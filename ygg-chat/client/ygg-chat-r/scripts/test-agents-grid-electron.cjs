// Isolated real Chromium visibility/Redux lifecycle test; never loads a user profile.
// Run: node scripts/test-agents-grid-electron.cjs
const path = require('node:path')
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit' })
  process.exit(result.status ?? 1)
} else {
  const { app, BrowserWindow } = require('electron')
  const fs = require('node:fs')
  const http = require('node:http')
  const os = require('node:os')
  const { build } = require('esbuild')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'graviton-agents-grid-'))
  app.setPath('userData', userData)
  let server
  let window
  let exitCode = 1
  const timeout = setTimeout(() => { console.error('Agents grid smoke timed out'); app.exit(1) }, 60000)
  app.whenReady().then(async () => {
    app.dock?.hide()
    const bundle = await build({
      entryPoints: [path.join(__dirname, 'agents-grid-browser-smoke.tsx')],
      bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}', __IS_ELECTRON__: 'false', __BUILD_TARGET__: '"local"' },
      plugins: [{ name: 'isolated-grid', setup(builder) {
        // Keep real grid, row, preview, Redux and browser observers. Stub only
        // the heavyweight message presentation and unrelated app dependencies.
        builder.onLoad({ filter: /[/\\]useRunningAgentStreams\.ts$/ }, async args => {
          const source = fs.readFileSync(args.path, 'utf8')
          const start = source.indexOf('export const getAgentForkKey')
          const end = source.indexOf('\nexport ', source.indexOf('export const buildAgentForkGroups') + 10)
          return { contents: source.slice(start, end), loader: 'ts' }
        })
        builder.onLoad({ filter: /[/\\]ThemeManager[/\\]themeConfig\.ts$/ }, () => ({ contents: 'export const useCustomChatTheme = () => ({theme: {colors: {}}, enabled: false}); export const useHtmlDarkMode = () => false; export const getThemeModeColor = color => color;' }))
        builder.onLoad({ filter: /[/\\]ChatMessage[/\\]ChatMessage\.tsx$/ }, () => ({ contents: 'export function ChatMessage({contentBlocks}) { window.__messageRenders = (window.__messageRenders || 0) + 1; return <p data-fixture-message style={{minHeight: 1400}}>{contentBlocks.filter(b => b.type === "text").map(b => b.content).join(" ")}</p> }', loader: 'tsx' }))
        builder.onLoad({ filter: /[/\\]ChatMessage[/\\]SummarisedMessage\.tsx$/ }, () => ({ contents: 'export const SummarisedMessage = () => null' }))
        builder.onLoad({ filter: /[/\\]ChatMessage[/\\]chatMessageShared\.tsx?$/ }, () => ({ contents: 'export const MESSAGE_BLOCK_INSET_CLASS = ""; export const extractAssistantTextsFromResponsesOutputItems = () => []; export const extractReasoningTextsFromResponsesOutputItems = () => [];' }))
        builder.onLoad({ filter: /[/\\]AgentMessageTooltip\.tsx$/ }, () => ({ contents: 'export const AgentMessageTooltip = ({children}) => children' }))
      } }],
    })
    server = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html')
      res.end('<!doctype html><html><head><style>*{box-sizing:border-box}html{font-size:16px}body{margin:0}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1 1 0%}.min-h-0{min-height:0}.h-full{height:100%}.overflow-hidden{overflow:hidden}.overflow-y-auto{overflow-y:auto}.grid{display:grid}.gap-3{gap:12px}.gap-x-3{column-gap:12px}</style></head><body><div id="root"></div></body></html>')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    window = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    window.webContents.on('console-message', details => { if (details.level === 'error') console.error(details.message) })
    await window.loadURL(`http://127.0.0.1:${server.address().port}`)
    window.show()
    window.focus()
    await window.webContents.executeJavaScript(bundle.outputFiles[0].text)
    const checks = await window.webContents.executeJavaScript('window.__runAgentsGridSmoke()')
    for (const check of checks) console.log(`PASS ${check}`)
    exitCode = 0
  }).catch(error => console.error(error)).finally(async () => {
    clearTimeout(timeout)
    window?.destroy()
    if (server) await new Promise(resolve => server.close(resolve))
    try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* Chromium may retain cache handles until exit. */ }
    app.exit(exitCode)
  })
}
