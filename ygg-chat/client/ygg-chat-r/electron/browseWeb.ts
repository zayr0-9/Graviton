/// <reference lib="dom" />
import { BrowserWindow } from 'electron'


interface BrowseWebOptions {
  waitForSelector?: string
  timeout?: number
  userAgent?: string
  viewport?: { width: number; height: number }
  waitForNetworkIdle?: boolean
  extractImages?: boolean
  extractLinks?: boolean
  extractMetadata?: boolean
  headless?: boolean
  useUserProfile?: boolean
  userDataDir?: string
  retries?: number
  retryDelay?: number
  useBrave?: boolean
  executablePath?: string
}

interface ExtractedContent {
  title: string
  url: string
  content: string
  metadata?: {
    description?: string
    author?: string
    publishDate?: string
    siteName?: string
    type?: string
  }
  headings?: Array<{
    level: number
    text: string
    id?: string
  }>
  links?: Array<{
    text: string
    href: string
    type: 'internal' | 'external'
  }>
  images?: Array<{
    src: string
    alt: string
    title?: string
  }>
  textChunks?: Array<{
    text: string
    type: 'paragraph' | 'heading' | 'list' | 'quote'
    priority: number
  }>
  allText?: string
}

interface BrowseWebResult {
  success: boolean
  data?: ExtractedContent
  error?: string
  url: string
}

