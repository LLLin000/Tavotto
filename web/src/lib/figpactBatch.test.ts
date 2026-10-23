import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyProject, type PanelObject } from '@/types/document'
import { fetchAutosave } from '@/lib/api'
import { readAutosaveDoc, useDocumentStore } from '@/store/documentStore'
import {
  __figpactBatchTestHooks,
  applyFigpactBatch,
  persistFigpactBatch,
  reopenVerifyFigpactBatch,
  resolveAmbiguousFigpactSave,
  type FigpactBatchPlan,
} from '@/lib/figpactBatch'

vi.mock('@/lib/timelineThumb', () => ({
  captureThumbSources: vi.fn(() => new Map()),
  composeTimelineThumb: vi.fn(async () => null),
}))

const DOC = 'd_figpact_batch'
const revOf = (body: string) => `r${body.length}-${body.slice(0, 8).replace(/\W/g, '')}`

/* ------------------------------- 假磁盘 -------------------------------- */

const disk = new Map<string, string>()
const order: Array<{ method: string; url: string; body?: string }> = []
let putMode: 'ok' | 'external' | 'stale' = 'ok'
let gatePuts = false
const gates: Array<() => void> = []

const sha = async (s: string) => {
  const d = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  disk.clear()
  order.length = 0
  gates.length = 0
  gatePuts = false
  putMode = 'ok'
  localStorage.clear()
  __figpactBatchTestHooks.reset()
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const raw = String(url)
    const method = init?.method ?? 'GET'
    if (raw.includes('/api/versions/') && method === 'POST') {
      order.push({ method: 'VERSION', url: raw, body: String(init?.body) })
      return new Response('{"version":{"id":"v1","name":"n","ts":1,"auto":true,"description":"","objects":0}}', { status: 200 })
    }
    const m = raw.match(/\/api\/autosave\/([^/?]+)/)
    if (!m || raw.includes('/summary')) return new Response('{}', { status: 404 })
    const id = decodeURIComponent(m[1])
    if (method === 'PUT') {
      const q = new URL(raw, 'http://t').searchParams
      order.push({ method: 'PUT', url: raw, body: String(init?.body) })
      if (gatePuts) await new Promise<void>((r) => gates.push(r))
      if (putMode === 'stale') return new Response('{"code":"stale_write","theirs":999}', { status: 409 })
      if (putMode === 'external') {
        const v = disk.get(id)
        return new Response(JSON.stringify({ code: 'external_change', revision: v ? revOf(v) : null }), { status: 409 })
      }
      const body = String(init?.body)
      disk.set(id, body)
      expect(q.get('base_revision')).not.toBeNull()
      return new Response(JSON.stringify({ ok: true, saved_at: 1, revision: revOf(body) }), { status: 200 })
    }
    const v = disk.get(id)
    return new Response(v ?? '{}', {
      status: v ? 200 : 404,
      headers: v ? { 'X-Tavotto-Revision': revOf(v) } : undefined,
    })
  }) as typeof fetch
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

const managed = (id: string, fileId = 'old.pdf'): PanelObject => ({
  id, type: 'panel', x: 0, y: 0, w: 40, h: 30, fileId, fileKind: 'pdf',
  nativeW: 80, nativeH: 60, figureFrame: 1, script: `${id}.py`,
  renderOwner: 'figpact', figpact: { config: `${id}.yaml`, scope: 'main' }, overrides: [],
})

const seed = async (objects: PanelObject[], id = DOC) => {
  const pd = emptyProject()
  pd.canvases[0].objects = objects as never
  pd.updatedAt = 100
  // 先让假磁盘上有种子版，走真读盘路把 diskWriter 的磁盘基线记住
  // （读到哪一版、基线就是哪一版；之后凭它写，不再探盘）。
  disk.set(id, JSON.stringify({ ...pd, updatedAt: 50 }))
  await readAutosaveDoc(id)
  await tick()
  // 再换上真正的种子文档：基线仍是种子版，写时带的 base_revision 就是它。
  await useDocumentStore.getState().switchDocument(pd, id)
  await tick()
  useDocumentStore.setState({ past: [], future: [] })
  return disk.get(id)!
}

