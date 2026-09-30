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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`
}

function isSensitiveName(name) {
  return /(?:authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|code[-_]?verifier|^code$)/i.test(String(name || ''))
}

function redactObject(value, keyName = '') {
  if (isSensitiveName(keyName)) {
    return '<redacted>'
  }

  if (Array.isArray(value)) {
    const result = []
    for (let i = 0; i < value.length; i += 1) {
      result.push(redactObject(value[i]))
    }
    return result
  }

  if (value && typeof value === 'object') {
    const result = {}
    const keys = Object.keys(value)
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i]
      result[key] = redactObject(value[key], key)
    }
    return result
  }

  return value
}

function redactRequestBody(body, contentType) {
  if (body === undefined || body === null) {
    return null
  }

  const raw = typeof body === 'string' ? body : String(body)
  if (/application\/json/i.test(contentType)) {
    try {
      return JSON.stringify(redactObject(JSON.parse(raw)))
    } catch (error) {
      return raw
    }
  }

  if (/application\/x-www-form-urlencoded/i.test(contentType)) {
    const input = new URLSearchParams(raw)
    const output = new URLSearchParams()
    for (const [key, value] of input.entries()) {
      output.append(key, isSensitiveName(key) ? '<redacted>' : value)
    }
    return output.toString()
  }

  return raw
}

function publicLitellmUrl(value) {
  const source = value instanceof URL ? value : new URL(String(value), litellmBaseUrl)
  const base = new URL(litellmPublicUrl)
  base.pathname = source.pathname
  base.search = source.search
  base.hash = ''
  return base.toString()
}

function redactInlineSecrets(value) {
  return String(value)
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, '<redacted>')
    .replace(/\bBearer\s+[^\s'"\\]+/gi, 'Bearer <redacted>')
}

function logLitellmRequest(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase()
  const publicUrl = publicLitellmUrl(url)
  const headers = new Headers(options.headers || {})
  let command = `curl -i -X ${method} ${shellQuote(publicUrl)}`

  const headerEntries = Array.from(headers.entries())
  for (let i = 0; i < headerEntries.length; i += 1) {
    const [name, value] = headerEntries[i]
    const safeValue = isSensitiveName(name)
      ? (/^bearer\s+/i.test(value) ? 'Bearer <redacted>' : '<redacted>')
      : redactInlineSecrets(value)
    command += ` \\\n  -H ${shellQuote(`${name}: ${safeValue}`)}`
  }

  if (options.body !== undefined && options.body !== null) {
    const contentType = headers.get('content-type') || ''
    const safeBody = redactInlineSecrets(redactRequestBody(options.body, contentType))
    command += ` \\\n  --data-raw ${shellQuote(safeBody)}`
  }

  const endpoint = new URL(String(url), litellmBaseUrl)
  process.stderr.write(`[test-app -> LiteLLM] ${method} ${endpoint.pathname}${endpoint.search}\n${command}\n`)
}

async function litellmFetch(url, options = {}) {
  logLitellmRequest(url, options)
  return await fetch(url, options)
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
  const response = await litellmFetch(`${litellmBaseUrl}/v1/mcp/server`, {
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

async function getOauthStatus(virtualKey, serverId, serverName = 'MCP') {
  const response = await litellmFetch(`${litellmBaseUrl}/v1/mcp/server/${encodeURIComponent(serverId)}/oauth-user-credential/status`, {
    headers: authHeaders(virtualKey),
  })
  const result = await readResponse(response)

  if (!response.ok) {
    const message = errorMessage(result.data || result.text)
    if (response.status === 400 && /user id/i.test(message)) {
      const error = new Error(`This virtual key has no user_id. Generate a virtual key attached to a LiteLLM user so ${serverName} OAuth can be stored per user.`)
      error.code = 'missing_user_id'
      throw error
    }
    throw new Error(`${serverName} credential status failed (${response.status}): ${message}`)
  }

  return result.data || {}
}

async function getNotionStatus(virtualKey, serverId) {
  return await getOauthStatus(virtualKey, serverId, 'Notion')
}

function isOauthMcpServer(server) {
  const authType = String(server.auth_type || '').toLowerCase()
  const oauthFlow = String(server.oauth2_flow || '').toLowerCase()
  const name = getServerName(server).toLowerCase()
  const url = String(server.url || '').toLowerCase()
  return authType.includes('oauth') || Boolean(oauthFlow) || name.includes('notion') || url.includes('mcp.notion.com')
}

function oauthMcpInfo(server) {
  return {
    serverId: getServerId(server),
    serverName: getServerName(server) || getServerId(server),
    authType: String(server.auth_type || 'oauth2'),
    oauth2Flow: String(server.oauth2_flow || ''),
    url: String(server.url || ''),
  }
}

async function findOauthServer(virtualKey, serverId) {
  const servers = await fetchMcpServers(virtualKey)
  for (let i = 0; i < servers.length; i += 1) {
    const server = servers[i]
    if (getServerId(server) === serverId && isOauthMcpServer(server)) {
      return server
    }
  }
  throw new Error('OAuth MCP server is not visible to this virtual key.')
}

async function listOauthMcpServersWithStatus(virtualKey) {
  const servers = await fetchMcpServers(virtualKey)
  const result = []

  for (let i = 0; i < servers.length; i += 1) {
    const server = servers[i]
    if (!isOauthMcpServer(server)) {
      continue
    }

    const info = oauthMcpInfo(server)
    try {
      const status = await getOauthStatus(virtualKey, info.serverId, info.serverName)
      result.push({
        ...info,
        connected: Boolean(status.has_credential),
        expired: Boolean(status.is_expired),
        expiresAt: status.expires_at || null,
      })
    } catch (error) {
      result.push({
        ...info,
        connected: false,
        expired: false,
        error: error.message,
      })
    }
  }

  return result
}

async function deleteOauthCredential(virtualKey, serverId) {
  const upstream = await litellmFetch(`${litellmBaseUrl}/v1/mcp/server/${encodeURIComponent(serverId)}/oauth-user-credential`, {
    method: 'DELETE',
    headers: authHeaders(virtualKey),
  })
  const result = await readResponse(upstream)
  if (!upstream.ok) {
    throw new Error(`MCP logout failed (${upstream.status}): ${errorMessage(result.data || result.text)}`)
  }
  return result.data || {}
}

async function logoutOauthMcpServer(virtualKey, serverId) {
  const server = await findOauthServer(virtualKey, serverId)
  const name = getServerName(server) || serverId
  const status = await getOauthStatus(virtualKey, serverId, name)
  if (!status.has_credential) {
    return {
      serverId,
      serverName: name,
      loggedOut: false,
      alreadyDisconnected: true,
    }
  }

  await deleteOauthCredential(virtualKey, serverId)
  return {
    serverId,
    serverName: name,
    loggedOut: true,
    alreadyDisconnected: false,
  }
}

async function logoutOauthMcpServers(virtualKey) {
  const servers = await fetchMcpServers(virtualKey)
  const loggedOut = []
  const alreadyDisconnected = []

  for (let i = 0; i < servers.length; i += 1) {
    const server = servers[i]
    if (!isOauthMcpServer(server)) {
      continue
    }

    const serverId = getServerId(server)
    const serverName = getServerName(server) || serverId
    const statusResponse = await litellmFetch(`${litellmBaseUrl}/v1/mcp/server/${encodeURIComponent(serverId)}/oauth-user-credential/status`, {
      headers: authHeaders(virtualKey),
    })
    const statusResult = await readResponse(statusResponse)
    if (!statusResponse.ok) {
      throw new Error(`Could not check MCP credential for ${serverName} (${statusResponse.status}): ${errorMessage(statusResult.data || statusResult.text)}`)
    }

    if (!statusResult.data?.has_credential) {
      alreadyDisconnected.push(serverName)
      continue
    }

    await deleteOauthCredential(virtualKey, serverId)
    loggedOut.push(serverName)
  }

  return {
    loggedOut,
    alreadyDisconnected,
  }
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
    .mcp-auth-list { display: grid; gap: 8px; }
    .mcp-auth-row { display: grid; grid-template-columns: minmax(140px, 1fr) auto; gap: 8px; align-items: center; padding: 8px; border: 1px solid #e1e5ea; border-radius: 6px; }
    .mcp-auth-name { font-weight: 600; }
    .mcp-auth-meta { color: #6b7280; font-size: 12px; overflow-wrap: anywhere; }
    .hidden { display: none; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
    #output { min-height: 80px; }
    #activity { margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid #eceff2; color: #6b7280; font-size: 12px; }
    .muted { color: #6b7280; font-size: 12px; }
    @media (max-width: 700px) { .grid { grid-template-columns: 1fr; } .mcp-auth-row { grid-template-columns: 1fr; } }
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
      <h2>MCP authorization</h2>
      <div id="mcpAuthList" class="mcp-auth-list">
        <div class="mcp-auth-row" data-server-id="notion-pending">
          <div>
            <div class="mcp-auth-name">Notion</div>
            <div class="mcp-auth-meta">OAuth MCP configured by this local stack. Enter a virtual key to discover its server ID and status.</div>
          </div>
          <div class="row">
            <button class="mcp-login" data-server-id="" data-server-name="notion" disabled>Log in</button>
            <button class="mcp-logout" data-server-id="" disabled>Log out</button>
            <button class="mcp-status-check" data-server-id="" disabled>Check OAuth status</button>
            <span class="status">Key required</span>
          </div>
        </div>
      </div>
      <div id="mcpAuthHint" class="muted" style="margin-top:6px">OAuth controls stay visible regardless of login state or selected MCP tools.</div>
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
    </section>

    <section class="card">
      <h2>Response</h2>
      <pre id="activity" class="hidden"></pre>
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
    const activity = document.getElementById('activity')
    const keyStatus = document.getElementById('keyStatus')
    const mcpAuthList = document.getElementById('mcpAuthList')
    const mcpAuthHint = document.getElementById('mcpAuthHint')
    const sendButton = document.getElementById('send')
    let oauthMcps = []

    keyInput.value = sessionStorage.getItem('litellmVirtualKey') || ''

    keyInput.addEventListener('input', () => {
      sessionStorage.setItem('litellmVirtualKey', keyInput.value.trim())
      keyStatus.textContent = 'Not checked'
      keyStatus.className = 'status'
      renderOauthMcps([])
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

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }

    function statusText(mcp) {
      if (mcp.error) {
        return 'Error'
      }
      if (mcp.expired) {
        return 'Expired'
      }
      return mcp.connected ? 'Connected' : 'Not connected'
    }

    function statusClass(mcp) {
      if (mcp.error) {
        return 'status error'
      }
      return mcp.connected && !mcp.expired ? 'status ok' : 'status warn'
    }

    function renderOauthMcps(items) {
      oauthMcps = Array.isArray(items) ? items : []
      if (oauthMcps.length === 0) {
        mcpAuthList.innerHTML =
          '<div class="mcp-auth-row">' +
            '<div>' +
              '<div class="mcp-auth-name">Notion</div>' +
              '<div class="mcp-auth-meta">OAuth MCP configured by this local stack. Enter/check a virtual key to load OAuth status.</div>' +
            '</div>' +
            '<div class="row">' +
              '<button disabled>Log in</button>' +
              '<button disabled>Log out</button>' +
              '<button disabled>Check OAuth status</button>' +
              '<span class="status">Key required</span>' +
            '</div>' +
          '</div>'
        return
      }

      let html = ''
      for (let i = 0; i < oauthMcps.length; i += 1) {
        const mcp = oauthMcps[i]
        const details = [mcp.authType, mcp.oauth2Flow, mcp.url].filter(Boolean).join(' · ')
        const serverId = escapeHtml(mcp.serverId)
        html +=
          '<div class="mcp-auth-row" data-server-id="' + serverId + '">' +
            '<div>' +
              '<div class="mcp-auth-name">' + escapeHtml(mcp.serverName) + '</div>' +
              '<div class="mcp-auth-meta">' + escapeHtml(mcp.error || details || 'OAuth MCP') + '</div>' +
            '</div>' +
            '<div class="row">' +
              '<button class="mcp-login primary" data-server-id="' + serverId + '">Log in</button>' +
              '<button class="mcp-logout" data-server-id="' + serverId + '">Log out</button>' +
              '<button class="mcp-status-check" data-server-id="' + serverId + '">Check OAuth status</button>' +
              '<span class="' + statusClass(mcp) + '">' + statusText(mcp) + '</span>' +
            '</div>' +
          '</div>'
      }
      mcpAuthList.innerHTML = html
    }

    function updateOauthMcp(serverId, patch) {
      for (let i = 0; i < oauthMcps.length; i += 1) {
        if (oauthMcps[i].serverId === serverId) {
          oauthMcps[i] = { ...oauthMcps[i], ...patch }
          renderOauthMcps(oauthMcps)
          return
        }
      }
    }

    function findOauthMcpByName(name) {
      const lower = String(name || '').toLowerCase()
      for (let i = 0; i < oauthMcps.length; i += 1) {
        if (String(oauthMcps[i].serverName || '').toLowerCase().includes(lower)) {
          return oauthMcps[i]
        }
      }
      return null
    }

    function resetRunUi() {
      output.textContent = ''
      activity.textContent = ''
      activity.classList.add('hidden')
    }

    function addActivity(line) {
      activity.classList.remove('hidden')
      activity.textContent += (activity.textContent ? '\\n' : '') + line
    }

    async function refreshOauthMcps() {
      const virtualKey = key()
      if (!virtualKey) {
        renderOauthMcps([])
        return false
      }

      mcpAuthHint.textContent = 'Checking OAuth MCPs…'
      const { response, data } = await api('/api/mcp/auth-servers', { virtualKey })
      if (!response.ok) {
        mcpAuthHint.textContent = data.error || 'Could not load OAuth MCP servers.'
        return false
      }

      renderOauthMcps(data.servers || [])
      mcpAuthHint.textContent = oauthMcps.length > 0
        ? 'OAuth controls stay visible regardless of login state or selected MCP tools.'
        : 'No OAuth MCP servers are visible to this virtual key.'
      return true
    }

    async function checkOauthStatus(serverId) {
      const virtualKey = key()
      if (!virtualKey) {
        keyStatus.textContent = 'Enter a key'
        keyStatus.className = 'status warn'
        return false
      }

      updateOauthMcp(serverId, { error: null })
      const { response, data } = await api('/api/mcp/status', { virtualKey, serverId })
      if (!response.ok) {
        updateOauthMcp(serverId, {
          connected: false,
          expired: false,
          error: data.error || 'Could not check OAuth status.',
        })
        return false
      }

      updateOauthMcp(serverId, {
        connected: Boolean(data.connected),
        expired: Boolean(data.expired),
        expiresAt: data.expiresAt || null,
        error: null,
      })
      return Boolean(data.connected) && !Boolean(data.expired)
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
      if (Array.isArray(data.oauthMcps)) {
        renderOauthMcps(data.oauthMcps)
      } else {
        await refreshOauthMcps()
      }
    })

    mcpAuthList.addEventListener('click', async event => {
      const button = event.target.closest('button')
      if (!button || button.disabled) {
        return
      }

      const virtualKey = key()
      const serverId = button.dataset.serverId || ''
      if (!virtualKey || !serverId) {
        keyStatus.textContent = 'Enter/check a key first'
        keyStatus.className = 'status warn'
        return
      }

      if (button.classList.contains('mcp-status-check')) {
        button.disabled = true
        await checkOauthStatus(serverId)
        button.disabled = false
        return
      }

      if (button.classList.contains('mcp-logout')) {
        button.disabled = true
        const { response, data } = await api('/api/mcp/logout-one', { virtualKey, serverId })
        button.disabled = false
        if (!response.ok) {
          updateOauthMcp(serverId, { error: data.error || 'MCP logout failed' })
          return
        }
        updateOauthMcp(serverId, {
          connected: false,
          expired: false,
          error: null,
        })
        output.textContent = data.loggedOut
          ? (data.serverName || 'MCP') + ' OAuth credential removed from LiteLLM.'
          : (data.serverName || 'MCP') + ' had no stored OAuth credential.'
        return
      }

      if (button.classList.contains('mcp-login')) {
        button.disabled = true
        const { response, data } = await api('/api/mcp/login/start', { virtualKey, serverId })
        button.disabled = false
        if (!response.ok) {
          updateOauthMcp(serverId, { error: data.error || 'Could not start MCP login.' })
          return
        }

        const popup = window.open(data.loginUrl, 'mcpOAuth-' + serverId, 'width=720,height=760')
        if (!popup) {
          updateOauthMcp(serverId, { error: 'Popup blocked. Allow popups for this local page and try again.' })
          return
        }
        updateOauthMcp(serverId, {
          connected: false,
          expired: false,
          error: null,
        })
      }
    })

    window.addEventListener('message', async event => {
      if (event.origin !== location.origin || !event.data || event.data.type !== 'mcp-oauth-complete') {
        return
      }

      const serverId = event.data.serverId || ''
      if (!event.data.ok) {
        if (serverId) {
          updateOauthMcp(serverId, { error: event.data.error || 'MCP login failed.' })
        }
        return
      }

      if (serverId) {
        await checkOauthStatus(serverId)
      } else {
        await refreshOauthMcps()
      }
      output.textContent = (event.data.serverName || 'MCP') + ' login completed. The OAuth credential is stored in LiteLLM for this virtual-key user.'
    })

    async function runStreamingChat(body) {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Local helper request failed (' + response.status + ')')
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\\n')
        buffer = lines.pop() || ''

        for (let i = 0; i < lines.length; i += 1) {
          const line = lines[i].trim()
          if (!line) {
            continue
          }

          const event = JSON.parse(line)
          if (event.type === 'delta') {
            output.textContent += event.text || ''
          } else if (event.type === 'tool_call') {
            const args = event.arguments && Object.keys(event.arguments).length > 0
              ? ' ' + JSON.stringify(event.arguments)
              : ''
            addActivity('→ ' + event.name + args)
          } else if (event.type === 'tool_result') {
            addActivity('✓ ' + event.name + (event.summary ? ' — ' + event.summary : ''))
          } else if (event.type === 'status') {
            addActivity(event.text || 'Working…')
          } else if (event.type === 'auth_required') {
            await refreshOauthMcps()
            throw new Error(event.error || 'MCP authentication required. Use the MCP authorization controls above.')
          } else if (event.type === 'error') {
            throw new Error(event.error || 'Request failed')
          }
        }
      }

      if (buffer.trim()) {
        const event = JSON.parse(buffer)
        if (event.type === 'delta') {
          output.textContent += event.text || ''
        } else if (event.type === 'error') {
          throw new Error(event.error || 'Request failed')
        }
      }
    }

    sendButton.addEventListener('click', async () => {
      const virtualKey = key()
      const prompt = promptInput.value.trim()
      if (!virtualKey || !prompt) {
        output.textContent = 'Enter both a virtual key and a prompt.'
        return
      }

      if (mcpScope.value === 'notion') {
        let notion = findOauthMcpByName('notion')
        if (!notion) {
          await refreshOauthMcps()
          notion = findOauthMcpByName('notion')
        }
        if (notion && (!notion.connected || notion.expired || notion.error)) {
          const connected = await checkOauthStatus(notion.serverId)
          if (!connected) {
            output.textContent = 'Notion authentication is required before this request can use Notion tools. Use Log in in MCP authorization above.'
            return
          }
        }
      }

      sendButton.disabled = true
      resetRunUi()
      addActivity('Starting…')

      try {
        await runStreamingChat({
          virtualKey,
          model: modelInput.value.trim(),
          prompt,
          mcpScope: mcpScope.value,
        })
        if (!output.textContent) {
          output.textContent = 'Completed without a text response.'
        }
      } catch (error) {
        if (!output.textContent) {
          output.textContent = error.message || String(error)
        } else {
          addActivity('Error: ' + (error.message || String(error)))
        }
      } finally {
        sendButton.disabled = false
      }
    })

    if (key()) {
      void refreshOauthMcps()
    }
  </script>
</body>
</html>`
}
function oauthResultHtml(ok, message, serverId = '', serverName = 'MCP') {
  const payload = JSON.stringify({
    type: 'mcp-oauth-complete',
    ok,
    serverId,
    serverName,
    error: ok ? undefined : message,
  }).replace(/</g, '\u003c')
  const safeMessage = String(message || (ok ? `${serverName} connected.` : `${serverName} login failed.`))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${serverName} OAuth</title></head>
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

  const modelsResponse = await litellmFetch(`${litellmBaseUrl}/v1/models`, {
    headers: authHeaders(virtualKey),
  })
  const modelsResult = await readResponse(modelsResponse)
  if (!modelsResponse.ok) {
    sendJson(response, modelsResponse.status, {
      error: `Virtual key check failed: ${errorMessage(modelsResult.data || modelsResult.text)}`,
    })
    return
  }

  const oauthMcps = await listOauthMcpServersWithStatus(virtualKey)
  let notion = null
  for (let i = 0; i < oauthMcps.length; i += 1) {
    if (String(oauthMcps[i].serverName || '').toLowerCase().includes('notion')) {
      notion = {
        configured: true,
        connected: Boolean(oauthMcps[i].connected),
        expired: Boolean(oauthMcps[i].expired),
        serverId: oauthMcps[i].serverId,
        error: oauthMcps[i].error || null,
      }
      break
    }
  }

  sendJson(response, 200, {
    ok: true,
    notion,
    oauthMcps,
    models: modelsResult.data,
  })
}

