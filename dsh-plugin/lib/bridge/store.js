import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const CONFIG_DEFAULTS = {
  port: 18765,
  host: '127.0.0.1',
  token: '',
  paused: false,
  provider: 'siliconflow',
  model: 'deepseek-ai/DeepSeek-V4.1-Flash',
  maxTokens: 512,
  rateLimitPerMinute: 12,
  historyTurns: 10,
  segments: {
    maxLen: 80,
    max: 3,
    firstDelayMs: [2000, 5000],
    segmentDelayMs: [800, 2000],
  },
  persona: {
    name: '小鱼',
    description: '25 岁，说话轻松自然，常用短句',
    tone: 'casual',
  },
  vision: {
    provider: 'siliconflow',
    model: 'Qwen/Qwen3-VL-8B-Instruct',
  },
  daily: {
    enabled: false,
    time: '09:30',
    target: '',
    lastSentDay: '',
  },
}

export const WHITELIST_DEFAULTS = {
  enabled: true,
  private: [],
  groups: [],
  groupWakeWords: ['@小鱼', '小鱼'],
}

function deepMerge(base, extra) {
  if (extra === undefined || extra === null) return structuredClone(base)
  if (Array.isArray(base) || typeof base !== 'object') return extra
  const out = { ...base }
  for (const [k, v] of Object.entries(extra)) {
    out[k] = k in base ? deepMerge(base[k], v) : v
  }
  return out
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return structuredClone(fallback)
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2))
  await fsp.rename(tmp, file)
}

export class Store {
  constructor(dir) {
    this.dir = dir
    this.dataDir = path.join(dir, 'data')
    this.configFile = path.join(this.dataDir, 'config.json')
    this.personaFile = path.join(this.dataDir, 'persona.md')
    this.memoryDir = path.join(this.dataDir, 'memory')
    this.memoryCache = new Map()
    this.memoryCounter = new Map()
    this.whitelistFile = path.join(this.dataDir, 'whitelist.json')
    this.sessionsDir = path.join(this.dataDir, 'sessions')
    this.outboxFile = path.join(this.dataDir, 'outbox.json')
    this.outbox = []
    this.moduleInfo = { version: '', keepAlive: false, dbHook: false, lastLag: -1, lastLagAt: 0, lastLine: '', updatedAt: 0 }
    this.config = structuredClone(CONFIG_DEFAULTS)
    this.whitelist = structuredClone(WHITELIST_DEFAULTS)
    this.whitelistMtime = 0
    this.configMtime = 0
    this.sessions = new Map()
    this.seen = new Map()
    this.today = { day: new Date().toISOString().slice(0, 10), count: 0 }
    this.dirty = new Set()
    this.timer = null
  }

  async load() {
    await fsp.mkdir(this.sessionsDir, { recursive: true })
    this.config = deepMerge(CONFIG_DEFAULTS, await readJson(this.configFile, {}))
    this.outbox = await readJson(this.outboxFile, [])
    this.whitelist = deepMerge(WHITELIST_DEFAULTS, await readJson(this.whitelistFile, {}))
    if (!fs.existsSync(this.configFile)) await writeJson(this.configFile, this.config)
    if (!fs.existsSync(this.whitelistFile)) await writeJson(this.whitelistFile, this.whitelist)
    let names = []
    try {
      names = await fsp.readdir(this.sessionsDir)
    } catch {
      names = []
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const s = await readJson(path.join(this.sessionsDir, name), null)
      if (s?.sessionId) this.sessions.set(s.sessionId, s)
    }
    this.today.count = this.countToday()
    try {
      this.configMtime = (await fsp.stat(this.configFile)).mtimeMs
    this.whitelistMtime = (await fsp.stat(this.whitelistFile)).mtimeMs
    } catch {
      this.whitelistMtime = 0
    }
    try {
      await fsp.mkdir(this.memoryDir, { recursive: true })
    } catch {
      /* exists */
    }
    this.startFlusher()
  }

