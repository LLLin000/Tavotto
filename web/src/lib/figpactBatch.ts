/**
 * Figpact 验收批次的宿主侧落地（G4-C/D）。
 *
 * 只走已有的权威与通道，不另起保存、版本、撤销或审计子系统：
 * - 应用：`store/actions.updateObjects` 一次 commit（整批一笔历史，一步撤销）；
 * - 检查点：`lib/timelineCheckpoint.takeCheckpoint`（POST /api/versions/<doc_id>）；
 * - 持久化：`store/documentStore.saveNowWithResult`（PUT /api/autosave/<doc_id>
 *   携带磁盘 base_revision 的整份写，不推进基线、不覆盖冲突，由 diskWriter 守）；
 * - 重开：`GET /api/autosave/<doc_id>`（`lib/api.fetchAutosave`，读响应头
 *   `X-Tavotto-Revision` 当磁盘修订号）+ 素材字节（`GET /api/render|/file`）；
 * - 审计：同样 POST /api/versions/<doc_id> 记一条描述性节点（正文即审计记录，
 *   `description` 里放 batch/audit JSON）。
 *
 * 资源字节身份 = sha256 hex（`crypto.subtle` 异步算）；算不出（file:// 等无
 * subtle 的上下文）就报 unknown，不猜。
 */
import { msg, type UiMessage } from '@/i18n'
import {
  ApiError,
  createVersion,
  fetchAutosave,
  type FetchedAutosave,
  type LayoutVersionMeta,
} from '@/lib/api'
import { currentProjectId } from '@/lib/session'
import { takeCheckpoint } from '@/lib/timelineCheckpoint'
import { updateObjects } from '@/store/actions'
import { saveNowWithResult, useDocumentStore } from '@/store/documentStore'
import { base64ToBytes, figpactHostGet, sha256Hex } from '@/store/figpactStore'
import type { CanvasObject, FigureDocument, PanelObject } from '@/types/document'

/* ------------------------------ 批次形状 -------------------------------- */

/** figpact 侧 `build_batch_acceptance_plan` 冻结的输入形状（只读用到的字段）。 */
export interface FigpactBatchPlan {
  schema: string
  status: 'READY' | 'REFUSED'
  state: string
  batch_id: string
  host?: {
    document_id?: string
    base_revision?: string | null
    canvas_id?: string | null
    panel_ids?: string[]
  }
  failures?: Array<{ panel_id?: string | null; reason?: string }>
  document_patch?: {
    canvas_id?: string | null
    updates?: Array<{ panel_id: string; set?: Record<string, unknown> }>
  }
  manifest?: Array<{
    panel_id: string
    pdf_path?: string
    pdf_sha256?: string | null
    config_path?: string | null
    config_sha256?: string | null
    config_rebuild_verified?: boolean
    scope?: string
    measured_fonts?: unknown[]
    frame_revision?: string
  }>
  next_document?: unknown
  limits?: string[]
  evidence?: Record<string, unknown>
}

export interface FigpactBatchPanel {
  panel_id: string
  pdf_path: string
  pdf_sha256: string | null
  config_path: string | null
  config_sha256: string | null
  config_rebuild_verified: boolean
  scope: string
}

/** 批次里实际要写的那几份引用（fileId + figpact.config/scope），从 patch 里原样取。 */
export interface BatchPanelWrite {
  panel_id: string
  fileId: string
  config: string | null
  scope: string | null
}

function patchWrites(plan: FigpactBatchPlan): BatchPanelWrite[] | null {
  const updates = plan.document_patch?.updates
  if (!Array.isArray(updates)) return null
  const out: BatchPanelWrite[] = []
  for (const u of updates) {
    if (!u || typeof u.panel_id !== 'string' || typeof u.set !== 'object' || u.set === null) return null
    const set = u.set
    if (!('fileId' in set) || typeof set.fileId !== 'string' || !set.fileId) return null
    const fig = 'figpact' in set && typeof set.figpact === 'object' && set.figpact !== null ? set.figpact : null
    const config = fig !== null && 'config' in fig && typeof fig.config === 'string' ? fig.config : null
    const scope = fig !== null && 'scope' in fig && typeof fig.scope === 'string' ? fig.scope : null
    out.push({ panel_id: u.panel_id, fileId: set.fileId, config, scope })
  }
  return out
}

