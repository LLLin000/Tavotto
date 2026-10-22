import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setCurrentProjectId } from '@/lib/session'
import { emptyDocument, type PanelObject } from '@/types/document'
import { useDocumentStore } from '@/store/documentStore'
import { useProjectStore } from '@/store/projectStore'
import { useFigpactStore } from './figpactStore'

const ROOT = 'C:/g2/project'
const REVISION = 'a'.repeat(64)
const FRAME = 'f'.repeat(64)
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII='
const scene = JSON.stringify({ schema: 'figpact.inspector.scene/1', scope: 'main',
  coordinate_reference: 'canvas_bottom_left', unit: 'mm', canvas_bounds_mm: [0, 0, 80, 68], nodes: [] })
const pngHash = createHash('sha256').update(Buffer.from(PNG, 'base64')).digest('hex')
const sceneHash = createHash('sha256').update(scene).digest('hex')
const panel: PanelObject = {
  id: 'managed', type: 'panel', x: 10, y: 20, w: 40, h: 34,
  fileId: 'runtime:figpact/nmr', fileKind: 'runtime', nativeW: 80, nativeH: 68,
  figureFrame: 1, script: 'nmr.py', overrides: [], renderOwner: 'figpact',
  figpact: { scope: 'main', config: 'nmr.yaml' },
}
const layout = {
  schema: 'figpact.layout/1', source_mode: 'live', revision: REVISION,
  project_id: 'doc-a', page_id: 'canvas-a', page_mm: [150, 100],
  objects: [{ id: 'managed', kind: 'panel', render_owner: 'figpact', rect_mm: [10, 20, 40, 34],
    measurement_status: 'conservative', resource_revision: 'resource-a', overrides_revision: 'overrides-a' }],
}
function frameReply(requestId: number) {
  return {
    binding: {
      schema: 'figpact.frame-binding/1', snapshot_revision: REVISION,
      project_id: 'doc-a', page_id: 'canvas-a', panel_id: 'managed',
      resource_revision: 'resource-a', overrides_revision: 'overrides-a',
      source_revision: 'source-a', base_config_revision: 'config-a', frame_revision: FRAME,
      native_size_mm: [80, 68], preview_ref: `sha256:${pngHash}`, scene_ref: `sha256:${sceneHash}`,
      request_id: requestId, display_status: 'offered', native_size_changed: false, limits: [],
    },
    frame: { schema: 'figpact.inspector/1', frame_revision: FRAME, image_revision: FRAME,
      geometry_revision: FRAME, png_base64: PNG, png_sha256: pngHash,
      source_revision: 'source-a', base_config_revision: 'config-a', scope: 'main',
      science: { verified: true }, evidence: { render: 'SAME_CAPTURE_PNG_SCENE' },
      scene_json: scene, scene_sha256: sceneHash },
    projection: { nodes: [] }, precheck: { risks: [] },
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
})
let captures: (body: unknown) => Promise<Response>
let frames: (body: { request_id: number }) => Promise<Response>
let displayRequests: unknown[]

beforeEach(() => {
  useFigpactStore.getState().disconnect()
  vi.stubGlobal('crypto', webcrypto)
  setCurrentProjectId('project-a')
  useProjectStore.setState({ phase: 'open', switching: false,
    project: { id: 'project-a', open: true, figures_dir: ROOT }, recent: [] })
  const doc = emptyDocument()
  doc.objects = [structuredClone(panel)]
  useDocumentStore.setState({ documentId: 'doc-a', activeCanvasId: 'canvas-a', doc,
    canvases: [{ id: 'canvas-a', name: doc.name, page: doc.page, objects: doc.objects, guides: [] }],
    projectMeta: { id: 'project-a', name: 'G2 fixture', createdAt: 0 } })
  captures = async () => json({ layout: structuredClone(layout) })
  frames = async (body) => json(frameReply(body.request_id))
  displayRequests = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' || input instanceof URL ? input : input.url).pathname
    if (path === '/session') return json({ schema: 'figpact.host-session/1', base_path: ROOT, panel_id: 'managed' })
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null
    if (path === '/capture') return captures(body)
    if (path === '/frame') return frames(body as { request_id: number })
    if (path === '/display') { displayRequests.push(body); return json({ status: 'DISPLAY_OBSERVED' }) }
    throw new Error(`Unexpected fixture request: ${path}`)
  }))
})
afterEach(() => {
  useFigpactStore.getState().disconnect()
  setCurrentProjectId(null)
  vi.unstubAllGlobals()
})
async function connectAndCapture() {
  await useFigpactStore.getState().connect('http://127.0.0.1:51234/#token=test-session-only')
  await useFigpactStore.getState().capture()
  expect(useFigpactStore.getState().layout?.revision).toBe(REVISION)
}
function moveUnsaved() {
  const current = useDocumentStore.getState().doc
  useDocumentStore.setState({ doc: { ...current, objects: current.objects.map((o) => ({ ...o, x: o.x + 1 })) } })
}

