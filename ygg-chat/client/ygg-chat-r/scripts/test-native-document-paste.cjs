// macOS-only opt-in smoke: the stock Electron edit command with an AppKit file URL on the clipboard.
// Never inspects or prints the user's prior clipboard. It is restored by the helper after the probe.
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
  process.exit(spawnSync(require('electron'), [__filename], { env, stdio: 'inherit' }).status ?? 1)
}

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graviton-paste-smoke-'))
app.setPath('userData', root)
let helper
const timeout = setTimeout(() => { helper?.stdin.end(); app.exit(1) }, 45_000)
app.whenReady().then(async () => {
  assert.equal(process.platform, 'darwin')
  const { docx, xlsx, pdf } = require('./document-paste-fixtures.cjs')
  const files = [['Document paste test.txt', Buffer.from('Native file paste test')],
    ['Document.docx', Buffer.from(docx, 'base64')], ['Spreadsheet.xlsx', Buffer.from(xlsx, 'base64')],
    ['Document.pdf', Buffer.from(pdf, 'base64')]]
  for (const [name, data] of files) fs.writeFileSync(path.join(root, name), data)
  const assets = path.join(__dirname, '../dist-electron/assets')
  const asset = name => {
    const output = fs.readdirSync(assets).find(file => file.startsWith(`${name}-`) && file.endsWith('.js'))
    assert.ok(output, `Build the Electron renderer before running this smoke test (${name} missing)`)
    return require('node:url').pathToFileURL(path.join(assets, output)).href
  }
  const officeUrl = asset('officeText')
  const pdfUrl = asset('pdfUtils')
  fs.writeFileSync(path.join(root, 'probe.html'), '<div id="root"></div><textarea autofocus></textarea>')
  const win = new BrowserWindow({ show: false })
  // This fixture exercises parser assets, not application startup or the user's local host.
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_request, callback) => callback({ cancel: true }))
  await win.loadFile(path.join(root, 'probe.html'))
  await win.webContents.executeJavaScript(`
    window.pasteResult = null;
    document.querySelector('textarea').focus();
    document.addEventListener('paste', async e => {
      e.preventDefault();
      const files = [...e.clipboardData.files];
      window.pasteResult = {
        types: [...e.clipboardData.types],
        items: [...e.clipboardData.items].map(item => ({ kind: item.kind, type: item.type })),
        files: files.map(file => ({ name: file.name, size: file.size, type: file.type }))
      };
      try {
        const { extractOfficeText } = await import(${JSON.stringify(officeUrl)});
        const { extractTextFromPdf } = await import(${JSON.stringify(pdfUrl)});
        window.extracted = [];
        for (const file of files) {
          if (file.name.endsWith('.docx') || file.name.endsWith('.xlsx')) {
            window.extracted.push(await extractOfficeText(file.name.slice(-4), file, new AbortController().signal, 5000));
          } else if (file.name.endsWith('.pdf')) {
            window.extracted.push(await extractTextFromPdf(file));
          } else {
            window.extracted.push(await file.text());
          }
        }
        window.extractDone = true;
      } catch (error) { window.extractError = String(error); }
    });
  `)
  const script = `
import AppKit
let pb = NSPasteboard.general
let saved = (pb.pasteboardItems ?? []).map { item -> NSPasteboardItem in
    let snapshot = NSPasteboardItem()
    for type in item.types { if let data = item.data(forType: type) { snapshot.setData(data, forType: type) } }
    return snapshot
}
pb.clearContents()
let urls = CommandLine.arguments.dropFirst().map { NSURL(fileURLWithPath: $0) }
guard pb.writeObjects(urls) else { exit(1) }
let ownChange = pb.changeCount
print("ready")
fflush(stdout)
_ = readLine()
if pb.changeCount == ownChange {
    pb.clearContents()
    if !saved.isEmpty { pb.writeObjects(saved) }
}
`
  helper = spawn('/usr/bin/swift', ['-e', script, ...files.map(([name]) => path.join(root, name))], { stdio: ['pipe', 'pipe', 'inherit'] })
  const ready = await Promise.race([
    once(helper.stdout, 'data').then(([data]) => String(data)),
    once(helper, 'exit').then(([status]) => { throw Error(`Clipboard helper exited (${status})`) }),
  ])
  assert.match(ready, /ready/)
  try {
    win.webContents.paste()
    let result
    for (let attempt = 0; attempt < 40; attempt++) {
      result = await win.webContents.executeJavaScript('window.pasteResult')
      if (result) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    console.log('Native clipboard event:', JSON.stringify(result))
    assert.deepEqual(result?.files.map(file => [file.name, file.size]), files.map(([name, bytes]) => [name, bytes.length]))
    let extraction
    for (let attempt = 0; attempt < 200; attempt++) {
      extraction = await win.webContents.executeJavaScript('({ done: window.extractDone, values: window.extracted, error: window.extractError })')
      if (extraction.done || extraction.error) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(extraction?.done, extraction?.error || 'Timed out waiting for Electron parser workers')
    assert.deepEqual(extraction.values, ['Native file paste test', 'Text from Word', 'Sheet: Revenue\nItem\t12\n\nSheet: Notes\nSecond sheet', 'Text from PDF'])
    console.log('macOS AppKit file URLs → Electron DOM Files → production PDF/Office workers: passed')
  } finally {
    const exited = once(helper, 'exit')
    helper.stdin.end()
    await exited
  }
}).then(() => finish(0), error => { console.error(error); finish(1) })
function finish(code) {
  helper?.stdin.end()
  clearTimeout(timeout)
  fs.rmSync(root, { recursive: true, force: true })
  app.exit(code)
}