async function handleOauthServers(request, response) {
  const body = await readJson(request)
  const virtualKey = normalizeKey(body.virtualKey)
  if (!virtualKey) {
    sendJson(response, 400, { error: 'Virtual key is required.' })
    return
  }

  try {
    const servers = await listOauthMcpServersWithStatus(virtualKey)
    sendJson(response, 200, { servers })
  } catch (error) {
    sendJson(response, error.code === 'missing_user_id' ? 400 : 502, { error: error.message })
  }
}

async function handleOauthStatus(request, response) {
  const body = await readJson(request)
  const virtualKey = normalizeKey(body.virtualKey)
  const serverId = String(body.serverId || '')
  if (!virtualKey || !serverId) {
    sendJson(response, 400, { error: 'Virtual key and serverId are required.' })
    return
  }

  try {
    const server = await findOauthServer(virtualKey, serverId)
    const serverName = getServerName(server) || serverId
    const status = await getOauthStatus(virtualKey, serverId, serverName)
    sendJson(response, 200, {
      connected: Boolean(status.has_credential),
      expired: Boolean(status.is_expired),
      expiresAt: status.expires_at || null,
      serverId,
      serverName,
    })
  } catch (error) {
    sendJson(response, error.code === 'missing_user_id' ? 400 : 502, { error: error.message })
  }
}