describe('explicit live capture and authoritative Frame visibility', () => {
  it.each(['move', 'canvas', 'early-project-switch'] as const)(
    'drops a delayed capture after %s without leaving controls busy or retaining old geometry', async (change) => {
      await connectAndCapture()
      const pending = deferred<Response>()
      captures = () => pending.promise
      const operation = useFigpactStore.getState().capture()
      if (change === 'move') moveUnsaved()
      else if (change === 'canvas') useDocumentStore.setState({ activeCanvasId: 'canvas-b' })
      else setCurrentProjectId('project-b') // metadata adoption has deliberately not completed
      pending.resolve(json({ layout }))
      await operation
      const state = useFigpactStore.getState()
      expect(state.layout).toBeNull()
      expect(state.binding).toBeNull()
      expect(['capturing', 'framing']).not.toContain(state.status)
      await state.requestFrame()
      expect(useFigpactStore.getState().binding).toBeNull()
    },
  )

  it('does not let a delayed Frame or old onLoad revive a moved page; caches only unbound pixels', async () => {
    await connectAndCapture()
    await useFigpactStore.getState().requestFrame()
    const before = useFigpactStore.getState()
    expect(before.binding?.frame_revision).toBe(FRAME)
    const offered = before.binding!
    const pending = deferred<Response>()
    let requestId = 0
    frames = (body) => { requestId = body.request_id; return pending.promise }
    const operation = before.requestFrame()
    const pageBefore = structuredClone(useDocumentStore.getState().doc.page)
    moveUnsaved()
    pending.resolve(json(frameReply(requestId)))
    await operation
    await useFigpactStore.getState().displayed(offered)
    const after = useFigpactStore.getState()
    expect(after.binding).toBeNull()
    expect(after.layout).toBeNull()
    expect(after.frame?.png_sha256).toBe(pngHash)
    expect(displayRequests).toEqual([])
    expect(useDocumentStore.getState().doc.page).toEqual(pageBefore)
    expect(useDocumentStore.getState().doc.objects[0].w).toBe(40)
  })

  it.each(['png', 'scene', 'capture', 'request', 'resource'] as const)(
    'refuses a %s mismatch rather than making the supplied pixels displayable', async (kind) => {
      await connectAndCapture()
      frames = async (body) => {
        const reply = frameReply(body.request_id)
        if (kind === 'png') reply.frame.png_base64 = 'dGFtcGVyZWQ='
        else if (kind === 'scene') reply.frame.scene_json += ' '
        else if (kind === 'capture') reply.frame.geometry_revision = 'b'.repeat(64)
        else if (kind === 'request') reply.binding.request_id -= 1
        else reply.binding.resource_revision = 'unrelated-resource'
        return json(reply)
      }
      await useFigpactStore.getState().requestFrame()
      expect(useFigpactStore.getState().binding).toBeNull()
      expect(useFigpactStore.getState().error).toBeTruthy()
      expect(displayRequests).toEqual([])
    },
  )

  it('preserves the displayed binding across save-status-only changes', async () => {
    await connectAndCapture()
    await useFigpactStore.getState().requestFrame()
    const before = useFigpactStore.getState().binding
    expect(before?.frame_revision).toBe(FRAME)
    useDocumentStore.setState({ dirty: !useDocumentStore.getState().dirty })
    expect(useFigpactStore.getState().binding).toEqual(before)
  })
})
