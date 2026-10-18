import React, { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { MermaidDiagram } from '../src/components/MermaidDiagram/MermaidDiagram'
import { namespaceMermaidSvg } from '../src/components/MermaidDiagram/mermaidRenderCache'

const root = createRoot(document.getElementById('root')!)
const chart = 'graph TD\n A[Start] --> B[Finish]'
const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label) }
const tick = () => new Promise(resolve => setTimeout(resolve, 20))
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 500; i++) { if (check()) return; await tick() }
  throw new Error(`Timed out: ${label}`)
}
const render = (charts: string[]) => flushSync(() => root.render(
  <StrictMode>{charts.map((chart, index) => <MermaidDiagram key={index} chart={chart} />)}</StrictMode>
))
const diagram = () => document.querySelector<HTMLElement>('.mermaid-diagram')!
const inlineSvg = () => diagram()?.querySelector('div.inline-block svg')
const openButton = () => document.querySelector<HTMLButtonElement>('[aria-label="Open interactive diagram viewer"]')!

Object.assign(window, {
  __runMermaidSmoke: async () => {
    const checks: string[] = []
    // Model the layout utilities used by the component without loading the app.
    const style = document.createElement('style')
    style.textContent = '.mermaid-diagram { margin: 12px 0; } .max-h-\\[60vh\\] { max-height: 60vh; overflow: auto; } .min-h-32 { min-height: 128px; }'
    document.head.append(style)

    render([chart])
    await until(() => !!inlineSvg(), 'initial Mermaid render')
    const initialHeight = diagram().getBoundingClientRect().height
    assert(initialHeight > 128, 'real diagram has settled dimensions')
    const originalSvg = inlineSvg()!.outerHTML
    checks.push('real Mermaid render and settled dimensions')

    render([])
    render([chart])
    // Intentionally do not await effects: this must be restored in the first commit.
    assert(!!inlineSvg(), 'cached SVG is present in the remount commit')
    assert(!diagram().textContent?.includes('Rendering diagram…'), 'remount has no loading placeholder')
    assert(diagram().getBoundingClientRect().height === initialHeight, 'remount preserves height')
    assert(inlineSvg()!.outerHTML !== originalSvg, 'remount namespaces SVG IDs')
    checks.push('synchronous cached remount without height collapse')

    render([chart, chart])
    await until(() => document.querySelectorAll('.mermaid-diagram div.inline-block svg').length === 2, 'duplicate diagram')
    const ids = Array.from(document.querySelectorAll('[id]')).map(element => element.id)
    assert(ids.length === new Set(ids).size, 'identical mounted diagrams have unique IDs')
    for (const svg of Array.from(document.querySelectorAll('.mermaid-diagram div.inline-block svg'))) {
      assert(svg.querySelector('style')?.textContent?.includes(`#${svg.id}`), 'CSS follows the namespaced root')
      for (const element of Array.from(svg.querySelectorAll('*'))) {
        for (const attribute of Array.from(element.attributes)) {
          for (const match of attribute.value.matchAll(/url\(["']?#([^)'"\s]+)/g)) {
            assert(Array.from(svg.querySelectorAll('[id]')).some(target => target.id === match[1]), 'marker references resolve inside their SVG')
          }
        }
      }
    }
    checks.push('duplicate cached diagrams keep local CSS and marker references')

    const viewerHeight = diagram().getBoundingClientRect().height
    openButton().click()
    await until(() => !!document.querySelector('[role="dialog"]'), 'fullscreen viewer')
    assert(diagram().getBoundingClientRect().height === viewerHeight, 'fullscreen keeps inline height')
    const allIds = Array.from(document.querySelectorAll('[id]')).map(element => element.id)
    assert(allIds.length === new Set(allIds).size, 'viewer and inline SVG IDs are distinct')
    document.querySelector<HTMLButtonElement>('[aria-label="Close diagram viewer"]')!.click()
    await until(() => !document.querySelector('[role="dialog"]'), 'close fullscreen viewer')
    assert(diagram().getBoundingClientRect().height === viewerHeight, 'closing viewer keeps inline height')
    checks.push('fullscreen open and close preserve inline geometry and unique IDs')

    document.documentElement.classList.add('dark')
    await until(() => !!inlineSvg() && inlineSvg()!.outerHTML !== originalSvg &&
      inlineSvg()!.querySelector('style')!.textContent!.includes('#1f2020'), 'dark Mermaid render')
    render([])
    render([chart])
    assert(!!inlineSvg(), 'dark diagram restores synchronously')
    document.documentElement.classList.remove('dark')
    await until(() => !!inlineSvg() && !inlineSvg()!.querySelector('style')!.textContent!.includes('#1f2020'), 'cached light theme')
    checks.push('theme-specific cached renders')

    render(['graph TD\n A --> C[Changed source]'])
    assert(!inlineSvg(), 'changed source does not show the old cached SVG')
    await until(() => !!inlineSvg(), 'changed source render')
    assert(inlineSvg()!.textContent!.includes('Changed source'), 'changed source renders new content')
    checks.push('source changes invalidate cached content')

    const sample = '<svg xmlns="http://www.w3.org/2000/svg" id="root"><style>#root #abc {fill:#abc;marker-end:url(#abc)}</style><defs><marker id="abc"/></defs><use href="#abc" aria-labelledby="abc"/><path marker-end="url(http://localhost/chat#abc)"/><text>#abc</text></svg>'
    const rewritten = namespaceMermaidSvg(sample, 'instance')
    assert(rewritten.includes('#instance-root #instance-abc'), 'CSS ID selectors rewritten')
    assert(rewritten.includes('fill:#abc'), 'hex colours preserved')
    assert(rewritten.includes('href="#instance-abc"'), 'local href rewritten')
    assert(rewritten.includes('aria-labelledby="instance-abc"'), 'accessible ID references rewritten')
    assert(rewritten.includes('url(#instance-abc)'), 'absolute marker URLs normalized to local IDs')
    assert(rewritten.includes('<text>#abc</text>'), 'label text preserved')
    checks.push('SVG namespacing preserves colours and labels while rewriting references')

    render([])
    return checks
  },
})