async function handleMcpLogoutOne(request, response) {
  const body = await readJson(request)
  const virtualKey = normalizeKey(body.virtualKey)
  const serverId = String(body.serverId || '')
  if (!virtualKey || !serverId) {
    sendJson(response, 400, { error: 'Virtual key and serverId are required.' })
    return
  }

  try {
    const result = await logoutOauthMcpServer(virtualKey, serverId)
    sendJson(response, 200, { ok: true, ...result })
  } catch (error) {
    sendJson(response, error.code === 'missing_user_id' ? 400 : 502, { error: error.message })
  }
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

async function handleMcpLogout(request, response) {
  const body = await readJson(request)
  const virtualKey = normalizeKey(body.virtualKey)
  if (!virtualKey) {
    sendJson(response, 400, { error: 'Virtual key is required.' })
    return
  }

  try {
    const result = await logoutOauthMcpServers(virtualKey)
    sendJson(response, 200, {
      ok: true,
      ...result,
    })
  } catch (error) {
    sendJson(response, error.code === 'missing_user_id' ? 400 : 502, { error: error.message })
  }
}

function sendStreamHeaders(response) {
  response.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
}

function writeStreamEvent(response, type, value = {}) {
  response.write(`${JSON.stringify({ type, ...value })}\n`)
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function mergeObject(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return target
  }

  const keys = Object.keys(source)
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i]
    const value = source[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] = mergeObject(target[key] && typeof target[key] === 'object' ? target[key] : {}, value)
    } else if (value !== undefined) {
      target[key] = value
    }
  }
  return target
}

