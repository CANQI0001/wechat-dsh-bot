import fs from 'node:fs'
import path from 'node:path'

// 识图不经过 DSH 引擎：引擎的模型目录里没有视觉模型，
// 走引擎会报 UNKNOWN_MODEL。这里直接按服务商 baseUrl 打 OpenAI 兼容接口，
// 所以将来换成别的视觉服务商也能用。

function home() {
  return process.env.DSH_HOME || '/root/.dsh'
}

let registryCache

function registry() {
  if (registryCache) return registryCache
  const base = path.join(home(), 'profiles')
  const candidates = []
  try {
    for (const profile of fs.readdirSync(base)) {
      candidates.push(path.join(base, profile, 'node_modules/dsh-our-free-model/src/providers/registry.json'))
    }
  } catch {
    /* 没有 profiles 目录就跳过 */
  }
  for (const file of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (Array.isArray(data) && data.length) {
        registryCache = data
        return data
      }
    } catch {
      /* 换下一个 */
    }
  }
  registryCache = []
  return registryCache
}

function providerOf(id) {
  return registry().find((p) => p.id === id)
}

function readKey(envNames) {
  for (const env of envNames) {
    if (env && process.env[env]) return process.env[env]
  }
  try {
    const text = fs.readFileSync(path.join(home(), '.credentials.yaml'), 'utf8')
    for (const env of envNames) {
      if (!env) continue
      const hit = text.match(new RegExp(`${env}:\\s*["']?([^"'\\s]+)`))
      if (hit?.[1]) return hit[1]
    }
  } catch {
    /* 没凭据文件 */
  }
  return undefined
}

/** 这个服务商能不能识图：取 baseUrl 和 key。 */
export function visionEndpoint(providerId, apiKey) {
  const provider = providerOf(providerId)
  // 注意：siliconflow 的国际站 .com 和国内站 .cn 是两个独立平台，key 不通用
  const baseUrl =
    providerId === 'siliconflow'
      ? 'https://api.siliconflow.cn/v1'
      : provider?.baseUrl
  const keys = [provider?.auth?.env, 'SILICONFLOW_API_KEY', 'OPENAI_API_KEY']
  // 优先级：环境变量 / 凭据文件 > config.json（后者容易误提交）
  const key = readKey(keys.filter(Boolean)) || apiKey
  if (!baseUrl) return { ok: false, reason: `不知道 ${providerId} 的接口地址` }
  if (!key) return { ok: false, reason: `没有 ${providerId} 的 key` }
  return { ok: true, url: `${baseUrl.replace(/\/$/, '')}/chat/completions`, key }
}

export async function completeVision({ provider, apiKey, system, turns, model, image, maxTokens = 140, signal }) {
  const endpoint = visionEndpoint(provider || 'siliconflow', apiKey)
  if (!endpoint.ok) throw new Error(endpoint.reason)

  const messages = [{ role: 'system', content: system }]
  const last = turns.length - 1
  turns.forEach((turn, index) => {
    if (index === last && turn.role === 'user') {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: turn.content },
          { type: 'image_url', image_url: { url: `data:${image.mime || 'image/jpeg'};base64,${image.data}` } },
        ],
      })
      return
    }
    messages.push({ role: turn.role, content: turn.content })
  })

  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.85 }),
    signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const hint = res.status === 401 ? '（key 和接口站点不匹配？）' : ''
    throw new Error(`识图接口 ${res.status}${hint}：${body.slice(0, 120)}`)
  }
  const json = await res.json()
  const text = json?.choices?.[0]?.message?.content
  if (!text) throw new Error('识图接口没返回内容')
  return { text: String(text).trim() }
}