  countToday() {
    let n = 0
    const day = this.today.day
    for (const s of this.sessions.values()) {
      for (const turn of s.history ?? []) {
        if (turn.role === 'user' && (turn.ts ?? '').slice(0, 10) === day) n += 1
      }
    }
    return n
  }

  startFlusher() {
    this.timer = setInterval(() => this.flush(), 4000)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  async flush() {
    if (this.dirty.size === 0) return
    const ids = [...this.dirty]
    this.dirty.clear()
    for (const id of ids) {
      const s = this.sessions.get(id)
      if (!s) continue
      try {
        await writeJson(path.join(this.sessionsDir, `${safeName(id)}.json`), s)
      } catch {
        /* keep dirty for a later retry */
        this.dirty.add(id)
      }
    }
  }

  markDirty(id) {
    this.dirty.add(id)
  }

  session(id, name) {
    let s = this.sessions.get(id)
    if (!s) {
      s = {
        sessionId: id,
        name: name ?? id,
        history: [],
        lastActive: new Date().toISOString(),
        msgCount: 0,
      }
      this.sessions.set(id, s)
    }
    if (name) s.name = name
    return s
  }

  appendTurn(id, role, content) {
    const s = this.session(id)
    s.history.push({ role, content, ts: new Date().toISOString() })
    const keep = Math.max(4, Number(this.config.historyTurns) || 10) * 2
    if (s.history.length > keep) s.history = s.history.slice(-keep)
    if (role === 'user') {
      s.msgCount = (s.msgCount ?? 0) + 1
      const day = new Date().toISOString().slice(0, 10)
      if ( day !== this.today.day) {
        this.today = { day, count: 0 }
      }
      this.today.count += 1
    }
    s.lastActive = new Date().toISOString()
    this.markDirty(id)
    return s
  }

  listSessions() {
    return [...this.sessions.values()]
      .sort((a, b) => String(b.lastActive).localeCompare(String(a.lastActive)))
      .slice(0, 30)
      .map((s) => ({
        id: s.sessionId,
        name: s.name,
        msgCount: s.msgCount ?? 0,
        lastActive: s.lastActive,
      }))
  }

  async deleteSession(id) {
    this.sessions.delete(id)
    this.dirty.delete(id)
    try {
      await fsp.unlink(path.join(this.sessionsDir, `${safeName(id)}.json`))
    } catch {
      /* already gone */
    }
  }

  isDuplicate(msgId) {
    if (!msgId) return false
    if (this.seen.has(msgId)) return true
    this.seen.set(msgId, Date.now())
    if (this.seen.size > 500) {
      const cutoff = Date.now() - 30 * 60 * 1000
      for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k)
    }
    return false
  }

  allowed(msg) {
    const w = this.whitelist
    if (!w.enabled) return { ok: false, reason: 'WHITELIST_DENIED' }
    if (msg.chatType === 'group') {
      const gid = msg.groupInfo?.groupId ?? msg.sessionId
      if (!(w.groups ?? []).includes(gid)) return { ok: false, reason: 'WHITELIST_DENIED' }
      const atMe = msg.groupInfo?.atMe === true
      const words = w.groupWakeWords ?? []
      const hit = atMe || words.some((word) => word && String(msg.content ?? '').includes(word))
      if (!hit) return { ok: false, reason: 'WHITELIST_DENIED' }
      return { ok: true }
    }
    const uid = msg.sender?.id
    if (!(w.private ?? []).includes(uid)) return { ok: false, reason: 'WHITELIST_DENIED' }
    return { ok: true }
  }

  snapshot() {
    return {
      port: this.config.port,
      host: this.config.host,
      paused: Boolean(this.config.paused),
      provider: this.config.provider,
      model: this.config.model,
      sessions: this.sessions.size,
      today: this.today.count,
      whitelist: {
        enabled: Boolean(this.whitelist.enabled),
        private: (this.whitelist.private ?? []).length,
        groups: (this.whitelist.groups ?? []).length,
      },
    }
  }

