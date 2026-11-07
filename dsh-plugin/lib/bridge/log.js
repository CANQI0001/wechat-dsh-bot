import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 1024 * 1024

export function createLogger(dir) {
  const file = path.join(dir, 'data', 'bridge.log')
  let checkedAt = 0
  // 超过 1MB 就轮转，保留一份旧的，别让日志无限长
  const rotateIfBig = () => {
    const now = Date.now()
    if (now - checkedAt < 30_000) return
    checkedAt = now
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        fs.renameSync(file, `${file}.1`)
      }
    } catch {
      /* 文件不存在就算了 */
    }
  }
  const write = (level, message, extra) => {
    const line = `${new Date().toISOString()} ${level} ${message}${extra ? ` ${safeJson(extra)}` : ''}`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      rotateIfBig()
      fs.appendFileSync(file, `${line}\n`)
    } catch {
      /* logging must never break a reply */
    }
  }
  return {
    info: (message, extra) => write('INFO', message, extra),
    warn: (message, extra) => write('WARN', message, extra),
    error: (message, extra) => write('ERROR', message, extra),
    file,
    tail(lines = 40) {
      try {
        const all = fs.readFileSync(file, 'utf8').split('\n')
        return all.slice(-lines).join('\n')
      } catch {
        return ''
      }
    },
  }
}

function safeJson(value) {
  try {
    const text = JSON.stringify(value)
    return text.length > 600 ? `${text.slice(0, 600)}…` : text
  } catch {
    return ''
  }
}
