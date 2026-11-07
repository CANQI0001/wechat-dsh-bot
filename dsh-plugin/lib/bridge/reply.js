/** 单段硬上限：超了才在逗号处拆，否则一律整段发。 */
const HARD_MAX = 45

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

export function splitSegments(text, maxLen = HARD_MAX, max = 6) {
  const clean = String(text ?? '').replace(/\r\n/g, '\n').trim()
  if (clean === '') return []
  const limit = Math.max(10, Math.min(HARD_MAX, Number(maxLen) || HARD_MAX))
  const cap = Math.max(1, Math.min(8, Number(max) || 6))

  // 模型自己用换行分好的段，先尊重它
  const lines = clean
    .split('\n')
    .map((line) => line.replace(TRIM_HEAD, '').trim())
    .filter((line) => line !== '' && !/^[\s\-*·•—–、，。；：！？'"“”‘’]+$/.test(line))

  // 一行里如果塞了多个完整句子，也按句号分开（这是模型没换行时的兜底）
  const pieces = []
  for (const line of lines) {
    const sentences = line.split(/(?<=[。！？!?…])/).map((x) => x.trim()).filter(Boolean)
    for (const sentence of sentences) {
      if (sentence.length <= limit) pieces.push(sentence)
      else pieces.push(...softChunk(sentence, limit))
    }
  }

  // 收尾清理：去首尾标点、合并超短残段
  const out = []
  for (const raw of pieces) {
    const seg = raw
      .replace(TRIM_HEAD, '')
      .replace(/[\s\-—–·•*]+$/, '')
      .replace(/[，、；：,;:]$/, '')
      .trim()
    if (!seg) continue
    if (seg.length <= 2 && out.length) out[out.length - 1] += seg
    else out.push(seg)
  }

  // 段数超过上限时不能丢字：剩下的并进最后一段
  const capped = out.length <= cap ? out : [...out.slice(0, cap - 1), out.slice(cap - 1).join('')]
  // 不再自动合并模型的段落：合并会把两句话焊成一大坨，看着更假
  return capped.map(relax)
}

const SHIFT = /^(对了|另外|话说|还有|哦对|顺便|说起来|不过)/

/**
 * 一段话说完一件事就别拆成两条；两条加起来很短、又不是新话题，就并成一条。
 * 并的时候用空格连着，像手打字那样。
 */
function mergeShort(list) {
  if (list.length !== 2) return list
  const [a, b] = list
  if (SHIFT.test(b)) return list
  if (a.length + b.length > 40) return list
  return [`${a} ${b}`]
}

/** 很长的段落才省点标点：隔一个逗号换空格，并去掉句尾句号。 */
function relax(segment) {
  if (segment.length <= 25) return segment.replace(/[。！？!?]$/, '')
  let flip = false
  return segment
    .replace(/[。！？!?]$/, '')
    .replace(/[，。；：、,;:]/g, (ch) => {
      if (ch === '。' || ch === '！' || ch === '？') return ' '
      flip = !flip
      return flip ? ' ' : '，'
    })
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function pickDelay(range, textLen = 0) {
  const [min, max] = Array.isArray(range) ? range : [1000, 3000]
  const lo = Math.max(200, Number(min) || 1000)
  const hi = Math.max(lo, Number(max) || lo)
  const base = lo + Math.random() * (hi - lo)
  const extra = Math.min(Math.max(0, Number(textLen) || 0) * 20, 2500)
  return Math.round(base + extra)
}
