// Production shared React UI in isolated Chromium contexts; synthetic host only.
const path = require('node:path')
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS
  process.exit(spawnSync(require('electron'), [__filename], { env, stdio: 'inherit' }).status ?? 1)
} else {
  const { app, BrowserWindow } = require('electron')
  const express = require('express'); const fs = require('node:fs'); const os = require('node:os')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graviton-workspace-smoke-')); app.setPath('userData', root)
  let server; const windows = []; let exit = 1
  const timeout = setTimeout(() => { console.error('Workspace smoke timeout'); app.exit(1) }, 90000)
  app.whenReady().then(async () => {
    app.dock?.hide()
    const host = express(); host.use(express.json())
    const uid = 'a7c485cb-99e7-4cf2-82a9-6e23b55cdfc3'; const epoch = 'fixture-epoch'; const now = new Date().toISOString()
    const slot = name => ({ slot: name, status: 'signed_out', version: 1, sessionId: null, userId: null, email: null, expiresAt: null })
    const auth = { epoch, app: slot('app'), codex: slot('codex'), user: { id: uid, email: 'local@localhost' } }
    const project = { id: 'p1', user_id: uid, name: 'Fixture project', storage_mode: 'local', created_at: now, updated_at: now }
    const conversation = { id: 'c1', project_id: 'p1', user_id: uid, title: 'Fixture conversation', storage_mode: 'local', cwd: null, created_at: now, updated_at: now }
    let rows = []; let run; let seq = 0; let queued; let queueRevision = 0; let executions = 0; let decisions = 0
    const subscribers = new Set(); const frames = []; const receipts = new Map(); const unexpected = new Set()
    const bundle = await require('esbuild').build({ entryPoints: [path.join(__dirname, '../server/headlessServer/services/runSnapshotProjector.ts')], bundle: true, write: false, platform: 'node', format: 'cjs' })
    const projectorModule = { exports: {} }
    new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, projectorModule, projectorModule.exports)
    let projector = new projectorModule.exports.RunSnapshotProjector()
    let forceResync = false; let bootstraps = 0
    const publish = event => { projector.apply(event); const frame = { ...event, seq: ++seq }; frames.push(frame); for (const res of subscribers) res.write(`data: ${JSON.stringify(frame)}\n\n`) }
    const queue = () => ({ streamId: run?.streamId ?? 'pending', conversationId: 'c1', lineageId: null, revision: queueRevision, items: queued ? [queued] : [] })
    const row = (id, role, content, parent_id) => ({ id, conversation_id: 'c1', role, content, parent_id, children_ids: [], revision: 1, model_name: 'glm-5.1', created_at: now, content_blocks: [{ type: 'text', content }] })
    host.get('/api/host/runtime', (_req, res) => res.json({ protocol: 1, epoch, hostId: 'fixture-host', auth, capabilities: { browserUi: true, sharedRuns: false } }))
    host.get('/api/host/auth/status', (_req, res) => res.json(auth))
    host.get('/api/host/auth/events', (_req, res) => { res.type('text/event-stream'); res.write(`data: ${JSON.stringify(auth)}\n\n`) })
    host.get('/api/host/execution-preferences', (_req, res) => res.json({ hostId: 'fixture-host', epoch, revision: 0, values: {} }))
    host.get('/api/host/prompts', (_req, res) => res.json({ schema: 1, hostId: 'fixture-host', epoch, revision: 0, prompts: [] }))
    host.get('/api/host/changes', (_req, res) => res.json({ epoch, cursor: 0, reset: false, changes: [] }))
    host.get('/api/host/runs', (_req, res) => res.json({ runs: run ? [{ streamId: run.streamId, conversationId: 'c1', parentId: null, lineageId: null, createdAt: now }] : [] }))
    host.get(['/api/custom-tools', '/api/mcp/tools'], (_req, res) => res.json({ success: true, tools: [] }))
    host.get('/api/skills', (_req, res) => res.json({ success: true, skills: [] }))
    host.get(['/api/gw/projects', '/api/local/projects'], (_req, res) => res.json([project]))
    host.get(['/api/gw/projects/p1', '/api/app/projects/p1'], (_req, res) => res.json(project))
    host.get(['/api/gw/conversations', '/api/gw/conversations/recent'], (_req, res) => res.json([conversation]))
    host.get(['/api/gw/conversations/paginated', '/api/gw/conversations/by-project'], (_req, res) => res.json({ conversations: [conversation], nextCursor: null, hasMore: false }))
    host.get(['/api/app/conversations/c1', '/api/gw/conversations/c1'], (_req, res) => res.json(conversation))
    host.get(['/api/app/conversations/c1/messages/tree', '/api/gw/conversations/c1/messages/tree'], (_req, res) => res.json({ messages: rows, tree: null, meta: { storage_mode: 'local' } }))
    host.get('/api/conversations/c1/streaming-runs', (_req, res) => res.json({ runs: [] }))
    host.get(['/api/local/tools', '/api/app/conversations/c1/messages/top-level-users', '/api/conversations/c1/subagents'], (_req, res) => res.json([]))
    host.post('/api/mcp/refresh-tools', (_req, res) => res.json({ success: true, tools: [] }))
    host.get('/api/jobs/stats', (_req, res) => res.json({ success: true, stats: { pending: 0, running: 0, completed: 0, failed: 0 } }))
    host.get('/api/conversations/c1/live-runs', (_req, res) => res.json({ runs: run ? [{ streamId: run.streamId, conversationId: 'c1', status: 'running', seq, createdAt: now, parentId: null, lineageId: null }] : [] }))
    host.get('/api/app/conversations', (_req, res) => res.json([conversation]))
    host.get(`/api/cloud/users/${uid}/research-notes`, (_req, res) => res.json([]))
    host.get('/api/jobs', (_req, res) => res.json({ success: true, jobs: [] }))
    host.post('/api/conversations/c1/admissions', (req, res) => {
      const body = req.body
      if (receipts.has(body.operationId)) { res.json(receipts.get(body.operationId)); return }
      if (run) { res.status(409).json({ error: 'Fixture expects direct queue for active UI' }); return }
      executions++; run = body
      projector = new projectorModule.exports.RunSnapshotProjector()
      if (executions > 1) {
        const head = rows.at(-1).id
        if (body.parentId !== head) { console.error('Fixture stale parent', body.parentId, 'expected', head); run = undefined; res.status(409).json({ code: 'lineage_mismatch', error: 'The selected parent is not the current branch head. Reload or explicitly branch.' }); return }
        const receipt = { status: 'accepted', epoch, operationId: body.operationId, conversationId: 'c1', streamId: body.streamId, lineageId: null, parentId: head, disposition: 'started' }
        receipts.set(body.operationId, receipt); res.json(receipt)
        publish({ type: 'started', operation: 'send', conversationId: 'c1', parentId: head, streamId: body.streamId })
        if (executions === 2) {
          if (!body.manualCompaction) throw new Error('Expected manual compaction admission')
          const instruction = { ...row('compact-instruction', 'user', '/compact', head), meta: { kind: 'compaction_instruction' } }
          const summary = { ...row('compact-summary', 'assistant', 'Synthetic summary', instruction.id), meta: { kind: 'compaction_summary', state: 'committed', compactionId: instruction.id } }
          const injection = { ...row('compact-context', 'user', 'Restored project instructions', summary.id), meta: { kind: 'context_injection', reason: 'compact' } }
          rows.push(instruction, summary, injection)
          publish({ type: 'user_message_persisted', message: instruction })
          publish({ type: 'context_compaction', status: 'started' })
          publish({ type: 'assistant_message_persisted', message: summary })
          publish({ type: 'context_compaction', status: 'completed', summaryMessage: summary, parentMessageId: summary.id })
          publish({ type: 'context_injection_persisted', message: injection })
          publish({ type: 'complete', message: summary })
        } else {
          if (body.manualCompaction || body.content !== 'Follow-up without refresh') throw new Error('Unexpected post-compaction submission')
          const user = row('after-compact-user', 'user', body.content, head)
          const answer = row('after-compact-answer', 'assistant', 'Post-compaction send accepted', user.id)
          rows.push(user, answer); publish({ type: 'user_message_persisted', message: user }); publish({ type: 'complete', message: answer })
        }
        return
      }
      const receipt = { status: 'accepted', epoch, operationId: body.operationId, conversationId: 'c1', streamId: body.streamId, lineageId: null, parentId: null, disposition: 'started' }
      receipts.set(body.operationId, receipt); res.json(receipt)
      rows = [row('u1', 'user', body.content, null)]
      publish({ type: 'started', operation: 'send', conversationId: 'c1', parentId: null, provider: 'zai', modelName: 'glm-5.1', streamId: body.streamId })
      publish({ type: 'user_message_persisted', message: rows[0] })
      publish({ type: 'chunk', part: 'text', delta: 'Synthetic reply in progress' })
      publish({ type: 'permission_required', streamId: body.streamId, toolCallId: 'tc1', toolName: 'bash', toolInput: { command: 'echo fixture', description: 'Synthetic only' } })
    })
    host.get('/api/streams/:streamId', (req, res) => {
      res.type('text/event-stream'); res.setHeader('Cache-Control', 'no-store'); res.flushHeaders()
      if (forceResync && req.query.bootstrap !== '1') {
        res.end(`data: ${JSON.stringify({ type: 'observer_resync_required', reason: 'fixture replay evicted' })}\n\n`); return
      }
      if (req.query.bootstrap === '1') {
        bootstraps++
        res.write(`data: ${JSON.stringify({ type: 'bootstrap', seq, snapshot: projector.snapshot({ epoch, streamId: run.streamId, conversationId: 'c1', stateSeq: seq, persisted: rows.map(row => ({ id: row.id, revision: row.revision, row })), pendingDecisions: decisions ? [] : frames.filter(frame => frame.type === 'permission_required').map(({ seq, ...event }) => event) }) })}\n\n`)
      }
      else for (const frame of frames) if (frame.seq > Number(req.query.fromSeq || 0)) res.write(`data: ${JSON.stringify(frame)}\n\n`)
      subscribers.add(res); res.once('close', () => subscribers.delete(res))
    })
    host.get('/api/conversations/c1/streams/:streamId/queue', (_req, res) => res.json(queue()))
    host.post('/api/conversations/c1/streams/:streamId/queue', (req, res) => { queued = { requestId: req.body.requestId, content: req.body.content, attachmentCount: 0, status: 'queued' }; queueRevision++; publish({ type: 'message_queue_updated', snapshot: queue() }); res.json({ streamId: run.streamId, snapshot: queue() }) })
    host.delete('/api/conversations/c1/streams/:streamId/queue/:requestId', (_req, res) => { queued = undefined; queueRevision++; publish({ type: 'message_queue_updated', snapshot: queue() }); res.json(queue()) })
    host.post('/api/resume', (req, res) => { if (req.body.decision !== 'allow_once') throw new Error('Unexpected answer'); decisions++; publish({ type: 'decision_settled', streamId: run.streamId, toolCallId: 'tc1', outcome: 'resolved', revision: 1 }); res.json({ success: true }) })
    host.use('/api', (req, res) => { unexpected.add(`${req.method} ${req.path}`); res.status(500).json({ error: 'Unexpected fixture endpoint' }) })
    host.get('/blank', (_req, res) => res.send('<!doctype html><body>Fixture</body>'))
    host.use(express.static(path.join(__dirname, '../dist-browser')))
    server = host.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve))
    const { WebSocketServer } = require('ws')
    const sockets = new WebSocketServer({ server })
    sockets.on('connection', socket => socket.on('message', raw => {
      const message = JSON.parse(String(raw))
      if (message.type === 'subscribe') socket.send(JSON.stringify({ type: 'subscribed', timestamp: Date.now() }))
    }))
    const origin = `http://127.0.0.1:${server.address().port}`
    const wait = async (window, expression, label) => {
      for (let i = 0; i < 200; i++) { if (await window.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)) }
      throw new Error(`${label}: ${await window.webContents.executeJavaScript('document.body.innerText.slice(-2500)')}`)
    }
    const click = (window, selector) => window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.click()`)
    const fill = async (window, value) => {
      await window.webContents.executeJavaScript(`(()=>{const input=document.querySelector('textarea[placeholder="Type your message..."]'); input.focus();input.select();})()`)
      await window.webContents.insertText(value)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    for (let i = 0; i < 2; i++) {
      const window = new BrowserWindow({ show: false, width: i ? 390 : 1280, height: i ? 844 : 900, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false, partition: `workspace-fixture-${i}` } }); windows.push(window)
      window.webContents.on('console-message', details => { if (details.level === 'error') console.error('Renderer:', details.message) })
      await window.loadURL(origin + '/blank')
      await window.webContents.executeJavaScript(`localStorage.setItem('currentProvider','Z.AI / GLM')`)
      await window.loadURL(origin + '/#/chat/p1/c1')
      await wait(window, `!!document.querySelector('textarea[placeholder="Type your message..."]')`, 'Composer missing')
      if (await window.webContents.executeJavaScript('!!window.electronAPI')) throw new Error('Unexpected preload')
    }
    // Test actual computed canvas colors, not only React inline-style strings.
    const assertBackground = async (dark, color, enabled = true, video = false) => {
      const actual = await windows[0].webContents.executeJavaScript(`(async()=>{
        localStorage.setItem('chat:customThemeEnabled', ${JSON.stringify(String(enabled))});
        localStorage.setItem('chat:customTheme', JSON.stringify({ colors: { appBackgroundColor: { light: ${JSON.stringify(color)}, dark: ${JSON.stringify(color)} } } }));
        localStorage.setItem('yggdrasil_background_preference', JSON.stringify({ mode: ${JSON.stringify(video ? 'video' : 'color')}, colors: { light: 'transparent', dark: 'transparent' } }));
        document.documentElement.classList.toggle('dark', ${dark});
        window.dispatchEvent(new Event('chatCustomThemeChange'));
        window.dispatchEvent(new Event('yggdrasil:video-background-change'));
        await new Promise(resolve=>setTimeout(resolve,100));
        const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');
        return [document.documentElement,document.body,document.getElementById('root')].map(el=>{
          ctx.clearRect(0,0,1,1);ctx.fillStyle=getComputedStyle(el).backgroundColor;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];
        });
      })()`)
      const expected = !enabled || color === 'transparent' || color.startsWith('var(') ? (dark ? [12,10,9,255] : [245,245,244,255]) : [18,52,86,255]
      if (actual.some(pixel => JSON.stringify(pixel) !== JSON.stringify(expected))) throw new Error(`Browser background dark=${dark} color=${color}: ${JSON.stringify(actual)}`)
    }
    for (const dark of [false, true]) {
      await assertBackground(dark, 'transparent', false)
      for (const color of ['#123456', 'rgba(18,52,86,0.05)', '#12345600', 'transparent', 'var(--missing)']) await assertBackground(dark, color)
      await assertBackground(dark, 'transparent', false, true)
    }
    console.log('PASS solid browser canvas: default/custom light+dark, alpha stripped, transparent/invalid fallback, saved video mode')
    await fill(windows[1], 'phone private draft')
    await fill(windows[0], 'first synthetic prompt');
    await click(windows[0], 'button[title="Send message"]')
    await wait(windows[0], `document.body.innerText.includes('Permission requested')`, 'Permission missing')
    await wait(windows[1], `document.body.innerText.includes('Permission requested')`, 'Second observer permission missing')
    if (subscribers.size !== 2) throw new Error(`Expected two live subscribers; got ${subscribers.size}`)
    if (await windows[1].webContents.executeJavaScript(`document.querySelector('textarea').value`) !== 'phone private draft') throw new Error('Remote event stole phone draft')
    await fill(windows[0], 'second synthetic prompt'); await click(windows[0], 'button[title="Queue message"]')
    await wait(windows[0], `document.body.innerText.includes('Queued')`, 'Queue missing')
    if (!queued || executions !== 1) throw new Error('Queue started duplicate execution')
    await click(windows[0], 'button[aria-label="Remove queued message"]')
    await wait(windows[0], `!document.querySelector('button[aria-label="Remove queued message"]')`, 'Queue removal missing')
    await windows[0].webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Allow Once').click()`)
    await wait(windows[0], `!document.body.innerText.includes('Permission requested')`, 'Permission did not settle')
    await wait(windows[1], `!document.body.innerText.includes('Permission requested')`, 'Other observer decision did not settle')
    // Persist consecutive tool turns, then reset live buffers for the next one.
    // Completed tool history must remain in Chat for sender AND remote observer.
    await windows[1].reload()
    await wait(windows[1], `!!document.querySelector('textarea[placeholder="Type your message..."]')`, 'Observer reload failed')
    await new Promise(resolve => setTimeout(resolve, 500))
    let parent = 'u1'
    for (let turn = 1; turn <= 3; turn++) {
      publish({ type: 'tool_loop', status: 'turn_started', turn })
      const name = ['read_file', 'glob', 'ripgrep'][turn - 1]
      const id = `history-call-${turn}`
      publish({ type: 'chunk', part: 'tool_call', toolCall: { id, name, arguments: { fixture: turn } } })
      const message = { ...row(`step-${turn}`, 'assistant', '', parent), content_blocks: [{ type: 'tool_use', id, name, input: { fixture: turn } }] }
      rows.push(message); publish({ type: 'assistant_message_persisted', message })
      publish({ type: 'chunk', part: 'tool_result', toolResult: { tool_use_id: id, content: `fixture result ${turn}` } })
      message.content_blocks.push({ type: 'tool_result', tool_use_id: id, content: `fixture result ${turn}` })
      publish({ type: 'assistant_message_persisted', message }); parent = message.id
      publish({ type: 'tool_loop', status: 'turn_started', turn: turn + 1 })
      publish({ type: 'chunk', part: 'reasoning', delta: 'Thinking after completed tools' })
      if (turn === 1) {
        for (const window of windows) await wait(window, `document.body.innerText.includes('1 completed')`, 'First turn missing')
        forceResync = true
        const detached = [...subscribers]; subscribers.clear()
        for (const res of detached) res.end()
      }
      if (turn === 3) {
        const deadline = Date.now() + 15000
        while (bootstraps < 4 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
        if (bootstraps < 4) throw new Error('Both clients did not rebootstrap after replay eviction')
        forceResync = false
        for (const window of windows) await wait(window, `document.body.innerText.includes('3 completed')`, `Tool history lost after reconnect on ${window === windows[0] ? 'sender' : 'observer'}`)
        console.log('PASS real compact projector rebootstrap catches up offline turns on both clients')
      }
    }
    for (const window of windows) {
      await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.includes('Agent steps') && button.getAttribute('aria-expanded') === 'false')?.click()`)
      for (const name of ['read_file', 'glob', 'ripgrep']) await wait(window, `document.body.innerText.includes('${name}')`, `Missing completed tool ${name}`)
    }
    console.log('PASS observer reload retains three completed tool turns and expanded call history')
    rows.push(row('a1', 'assistant', 'Synthetic final reply', parent)); publish({ type: 'complete', message: rows[rows.length - 1] }); for (const res of subscribers) res.end()
    for (const window of windows) await wait(window, `document.body.innerText.includes('Synthetic final reply')`, 'Final reply missing on sender/observer')
    const phone = windows[1]
    await phone.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Workspace')?.click()`)
    await wait(phone, `!!document.querySelector('dialog[aria-label="Workspace"]')?.open`, 'Phone workspace missing')
    await phone.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Close workspace')?.click()`)
    if (executions !== 1 || decisions !== 1) throw new Error('Duplicate fixture execution or decision')
    // A manual summary is followed by a restored-context row, which is the real
    // branch head even though complete.message is the earlier summary.
    run = undefined; frames.length = 0; seq = 0
    await fill(windows[0], '/compact')
    await click(windows[0], 'button[title="Send message"]')
    await wait(windows[0], `document.body.innerText.includes('Conversation summarised')`, 'Manual compaction did not complete')
    await wait(windows[0], `!!document.querySelector('button[title="Send message"]')`, 'Compaction did not settle')
    for (const res of subscribers) res.end()
    run = undefined; frames.length = 0; seq = 0
    await new Promise(resolve => setTimeout(resolve, 500))
    await fill(windows[0], 'Follow-up without refresh')
    await wait(windows[0], `document.querySelector('textarea[placeholder="Type your message..."]').value === 'Follow-up without refresh'`, 'Follow-up draft did not settle')
    await click(windows[0], 'button[title="Send message"]')
    await wait(windows[0], `document.body.innerText.includes('Post-compaction send accepted')`, 'Post-compaction parent was stale')
    if (executions !== 3) throw new Error('Expected exactly one compaction and one follow-up')
    console.log('PASS manual compaction -> restored context -> next send at actual head without refresh')
    if (unexpected.size) throw new Error('Unexpected fixture requests: ' + [...unexpected].join('; '))
    console.log('PASS production no-preload two-client chat: independent draft, two live observers, permission settlement, queue/remove, one final reply, phone workspace')
    console.log('Fixture ancillary coverage:', [...unexpected].join('; '))
    exit = 0
  }).catch(error => console.error(error)).finally(async () => {
    clearTimeout(timeout); for (const window of windows) window.destroy()
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
    app.exit(exit)
  })
}
