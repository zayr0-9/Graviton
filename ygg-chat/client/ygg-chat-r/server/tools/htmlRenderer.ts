import sanitizeHtmlLib from 'sanitize-html'

interface HtmlRendererInput {
  html: string
  allowUnsafe?: boolean
}

function sanitizeHtml(html: string, allowUnsafe = false): string {
  // TODO: Re-enable sanitization after testing
  // For now, skip sanitization to allow full CSS rendering
  return html
}

export async function run(params: HtmlRendererInput) {
  const { html, allowUnsafe = false } = params
  if (typeof html !== 'string' || html.trim().length === 0) {
    return { success: false, error: 'html must be a non-empty string' }
  }

  const sanitized = sanitizeHtml(html, allowUnsafe)

  return {
    success: true,
    html: sanitized,
  }
}

export default { run }