function manifestPanels(plan: FigpactBatchPlan): FigpactBatchPanel[] | null {
  if (!Array.isArray(plan.manifest)) return null
  const out: FigpactBatchPanel[] = []
  for (const m of plan.manifest) {
    if (!m || typeof m.panel_id !== 'string') return null
    if (typeof m.pdf_path !== 'string' || !m.pdf_path) return null
    out.push({
      panel_id: m.panel_id,
      pdf_path: m.pdf_path,
      pdf_sha256: typeof m.pdf_sha256 === 'string' ? m.pdf_sha256 : null,
      config_path: typeof m.config_path === 'string' ? m.config_path : null,
      config_sha256: typeof m.config_sha256 === 'string' ? m.config_sha256 : null,
      config_rebuild_verified: m.config_rebuild_verified === true,
      scope: typeof m.scope === 'string' ? m.scope : '',
    })
  }
  return out
}

/* ------------------------------ 状态机 ---------------------------------- */

export type FigpactBatchState =
  | 'PREPARED'
  | 'REFUSED'
  | 'HOST_APPLIED'
  | 'HOST_PERSISTED'
  | 'REOPEN_VERIFIED'
  | 'APPLY_MISMATCH'
  | 'PERSIST_CONFLICT'
  | 'PERSIST_FAILED'
  | 'REOPEN_MISMATCH'
  | 'REOPEN_UNREADABLE'

export interface FigpactBatchVerdict {
  batch_id: string
  state: FigpactBatchState
  applied?: { panels: string[]; history: number }
  persisted?: { revision_before: string | null; revision_after: string | null }
  reopen?: { revision: string | null; checked: string[] }
  audits?: { checkpoint?: string | null; record?: string | null }
  alreadyApplied?: boolean
  conflict?: { kind: 'stale' | 'external'; disk?: unknown } | null
  mismatch?: string[]
  error?: string
}

const hist = (key: string, values?: Record<string, unknown>): UiMessage =>
  msg(`history.${key}`, values, 'workspace')
const note = (key: string, values?: Record<string, unknown>): UiMessage =>
  msg(`figpact.${key}`, values, 'workspace')

/** 同一批 id 在本会话里已经落过历史就不再写第二笔（幂等：报已应用）。 */
const appliedBatches = new Set<string>()
export const __figpactBatchTestHooks = {
  applied: appliedBatches,
  reset: () => appliedBatches.clear(),
}

function docOf(): FigureDocument {
  return useDocumentStore.getState().doc
}

function panelById(doc: FigureDocument, id: string): PanelObject | undefined {
  const o = doc.objects.find((x) => x.id === id)
  return o?.type === 'panel' ? o : undefined
}

function refsOf(p: PanelObject): { fileId: string; config: string | null; scope: string | null } {
  return {
    fileId: p.fileId,
    config: p.renderOwner === 'figpact' && p.figpact ? p.figpact.config : null,
    scope: p.renderOwner === 'figpact' && p.figpact ? p.figpact.scope : null,
  }
}

/** 内存里这批的引用是不是已经是批次要写的样子（重放同一 batch_id 的判据）。 */
function batchAlreadyApplied(writes: BatchPanelWrite[]): boolean {
  const doc = docOf()
  return writes.every((w) => {
    const p = panelById(doc, w.panel_id)
    if (!p) return false
    const r = refsOf(p)
    return r.fileId === w.fileId && r.config === w.config && r.scope === w.scope
  })
}

/* ------------------------------ APPLY ----------------------------------- */

/**
 * 整批一次 commit 应用。缺素材（assetStore 无记录）或引用不符的面板整批拒绝，
 * 一个不写；成功恰好一笔历史。
 */
