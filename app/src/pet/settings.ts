interface CharacterSummary {
  id: string
  name: string
  /** 仅外观预设，骨架复用内置角色 */
  preset?: boolean
  /** 来自 Steam 创意工坊 */
  workshop?: boolean
}

interface WorkshopItem {
  /** Steam PublishedFileId */
  id: string
  title: string
  /** 缩略图 data URL */
  preview?: string
  required?: string[]
  /** 已添加为角色时的角色 id */
  characterId?: string
}

interface StageSummary {
  id: string
  characterId: string
  name: string
  /** 第一项为主角色，受「使用 / 切换」控制 */
  primary: boolean
}

interface SettingsState {
  size: number
  alwaysOnTop: boolean
  autostart: boolean
  visible: boolean
  autoActions: boolean
  autoActionMin: number
  autoActionMax: number
  clickAction: boolean
  /** 拖拽甩抛与弹跳形变 */
  throwPhysics: boolean
  currentCharacter: string
  characters: CharacterSummary[]
  /** 桌面上的角色阵容 */
  stage: StageSummary[]
  stageLimit: number
}

interface SettingsAPI {
  get: () => Promise<SettingsState>
  update: (patch: Partial<SettingsState>) => Promise<SettingsState>
  resetPosition: () => Promise<SettingsState>
  importCharacter: () => Promise<SettingsState>
  switchCharacter: (id: string) => Promise<SettingsState>
  renameCharacter: (id: string, name: string) => Promise<SettingsState>
  deleteCharacter: (id: string) => Promise<SettingsState>
  addInstance: (characterId: string) => Promise<SettingsState>
  removeInstance: (instanceId: string) => Promise<SettingsState>
  listWorkshop: () => Promise<WorkshopItem[]>
  addWorkshop: (id: string) => Promise<SettingsState>
  onChange: (cb: (state: SettingsState) => void) => void
}

declare global {
  interface Window {
    settingsAPI: SettingsAPI
  }
}

const TABS = ['characters', 'appearance', 'behavior', 'position'] as const
type Tab = (typeof TABS)[number]

let state: SettingsState | null = null
let editingId: string | null = null
/** 角色列表没有变化时不重建 DOM，避免重命名输入框被打断 */
let listSignature = ''
let sizeDragging = false
let sizeTimer: number | undefined
/** 创意工坊扫描结果，null 表示尚未加载 */
let workshopItems: WorkshopItem[] | null = null
let workshopLoading = false
/** 阵容为空时只自动补拉一次，避免渲染循环 */
let stageRepairing = false

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?'
}

async function apply(patch: Partial<SettingsState>): Promise<void> {
  state = await window.settingsAPI.update(patch)
  render()
}

function bindTabs(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('nav button'))
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab as Tab
      for (const b of buttons) b.classList.toggle('active', b === btn)
      for (const id of TABS) el(`tab-${id}`).hidden = id !== tab
      const panel = el<HTMLElement>(`tab-${tab}`)
      if (panel instanceof HTMLElement) panel.parentElement?.scrollTo({ top: 0 })
      // 每次进入角色页都静默重扫一次，Steam 更新后能及时看到最新列表
      if (tab === 'characters') void loadWorkshop(true)
    })
  }
  // 设置窗口重新获得焦点时也刷新（扫描有 mtime 缓存，命中时只做 stat）
  window.addEventListener('focus', () => {
    void loadWorkshop(true)
  })
}

function bindAppearance(): void {
  const range = el<HTMLInputElement>('size-range')
  const value = el('size-value')

  range.addEventListener('input', () => {
    sizeDragging = true
    value.textContent = `${range.value} px`
    window.clearTimeout(sizeTimer)
    // 拖动过程中不必每帧都发 IPC，停一下再同步
    sizeTimer = window.setTimeout(() => {
      const size = Number(range.value)
      window.settingsAPI.update({ size }).then((next) => {
        state = next
        sizeDragging = false
        render()
      })
    }, 90)
  })

  el<HTMLInputElement>('always-on-top').addEventListener('change', (e) => {
    void apply({ alwaysOnTop: (e.target as HTMLInputElement).checked })
  })
  el<HTMLInputElement>('visible').addEventListener('change', (e) => {
    void apply({ visible: (e.target as HTMLInputElement).checked })
  })
}

