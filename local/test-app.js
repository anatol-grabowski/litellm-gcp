'use strict'

const crypto = require('crypto')
const http = require('http')

const port = Number(process.env.PORT || 3002)
const litellmBaseUrl = process.env.LITELLM_BASE_URL || 'http://litellm:4000'
const litellmPublicUrl = process.env.LITELLM_PUBLIC_URL || 'http://localhost:4000'
const publicOrigin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`
const oauthMaxAgeMs = 10 * 60 * 1000
const pendingOauth = new Map()

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

function sendHtml(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

function normalizeKey(value) {
  if (typeof value !== 'string') {
    return ''
  }

  return value.trim().replace(/^Bearer\s+/i, '')
}

function authHeaders(virtualKey) {
  return {
    Authorization: `Bearer ${virtualKey}`,
  }
}

function mcpAuthHeaders(virtualKey) {
  return {
    'x-litellm-api-key': `Bearer ${virtualKey}`,
  }
}

async function readJson(request) {
  return await new Promise((resolve, reject) => {
    let body = ''

    request.setEncoding('utf8')
    request.on('data', chunk => {
      body += chunk
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body is too large'))
        request.destroy()
      }
    })
    request.on('end', () => {
      if (!body) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(new Error('Invalid JSON request body'))
      }
    })
    request.on('error', reject)
  })
}

async function readResponse(response) {
  const text = await response.text()
  let data = null

  if (text) {
    try {
      data = JSON.parse(text)
    } catch (error) {
      data = null
    }
  }

  return { text, data }
}

function errorMessage(value) {
  if (!value) {
    return 'Unknown error'
  }

  if (typeof value === 'string') {
    return value
  }

  const detail = value.detail
  if (typeof detail === 'string') {
    return detail
  }
  if (detail && typeof detail === 'object') {
    return detail.error_description || detail.message || detail.error || JSON.stringify(detail)
  }

  return value.error_description || value.message || value.error || JSON.stringify(value)
}

function cleanupOauth() {
  const now = Date.now()
  for (const [state, entry] of pendingOauth.entries()) {
    if (now - entry.createdAt > oauthMaxAgeMs) {
      pendingOauth.delete(state)
    }
  }
}

function base64Url(buffer) {
  return buffer
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function createPkce() {
  const verifier = base64Url(crypto.randomBytes(48))
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

async function fetchMcpServers(virtualKey) {
  const response = await fetch(`${litellmBaseUrl}/v1/mcp/server`, {
    headers: authHeaders(virtualKey),
  })
  const result = await readResponse(response)

  if (!response.ok) {
    throw new Error(`LiteLLM MCP server list failed (${response.status}): ${errorMessage(result.data || result.text)}`)
  }

  return Array.isArray(result.data) ? result.data : []
}

function getServerName(server) {
  return String(server.server_name || server.name || server.server_id || '')
}

function getServerId(server) {
  return String(server.server_id || server.id || server.server_name || '')
}

async function findNotionServer(virtualKey) {
  const servers = await fetchMcpServers(virtualKey)

  for (let i = 0; i < servers.length; i += 1) {
    const server = servers[i]
    const name = getServerName(server).toLowerCase()
    const url = String(server.url || '').toLowerCase()
    if (name === 'notion' || name.includes('notion') || url.includes('mcp.notion.com')) {
      return server
    }
  }

  throw new Error('Notion MCP is not visible to this virtual key. Check the MCP config/access grant.')
}

async function getNotionStatus(virtualKey, serverId) {
  const response = await fetch(`${litellmBaseUrl}/v1/mcp/server/${encodeURIComponent(serverId)}/oauth-user-credential/status`, {
    headers: authHeaders(virtualKey),
  })
  const result = await readResponse(response)

  if (!response.ok) {
    const message = errorMessage(result.data || result.text)
    if (response.status === 400 && /user id/i.test(message)) {
      const error = new Error('This virtual key has no user_id. Generate a virtual key attached to a LiteLLM user so Notion OAuth can be stored per user.')
      error.code = 'missing_user_id'
      throw error
    }
    throw new Error(`Notion credential status failed (${response.status}): ${message}`)
  }

  return result.data || {}
}

function isMcpAuthError(status, value) {
  if (status === 401 || status === 412) {
    return true
  }

  const text = typeof value === 'string' ? value : JSON.stringify(value || {})
  return /oauth|auth_required|authentication required|not authenticated|credential|login required|mcp.*401/i.test(text)
}

function browserHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>LiteLLM MCP Tester</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1f2937; background: #f6f7f9; }
    main { width: min(940px, calc(100% - 24px)); margin: 12px auto; display: grid; gap: 10px; }
    .card { background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; padding: 10px; }
    h1 { margin: 0 0 8px; font-size: 18px; }
    h2 { margin: 0 0 8px; font-size: 14px; }
    label { display: block; margin-bottom: 4px; font-size: 12px; color: #4b5563; }
    input, textarea, select, button { font: inherit; }
    input, textarea, select { width: 100%; border: 1px solid #cfd5dc; border-radius: 6px; padding: 7px 8px; background: #fff; color: #111827; }
    textarea { min-height: 120px; resize: vertical; }
    button { border: 1px solid #c6ccd4; border-radius: 6px; padding: 7px 10px; background: #fff; cursor: pointer; }
    button.primary { background: #eef4ff; border-color: #a9bfe8; }
    button:disabled { opacity: .55; cursor: default; }
    .grid { display: grid; grid-template-columns: 1fr 180px 160px; gap: 8px; align-items: end; }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .grow { flex: 1 1 320px; }
    .status { display: inline-flex; align-items: center; min-height: 28px; padding: 4px 8px; border-radius: 6px; background: #f3f4f6; color: #4b5563; }
    .status.ok { background: #eef8f0; color: #276738; }
    .status.warn { background: #fff6df; color: #805b00; }
    .status.error { background: #fff0f0; color: #9b2c2c; }
    .notice { margin-top: 8px; padding: 8px; border: 1px solid #ead394; border-radius: 6px; background: #fff9e8; }
    .hidden { display: none; }
    pre { margin: 0; min-height: 80px; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .muted { color: #6b7280; font-size: 12px; }
    @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>LiteLLM MCP Tester</h1>
      <div class="row">
        <div class="grow">
          <label for="key">User virtual key</label>
          <input id="key" type="password" autocomplete="off" placeholder="sk-...">
        </div>
        <button id="check">Check key + MCP</button>
        <span id="keyStatus" class="status">Not checked</span>
      </div>
      <div class="muted">The key is sent only to this local helper server and LiteLLM. It is kept in browser session storage for this tab.</div>
    </section>

    <section class="card">
      <h2>Prompt</h2>
      <div class="grid">
        <div>
          <label for="model">Model</label>
          <input id="model" value="gemini-2.5-flash">
        </div>
        <div>
          <label for="mcpScope">MCP tools</label>
          <select id="mcpScope">
            <option value="all">All configured MCPs</option>
            <option value="notion">Notion only</option>
            <option value="example">Example MCP only</option>
            <option value="none">No MCP</option>
          </select>
        </div>
        <button id="send" class="primary">Send</button>
      </div>
      <div style="margin-top:8px">
        <textarea id="prompt" placeholder="For example: Search my Notion workspace for pages mentioning LiteLLM and summarize them."></textarea>
      </div>
      <div id="authNotice" class="notice hidden">
        <strong>Notion login required.</strong>
        <span id="authText">This virtual key does not currently have a stored Notion OAuth credential.</span>
        <div class="row" style="margin-top:8px">
          <button id="loginNotion" class="primary">Log in to Notion</button>
          <button id="checkNotion">Check again</button>
          <span id="notionStatus" class="status warn">Not connected</span>
        </div>
      </div>
    </section>

    <section class="card">
      <h2>Response</h2>
      <pre id="output">Ready.</pre>
    </section>
  </main>

  <script>
    'use strict'

    const keyInput = document.getElementById('key')
    const modelInput = document.getElementById('model')
    const mcpScope = document.getElementById('mcpScope')
    const promptInput = document.getElementById('prompt')
    const output = document.getElementById('output')
    const keyStatus = document.getElementById('keyStatus')
    const notionStatus = document.getElementById('notionStatus')
    const authNotice = document.getElementById('authNotice')
    const authText = document.getElementById('authText')
    const sendButton = document.getElementById('send')
    const loginButton = document.getElementById('loginNotion')

    keyInput.value = sessionStorage.getItem('litellmVirtualKey') || ''

    keyInput.addEventListener('input', () => {
      sessionStorage.setItem('litellmVirtualKey', keyInput.value.trim())
      keyStatus.textContent = 'Not checked'
      keyStatus.className = 'status'
    })

    async function api(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({ error: 'Invalid response from local helper' }))
      return { response, data }
    }

    function key() {
      return keyInput.value.trim().replace(/^Bearer\\s+/i, '')
    }

    function showAuth(message) {
      authNotice.classList.remove('hidden')
      authText.textContent = message || 'This virtual key does not currently have a stored Notion OAuth credential.'
      notionStatus.textContent = 'Not connected'
      notionStatus.className = 'status warn'
    }

    function hideAuth() {
      authNotice.classList.add('hidden')
    }

    async function checkNotion() {
      const virtualKey = key()
      if (!virtualKey) {
        showAuth('Enter a virtual key first.')
        return false
      }

      notionStatus.textContent = 'Checking…'
      notionStatus.className = 'status'
      const { response, data } = await api('/api/notion/status', { virtualKey })

      if (!response.ok) {
        showAuth(data.error || 'Could not check Notion authentication.')
        notionStatus.textContent = 'Error'
        notionStatus.className = 'status error'
        return false
      }

      if (data.connected && !data.expired) {
        notionStatus.textContent = 'Connected'
        notionStatus.className = 'status ok'
        hideAuth()
        return true
      }

      showAuth(data.expired ? 'The stored Notion OAuth credential has expired. Log in again.' : 'This virtual key needs a Notion login before Notion tools can run.')
      return false
    }

    document.getElementById('check').addEventListener('click', async () => {
      const virtualKey = key()
      if (!virtualKey) {
        keyStatus.textContent = 'Enter a key'
        keyStatus.className = 'status warn'
        return
      }

      keyStatus.textContent = 'Checking…'
      keyStatus.className = 'status'
      const { response, data } = await api('/api/check', { virtualKey })
      if (!response.ok) {
        keyStatus.textContent = data.error || 'Failed'
        keyStatus.className = 'status error'
        return
      }

      keyStatus.textContent = 'Key valid'
      keyStatus.className = 'status ok'
      if (data.notion) {
        if (data.notion.connected && !data.notion.expired) {
          notionStatus.textContent = 'Connected'
          notionStatus.className = 'status ok'
          hideAuth()
        } else {
          showAuth(data.notion.expired ? 'Notion credential expired.' : 'Notion is configured but this user is not logged in.')
        }
      }
    })

    document.getElementById('checkNotion').addEventListener('click', async () => {
      await checkNotion()
    })

    loginButton.addEventListener('click', async () => {
      const virtualKey = key()
      if (!virtualKey) {
        showAuth('Enter a virtual key first.')
        return
      }

      loginButton.disabled = true
      notionStatus.textContent = 'Starting login…'
      notionStatus.className = 'status'

      const { response, data } = await api('/api/notion/login/start', { virtualKey })
      loginButton.disabled = false

      if (!response.ok) {
        showAuth(data.error || 'Could not start Notion login.')
        notionStatus.textContent = 'Login failed'
        notionStatus.className = 'status error'
        return
      }

      const popup = window.open(data.loginUrl, 'notionOAuth', 'width=720,height=760')
      if (!popup) {
        showAuth('Popup blocked. Allow popups for this local page and try again.')
        return
      }

      notionStatus.textContent = 'Waiting for Notion…'
      notionStatus.className = 'status warn'
    })

    window.addEventListener('message', async event => {
      if (event.origin !== location.origin || !event.data || event.data.type !== 'notion-oauth-complete') {
        return
      }

      if (!event.data.ok) {
        showAuth(event.data.error || 'Notion login failed.')
        notionStatus.textContent = 'Login failed'
        notionStatus.className = 'status error'
        return
      }

      notionStatus.textContent = 'Connected'
      notionStatus.className = 'status ok'
      hideAuth()
      output.textContent = 'Notion login completed. The OAuth credential is stored in LiteLLM for this virtual key user.'
    })

    sendButton.addEventListener('click', async () => {
      const virtualKey = key()
      const prompt = promptInput.value.trim()
      if (!virtualKey || !prompt) {
        output.textContent = 'Enter both a virtual key and a prompt.'
        return
      }

      if (mcpScope.value === 'notion') {
        const connected = await checkNotion()
        if (!connected) {
          output.textContent = 'Notion authentication is required before this request can use Notion tools.'
          return
        }
      }

      sendButton.disabled = true
      output.textContent = 'Running…'
      const { response, data } = await api('/api/chat', {
        virtualKey,
        model: modelInput.value.trim(),
        prompt,
        mcpScope: mcpScope.value,
      })
      sendButton.disabled = false

      if (data.authRequired) {
        showAuth(data.error || 'An MCP server requires user authentication.')
      }

      if (!response.ok) {
        output.textContent = data.error || JSON.stringify(data, null, 2)
        return
      }

      output.textContent = data.text || JSON.stringify(data.response, null, 2)
    })
  </script>
</body>
</html>`
}

