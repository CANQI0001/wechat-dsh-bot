/**
 * 每日趣事：抓热榜 -> 让模型挑一条、用聊天口吻讲出来。
 *
 * 不做「新闻播报」：直接把标题塞给对方就成了复制粘贴。
 * 这里只把标题当作素材，讲什么、怎么讲由人设决定。
 */

const UA = 'Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36'

const SOURCES = [
  {
    id: 'baidu',
    name: '百度热搜',
    async fetch() {
      const res = await fetch('https://top.baidu.com/api/board?platform=wise&tab=realtime', {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(`百度热搜 ${res.status}`)
      const json = await res.json()
      const items = (json?.data?.cards ?? [])
        .flatMap((c) => c?.content ?? [])
        .flatMap((c) => c?.content ?? [])
        .filter((x) => x?.word)
        .map((x, i) => ({ title: String(x.word).trim(), rank: i + 1 }))
      return items
    },
  },
  {
    id: 'toutiao',
    name: '今日头条',
    async fetch() {
      const res = await fetch('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', {
        headers: { 'user-agent': UA },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(`头条热榜 ${res.status}`)
      const json = await res.json()
      return (json?.data ?? [])
        .map((x, i) => ({ title: String(x.Title ?? '').trim(), rank: i + 1 }))
        .filter((x) => x.title)
    },
  },
]

/** 政治/灾难类不聊，避免尴尬也避免账号风险。 */
const SKIP = /(习近平|总书记|国务院|外交部|战争|袭击|地震|遇难|死亡|坠机|车祸|疫情|判决|判刑|落马|纪委|台独|军演|导弹)/

export async function collectCandidates(limit = 12) {
  const out = []
  const errors = []
  for (const source of SOURCES) {
    try {
      const items = await source.fetch()
      for (const item of items.slice(0, 20)) {
        if (SKIP.test(item.title)) continue
        if (out.some((x) => x.title === item.title)) continue
        out.push({ ...item, source: source.name })
      }
    } catch (error) {
      errors.push(`${source.name}: ${error?.message ?? error}`)
    }
  }
  return { items: out.slice(0, limit), errors }
}

/**
 * 让模型用她的口吻讲一条。
 * @returns {Promise<{segments: string[]}|null>}
 */
export async function composeDaily(llm, { persona, config, personaName }) {
  const { items, errors } = await collectCandidates()
  if (!items.length) {
    return { segments: [], errors }
  }
  const list = items.map((x, i) => `${i + 1}. [${x.source}] ${x.title}`).join('\n')
  const system = [
    persona?.prompt ? persona.prompt : `你叫${personaName || '小鱼'}，是最普通不过的网友。`,
    '',
    '现在你要主动找对方聊天，讲一件你今天刷到的事。规矩：',
    '- 不许念标题，不许复制新闻原句，用自己的话讲',
    '- 像随口一提：「刚刷到个事，笑死」这种起手',
    '- 一到两句，总共不超过 40 字',
    '- 说人话，带一点情绪（觉得好笑、离谱、奇怪）',
    '- 不确定真假就别说死，可以说「不知道真假」',
    '- 不要提问式结尾，不要让对方觉得在被要求回应',
    '',
    '直接给要发出去的话，不要解释。',
  ].join('\n')

  const stream = llm.stream({
    provider: config.provider,
    model: config.model,
    system,
    messages: [
      {
        id: `daily-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: `今天刷到的这些事：\n${list}\n\n挑一件最有意思的讲给我听。` }],
        source: { kind: 'user' },
      },
    ],
    maxTokens: 200,
  })

  let text = ''
  let finish
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta') text += chunk.text ?? ''
    else if (chunk?.type === 'finish') finish = chunk
  }
  if (finish?.reason?.kind === 'error') {
    const failure = finish.reason.failure ?? {}
    throw new Error(failure.message || failure.code || '模型调用失败')
  }
  return { segments: [text.trim()].filter(Boolean), errors, picked: items.slice(0, 5) }
}
