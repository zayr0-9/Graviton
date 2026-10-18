import type { MermaidSize } from './mermaidViewport'

export interface MermaidRenderResult {
  svg: string
  size: MermaidSize
}

// Version the key when changing Mermaid's rendering configuration. Entries are shared
// across virtual-row remounts, not persisted to disk or kept as mounted DOM nodes.
export const getMermaidRenderKey = (chart: string, darkMode: boolean): string =>
  JSON.stringify(['strict-v1', darkMode ? 'dark' : 'default', chart])

export class MermaidRenderCache {
  private entries = new Map<string, { result: MermaidRenderResult; bytes: number }>()
  private bytes = 0

  constructor(private maxEntries = 64, private maxBytes = 8 * 1024 * 1024) {}

  get(key: string): MermaidRenderResult | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.result
  }

  set(key: string, result: MermaidRenderResult): void {
    const previous = this.entries.get(key)
    if (previous) {
      this.bytes -= previous.bytes
      this.entries.delete(key)
    }
    // Approximate UTF-16 storage, including the source/configuration key.
    const bytes = 2 * (key.length + result.svg.length)
    if (this.maxEntries < 1 || bytes > this.maxBytes) return
    this.entries.set(key, { result, bytes })
    this.bytes += bytes
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value!
      this.bytes -= this.entries.get(oldestKey)!.bytes
      this.entries.delete(oldestKey)
    }
  }
}

export const mermaidRenderCache = new MermaidRenderCache()

const pendingRenders = new Map<string, {
  promise: Promise<MermaidRenderResult>
  consumers: Array<() => boolean>
}>()
let renderQueue: Promise<unknown> = Promise.resolve()
let renderSequence = 0

// Mermaid configuration is global. Serialize initialize + render together so a
// queued light render cannot accidentally consume a later dark configuration.
export const loadMermaidRender = (
  key: string,
  render: (id: string) => Promise<MermaidRenderResult>,
  isActive: () => boolean = () => true
): Promise<MermaidRenderResult> => {
  const cached = mermaidRenderCache.get(key)
  if (cached) return Promise.resolve(cached)
  const pending = pendingRenders.get(key)
  if (pending) {
    pending.consumers.push(isActive)
    return pending.promise
  }
  const consumers = [isActive]
  const job = renderQueue.then(() => {
    // Do not spend Mermaid layout time on rows that left the overscan range
    // before their turn. A render already in progress can still fill the cache.
    if (!consumers.some(active => active())) throw new Error('Mermaid render no longer needed')
    return render(`mermaid-render-${++renderSequence}`)
  }).then(result => {
    mermaidRenderCache.set(key, result)
    return result
  }).finally(() => pendingRenders.delete(key))
  pendingRenders.set(key, { promise: job, consumers })
  renderQueue = job.catch(() => undefined)
  return job
}

/** Cached SVGs can appear more than once; namespace IDs and their local references. */
export const namespaceMermaidSvg = (svg: string, prefix: string): string => {
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
  const elements = [root, ...Array.from(root.querySelectorAll('*'))]
  const ids = new Map<string, string>()
  for (const element of elements) {
    const id = element.getAttribute('id')
    if (id) ids.set(id, `${prefix}-${id}`)
  }

  const replaceUrls = (value: string) => value.replace(
    /url\(\s*(['"]?)([^\s)'"<>]*)\1\s*\)/g,
    (match, quote: string, target: string) => {
      const id = target.slice(target.lastIndexOf('#') + 1)
      return target.includes('#') && ids.has(id) ? `url(${quote}#${ids.get(id)}${quote})` : match
    }
  )
  const replaceSelectors = (value: string) => value.replace(
    /#([\w-]+)/g,
    (match, id: string) => ids.has(id) ? `#${ids.get(id)}` : match
  )

  for (const element of elements) {
    for (const attribute of Array.from(element.attributes)) {
      let value = attribute.value
      if (attribute.name === 'id') value = ids.get(value) ?? value
      else if (attribute.localName === 'href' && value.startsWith('#')) value = ids.has(value.slice(1)) ? `#${ids.get(value.slice(1))}` : value
      else if (attribute.name === 'aria-labelledby' || attribute.name === 'aria-describedby') value = value.split(/\s+/).map(id => ids.get(id) ?? id).join(' ')
      else value = replaceUrls(value)
      attribute.value = value
    }
    if (element.localName === 'style') {
      // Rewrite selector preludes, not declarations (which may contain hex colours).
      element.textContent = replaceUrls(element.textContent ?? '').replace(
        /([^{}]+)\{/g,
        (_, selectors: string) => `${replaceSelectors(selectors)}{`
      )
    }
  }
  return new XMLSerializer().serializeToString(root)
}