export function applyFigpactBatch(plan: FigpactBatchPlan): FigpactBatchVerdict {
  const batch_id = typeof plan.batch_id === 'string' ? plan.batch_id : ''
  if (plan.status !== 'READY') {
    return {
      batch_id, state: 'REFUSED',
      mismatch: (plan.failures ?? []).map((f) => `${f.panel_id ?? '?'}: ${f.reason ?? 'refused'}`),
    }
  }
  const writes = patchWrites(plan)
  const panels = manifestPanels(plan)
  if (!batch_id || !writes || !panels || !writes.length) {
    return { batch_id, state: 'REFUSED', mismatch: ['batch: malformed plan'] }
  }
  const byPanel = new Map(writes.map((w) => [w.panel_id, w]))
  const panelIds = writes.map((w) => w.panel_id)
  // patch 与 manifest 必须同批同面板：两边对不上就不写。
  if (panels.length !== writes.length || !panels.every((m) => byPanel.get(m.panel_id)?.fileId === m.pdf_path)) {
    return { batch_id, state: 'REFUSED', mismatch: ['batch: patch/manifest mismatch'] }
  }
  // 同一批里已有笔落过：第二次是幂等重放，不是新的一批。
  if (appliedBatches.has(batch_id) && batchAlreadyApplied(writes)) {
    return { batch_id, state: 'HOST_APPLIED', alreadyApplied: true, applied: { panels: panelIds, history: 0 } }
  }
  // 目标面板必须都在、且托管身份齐（unmanaged 不由这条路翻成 managed）。
  const missing: string[] = []
  for (const w of writes) {
    const p = panelById(docOf(), w.panel_id)
    if (!p || p.renderOwner !== 'figpact' || !p.figpact) missing.push(w.panel_id)
  }
  if (missing.length) {
    return { batch_id, state: 'REFUSED', mismatch: missing.map((id) => `${id}: not a managed panel`) }
  }
  // 引用与范围双重校验：patch 写什么，manifest 就必须是什么；config 有 hash 才写。
  for (const w of writes) {
    const m = panels.find((x) => x.panel_id === w.panel_id)!
    if (w.fileId !== m.pdf_path) return { batch_id, state: 'REFUSED', mismatch: [`${w.panel_id}: patch/manifest fileId disagree`] }
    if (w.config !== m.config_path || w.scope !== (m.scope || w.scope)) {
      return { batch_id, state: 'REFUSED', mismatch: [`${w.panel_id}: patch/manifest config disagree`] }
    }
    if (w.config && !m.config_sha256) {
      return { batch_id, state: 'REFUSED', mismatch: [`${w.panel_id}: managed config without hash`] }
    }
  }
  // 用户可能在准备与落地之间挪过、转过或裁过这些面板。几何变了，先前测到的有效字号
  // 就不再描述这一页，批次必须停下、保留用户的改动，而不是照样换掉引用。
  // 判据取批次自己的 next_document：那是同一批事实算出来的目标几何。
  const moved = placementDrift(plan)
  if (moved.length) {
    return { batch_id, state: 'REFUSED', mismatch: moved.map((id) => `${id}: panel placement changed since the plan`) }
  }
  const before = useDocumentStore.getState().past.length
  updateObjects(panelIds, hist('figpactApply', { count: panelIds.length }), (o) => {
    if (o.type !== 'panel') return
    const w = byPanel.get(o.id)
    if (!w) return
    o.fileId = w.fileId
    o.fileKind = 'pdf'
    o.renderOwner = 'figpact'
    // fileId + config 一起换：只换一半的中间态不存在（同一次 recipe 内）。
    if (w.config && w.scope) o.figpact = { config: w.config, scope: w.scope }
    else delete o.figpact
  })
  const after = useDocumentStore.getState().past.length
  if (after !== before + 1) {
    return { batch_id, state: 'APPLY_MISMATCH', mismatch: ['batch: expected exactly one history entry'] }
  }
  appliedBatches.add(batch_id)
  return { batch_id, state: 'HOST_APPLIED', applied: { panels: panelIds, history: 1 } }
}

