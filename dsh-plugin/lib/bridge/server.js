import http from 'node:http'
import { complete, renderSystem, summarizeMemory } from './model.js'
import { pickDelay, splitSegments } from './reply.js'

const MAX_BODY = 256 * 1024

export function createBridgeServer({ store, getLlm, logger }) {
  const hits = []
  const started = Date.now()

  const rateLimited = () => {
    const limit = Math.max(1, Number(store.config.rateLimitPerMinute) || 12)
    const now = Date.now()
    while (hits.length && now - hits[0] > 60_000) hits.shift()
    if (hits.length >= limit) return true
    hits.push(now)
    return false
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    try {
      if (!authorized(req, store.config.token)) {
        return send(res, 401, { type: 'error', code: 'UNAUTHORIZED', message: '缺少或错误的 token' })
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = `${req.method} ${url.pathname}`

      if (route === 'POST /api/message') {
        const body = await readJson(req)
        const result = await handleMessage(body)
        return send(res, 200, result)
      }
      if (route === 'POST /api/heartbeat') {
        return send(res, 200, { type: 'heartbeat.ack', timestamp: Math.floor(Date.now() / 1000) })
      }
      if (route === 'GET /api/health') {
        return send(res, 200, {
          status: 'ok',
          uptime: Math.floor((Date.now() - started) / 1000),
          connections: 1,
          sessions: store.sessions.size,
          paused: Boolean(store.config.paused),
          model: `${store.config.provider}/${store.config.model}`,
        })
      }
      if (route === 'GET /api/sessions') {
        return send(res, 200, { sessions: store.listSessions() })
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/sessions/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/sessions/'.length))
        await store.deleteSession(id)
        return send(res, 200, { status: 'deleted', id })
      }
      if (route === 'POST /api/log') {
        const body = await readJson(req)
        const lines = Array.isArray(body.lines) ? body.lines.slice(0, 200) : []
        for (const line of lines) logger.info('module', { line: String(line).slice(0, 800) })
        return send(res, 200, { status: 'logged', count: lines.length })
      }
      if (route === 'POST /api/reload') {
        await store.reloadWhitelist()
        return send(res, 200, { status: 'reloaded', whitelist: store.whitelist })
      }
      if (route === 'GET /api/config') {
        const { token: _token, ...safe } = store.config
        return send(res, 200, { config: safe, whitelist: store.whitelist })
      }
      return send(res, 404, { type: 'error', code: 'NOT_FOUND', message: `未知路径 ${url.pathname}` })
    } catch (error) {
      logger.error('request failed', { message: error?.message, code: error?.code })
      return send(res, 200, {
        type: 'error',
        code: error?.code || 'INTERNAL',
        message: error?.message || '桥接服务出错',
      })
    }
  })

  async function handleMessage(msg) {
    if (!msg || msg.type !== 'message.in') {
      return fail('INVALID_MSG', '缺少 message.in', msg?.msgId)
    }
    if (store.config.paused) {
      return fail('PAUSED', '桥接已暂停', msg.msgId)
    }
    await store.maybeReloadWhitelist()
    if (store.isDuplicate(msg.msgId)) {
      return fail('DUPLICATE', '重复消息', msg.msgId)
    }
    const verdict = store.allowed(msg)
    if (!verdict.ok) {
      logger.info('denied', { sessionId: msg.sessionId, reason: verdict.reason })
      return fail(verdict.reason, '该聊天不在允许范围内', msg.msgId)
    }
    if (rateLimited()) {
      return fail('RATE_LIMITED', '触发限速', msg.msgId)
    }
    const llm = getLlm()
    if (!llm?.stream) {
      return fail('DSH_UNAVAILABLE', '模型服务还没就绪', msg.msgId)
    }

    const sessionId = String(msg.sessionId || msg.sender?.id || 'unknown')
    const session = store.session(sessionId, msg.sender?.remark || msg.sender?.name)
    store.appendTurn(sessionId, 'user', String(msg.content ?? ''))

    const turns = [
      ...(session.history ?? []).slice(-Math.max(2, Number(store.config.historyTurns) || 10)).map((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
    ]

    const memory = await store.getMemory(sessionId)

    let text = ''
    try {
      const result = await complete(llm, {
        system: renderSystem(store.persona ?? store.config.persona, msg, session.summary, memory),
        turns,
        provider: store.config.provider,
        model: store.config.model,
        maxTokens: store.config.maxTokens,
      })
      text = result.text
    } catch (error) {
      logger.error('model failed', { message: error?.message, code: error?.code })
      return fail('MODEL_ERROR', error?.message || '模型调用失败', msg.msgId)
    }

    // 记忆整理：每 5 条对话跑一次，后台进行，失败不影响回复
    const memoryTurn = store.bumpMemoryCounter(sessionId)
    if (memoryTurn % 5 === 0) {
      summarizeMemory(llm, {
        previous: memory,
        turns: [...(session.history ?? [])],
        provider: store.config.provider,
        model: store.config.model,
      })
        .then((next) => {
          if (next && next !== memory) {
            store.saveMemory(sessionId, next)
            logger.info('memory updated', { sessionId, chars: next.length })
          }
        })
        .catch((error) => logger.error('memory failed', { message: error?.message }))
    }

    if (!text) {
      return {
        status: 'accepted',
        msgId: msg.msgId,
        reply: { type: 'reply.out', msgId: msg.msgId, sessionId, segments: [], delayMs: 0, segmentDelayMs: 0 },
      }
    }

    const segments = splitSegments(text, store.config.segments?.maxLen, store.config.segments?.max)
    const delayMs = pickDelay(store.config.segments?.firstDelayMs, segments[0]?.length ?? 0)
    const segmentDelayMs = pickDelay(store.config.segments?.segmentDelayMs, 0)
    store.appendTurn(sessionId, 'assistant', text)
    logger.info('replied', { sessionId, segments: segments.length, chars: text.length })

    return {
      status: 'accepted',
      msgId: msg.msgId,
      reply: {
        type: 'reply.out',
        msgId: msg.msgId,
        sessionId,
        segments,
        delayMs,
        segmentDelayMs,
        persona: store.config.persona?.name ?? 'default',
      },
      usageChars: text.length,
    }
  }

  return server
}

function fail(code, message, msgId) {
  return { type: 'error', code, message, msgId }
}

function send(res, status, value) {
  res.statusCode = status
  res.end(JSON.stringify(value))
}

function authorized(req, token) {
  if (!token) return true
  const header = req.headers.authorization ?? ''
  return header === `Bearer ${token}`
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw Object.assign(new Error('请求体太大'), { code: 'INVALID_MSG' })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('JSON 解析失败'), { code: 'INVALID_MSG' })
  }
}