// This function runs inside the browser context
// It MUST be self-contained (no external references)
function extractionFunction(options: any) {
  const { extractImages, extractLinks, extractMetadata } = options

  // Helper function to get text content and clean it
  function getCleanText(element: any): string {
    return (element as any).textContent?.trim().replace(/\s+/g, ' ') || ''
  }

  // Extract all text content from the page
  function extractAllTextContent() {
    const textElements = [
      'p',
      'span',
      'div',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'li',
      'td',
      'th',
      'blockquote',
      'pre',
      'code',
      'em',
      'strong',
      'b',
      'i',
      'u',
      'mark',
      'small',
      'sub',
      'sup',
      'article',
      'section',
      'main',
      'aside',
      'nav',
      'header',
      'footer',
      'time',
      'address',
      'figcaption',
      'caption',
      'label',
      'legend',
      'summary',
      'details',
    ]

    const allTextContent: string[] = []
    const processedElements = new Set()

    // Get all elements that might contain text
    const allElements = document.querySelectorAll(textElements.join(', '))

    Array.from(allElements).forEach((element: any) => {
      // Skip if we've already processed this element or its parent
      if (processedElements.has(element)) return

      const text = getCleanText(element)
      if (text && text.length > 3) {
        // Only include meaningful text
        // Check if this text is already included in a parent element
        let isChildText = false
        for (const existingText of allTextContent) {
          if (existingText.includes(text) && existingText.length > text.length + 10) {
            isChildText = true
            break
          }
        }

        if (!isChildText) {
          allTextContent.push(text)
          processedElements.add(element)

          // Mark all child text elements as processed to avoid duplication
          const childTextElements = element.querySelectorAll(textElements.join(', '))
          Array.from(childTextElements).forEach((child: any) => {
            processedElements.add(child)
          })
        }
      }
    })

    return allTextContent.join('\n\n')
  }

  // Find the main content container (fallback for other extractions)
  function findMainContent(): Element {
    return document.body
  }

  // Extract metadata
  function extractPageMetadata() {
    if (!extractMetadata) return undefined

    const getMetaContent = (name: string): string | undefined => {
      const meta =
        document.querySelector(`meta[name="${name}"]`) ||
        document.querySelector(`meta[property="${name}"]`) ||
        document.querySelector(`meta[property="og:${name}"]`) ||
        document.querySelector(`meta[name="twitter:${name}"]`)
      return meta?.getAttribute('content') || undefined
    }

    return {
      description: getMetaContent('description'),
      author: getMetaContent('author'),
      publishDate: getMetaContent('article:published_time') || getMetaContent('date'),
      siteName: getMetaContent('site_name') || getMetaContent('og:site_name'),
      type: getMetaContent('type') || getMetaContent('og:type'),
    }
  }

  // Extract headings with hierarchy
  function extractHeadings(container: Element) {
    const headings: Array<{ level: number; text: string; id?: string }> = []
    const headingElements = (container as any).querySelectorAll('h1, h2, h3, h4, h5, h6')

    headingElements.forEach((heading: any) => {
      const level = parseInt((heading as any).tagName.charAt(1))
      const text = getCleanText(heading)
      const id = (heading as any).id || undefined

      if (text) {
        headings.push({ level, text, id })
      }
    })

    return headings
  }

  // Extract links
  function extractPageLinks(container: Element) {
    if (!extractLinks) return undefined

    const links: Array<{ text: string; href: string; type: 'internal' | 'external' }> = []
    const linkElements = (container as any).querySelectorAll('a[href]')
    const currentDomain = window.location.hostname

    linkElements.forEach((link: any) => {
      const href = (link as any).getAttribute('href')
      const text = getCleanText(link)

      if (href && text && href !== '#') {
        let fullHref = href
        try {
          const url = new URL(href, window.location.href)
          fullHref = url.href
          const isInternal = url.hostname === currentDomain
          links.push({
            text: text.substring(0, 100), // Limit text length
            href: fullHref,
            type: isInternal ? 'internal' : 'external',
          })
        } catch {
          // Skip invalid URLs
        }
      }
    })

    return links
  }

  // Extract images
  function extractPageImages(container: Element) {
    if (!extractImages) return undefined

    const images: Array<{ src: string; alt: string; title?: string }> = []
    const imgElements = (container as any).querySelectorAll('img[src]')

    imgElements.forEach((img: any) => {
      const src = (img as any).getAttribute('src')
      const alt = (img as any).getAttribute('alt') || ''
      const title = (img as any).getAttribute('title')

      if (src) {
        try {
          const fullSrc = new URL(src, window.location.href).href
          images.push({
            src: fullSrc,
            alt,
            title: title || undefined,
          })
        } catch {
          // Skip invalid URLs
        }
      }
    })

    return images
  }

  // Create text chunks with priority
  function createTextChunks(container: Element) {
    const chunks: Array<{ text: string; type: 'paragraph' | 'heading' | 'list' | 'quote'; priority: number }> = []

    // Process different element types
    const elements = (container as any).querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, div')

    elements.forEach((element: any, index: number) => {
      const text = getCleanText(element)
      if (text.length < 20) return // Skip very short text

      const tagName = (element as any).tagName.toLowerCase()
      let type: 'paragraph' | 'heading' | 'list' | 'quote' = 'paragraph'
      let priority = 1

      if (/^h[1-6]$/.test(tagName)) {
        type = 'heading'
        priority = 6 - parseInt(tagName.charAt(1)) // h1 = 5, h2 = 4, etc.
      } else if (tagName === 'li') {
        type = 'list'
        priority = 2
      } else if (tagName === 'blockquote') {
        type = 'quote'
        priority = 2
      } else if (tagName === 'p') {
        priority = 3
      }

      // Boost priority for elements near the top
      if (index < 10) priority += 1

      chunks.push({ text, type, priority })
    })

    // Sort by priority (higher first)
    chunks.sort((a: any, b: any) => b.priority - a.priority)

    return chunks
  }

  // Main extraction logic
  const mainContent = findMainContent()
  const title = document.title
  const url = window.location.href

  // Remove script and style elements from main content - be careful not to break the DOM for subsequent ops if needed
  // Cloning would be safer but for extraction we can just ignore them or temporarily remove
  // For this script we'll query selectors that exclude them or just handle them in text extraction
  
  // Clean up for extraction (optional, but good for cleaner text)
  const scriptsAndStyles = (mainContent as any).querySelectorAll('script, style, noscript')
  scriptsAndStyles.forEach((el: any) => el.remove())

  // Extract comprehensive text content from all text elements
  const allTextContent = extractAllTextContent()

  return {
    title,
    url,
    content: allTextContent.substring(0, 50000), // Use comprehensive text extraction
    metadata: extractPageMetadata(),
    headings: extractHeadings(mainContent),
    links: extractPageLinks(mainContent),
    images: extractPageImages(mainContent),
    textChunks: createTextChunks(mainContent).slice(0, 50), // Limit chunks
    allText: allTextContent.substring(0, 50000), // Include full text extraction
  }
}