function bindBehavior(): void {
  el<HTMLInputElement>('auto-actions').addEventListener('change', (e) => {
    void apply({ autoActions: (e.target as HTMLInputElement).checked })
  })
  el<HTMLInputElement>('click-action').addEventListener('change', (e) => {
    void apply({ clickAction: (e.target as HTMLInputElement).checked })
  })
  el<HTMLInputElement>('throw-physics').addEventListener('change', (e) => {
    void apply({ throwPhysics: (e.target as HTMLInputElement).checked })
  })
  el<HTMLInputElement>('auto-min').addEventListener('change', (e) => {
    void apply({ autoActionMin: Number((e.target as HTMLInputElement).value) })
  })
  el<HTMLInputElement>('auto-max').addEventListener('change', (e) => {
    void apply({ autoActionMax: Number((e.target as HTMLInputElement).value) })
  })
}

function bindCharacters(): void {
  const importBtn = el<HTMLButtonElement>('import-btn')
  importBtn.addEventListener('click', async () => {
    importBtn.disabled = true
    importBtn.textContent = '导入中…'
    try {
      state = await window.settingsAPI.importCharacter()
      render()
    } finally {
      importBtn.disabled = false
      importBtn.textContent = '导入角色…'
    }
  })
}

function bindWorkshop(): void {
  el<HTMLButtonElement>('workshop-refresh').addEventListener('click', () => {
    void loadWorkshop(true)
  })
}

async function loadWorkshop(force = false): Promise<void> {
  if (workshopLoading) return
  if (workshopItems !== null && !force) return
  workshopLoading = true
  const refresh = el<HTMLButtonElement>('workshop-refresh')
  refresh.disabled = true
  try {
    workshopItems = await window.settingsAPI.listWorkshop()
  } catch (err) {
    console.error('[Settings] workshop scan failed:', err)
    workshopItems = []
  } finally {
    workshopLoading = false
    refresh.disabled = false
    renderWorkshop()
  }
}

function workshopMeta(item: WorkshopItem): string {
  if (item.characterId === state?.currentCharacter) return '正在使用'
  if (item.characterId) return '已添加'
  if (item.required && item.required.length > 0) return `需要 ${item.required.length} 个前置工坊项目`
  return `PublishedFileId ${item.id}`
}

function renderWorkshop(): void {
  const list = el('workshop-list')
  const tip = el('workshop-tip')
  list.textContent = ''
  tip.hidden = true

  if (workshopItems === null) {
    const row = document.createElement('div')
    row.className = 'empty-row'
    row.textContent = '正在扫描创意工坊内容…'
    list.appendChild(row)
    return
  }

  if (workshopItems.length === 0) {
    const row = document.createElement('div')
    row.className = 'empty-row'
    row.textContent = '未在 Steam 创意工坊中找到 EmoteLab 角色。'
    list.appendChild(row)
    tip.hidden = false
    tip.textContent = '需要先在 Steam 中订阅并下载 EmoteLab（AppID 4301100）的创意工坊角色。'
    return
  }

  for (const item of workshopItems) {
    const row = document.createElement('div')
    row.className = 'item'

    if (item.preview) {
      const img = document.createElement('img')
      img.className = 'workshop-preview'
      img.src = item.preview
      img.alt = ''
      row.appendChild(img)
    } else {
      const placeholder = document.createElement('div')
      placeholder.className = 'workshop-placeholder'
      placeholder.textContent = '工'
      row.appendChild(placeholder)
    }

    const meta = document.createElement('div')
    meta.className = 'meta'
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = item.title
    const sub = document.createElement('div')
    sub.className = 'sub'
    sub.textContent = workshopMeta(item)
    meta.append(name, sub)
    row.appendChild(meta)

    const actions = document.createElement('div')
    actions.className = 'item-actions'
    const inUse = item.characterId === state?.currentCharacter
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = item.characterId ? 'ghost' : 'primary'
    btn.textContent = inUse ? '使用中' : item.characterId ? '切换' : '添加'
    btn.disabled = inUse
    btn.addEventListener('click', async () => {
      btn.disabled = true
      // 已添加的项目也走 addWorkshop：主进程会先比对 elpack 修改时间，
      // Steam 更新过内容就重新解包，再切换过去
      btn.textContent = item.characterId ? '切换中…' : '添加中…'
      try {
        state = await window.settingsAPI.addWorkshop(item.id)
        await loadWorkshop(true)
        render()
      } finally {
        btn.disabled = false
      }
    })
    actions.appendChild(btn)
    row.appendChild(actions)
    list.appendChild(row)
  }
}

