export const TEST_HARNESS_CLIENT_JS = `;(function () {
  window.__headlessHarnessBooted = true
  try {
    console.info('[headless-harness] script booted')
  } catch (_error) {
    // no-op
  }

  // NOTE: do not use a window-global one-shot flag here.
  // In embedded/Electron shells this page can be re-rendered without a full reload,
  // and a global flag makes the harness silently no-op ("nothing works").
  // Guard against duplicate bindings on the current DOM only.
  var guardEl = document.getElementById('sendBtn') || document.body || document.documentElement
  if (guardEl && guardEl.getAttribute('data-headless-harness-bound') === '1') return
  if (guardEl) guardEl.setAttribute('data-headless-harness-bound', '1')

  var state = {
    accessToken: null,
    refreshToken: null,
    accountId: null,
    expiresAt: null,
    history: [],
    conversationId: null,
    availableTools: [],
    selectedToolNames: new Set(),
  }

  var ui = {
    userId: document.getElementById('userId'),
    model: document.getElementById('model'),
    sendMode: document.getElementById('sendMode'),
    oauthBtn: document.getElementById('oauthBtn'),
    resetBtn: document.getElementById('resetBtn'),
    sendBtn: document.getElementById('sendBtn'),
    prompt: document.getElementById('prompt'),
    status: document.getElementById('status'),
    chat: document.getElementById('chat'),
    toolsPanel: document.getElementById('toolsPanel'),
    toolsMeta: document.getElementById('toolsMeta'),
    toolsList: document.getElementById('toolsList'),
    refreshToolsBtn: document.getElementById('refreshToolsBtn'),
    selectAllToolsBtn: document.getElementById('selectAllToolsBtn'),
    clearToolsBtn: document.getElementById('clearToolsBtn'),
  }

  var requiredUi = ['userId', 'model', 'sendMode', 'oauthBtn', 'sendBtn', 'prompt', 'status', 'chat']
  var missingUi = requiredUi.filter(function (key) {
    return !ui[key]
  })
  if (missingUi.length > 0) {
    console.error('[headless-harness] Missing required UI elements:', missingUi)
    return
  }

  if (ui.toolsPanel && window.matchMedia && window.matchMedia('(max-width: 768px)').matches) {
    ui.toolsPanel.open = false
  }

  function toErrorMessage(error) {
    if (error && typeof error === 'object' && typeof error.message === 'string') return error.message
    return String(error)
  }

  function setStatus(text) {
    if (ui.status) ui.status.textContent = text
  }

  function addMessage(role, text) {
    if (!ui.chat) return null
    var el = document.createElement('div')
    el.className = 'msg ' + role
    el.textContent = text
    ui.chat.appendChild(el)
    ui.chat.scrollTop = ui.chat.scrollHeight
    return el
  }

  function getSelectedTools() {
    return state.availableTools.filter(function (tool) {
      return state.selectedToolNames.has(tool.name)
    })
  }

  function renderTools() {
    var tools = state.availableTools || []
    if (!ui.toolsList) return

    ui.toolsList.innerHTML = ''
    if (!tools.length) {
      ui.toolsList.innerHTML = '<div class="muted">No tools available.</div>'
    }

    tools.forEach(function (tool) {
      var label = document.createElement('label')
      label.className = 'tool-item'

      var checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = state.selectedToolNames.has(tool.name)
      checkbox.addEventListener('change', function () {
        if (checkbox.checked) state.selectedToolNames.add(tool.name)
        else state.selectedToolNames.delete(tool.name)
        if (ui.toolsMeta) {
          ui.toolsMeta.textContent = 'Loaded ' + tools.length + ' tools. Selected ' + getSelectedTools().length + '.'
        }
      })

      var nameSpan = document.createElement('span')
      nameSpan.className = 'tool-name'
      nameSpan.textContent = ' ' + tool.name

      label.appendChild(checkbox)
      label.appendChild(nameSpan)

      if (tool.description) {
        var desc = document.createElement('div')
        desc.className = 'tool-desc'
        desc.textContent = tool.description
        label.appendChild(desc)
      }

      ui.toolsList.appendChild(label)
    })

    if (ui.toolsMeta) {
      ui.toolsMeta.textContent = 'Loaded ' + tools.length + ' tools. Selected ' + getSelectedTools().length + '.'
    }
  }

  async function jsonFetch(url, init) {
    var opts = init || {}
    var headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {})
    var res = await fetch(url, Object.assign({}, opts, { headers: headers }))
    var payload = {}
    try {
      payload = await res.json()
    } catch (error) {
      payload = {}
    }
    if (!res.ok) {
      throw new Error((payload && payload.error) || ('HTTP ' + res.status))
    }
    return payload
  }

  async function loadTools() {
    var payload = await jsonFetch('/api/headless/ephemeral/tools', { method: 'GET' })
    state.availableTools = payload && Array.isArray(payload.tools) ? payload.tools : []
    state.selectedToolNames = new Set(
      state.availableTools.map(function (tool) {
        return tool.name
      })
    )
    renderTools()
  }

  function resetSession() {
    state.history = []
    state.conversationId = null
    if (ui.chat) ui.chat.innerHTML = ''
    addMessage('sys', 'Ephemeral session reset. Conversation cleared.')
  }

  async function connectOAuth() {
    var popup = window.open('about:blank', 'openai_oauth', 'width=520,height=760')
    setStatus('Starting OAuth flow...')

    var started = await jsonFetch('/api/openai/auth/start', { method: 'POST', body: '{}' })
    if (!started || !started.success || !started.authUrl || !started.state) {
      throw new Error('OAuth start failed')
    }
    if (popup) popup.location.href = started.authUrl

    var stateId = started.state
    var startedAt = Date.now()

    while (Date.now() - startedAt < 120000) {
      await new Promise(function (resolve) {
        setTimeout(resolve, 1500)
      })

      var completeRes = await fetch('/api/openai/auth/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: stateId }),
      })

      var payload = {}
      try {
        payload = await completeRes.json()
      } catch (error) {
        payload = {}
      }

      if (completeRes.ok && payload && payload.success) {
        state.accessToken = payload.accessToken || null
        state.refreshToken = payload.refreshToken || null
        state.accountId = payload.accountId || null
        state.expiresAt = payload.expiresAt || null

        var expiresAtIso = state.expiresAt ? new Date(Number(state.expiresAt)).toISOString() : null
        await jsonFetch('/api/provider-auth/openai/token', {
          method: 'POST',
          body: JSON.stringify({
            userId: ui.userId ? ui.userId.value.trim() : '',
            accessToken: state.accessToken,
            refreshToken: state.refreshToken,
            accountId: state.accountId,
            expiresAt: expiresAtIso,
          }),
        })

        setStatus('Connected. accountId=' + (state.accountId || 'n/a'))
        addMessage('sys', 'OAuth connected successfully.')
        return
      }

      if (payload && payload.pending) {
        setStatus('Waiting for OAuth completion...')
        continue
      }

      if (!completeRes.ok && completeRes.status !== 404) {
        throw new Error((payload && payload.error) || 'OAuth completion failed')
      }
    }

    throw new Error('OAuth timed out after 2 minutes')
  }

  async function ensureConversation(userId) {
    if (state.conversationId) return state.conversationId

    var created = await jsonFetch('/api/app/conversations', {
      method: 'POST',
      body: JSON.stringify({
        user_id: userId,
        title: 'Headless Harness Conversation',
        storage_mode: 'local',
      }),
    })

    var id = created && created.conversation && created.conversation.id ? created.conversation.id : null
    if (!id) throw new Error('Failed to create harness conversation')

    state.conversationId = id
    addMessage('sys', 'Created conversation: ' + id)
    return id
  }

  function parseSseEvents(rawText) {
    var events = []
    var lines = String(rawText || '').split('\\n')
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      if (!line || line.indexOf('data: ') !== 0) continue
      var payload = line.slice(6)
      try {
        events.push(JSON.parse(payload))
      } catch (error) {
        // ignore malformed lines
      }
    }
    return events
  }

  async function sendViaProvider(content, userId, modelName, selectedTools, assistantEl) {
    var payload = await jsonFetch('/api/headless/provider/openai/responses', {
      method: 'POST',
      body: JSON.stringify({
        userId: userId,
        modelName: modelName,
        content: content,
        history: state.history,
        tools: selectedTools,
      }),
    })

    var assistant = payload && payload.message && payload.message.content ? payload.message.content : ''
    if (assistantEl) assistantEl.textContent = assistant

    if (payload && payload.reasoning) {
      addMessage('sys', 'Reasoning:\\n' + payload.reasoning)
    }

    if (payload && Array.isArray(payload.toolCalls) && payload.toolCalls.length > 0) {
      addMessage('sys', 'Tool calls (provider only; no loop execution here):\\n' + JSON.stringify(payload.toolCalls, null, 2))
    }

    if (payload && Array.isArray(payload.contentBlocks) && payload.contentBlocks.length > 0) {
      addMessage('sys', 'Content blocks:\\n' + JSON.stringify(payload.contentBlocks, null, 2))
    }

    state.history.push({ role: 'user', content: content })
    state.history.push({
      role: 'assistant',
      content: assistant,
      tool_calls: payload && payload.toolCalls ? payload.toolCalls : null,
      content_blocks: payload && payload.contentBlocks ? payload.contentBlocks : null,
    })
  }

  async function sendViaOrchestrator(content, userId, modelName, selectedTools, assistantEl) {
    var conversationId = await ensureConversation(userId)

    var res = await fetch('/api/conversations/' + encodeURIComponent(conversationId) + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: content,
        provider: 'openaichatgpt',
        modelName: modelName,
        userId: userId,
        tools: selectedTools,
      }),
    })

    var raw = await res.text()
    if (!res.ok) {
      throw new Error('Orchestrator SSE request failed: HTTP ' + res.status + ' ' + raw)
    }

    var events = parseSseEvents(raw)
    var assistantText = ''

    events.forEach(function (event) {
      if (!event || typeof event !== 'object') return

      if (event.type === 'chunk' && event.part === 'text' && typeof event.delta === 'string') {
        assistantText += event.delta
        if (assistantEl) assistantEl.textContent = assistantText
        return
      }

      if (event.type === 'chunk' && event.part === 'reasoning' && typeof event.delta === 'string') {
        addMessage('sys', 'Reasoning chunk:\\n' + event.delta)
        return
      }

      if (event.type === 'tool_execution') {
        addMessage('sys', 'Tool execution: ' + event.status + ' ' + event.toolName + ' (' + event.toolCallId + ')')
        return
      }

      if (event.type === 'chunk' && event.part === 'tool_result' && event.toolResult) {
        addMessage('sys', 'Tool result:\\n' + JSON.stringify(event.toolResult, null, 2))
        return
      }

      if (event.type === 'error') {
        throw new Error(event.error || 'Unknown orchestrator error')
      }

      if (event.type === 'complete' && event.message && typeof event.message.content === 'string') {
        assistantText = event.message.content
        if (assistantEl) assistantEl.textContent = assistantText
      }
    })

    if (!assistantText && assistantEl) {
      assistantText = assistantEl.textContent || ''
    }
  }

  async function sendMessage() {
    var content = ui.prompt ? ui.prompt.value.trim() : ''
    if (!content) return
    var userId = ui.userId ? ui.userId.value.trim() : ''
    if (!userId) throw new Error('User ID is required')

    var modelName = (ui.model && ui.model.value) || 'gpt-5.6-sol'
    var mode = (ui.sendMode && ui.sendMode.value) || 'provider'
    var selectedTools = getSelectedTools()

    addMessage('user', content)
    if (ui.prompt) ui.prompt.value = ''
    var assistantEl = addMessage('assistant', '')

    if (mode === 'orchestrator') {
      await sendViaOrchestrator(content, userId, modelName, selectedTools, assistantEl)
      return
    }

    await sendViaProvider(content, userId, modelName, selectedTools, assistantEl)
  }

  if (ui.oauthBtn) {
    ui.oauthBtn.addEventListener('click', async function () {
      ui.oauthBtn.disabled = true
      try {
        await connectOAuth()
      } catch (error) {
        var msg = toErrorMessage(error)
        setStatus('OAuth error: ' + msg)
        addMessage('sys', 'OAuth error: ' + msg)
      } finally {
        ui.oauthBtn.disabled = false
      }
    })
  }

  if (ui.sendBtn) {
    ui.sendBtn.addEventListener('click', async function () {
      ui.sendBtn.disabled = true
      try {
        await sendMessage()
      } catch (error) {
        addMessage('sys', 'Send error: ' + toErrorMessage(error))
      } finally {
        ui.sendBtn.disabled = false
      }
    })
  }

  if (ui.refreshToolsBtn) {
    ui.refreshToolsBtn.addEventListener('click', async function () {
      ui.refreshToolsBtn.disabled = true
      try {
        await loadTools()
        addMessage('sys', 'Tools refreshed.')
      } catch (error) {
        addMessage('sys', 'Tool load error: ' + toErrorMessage(error))
        if (ui.toolsMeta) ui.toolsMeta.textContent = 'Tool load failed.'
      } finally {
        ui.refreshToolsBtn.disabled = false
      }
    })
  }

  if (ui.selectAllToolsBtn) {
    ui.selectAllToolsBtn.addEventListener('click', function () {
      state.selectedToolNames = new Set(
        state.availableTools.map(function (tool) {
          return tool.name
        })
      )
      renderTools()
    })
  }

  if (ui.clearToolsBtn) {
    ui.clearToolsBtn.addEventListener('click', function () {
      state.selectedToolNames = new Set()
      renderTools()
    })
  }

  if (ui.resetBtn) {
    ui.resetBtn.addEventListener('click', resetSession)
  }

  if (ui.prompt && ui.sendBtn) {
    ui.prompt.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        ui.sendBtn.click()
      }
    })
  }

  window.addEventListener('error', function (event) {
    var msg = event && event.error ? toErrorMessage(event.error) : String((event && event.message) || 'Unknown script error')
    setStatus('Script error: ' + msg)
    addMessage('sys', 'Script error: ' + msg)
  })

  window.__headlessHarnessDebug = {
    state: state,
    ui: ui,
    sendMessage: sendMessage,
    connectOAuth: connectOAuth,
    loadTools: loadTools,
    resetSession: resetSession,
  }

  if (ui.model) ui.model.value = 'gpt-5.6-sol'
  if (ui.sendMode) ui.sendMode.value = 'provider'
  addMessage('sys', 'Ready. 1) Connect OAuth 2) Pick tools 3) Choose mode (provider/orchestrator) 4) Send.')
  loadTools().catch(function (error) {
    var msg = toErrorMessage(error)
    addMessage('sys', 'Initial tool load failed: ' + msg)
    if (ui.toolsMeta) ui.toolsMeta.textContent = 'Tool load failed: ' + msg
    setStatus('Tool load failed')
  })
})()
`
