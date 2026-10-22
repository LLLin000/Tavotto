import { create } from 'zustand'
import { newId } from '@/lib/id'
import { currentProjectId, onCurrentProjectChange } from '@/lib/session'
import { useAssetStore } from '@/store/assetStore'
import { useDocumentStore } from '@/store/documentStore'
import { useProjectStore } from '@/store/projectStore'

/**
 * Figpact live bridge (G2-B/C): explicit capture + exact display against a
 * loopback `figpact/host_server.py` session.
 *
 * - Connect string `http://127.0.0.1:<port>/#token=<secret>`; endpoint + token
 *   live in module memory only — never in state, storage, log, or DOM.
 * - Payloads are built explicitly from `documentStore.buildProject()` /
 *   `documentId` / `activeCanvasId` / the active project path. No autosave
 *   reads, no page mutation.
 * - `generation` bumps on every connect/disconnect and on any relevant
 *   doc/project/assets change (save-status-only churn excluded); `requestSeq`
 *   supersedes in-flight capture/frame work. Both are checked after every
 *   await and late arrivals are discarded.
 * - No Tavotto engine imports, no figure Python execution.
 */

export type FigpactStatus =
  | 'offline'
  | 'connecting'
  | 'ready'
  | 'stale'
  | 'capturing'
  | 'framing'
  | 'error'

export interface FigpactLayoutSnapshot {
  schema: string
  revision: string
  [key: string]: unknown
}

export interface FigpactBinding {
  schema: 'figpact.frame-binding/1'
  snapshot_revision: string
  project_id: string | null
  page_id: string | null
  panel_id: string
  resource_revision: string | null
  overrides_revision: string | null
  source_revision: string
  base_config_revision: string
  frame_revision: string
  native_size_mm: [number, number]
  preview_ref: string
  scene_ref: string
  request_id: number
  display_status: 'offered' | 'displayed'
  native_size_changed: boolean | null
  limits: string[]
}

export interface FigpactFrame {
  schema: 'figpact.inspector/1'
  png_base64: string
  png_sha256: string
  scene_json: string
  scene_sha256: string
  frame_revision: string
  image_revision: string
  geometry_revision: string
  /** Passthrough inspector facts; not validated or executed here. */
  [key: string]: unknown
}

interface FigpactState {
  status: FigpactStatus
  error: string | null
  layout: FigpactLayoutSnapshot | null
  binding: FigpactBinding | null
  frame: FigpactFrame | null
  projection: unknown
  precheck: unknown
  connect: (connection: string) => Promise<void>
  capture: () => Promise<void>
  requestFrame: () => Promise<void>
  disconnect: () => void
  displayed: (binding: FigpactBinding) => Promise<void>
}

/* Guard predicate lives in renderScheduler (single definition); not duplicated here. */

/* ------------------------------------------------------------------ */
/*  memory-only session (never in state/storage/log/DOM)               */
/* ------------------------------------------------------------------ */

let endpoint: string | null = null
let token: string | null = null
// Browser-instance identity, stable for this module's lifetime: the server
// pins one instance_id, so Disconnect→Reconnect to the same server must
// present the same id. A full page reload mints a new id and therefore
// requires a fresh host-session (it must not silently steal another tab).
const instanceId = newId('live')
let generation = 0
let requestSeq = 0
/** Configured render target; null denotes a capture-only session. */
let panelId: string | null = null

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function parseConnection(raw: string): { endpoint: string; token: string } {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new Error('figpact: connect string must be a URL like http://127.0.0.1:<port>/#token=…')
  }
  if (url.protocol !== 'http:') throw new Error('figpact: connect string must be plain http')
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1') {
    throw new Error('figpact: host must be loopback')
  }
  if (url.username || url.password) throw new Error('figpact: connect string must not carry credentials')
  if (url.search) throw new Error('figpact: connect string must not carry a query')
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('figpact: connect string must not carry a path')
  }
  const m = /^#token=([^#]+)$/.exec(url.hash)
  if (!m || !m[1]) throw new Error('figpact: connect string must carry #token=')
  let secret = ''
  try {
    secret = decodeURIComponent(m[1])
  } catch {
    throw new Error('figpact: token is not decodable')
  }
  if (!secret) throw new Error('figpact: connect string must carry #token=')
  return { endpoint: `${url.protocol}//${url.host}/`, token: secret }
}

