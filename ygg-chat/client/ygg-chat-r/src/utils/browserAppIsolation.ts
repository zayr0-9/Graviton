/** Browser apps use only the parent-mediated host bridge for network/host work.
 * Keep scripts/assets available but block direct fetch/XHR/WebSocket/workers and
 * form submissions, including legacy host APIs not protected by origin checks. */
export function isolateBrowserAppHtml(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'; form-action 'none'; worker-src 'none'">`
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, match => match + meta)
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) return html.slice(0, doctype[0].length) + meta + html.slice(doctype[0].length)
  return meta + html
}
