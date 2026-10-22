import { afterEach, expect, it } from 'vitest'
import { renderTargets, syncEngine } from '@/hooks/useEngineSync'
import { enterElementEdit, rebuildPanel } from '@/store/actions'
import { useDocumentStore } from '@/store/documentStore'
import { flushRender, requestRender } from '@/store/renderScheduler'
import { useRenderStore } from '@/store/renderStore'
import { useUiStore } from '@/store/uiStore'
import { emptyDocument, type PanelObject } from '@/types/document'

const originalRender = useRenderStore.getState().render
const originalDoc = useDocumentStore.getState().doc

afterEach(() => {
  useRenderStore.setState({ render: originalRender })
  useRenderStore.getState().clear()
  useDocumentStore.setState({ doc: originalDoc })
  useUiStore.getState().setElementPanel(null)
})

it('managed figures cannot execute through legacy edit, rebuild, scheduling or sync; legacy figures still render', async () => {
  const managed: PanelObject = {
    id: 'managed', type: 'panel', x: 10, y: 20, w: 40, h: 30,
    nativeW: 80, nativeH: 60, fileId: 'runtime:figpact/managed', fileKind: 'runtime',
    script: 'managed.py', figureFrame: 1, renderOwner: 'figpact',
    figpact: { config: 'managed.yaml', scope: 'main' },
    overrides: [{ gid: 'axis.title', prop: 'fontsize', value: 8 }],
  }
  const legacy: PanelObject = { ...managed, id: 'legacy', fileId: 'legacy.pdf',
    fileKind: 'pdf', script: 'legacy.py', renderOwner: undefined, figpact: undefined }
  const doc = emptyDocument()
  doc.objects = [managed, legacy]
  useDocumentStore.setState({ doc })
  useUiStore.getState().setElementPanel(null)
  const executed: string[] = []
  useRenderStore.getState().clear()
  useRenderStore.setState({ render: async (fileId) => { executed.push(fileId) } })

  expect(renderTargets(doc.objects, managed.id, { [managed.fileId]: true },
    { [managed.fileId]: 'already-rendered' }, {}, true).map((o) => o.id)).toEqual(['legacy'])
  requestRender(managed, true)
  flushRender(managed.id)
  await rebuildPanel(managed.id)
  await enterElementEdit(managed.id)
  expect(executed).toEqual([])
  expect(useUiStore.getState().elementPanelId).toBeNull()

  syncEngine(doc.objects, managed.id)
  expect(executed).toEqual(['legacy.pdf'])
  expect(useDocumentStore.getState().doc.objects[0]).toEqual(managed)
})