export async function browseWeb(url: string, options: BrowseWebOptions = {}): Promise<BrowseWebResult> {
  return new Promise((resolve) => {
    // Default options
    const {
      timeout = 30000,
      userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      headless = true,
      useUserProfile = false,
      waitForNetworkIdle = true,
      waitForSelector,
    } = options

    let resolved = false
    
    const win = new BrowserWindow({
      show: !headless, // Show window if not headless
      width: options.viewport?.width || 1280,
      height: options.viewport?.height || 720,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // Use a partition to isolate session unless user profile requested
        partition: useUserProfile ? undefined : `persist:temp-browse-${Date.now()}`,
      },
    })

    // Helper to cleanup and resolve
    const finish = (result: BrowseWebResult) => {
      if (resolved) return
      resolved = true
      
      // Close window if headless (or if we want to auto-close after success)
      // If not headless (debug mode), maybe we want to keep it open? 
      // Usually tools should clean up unless specified otherwise.
      // Let's assume we close it for now to avoid leaking windows.
      if (!win.isDestroyed()) {
        win.close()
      }
      
      resolve(result)
    }

    // Set a timeout
    const timeoutId = setTimeout(() => {
      finish({
        success: false,
        url,
        error: `Timeout after ${timeout}ms`,
      })
    }, timeout)

    // Handle loading
    win.loadURL(url, { userAgent }).then(async () => {
      try {
        // Custom wait logic
        if (waitForSelector) {
           // Poll for selector
           await win.webContents.executeJavaScript(`
             new Promise((resolve, reject) => {
               const interval = setInterval(() => {
                 if (document.querySelector('${waitForSelector}')) {
                   clearInterval(interval);
                   resolve();
                 }
               }, 100);
               setTimeout(() => {
                 clearInterval(interval);
                 reject(new Error('Selector timeout'));
               }, ${Math.min(timeout, 10000)});
             })
           `)
        } else if (url.includes('twitter.com') || url.includes('x.com')) {
           // Basic wait for twitter
           try {
             await win.webContents.executeJavaScript(`
                new Promise((resolve) => {
                  const interval = setInterval(() => {
                     if (document.querySelector('[data-testid="tweetText"]') || document.querySelector('[data-testid="tweet"]')) {
                       clearInterval(interval);
                       resolve();
                     }
                  }, 200);
                  setTimeout(() => { clearInterval(interval); resolve(); }, 5000);
                })
             `)
           } catch (e) { /* ignore */ }
        } else if (waitForNetworkIdle) {
           // Rough approximation of network idle (wait a bit after load)
           await new Promise(r => setTimeout(r, 2000))
        }

        // Execute extraction
        // We stringify the function and options to pass them into the browser context
        const result = await win.webContents.executeJavaScript(`
          (${extractionFunction.toString()})(${JSON.stringify(options)})
        `)

        clearTimeout(timeoutId)
        finish({
          success: true,
          url,
          data: result,
        })

      } catch (error) {
        clearTimeout(timeoutId)
        finish({
          success: false,
          url,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }).catch((error) => {
      clearTimeout(timeoutId)
      finish({
        success: false,
        url,
        error: `Failed to load URL: ${error instanceof Error ? error.message : String(error)}`,
      })
    })

    // Handle window closed prematurely
    win.on('closed', () => {
      if (!resolved) {
        clearTimeout(timeoutId)
        resolve({
          success: false,
          url,
          error: 'Window closed prematurely',
        })
      }
    })
  })
}