function oauthResultHtml(ok, message) {
  const payload = JSON.stringify({
    type: 'notion-oauth-complete',
    ok,
    error: ok ? undefined : message,
  }).replace(/</g, '\\u003c')
  const safeMessage = String(message || (ok ? 'Notion connected.' : 'Notion login failed.'))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Notion OAuth</title></head>
<body style="font:14px system-ui;padding:20px;color:#1f2937">
  <p>${safeMessage}</p>
  <script>
    if (window.opener) {
      window.opener.postMessage(${payload}, ${JSON.stringify(publicOrigin)})
      setTimeout(() => window.close(), 500)
    }
  </script>
</body>
</html>`
}

async function handleCheck(request, response) {
  const body = await readJson(request)
  const virtualKey = normalizeKey(body.virtualKey)
  if (!virtualKey) {
    sendJson(response, 400, { error: 'Virtual key is required.' })
    return
  }

  const modelsResponse = await fetch(`${litellmBaseUrl}/v1/models`, {
    headers: authHeaders(virtualKey),
  })
  const modelsResult = await readResponse(modelsResponse)
  if (!modelsResponse.ok) {
    sendJson(response, modelsResponse.status, {
      error: `Virtual key check failed: ${errorMessage(modelsResult.data || modelsResult.text)}`,
    })
    return
  }

  let notion = null
  try {
    const server = await findNotionServer(virtualKey)
    const status = await getNotionStatus(virtualKey, getServerId(server))
    notion = {
      configured: true,
      connected: Boolean(status.has_credential),
      expired: Boolean(status.is_expired),
      serverId: getServerId(server),
    }
  } catch (error) {
    notion = {
      configured: false,
      connected: false,
      expired: false,
      error: error.message,
    }
  }

  sendJson(response, 200, {
    ok: true,
    notion,
    models: modelsResult.data,
  })
}

async function handleNotionStatus(request, response) {
  const body = await readJson(request)
  const virtualKey = normalizeKey(body.virtualKey)
  if (!virtualKey) {
    sendJson(response, 400, { error: 'Virtual key is required.' })
    return
  }

  try {
    const server = await findNotionServer(virtualKey)
    const serverId = getServerId(server)
    const status = await getNotionStatus(virtualKey, serverId)
    sendJson(response, 200, {
      connected: Boolean(status.has_credential),
      expired: Boolean(status.is_expired),
      expiresAt: status.expires_at || null,
      serverId,
    })
  } catch (error) {
    sendJson(response, error.code === 'missing_user_id' ? 400 : 502, { error: error.message })
  }
}

async function handleChat(request, response) {
  const body = await readJson(request)
  const virtualKey = normalizeKey(body.virtualKey)
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'gemini-2.5-flash'
  const mcpScope = ['all', 'notion', 'example', 'none'].includes(body.mcpScope) ? body.mcpScope : 'all'

  if (!virtualKey || !prompt) {
    sendJson(response, 400, { error: 'Virtual key and prompt are required.' })
    return
  }

  if (mcpScope === 'notion') {
    try {
      const server = await findNotionServer(virtualKey)
      const status = await getNotionStatus(virtualKey, getServerId(server))
      if (!status.has_credential || status.is_expired) {
        sendJson(response, 409, {
          error: status.is_expired
            ? 'Notion OAuth credential is expired. Log in to Notion again.'
            : 'Notion login is required for this virtual-key user.',
          authRequired: true,
          mcp: 'notion',
        })
        return
      }
    } catch (error) {
      sendJson(response, 409, {
        error: error.message,
        authRequired: true,
        mcp: 'notion',
      })
      return
    }
  }

  const payload = {
    model,
    messages: [
      {
        role: 'user',
        content: prompt,
      },
    ],
  }

  if (mcpScope !== 'none') {
    let serverUrl = 'litellm_proxy'
    if (mcpScope === 'notion') {
      serverUrl = 'litellm_proxy/mcp/notion'
    } else if (mcpScope === 'example') {
      serverUrl = 'litellm_proxy/mcp/example'
    }

    payload.tools = [
      {
        type: 'mcp',
        server_label: mcpScope === 'all' ? 'litellm' : mcpScope,
        server_url: serverUrl,
        require_approval: 'never',
      },
    ]
  }

  const upstream = await fetch(`${litellmBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      ...authHeaders(virtualKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const result = await readResponse(upstream)

  if (!upstream.ok) {
    const value = result.data || result.text
    sendJson(response, upstream.status, {
      error: `LiteLLM request failed (${upstream.status}): ${errorMessage(value)}`,
      authRequired: isMcpAuthError(upstream.status, value),
      response: result.data,
    })
    return
  }

  const text = result.data?.choices?.[0]?.message?.content
  sendJson(response, 200, {
    text: typeof text === 'string' ? text : '',
    response: result.data,
  })
}

async function handleNotionLoginStart(request, response) {
  cleanupOauth()
  const body = await readJson(request)
  const virtualKey = normalizeKey(body.virtualKey)
  if (!virtualKey) {
    sendJson(response, 400, { error: 'Virtual key is required.' })
    return
  }

  try {
    const server = await findNotionServer(virtualKey)
    const serverId = getServerId(server)
    await getNotionStatus(virtualKey, serverId)

    const redirectUri = `${publicOrigin}/oauth/callback`
    const registerResponse = await fetch(`${litellmBaseUrl}/notion/register`, {
      method: 'POST',
      headers: {
        ...mcpAuthHeaders(virtualKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_name: 'Local LiteLLM MCP Tester',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    })
    const registerResult = await readResponse(registerResponse)

    if (!registerResponse.ok) {
      throw new Error(`Notion MCP client registration failed (${registerResponse.status}): ${errorMessage(registerResult.data || registerResult.text)}`)
    }

    const clientId = registerResult.data?.client_id
    const clientSecret = registerResult.data?.client_secret || ''
    if (!clientId) {
      throw new Error('Notion MCP registration did not return a client_id.')
    }

    const state = base64Url(crypto.randomBytes(24))
    const pkce = createPkce()
    pendingOauth.set(state, {
      virtualKey,
      serverId,
      serverName: 'notion',
      clientId,
      clientSecret,
      redirectUri,
      codeVerifier: pkce.verifier,
      createdAt: Date.now(),
    })

    const loginUrl = new URL(`${litellmPublicUrl}/notion/authorize`)
    loginUrl.searchParams.set('response_type', 'code')
    loginUrl.searchParams.set('client_id', clientId)
    loginUrl.searchParams.set('redirect_uri', redirectUri)
    loginUrl.searchParams.set('state', state)
    loginUrl.searchParams.set('code_challenge', pkce.challenge)
    loginUrl.searchParams.set('code_challenge_method', 'S256')

    sendJson(response, 200, { loginUrl: loginUrl.toString() })
  } catch (error) {
    sendJson(response, error.code === 'missing_user_id' ? 400 : 502, { error: error.message })
  }
}

async function handleOauthCallback(request, response, url) {
  cleanupOauth()
  const state = url.searchParams.get('state') || ''
  const code = url.searchParams.get('code') || ''
  const oauthError = url.searchParams.get('error') || ''
  const oauthDescription = url.searchParams.get('error_description') || ''
  const entry = pendingOauth.get(state)

  if (oauthError) {
    pendingOauth.delete(state)
    sendHtml(response, 400, oauthResultHtml(false, oauthDescription || oauthError))
    return
  }

  if (!entry || !code) {
    sendHtml(response, 400, oauthResultHtml(false, 'OAuth callback is missing or expired. Start the Notion login again.'))
    return
  }

  pendingOauth.delete(state)

  try {
    const form = new URLSearchParams()
    form.set('grant_type', 'authorization_code')
    form.set('code', code)
    form.set('redirect_uri', entry.redirectUri)
    form.set('client_id', entry.clientId)
    form.set('code_verifier', entry.codeVerifier)
    if (entry.clientSecret) {
      form.set('client_secret', entry.clientSecret)
    }

    const tokenResponse = await fetch(`${litellmBaseUrl}/${entry.serverName}/token`, {
      method: 'POST',
      headers: {
        ...mcpAuthHeaders(entry.virtualKey),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })
    const tokenResult = await readResponse(tokenResponse)
    if (!tokenResponse.ok) {
      throw new Error(`Notion token exchange failed (${tokenResponse.status}): ${errorMessage(tokenResult.data || tokenResult.text)}`)
    }

    const token = tokenResult.data || {}
    if (!token.access_token) {
      throw new Error('Notion token exchange returned no access_token.')
    }

    const scopes = Array.isArray(token.scopes)
      ? token.scopes
      : typeof token.scope === 'string'
        ? token.scope.split(/\s+/).filter(Boolean)
        : []

    const storePayload = {
      access_token: token.access_token,
    }
    if (token.refresh_token) {
      storePayload.refresh_token = token.refresh_token
    }
    if (Number.isFinite(Number(token.expires_in))) {
      storePayload.expires_in = Number(token.expires_in)
    }
    if (scopes.length > 0) {
      storePayload.scopes = scopes
    }

    const storeResponse = await fetch(`${litellmBaseUrl}/v1/mcp/server/${encodeURIComponent(entry.serverId)}/oauth-user-credential`, {
      method: 'POST',
      headers: {
        ...authHeaders(entry.virtualKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(storePayload),
    })
    const storeResult = await readResponse(storeResponse)
    if (!storeResponse.ok) {
      throw new Error(`LiteLLM could not store the Notion credential (${storeResponse.status}): ${errorMessage(storeResult.data || storeResult.text)}`)
    }

    sendHtml(response, 200, oauthResultHtml(true, 'Notion connected. You can close this window.'))
  } catch (error) {
    sendHtml(response, 502, oauthResultHtml(false, error.message))
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, publicOrigin)

  try {
    if (request.method === 'GET' && url.pathname === '/') {
      sendHtml(response, 200, browserHtml())
      return
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'ok' })
      return
    }

    if (request.method === 'GET' && url.pathname === '/oauth/callback') {
      await handleOauthCallback(request, response, url)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/check') {
      await handleCheck(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      await handleChat(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/notion/status') {
      await handleNotionStatus(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/notion/login/start') {
      await handleNotionLoginStart(request, response)
      return
    }

    sendJson(response, 404, { error: 'Not found' })
  } catch (error) {
    sendJson(response, 500, { error: error.message || String(error) })
  }
})

server.listen(port, '0.0.0.0', () => {
  process.stderr.write(`LiteLLM MCP test app listening on http://0.0.0.0:${port}\n`)
})
