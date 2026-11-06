import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from './bridge/log.js'
import { createBridgeServer } from './bridge/server.js'
import { Store } from './bridge/store.js'
import { installPanels } from './panels.js'

export const name = 'local-wechat-bridge'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')

// 回复速率的预设：first = 第一条延迟，gap = 后续分段间隔
const SPEED_PRESETS = {
  instant: { zh: '秒回', en: 'Instant', first: [300, 800], gap: [200, 500] },
  fast: { zh: '快', en: 'Fast', first: [1000, 2000], gap: [500, 1200] },
  normal: { zh: '正常', en: 'Normal', first: [2000, 5000], gap: [800, 2000] },
  slow: { zh: '慢', en: 'Slow', first: [5000, 9000], gap: [2000, 4000] },
  lazy: { zh: '很慢', en: 'Lazy', first: [9000, 15000], gap: [3000, 6000] },
}

function matchSpeed(segments) {
  const first = segments?.firstDelayMs ?? []
  for (const [key, preset] of Object.entries(SPEED_PRESETS)) {
    if (first[0] === preset.first[0] && first[1] === preset.first[1]) return key
  }
  return 'custom'
}

export function apply(ctx) {
  const logger = createLogger(pluginDir)
  const store = new Store(pluginDir)
  const state = { running: false, error: '' }
  let server = null

  const start = async () => {
    try {
      await store.load()
      store.persona = await store.loadPersona()
      server = createBridgeServer({
        store,
        logger,
        getLlm: () => {
          try {
            return ctx.get('llm')
          } catch {
            return undefined
          }
        },
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(store.config.port, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      server.unref?.()
      state.running = true
      logger.info('bridge listening', { port: store.config.port })
    } catch (error) {
      state.running = false
      state.error = error?.message || String(error)
      logger.error('bridge failed to start', { message: state.error })
    }
  }

  const stop = () => {
    try {
      server?.close()
    } catch {
      /* ignore */
    }
    server = null
    state.running = false
    store.dispose()
  }

  start()
  try {
    ctx.on('dispose', stop)
  } catch {
    /* engine without dispose hook */
  }

  const statusText = () => {
    if (!state.running) return state.error ? '启动失败' : '未启动'
    if (store.config.paused) return '已暂停'
    return '运行中'
  }

  // 面板定义在 panels.js（微信参数 + AI 管理）
  installPanels(ctx, { store, state, statusText: () => statusText() })
}
