'use strict'

const http = require('http')

const port = Number(process.env.PORT || 3000)
const serverInfo = {
  name: 'example-mcp',
  version: '1.0.0',
}

const tools = [
  {
    name: 'echo',
    title: 'Echo text',
    description: 'Return the supplied text unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to echo back.',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'add',
    title: 'Add numbers',
    description: 'Add two numbers and return the result.',
    inputSchema: {
      type: 'object',
      properties: {
        a: {
          type: 'number',
        },
        b: {
          type: 'number',
        },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    },
  },
]

function jsonRpcResult(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  }
}

function jsonRpcError(id, code, message, data) {
  const error = {
    code,
    message,
  }

  if (data !== undefined) {
    error.data = data
  }

  return {
    jsonrpc: '2.0',
    id: id === undefined ? null : id,
    error,
  }
}

function toolResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value),
      },
    ],
    structuredContent: value,
  }
}

function handleMessage(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return jsonRpcError(message?.id, -32600, 'Invalid Request')
  }

  const { id, method, params = {} } = message
  const isNotification = id === undefined

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return null
  }

  if (method === 'initialize') {
    const protocolVersion = typeof params.protocolVersion === 'string'
      ? params.protocolVersion
      : '2025-11-25'

    return jsonRpcResult(id, {
      protocolVersion,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo,
    })
  }

  // MCP 2026 clients may probe a server without the older initialize handshake.
  if (method === 'server/discover') {
    return jsonRpcResult(id, {
      protocolVersions: ['2026-07-28', '2025-11-25'],
      capabilities: {
        tools: {},
      },
      serverInfo,
    })
  }

  if (method === 'ping') {
    return jsonRpcResult(id, {})
  }

  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools })
  }

  if (method === 'tools/call') {
    const name = params.name
    const args = params.arguments || {}

    if (name === 'echo') {
      if (typeof args.text !== 'string') {
        return jsonRpcResult(id, {
          ...toolResult({ error: 'text must be a string' }),
          isError: true,
        })
      }

      return jsonRpcResult(id, toolResult({ text: args.text }))
    }

    if (name === 'add') {
      if (typeof args.a !== 'number' || typeof args.b !== 'number') {
        return jsonRpcResult(id, {
          ...toolResult({ error: 'a and b must be numbers' }),
          isError: true,
        })
      }

      return jsonRpcResult(id, toolResult({ result: args.a + args.b }))
    }

    return jsonRpcResult(id, {
      ...toolResult({ error: `Unknown tool: ${String(name)}` }),
      isError: true,
    })
  }

  if (isNotification) {
    return null
  }

  return jsonRpcError(id, -32601, 'Method not found', { method })
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  response.end(body)
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { status: 'ok' })
    return
  }

  if (request.method !== 'POST' || request.url !== '/mcp') {
    sendJson(response, 404, { error: 'Not found' })
    return
  }

  let body = ''

  request.setEncoding('utf8')
  request.on('data', chunk => {
    body += chunk

    if (body.length > 1024 * 1024) {
      response.writeHead(413)
      response.end()
      request.destroy()
    }
  })

  request.on('end', () => {
    if (response.writableEnded) {
      return
    }

    let payload
    try {
      payload = JSON.parse(body)
    } catch (error) {
      sendJson(response, 400, jsonRpcError(null, -32700, 'Parse error'))
      return
    }

    if (Array.isArray(payload)) {
      const results = []
      for (let i = 0; i < payload.length; i += 1) {
        const result = handleMessage(payload[i])
        if (result !== null) {
          results.push(result)
        }
      }

      if (results.length === 0) {
        response.writeHead(202)
        response.end()
        return
      }

      sendJson(response, 200, results)
      return
    }

    const result = handleMessage(payload)
    if (result === null) {
      response.writeHead(202)
      response.end()
      return
    }

    sendJson(response, 200, result)
  })
})

server.listen(port, '0.0.0.0', () => {
  process.stderr.write(`example-mcp listening on http://0.0.0.0:${port}/mcp\n`)
})