function mergeStreamFragment(current, next) {
  const left = String(current || '')
  const right = String(next || '')
  if (!right) {
    return left
  }
  if (!left) {
    return right
  }

  // Some providers stream fragments, while others repeat the full accumulated
  // value in later chunks. Handle both without producing name/name or duplicated
  // JSON arguments.
  if (right === left || left.endsWith(right)) {
    return left
  }
  if (right.startsWith(left)) {
    return right
  }

  // Find the largest overlap between the end of the current value and the
  // beginning of the next value before falling back to ordinary concatenation.
  const maxOverlap = Math.min(left.length, right.length)
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (left.slice(-size) === right.slice(0, size)) {
      return left + right.slice(size)
    }
  }

  return left + right
}

function appendToolCallDelta(toolCalls, delta) {
  const index = Number.isInteger(delta.index) ? delta.index : toolCalls.length
  let entry = toolCalls[index]
  if (!entry) {
    entry = {
      index,
      id: '',
      type: 'function',
      function: {
        name: '',
        arguments: '',
      },
    }
    toolCalls[index] = entry
  }

  if (delta.id) {
    entry.id = mergeStreamFragment(entry.id, delta.id)
  }
  if (delta.type) {
    entry.type = delta.type
  }
  if (delta.function?.name) {
    entry.function.name = mergeStreamFragment(entry.function.name, delta.function.name)
  }
  if (delta.function?.arguments) {
    entry.function.arguments = mergeStreamFragment(entry.function.arguments, delta.function.arguments)
  }
  if (delta.provider_specific_fields) {
    entry.provider_specific_fields = mergeObject(entry.provider_specific_fields || {}, delta.provider_specific_fields)
  }
}