  /**
   * data/persona.md 存在就用它当人设；否则用 config.json 里的 persona。
   * 这是给「网上抄来的人设」用的：整段说明贴进去就行。
   */
  async loadPersona() {
    try {
      const text = await fsp.readFile(this.personaFile, 'utf8')
      return { name: this.config.persona?.name || '小鱼', prompt: text.trim() }
    } catch {
      return null
    }
  }

  /**
   * 每个会话一份长期记忆（data/memory/<id>.md），重启也留着。
   */
  async getMemory(id) {
    if (this.memoryCache.has(id)) return this.memoryCache.get(id)
    let text = ''
    try {
      text = await fsp.readFile(path.join(this.memoryDir, `${safeName(id)}.md`), 'utf8')
    } catch {
      text = ''
    }
    this.memoryCache.set(id, text)
    return text
  }

  async saveMemory(id, text) {
    const trimmed = String(text ?? '').trim().slice(0, 2000)
    this.memoryCache.set(id, trimmed)
    try {
      await fsp.writeFile(path.join(this.memoryDir, `${safeName(id)}.md`), trimmed, 'utf8')
    } catch {
      /* ignore */
    }
    return trimmed
  }

  bumpMemoryCounter(id) {
    const n = (this.memoryCounter.get(id) ?? 0) + 1
    this.memoryCounter.set(id, n)
    return n
  }

  memoryIds() {
    return [...this.memoryCache.keys()]
  }

  async saveWhitelist() {
    await writeJson(this.whitelistFile, this.whitelist)
    try {
      this.whitelistMtime = (await fsp.stat(this.whitelistFile)).mtimeMs
    } catch {
      this.whitelistMtime = 0
    }
  }

  // ── 主动发出（模块定时来取） ──────────────────────────────
  async enqueueOutbound(sessionId, segments, options = {}) {
    if (!sessionId || !Array.isArray(segments) || segments.length === 0) return null
    const item = {
      id: `out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      segments,
      delayMs: options.delayMs ?? 800,
      segmentDelayMs: options.segmentDelayMs ?? 900,
      createdAt: Date.now(),
    }
    this.outbox.push(item)
    if (this.outbox.length > 20) this.outbox = this.outbox.slice(-20)
    await writeJson(this.outboxFile, this.outbox)
    return item
  }

  async takeOutbox() {
    const items = this.outbox.slice()
    this.outbox = []
    await writeJson(this.outboxFile, this.outbox)
    return items
  }

  async saveConfig() {
    await writeJson(this.configFile, this.config)
    try {
      this.configMtime = (await fsp.stat(this.configFile)).mtimeMs
    } catch {
      this.configMtime = 0
    }
  }

  async reloadWhitelist() {
    this.whitelist = deepMerge(WHITELIST_DEFAULTS, await readJson(this.whitelistFile, {}))
    try {
      this.whitelistMtime = (await fsp.stat(this.whitelistFile)).mtimeMs
    } catch {
      this.whitelistMtime = 0
    }
    return this.whitelist
  }

  /**
   * Pick up an edited whitelist.json without restarting the engine.
   */
  /** 配置文件被外部改过（调延迟、换模型）就热加载，不用重启引擎。 */
  async maybeReloadConfig() {
    try {
      const stat = await fsp.stat(this.configFile)
      if (stat.mtimeMs === this.configMtime) return
      this.configMtime = stat.mtimeMs
      const next = deepMerge(CONFIG_DEFAULTS, await readJson(this.configFile, {}))
      next.paused = this.config?.paused ?? next.paused
      this.config = next
    } catch {
      /* 文件暂时读不到就保持原样 */
    }
  }

  async maybeReloadWhitelist() {
    try {
      const stat = await fsp.stat(this.whitelistFile)
      if (stat.mtimeMs !== this.whitelistMtime) {
        await this.reloadWhitelist()
        return true
      }
    } catch {
      /* missing file keeps the current rules */
    }
    return false
  }

  dispose() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

function safeName(id) {
  return Buffer.from(String(id)).toString('hex').slice(0, 64)
}