function bindPosition(): void {
  const btn = el<HTMLButtonElement>('reset-position')
  btn.addEventListener('click', async () => {
    state = await window.settingsAPI.resetPosition()
    render()
    btn.textContent = '已重置'
    window.setTimeout(() => {
      btn.textContent = '重置位置'
    }, 1200)
  })
}

function renderCurrent(): void {
  if (!state) return
  const current =
    state.characters.find((c) => c.id === state!.currentCharacter) ?? state.characters[0]
  if (!current) return
  el('current-avatar').textContent = initial(current.name)
  el('current-name').textContent = current.name
  el('current-sub').textContent = current.workshop
    ? '创意工坊角色'
    : current.id === 'default'
      ? '内置角色'
      : '导入角色'
}

function commitRename(id: string, name: string, cancelled: () => boolean): void {
  if (cancelled()) return
  editingId = null
  const trimmed = name.trim()
  if (!trimmed) {
    renderCharacters(true)
    return
  }
  window.settingsAPI.renameCharacter(id, trimmed).then((next) => {
    state = next
    render()
  })
}

function renderStage(): void {
  if (!state) return
  const list = el('stage-list')
  const count = el('stage-count')
  const stage = state.stage ?? []
  count.textContent = `${stage.length} / ${state.stageLimit}`
  list.textContent = ''

  if (stage.length === 0) {
    const row = document.createElement('div')
    row.className = 'empty-row'
    row.textContent = '正在读取阵容…'
    list.appendChild(row)
    // 启动时序可能导致首帧拿到空数组，补拉一次
    if (!stageRepairing) {
      stageRepairing = true
      void window.settingsAPI
        .get()
        .then((next) => {
          state = next
          stageRepairing = false
          render()
        })
        .catch(() => {
          stageRepairing = false
        })
    }
    return
  }

  for (const item of stage) {
    const row = document.createElement('div')
    row.className = 'item'

    const avatar = document.createElement('div')
    avatar.className = 'avatar'
    avatar.textContent = initial(item.name)
    row.appendChild(avatar)

    const meta = document.createElement('div')
    meta.className = 'meta'
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = item.name
    const sub = document.createElement('div')
    sub.className = 'sub'
    sub.textContent = item.primary ? '主角色 · 使用与切换作用于这一只' : '桌面上'
    meta.append(name, sub)
    row.appendChild(meta)

    if (!item.primary) {
      const actions = document.createElement('div')
      actions.className = 'item-actions'
      const removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.className = 'danger'
      removeBtn.textContent = '移除'
      removeBtn.addEventListener('click', async () => {
        state = await window.settingsAPI.removeInstance(item.id)
        render()
      })
      actions.appendChild(removeBtn)
      row.appendChild(actions)
    }

    list.appendChild(row)
  }
}

