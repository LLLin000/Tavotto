/**
 * 托管面板的离线兜底（G4-B）：没有实时绑定/帧时，显示页里写明的那个已保存 PDF。
 *
 * 三条分支（按优先级）：
 * 1. 实时绑定+帧在 -> 实时 PNG（与从前逐字节相同，display 回执照发）；
 * 2. 无实时但 fileId 是页里写明的真实文件 -> /api/render 出那份 PDF（`data-figpact-offline="prepared"`）；
 * 3. fileId 仍是 opaque runtime id（assetStore 无记录）-> 空白 + stale 角标（从前一样），绝不猜地址。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { useAssetStore } from '@/store/assetStore'
import { emptyDocument, emptyProject, type PanelObject } from '@/types/document'
import { useDocumentStore } from '@/store/documentStore'
import { useFigpactStore } from '@/store/figpactStore'
import { useProjectStore } from '@/store/projectStore'
import { useViewportStore } from '@/store/viewportStore'
import { ObjectView } from './ObjectView'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let mountEl: HTMLDivElement

const live = () => useDocumentStore.getState().doc.objects.find((o) => o.id === 'managed') as PanelObject

async function mount(fileId: string) {
  useAssetStore.setState({
    byId: fileId.startsWith('runtime:')
      ? {}
      : { [fileId]: { id: fileId, name: fileId, folder: '.', kind: 'pdf', native_w_mm: 80, native_h_mm: 60, mtime: 7 } },
  })
  const doc = emptyDocument()
  doc.objects = [
    {
      id: 'managed',
      type: 'panel',
      x: 10,
      y: 20,
      w: 40,
      h: 30,
      fileId,
      fileKind: fileId.startsWith('runtime:') ? 'runtime' : 'pdf',
      nativeW: 80,
      nativeH: 60,
      figureFrame: 1,
      script: 'managed.py',
      renderOwner: 'figpact',
      figpact: { config: 'managed.yaml', scope: 'main' },
      overrides: [],
    } as unknown as PanelObject,
  ]
  useDocumentStore.setState({ doc })
  await act(async () => {
    root.render(<ObjectView obj={live()} />)
  })
}

const hostOf = () => document.querySelector<HTMLElement>('[data-figpact-panel="managed"]')!
const imgOf = () => hostOf().querySelector('img')

beforeEach(async () => {
  document.body.innerHTML = ''
  useFigpactStore.getState().disconnect()
  useViewportStore.setState({ zoom: 1, panX: 0, panY: 0, spaceDown: false })
  useProjectStore.setState({ project: { id: 'p1', open: true, figures_dir: '/p' } } as never)
  const project = emptyProject()
  await useDocumentStore.getState().switchDocument(project, 'd_offline')
  mountEl = document.createElement('div')
  document.body.appendChild(mountEl)
  root = createRoot(mountEl)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  mountEl.remove()
  useFigpactStore.getState().disconnect()
  useAssetStore.setState({ byId: {}, panels: [] })
})

describe('托管面板离线兜底', () => {
  it('fileId 是真实文件时显示已保存的 PDF，不发 display 回执', async () => {
    await mount('FigM.pdf')
    const img = imgOf()
    expect(img).not.toBeNull()
    // 同一条 panelSrc 链：/api/render?id=<fileId>，绝不是伪造的 binding / POST /display
    expect(img!.getAttribute('src')).toContain('/api/render?id=FigM.pdf')
    expect(hostOf().getAttribute('data-figpact-offline')).toBe('prepared')
    expect(hostOf().getAttribute('data-figpact-binding')).toBeNull()
    expect(document.body.textContent).toContain('非实时')
  })

  it('fileId 仍是 opaque runtime id 时保持空白 + stale，不挂碎图', async () => {
    await mount('runtime:figpact/managed')
    expect(imgOf()).toBeNull()
    expect(hostOf().getAttribute('data-figpact-offline')).toBeNull()
    expect(hostOf().getAttribute('data-display')).toBe('figpact-stale')
    expect(document.body.textContent).toContain('请重新抓取')
  })

  it('fileId 换了旧兜底地址立刻失效', async () => {
    await mount('FigM.pdf')
    expect(imgOf()!.getAttribute('src')).toContain('/api/render?id=FigM.pdf')
    // fileId 指向另一份真实文件：地址必须跟着换，不能还挂着旧 PDF。
    useAssetStore.setState({
      byId: { 'FigN.pdf': { id: 'FigN.pdf', name: 'FigN.pdf', folder: '.', kind: 'pdf', native_w_mm: 80, native_h_mm: 60, mtime: 9 } },
    })
    await act(async () => {
      useDocumentStore.getState().commit('换文件' as never, (d) => {
        const o = d.objects.find((x) => x.id === 'managed')
        if (o?.type === 'panel') o.fileId = 'FigN.pdf'
      })
    })
    await act(async () => {
      root.render(<ObjectView obj={live()} />)
    })
    expect(imgOf()!.getAttribute('src')).toContain('/api/render?id=FigN.pdf')
    expect(hostOf().getAttribute('data-figpact-offline')).toBe('prepared')
  })
})
