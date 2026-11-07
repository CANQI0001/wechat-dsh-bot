import { summarizeMemory } from './bridge/model.js'

// 回复速率的预设：first = 第一条延迟，gap = 后续分段间隔
const SPEED_PRESETS = {
  instant: { zh: '秒回', en: 'Instant', first: [300, 800], gap: [200, 500] },
  fast: { zh: '快', en: 'Fast', first: [600, 1400], gap: [400, 800] },
  normal: { zh: '正常', en: 'Normal', first: [2000, 5000], gap: [800, 2000] },
  slow: { zh: '慢', en: 'Slow', first: [5000, 9000], gap: [2000, 4000] },
  lazy: { zh: '很慢', en: 'Lazy', first: [9000, 15000], gap: [3000, 6000] },
}

const DAILY_TIMES = ['08:30', '12:30', '18:00', '21:00', '22:30']

function matchSpeed(segments) {
  const first = segments?.firstDelayMs ?? []
  for (const [key, preset] of Object.entries(SPEED_PRESETS)) {
    if (first[0] === preset.first[0] && first[1] === preset.first[1]) return key
  }
  return 'custom'
}

function ago(ms, zh) {
  if (!ms) return zh ? '还没收到' : 'never'
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return zh ? `${s} 秒前` : `${s}s ago`
  if (s < 3600) return zh ? `${Math.floor(s / 60)} 分钟前` : `${Math.floor(s / 60)}m ago`
  return zh ? `${Math.floor(s / 3600)} 小时前` : `${Math.floor(s / 3600)}h ago`
}