async function streamCompletion(virtualKey, payload, response) {
  const upstream = await litellmFetch(`${litellmBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      ...authHeaders(virtualKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...payload,
      stream: true,
      stream_options: {
        include_usage: true,
      },
    }),
  })

  if (!upstream.ok) {
    const result = await readResponse(upstream)
    const value = result.data || result.text
    const error = new Error(`LiteLLM request failed (${upstream.status}): ${errorMessage(value)}`)
    error.status = upstream.status
    error.authRequired = isMcpAuthError(upstream.status, value)
    throw error
  }

  if (!upstream.body) {
    throw new Error('LiteLLM returned no streaming response body.')
  }

  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const toolCalls = []
  let buffer = ''
  let content = ''
  let finishReason = null

  function processLine(line) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('data:')) {
      return
    }

    const dataText = trimmed.slice(5).trim()
    if (!dataText || dataText === '[DONE]') {
      return
    }

    const chunk = JSON.parse(dataText)
    const choice = chunk.choices?.[0]
    if (!choice) {
      return
    }

    const delta = choice.delta || {}
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content
      writeStreamEvent(response, 'delta', { text: delta.content })
    }

    const deltaToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
    for (let i = 0; i < deltaToolCalls.length; i += 1) {
      appendToolCallDelta(toolCalls, deltaToolCalls[i])
    }

    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      finishReason = choice.finish_reason
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (let i = 0; i < lines.length; i += 1) {
      processLine(lines[i])
    }
  }

  buffer += decoder.decode()
  if (buffer.trim()) {
    processLine(buffer)
  }

  const completedToolCalls = toolCalls.filter(Boolean).map(toolCall => {
    const { index, ...value } = toolCall
    return value
  })

  return {
    finishReason,
    message: {
      role: 'assistant',
      content: content || null,
      ...(completedToolCalls.length > 0 ? { tool_calls: completedToolCalls } : {}),
    },
  }
}

async function fetchMcpTools(virtualKey, serverId) {
  const url = new URL(`${litellmBaseUrl}/mcp-rest/tools/list`)
  url.searchParams.set('server_id', serverId)
  const upstream = await litellmFetch(url, {
    headers: authHeaders(virtualKey),
  })
  const result = await readResponse(upstream)
  if (!upstream.ok) {
    const error = new Error(`MCP tool list failed (${upstream.status}): ${errorMessage(result.data || result.text)}`)
    error.status = upstream.status
    error.authRequired = isMcpAuthError(upstream.status, result.data || result.text)
    throw error
  }

  const tools = Array.isArray(result.data?.tools)
    ? result.data.tools
    : Array.isArray(result.data)
      ? result.data
      : []
  return tools
}

function serverMatchesScope(server, mcpScope) {
  if (mcpScope === 'all') {
    return true
  }

  const name = getServerName(server).toLowerCase()
  const url = String(server.url || '').toLowerCase()
  if (mcpScope === 'notion') {
    return name.includes('notion') || url.includes('mcp.notion.com')
  }
  if (mcpScope === 'example') {
    return name.includes('example') || url.includes('example-mcp')
  }
  return false
}

function collapseRepeatedToolName(value) {
  let result = String(value || '').trim()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (result.length < 2 || result.length % 2 !== 0) {
      break
    }
    const half = result.length / 2
    if (result.slice(0, half) !== result.slice(half)) {
      break
    }
    result = result.slice(0, half)
  }
  return result
}

function normalizeToolName(value) {
  return collapseRepeatedToolName(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/_/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function stripServerPrefixes(value, serverName) {
  let result = normalizeToolName(value)
  const prefix = normalizeToolName(serverName)
  if (!prefix) {
    return result
  }
  while (result.startsWith(`${prefix}-`)) {
    result = result.slice(prefix.length + 1)
  }
  return result
}

function scoreToolName(exposedName, server, toolName) {
  const exposed = normalizeToolName(exposedName)
  const tool = normalizeToolName(toolName)
  const serverName = normalizeToolName(getServerName(server))
  if (!exposed || !tool) {
    return 0
  }

  if (exposed === tool) {
    return 100000 + tool.length
  }

  const prefixed = serverName ? `${serverName}-${tool}` : tool
  if (exposed === prefixed) {
    return 90000 + tool.length
  }

  const exposedBase = stripServerPrefixes(exposed, serverName)
  const toolBase = stripServerPrefixes(tool, serverName)
  if (exposedBase === toolBase) {
    return 80000 + tool.length
  }

  if (exposed.endsWith(`-${tool}`) || tool.endsWith(`-${exposed}`)) {
    return 70000 + Math.min(exposed.length, tool.length)
  }

  if (exposedBase.endsWith(`-${toolBase}`) || toolBase.endsWith(`-${exposedBase}`)) {
    return 60000 + Math.min(exposedBase.length, toolBase.length)
  }

  return 0
}

async function resolveToolTarget(virtualKey, mcpScope, exposedName) {
  const servers = await fetchMcpServers(virtualKey)
  let candidates = servers.filter(server => serverMatchesScope(server, mcpScope))
  const prefix = exposedName.split('-')[0].toLowerCase()

  if (mcpScope === 'all' && prefix) {
    const prefixMatches = candidates.filter(server => {
      const serverName = getServerName(server).toLowerCase()
      const url = String(server.url || '').toLowerCase()
      return serverName.includes(prefix) || url.includes(prefix)
    })
    if (prefixMatches.length > 0) {
      candidates = prefixMatches
    }
  }

  const matches = []
  let lastError = null
  for (let i = 0; i < candidates.length; i += 1) {
    const server = candidates[i]
    const serverId = getServerId(server)
    let tools
    try {
      tools = await fetchMcpTools(virtualKey, serverId)
    } catch (error) {
      lastError = error
      if (error.authRequired && candidates.length === 1) {
        throw error
      }
      continue
    }

    for (let j = 0; j < tools.length; j += 1) {
      const tool = tools[j]
      const name = String(tool.name || tool.function?.name || '')
      if (!name) {
        continue
      }

      const score = scoreToolName(exposedName, server, name)
      if (score > 0) {
        matches.push({ server, serverId, name, score })
      }
    }
  }

  matches.sort((a, b) => b.score - a.score)
  if (matches.length > 0 && (matches.length === 1 || matches[0].score > matches[1].score)) {
    return matches[0]
  }

  if (lastError && matches.length === 0) {
    throw lastError
  }
  throw new Error(`Could not map MCP tool '${collapseRepeatedToolName(exposedName)}' to a configured server/tool.`)
}

function parseToolArguments(toolCall) {
  const value = toolCall.function?.arguments || '{}'
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    throw new Error(`Invalid arguments for ${toolCall.function?.name || 'MCP tool'}: ${value}`)
  }
}

async function callMcpTool(virtualKey, target, argumentsValue) {
  const upstream = await litellmFetch(`${litellmBaseUrl}/mcp-rest/tools/call`, {
    method: 'POST',
    headers: {
      ...authHeaders(virtualKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      server_id: target.serverId,
      name: target.name,
      arguments: argumentsValue || {},
    }),
  })
  const result = await readResponse(upstream)
  if (!upstream.ok) {
    const value = result.data || result.text
    const error = new Error(`MCP tool '${target.name}' failed (${upstream.status}): ${errorMessage(value)}`)
    error.status = upstream.status
    error.authRequired = isMcpAuthError(upstream.status, value)
    throw error
  }

  return result.data ?? result.text
}

function findAsyncState(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) {
    return null
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
      return null
    }
    try {
      return findAsyncState(JSON.parse(trimmed), depth + 1)
    } catch (error) {
      return null
    }
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const found = findAsyncState(value[i], depth + 1)
      if (found) {
        return found
      }
    }
    return null
  }

  if (typeof value !== 'object') {
    return null
  }

  const status = typeof value.status === 'string' ? value.status.toLowerCase() : ''
  if (['queued', 'running', 'retrying', 'succeeded', 'failed'].includes(status)) {
    return {
      status,
      pollAfterSeconds: Number(value.poll_after_seconds) || 0,
    }
  }

  const priorityKeys = ['result', 'data', 'content', 'text']
  for (let i = 0; i < priorityKeys.length; i += 1) {
    const key = priorityKeys[i]
    if (value[key] !== undefined) {
      const found = findAsyncState(value[key], depth + 1)
      if (found) {
        return found
      }
    }
  }

  const keys = Object.keys(value)
  for (let i = 0; i < keys.length; i += 1) {
    const found = findAsyncState(value[keys[i]], depth + 1)
    if (found) {
      return found
    }
  }
  return null
}

function summarizeToolResult(result) {
  const asyncState = findAsyncState(result)
  if (asyncState) {
    return asyncState.status
  }

  if (result && typeof result === 'object' && result.isError === true) {
    return 'tool error'
  }
  return 'done'
}

async function executeToolCall(virtualKey, mcpScope, toolCall, response) {
  const exposedName = String(toolCall.function?.name || '')
  const target = await resolveToolTarget(virtualKey, mcpScope, exposedName)
  const argumentsValue = parseToolArguments(toolCall)

  writeStreamEvent(response, 'tool_call', {
    name: collapseRepeatedToolName(exposedName),
    arguments: argumentsValue,
  })

  let result = await callMcpTool(virtualKey, target, argumentsValue)
  const isAsyncPoll = /get[-_]async[-_]task/i.test(exposedName)
  if (isAsyncPoll) {
    const deadline = Date.now() + 90 * 1000
    while (Date.now() < deadline) {
      const state = findAsyncState(result)
      if (!state || !['queued', 'running', 'retrying'].includes(state.status)) {
        break
      }

      const waitMs = Math.max(500, Math.min(10000, Math.round((state.pollAfterSeconds || 1) * 1000)))
      writeStreamEvent(response, 'status', {
        text: `Notion async task ${state.status}; polling again in ${(waitMs / 1000).toFixed(1)}s…`,
      })
      await sleep(waitMs)
      result = await callMcpTool(virtualKey, target, argumentsValue)
    }
  }

  writeStreamEvent(response, 'tool_result', {
    name: collapseRepeatedToolName(exposedName),
    summary: summarizeToolResult(result),
  })

  return result
}

function createMcpToolDefinition(mcpScope) {
  if (mcpScope === 'none') {
    return null
  }

  let serverUrl = 'litellm_proxy'
  if (mcpScope === 'notion') {
    serverUrl = 'litellm_proxy/mcp/notion'
  } else if (mcpScope === 'example') {
    serverUrl = 'litellm_proxy/mcp/example'
  }

  return {
    type: 'mcp',
    server_label: mcpScope === 'all' ? 'litellm' : mcpScope,
    server_url: serverUrl,
    require_approval: 'never',
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

  sendStreamHeaders(response)

  try {
    if (mcpScope === 'notion') {
      const server = await findNotionServer(virtualKey)
      const status = await getNotionStatus(virtualKey, getServerId(server))
      if (!status.has_credential || status.is_expired) {
        writeStreamEvent(response, 'auth_required', {
          error: status.is_expired
            ? 'Notion OAuth credential is expired. Log in to Notion again.'
            : 'Notion login is required for this virtual-key user.',
          mcp: 'notion',
        })
        response.end()
        return
      }
    }

    const messages = [
      {
        role: 'system',
        content: [
          'You are an interactive assistant with access to the MCP tools supplied with this request.',
          'Use tools whenever they are useful, and continue after every tool result until the task is complete.',
          'After tool use, always produce a user-visible natural-language answer instead of ending with an empty response.',
          'When the user asks which tools are available, summarize the tool capabilities you can see.',
        ].join(' '),
      },
      {
        role: 'user',
        content: prompt,
      },
    ]
    const mcpTool = createMcpToolDefinition(mcpScope)
    const maxRounds = 12
    let emptyResponseRetries = 0

    for (let round = 1; round <= maxRounds; round += 1) {
      writeStreamEvent(response, 'status', {
        text: round === 1 ? 'Calling model…' : `Continuing conversation (round ${round})…`,
      })

      const payload = {
        model,
        messages,
      }
      if (mcpTool) {
        payload.tools = [mcpTool]
      }

      const completion = await streamCompletion(virtualKey, payload, response)
      const toolCalls = Array.isArray(completion.message.tool_calls) ? completion.message.tool_calls : []
      if (toolCalls.length === 0) {
        if (typeof completion.message.content === 'string' && completion.message.content.trim()) {
          writeStreamEvent(response, 'done', {
            rounds: round,
            finishReason: completion.finishReason,
          })
          response.end()
          return
        }

        if (emptyResponseRetries < 1) {
          emptyResponseRetries += 1
          writeStreamEvent(response, 'status', {
            text: 'Model returned no visible text; asking it to finish the answer…',
          })
          messages.push({
            role: 'system',
            content: 'The previous model turn ended without visible text. Continue the original task and return a concrete user-visible answer. Do not stop with an empty response.',
          })
          continue
        }

        writeStreamEvent(response, 'error', {
          error: 'The model completed twice without returning text or a tool call.',
        })
        response.end()
        return
      }

      emptyResponseRetries = 0
      messages.push(completion.message)
      for (let i = 0; i < toolCalls.length; i += 1) {
        const toolCall = toolCalls[i]
        const result = await executeToolCall(virtualKey, mcpScope, toolCall, response)
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        })
      }
    }

    writeStreamEvent(response, 'error', {
      error: `Stopped after ${maxRounds} model/tool rounds to avoid an infinite tool loop.`,
    })
    response.end()
  } catch (error) {
    if (error.authRequired) {
      writeStreamEvent(response, 'auth_required', {
        error: error.message || String(error),
      })
    } else {
      writeStreamEvent(response, 'error', {
        error: error.message || String(error),
      })
    }
    response.end()
  }
}
async function handleMcpLoginStart(request, response) {
  cleanupOauth()
  const body = await readJson(request)
  const virtualKey = normalizeKey(body.virtualKey)
  const serverId = String(body.serverId || '')
  if (!virtualKey || !serverId) {
    sendJson(response, 400, { error: 'Virtual key and serverId are required.' })
    return
  }

  try {
    const server = await findOauthServer(virtualKey, serverId)
    const serverName = getServerName(server) || serverId
    await getOauthStatus(virtualKey, serverId, serverName)

    const redirectUri = `${publicOrigin}/oauth/callback`
    const routeName = encodeURIComponent(serverName)
    const registerResponse = await litellmFetch(`${litellmBaseUrl}/${routeName}/register`, {
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
      throw new Error(`${serverName} MCP client registration failed (${registerResponse.status}): ${errorMessage(registerResult.data || registerResult.text)}`)
    }

    const clientId = registerResult.data?.client_id
    const clientSecret = registerResult.data?.client_secret || ''
    if (!clientId) {
      throw new Error(`${serverName} MCP registration did not return a client_id.`)
    }

    const state = base64Url(crypto.randomBytes(24))
    const pkce = createPkce()
    pendingOauth.set(state, {
      virtualKey,
      serverId,
      serverName,
      routeName,
      clientId,
      clientSecret,
      redirectUri,
      codeVerifier: pkce.verifier,
      createdAt: Date.now(),
    })

    const loginUrl = new URL(`${litellmPublicUrl}/${routeName}/authorize`)
    loginUrl.searchParams.set('response_type', 'code')
    loginUrl.searchParams.set('client_id', clientId)
    loginUrl.searchParams.set('redirect_uri', redirectUri)
    loginUrl.searchParams.set('state', state)
    loginUrl.searchParams.set('code_challenge', pkce.challenge)
    loginUrl.searchParams.set('code_challenge_method', 'S256')

    sendJson(response, 200, {
      loginUrl: loginUrl.toString(),
      serverId,
      serverName,
    })
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
    sendHtml(response, 400, oauthResultHtml(false, oauthDescription || oauthError, entry?.serverId || '', entry?.serverName || 'MCP'))
    return
  }

  if (!entry || !code) {
    sendHtml(response, 400, oauthResultHtml(false, 'OAuth callback is missing or expired. Start the MCP login again.'))
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

    const tokenResponse = await litellmFetch(`${litellmBaseUrl}/${entry.routeName || encodeURIComponent(entry.serverName)}/token`, {
      method: 'POST',
      headers: {
        ...mcpAuthHeaders(entry.virtualKey),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    })
    const tokenResult = await readResponse(tokenResponse)
    if (!tokenResponse.ok) {
      throw new Error(`${entry.serverName} token exchange failed (${tokenResponse.status}): ${errorMessage(tokenResult.data || tokenResult.text)}`)
    }

    const token = tokenResult.data || {}
    if (!token.access_token) {
      throw new Error(`${entry.serverName} token exchange returned no access_token.`)
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

    const storeResponse = await litellmFetch(`${litellmBaseUrl}/v1/mcp/server/${encodeURIComponent(entry.serverId)}/oauth-user-credential`, {
      method: 'POST',
      headers: {
        ...authHeaders(entry.virtualKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(storePayload),
    })
    const storeResult = await readResponse(storeResponse)
    if (!storeResponse.ok) {
      throw new Error(`LiteLLM could not store the ${entry.serverName} credential (${storeResponse.status}): ${errorMessage(storeResult.data || storeResult.text)}`)
    }

    sendHtml(response, 200, oauthResultHtml(true, `${entry.serverName} connected. You can close this window.`, entry.serverId, entry.serverName))
  } catch (error) {
    sendHtml(response, 502, oauthResultHtml(false, error.message, entry.serverId, entry.serverName))
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

    if (request.method === 'POST' && url.pathname === '/api/mcp/auth-servers') {
      await handleOauthServers(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/mcp/status') {
      await handleOauthStatus(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/mcp/logout-one') {
      await handleMcpLogoutOne(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/notion/status') {
      await handleNotionStatus(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/mcp/logout') {
      await handleMcpLogout(request, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/mcp/login/start') {
      await handleMcpLoginStart(request, response)
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
