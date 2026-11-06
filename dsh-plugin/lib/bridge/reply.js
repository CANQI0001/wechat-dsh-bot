/** 硬上限：一段最多 30 字，配置写多大都不会超。 */
const HARD_MAX = 30

const SOFT_CUT = ['，', '、', '；', '：', ',', ';', '：', ' ']
const TRIM_HEAD = /^[\s\-*·•—–、，。；：！？'"“”‘’「」『』()（）]+/

/** 只按逗号这类软停顿切，绝不在词中间下刀。 */
function softChunk(sentence, limit) {
  const out = []
  let cursor = 0
  while (cursor < sentence.length) {
    if (sentence.length - cursor <= limit) {
      out.push(sentence.slice(cursor).trim())
      break
    }
    const target = cursor + limit
    let cut = -1
    for (const ch of SOFT_CUT) {
      const at = sentence.lastIndexOf(ch, target)
      if (at > cursor + Math.floor(limit / 2) && at > cut) cut = at
    }
    if (cut < 0) {
      // 附近没有软停顿：整句发出去，宁可长一点也不切碎
      out.push(sentence.slice(cursor).trim())
      break
    }
    out.push(sentence.slice(cursor, cut + 1).trim())
    cursor = cut + 1
  }
  return out.filter((x) => x !== '')
}

export function splitSegments(text, maxLen = HARD_MAX, max = 3) {
  const clean = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (clean === '') return []
  const limit = Math.max(5, Math.min(HARD_MAX, Number(maxLen) || HARD_MAX))
  const count = Math.max(1, Math.min(6, Number(max) || 3))

  // 1. 先按句末标点断句，标点留在句子里
  const sentences = clean
    .split(/(?<=[。！？!?…\n])/)
    .map((s) => s.replace(TRIM_HEAD, '').trim())
    .filter((s) => s !== '' && !/^[\s\-*·•—–、，。；：！？'"“”‘’]+$/.test(s))

  // 2. 单句超长只在逗号处再切；没逗号就整句留着
  const pieces = []
  for (const sentence of sentences) {
    if (sentence.length <= limit) pieces.push(sentence)
    else pieces.push(...softChunk(sentence, limit))
  }

  // 3. 贪心合并到 limit 以内
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

  // 4. 清掉首尾残留标点和太短的残段
  const merged = []
  for (const raw of out) {
    // 段末的逗号顿号去掉：微信里不会有人把「，」当一句的结尾
    const seg = raw.replace(TRIM_HEAD, '')
      .replace(/[\s\-—–·•*]+$/, '')
      .replace(/[，、；：,;:]$/, '')
      .trim()
    if (!seg) continue
    if (seg.length <= 2 && merged.length) merged[merged.length - 1] += seg
    else merged.push(seg)
  }

  // 5. 段数超了不能丢字：剩下的并进最后一段
  if (merged.length <= count) return merged
  return [...merged.slice(0, count - 1), merged.slice(count - 1).join('')]
}

export function pickDelay(range, textLen = 0) {
  const [min, max] = Array.isArray(range) ? range : [1000, 3000]
  const lo = Math.max(200, Number(min) || 1000)
  const hi = Math.max(lo, Number(max) || lo)
  const base = lo + Math.random() * (hi - lo)
  const extra = Math.min(Math.max(0, Number(textLen) || 0) * 20, 2500)
  return Math.round(base + extra)
}
