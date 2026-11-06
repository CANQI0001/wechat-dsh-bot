import { summarizeMemory } from './bridge/model.js'

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

export function installPanels(ctx, { store, state }) {
  const engine = ctx
  ctx.inject(['dshGo'], (ctx) => {
    // ── 微信参数 ──────────────────────────────────────────────
    ctx.dshGo.panel('wechat-settings', {
      view: (scope, caps) => {
        const zh = !String(caps?.locale ?? '').startsWith('en')
        const t = (a, b) => (zh ? a : b)
        return {
          type: 'stack',
          title: t('微信参数', 'WeChat'),
          children: [
            { type: 'callout', text: { $: 'data.stateText' }, tone: { $: 'data.stateTone' } },
            { type: 'text', text: t('白名单', 'Whitelist') },
            {
              type: 'list',
              items: { $: 'data.whitelistItems' },
            },
            {
              type: 'actions',
              items: [
                { label: t('加入最近来信的人', 'Add last sender'), action: 'add-last', style: 'primary' },
                { label: t('重载白名单', 'Reload'), action: 'reload-all' },
                { label: t('清空白名单', 'Clear all'), action: 'clear-whitelist' },
              ],
            },
            { type: 'text', text: t('回复节奏', 'Pace') },
            {
              type: 'options',
              id: 'speed',
              selected: { $: 'data.speed' },
              options: Object.entries(SPEED_PRESETS).map(([value, p]) => ({
                value,
                label: t(p.zh, p.en),
              })),
            },
            {
              type: 'options',
              id: 'seg-count',
              selected: { $: 'data.segCount' },
              options: ['1', '2', '3'].map((v) => ({ value: v, label: t(`${v} 段`, `${v} part`) })),
            },
            {
              type: 'options',
              id: 'seg-len',
              selected: { $: 'data.segLen' },
              options: ['15', '20', '25', '30'].map((v) => ({ value: v, label: t(`${v} 字`, `${v} chars`) })),
            },
            {
              type: 'keyValue',
              items: [
                [t('当前延迟', 'Delay'), { $: 'data.delayText' }],
                [t('每段上限', 'Max / part'), { $: 'data.lenText' }],
              ],
            },
            { type: 'text', text: { $: 'data.hint' }, tone: 'muted' },
          ],
        }
      },
      data: (scope, emit, caps) => {
        const zh = !String(caps?.locale ?? '').startsWith('en')
        const tick = () => {
          const seg = store.config.segments ?? {}
          const items = (store.whitelist.private ?? []).map((id) => ({
            title: id,
            subtitle: store.sessions.get(id)?.name && store.sessions.get(id).name !== id
              ? store.sessions.get(id).name
              : (zh ? '私聊' : 'direct'),
            trailing: zh ? '移除' : 'remove',
            action: { id: 'remove-whitelist', args: { wxid: id } },
          }))
          for (const id of store.whitelist.groups ?? []) {
            items.push({
              title: id,
              subtitle: zh ? '群聊' : 'group',
              trailing: zh ? '移除' : 'remove',
              action: { id: 'remove-whitelist', args: { wxid: id } },
            })
          }
          emit({
            speed: matchSpeed(seg),
            segCount: String(seg.max ?? 3),
            segLen: String(seg.maxLen ?? 30),
            delayText: `${(seg.firstDelayMs ?? []).join('–')}ms / +${(seg.segmentDelayMs ?? []).join('–')}ms`,
            lenText: `${Math.min(30, Number(seg.maxLen) || 30)} ${zh ? '字' : 'chars'}`,
            whitelistItems: items.length
              ? items
              : [{ title: zh ? '还没有白名单' : 'Empty', subtitle: zh ? '谁都不会被回复' : 'nobody answered', tone: 'warn' }],
            stateText: state.running
              ? store.config.paused
                ? (zh ? '已暂停：收到消息也不回' : 'Paused')
                : (zh ? '运行中' : 'Running')
              : (state.error ? (zh ? `启动失败：${state.error}` : `Failed: ${state.error}`) : (zh ? '未启动' : 'Not running')),
            stateTone: state.running && !store.config.paused ? 'good' : 'warn',
            hint: store.lastInbound
              ? (zh ? `最近来信：${store.lastInbound.name || store.lastInbound.senderId}` : `Last: ${store.lastInbound.senderId}`)
              : (zh ? '让对方向你发一条消息，就能一键加入白名单' : 'Ask someone to message you first'),
          })
        }
        tick()
        const timer = setInterval(tick, 5000)
        return () => clearInterval(timer)
      },
      actions: {
        'add-last': async () => {
          const last = store.lastInbound
          if (!last?.senderId) return { toast: '还没有收到过消息' }
          const isGroup = String(last.sessionId ?? '').endsWith('@chatroom')
          const list = isGroup ? store.whitelist.groups : store.whitelist.private
          const id = isGroup ? last.sessionId : last.senderId
          if (list.includes(id)) return { toast: '已经在白名单里了' }
          list.push(id)
          await store.saveWhitelist()
          store.whitelistMtime = 0
          return { toast: `已加入 ${last.name || id}`, refresh: true }
        },
        'remove-whitelist': async (scope, event) => {
          const id = event?.value?.wxid
          if (!id) return { toast: '没拿到要移除的 id' }
          store.whitelist.private = (store.whitelist.private ?? []).filter((x) => x !== id)
          store.whitelist.groups = (store.whitelist.groups ?? []).filter((x) => x !== id)
          await store.saveWhitelist()
          store.whitelistMtime = 0
          return { toast: '已移除', refresh: true }
        },
        'clear-whitelist': async () => {
          store.whitelist.private = []
          store.whitelist.groups = []
          await store.saveWhitelist()
          store.whitelistMtime = 0
          return { toast: '白名单已清空', refresh: true }
        },
        'reload-all': async () => {
          await store.reloadWhitelist()
          store.persona = await store.loadPersona()
          return { toast: '已重载', refresh: true }
        },
        speed: async (scope, event) => {
          const preset = SPEED_PRESETS[event?.value?.value]
          if (!preset) return { toast: '未知速率' }
          store.config.segments = {
            ...(store.config.segments ?? {}),
            firstDelayMs: [...preset.first],
            segmentDelayMs: [...preset.gap],
          }
          await store.saveConfig()
          return { toast: `速率：${preset.zh}`, refresh: true }
        },
        'seg-count': async (scope, event) => {
          store.config.segments = { ...(store.config.segments ?? {}), max: Number(event?.value?.value) || 1 }
          await store.saveConfig()
          return { toast: '分段数已更新', refresh: true }
        },
        'seg-len': async (scope, event) => {
          const len = Math.max(5, Math.min(30, Number(event?.value?.value) || 30))
          store.config.segments = { ...(store.config.segments ?? {}), maxLen: len }
          await store.saveConfig()
          return { toast: `每段最多 ${len} 字`, refresh: true }
        },
      },
    })

    // ── AI 管理 ───────────────────────────────────────────────
    const PAGE = 8
    const catalog = { providers: [], byProvider: new Map(), error: '', loadedAt: 0 }
    let modelPage = 0
    let viewingProvider = store.config.provider

    const loadProviders = async () => {
      const llm = engine.get('llm')
      if (!llm) throw new Error('模型服务还没就绪')
      const list = await llm.listProviders()
      catalog.providers = list.map((p) => ({ id: p.id, name: p.name || p.id }))
      catalog.loadedAt = Date.now()
      catalog.error = ''
      return catalog.providers
    }

    const loadModels = async (provider) => {
      const llm = engine.get('llm')
      if (!llm) throw new Error('模型服务还没就绪')
      const models = await llm.listModels(provider)
      catalog.byProvider.set(provider, models.map((m) => ({ id: m.id, name: m.name || m.id })))
      return catalog.byProvider.get(provider)
    }

    const warm = async () => {
      try {
        await loadProviders()
        await loadModels(store.config.provider || viewingProvider)
      } catch (error) {
        catalog.error = error?.message || String(error)
      }
    }
    warm()

    // 选完先真发一次，确认这个 provider+model 能用，再写配置
    const probeModel = async (provider, model) => {
      const llm = engine.get('llm')
      const stream = llm.stream({
        provider,
        model,
        messages: [{ id: 'probe', role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' } }],
        maxTokens: 16,
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
      return text.trim()
    }

    ctx.dshGo.panel('ai', {
      view: (scope, caps) => {
        const zh = !String(caps?.locale ?? '').startsWith('en')
        const t = (a, b) => (zh ? a : b)
        return {
          type: 'stack',
          title: t('AI 管理', 'AI'),
          children: [
            {
              type: 'row',
              children: [
                { type: 'metric', label: t('今日来信', 'Today'), value: { $: 'data.today' } },
                { type: 'metric', label: t('会话', 'Chats'), value: { $: 'data.sessions' } },
              ],
            },
            {
              type: 'keyValue',
              items: [
                [t('当前模型', 'Current'), { $: 'data.model' }],
                [t('人设', 'Persona'), { $: 'data.personaText' }],
                [t('人设字数', 'Persona size'), { $: 'data.personaSize' }],
                [t('记忆', 'Memory'), { $: 'data.memoryText' }],
                [t('上下文', 'Context'), { $: 'data.historyText' }],
                [t('回复上限', 'Max tokens'), { $: 'data.tokensText' }],
                [t('限流', 'Rate limit'), { $: 'data.rateText' }],
                [t('模型目录', 'Catalog'), { $: 'data.catalogText' }],
              ],
            },
            { type: 'text', text: t('渠道', 'Provider') },
            { type: 'options', id: 'provider', selected: { $: 'data.selectedProvider' }, options: { $: 'data.providerOptions' } },
            { type: 'text', text: { $: 'data.modelPageText' } },
            { type: 'options', id: 'model', selected: { $: 'data.selectedModel' }, options: { $: 'data.modelOptions' } },
            {
              type: 'actions',
              items: [
                { label: t('上一页', 'Prev'), action: 'model-prev' },
                { label: t('下一页', 'Next'), action: 'model-next' },
                { label: t('刷新目录', 'Refresh'), action: 'catalog-refresh' },
              ],
            },
            {
              type: 'options',
              id: 'history',
              selected: { $: 'data.history' },
              options: ['4', '6', '10', '16'].map((v) => ({ value: v, label: t(`记忆 ${v} 轮`, `${v} turns`) })),
            },
            {
              type: 'options',
              id: 'tokens',
              selected: { $: 'data.tokens' },
              options: ['256', '512', '1024'].map((v) => ({ value: v, label: t(`${v} tokens`, `${v} tokens`) })),
            },
            {
              type: 'options',
              id: 'rate',
              selected: { $: 'data.rate' },
              options: ['6', '12', '30'].map((v) => ({ value: v, label: t(`限流 ${v} 条/分`, `${v}/min`) })),
            },
            {
              type: 'actions',
              items: [
                { label: t('重载人设', 'Reload persona'), action: 'reload-persona', style: 'primary' },
                { label: t('整理记忆', 'Compress'), action: 'memory-compact' },
                { label: t('清空记忆', 'Clear memory'), action: 'memory-clear' },
              ],
            },
            { type: 'text', text: { $: 'data.hint' }, tone: 'muted' },
          ],
        }
      },
      data: (scope, emit, caps) => {
        const zh = !String(caps?.locale ?? '').startsWith('en')
        const t = (a, b) => (zh ? a : b)
        const tick = () => {
          const snap = store.snapshot()
          const id = scope?.sessionId
          const memoryLen = id ? (store.memoryCache.get(id) ?? '').length : 0
          const models = catalog.byProvider.get(viewingProvider) ?? []
          const pages = Math.max(1, Math.ceil(models.length / PAGE))
          const page = Math.min(modelPage, pages - 1)
          emit({
            today: snap.today,
            sessions: snap.sessions,
            model: `${store.config.provider}/${store.config.model}`,
            personaText: store.persona
              ? `${store.persona.name}${zh ? '（自定义）' : ' (custom)'}`
              : `${store.config.persona?.name ?? '小鱼'}${zh ? '（默认）' : ' (default)'}`,
            personaSize: store.persona ? `${store.persona.prompt.length} ${zh ? '字' : 'chars'}` : '—',
            memoryText: id ? `${memoryLen} ${zh ? '字' : 'chars'}` : (zh ? '打开对话后可见' : 'open a chat'),
            historyText: `${store.config.historyTurns ?? 10} ${zh ? '轮' : 'turns'}`,
            tokensText: `${store.config.maxTokens ?? 512}`,
            rateText: `${store.config.rateLimitPerMinute ?? 12}/${zh ? '分' : 'min'}`,
            catalogText: catalog.providers.length
              ? `${catalog.providers.length} ${zh ? '个渠道' : 'providers'} / ${models.length} ${zh ? '个模型' : 'models'}`
              : (catalog.error || (zh ? '读取中…' : 'loading…')),
            providerOptions: catalog.providers.length
              ? catalog.providers.map((p) => ({ value: p.id, label: p.name }))
              : [{ value: store.config.provider, label: store.config.provider }],
            modelOptions: models.length
              ? models.slice(page * PAGE, page * PAGE + PAGE).map((m) => ({ value: m.id, label: m.name }))
              : [{ value: store.config.model, label: store.config.model }],
            modelPageText: models.length > PAGE
              ? t(`${viewingProvider} · 第 ${page + 1}/${pages} 页`, `${viewingProvider} · ${page + 1}/${pages}`)
              : t(`渠道：${viewingProvider}`, viewingProvider),
            selectedProvider: viewingProvider,
            selectedModel: store.config.provider === viewingProvider ? store.config.model : '',
            history: String(store.config.historyTurns ?? 10),
            tokens: String(store.config.maxTokens ?? 512),
            rate: String(store.config.rateLimitPerMinute ?? 12),
            hint: zh
              ? '选完会自动试一句，能通才写入配置。人设在 data/persona.md。'
              : 'Picking a model sends a probe message first; only working ones are saved.',
          })
        }
        tick()
        const timer = setInterval(tick, 5000)
        return () => clearInterval(timer)
      },
      actions: {
        provider: async (scope, event) => {
          const id = event?.value?.value
          if (!id) return { toast: '没拿到渠道' }
          viewingProvider = id
          modelPage = 0
          try {
            await loadModels(id)
          } catch (error) {
            return { toast: `这个渠道读不到模型：${error?.message ?? error}` }
          }
          return { toast: `切换到 ${id}`, refresh: true }
        },
        model: async (scope, event) => {
          const id = event?.value?.value
          if (!id) return { toast: '没拿到模型' }
          try {
            await probeModel(viewingProvider, id)
          } catch (error) {
            return { toast: `这个模型不能用：${error?.message ?? error}` }
          }
          store.config.provider = viewingProvider
          store.config.model = id
          await store.saveConfig()
          return { toast: `已换成 ${id}`, refresh: true }
        },
        'model-prev': () => {
          modelPage = Math.max(0, modelPage - 1)
          return { refresh: true }
        },
        'model-next': () => {
          const total = (catalog.byProvider.get(viewingProvider) ?? []).length
          modelPage = Math.min(Math.max(0, Math.ceil(total / PAGE) - 1), modelPage + 1)
          return { refresh: true }
        },
        'catalog-refresh': async () => {
          await warm()
          return { toast: catalog.error || '目录已刷新', refresh: true }
        },
        history: async (scope, event) => {
          store.config.historyTurns = Number(event?.value?.value) || 10
          await store.saveConfig()
          return { toast: '上下文轮数已更新', refresh: true }
        },
        tokens: async (scope, event) => {
          store.config.maxTokens = Number(event?.value?.value) || 512
          await store.saveConfig()
          return { toast: '回复上限已更新', refresh: true }
        },
        rate: async (scope, event) => {
          store.config.rateLimitPerMinute = Number(event?.value?.value) || 12
          await store.saveConfig()
          return { toast: '限流已更新', refresh: true }
        },
        'reload-persona': async () => {
          store.persona = await store.loadPersona()
          return {
            toast: store.persona ? '人设已重载' : '没有 persona.md，用的是默认人设',
            refresh: true,
          }
        },
        'memory-compact': async (scope) => {
          const id = scope?.sessionId
          if (!id) return { toast: '请从对话详情页打开' }
          const llm = engine.get('llm')
          const session = store.session(id)
          const next = await summarizeMemory(llm, {
            previous: await store.getMemory(id),
            turns: [...(session.history ?? [])],
            provider: store.config.provider,
            model: store.config.model,
          })
          if (!next) return { toast: '这次没整理出内容' }
          await store.saveMemory(id, next)
          return { toast: `记忆已更新 ${next.length} 字`, refresh: true }
        },
        'memory-clear': async (scope) => {
          const id = scope?.sessionId
          if (!id) return { toast: '请从对话详情页打开' }
          await store.saveMemory(id, '')
          return { toast: '这个人的记忆已清空', refresh: true }
        },
      },
    })
  })
}
