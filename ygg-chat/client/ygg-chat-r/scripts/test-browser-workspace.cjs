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
    host.get('/api/host/runs/finished', (_req, res) => res.json({ runs: [] }))
    host.get('/api/local/conversations/c1/heimdall-collapse-groups', (_req, res) => res.json({ groups: [] }))
    host.get('/api/conversations/c1/streaming-runs', (_req, res) => res.json({ runs: [] }))
    host.get(['/api/local/tools', '/api/app/conversations/c1/messages/top-level-users', '/api/conversations/c1/subagents'], (_req, res) => res.json([]))
    host.post('/api/mcp/refresh-tools', (_req, res) => res.json({ success: true, tools: [] }))
    host.get('/api/jobs/stats', (_req, res) => res.json({ success: true, stats: { pending: 0, running: 0, completed: 0, failed: 0 } }))
    host.get('/api/conversations/c1/live-runs', (_req, res) => res.json({ runs: run ? [{ streamId: run.streamId, conversationId: 'c1', status: 'running', seq, createdAt: now, parentId: null, lineageId: null }] : [] }))
    host.get('/api/app/conversations', (_req, res) => res.json([conversation]))
    host.get('/api/gw/research-notes', (_req, res) => res.json([]))
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
    // Actual textarea identity and draft/caret survive both directions of the breakpoint.
    await fill(windows[1], 'retained compact draft')
    await windows[1].webContents.executeJavaScript(`window.quietTextarea=document.querySelector('textarea[placeholder="Type your message..."]'); window.quietTextarea.focus(); window.quietTextarea.setSelectionRange(4,9)`)
    for (const width of [1100, 390]) {
      windows[1].setContentSize(width, 900)
      await new Promise(resolve => setTimeout(resolve, 400))
      const stable = await windows[1].webContents.executeJavaScript(`window.quietTextarea === document.querySelector('textarea[placeholder="Type your message..."]') && window.quietTextarea.value==='retained compact draft' && window.quietTextarea.selectionStart===4 && window.quietTextarea.selectionEnd===9`)
      if (!stable) throw new Error('Responsive layout remounted or reset the textarea')
    }
    await windows[1].webContents.executeJavaScript(`window.quietTextarea.select(); document.execCommand('delete')`)
    // Real layout bounds: compact controls remain reachable through the menu.
    for (const width of [320, 390, 767, 820]) {
      windows[1].setContentSize(width, 900)
      await new Promise(resolve => setTimeout(resolve, 400))
      const layout = await windows[1].webContents.executeJavaScript(`(()=>{
        const rect = el => { const r=el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height} };
        const selectors=document.querySelector('.composer-controls-left-selectors');
        const rail=document.querySelector('[aria-label="Sidebar rail"]');
        return { width:innerWidth, rail:rect(rail), railOverflow:rail.scrollHeight > rail.clientHeight, chat:rect(document.querySelector('.chat-layout')),
          buttons:[...selectors.querySelectorAll(':scope > div > button')].map(rect), display:getComputedStyle(selectors).display };
      })()`)
      const compact = await windows[1].webContents.executeJavaScript(`!!document.querySelector('[data-composer-layout="compact"]')`)
      const paneWidth = await windows[1].webContents.executeJavaScript(`document.querySelector('[data-chat-pane-kind="primary"]').clientWidth`)
      if (compact !== (paneWidth < 768)) throw new Error('Composer did not follow actual pane width')
      if (compact) {
        await click(windows[1], '[data-quiet-add]')
        await wait(windows[1], `!!document.querySelector('[aria-label="Add to message"][role="dialog"]')`, 'Compact menu missing')
        await wait(windows[1], `(()=>{const menu=document.querySelector('.quiet-menu').getBoundingClientRect(),input=document.querySelector('.quiet-input-grid').getBoundingClientRect();return menu.bottom <= input.top-6 && menu.bottom >= input.top-12 && menu.top>=0})()`, 'Menu is not anchored above input')
        await windows[1].webContents.executeJavaScript(`[...document.querySelectorAll('.quiet-menu-items button')].find(b=>b.textContent==='Model and controls').click()`)
        await wait(windows[1], `document.querySelectorAll('.quiet-controls-content [role="combobox"]').length > 0 || document.querySelectorAll('.quiet-controls-content button').length > 3`, 'Compact controls missing')
        await wait(windows[1], `document.activeElement?.getAttribute('aria-label')==='Back to previous menu'`, 'Submenu focus missing')
        await windows[1].webContents.executeJavaScript(`[...document.querySelectorAll('.quiet-controls-content button')].find(b=>b.textContent.includes('glm-5.1'))?.click()`)
        await wait(windows[1], `!!document.querySelector('[data-ygg-overlay="select-dropdown"] [role="option"]')`, 'Model options did not open')
        const optionReady = await windows[1].webContents.executeJavaScript(`(()=>{const option=document.querySelector('[data-ygg-overlay="select-dropdown"] [role="option"]');const r=option.getBoundingClientRect();return option.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()`)
        if (!optionReady) throw new Error('Model dropdown is covered by compact overlay')
        await click(windows[1], '[data-ygg-overlay="select-dropdown"] [role="option"]')
        await wait(windows[1], `!document.querySelector('[data-ygg-overlay="select-dropdown"]')`, 'Model selection did not dismiss dropdown')
        await click(windows[1], '[aria-label="Back to previous menu"]')
        await wait(windows[1], `!!document.querySelector('.quiet-menu-items') && document.activeElement?.textContent==='Model and controls'`, 'Menu Back did not restore parent row focus')
        await click(windows[1], '[data-menu-row="activity"]')
        await wait(windows[1], `(()=>{const menu=document.querySelector('.quiet-menu'),pane=document.querySelector('[data-chat-pane-kind="primary"]');return menu?.getAttribute('aria-label')==='Activity' && Math.abs(menu.getBoundingClientRect().width-(pane.getBoundingClientRect().width-16))<2})()`, 'Activity did not expand to pane width')
        await click(windows[1], '[aria-label="Back to previous menu"]')
        await wait(windows[1], `document.activeElement?.dataset.menuRow==='activity'`, 'Activity Back did not restore focus')
        await click(windows[1], '[aria-label="Close composer menu"]')
        await wait(windows[1], `!document.querySelector('.quiet-menu')`, 'Menu failed to close')
        const geometry = await windows[1].webContents.executeJavaScript(`(()=>{const grid=document.querySelector('.quiet-input-grid'), t=grid.querySelector('textarea'), send=grid.querySelector('[title="Send message"]'); const r=grid.getBoundingClientRect();return {height:r.height,width:r.width,right:r.right,send:!!send,textareaHeight:t.offsetHeight,header:!!document.querySelector('.quiet-agents-slot button')}})()`)
        const centered = await windows[1].webContents.executeJavaScript(`(()=>{const grid=document.querySelector('.quiet-input-grid'), input=grid.querySelector('textarea');if(input.value)return true;const r=input.getBoundingClientRect(),cy=r.top+r.height/2;return [grid.querySelector('[data-quiet-add]'),grid.querySelector('.quiet-inline-send')].every(el=>{const b=el.getBoundingClientRect();return Math.abs(b.top+b.height/2-cy)<1})})()`)
        if (!centered) throw new Error('Empty composer buttons are not vertically centered with input')
        if (!geometry.send || geometry.right > width || geometry.height > 80 || (width < 768 && !geometry.header)) throw new Error('Quiet composer invalid: '+JSON.stringify(geometry))
      } else if (layout.display === 'none' || layout.buttons.length < 2 || layout.buttons.some(r => r.width < 42 || r.left < 0 || r.right > layout.width + 1 || r.bottom > 901)) throw new Error(`Phone selectors clipped: ${JSON.stringify(layout)}`)
      if (width < 768 && (layout.railOverflow || layout.rail.height > 70 || layout.rail.width < width - 1 || layout.chat.top < layout.rail.bottom - 1 || layout.chat.width > width + 1)) throw new Error(`Phone top bar/layout invalid: ${JSON.stringify(layout)}`)
    }
    windows[1].setContentSize(390, 844)
    await new Promise(resolve => setTimeout(resolve, 300))
    for (const dark of [false, true]) {
      await windows[1].webContents.executeJavaScript(`document.documentElement.classList.toggle('dark', ${dark});localStorage.setItem('chat:customThemeEnabled','false');window.dispatchEvent(new Event('chatCustomThemeChange'))`)
      await new Promise(resolve => setTimeout(resolve, 100))
      await click(windows[1], '[aria-label="Conversation actions"]')
      const headerColors = await windows[1].webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-quiet-header] h1, .quiet-model-trigger, .quiet-model-trigger svg, .quiet-header-actions button')).map(el=>{const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.fillStyle=getComputedStyle(el).color;ctx.fillRect(0,0,1,1);const [r,g,b]=ctx.getImageData(0,0,1,1).data;return 'rgb('+r+', '+g+', '+b+')'})`)
      await windows[1].webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('chat:characterMeter', {detail:{style:'spectrum',scope:'all'}}))`)
      await wait(windows[1], `!!document.querySelector('.output-meter canvas')`, 'Spectrum missing')
      const spectrum = await windows[1].webContents.executeJavaScript(`(()=>{
        const meter=document.querySelector('.output-meter'), canvas=meter.querySelector('canvas'), key=meter.querySelector('.output-meter-key');
        const ctx=canvas.getContext('2d'), pixel=Array.from(ctx.getImageData(Math.floor(canvas.width/106),canvas.height-1,1,1).data);
        return { pixel, labels:key.children.length, first:key.firstChild.textContent, last:key.lastChild.textContent, color:getComputedStyle(meter).color };
      })()`)
      const expectedLetter = dark ? [134,239,172] : [30,64,175]
      if (spectrum.labels !== 53 || spectrum.first !== 'a' || spectrum.last !== '…' || !spectrum.pixel[3] || expectedLetter.some((c,i)=>Math.abs(c-spectrum.pixel[i])>4)) throw new Error('Wrong spectrum key or palette: '+JSON.stringify({dark,spectrum}))
      const meterKey = `document.querySelector('.output-meter-key')`
      await wait(windows[1], `getComputedStyle(${meterKey}).opacity==='0'`, 'Spectrum key should be hidden at rest')
      await windows[1].webContents.executeJavaScript(`document.querySelector('.output-meter').focus({focusVisible:true})`)
      await wait(windows[1], `getComputedStyle(${meterKey}).opacity==='1' && ${meterKey}.offsetHeight>0`, 'Spectrum focus did not reveal character labels')
      await windows[1].webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('chat:characterMeter', {detail:{style:'off',scope:'all'}}))`)
      console.log('PASS character spectrum canvas and per-character key in '+(dark?'dark':'light')+' mode')
      const expectedHeaderColor = dark ? 'rgb(245, 245, 244)' : 'rgb(41, 37, 36)'
      if (headerColors.length !== 6 || headerColors.some(color => color !== expectedHeaderColor)) throw new Error('Default header text mismatch: '+JSON.stringify({dark,headerColors}))
      await click(windows[1], '[aria-label="Conversation actions"]')
      await click(windows[1], '[data-quiet-add]')
      await wait(windows[1], `!!document.querySelector('.quiet-menu')`, 'Default theme menu missing')
      const menuColors = await windows[1].webContents.executeJavaScript(`Array.from(document.querySelectorAll('.quiet-menu-heading h2, .quiet-menu-heading button, .quiet-menu-items > button')).map(el=>getComputedStyle(el).color)`)
      if (!menuColors.length || menuColors.some(color => color !== (dark ? 'rgb(242, 243, 245)' : 'rgb(37, 38, 42)'))) throw new Error('Default menu text mismatch: '+JSON.stringify({dark,menuColors}))
      await click(windows[1], '[aria-label="Close composer menu"]')
      await wait(windows[1], `!document.querySelector('.quiet-menu')`, 'Default theme menu failed to close')
      await windows[1].webContents.executeJavaScript(`(()=>{
        document.documentElement.classList.toggle('dark', ${dark});
        localStorage.setItem('chat:customThemeEnabled','true');
        localStorage.setItem('chat:customTheme',JSON.stringify({colors:{settingsCustomThemesCardBg:{light:'#e0e8f0',dark:'#243448'},toolJobsPrimaryText:{light:'#123456',dark:'#e1e2e3'},toolJobsMutedText:{light:'#456789',dark:'#a1b2c3'},settingsCustomThemesButtonText:{light:'#234567',dark:'#c1d2e3'}}}));
        window.dispatchEvent(new Event('chatCustomThemeChange'));
      })()`)
      await click(windows[1], '[data-quiet-add]')
      await wait(windows[1], `!!document.querySelector('.quiet-menu')`, 'Theme menu missing')
      await new Promise(resolve=>setTimeout(resolve,300))
      const colors = await windows[1].webContents.executeJavaScript(`(()=>{
        const menu=document.querySelector('.quiet-menu'),input=document.querySelector('.quiet-input-slot textarea');
        const style=getComputedStyle(menu),canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=style.backgroundColor;ctx.fillRect(0,0,1,1);
        return {menu:getComputedStyle(menu.querySelector('h2')).color,add:getComputedStyle(document.querySelector('[data-quiet-add]')).color,input:getComputedStyle(input).color,placeholder:getComputedStyle(input,'::placeholder').color,blur:style.backdropFilter,alpha:ctx.getImageData(0,0,1,1).data[3]};
      })()`)
      if (colors.menu !== (dark?'rgb(225, 226, 227)':'rgb(18, 52, 86)') || colors.input!==colors.menu || colors.add!==(dark?'rgb(193, 210, 227)':'rgb(35, 69, 103)') || colors.placeholder!==(dark?'rgb(161, 178, 195)':'rgb(69, 103, 137)') || !colors.blur.includes('blur(28px)') || colors.alpha>=255 || colors.alpha<200) throw new Error('Quiet theme/glass mismatch '+JSON.stringify(colors))
      await click(windows[1], '[aria-label="Close composer menu"]')
      await wait(windows[1], `!document.querySelector('.quiet-menu')`, 'Theme menu failed to close')
    }
    await windows[1].webContents.executeJavaScript(`localStorage.setItem('chat:customThemeEnabled','false');document.documentElement.classList.remove('dark');window.dispatchEvent(new Event('chatCustomThemeChange'))`)
    console.log('PASS above-input popup anchoring and light/dark custom text/icon/placeholder colors with translucent blur')
    await click(windows[1], '.quiet-agents-slot button')
    await wait(windows[1], `!!document.querySelector('[data-quiet-panel="true"]:not([hidden])')`, 'Header agents failed to open')
    await click(windows[1], '[aria-label="Close agents"]')
    await wait(windows[1], `document.activeElement?.closest('.quiet-agents-slot') && document.querySelector('[data-quiet-panel="true"]').hidden`, 'Agents did not close/restore focus')
    const sameAgents = await windows[1].webContents.executeJavaScript(`document.querySelectorAll('.agents-pill').length===1`)
    if (!sameAgents) throw new Error('Duplicate agents owner')
    await click(windows[1], '[aria-label="Open sidebar panel"]')
    await wait(windows[1], `(()=>{const panel=document.querySelector('[role="dialog"][aria-label="Sidebar panel"]'); if(!panel)return false; const r=panel.getBoundingClientRect(); return r.width > 200 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;})()`, 'Phone sidebar panel not visible within viewport')
    await click(windows[1], 'button[aria-label="Close sidebar panel"]')
    // Wider phone/unfolded foldable: the top bar spans the viewport, so the panel must open
    // from the left below it, not get pushed to the right by the bar's right edge.
    windows[1].setContentSize(700, 900)
    await new Promise(resolve => setTimeout(resolve, 400))
    await click(windows[1], '[aria-label="Open sidebar panel"]')
    await wait(windows[1], `(()=>{const panel=document.querySelector('[role="dialog"][aria-label="Sidebar panel"]'); const rail=document.querySelector('[aria-label="Sidebar rail"]'); if(!panel||!rail)return false; const r=panel.getBoundingClientRect(), b=rail.getBoundingClientRect(); return r.left <= 12 && r.width >= innerWidth - 24 && r.right <= innerWidth && r.top >= b.bottom - 1 && r.bottom <= innerHeight;})()`, 'Foldable-width sidebar panel not anchored below the top bar')
    await click(windows[1], 'button[aria-label="Close sidebar panel"]')
    windows[1].setContentSize(390, 844)
    await new Promise(resolve => setTimeout(resolve, 300))
    console.log('PASS responsive web selectors at 320/390/767/820px, horizontal phone navigation and sidebar panel (390/700px)')
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
    const draftBeforeStream = await windows[1].webContents.executeJavaScript(`({value:document.querySelector('textarea[placeholder="Type your message..."]').value,active:document.activeElement.outerHTML.slice(0,400)})`)
    if (draftBeforeStream.value !== 'phone private draft') throw new Error('Phone draft fill failed before stream: '+JSON.stringify(draftBeforeStream))
    await fill(windows[0], 'first synthetic prompt');
    await click(windows[0], 'button[title="Send message"]')
    await wait(windows[0], `document.body.innerText.includes('Permission requested')`, 'Permission missing')
    await wait(windows[1], `document.body.innerText.includes('Permission requested')`, 'Second observer permission missing')
    // Commentary is still active work: it must retain one status BELOW the live text.
    for (const window of windows) await wait(window, `(()=>{
      const footer=document.querySelector('[data-live-activity-footer]');
      const tail=document.querySelector('[data-live-streaming-tail]');
      return footer && tail && tail.contains(footer) && tail.innerText.includes('Synthetic reply in progress') &&
        !!footer.querySelector('[aria-label="Assistant is working"]') && !document.querySelector('#message-generation-loader');
    })()`, 'Commentary lost its live-tail activity footer')
    if (subscribers.size !== 2) throw new Error(`Expected two live subscribers; got ${subscribers.size}`)
    if (await windows[1].webContents.executeJavaScript(`document.querySelector('textarea').value`) !== 'phone private draft') throw new Error('Remote event stole phone draft')
    await wait(windows[1], `(()=>{const queue=document.querySelector('.quiet-inline-send [title="Queue message"]'),loading=document.querySelector('.quiet-inline-send .send-btn-loading');if(!queue||!loading)return false;const q=queue.getBoundingClientRect(),s=loading.getBoundingClientRect();return Math.abs(q.width-s.width)<1 && Math.abs(q.height-s.height)<1 && Math.abs(q.top-s.top)<1})()`, 'Compact Queue and visible Stop circle differ in size/alignment')
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
    await windows[0].webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('chat:characterMeter', {detail:{style:'spectrum',scope:'all'}}))`)
    await wait(windows[0], `document.querySelector('.output-meter')?.getAttribute('aria-label')==='All output: 0 characters'`, 'Live spectrum did not start idle')
    // Exercise ownership transitions in the real shared Chat/ChatMessage renderers.
    const commentary = 'I have checked the files and am now preparing the next operation for this task.'
    publish({ type: 'chunk', part: 'text', delta: commentary })
    await wait(windows[0], `document.querySelector('.output-meter')?.getAttribute('aria-label')==='All output: ${commentary.length} characters'`, 'Live spectrum missed stream characters')
    console.log('PASS live character count from production SSE projection')
    for (const window of windows) await wait(window, `!!document.querySelector('[data-live-activity-footer] [aria-label="Assistant is working"]')`, 'Trailing commentary footer missing')
    publish({ type: 'chunk', part: 'tool_call', toolCall: { id: 'last-step', name: 'read_file', arguments: {} } })
    for (const window of windows) await wait(window, `!document.querySelector('[data-live-activity-footer]') && !!document.querySelector('[data-live-streaming-tail] [data-agent-steps] [role="status"]')`, 'Trailing steps did not take activity ownership')
    publish({ type: 'chunk', part: 'text', delta: 'The final check finished; I am putting the findings into the answer.' })
    publish({ type: 'chunk', part: 'tool_result', toolResult: { tool_use_id: 'last-step', content: 'ok' } })
    for (const window of windows) await wait(window, `!!document.querySelector('[data-live-activity-footer] [aria-label="Assistant is working"]') && !document.querySelector('[data-agent-steps] [role="status"]')`, 'Late tool result stole trailing prose ownership')
    for (const window of windows) {
      await window.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('streamingThinkingIndicatorPlacementChange', { detail: 'input-tab' }))`)
      await wait(window, `!document.querySelector('[data-live-activity-footer]') && !document.querySelector('[data-agent-steps] [role="status"]') && !!document.querySelector('[aria-label="Assistant is working"]')`, 'Input-tab preference lost activity')
      await window.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('streamingThinkingIndicatorPlacementChange', { detail: 'message' })); window.dispatchEvent(new CustomEvent('groupToolReasoningRunsChange', { detail: false }))`)
      await wait(window, `!!document.querySelector('[data-live-activity-footer]')`, 'Ungrouped commentary lost footer')
      await window.webContents.executeJavaScript(`window.dispatchEvent(new CustomEvent('groupToolReasoningRunsChange', { detail: true }))`)
    }
    console.log('PASS commentary -> active steps -> commentary/late result indicator ownership, placement and grouping on both clients')
    rows.push(row('a1', 'assistant', 'Synthetic final reply', parent)); publish({ type: 'complete', message: rows[rows.length - 1] }); for (const res of subscribers) res.end()
    for (const window of windows) await wait(window, `document.body.innerText.includes('Synthetic final reply')`, 'Final reply missing on sender/observer')
    for (const window of windows) await wait(window, `!document.querySelector('[data-live-activity-footer]') && !document.querySelector('#message-generation-loader') && !document.querySelector('[data-agent-steps] [role="status"]')`, 'Activity indicator remained after completion')
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