export function installPanels(ctx, { store, state }) {
  const engine = ctx
  ctx.inject(['dshGo'], (ctx) => {
    // ══ 1. 微信连接 ═══════════════════════════════════════════
    ctx.dshGo.panel('wechat', {
      view: (scope, caps) => {
        const zh = !String(caps?.locale ?? '').startsWith('en')
        const t = (a, b) => (zh ? a : b)
        return {
          type: 'stack',
          title: t('微信连接', 'WeChat'),
          children: [
            { type: 'callout', text: { $: 'data.stateText' }, tone: { $: 'data.stateTone' } },
            {
              type: 'row',
              children: [
                { type: 'metric', label: t('今日来信', 'Today'), value: { $: 'data.today' } },
                { type: 'metric', label: t('最近延迟', 'Lag'), value: { $: 'data.lagText' }, tone: { $: 'data.lagTone' } },
              ],
            },
            { type: 'text', text: t('谁可以聊', 'Who can chat') },
            { type: 'list', items: { $: 'data.whitelistItems' } },
            {
              type: 'actions',
              items: [
                { label: t('加入最近来信的人', 'Add last sender'), action: 'add-last', style: 'primary' },
                { label: t('重载名单', 'Reload'), action: 'reload-all' },
                { label: t('清空', 'Clear'), action: 'clear-whitelist' },
              ],
            },
            { type: 'text', text: t('回复节奏', 'Pace') },
            {
              type: 'options',
              id: 'speed',
              selected: { $: 'data.speed' },
              options: Object.entries(SPEED_PRESETS).map(([value, p]) => ({ value, label: t(p.zh, p.en) })),
            },
            {
              type: 'row',
              children: [
                { type: 'options', id: 'seg-count', selected: { $: 'data.segCount' }, options: ['1', '2', '3'].map((v) => ({ value: v, label: t(`${v} 段`, `${v}`) })) },
                { type: 'options', id: 'seg-len', selected: { $: 'data.segLen' }, options: ['15', '20', '25'].map((v) => ({ value: v, label: t(`${v} 字`, `${v}`) })) },
              ],
            },
            {
              type: 'actions',
              items: [{ label: t('暂停 / 继续', 'Pause / resume'), action: 'toggle-pause' }],
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
            subtitle: store.sessions.get(id)?.name && store.sessions.get(id).name !== id ? store.sessions.get(id).name : (zh ? '私聊' : 'direct'),
            trailing: zh ? '移除' : 'remove',
            action: { id: 'remove-whitelist', args: { wxid: id } },
          }))
          for (const id of store.whitelist.groups ?? []) {
            items.push({ title: id, subtitle: zh ? '群聊' : 'group', trailing: zh ? '移除' : 'remove', action: { id: 'remove-whitelist', args: { wxid: id } } })
          }
          const lag = store.moduleInfo.lastLag
          emit({
            speed: matchSpeed(seg),
            segCount: String(seg.max ?? 2),
            segLen: String(seg.maxLen ?? 15),
            whitelistItems: items.length ? items : [{ title: zh ? '还没有白名单' : 'Empty', subtitle: zh ? '谁都不会被回复' : 'nobody answered', tone: 'warn' }],
            stateText: state.running
              ? store.config.paused
                ? (zh ? '已暂停：收到消息也不回' : 'Paused')
                : (zh ? '运行中，收到白名单里的消息就回' : 'Running')
              : (state.error ? (zh ? `启动失败：${state.error}` : `Failed: ${state.error}`) : (zh ? '未启动' : 'Not running')),
            stateTone: state.running && !store.config.paused ? 'good' : 'warn',
            today: String(store.snapshot().today ?? 0),
            lagText: lag >= 0 ? `${lag}s` : '—',
            lagTone: lag >= 0 && lag <= 10 ? 'good' : lag >= 0 ? 'warn' : 'muted',
            hint: store.lastInbound
              ? (zh ? `最近来信：${store.lastInbound.name || store.lastInbound.senderId} · ${ago(store.lastInbound.at, zh)}` : `Last: ${store.lastInbound.senderId}`)
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
          return { toast: `已加入 ${last.name || id}`, refresh: true }
        },
        'remove-whitelist': async (scope, event) => {
          const id = event?.value?.wxid
          if (!id) return { toast: '没拿到要移除的 id' }
          store.whitelist.private = (store.whitelist.private ?? []).filter((x) => x !== id)
          store.whitelist.groups = (store.whitelist.groups ?? []).filter((x) => x !== id)
          await store.saveWhitelist()
          return { toast: '已移除', refresh: true }
        },
        'clear-whitelist': async () => {
          store.whitelist.private = []
          store.whitelist.groups = []
          await store.saveWhitelist()
          return { toast: '白名单已清空', refresh: true }
        },
        'reload-all': async () => {
          await store.reloadWhitelist()
          store.persona = await store.loadPersona()
          return { toast: '已重载', refresh: true }
        },
        'toggle-pause': async () => {
          store.config.paused = !store.config.paused
          await store.saveConfig()
          return { toast: store.config.paused ? '已暂停' : '已继续', refresh: true }
        },
        speed: async (scope, event) => {
          const preset = SPEED_PRESETS[event?.value?.value]
          if (!preset) return { toast: '未知速率' }
          store.config.segments = { ...(store.config.segments ?? {}), firstDelayMs: [...preset.first], segmentDelayMs: [...preset.gap] }
          await store.saveConfig()
          return { toast: `速率：${preset.zh}`, refresh: true }
        },
        'seg-count': async (scope, event) => {
          store.config.segments = { ...(store.config.segments ?? {}), max: Number(event?.value?.value) || 1 }
          await store.saveConfig()
          return { toast: '分段数已更新', refresh: true }
        },
        'seg-len': async (scope, event) => {
          const len = Math.max(5, Math.min(30, Number(event?.value?.value) || 15))
          store.config.segments = { ...(store.config.segments ?? {}), maxLen: len }
          await store.saveConfig()
          return { toast: `每段最多 ${len} 字`, refresh: true }
        },
      },
    })

    // ══ 2. 模型 ═══════════════════════════════════════════════
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

    // 识图模型：从目录里挑名字带 vl / vision 的
    const visionCandidates = (provider, t) => {
      const all = catalog.byProvider.get(provider) ?? []
      const hits = all.filter((m) => /vl|vision|glm-4\.\d+v|internvl/i.test(m.id))
      // 引擎目录里通常没有视觉模型，给一份实测可用的清单兜底
      const known = [
        { id: 'Qwen/Qwen3-VL-8B-Instruct', name: 'Qwen3-VL 8B（快、便宜）' },
        { id: 'Qwen/Qwen3-VL-30B-A3B-Instruct', name: 'Qwen3-VL 30B' },
        { id: 'Qwen/Qwen3-VL-32B-Instruct', name: 'Qwen3-VL 32B（更准、更慢）' },
        { id: 'zai-org/GLM-4.5V', name: 'GLM-4.5V' },
      ]
      const list = hits.length ? hits : known
      const current = store.config.vision?.model
      if (current && !list.some((m) => m.id === current)) list.unshift({ id: current, name: current })
      return list.length ? list.map((m) => ({ value: m.id, label: m.name })) : [{ value: '', label: t('这个渠道没有识图模型', 'no vision model here') }]
    }

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
          title: t('模型与记忆', 'Model'),
          children: [
            {
              type: 'keyValue',
              items: [
                [t('当前模型', 'Current'), { $: 'data.model' }],
                [t('人设', 'Persona'), { $: 'data.personaText' }],
                [t('记忆', 'Memory'), { $: 'data.memoryText' }],
                [t('上下文', 'Context'), { $: 'data.historyText' }],
                [t('回复上限', 'Max tokens'), { $: 'data.tokensText' }],
                [t('限流', 'Rate'), { $: 'data.rateText' }],
                [t('识图模型', 'Vision'), { $: 'data.visionText' }],
              ],
            },
            { type: 'text', text: t('换渠道', 'Provider') },
            { type: 'options', id: 'provider', selected: { $: 'data.selectedProvider' }, options: { $: 'data.providerOptions' } },
            { type: 'text', text: { $: 'data.modelPageText' } },
            { type: 'options', id: 'model', selected: { $: 'data.selectedModel' }, options: { $: 'data.modelOptions' } },
            {
              type: 'actions',
              items: [
                { label: t('上一页', 'Prev'), action: 'model-prev' },
                { label: t('下一页', 'Next'), action: 'model-next' },
                { label: t('刷新', 'Refresh'), action: 'catalog-refresh' },
              ],
            },
            { type: 'text', text: t('识图服务商（只影响发图，不影响聊天）', 'Vision provider') },
            { type: 'options', id: 'visionProvider', selected: { $: 'data.selectedVisionProvider' }, options: { $: 'data.visionProviderOptions' } },
            { type: 'text', text: t('识图模型（对方发图时用）', 'Vision model') },
            { type: 'options', id: 'vision', selected: { $: 'data.selectedVision' }, options: { $: 'data.visionOptions' } },
            { type: 'text', text: t('记忆与上下文', 'Memory') },
            {
              type: 'options',
              id: 'history',
              selected: { $: 'data.history' },
              options: ['4', '6', '10', '16'].map((v) => ({ value: v, label: t(`${v} 轮`, `${v} turns`) })),
            },
            {
              type: 'options',
              id: 'rate',
              selected: { $: 'data.rate' },
              options: ['6', '12', '30'].map((v) => ({ value: v, label: t(`${v}/分`, `${v}/min`) })),
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
          const id = scope?.sessionId
          const memoryLen = id ? (store.memoryCache.get(id) ?? '').length : 0
          const models = catalog.byProvider.get(viewingProvider) ?? []
          const pages = Math.max(1, Math.ceil(models.length / PAGE))
          const page = Math.min(modelPage, pages - 1)
          emit({
            model: `${store.config.provider}/${store.config.model}`,
            personaText: store.persona ? `${store.persona.name}${zh ? '（自定义）' : ' (custom)'}` : `${store.config.persona?.name ?? '小鱼'}${zh ? '（默认）' : ' (default)'}`,
            memoryText: id ? `${memoryLen} ${zh ? '字' : 'chars'}` : (zh ? '打开对话后可见' : 'open a chat'),
            historyText: `${store.config.historyTurns ?? 10} ${zh ? '轮' : 'turns'}`,
            tokensText: `${store.config.maxTokens ?? 512}`,
            rateText: `${store.config.rateLimitPerMinute ?? 12}/${zh ? '分' : 'min'}`,
            providerOptions: catalog.providers.length ? catalog.providers.map((p) => ({ value: p.id, label: p.name })) : [{ value: store.config.provider, label: store.config.provider }],
            modelOptions: models.length ? models.slice(page * PAGE, page * PAGE + PAGE).map((m) => ({ value: m.id, label: m.name })) : [{ value: store.config.model, label: store.config.model }],
            modelPageText: models.length > PAGE ? t(`${viewingProvider} · ${page + 1}/${pages}`, `${viewingProvider} · ${page + 1}/${pages}`) : t(`渠道：${viewingProvider}`, viewingProvider),
            selectedProvider: viewingProvider,
            selectedModel: store.config.provider === viewingProvider ? store.config.model : '',
            history: String(store.config.historyTurns ?? 10),
            rate: String(store.config.rateLimitPerMinute ?? 12),
            visionText: store.config.vision?.model || t('没配（发图只会回占位）', 'none'),
            selectedVision: store.config.vision?.model || '',
            visionOptions: visionCandidates(viewingProvider, t),
            selectedVisionProvider: store.config.vision?.provider || '',
            visionProviderOptions: Array.from(catalog.byProvider.keys()).map((id) => ({ value: id, label: id })),
            hint: catalog.error ? `${t('目录读取失败', 'Catalog error')}: ${catalog.error}` : (zh ? '选模型会先试发一句，能通才保存' : 'A probe message is sent before saving a model.'),
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
            return { toast: `读不到模型：${error?.message ?? error}` }
          }
          return { toast: `切换到 ${id}`, refresh: true }
        },
        model: async (scope, event) => {
          const id = event?.value?.value
          if (!id) return { toast: '没拿到模型' }
          try {
            await probeModel(viewingProvider, id)
          } catch (error) {
            return { toast: `不能用：${error?.message ?? error}` }
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
        'vision-provider': async (scope, event) => {
          const id = event?.value?.value
          if (!id) return { toast: '没拿到服务商' }
          store.config.vision = { ...(store.config.vision ?? {}), provider: id, model: '' }
          await store.saveConfig()
          return { toast: `识图改用 ${id}`, refresh: true }
        },
        vision: async (scope, event) => {
          const id = event?.value?.value
          if (!id) return { toast: '没拿到模型' }
          try {
            await probeModel(store.config.vision?.provider || viewingProvider, id)
          } catch (error) {
            return { toast: `这个识图模型不能用：${error?.message ?? error}` }
          }
          store.config.vision = { provider: store.config.vision?.provider || viewingProvider, model: id }
          await store.saveConfig()
          return { toast: `识图用 ${id}`, refresh: true }
        },
        'catalog-refresh': async () => {
          await warm()
          return { toast: catalog.error || '已刷新', refresh: true }
        },
        history: async (scope, event) => {
          store.config.historyTurns = Number(event?.value?.value) || 10
          await store.saveConfig()
          return { toast: '已更新', refresh: true }
        },
        rate: async (scope, event) => {
          store.config.rateLimitPerMinute = Number(event?.value?.value) || 12
          await store.saveConfig()
          return { toast: '已更新', refresh: true }
        },
        'reload-persona': async () => {
          store.persona = await store.loadPersona()
          return { toast: store.persona ? '人设已重载' : '没有 persona.md，用默认人设', refresh: true }
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
          return { toast: '已清空', refresh: true }
        },
      },
    })

    // ══ 3. 模块（单独一页） ══════════════════════════════════
    ctx.dshGo.panel('module', {
      view: (scope, caps) => {
        const zh = !String(caps?.locale ?? '').startsWith('en')
        const t = (a, b) => (zh ? a : b)
        return {
          type: 'stack',
          title: t('微信模块', 'Module'),
          children: [
            { type: 'callout', text: { $: 'data.headline' }, tone: { $: 'data.headlineTone' } },
            {
              type: 'row',
              children: [
                { type: 'metric', label: t('版本', 'Version'), value: { $: 'data.version' } },
                { type: 'metric', label: t('最近延迟', 'Lag'), value: { $: 'data.lag' }, tone: { $: 'data.lagTone' } },
              ],
            },
            {
              type: 'keyValue',
              items: [
                [t('收消息', 'Receive'), { $: 'data.dbHook' }],
                [t('后台保活', 'Keep-alive'), { $: 'data.keepAlive' }],
                [t('桥接', 'Bridge'), { $: 'data.bridge' }],
                [t('最后一条', 'Last'), { $: 'data.lastLine' }],
                [t('更新时间', 'Updated'), { $: 'data.updated' }],
              ],
            },
            { type: 'actions', items: [{ label: t('刷新', 'Refresh'), action: 'module-refresh' }] },
            { type: 'text', text: t('这页只读：数据来自模块日志。重装模块后刷新一下。', 'Read-only: values come from module logs.'), tone: 'muted' },
          ],
        }
      },
      data: (scope, emit, caps) => {
        const zh = !String(caps?.locale ?? '').startsWith('en')
        const t = (a, b) => (zh ? a : b)
        const tick = () => {
          const info = store.moduleInfo
          const lag = info.lastLag
          const stale = info.updatedAt && Date.now() - info.updatedAt > 10 * 60_000
          emit({
            version: info.version || '—',
            lag: lag >= 0 ? `${lag}s` : '—',
            lagTone: lag >= 0 && lag <= 10 ? 'good' : lag >= 0 ? 'warn' : 'muted',
            dbHook: info.dbHook ? t('已挂', 'hooked') : t('还没挂', 'not yet'),
            keepAlive: info.keepAlive ? t('已启动', 'on') : t('没启动', 'off'),
            bridge: state.running ? t('在线', 'online') : t('离线', 'offline'),
            lastLine: info.lastLine || '—',
            updated: ago(info.updatedAt, zh),
            headline: stale
              ? t('很久没收到模块日志了：微信可能没在跑，或模块被停用', 'No module logs for a while')
              : info.keepAlive
                ? t('模块正常，后台保活中', 'Module running, keep-alive on')
                : t('模块在线，但保活没启动：后台可能延迟一两分钟', 'Online, keep-alive off'),
            headlineTone: stale ? 'warn' : info.keepAlive ? 'good' : 'warn',
          })
        }
        tick()
        const timer = setInterval(tick, 5000)
        return () => clearInterval(timer)
      },
      actions: {
        'module-refresh': async () => ({ toast: '已刷新', refresh: true }),
      },
    })

    // ══ 4. 每日趣事 ═══════════════════════════════════════════
    ctx.dshGo.panel('daily', {
      view: (scope, caps) => {
        const zh = !String(caps?.locale ?? '').startsWith('en')
        const t = (a, b) => (zh ? a : b)
        return {
          type: 'stack',
          title: t('每日趣事', 'Daily'),
          children: [
            { type: 'callout', text: { $: 'data.stateText' }, tone: { $: 'data.stateTone' } },
            {
              type: 'keyValue',
              items: [
                [t('发送时间', 'Time'), { $: 'data.time' }],
                [t('发给谁', 'To'), { $: 'data.target' }],
                [t('上次发送', 'Last sent'), { $: 'data.lastSent' }],
              ],
            },
            {
              type: 'actions',
              items: [
                { label: t('开 / 关', 'Toggle'), action: 'toggle', style: 'primary' },
                { label: t('现在就讲一条', 'Send now'), action: 'now' },
              ],
            },
            { type: 'text', text: t('什么时候讲', 'Time') },
            { type: 'options', id: 'time', selected: { $: 'data.selectedTime' }, options: DAILY_TIMES.map((v) => ({ value: v, label: v })) },
            { type: 'text', text: t('讲给谁听', 'Target') },
            { type: 'options', id: 'target', selected: { $: 'data.selectedTarget' }, options: { $: 'data.targetOptions' } },
            { type: 'text', text: t('她从热榜挑一件讲，用自己的话，不是复述标题。政治灾难类会跳过。', 'Picks one trending item, tells it her way.'), tone: 'muted' },
          ],
        }
      },
      data: (scope, emit, caps) => {
        const zh = !String(caps?.locale ?? '').startsWith('en')
        const t = (a, b) => (zh ? a : b)
        const tick = () => {
          const daily = store.config.daily ?? {}
          const targets = (store.whitelist.private ?? []).map((id) => ({
            value: id,
            label: store.sessions.get(id)?.name && store.sessions.get(id).name !== id ? store.sessions.get(id).name : id,
          }))
          const target = daily.target || store.lastInbound?.senderId || ''
          emit({
            stateText: daily.enabled ? t(`每天 ${daily.time} 讲一件`, `Daily at ${daily.time}`) : t('关着：不会主动说话', 'Off'),
            stateTone: daily.enabled ? 'good' : 'muted',
            time: daily.time || '—',
            target: target || t('还没定', 'unset'),
            lastSent: daily.lastSentDay || t('还没发过', 'never'),
            selectedTime: daily.time || '09:30',
            selectedTarget: target,
            targetOptions: targets.length ? targets : [{ value: '', label: t('先让白名单里有人', 'add someone first') }],
          })
        }
        tick()
        const timer = setInterval(tick, 5000)
        return () => clearInterval(timer)
      },
      actions: {
        toggle: async () => {
          const daily = (store.config.daily ??= {})
          daily.enabled = !daily.enabled
          await store.saveConfig()
          return { toast: daily.enabled ? `已开启，每天 ${daily.time}` : '已关闭', refresh: true }
        },
        now: async () => {
          try {
            const res = await fetch(`http://127.0.0.1:${store.config.port}/api/daily/now`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...(store.config.token ? { 'x-bridge-token': store.config.token } : {}) },
              body: '{}',
            })
            const json = await res.json()
            if (json.type === 'error') return { toast: json.message }
            return { toast: `已排队：${json.segments.join(' / ').slice(0, 40)}`, refresh: true }
          } catch (error) {
            return { toast: `失败：${error?.message ?? error}` }
          }
        },
        time: async (scope, event) => {
          const v = event?.value?.value
          if (!v) return { toast: '没拿到时间' }
          store.config.daily = { ...(store.config.daily ?? {}), time: v }
          await store.saveConfig()
          return { toast: `每天 ${v}`, refresh: true }
        },
        target: async (scope, event) => {
          const v = event?.value?.value
          if (!v) return { toast: '还没选人' }
          store.config.daily = { ...(store.config.daily ?? {}), target: v }
          await store.saveConfig()
          return { toast: '已设置', refresh: true }
        },
      },
    })
  })
}
