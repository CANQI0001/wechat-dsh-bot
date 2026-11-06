/** 硬上限：一段最多 30 字，配置写多大都不会超。 */
const HARD_MAX = 30

function hardChunk(text, maxLen) {
  const rest = String(text).trim()
  if (rest.length <= maxLen) return [rest]
  // 均分成若干段，避免最后剩两三个字的尾巴
  const parts = Math.ceil(rest.length / maxLen)
  const size = Math.ceil(rest.length / parts)
  const out = []
  let cursor = 0
  for (let i = 0; i < parts - 1; i++) {
    const target = cursor + size
    let cut = -1
    for (const ch of ['，', '、', '；', '：', ',', ';', ' ']) {
      const at = rest.lastIndexOf(ch, target)
      if (at > cursor + Math.floor(size / 3) && at > cut) cut = at
    }
    if (cut < 0) cut = target - 1
    out.push(rest.slice(cursor, cut + 1).trim())
    cursor = cut + 1
  }
  if (rest.slice(cursor).trim()) out.push(rest.slice(cursor).trim())
  return out
}

export function splitSegments(text, maxLen = HARD_MAX, max = 3) {
  const clean = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (clean === '') return []
  const limit = Math.max(5, Math.min(HARD_MAX, Number(maxLen) || HARD_MAX))
  const count = Math.max(1, Math.min(6, Number(max) || 3))

  const sentences = clean
    .split(/(?<=[。！？!?…\n])/)
    .map((s) => s.replace(/^[\s\-*·•—–]+/, '').trim())
    .filter((s) => s !== '' && !/^[\s\-*·•—–、，。]+$/.test(s))
  const pieces = []
  for (const sentence of sentences) {
    if (sentence.length <= limit) pieces.push(sentence.trim())
    else pieces.push(...hardChunk(sentence, limit))
  }

  const out = []
  let current = ''
  for (const piece of pieces) {
    if (current && current.length + piece.length > limit) {
      out.push(current.trim())
      current = piece
    } else {
      current += piece
    }
  }
  if (current.trim()) out.push(current.trim())

  // 太短的残段并进上一段，避免发一个孤零零的「一」「-」
  const merged = []
  for (const raw of out) {
    const seg = raw.replace(/[\s\-—–·•*]+$/, '').trim()
    if (!seg) continue
    if (seg.length <= 2 && merged.length) merged[merged.length - 1] += seg
    else merged.push(seg)
  }

  // 段数上限就是硬上限：多出来的不发，避免某一段被撑大
  return merged.slice(0, count)
}

export function pickDelay(range, textLen = 0) {
  const [min, max] = Array.isArray(range) ? range : [1000, 3000]
  const lo = Math.max(200, Number(min) || 1000)
  const hi = Math.max(lo, Number(max) || lo)
  const base = lo + Math.random() * (hi - lo)
  const extra = Math.min(Math.max(0, Number(textLen) || 0) * 20, 2500)
  return Math.round(base + extra)
}