const planOf = async (pdfA: string, pdfB: string, cfgA: string, cfgB: string): Promise<FigpactBatchPlan> => ({
  schema: 'figpact.acceptance-batch-plan/1',
  status: 'READY',
  state: 'PREPARED',
  batch_id: 'b'.repeat(64),
  host: { document_id: DOC, base_revision: 'r0', canvas_id: 'c', panel_ids: ['nmr', 'xrd'] },
  failures: [],
  document_patch: {
    canvas_id: 'c',
    updates: [
      { panel_id: 'nmr', set: { fileId: pdfA, figpact: { config: cfgA, scope: 'main' } } },
      { panel_id: 'xrd', set: { fileId: pdfB, figpact: { config: cfgB, scope: 'main' } } },
    ],
  },
  manifest: [
    { panel_id: 'nmr', pdf_path: pdfA, pdf_sha256: await sha(`pdf:${pdfA}`), config_path: cfgA, config_sha256: await sha(`cfg:${cfgA}`), config_rebuild_verified: true, scope: 'main', measured_fonts: [], frame_revision: 'f1' },
    { panel_id: 'xrd', pdf_path: pdfB, pdf_sha256: await sha(`pdf:${pdfB}`), config_path: cfgB, config_sha256: await sha(`cfg:${cfgB}`), config_rebuild_verified: true, scope: 'main', measured_fonts: [], frame_revision: 'f2' },
  ],
  next_document: null,
  limits: ['PREPARED only'],
  evidence: { first_failure: null },
})

/** 假 figpact 宿主文件腿：真实 PDF 字节经 /resource?kind=file 来（render 预览不 hash）。 */
const fileFetch = (pdfA: string, pdfB: string, tamper?: string) =>
  async (pdfPath: string) => {
    const table: Record<string, string> = { [pdfA]: `pdf:${pdfA}`, [pdfB]: `pdf:${pdfB}` }
    const hit = pdfPath === tamper ? 'tampered-pdf' : table[pdfPath]
    if (!hit) return { data: null, sha256: null }
    return { data: new TextEncoder().encode(hit), sha256: await sha(hit) }
  }

/** 假 figpact 宿主：config 字节经 /resource?id=&kind=config 腿来。 */
const configFetch = (cfgA: string, cfgB: string, tamper?: string) =>
  async (panelId: string) => {
    const table: Record<string, string> = { nmr: `cfg:${cfgA}`, xrd: `cfg:${cfgB}` }
    const body = tamper && panelId === tamper ? 'tampered-config' : table[panelId]
    if (!body) return { data: null, sha256: null }
    return { data: new TextEncoder().encode(body), sha256: await sha(body) }
  }