async function hostFetch(path: string, body?: unknown): Promise<unknown> {
  if (!endpoint || !token) throw new Error('figpact: not connected')
  const res = await fetch(endpoint + path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'omit',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const msg =
      typeof data === 'object' && data !== null && 'message' in data
        ? String((data as Record<string, unknown>).message)
        : res.statusText
    throw new Error(`figpact: ${res.status} ${msg}`)
  }
  return data
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const HEX64 = /^[0-9a-f]{64}$/

function asLayout(v: unknown): FigpactLayoutSnapshot {
  if (typeof v !== 'object' || v === null) throw new Error('figpact: capture returned no layout')
  const r = v as Record<string, unknown>
  if (r.schema !== 'figpact.layout/1') throw new Error('figpact: unexpected layout schema')
  if (typeof r.revision !== 'string' || !HEX64.test(r.revision)) {
    throw new Error('figpact: layout has no snapshot revision')
  }
  return r as FigpactLayoutSnapshot
}

function asBinding(v: unknown): FigpactBinding {
  if (typeof v !== 'object' || v === null) throw new Error('figpact: frame returned no binding')
  const r = v as Record<string, unknown>
  if (r.schema !== 'figpact.frame-binding/1') throw new Error('figpact: unexpected binding schema')
  if (typeof r.snapshot_revision !== 'string' || !HEX64.test(r.snapshot_revision)) {
    throw new Error('figpact: binding has no snapshot revision')
  }
  if (typeof r.panel_id !== 'string' || !r.panel_id) throw new Error('figpact: binding has no panel')
  if (typeof r.preview_ref !== 'string' || typeof r.scene_ref !== 'string') {
    throw new Error('figpact: binding has no content refs')
  }
  if (typeof r.frame_revision !== 'string' || !r.frame_revision) {
    throw new Error('figpact: binding has no frame revision')
  }
  if (typeof r.request_id !== 'number' || !Number.isInteger(r.request_id) || r.request_id < 0) {
    throw new Error('figpact: binding has no request id')
  }
  if (r.display_status !== 'offered') throw new Error('figpact: binding is not offered')
  return r as unknown as FigpactBinding
}

function asFrame(v: unknown): FigpactFrame {
  if (typeof v !== 'object' || v === null) throw new Error('figpact: frame returned no pixels')
  const r = v as Record<string, unknown>
  if (r.schema !== 'figpact.inspector/1') throw new Error('figpact: unexpected frame schema')
  for (const k of [
    'png_base64',
    'png_sha256',
    'scene_json',
    'scene_sha256',
    'frame_revision',
    'image_revision',
    'geometry_revision',
  ]) {
    if (typeof r[k] !== 'string' || !(r[k] as string)) throw new Error(`figpact: frame has no ${k}`)
  }
  if (!HEX64.test(r.png_sha256 as string) || !HEX64.test(r.scene_sha256 as string)) {
    throw new Error('figpact: frame has malformed digests')
  }
  if (r.frame_revision !== r.image_revision || r.frame_revision !== r.geometry_revision) {
    throw new Error('figpact: frame revisions are not the same capture')
  }
  return r as unknown as FigpactFrame
}

/* ------------------------------------------------------------------ */
/*  staleness: owned doc/project/assets changes invalidate bindings    */
/* ------------------------------------------------------------------ */

let subscribed = false

function markStale(): void {
  generation += 1
  requestSeq += 1
  if (!endpoint) return
  const s = useFigpactStore.getState()
  if (s.status === 'capturing' || s.status === 'framing' || s.layout || s.binding) {
    // Bytes stay as unbound cache only: layout/binding/projection/precheck
    // are dropped so nothing new projects onto old geometry, and busy
    // settles into an explicit connected-stale state (capture needed).
    useFigpactStore.setState({
      status: 'stale',
      layout: null,
      binding: null,
      projection: null,
      precheck: null,
    })
  }
}

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  // Save-status-only churn (saveState/dirty/recent/history) is excluded: it
  // must not invalidate a live binding.
  useDocumentStore.subscribe((s, prev) => {
    if (
      s.documentId !== prev.documentId ||
      s.loadSeq !== prev.loadSeq ||
      s.doc !== prev.doc ||
      s.canvases !== prev.canvases ||
      s.activeCanvasId !== prev.activeCanvasId ||
      s.projectMeta !== prev.projectMeta
    ) {
      markStale()
    }
  })
  // Project identity switches synchronously at setCurrentProjectId, before
  // projectStore adoption lands — invalidate here, not on the later store.
  onCurrentProjectChange(() => markStale())
  useProjectStore.subscribe((s, prev) => {
    if (s.project?.id !== prev.project?.id || s.phase !== prev.phase) markStale()
  })
  useAssetStore.subscribe((s, prev) => {
    if (s.panels !== prev.panels || s.byId !== prev.byId || s.figuresDir !== prev.figuresDir) {
      markStale()
    }
  })
}