/** 当前页里这些面板的几何是否仍与批次计划一致（位置/尺寸/原生尺寸/裁剪/旋转/翻转）。 */
function placementDrift(plan: FigpactBatchPlan): string[] {
  const next = plan.next_document as { canvases?: { objects?: unknown[] }[] } | undefined
  const target = Array.isArray(next?.canvases) ? next.canvases.flatMap((c) => c.objects ?? []) : []
  const byId = new Map(
    target
      .filter((o): o is Record<string, unknown> => !!o && typeof o === 'object' && 'id' in o)
      .map((o) => [String(o.id), o]),
  )
  const keys = ['x', 'y', 'w', 'h', 'nativeW', 'nativeH', 'rotation', 'flipH', 'flipV'] as const
  const drift: string[] = []
  if (!byId.size) return drift
  for (const [id, want] of byId) {
    const have = panelById(docOf(), id)
    if (!have) continue
    const t = have as unknown as Record<string, unknown>
    if (keys.some((k) => (t[k] ?? null) !== (want[k] ?? null)) ||
        JSON.stringify(t.crop ?? null) !== JSON.stringify(want.crop ?? null)) {
      drift.push(id)
    }
  }
  return drift
}

/* --------------------------- PERSIST + AUDIT ---------------------------- */

async function sha256HexBytes(data: Uint8Array): Promise<string | null> {
  try {
    return await sha256Hex(data)
  } catch {
    // 无 subtle 的上下文（file:// 等）：算不出，按 unknown 计，不猜。
    return null
  }
}

/**
 * 托管 config 字节经 figpact 宿主读（`GET /resource?id=&kind=config`，
 * 与 FigpactBridge 同一条已连接会话、同一个 Bearer token，走 `figpactHostGet`）。
 * 宿主未知 / 失败 / 形状不对时回 nulls——调用方按 unreadable 计，绝不记 verified。
 */
async function fetchFigpactConfig(
  panelId: string,
  override?: ReopenOptions['fetchConfig'],
): Promise<{ data: Uint8Array | null; sha256: string | null }> {
  if (override) return override(panelId)
  return fetchFigpactHostResource(`resource?id=${encodeURIComponent(panelId)}&kind=config`, 'config')
}

/**
 * 托管面板的真实文件字节经 figpact 宿主读（`GET /resource?kind=file&path=`，
 * 同一条已连接会话，走 `figpactHostGet`）。`/api/render` 回的是重渲染预览，
 * 不是面板存的那份 PDF 字节，hash 它等于比错了对象——只做显示用，不再 hash。
 * 宿主未知 / 失败 / 形状或 path 对不上时回 nulls，按 unreadable 计。
 */
async function fetchFigpactFile(
  pdfPath: string,
  override?: ReopenOptions['fetchFile'],
): Promise<{ data: Uint8Array | null; sha256: string | null }> {
  if (override) return override(pdfPath)
  const got = await fetchFigpactHostResource(
    `resource?kind=file&path=${encodeURIComponent(pdfPath)}`, 'file')
  if (!got.data || !got.sha256 || got.path !== pdfPath) return { data: null, sha256: null }
  return got
}

async function fetchFigpactHostResource(
  query: string, wantKind: string,
): Promise<{ data: Uint8Array | null; sha256: string | null; path?: string | null }> {
  const body = await figpactHostGet(query)
  if (!body || typeof body !== 'object') return { data: null, sha256: null }
  if (!('schema' in body) || !('kind' in body)) return { data: null, sha256: null }
  const r = body as { schema?: unknown; kind?: unknown; sha256?: unknown; bytes_base64?: unknown; path?: unknown }
  if (r.schema !== 'figpact.host-resource/1' || r.kind !== wantKind) return { data: null, sha256: null }
  if (typeof r.bytes_base64 !== 'string' || typeof r.sha256 !== 'string') return { data: null, sha256: null }
  let data: Uint8Array
  try {
    data = base64ToBytes(r.bytes_base64)
  } catch {
    return { data: null, sha256: null }
  }
  return { data, sha256: r.sha256, path: typeof r.path === 'string' ? r.path : null }
}

export interface PersistOptions {
  /** 审计节点写在哪份排版的时间线上；缺省当前文档。 */
  docId?: string
}

/**
 * 检查点 → 整份写（带磁盘 base_revision）→ 审计节点。409 按 diskWriter 同一语义
 * 报冲突且不持久化；写后基线交由 saveNowWithResult/diskWriter 推进。
 */