function renderCharacters(force = false): void {
  if (!state) return
  const signature = JSON.stringify([
    state.characters,
    state.currentCharacter,
    editingId,
    (state.stage ?? []).map((s) => `${s.characterId}:${s.id}`),
  ])
  if (!force && signature === listSignature) return
  listSignature = signature

  const list = el('character-list')
  list.textContent = ''

  for (const character of state.characters) {
    const isCurrent = character.id === state.currentCharacter
    const item = document.createElement('div')
    item.className = `item${isCurrent ? ' current' : ''}`

    const avatar = document.createElement('div')
    avatar.className = 'avatar'
    avatar.textContent = initial(character.name)
    item.appendChild(avatar)

    if (editingId === character.id) {
      const input = document.createElement('input')
      input.className = 'rename-input'
      input.value = character.name
      input.maxLength = 24
      let cancelled = false

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          input.blur()
        } else if (e.key === 'Escape') {
          cancelled = true
          editingId = null
          renderCharacters(true)
        }
      })
      input.addEventListener('blur', () => commitRename(character.id, input.value, () => cancelled))

      item.appendChild(input)
      list.appendChild(item)
      input.focus()
      input.select()
      continue
    }

    const meta = document.createElement('div')
    meta.className = 'meta'
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = character.name
    const sub = document.createElement('div')
    sub.className = 'sub'
    const base = isCurrent
      ? '正在使用'
      : character.id === 'default'
        ? '内置角色'
        : character.workshop
          ? '创意工坊角色'
          : character.preset
            ? '外观预设'
            : '已导入'
    // 已上场的角色在列表里也标出来，避免看不出默认主角色就在桌上
    const onStage = (state.stage ?? []).filter((s) => s.characterId === character.id).length
    sub.textContent =
      !isCurrent && onStage > 0 ? `${base} · 已上场${onStage > 1 ? ` ×${onStage}` : ''}` : base
    meta.append(name, sub)
    item.appendChild(meta)

    const actions = document.createElement('div')
    actions.className = 'item-actions'

    const useBtn = document.createElement('button')
    useBtn.type = 'button'
    useBtn.className = 'ghost'
    useBtn.textContent = isCurrent ? '使用中' : '使用'
    useBtn.disabled = isCurrent
    useBtn.addEventListener('click', async () => {
      state = await window.settingsAPI.switchCharacter(character.id)
      render()
    })
    actions.appendChild(useBtn)

    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'ghost'
    addBtn.textContent = '上场'
    addBtn.disabled = (state.stage?.length ?? 0) >= state.stageLimit
    addBtn.addEventListener('click', async () => {
      state = await window.settingsAPI.addInstance(character.id)
      render()
    })
    actions.appendChild(addBtn)

    if (character.id !== 'default') {
      const renameBtn = document.createElement('button')
      renameBtn.type = 'button'
      renameBtn.className = 'ghost'
      renameBtn.textContent = '重命名'
      renameBtn.addEventListener('click', () => {
        editingId = character.id
        renderCharacters(true)
      })
      actions.appendChild(renameBtn)

      const deleteBtn = document.createElement('button')
      deleteBtn.type = 'button'
      deleteBtn.className = 'danger'
      deleteBtn.textContent = '删除'
      deleteBtn.addEventListener('click', async () => {
        state = await window.settingsAPI.deleteCharacter(character.id)
        render()
      })
      actions.appendChild(deleteBtn)
    }

    item.appendChild(actions)
    list.appendChild(item)
  }
}

function renderAppearance(): void {
  if (!state) return
  if (!sizeDragging) {
    el<HTMLInputElement>('size-range').value = String(state.size)
    el('size-value').textContent = `${state.size} px`
  }
  el<HTMLInputElement>('always-on-top').checked = state.alwaysOnTop
  el<HTMLInputElement>('visible').checked = state.visible
}

function renderBehavior(): void {
  if (!state) return
  el<HTMLInputElement>('auto-actions').checked = state.autoActions
  el<HTMLInputElement>('click-action').checked = state.clickAction
  el<HTMLInputElement>('throw-physics').checked = state.throwPhysics
  const min = el<HTMLInputElement>('auto-min')
  const max = el<HTMLInputElement>('auto-max')
  min.value = String(state.autoActionMin)
  max.value = String(state.autoActionMax)
  min.disabled = !state.autoActions
  max.disabled = !state.autoActions
}

function render(): void {
  if (!state) return
  renderCurrent()
  renderStage()
  renderCharacters()
  renderAppearance()
  renderBehavior()
  renderWorkshop()
}

async function init(): Promise<void> {
  bindTabs()
  bindAppearance()
  bindBehavior()
  bindCharacters()
  bindWorkshop()
  bindPosition()

  window.settingsAPI.onChange((next) => {
    state = next
    render()
  })

  state = await window.settingsAPI.get()
  render()
  void loadWorkshop()
}

init().catch((err) => {
  console.error('[Settings] init failed:', err)
  document.body.textContent = `设置加载失败：${(err as Error).message}`
})

export {}