/* ------------------------------------------------------------------ */
/*  store                                                               */
/* ------------------------------------------------------------------ */

export const useFigpactStore = create<FigpactState>((set, get) => ({
  status: 'offline',
  error: null,
  layout: null,
  binding: null,
  frame: null,
  projection: null,
  precheck: null,

  connect: async (connection) => {
    ensureSubscribed()
    let parsed: { endpoint: string; token: string }
    try {
      parsed = parseConnection(connection)
    } catch (e) {
      set({ error: errMsg(e) })
      return
    }
    // A new connect invalidates all older async results.
    generation += 1
    requestSeq += 1
    const mine = generation
    endpoint = parsed.endpoint
    token = parsed.token
    panelId = null
    set({
      status: 'connecting',
      error: null,
      layout: null,
      binding: null,
      frame: null,
      projection: null,
      precheck: null,
    })
    try {
      const session = (await hostFetch('session')) as Record<string, unknown> | null
      if (generation !== mine) return
      if (typeof session !== 'object' || session === null || session.schema !== 'figpact.host-session/1') {
        throw new Error('figpact: unexpected session schema')
      }
      if (!('panel_id' in session)) throw new Error('figpact: session has no panel field')
      const pinned = session.panel_id
      // Explicit null is valid capture-only mode (no managed panel
      // configured); malformed values still reject.
      if (pinned === null) panelId = null
      else if (typeof pinned === 'string' && pinned) panelId = pinned
      else throw new Error('figpact: session panel id is malformed')
      set({ status: 'ready' })
    } catch (e) {
      if (generation !== mine) return
      set({ status: 'offline', error: errMsg(e) })
    }
  },

  capture: async () => {
    ensureSubscribed()
    if (!endpoint || !token) {
      set({ status: 'error', error: 'figpact: not connected' })
      return
    }
    const mine = generation
    requestSeq += 1
    const req = requestSeq
    set({ status: 'capturing', error: null })
    try {
      const d = useDocumentStore.getState()
      // Authoritative adopted project: current figures dir only. Recent
      // entries and resource-list dirs can lag a project switch and are
      // not active-page facts.
      const ps = useProjectStore.getState()
      const projectRoot = ps.project?.figures_dir ?? null
      if (!projectRoot) throw new Error('figpact: no active project')
      if (ps.phase !== 'open' || ps.switching || ps.project?.id !== currentProjectId()) {
        throw new Error('figpact: project is switching')
      }
      if (!d.documentId || !d.activeCanvasId) throw new Error('figpact: no active page')
      const res = (await hostFetch('capture', {
        instance_id: instanceId,
        generation: mine,
        document_id: d.documentId,
        canvas_id: d.activeCanvasId,
        project_root: projectRoot,
        document: d.buildProject(),
      })) as Record<string, unknown>
      if (generation !== mine || requestSeq !== req) return
      const layout = asLayout(res?.layout)
      set({ status: 'ready', layout, binding: null, projection: null, precheck: null })
    } catch (e) {
      if (generation !== mine || requestSeq !== req) return
      set({ status: 'error', error: errMsg(e) })
    }
  },

  requestFrame: async () => {
    ensureSubscribed()
    const layout = get().layout
    if (!endpoint || !token || !layout) {
      set({ status: 'error', error: 'figpact: capture the page first' })
      return
    }
    // Capture-only session (no managed panel): refuse locally, no network.
    if (!panelId) {
      set({ status: 'error', error: 'figpact: session has no managed panel' })
      return
    }
    const mine = generation
    requestSeq += 1
    const req = requestSeq
    set({ status: 'framing', error: null })
    try {
      const res = (await hostFetch('frame', {
        snapshot_revision: layout.revision,
        request_id: req,
      })) as Record<string, unknown>
      if (generation !== mine || requestSeq !== req) return
      const binding = asBinding(res?.binding)
      const frame = asFrame(res?.frame)
      // Verify the actual bytes before storing anything.
      const pngHash = await sha256Hex(base64ToBytes(frame.png_base64))
      if (generation !== mine || requestSeq !== req) return
      const sceneHash = await sha256Hex(new TextEncoder().encode(frame.scene_json))
      if (generation !== mine || requestSeq !== req) return
      if (pngHash !== frame.png_sha256) throw new Error('figpact: PNG bytes fail their hash')
      if (sceneHash !== frame.scene_sha256) throw new Error('figpact: scene bytes fail their hash')
      if (binding.preview_ref !== `sha256:${frame.png_sha256}`) {
        throw new Error('figpact: binding preview ref mismatches PNG')
      }
      if (binding.scene_ref !== `sha256:${frame.scene_sha256}`) {
        throw new Error('figpact: binding scene ref mismatches scene')
      }
      if (binding.frame_revision !== frame.frame_revision) {
        throw new Error('figpact: binding and frame are not the same capture')
      }
      if (binding.snapshot_revision !== layout.revision) {
        throw new Error('figpact: frame belongs to an older capture')
      }
      if (binding.request_id !== req) throw new Error('figpact: frame answers another request')
      if (panelId && binding.panel_id !== panelId) {
        throw new Error('figpact: frame is for another panel')
      }
      const objects = (layout as Record<string, unknown>).objects
      if (!Array.isArray(objects)) throw new Error('figpact: layout has no objects')
      const target = objects.find(
        (o) => typeof o === 'object' && o !== null && (o as Record<string, unknown>).id === binding.panel_id,
      ) as Record<string, unknown> | undefined
      if (!target) throw new Error('figpact: frame panel is not in the current layout')
      if (target.kind !== 'panel' || target.render_owner !== 'figpact') {
        throw new Error('figpact: frame panel is not managed')
      }
      if (
        binding.project_id !== (layout.project_id ?? null) ||
        binding.page_id !== (layout.page_id ?? null) ||
        binding.resource_revision !== (target.resource_revision ?? null) ||
        binding.overrides_revision !== (target.overrides_revision ?? null)
      ) {
        throw new Error('figpact: frame identity mismatches current layout')
      }
      set({
        status: 'ready',
        binding,
        frame,
        projection: res?.projection ?? null,
        precheck: res?.precheck ?? null,
      })
    } catch (e) {
      if (generation !== mine || requestSeq !== req) return
      // A failed fresh display cannot retain a current-looking old binding:
      // unbind, keep old frame bytes only as cache.
      set({ status: 'error', error: errMsg(e), binding: null, projection: null, precheck: null })
    }
  },

  disconnect: () => {
    endpoint = null
    token = null
    panelId = null
    generation += 1
    requestSeq += 1
    set({
      status: 'offline',
      error: null,
      layout: null,
      binding: null,
      frame: null,
      projection: null,
      precheck: null,
    })
  },

  displayed: async (binding) => {
    // Only the exact currently-offered binding counts as observed display;
    // stale onLoad arrivals and source errors are ignored.
    const cur = get().binding
    if (!cur || !endpoint || !token) return
    const same =
      cur.request_id === binding.request_id &&
      cur.snapshot_revision === binding.snapshot_revision &&
      cur.project_id === binding.project_id &&
      cur.page_id === binding.page_id &&
      cur.panel_id === binding.panel_id &&
      cur.frame_revision === binding.frame_revision &&
      cur.preview_ref === binding.preview_ref &&
      cur.scene_ref === binding.scene_ref
    if (!same) return
    const mine = generation
    const req = cur.request_id
    try {
      await hostFetch('display', { ...binding, display_status: 'displayed' })
      const now = get().binding
      if (generation !== mine || !now || now.request_id !== req) return
      // The receipt is client-reported image-load evidence, not acceptance:
      // nothing further to store.
    } catch (e) {
      const now = get().binding
      if (generation !== mine || !now || now.request_id !== req) return
      set({ error: errMsg(e) })
    }
  },
}))
