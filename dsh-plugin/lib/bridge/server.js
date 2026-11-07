import http from 'node:http'
import { complete, renderSystem, summarizeMemory } from './model.js'
import { completeVision } from './vision.js'
import { ocrImage } from './ocr.js'
import { pickDelay, splitSegments } from './reply.js'
import { composeDaily } from './news.js'

const MAX_BODY = 4 * 1024 * 1024 // 图片 base64 会比较大

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
      // 模块定时来取「要主动发出的消息」；取走即清空
      if (route === 'GET /api/outbox') {
        const items = await store.takeOutbox()
        const lines = items.map((it) =>
          [it.sessionId, it.delayMs, it.segmentDelayMs, ...it.segments].join('\t'),
        )
        return send(res, 200, { count: lines.length, lines })
      }
      if (route === 'POST /api/daily/now') {
        const result = await runDaily({ manual: true })
        return send(res, 200, result)
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
        for (const line of lines) {
          const text = String(line).slice(0, 800)
          logger.info('module', { line: text })
          const version = text.match(/WeChatBridge (\d+\.\d+\.\d+) 启动/)
          if (version) store.moduleInfo.version = version[1]
          if (text.includes('静音保活已启动')) store.moduleInfo.keepAlive = true
          if (text.includes('收消息 Hook：WCDB 数据库层已挂')) store.moduleInfo.dbHook = true
          const lag = text.match(/比发送时间晚 (\d+)s/)
          if (lag) {
            store.moduleInfo.lastLag = Number(lag[1])
            store.moduleInfo.lastLagAt = Date.now()
            store.moduleInfo.lastLine = text.replace(/^.*\| /, '')
          }
          store.moduleInfo.lastLine = store.moduleInfo.lastLine || text.replace(/^.*\| /, '')
          store.moduleInfo.updatedAt = Date.now()
        }
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

  let dailyTimer = null
  let dailyBusy = false

  /** 生成一条「今天刷到的事」，塞进出站队列等模块来取。 */
  async function runDaily(options = {}) {
    if (dailyBusy) return { type: 'error', code: 'BUSY', message: '正在生成上一条' }
    const daily = store.config.daily ?? {}
    const target = options.sessionId || daily.target || store.lastInbound?.senderId
    if (!target) return { type: 'error', code: 'NO_TARGET', message: '还不知道发给谁，先让它收到一条消息' }
    if (!daily.enabled && !options.manual) {
      return { type: 'error', code: 'DISABLED', message: '每日趣事没开' }
    }
    // 冷场才自己找话：对方 30 分钟内说过话就不插嘴
    const idleMs = Date.now() - (store.lastInbound?.at ?? 0)
    if (!options.manual && idleMs < 30 * 60_000) {
      return { type: 'error', code: 'BUSY_CHAT', message: '还在聊天，等冷场再讲' }
    }
    dailyBusy = true
    try {
      const llm = getLlm()
      if (!llm) throw new Error('模型服务还没就绪')
      const session = store.session(target)
      const result = await composeDaily(llm, {
        persona: store.persona ?? store.config.persona,
        config: store.config,
        personaName: store.config.persona?.name,
        memory: await store.getMemory(target),
        summary: session.summary,
        recent: (session.history ?? []).slice(-6),
      })
      const segments = (result?.segments ?? []).flatMap((t) => splitSegments(t, 20, 2))
      if (!segments.length) {
        return { type: 'error', code: 'EMPTY', message: '没挑出可讲的事', errors: result?.errors ?? [] }
      }
      const item = await store.enqueueOutbound(target, segments, { delayMs: 1200, segmentDelayMs: 900 })
      // 主动说的话也要进上下文，不然对方一接话她就失忆
      store.appendTurn(target, 'assistant', segments.join(''))
      logger.info('daily queued', { sessionId: target, segments, chars: segments.join('').length })
      return { type: 'daily.out', sessionId: target, segments, itemId: item?.id }
    } catch (error) {
      logger.error('daily failed', { message: error?.message })
      return { type: 'error', code: 'DAILY_ERROR', message: error?.message || '生成失败' }
    } finally {
      dailyBusy = false
    }
  }

  /** 每 30 秒看一眼：到点了吗、今天发过没有。 */
  function startDailyScheduler() {
    if (dailyTimer) return
    dailyTimer = setInterval(async () => {
      const daily = store.config.daily ?? {}
      if (!daily.enabled) return
      const now = new Date()
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      if (hhmm !== daily.time) return
      if (daily.lastSentDay === day) return
      const result = await runDaily()
      if (result?.code === 'BUSY_CHAT') return // 正在聊，过会儿再看
      daily.lastSentDay = day
      await store.saveConfig()
    }, 30_000)
  }

  async function handleMessage(msg) {
    if (!msg || msg.type !== 'message.in') {
      return fail('INVALID_MSG', '缺少 message.in', msg?.msgId)
    }
    if (store.config.paused) {
      return fail('PAUSED', '桥接已暂停', msg.msgId)
    }
    await store.maybeReloadConfig()
    await store.maybeReloadWhitelist()
    if (store.isDuplicate(msg.msgId)) {
      return fail('DUPLICATE', '重复消息', msg.msgId)
    }
    store.lastInbound = {
      sessionId: msg.sessionId,
      senderId: msg.sender?.id || msg.sessionId,
      name: msg.sender?.name || msg.session?.name || '',
      content: String(msg.content || '').slice(0, 60),
      at: Date.now(),
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
    const vision = store.config.vision ?? {}
    const hasImage = Boolean(msg.image?.data)

    let text = ''
    const started = Date.now()
    const controller = new AbortController()
    // 三分钟还没出结果就放弃，不回了
    const watchdog = setTimeout(() => controller.abort(), 180_000)
    try {
      let promptTurns = turns
      let describe = ''
      let ocrText = ''

      if (hasImage) {
        // 1) 本地识字：图里有字就能给纯文本模型用
        ocrText = await ocrImage(msg.image.data, msg.image.mime).catch(() => '')
        // 2) 视觉模型只负责客观描述，不负责说话
        if (vision.model) {
          try {
            const seen = await completeVision({
              provider: vision.provider || 'siliconflow',
              system: [
                '你在帮一个聊天机器人看图片。',
                '用两三句话客观描述画面：谁/什么、在做什么、场景、可见的文字。',
                '不要用聊天口吻，不要称呼对方，不要编造看不清的细节。',
              ].join('\n'),
              turns: [{ role: 'user', content: '[图片]' }],
              model: vision.model,
              image: msg.image,
              maxTokens: 200,
              signal: controller.signal,
            })
            describe = seen.text
          } catch (error) {
            logger.warn('vision describe failed', { message: error?.message })
          }
        }

        const pieces = ['[对方发了一张图片]']
        if (describe) pieces.push(`画面：${describe}`)
        if (ocrText) pieces.push(`图里的文字：${ocrText}`)
        if (pieces.length === 1) pieces.push('（图看不清，别硬猜内容，随口应一句就行）')
        promptTurns = [
          ...turns.slice(0, -1),
          { role: 'user', content: pieces.join('\n') },
        ]
        logger.info('image seen', {
          describe: describe.length,
          ocr: ocrText.length,
        })
      }

      let lastError
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const system = renderSystem(store.persona ?? store.config.persona, msg, session.summary, memory, {
            withImage: Boolean(describe || ocrText),
          })
          const result = await complete(llm, {
            system,
            turns: promptTurns,
            provider: store.config.provider,
            model: store.config.model,
            maxTokens: store.config.maxTokens,
            signal: controller.signal,
          })
          text = result.text
          lastError = null
          logger.info('model done', {
            ms: Date.now() - started,
            chars: text.length,
            promptTurns: promptTurns.length,
            vision: Boolean(describe),
            ocr: Boolean(ocrText),
            attempt,
          })
          break
        } catch (error) {
          lastError = error
          if (controller.signal.aborted || attempt === 2) break
          logger.warn('model retry', { ms: Date.now() - started, message: error?.message })
          await new Promise((r) => setTimeout(r, 600))
        }
      }
      if (lastError) throw lastError
    } catch (error) {
      const timedOut = controller.signal.aborted
      logger.error('model failed', {
        ms: Date.now() - started,
        message: timedOut ? '超过三分钟，放弃这次回复' : error?.message,
        code: timedOut ? 'TIMEOUT' : error?.code,
      })
      return fail('MODEL_ERROR', timedOut ? '超过三分钟' : error?.message || '模型调用失败', msg.msgId)
    } finally {
      clearTimeout(watchdog)
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

  startDailyScheduler()
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