describe('figpact 批次：应用 / 持久化 / 重开 / 撤销 / 幂等', () => {
  it('两块面板一次 commit；检查点先于写；写带磁盘 base_revision；重开从盘读并通过', async () => {
    const pdfA = 'figpact-resources/p/aaa.pdf'
    const pdfB = 'figpact-resources/p/bbb.pdf'
    const cfgA = 'figpact-resources/p/aaa.yaml'
    const cfgB = 'figpact-resources/p/bbb.yaml'
    const text = { id: 't1', type: 'text', text: 'keep', sizePt: 9, bold: false, color: '#000', align: 'left', x: 0, y: 0, w: 20, h: 8 }
    await seed([managed('nmr'), managed('xrd'), text as never])
    const diskBefore = revOf(disk.get(DOC)!)
    const plan = await planOf(pdfA, pdfB, cfgA, cfgB)

    const pastBefore = useDocumentStore.getState().past.length
    const applied = applyFigpactBatch(plan)
    expect(applied.state).toBe('HOST_APPLIED')
    expect(useDocumentStore.getState().past.length).toBe(pastBefore + 1)

    order.length = 0
    const persisted = await persistFigpactBatch(plan)
    // seed 把基线钉在种子版：应用后内存与种子版不同，saveNowWithResult 必发 PUT。
    expect(persisted.state).toBe('HOST_PERSISTED')
    const vIdx = order.findIndex((o) => o.method === 'VERSION')
    const pIdx = order.findIndex((o) => o.method === 'PUT')
    expect(vIdx).toBeGreaterThanOrEqual(0)
    expect(pIdx).toBeGreaterThan(vIdx)
    // 写带的是落盘前那一份的 base_revision（不是内存猜的）
    const put = order[pIdx]
    expect(new URL(put.url, 'http://t').searchParams.get('base_revision')).toBe(diskBefore)
    expect(persisted.persisted?.revision_before).toBe(diskBefore)
    expect(persisted.persisted?.revision_after).toBe(revOf(disk.get(DOC)!))
    expect(persisted.audits?.checkpoint).toBeTruthy()

    const reopened = await reopenVerifyFigpactBatch(plan, { fetchFile: fileFetch(pdfA, pdfB), fetchConfig: configFetch(cfgA, cfgB) })
    expect(reopened.state).toBe('REOPEN_VERIFIED')
    expect(reopened.reopen?.checked).toEqual(['nmr', 'xrd'])
    // 未动对象仍在盘上
    expect(JSON.parse(disk.get(DOC)!).canvases[0].objects.map((o: { id: string }) => o.id)).toContain('t1')
  })

  it('重开验出被篡改的引用', async () => {
    const pdfA = 'figpact-resources/p/aaa.pdf'
    const pdfB = 'figpact-resources/p/bbb.pdf'
    const cfgA = 'figpact-resources/p/aaa.yaml'
    const cfgB = 'figpact-resources/p/bbb.yaml'
    await seed([managed('nmr'), managed('xrd')])
    const plan = await planOf(pdfA, pdfB, cfgA, cfgB)
    applyFigpactBatch(plan)
    expect((await persistFigpactBatch(plan)).state).toBe('HOST_PERSISTED')
    // 盘上引用被动过（fileId 指到别处）
    const raw = JSON.parse(disk.get(DOC)!)
    raw.canvases[0].objects.find((o: { id: string }) => o.id === 'nmr').fileId = 'evil.pdf'
    disk.set(DOC, JSON.stringify(raw))
    const reopened = await reopenVerifyFigpactBatch(plan, { fetchFile: fileFetch(pdfA, pdfB), fetchConfig: configFetch(cfgA, cfgB) })
    expect(reopened.state).toBe('REOPEN_MISMATCH')
  })

  it('409 不持久化：外部修改挡住写，磁盘原样；冲突走已有裁决态', async () => {
    const pdfA = 'figpact-resources/p/aaa.pdf'
    const pdfB = 'figpact-resources/p/bbb.pdf'
    const cfgA = 'figpact-resources/p/aaa.yaml'
    const cfgB = 'figpact-resources/p/bbb.yaml'
    await seed([managed('nmr'), managed('xrd')])
    const before = disk.get(DOC)!
    const plan = await planOf(pdfA, pdfB, cfgA, cfgB)
    applyFigpactBatch(plan)
    putMode = 'external'
    const persisted = await persistFigpactBatch(plan)
    expect(persisted.state).toBe('PERSIST_CONFLICT')
    expect(persisted.conflict?.kind).toBe('external')
    expect(disk.get(DOC)).toBe(before)
    expect(useDocumentStore.getState().saveState).toBe('conflict')
    expect(persisted.audits?.checkpoint).toBeTruthy()
    expect(persisted.audits?.record).toBeNull()
  })

  it('模棱两可的超时靠重读裁决：盘上是就认、不是就不盖', async () => {
    await seed([managed('nmr'), managed('xrd')])
    const ours = useDocumentStore.getState().doc
    const before = disk.get(DOC)!
    // 超时但其实写进去了：重读认出是我们这份
    disk.set(DOC, JSON.stringify(useDocumentStore.getState().buildProject()))
    expect(await resolveAmbiguousFigpactSave({ ours })).toBe('persisted')
    // 盘上还是旧的：可重试
    disk.set(DOC, before)
    const fetched = await fetchAutosave(DOC, null)
    expect(await resolveAmbiguousFigpactSave({ expectedRevision: fetched?.revision ?? null, ours })).toBe('absent')
  })

  it('撤销一步退回旧引用且仍能解析；重放同批幂等（不添历史）', async () => {
    const pdfA = 'figpact-resources/p/aaa.pdf'
    const pdfB = 'figpact-resources/p/bbb.pdf'
    const cfgA = 'figpact-resources/p/aaa.yaml'
    const cfgB = 'figpact-resources/p/bbb.yaml'
    await seed([managed('nmr'), managed('xrd')])
    const plan = await planOf(pdfA, pdfB, cfgA, cfgB)
    applyFigpactBatch(plan)
    useDocumentStore.getState().undo()
    const doc = useDocumentStore.getState().doc
    expect(doc.objects.filter((o) => o.type === 'panel').map((o) => (o as PanelObject).fileId)).toEqual(['old.pdf', 'old.pdf'])
    // 旧引用仍在（unmanaged 时的形态），重做回来再重放同批 → 已应用，不添历史
    useDocumentStore.getState().redo()
    const past = useDocumentStore.getState().past.length
    const again = applyFigpactBatch(plan)
    expect(again.state).toBe('HOST_APPLIED')
    expect(again.alreadyApplied).toBe(true)
    expect(again.applied?.history).toBe(0)
    expect(useDocumentStore.getState().past.length).toBe(past)
  })

  it('REFUSED 整批不动：一次失败面板也不写', async () => {
    await seed([managed('nmr'), managed('xrd')])
    const past = useDocumentStore.getState().past.length
    const refused: FigpactBatchPlan = {
      schema: 'figpact.acceptance-batch-plan/1', status: 'REFUSED', state: 'REFUSED',
      batch_id: 'c'.repeat(64), failures: [{ panel_id: 'nmr', reason: 'anisotropic' }],
      document_patch: { canvas_id: 'c', updates: [] }, manifest: [],
    }
    expect(applyFigpactBatch(refused).state).toBe('REFUSED')
    expect(useDocumentStore.getState().past.length).toBe(past)
  })

  it('config 腿：宿主字节与 prepared 一致才过；被篡改点名面板', async () => {
    const pdfA = 'figpact-resources/p/aaa.pdf'
    const pdfB = 'figpact-resources/p/bbb.pdf'
    const cfgA = 'figpact-resources/p/aaa.yaml'
    const cfgB = 'figpact-resources/p/bbb.yaml'
    await seed([managed('nmr'), managed('xrd')])
    const plan = await planOf(pdfA, pdfB, cfgA, cfgB)
    applyFigpactBatch(plan)
    expect((await persistFigpactBatch(plan)).state).toBe('HOST_PERSISTED')
    const good = await reopenVerifyFigpactBatch(plan, {
      fetchFile: fileFetch(pdfA, pdfB), fetchConfig: configFetch(cfgA, cfgB),
    })
    expect(good.state).toBe('REOPEN_VERIFIED')
    const bad = await reopenVerifyFigpactBatch(plan, {
      fetchFile: fileFetch(pdfA, pdfB), fetchConfig: configFetch(cfgA, cfgB, 'nmr'),
    })
    expect(bad.state).toBe('REOPEN_MISMATCH')
    expect(bad.mismatch?.join('\n')).toMatch(/nmr/)
  })

  it('config 腿：宿主未知时 unreadable，且 verdict 不是 REOPEN_VERIFIED', async () => {
    const pdfA = 'figpact-resources/p/aaa.pdf'
    const pdfB = 'figpact-resources/p/bbb.pdf'
    const cfgA = 'figpact-resources/p/aaa.yaml'
    const cfgB = 'figpact-resources/p/bbb.yaml'
    await seed([managed('nmr'), managed('xrd')])
    const plan = await planOf(pdfA, pdfB, cfgA, cfgB)
    applyFigpactBatch(plan)
    expect((await persistFigpactBatch(plan)).state).toBe('HOST_PERSISTED')
    // 宿主未知：fetchConfig 回 nulls（与 figpactHostGet 未连接同一语义）。
    const missing = await reopenVerifyFigpactBatch(plan, {
      fetchFile: async () => ({ data: null, sha256: null }),
      fetchConfig: async () => ({ data: null, sha256: null }),
    })
    expect(missing.state).not.toBe('REOPEN_VERIFIED')
    expect(missing.mismatch?.join('\n')).toMatch(/nmr/)
  })

  it('PDF 腿：真实文件字节与 prepared 一致才过；被篡改点名面板', async () => {
    const pdfA = 'figpact-resources/p/aaa.pdf'
    const pdfB = 'figpact-resources/p/bbb.pdf'
    const cfgA = 'figpact-resources/p/aaa.yaml'
    const cfgB = 'figpact-resources/p/bbb.yaml'
    await seed([managed('nmr'), managed('xrd')])
    const plan = await planOf(pdfA, pdfB, cfgA, cfgB)
    applyFigpactBatch(plan)
    expect((await persistFigpactBatch(plan)).state).toBe('HOST_PERSISTED')
    const good = await reopenVerifyFigpactBatch(plan, {
      fetchFile: fileFetch(pdfA, pdfB), fetchConfig: configFetch(cfgA, cfgB),
    })
    expect(good.state).toBe('REOPEN_VERIFIED')
    const bad = await reopenVerifyFigpactBatch(plan, {
      fetchFile: fileFetch(pdfA, pdfB, pdfA), fetchConfig: configFetch(cfgA, cfgB),
    })
    expect(bad.state).toBe('REOPEN_MISMATCH')
    expect(bad.mismatch?.join('\n')).toMatch(/nmr/)
  })

  it('PDF 腿：宿主未知时 unreadable，且 verdict 不是 REOPEN_VERIFIED', async () => {
    const pdfA = 'figpact-resources/p/aaa.pdf'
    const pdfB = 'figpact-resources/p/bbb.pdf'
    const cfgA = 'figpact-resources/p/aaa.yaml'
    const cfgB = 'figpact-resources/p/bbb.yaml'
    await seed([managed('nmr'), managed('xrd')])
    const plan = await planOf(pdfA, pdfB, cfgA, cfgB)
    applyFigpactBatch(plan)
    expect((await persistFigpactBatch(plan)).state).toBe('HOST_PERSISTED')
    const missing = await reopenVerifyFigpactBatch(plan, {
      fetchFile: async () => ({ data: null, sha256: null }),
      fetchConfig: configFetch(cfgA, cfgB),
    })
    expect(missing.state).not.toBe('REOPEN_VERIFIED')
    expect(missing.mismatch?.join('\n')).toMatch(/nmr/)
  })
})

