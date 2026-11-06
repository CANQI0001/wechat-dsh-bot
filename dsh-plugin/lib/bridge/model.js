import { randomUUID } from 'node:crypto'

export function makeMessage(role, text) {
  return {
    id: randomUUID(),
    role,
    content: text ? [{ type: 'text', text }] : [],
    source: { kind: role === 'system' ? 'system-prompt' : 'user' },
  }
}

/**
 * Run one non-agentic completion against the engine's configured model.
 * Streams raw chunks and collects the visible text.
 */
export async function complete(llm, options) {
  const { system, turns, provider, model, maxTokens, signal } = options
  const messages = []
  if (system) messages.push(makeMessage('system', system))
  for (const turn of turns ?? []) {
    messages.push(makeMessage(turn.role === 'assistant' ? 'assistant' : 'user', turn.content))
  }
  const stream = llm.stream({
    provider,
    model,
    messages,
    maxTokens: Math.max(32, Math.min(Number(maxTokens) || 512, 4096)),
    ...(signal ? { signal } : {}),
  })
  let text = ''
  let finish
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk?.type === 'finish') finish = chunk
  }
  if (finish?.reason?.kind === 'error') {
    const failure = finish.reason.failure ?? {}
    const error = new Error(failure.message || '模型调用失败')
    error.code = failure.code || 'MODEL_ERROR'
    throw error
  }
  return { text: text.trim(), finish }
}

export function renderSystem(persona, msg, summary, memory) {
  const name = persona?.name || '小鱼'
  const custom = typeof persona?.prompt === 'string' ? persona.prompt.trim() : ''
  if (custom) {
    const who = msg.sender?.remark || msg.sender?.name || '对方'
    const where = msg.chatType === 'group'
      ? `群聊「${msg.groupInfo?.groupName || msg.groupInfo?.groupId || '群'}」`
      : '私聊'
    const filled = custom
      .replaceAll('{{name}}', name)
      .replaceAll('{{who}}', who)
      .replaceAll('{{where}}', where)
      .replaceAll('{{summary}}', summary || '')
      .replaceAll('{{memory}}', (memory || '').slice(0, 1200))
    return [
      filled,
      '',
      `（当前场景：你正在和${who}${where}聊天。）`,
      '只输出要发出去的那句话，不要加引号、前缀或任何说明。',
      '每次只说一两句，一句不超过 20 个字；不要用列表、破折号、分隔线或 Markdown。',
      '对方只发了 [图片]/[语音] 这种占位时，自然接一句就好，别去描述内容。',
      '[表情: 名字] 是对方发的表情包，名字只是提示；顺着名字和上下文接一句，别解释表情本身。',
    ].join('\n')
  }
  const description = persona?.description || '一个普通人'
  const who = msg.sender?.remark || msg.sender?.name || '对方'
  const where = msg.chatType === 'group' ? `群聊「${msg.groupInfo?.groupName || msg.groupInfo?.groupId || '群'}」` : '私聊'
  const lines = [
    `你是${name}，${description}。`,
    '',
    `正在和${who}${where}聊天。`,
  ]
  if (memory) lines.push('', '你记得关于对方的事（自然带出来，别一次全说）：', memory.slice(0, 1200))
  if (summary) lines.push(`之前聊过：${summary}`)
  lines.push(
    '',
    '要求：',
    '- 像真人朋友一样聊天，不要客服腔，不要每句都用“您好”“请问”。',
    '- 对方说得短，你就回得短；不要长篇解释，不要列清单。',
    '- 不要主动声明自己是 AI 或机器人。',
    '- 口语化，标点自然，少用表情符号。',
    '- 只输出要发出去的话，不要加引号、前缀或说明。',
    '- 每次只说一两句，一句不超过 20 个字；不要用列表、破折号、分隔线或 Markdown。',
    '- 对方只发了 [图片]/[语音] 这种占位时，自然接一句就好，别去描述内容。',
    '- [表情: 名字] 是对方发的表情包，名字只是提示；顺着名字和上下文接一句，别解释表情本身。',
  )
  return lines.join('\n')
}


/**
 * 把最近的对话压成一段长期记忆。失败就返回空，绝不打断正常回复。
 */
export async function summarizeMemory(llm, options) {
  const { previous, turns, provider, model, signal } = options
  const system = [
    '你是记忆整理助手。读现有记忆和最近对话，输出更新后的记忆。',
    '要求：只保留稳定、以后用得上的事实（怎么称呼、喜好、习惯、在忙的事、约定）。',
    '不要记录寒暄、不要复述原话、不要评论。用第三人称短句，每行一条，最多 15 行。',
    '如果没什么新东西，原样保留旧记忆。只输出记忆本身。',
  ].join('\n')
  const transcript = (turns ?? [])
    .slice(-16)
    .map((t) => `${t.role === 'assistant' ? '我' : '对方'}：${t.content}`)
    .join('\n')
  const user = [`现有记忆：\n${previous?.trim() || '（空）'}`, '', '最近对话：', transcript].join('\n')
  const result = await complete(llm, { system, turns: [{ role: 'user', content: user }], provider, model, maxTokens: 400, signal })
  return result.text.trim()
}
