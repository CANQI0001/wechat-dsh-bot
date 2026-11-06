import fs from 'node:fs'
import path from 'node:path'

export function createLogger(dir) {
  const file = path.join(dir, 'data', 'bridge.log')
  const write = (level, message, extra) => {
    const line = `${new Date().toISOString()} ${level} ${message}${extra ? ` ${safeJson(extra)}` : ''}`
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
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