describe('figpact 批次：用户挪过面板', () => {
  it('批次按原几何计划，落地前面板被挪动 -> 拒绝且保留用户的改动', async () => {
    await seed([managed('nmr'), managed('xrd')])
    const plan = await planOf('figpact-resources/p/a.pdf', 'figpact-resources/p/b.pdf',
                              'p/a.yaml', 'p/b.yaml')
    // 批次自己算出的目标几何（与当前页一致时才会放行）。
    const planned = { id: 'nmr', x: 0, y: 0, w: 40, h: 30, nativeW: 80, nativeH: 60 }
    plan.next_document = { schema: 3, canvases: [{ objects: [planned] }] }
    expect(applyFigpactBatch(plan).state).toBe('HOST_APPLIED')

    await seed([managed('nmr'), managed('xrd')])
    useDocumentStore.getState().commit({ key: 'ui.move' } as never, (d) => {
      const o = d.objects.find((x) => x.id === 'nmr')
      if (o) o.x = 12
    })

    const historyBefore = useDocumentStore.getState().past.length
    const refused = applyFigpactBatch(plan)
    expect(refused.state).toBe('REFUSED')
    expect(refused.mismatch?.join(' ')).toContain('nmr: panel placement changed')
    expect(useDocumentStore.getState().past.length).toBe(historyBefore)
    expect(useDocumentStore.getState().doc.objects.find((o) => o.id === 'nmr')?.x).toBe(12)
  })
})