export async function persistFigpactBatch(
  plan: FigpactBatchPlan,
  opts: PersistOptions = {},
): Promise<FigpactBatchVerdict> {
  const batch_id = typeof plan.batch_id === 'string' ? plan.batch_id : ''
  const writes = patchWrites(plan)
  const panels = manifestPanels(plan)
  if (plan.status !== 'READY' || !batch_id || !writes?.length || !panels?.length) {
    return { batch_id, state: 'REFUSED', mismatch: ['batch: not ready'] }
  }
  const s = useDocumentStore.getState()
  const docId = opts.docId ?? s.documentId
  if (docId !== s.documentId) {
    return { batch_id, state: 'PERSIST_FAILED', error: 'cross-document persist refused' }
  }
  const panelIds = writes.map((w) => w.panel_id)
  // 刚应用的那批引用必须还在内存里：persist 只为它落盘，不为陈旧内存背书。
  // （基线未推进 = saveNowWithResult 判“无新内容”而不发 PUT；那时直接拒，
  // 调用方重走 apply→persist，而不是静默报已持久化。）
  if (!batchAlreadyApplied(writes)) {
    return { batch_id, state: 'PERSIST_FAILED', error: 'batch not applied in memory; apply first' }
  }
  // 1) 检查点（当前内存内容，写入之前）：失败就不往下走。
  let checkpoint: LayoutVersionMeta | undefined
  try {
    const res = await takeCheckpoint(
      { auto: true, allowEmpty: true, name: `figpact batch ${batch_id.slice(0, 12)} (before)`, programName: true },
    )
    checkpoint = res?.version
    if (!checkpoint) return { batch_id, state: 'PERSIST_FAILED', error: 'checkpoint not stored' }
  } catch (e) {
    return { batch_id, state: 'PERSIST_FAILED', error: `checkpoint failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  let revisionBefore: string | null = null
  try {
    const head: FetchedAutosave | null = await fetchAutosave(docId, currentProjectId())
    revisionBefore = head?.revision ?? null
  } catch {
    return { batch_id, state: 'REOPEN_UNREADABLE', error: 'disk unreadable before write' }
  }
  const { state, wrote } = await saveNowWithResult()
  if (state === 'conflict') {
    const issue = useDocumentStore.getState().saveIssue
    return {
      batch_id, state: 'PERSIST_CONFLICT',
      persisted: { revision_before: revisionBefore, revision_after: null },
      audits: { checkpoint: checkpoint.id, record: null },
      conflict: { kind: issue?.kind === 'stale' ? 'stale' : 'external', disk: issue?.disk ?? null },
    }
  }
  if (state === 'save_error' || !wrote) {
    return {
      batch_id, state: 'PERSIST_FAILED', error: `save failed: ${state}`,
      persisted: { revision_before: revisionBefore, revision_after: null },
      audits: { checkpoint: checkpoint.id, record: null },
    }
  }
  let revisionAfter: string | null = null
  try {
    revisionAfter = (await fetchAutosave(docId, currentProjectId()))?.revision ?? null
  } catch {
    revisionAfter = null
  }

  // 3) 审计节点：同一条 versions 时间线，description 里放机器可读的审计 JSON。
  const audit = {
    kind: 'figpact.batch-audit/1',
    batch_id,
    panels: panelIds,
    resource_hashes: Object.fromEntries(
      panels.map((m) => [m.panel_id, { pdf_sha256: m.pdf_sha256, config_sha256: m.config_sha256 }]),
    ),
    revision_before: revisionBefore,
    revision_after: revisionAfter,
    applied: true,
    persisted: true,
    conflict: null,
  }
  let record: LayoutVersionMeta | undefined
  try {
    const res = await createVersion(
      docId,
      {
        auto: true,
        name: `figpact batch ${batch_id.slice(0, 12)}`,
        description: JSON.stringify(audit),
        doc: useDocumentStore.getState().doc,
        canvasId: useDocumentStore.getState().activeCanvasId,
        canvasName: useDocumentStore.getState().doc.name,
      },
      currentProjectId(),
    )
    record = res.version
  } catch {
    record = undefined
  }
  return {
    batch_id,
    state: 'HOST_PERSISTED',
    applied: { panels: panelIds, history: 1 },
    persisted: { revision_before: revisionBefore, revision_after: revisionAfter },
    audits: { checkpoint: checkpoint.id, record: record?.id ?? null },
  }
}

/* ------------------------------ REOPEN ---------------------------------- */

export interface ReopenOptions {
  docId?: string
  /** 覆盖读盘：用例注入假磁盘；缺省真 fetch。 */
  fetchDoc?: (docId: string) => Promise<FetchedAutosave | null>
  /** 显示层预留（/api/render panelSrc 链）；重开核验不再读它，只认宿主真实字节。 */
  fetchResource?: (path: string) => Promise<{ data: Uint8Array | null; status: number }>
  /**
   * 托管 config 字节的来源（`GET /resource?id=&kind=config` 的 figpact 宿主
   * 路由，经 `figpactHostGet` 同一条已连接会话）。用例注入假宿主；缺省真宿主，
   * 未连接时回 nulls，config 腿按 unreadable 计，绝不记 verified。
   */
  fetchConfig?: (panelId: string) => Promise<{ data: Uint8Array | null; sha256: string | null }>
  /**
   * 托管面板真实文件字节的来源（`GET /resource?kind=file&path=` 的 figpact
   * 宿主路由，经 `figpactHostGet`）。用例注入假宿主；缺省真宿主，未连接时
   * 回 nulls，PDF 腿按 unreadable 计，绝不记 verified。
   */
  fetchFile?: (pdfPath: string) => Promise<{ data: Uint8Array | null; sha256: string | null }>
}

/**
 * 从磁盘重读（fresh GET，不读内存对象）并核验：面板引用 == prepared、
 * 面板真实文件字节 hash == prepared（经 figpact 宿主 /resource?kind=file）、
 * config 原样 == prepared（经 figpact 宿主 /resource?kind=config）、其余对象原样。
 * `/api/render` 只做显示，不再 hash。
 */
export async function reopenVerifyFigpactBatch(
  plan: FigpactBatchPlan,
  opts: ReopenOptions = {},
): Promise<FigpactBatchVerdict> {
  const batch_id = typeof plan.batch_id === 'string' ? plan.batch_id : ''
  const writes = patchWrites(plan)
  const panels = manifestPanels(plan)
  if (plan.status !== 'READY' || !batch_id || !writes?.length || !panels?.length) {
    return { batch_id, state: 'REFUSED', mismatch: ['batch: not ready'] }
  }
  const docId = opts.docId ?? useDocumentStore.getState().documentId
  const fetchDoc = opts.fetchDoc ?? ((id: string) => fetchAutosave(id, currentProjectId()))
  // 显示仍走 /api/render panelSrc 链（见 ObjectView 离线兜底）；核验 hash 只认
  // figpact 宿主的真实文件字节。fetchResource 缝线保留给显示层调用方，重开不再读。
  void opts.fetchResource
  let diskDoc: FigureDocument | null = null
  let revision: string | null = null
  try {
    const fetched = await fetchDoc(docId)
    if (!fetched) return { batch_id, state: 'REOPEN_UNREADABLE', error: 'disk document missing' }
    revision = fetched.revision ?? null
    diskDoc = projectToActiveDoc(fetched.doc)
  } catch (e) {
    return { batch_id, state: 'REOPEN_UNREADABLE', error: e instanceof Error ? e.message : String(e) }
  }
  if (!diskDoc) return { batch_id, state: 'REOPEN_UNREADABLE', error: 'disk document unreadable' }
  const mismatch: string[] = []
  const checked: string[] = []
  const byWrite = new Map(writes.map((w) => [w.panel_id, w]))
  for (const m of panels) {
    const w = byWrite.get(m.panel_id)
    const p = panelById(diskDoc, m.panel_id)
    if (!p) { mismatch.push(`${m.panel_id}: panel missing on disk`); continue }
    const r = refsOf(p)
    // 引用必须恰好是 prepared 那一份（fileId + config 一起，绝不只对一半）。
    if (!w || r.fileId !== w.fileId || r.fileId !== m.pdf_path) {
      mismatch.push(`${m.panel_id}: fileId is ${r.fileId ?? '∅'}, prepared ${m.pdf_path}`)
      continue
    }
    if ((r.config ?? null) !== (w.config ?? null) || (w.config ?? null) !== (m.config_path ?? null)) {
      mismatch.push(`${m.panel_id}: config is ${r.config ?? '∅'}, prepared ${m.config_path ?? '∅'}`)
      continue
    }
    // 面板真实文件字节 hash == prepared：经 figpact 宿主 /resource?kind=file。
    // `/api/render` 回的是重渲染预览字节，hash 它等于比错了对象——只做显示。
    // 宿主未知 / 读不到 / 无 subtle 时按 unreadable 计——绝不记 verified。
    if (m.pdf_sha256) {
      const { data, sha256 } = await fetchFigpactFile(m.pdf_path, opts.fetchFile)
      if (!data || !sha256) { mismatch.push(`${m.panel_id}: resource ${m.pdf_path} unreadable`); continue }
      const actual = await sha256HexBytes(data)
      if (!actual) { mismatch.push(`${m.panel_id}: resource hash unavailable (no subtle crypto)`); continue }
      const want = m.pdf_sha256.toLowerCase()
      if (sha256.toLowerCase() !== want) {
        mismatch.push(`${m.panel_id}: resource served hash ${sha256.slice(0, 12)}… != prepared ${want.slice(0, 12)}…`)
        continue
      }
      if (actual !== want) {
        mismatch.push(`${m.panel_id}: resource hash ${actual.slice(0, 12)}… != prepared ${want.slice(0, 12)}…`)
        continue
      }
    }
    // 托管面板 config 原样 == prepared：走 figpact 宿主的 /resource 路由
    // （Tavotto safe_resolve 不发 .yaml，PDF 腿的 panelSrc 链读不到它）。
    // 宿主未知 / 读不到 / 无 subtle 时按 unreadable 计——绝不记 verified。
    if (m.config_path && m.config_sha256) {
      const { data, sha256 } = await fetchFigpactConfig(m.panel_id, opts.fetchConfig)
      if (!data || !sha256) { mismatch.push(`${m.panel_id}: config ${m.config_path} unreadable`); continue }
      const actual = await sha256HexBytes(data)
      if (!actual) { mismatch.push(`${m.panel_id}: config hash unavailable (no subtle crypto)`); continue }
      const want = m.config_sha256.toLowerCase()
      if (sha256.toLowerCase() !== want) {
        mismatch.push(`${m.panel_id}: config served hash ${sha256.slice(0, 12)}… != prepared ${want.slice(0, 12)}…`)
        continue
      }
      if (actual !== want) {
        mismatch.push(`${m.panel_id}: config hash ${actual.slice(0, 12)}… != prepared ${want.slice(0, 12)}…`)
        continue
      }
    }
    checked.push(m.panel_id)
  }
  // 其余对象：只核对身份集合（数量 + id），内容逐字段比对是 next_document 的事。
  const diskIds = new Set(diskDoc.objects.map((o) => o.id))
  const nextIds = plan.next_document
    ? idsOfNextDocument(plan.next_document)
    : new Set([...diskIds])
  for (const id of nextIds) {
    if (!diskIds.has(id)) mismatch.push(`untouched object ${id} missing on disk`)
  }
  if (mismatch.length) {
    return { batch_id, state: 'REOPEN_MISMATCH', mismatch, reopen: { revision, checked } }
  }
  return { batch_id, state: 'REOPEN_VERIFIED', reopen: { revision, checked } }
}

function projectToActiveDoc(raw: unknown): FigureDocument | null {
  if (!raw || typeof raw !== 'object' || !('schema' in raw)) return null
  // schema 3 项目文档：取激活画布；否则当它本身就是 FigureDocument。
  if (raw.schema === 3 && 'canvases' in raw && Array.isArray(raw.canvases) && raw.canvases.length) {
    const canvases = raw.canvases as Array<{ id?: string; objects?: CanvasObject[] }>
    const want = 'activeCanvasId' in raw ? raw.activeCanvasId : undefined
    const active = canvases.find((c) => c.id === want) ?? canvases[0]
    if (!active || !Array.isArray(active.objects)) return null
    return { schema: 2, name: 'disk', page: { w: 150, h: 100 }, objects: active.objects, guides: [] }
  }
  if (!('objects' in raw) || !Array.isArray(raw.objects)) return null
  return raw as FigureDocument
}

function idsOfNextDocument(next: unknown): Set<string> {
  if (!next || typeof next !== 'object') return new Set()
  if ('canvases' in next && Array.isArray(next.canvases)) {
    const ids: string[] = []
    for (const c of next.canvases as Array<{ objects?: Array<{ id?: string }> }>) {
      for (const o of c.objects ?? []) ids.push(String(o.id))
    }
    return new Set(ids)
  }
  if ('objects' in next && Array.isArray(next.objects)) {
    return new Set((next.objects as Array<{ id?: string }>).map((o) => String(o.id)))
  }
  return new Set()
}

/* ------------------------- 模棱两可的写后裁决 ---------------------------- */

/**
 * 超时/中断后不知道写进去了没有：重读磁盘，看 revision 变没变、内容是不是我
 * 们这一份——是就认，不猜、不覆盖、不重写。
 *
 * @returns 'persisted' 磁盘上已经是我们这份；'absent' 磁盘还是旧的（可重试）；
 *   'diverged' 磁盘是别人的一份（走冲突裁决）；'unreadable' 读不到。
 */
export async function resolveAmbiguousFigpactSave(
  opts: ReopenOptions & { expectedRevision?: string | null; ours?: FigureDocument | null } = {},
): Promise<'persisted' | 'absent' | 'diverged' | 'unreadable'> {
  const docId = opts.docId ?? useDocumentStore.getState().documentId
  const fetchDoc = opts.fetchDoc ?? ((id: string) => fetchAutosave(id, currentProjectId()))
  let fetched: FetchedAutosave | null
  try {
    fetched = await fetchDoc(docId)
  } catch {
    return 'unreadable'
  }
  if (!fetched) return 'unreadable'
  if (opts.expectedRevision && fetched.revision && fetched.revision === opts.expectedRevision) {
    return 'absent'
  }
  if (opts.ours) {
    const disk = projectToActiveDoc(fetched.doc)
    if (disk && JSON.stringify(disk.objects) === JSON.stringify(opts.ours.objects)) return 'persisted'
    return 'diverged'
  }
  return 'diverged'
}

/* ------------------------------ 审计通道 -------------------------------- */

/** 审计记录写进已有 versions 时间线的描述性节点（见 persistFigpactBatch §3）。 */
export async function auditFigpactBatch(
  verdict: FigpactBatchVerdict,
  opts: PersistOptions = {},
): Promise<{ record: string | null; error?: string }> {
  const docId = opts.docId ?? useDocumentStore.getState().documentId
  try {
    const s = useDocumentStore.getState()
    const res = await createVersion(
      docId,
      {
        auto: true,
        name: `figpact audit ${verdict.batch_id.slice(0, 12)}`,
        description: JSON.stringify({ kind: 'figpact.batch-audit/1', ...verdict }),
        doc: s.doc,
        canvasId: s.activeCanvasId,
        canvasName: s.doc.name,
      },
      currentProjectId(),
    )
    return { record: res.version?.id ?? null }
  } catch (e) {
    return { record: null, error: e instanceof Error ? e.message : String(e) }
  }
}

/* ------------------------------ 409 语义 -------------------------------- */

export function figpactConflictOf(e: unknown): 'stale' | 'external' | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null
  const code = typeof e.body === 'object' && e.body !== null && 'code' in e.body ? e.body.code : null
  if (code === 'stale_write') return 'stale'
  if (code === 'external_change') return 'external'
  return null
}

/** 调用点按 verdict.state 选已有 workspace 文案（见 figpactBatchNote 的调用方注释）。 */
export function figpactBatchNote(v: FigpactBatchVerdict): UiMessage {
  switch (v.state) {
    case 'HOST_APPLIED':
      return v.alreadyApplied ? note('batchAlreadyApplied') : note('batchApplied', { count: v.applied?.panels.length ?? 0 })
    case 'HOST_PERSISTED':
      return note('batchPersisted', { count: v.applied?.panels.length ?? 0 })
    case 'REOPEN_VERIFIED':
      return note('batchVerified', { count: v.reopen?.checked.length ?? 0 })
    case 'PERSIST_CONFLICT':
      return note('batchConflict')
    case 'REOPEN_MISMATCH':
    case 'APPLY_MISMATCH':
      return note('batchMismatch')
    default:
      return note('batchFailed')
  }
}
