import { app, BrowserWindow, ipcMain, Menu, screen, dialog, protocol, net, Tray, Notification, nativeImage, shell } from 'electron'
import { join, resolve, dirname, basename, sep } from 'path'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { format } from 'util'
import { localizeAnimationGroup, localizeAnimationName } from './animation-labels'
import { extractElpack } from './elpack'
import { scanWorkshopCharacters } from './workshop'
import { pathToFileURL } from 'url'
import { spawn } from 'child_process'

/** 导入的 EmoteLab 角色目录及其中识别到的骨架文件 */
interface CharacterEntry {
  id: string
  name: string
  dir: string
  /** 导入时的原始目录或预设 json，用于去重；旧配置可能没有 */
  source?: string
  skel: string
  atlas: string
  /** 仅导入外观预设 json：骨架复用内置 CoffeeBean，资源目录里只有 character.json */
  preset?: boolean
  /** 创意工坊角色包：预设 + Regions 自定义贴图，骨架仍复用内置 CoffeeBean */
  model?: 'default'
  /** 来自 Steam 创意工坊目录（而不是用户手动选择的 .elpack 文件） */
  kind?: 'workshop'
  publishedFileId?: string
  /** 上次解包时 character.elpack 的修改时间，用于工坊更新后重新解包 */
  sourceMtime?: number
}

/** 传给渲染进程的角色描述 */
interface CharacterInfo {
  id: string
  name: string
  baseUrl: string
  skel: string
  atlas: string
  meta: string | null
  /** 预设角色的 character.json 与骨架不在同一目录，这里给出完整地址 */
  metaUrl?: string
  /** 复用内置 CoffeeBean 骨架，渲染层会额外加载 Regions 自定义贴图 */
  model?: 'default'
}

/** 桌面上的一个角色实例；stage 第一项为主角色，受「切换」控制 */
interface StageInstance {
  id: string
  characterId: string
  /** 屏幕上角色中心的 DIP 坐标 */
  x: number
  y: number
}

interface PetConfig {
  /** 旧版窗口左上角坐标，仅用于迁移到 centerX/centerY */
  x?: number
  y?: number
  /** 角色视觉中心点在屏幕 DIP 坐标中的位置 */
  centerX?: number
  centerY?: number
  size?: number
  alwaysOnTop?: boolean
  autostart?: boolean
  /** 闲置时自动播放随机动作 */
  autoActions?: boolean
  /** 自动动作的间隔下限/上限（秒） */
  autoActionMin?: number
  autoActionMax?: number
  /** 左键点击角色时播放随机动作 */
  clickAction?: boolean
  /** 拖拽甩抛与弹跳形变 */
  throwPhysics?: boolean
  characters?: CharacterEntry[]
  currentCharacter?: string
  /** 同时显示在桌面上的角色；第一项为主角色 */
  stage?: StageInstance[]
}

const DEFAULT_SIZE = 400
const SIZE_MIN = 240
const SIZE_MAX = 600
const AUTO_MIN = 5
const AUTO_MAX = 600

/** 设置页需要的完整状态 */
interface SettingsState {
  size: number
  alwaysOnTop: boolean
  autostart: boolean
  visible: boolean
  autoActions: boolean
  autoActionMin: number
  autoActionMax: number
  clickAction: boolean
  throwPhysics: boolean
  currentCharacter: string
  characters: { id: string; name: string; preset?: boolean; workshop?: boolean }[]
  /** 当前桌面阵容；第一项为主角色 */
  stage: { id: string; characterId: string; name: string; primary: boolean }[]
  stageLimit: number
}

/** 应用与托盘图标：优先用打包资源，缺失时回退到项目内资源（兼容开发态 isPackaged 误判） */
function appIconPath(): string {
  const packaged = join(process.resourcesPath, 'icon.png')
  if (app.isPackaged && existsSync(packaged)) return packaged
  return join(app.getAppPath(), 'resources', 'default-character', 'icon.png')
}

const DEFAULT_CHARACTER: CharacterInfo = {
  id: 'default',
  // 角色名；CoffeeBean 是骨架/美术系列名，不是角色名
  name: '没想好',
  baseUrl: '',
  skel: 'CoffeeBean_V1_9.skel',
  atlas: 'CoffeeBean_V1_9.atlas',
  meta: 'character.json',
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'petfile',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      // 渲染层页面是 file:// 来源，跨源读取角色 JSON 需要该协议支持 CORS
      corsEnabled: true,
    },
  },
])

function isWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.write-${process.pid}.tmp`)
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Chromium 在默认 userData 不可写时会在初始化阶段直接崩溃，而这个路径在 JS 执行前就已确定，
 * 所以这里探测到不可写后带 --user-data-dir 重新拉起自身，改用可写目录。
 */
function ensureWritableUserData(): void {
  const userData = app.getPath('userData')
  if (isWritableDir(userData)) return
  // 已经在回退目录中运行，避免反复重启
  if (app.commandLine.hasSwitch('user-data-dir')) return

  const fallbacks = [
    join(app.isPackaged ? dirname(app.getPath('exe')) : process.cwd(), 'pet-data'),
    join(app.getPath('temp'), 'emotelab-pet-data'),
  ]
  const target = fallbacks.find(isWritableDir)
  if (!target) return

  console.warn('[Pet] userData 不可写，改用', target)
  // 先拉起新实例（带 --user-data-dir），再退出当前进程
  const args = [
    ...process.argv.slice(1).filter((a) => !a.startsWith('--user-data-dir')),
    `--user-data-dir=${target}`,
  ]
  spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref()
  app.exit(0)
}

ensureWritableUserData()

// Windows 原生 toast 需要显式 AUMID，且需与 electron-builder 的 appId 保持一致
if (process.platform === 'win32') app.setAppUserModelId('com.emotelab.pet')

// 单实例：再次启动时由已运行的实例把窗口带到前台
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

/** 主进程日志落盘：控制台输出同时写入 userData/logs/pet.log，超过 2MB 轮转一次 */
function setupFileLogging(): void {
  const file = join(app.getPath('userData'), 'logs', 'pet.log')
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file) && statSync(file).size > 2 * 1024 * 1024) renameSync(file, file + '.1')
  } catch {
    return
  }

  const write = (level: string, args: unknown[]): void => {
    try {
      appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${format(...args)}\n`)
    } catch {
      // 磁盘不可写时放弃落盘，不影响运行
    }
  }
  const raw = { log: console.log, warn: console.warn, error: console.error }
  console.log = (...args: unknown[]) => { raw.log(...args); write('LOG', args) }
  console.warn = (...args: unknown[]) => { raw.warn(...args); write('WARN', args) }
  console.error = (...args: unknown[]) => { raw.error(...args); write('ERR', args) }
  process.on('uncaughtException', (e) => write('FATAL', [e]))
  process.on('unhandledRejection', (e) => write('FATAL', [e]))
}

setupFileLogging()
console.log('[Pet] started', `v${app.getVersion()}`, app.isPackaged ? 'packaged' : 'dev')

let petWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let config: PetConfig = {}
let saveTimer: NodeJS.Timeout | null = null
let cursorTimer: NodeJS.Timeout | null = null

let resolvedConfigPath: string | null = null

/** 优先系统应用数据目录，不可写时退回项目目录 */
function configCandidates(): string[] {
  return [
    join(app.getPath('userData'), 'pet-config.json'),
    join(process.cwd(), 'pet-config.json'),
    join(app.getAppPath(), 'pet-config.json'),
  ]
}

function loadConfig(): PetConfig {
  for (const file of configCandidates()) {
    try {
      if (existsSync(file)) {
        resolvedConfigPath = file
        return JSON.parse(readFileSync(file, 'utf-8'))
      }
    } catch (e) {
      console.warn('[Pet] config read failed', e)
    }
  }
  return {}
}

function persistConfig(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const first = configCandidates()
    const order = resolvedConfigPath
      ? [resolvedConfigPath, ...first.filter((p) => p !== resolvedConfigPath)]
      : first
    let lastError: unknown = null
    for (const file of order) {
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(config, null, 2))
        resolvedConfigPath = file
        return
      } catch (e) {
        lastError = e
      }
    }
    console.warn('[Pet] config write failed', lastError)
  }, 300)
}

/**
 * 主进程只保证角色中心点落在工作区内。
 * 贴边细节由渲染层按角色真实轮廓处理，这里不再按 size/2 收紧。
 */
function clampCenter(x: number, y: number): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width),
    y: Math.min(Math.max(y, workArea.y), workArea.y + workArea.height),
  }
}

/** 首次启动时放在主屏右下角（按角色大小留出边距） */
function defaultCenter(size: number): { x: number; y: number } {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.round(workArea.x + workArea.width - size / 2 - 20),
    y: Math.round(workArea.y + workArea.height - size / 2 - 20),
  }
}

/** 首次启动放在主屏右下角；旧版的窗口坐标换算成角色中心点 */
function resolveCenter(size: number): { x: number; y: number } {
  const fallback = defaultCenter(size)
  const cx = config.centerX ?? (config.x !== undefined ? config.x + size / 2 : undefined)
  const cy = config.centerY ?? (config.y !== undefined ? config.y + size / 2 : undefined)
  if (cx === undefined || cy === undefined) return fallback
  return clampCenter(cx, cy)
}

// --- 设置 ---

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 行为配置：间隔限制在合理范围，保证上限始终大于下限 */
function behaviorSettings(): {
  autoActions: boolean
  autoActionMin: number
  autoActionMax: number
  clickAction: boolean
  throwPhysics: boolean
} {
  const min = clampNumber(config.autoActionMin ?? 15, AUTO_MIN, AUTO_MAX - 5)
  const max = clampNumber(config.autoActionMax ?? 45, min + 5, AUTO_MAX)
  return {
    autoActions: config.autoActions ?? true,
    autoActionMin: min,
    autoActionMax: max,
    clickAction: config.clickAction ?? true,
    throwPhysics: config.throwPhysics ?? true,
  }
}

function settingsState(): SettingsState {
  return {
    size: config.size ?? DEFAULT_SIZE,
    alwaysOnTop: config.alwaysOnTop ?? true,
    autostart: config.autostart ?? false,
    visible: petWindow?.isVisible() ?? false,
    ...behaviorSettings(),
    currentCharacter: config.currentCharacter ?? 'default',
    characters: [
      { id: 'default', name: DEFAULT_CHARACTER.name },
      ...(config.characters ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        preset: c.preset,
        workshop: c.kind === 'workshop',
      })),
    ],
    stage: ensureStage().map((s, i) => ({
      id: s.id,
      characterId: s.characterId,
      name: characterInfoById(s.characterId).name,
      primary: i === 0,
    })),
    stageLimit: MAX_STAGE,
  }
}

/** 托盘/右键菜单改动后同步到设置页 */
function broadcastSettings(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('settings:changed', settingsState())
  }
}

/** 设置页打开时把对话框挂在设置页上，否则用宠物窗口 */
function dialogParent(): BrowserWindow | null {
  if (settingsWindow && !settingsWindow.isDestroyed()) return settingsWindow
  return petWindow
}

// --- 角色管理 ---

/** 在用户选择的目录（含一级子目录）里找 EmoteLab 角色目录 */
function findCharacterDir(root: string): string | null {
  const candidates = [root]
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(root, entry.name))
    }
  } catch {
    return null
  }

  for (const dir of candidates) {
    if (!existsSync(join(dir, 'character.json'))) continue
    if (pickSkeletonFiles(dir)) return dir
  }
  return null
}

/** 识别目录中的 .skel/.atlas，多个时优先采用文件名匹配的一对 */
function pickSkeletonFiles(dir: string): { skel: string; atlas: string } | null {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return null
  }
  const skels = files.filter((f) => /\.skel$/i.test(f)).sort()
  const atlases = files.filter((f) => /\.atlas$/i.test(f)).sort()
  if (skels.length === 0 || atlases.length === 0) return null

  for (const skel of skels) {
    const stem = skel.replace(/\.skel$/i, '').toLowerCase()
    const matched = atlases.find((a) => a.toLowerCase().startsWith(stem))
    if (matched) return { skel, atlas: matched }
  }
  return { skel: skels[0], atlas: atlases[0] }
}

function readDisplayName(dir: string): string {
  try {
    const metaPath = join(dir, 'model.meta')
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      if (meta.DisplayName) return String(meta.DisplayName)
    }
  } catch {
    // 忽略损坏的 model.meta
  }
  return basename(dir)
}

/** 角色文件是否仍然可用：预设/工坊角色只校验 json，完整角色校验骨架与图集 */
function entryIsUsable(entry: CharacterEntry): boolean {
  if (entry.preset || entry.model === 'default') return existsSync(join(entry.dir, 'character.json'))
  return existsSync(join(entry.dir, entry.skel)) && existsSync(join(entry.dir, entry.atlas))
}

function entryToInfo(entry: CharacterEntry): CharacterInfo {
  if (entry.preset || entry.model === 'default') {
    // 骨架走内置 CoffeeBean，外观来自 character.json；工坊角色另有 Regions 自定义贴图
    return {
      id: entry.id,
      name: entry.name,
      baseUrl: `petfile://${entry.id}/`,
      skel: DEFAULT_CHARACTER.skel,
      atlas: DEFAULT_CHARACTER.atlas,
      meta: 'character.json',
      metaUrl: `petfile://${entry.id}/character.json`,
      model: 'default',
    }
  }
  return {
    id: entry.id,
    name: entry.name,
    baseUrl: `petfile://${entry.id}/`,
    skel: entry.skel,
    atlas: entry.atlas,
    meta: existsSync(join(entry.dir, 'character.json')) ? 'character.json' : null,
  }
}

function currentCharacterInfo(): CharacterInfo {
  return characterInfoById(config.currentCharacter ?? DEFAULT_CHARACTER.id)
}

const MAX_STAGE = 6

function stageEntryUsable(id: string): boolean {
  if (id === 'default') return true
  const entry = config.characters?.find((c) => c.id === id)
  return !!entry && entryIsUsable(entry)
}

function characterInfoById(id: string): CharacterInfo {
  if (id === 'default') return DEFAULT_CHARACTER
  const entry = config.characters?.find((c) => c.id === id)
  return entry && entryIsUsable(entry) ? entryToInfo(entry) : DEFAULT_CHARACTER
}

/** 读取并修复实例列表；旧配置没有 stage 时按当前单角色迁移 */
function ensureStage(): StageInstance[] {
  const size = config.size ?? DEFAULT_SIZE
  const center = resolveCenter(size)
  if (!Array.isArray(config.stage) || config.stage.length === 0) {
    config.stage = [{
      id: 'main',
      characterId:
        config.currentCharacter && stageEntryUsable(config.currentCharacter)
          ? config.currentCharacter
          : 'default',
      x: config.centerX ?? center.x,
      y: config.centerY ?? center.y,
    }]
  }
  config.stage = config.stage.filter((s) => s && stageEntryUsable(s.characterId))
  if (config.stage.length === 0) {
    config.stage.push({ id: 'main', characterId: 'default', x: center.x, y: center.y })
  }
  // 主角色与旧字段保持同步，托盘/设置页仍按「当前角色」展示第一只
  config.currentCharacter = config.stage[0].characterId
  config.centerX = config.stage[0].x
  config.centerY = config.stage[0].y
  return config.stage
}

let stageSeq = 0

function newStageId(): string {
  return `inst-${Date.now().toString(36)}-${stageSeq++}`
}

/** 渲染层需要的完整舞台信息：实例、角色描述、尺寸与工作区 */
function stagePayload(): {
  size: number
  workArea: { x: number; y: number; width: number; height: number }
  stage: { id: string; x: number; y: number; character: CharacterInfo }[]
} {
  const size = config.size ?? DEFAULT_SIZE
  const { workArea } = screen.getPrimaryDisplay()
  return {
    size,
    workArea: { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height },
    stage: ensureStage().map((s) => ({
      id: s.id,
      x: s.x,
      y: s.y,
      character: characterInfoById(s.characterId),
    })),
  }
}

function broadcastStage(): void {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.webContents.send('pet:stage', stagePayload())
  }
}

function switchCharacter(id: string): void {
  const entry = config.characters?.find((c) => c.id === id)
  const previous = config.currentCharacter ?? DEFAULT_CHARACTER.id
  let nextId = 'default'
  if (entry) {
    if (!entryIsUsable(entry)) {
      notify(
        '角色文件已丢失',
        entry.preset
          ? `找不到预设文件，请重新导入「${entry.name}」。`
          : `找不到 ${entry.skel} / ${entry.atlas}，请重新导入「${entry.name}」。`
      )
      return
    }
    nextId = id
  }
  const stage = ensureStage()
  stage[0].characterId = nextId
  config.currentCharacter = nextId
  persistConfig()
  broadcastStage()
  refreshTrayMenu()
  broadcastSettings()
  if (previous !== config.currentCharacter) {
    notify('已切换角色', `当前角色：${entry?.name ?? DEFAULT_CHARACTER.name}`)
  }
}

/** 导入角色的存放目录：跟随配置文件所在目录，保证与配置一样可写 */
function charactersRoot(): string {
  const base = resolvedConfigPath ? dirname(resolvedConfigPath) : app.getPath('userData')
  return join(base, 'characters')
}

function normalizePath(p: string): string {
  return resolve(p).replace(/[\\/]+$/, '').toLowerCase()
}

/** 把角色复制到本地存放目录，失败时退回引用原目录 */
function copyCharacterIntoApp(dir: string, id: string): string | null {
  const target = join(charactersRoot(), id)
  try {
    cpSync(dir, target, { recursive: true })
    return target
  } catch (e) {
    console.warn('[Pet] copy character failed', e)
    return null
  }
}

/** 读取并校验 EmoteLab 外观预设 json；不合法时返回 null */
function readPresetJson(file: string): string | null {
  try {
    const raw = readFileSync(file, 'utf-8')
    const data = JSON.parse(raw) as {
      ActiveSkins?: { Items?: unknown[] }
      SliderConstraints?: unknown[]
      SlotGroups?: unknown[]
    }
    if (!data || typeof data !== 'object') return null
    const valid =
      Array.isArray(data.ActiveSkins?.Items) ||
      Array.isArray(data.SliderConstraints) ||
      Array.isArray(data.SlotGroups)
    return valid ? raw : null
  } catch {
    return null
  }
}

/** 导入外观预设：骨架复用内置 CoffeeBean，每个 json 只保存几 KB */
async function importPresetFiles(): Promise<void> {
  const parent = dialogParent()
  if (!parent) return
  const result = await dialog.showOpenDialog(parent, {
    title: '导入 EmoteLab 角色预设',
    buttonLabel: '导入',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'EmoteLab 角色预设', extensions: ['json'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return

  const imported: CharacterEntry[] = []
  let failed = 0

  for (const file of result.filePaths) {
    const raw = readPresetJson(file)
    if (!raw) {
      failed++
      continue
    }

    const picked = normalizePath(file)
    const existing = (config.characters ?? []).find(
      (c) => normalizePath(c.source ?? c.dir) === picked
    )
    if (existing) {
      // 重复导入同一份预设时刷新内容，方便在 EmoteLab 里改完再导一次
      try {
        writeFileSync(join(existing.dir, 'character.json'), raw)
        imported.push(existing)
      } catch (e) {
        console.warn('[Pet] refresh preset failed', e)
        failed++
      }
      continue
    }

    const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const dir = join(charactersRoot(), id)
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'character.json'), raw)
    } catch (e) {
      console.warn('[Pet] copy preset failed', e)
      failed++
      continue
    }

    const entry: CharacterEntry = {
      id,
      name: basename(file).replace(/\.json$/i, '').slice(0, 24) || '角色预设',
      dir,
      source: file,
      skel: DEFAULT_CHARACTER.skel,
      atlas: DEFAULT_CHARACTER.atlas,
      preset: true,
    }
    config.characters = [...(config.characters ?? []), entry]
    imported.push(entry)
  }

  if (failed > 0) {
    notify(
      '部分预设导入失败',
      `${failed} 个文件不是有效的 EmoteLab 角色预设，请确认是包含 ActiveSkins 等字段的 json。`
    )
  }
  if (imported.length === 0) return

  persistConfig()
  switchCharacter(imported[0].id)
  if (imported.length > 1) {
    notify('已导入角色预设', `共导入 ${imported.length} 个预设，已切换到「${imported[0].name}」。`)
  }
}

/** 从 .elpack 解包并加入角色列表；工坊扫描也复用这个入口 */
function addElpackCharacter(
  file: string,
  options?: { kind?: 'workshop'; publishedFileId?: string; source?: string }
): CharacterEntry | null {
  const source = options?.source ?? file
  const picked = normalizePath(source)
  let mtime = 0
  try {
    mtime = statSync(file).mtimeMs
  } catch {
    // 读取不到时间戳时按首次导入处理
  }

  const existing = (config.characters ?? []).find((c) => normalizePath(c.source ?? c.dir) === picked)
  if (existing) {
    // 工坊内容更新后重新解包，避免继续使用旧贴图
    if (existing.model === 'default' && mtime > (existing.sourceMtime ?? 0)) {
      try {
        extractElpack(file, existing.dir)
        existing.sourceMtime = mtime
        persistConfig()
      } catch (e) {
        console.warn('[Pet] 重新解包工坊角色失败', file, e)
      }
    }
    return existing
  }

  const id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const dir = join(charactersRoot(), id)
  try {
    const extracted = extractElpack(file, dir)
    const entry: CharacterEntry = {
      id,
      name:
        (extracted.header.DisplayName || '').trim().slice(0, 24) ||
        basename(file).replace(/\.elpack$/i, '').slice(0, 24) ||
        '创意工坊角色',
      dir,
      source,
      skel: DEFAULT_CHARACTER.skel,
      atlas: DEFAULT_CHARACTER.atlas,
      preset: true,
      model: 'default',
      kind: options?.kind,
      publishedFileId: options?.publishedFileId,
      sourceMtime: mtime,
    }
    config.characters = [...(config.characters ?? []), entry]
    persistConfig()
    return entry
  } catch (e) {
    console.warn('[Pet] extract elpack failed', file, e)
    rmSync(dir, { recursive: true, force: true })
    notify('导入失败', (e as Error).message || '无法解析角色包。')
    return null
  }
}

/** 手动导入 .elpack 文件（Steam 创意工坊下载到本地的角色包） */
async function importElpackFile(): Promise<void> {
  const parent = dialogParent()
  if (!parent) return
  const result = await dialog.showOpenDialog(parent, {
    title: '导入 EmoteLab 创意工坊角色包',
    buttonLabel: '导入',
    properties: ['openFile'],
    filters: [{ name: 'EmoteLab 角色包', extensions: ['elpack'] }],
  })
  if (result.canceled || !result.filePaths[0]) return

  const entry = addElpackCharacter(result.filePaths[0])
  if (!entry) return
  switchCharacter(entry.id)
  notify('已导入创意工坊角色', `当前角色：${entry.name}`)
}

/** 导入完整角色目录（character.json + .skel/.atlas） */
async function importCharacterFolder(): Promise<void> {
  const parent = dialogParent()
  if (!parent) return
  const result = await dialog.showOpenDialog(parent, {
    title: '导入 EmoteLab 角色',
    buttonLabel: '导入',
    properties: ['openDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return

  const dir = findCharacterDir(result.filePaths[0])
  const files = dir ? pickSkeletonFiles(dir) : null
  if (!dir || !files) {
    notify(
      '导入失败',
      '没有找到 EmoteLab 角色文件，请选择包含 character.json 与 .skel/.atlas 的角色文件夹。'
    )
    return
  }

  const picked = normalizePath(dir)
  const existing = (config.characters ?? []).find((c) => normalizePath(c.source ?? c.dir) === picked)
  if (existing) {
    switchCharacter(existing.id)
    return
  }

  const id = `c${Date.now().toString(36)}`
  const copiedDir = copyCharacterIntoApp(dir, id)
  const entry: CharacterEntry = {
    id,
    name: readDisplayName(dir),
    dir: copiedDir ?? dir,
    source: dir,
    skel: files.skel,
    atlas: files.atlas,
  }
  config.characters = [...(config.characters ?? []), entry]
  persistConfig()
  switchCharacter(entry.id)
}

async function importCharacter(): Promise<void> {
  const parent = dialogParent()
  if (!parent) return
  const { response } = await dialog.showMessageBox(parent, {
    type: 'question',
    title: '导入角色',
    message: '选择导入方式',
    detail:
      '创意工坊角色包：Steam 创意工坊下载的 .elpack，包含外观预设与自定义贴图。\n' +
      '预设 JSON：直接使用 EmoteLab 导出的外观设置，骨架复用内置 CoffeeBean 模型。\n' +
      '角色文件夹：包含 character.json 与 .skel/.atlas 的完整角色目录。',
    buttons: ['创意工坊 .elpack…', '预设 JSON…', '角色文件夹…', '取消'],
    defaultId: 0,
    cancelId: 3,
    noLink: true,
  })
  if (response === 0) await importElpackFile()
  else if (response === 1) await importPresetFiles()
  else if (response === 2) await importCharacterFolder()
}

async function removeCharacter(id: string): Promise<void> {
  const parent = dialogParent()
  const entry = config.characters?.find((c) => c.id === id)
  if (!entry || !parent) return

  const { response } = await dialog.showMessageBox(parent, {
    type: 'warning',
    buttons: ['删除', '取消'],
    defaultId: 1,
    cancelId: 1,
    message: `删除角色「${entry.name}」？`,
    detail: '会从角色列表移除；复制到本地的角色文件也会一起删除。',
  })
  if (response !== 0) return

  const root = resolve(charactersRoot())
  const dir = resolve(entry.dir)
  if (dir.startsWith(root + sep)) rmSync(dir, { recursive: true, force: true })

  config.characters = (config.characters ?? []).filter((c) => c.id !== id)
  if (config.currentCharacter === id) config.currentCharacter = 'default'
  config.stage = (config.stage ?? []).filter((s) => s.characterId !== id)
  ensureStage()
  persistConfig()
  broadcastStage()
  refreshTrayMenu()
  broadcastSettings()
}

/** 在宠物窗口里弹出输入框改名（Electron 没有原生输入对话框） */
function promptRename(id: string): void {
  const entry = config.characters?.find((c) => c.id === id)
  if (!entry || !petWindow) return
  petWindow.show()
  petWindow.setIgnoreMouseEvents(false)
  petWindow.focus()
  petWindow.webContents.send('pet:rename-prompt', { id, name: entry.name })
}

/** 导入的角色位于任意本地目录，通过自定义协议提供资源，避免 file:// 受页面来源限制 */
function registerPetFileProtocol(): void {
  protocol.handle('petfile', async (request) => {
    const url = new URL(request.url)
    const entry = config.characters?.find((c) => c.id === url.hostname)
    if (!entry) return new Response('Character not found', { status: 404 })

    const root = resolve(entry.dir)
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const abs = resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + sep)) {
      return new Response('Forbidden', { status: 403 })
    }
    try {
      const response = await net.fetch(pathToFileURL(abs).toString())
      const headers = new Headers(response.headers)
      headers.set('Access-Control-Allow-Origin', '*')
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

// --- 托盘 ---

let tray: Tray | null = null

function toggleWindow(): void {
  if (!petWindow) return
  if (petWindow.isVisible()) {
    petWindow.hide()
  } else {
    petWindow.show()
    petWindow.focus()
  }
  refreshTrayMenu()
  broadcastSettings()
}

function setAlwaysOnTop(value: boolean): void {
  config.alwaysOnTop = value
  petWindow?.setAlwaysOnTop(value, 'screen-saver')
  persistConfig()
  refreshTrayMenu()
  broadcastSettings()
}

/** 把开机自启状态同步到系统登录项 */
function applyAutostart(value: boolean): void {
  try {
    // 打包后直接用 exe 注册；开发态用当前进程参数
    app.setLoginItemSettings({
      openAtLogin: value,
      args: app.isPackaged ? [] : process.argv.slice(1),
    })
  } catch (e) {
    console.warn('[Pet] setLoginItemSettings failed', e)
  }
}

function setAutostart(value: boolean): void {
  config.autostart = value
  applyAutostart(value)
  persistConfig()
  refreshTrayMenu()
  broadcastSettings()
}

function characterMenuItems(): Electron.MenuItemConstructorOptions[] {
  const current = config.currentCharacter ?? 'default'
  return [
    { label: '导入角色…', click: () => void importCharacter() },
    { type: 'separator' },
    {
      label: DEFAULT_CHARACTER.name,
      type: 'radio',
      checked: current === 'default',
      click: () => switchCharacter('default'),
    },
    ...(config.characters ?? []).map<Electron.MenuItemConstructorOptions>((c) => ({
      label: c.name,
      submenu: [
        {
          label: '使用',
          type: 'radio',
          checked: current === c.id,
          click: () => switchCharacter(c.id),
        },
        { label: '重命名…', click: () => promptRename(c.id) },
        { type: 'separator' },
        { label: '删除…', click: () => void removeCharacter(c.id) },
      ],
    })),
  ]
}

function trayTemplate(): Electron.MenuItemConstructorOptions[] {
  return [
    { label: petWindow?.isVisible() ? '隐藏角色' : '显示角色', click: toggleWindow },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: config.alwaysOnTop ?? true,
      click: (item) => setAlwaysOnTop(item.checked),
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: config.autostart ?? false,
      click: (item) => setAutostart(item.checked),
    },
    { label: '角色', submenu: characterMenuItems() },
    { label: '设置…', click: openSettingsWindow },
    { type: 'separator' },
    { label: '关于 Emotelab Pet…', click: () => void showAboutDialog() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]
}

function refreshTrayMenu(): void {
  tray?.setContextMenu(Menu.buildFromTemplate(trayTemplate()))
}

/** 轻量气泡提示：优先系统通知，托盘气泡在某些 Windows 环境下会阻塞主进程 */
function notify(title: string, content: string): void {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body: content, icon: appIconPath() }).show()
      return
    }
    if (process.platform === 'win32' && tray && !tray.isDestroyed()) {
      tray.displayBalloon({
        title,
        content,
        icon: nativeImage.createFromPath(appIconPath()),
      })
    }
  } catch (e) {
    console.warn('[Pet] notify failed', e)
  }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(appIconPath())
  tray = new Tray(icon.isEmpty() ? appIconPath() : icon.resize({ width: 32, height: 32, quality: 'best' }))
  tray.setToolTip('Emotelab Pet')
  tray.on('double-click', toggleWindow)
  refreshTrayMenu()
}

/** 显示器拔插或分辨率变化时，重新贴合主屏工作区，并把角色拉回可见范围 */
function keepWindowOnScreen(): void {
  if (!petWindow || petWindow.isDestroyed()) return
  const { workArea } = screen.getPrimaryDisplay()
  petWindow.setBounds(workArea)

  const center = clampCenter(config.centerX ?? 0, config.centerY ?? 0)
  config.centerX = center.x
  config.centerY = center.y
  persistConfig()

  petWindow.webContents.send('pet:center', {
    x: center.x - workArea.x,
    y: center.y - workArea.y,
  })
}

function setupDisplayListeners(): void {
  screen.on('display-removed', keepWindowOnScreen)
  screen.on('display-metrics-changed', keepWindowOnScreen)
}

/** 独立设置窗口：固定初始尺寸，可自由缩放，关掉不退出应用 */
function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show()
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 780,
    height: 640,
    minWidth: 660,
    minHeight: 540,
    title: '设置 - Emotelab Pet',
    backgroundColor: '#191920',
    autoHideMenuBar: true,
    show: false,
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false,
    },
  })

  settingsWindow.once('ready-to-show', () => settingsWindow?.show())
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) settingsWindow.loadURL(`${devUrl.replace(/\/$/, '')}/settings.html`)
  else settingsWindow.loadFile(resolve(__dirname, '../renderer/pet/settings.html'))
}

/** 诊断信息：版本、运行时、角色与路径，方便反馈问题时一次性提供 */
function aboutDetail(): string {
  const userData = app.getPath('userData')
  const characters = config.characters ?? []
  const currentId = config.currentCharacter ?? DEFAULT_CHARACTER.id
  const currentName =
    currentId === DEFAULT_CHARACTER.id
      ? DEFAULT_CHARACTER.name
      : characters.find((c) => c.id === currentId)?.name ?? DEFAULT_CHARACTER.name
  const configPath = resolvedConfigPath ?? join(userData, 'pet-config.json')
  return [
    `版本：${app.getVersion()}（${app.isPackaged ? '安装版' : '开发版'}）`,
    `Electron：${process.versions.electron}`,
    `Chromium：${process.versions.chrome}`,
    `Node：${process.versions.node}`,
    '',
    `当前角色：${currentName}`,
    `角色总数：${characters.length + 1}`,
    `角色尺寸：${config.size ?? DEFAULT_SIZE} px`,
    '',
    `数据目录：${userData}`,
    `配置文件：${configPath}`,
    `日志文件：${join(userData, 'logs', 'pet.log')}`,
  ].join('\n')
}

/** 用系统文件管理器打开目录，不存在时先创建 */
function openDirInExplorer(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
    void shell.openPath(dir)
  } catch (e) {
    console.warn('[Pet] open dir failed', e)
  }
}

/** 关于对话框：展示诊断信息，并提供打开数据/日志目录的入口 */
async function showAboutDialog(): Promise<void> {
  const userData = app.getPath('userData')
  const options: Electron.MessageBoxOptions = {
    type: 'info',
    title: '关于 Emotelab Pet',
    message: `Emotelab Pet ${app.getVersion()}`,
    detail: aboutDetail(),
    buttons: ['打开数据目录', '打开日志目录', '确定'],
    defaultId: 2,
    cancelId: 2,
    noLink: true,
  }
  const parent = dialogParent()
  const { response } = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)

  if (response === 0) openDirInExplorer(userData)
  if (response === 1) openDirInExplorer(join(userData, 'logs'))
}

function createPetWindow(): void {
  config = loadConfig()
  // 先把阵容落盘，避免设置页先打开时读到空数组
  ensureStage()
  persistConfig()
  const size = config.size ?? DEFAULT_SIZE
  const center = resolveCenter(size)
  const { workArea } = screen.getPrimaryDisplay()

  petWindow = new BrowserWindow({
    // 覆盖式窗口：位置和尺寸在生命周期内固定不变，拖拽只移动窗口内的角色
    width: workArea.width, height: workArea.height,
    x: workArea.x, y: workArea.y,
    frame: false, transparent: true,
    resizable: false, movable: false, minimizable: false, maximizable: false,
    alwaysOnTop: config.alwaysOnTop ?? true, show: false,
    backgroundColor: '#00000000',
    skipTaskbar: true,
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false, contextIsolation: true, nodeIntegration: false,
    },
  })

  petWindow.setAlwaysOnTop(config.alwaysOnTop ?? true, 'screen-saver')
  petWindow.setIgnoreMouseEvents(true, { forward: true })

  petWindow.once('ready-to-show', () => {
    petWindow?.show()
  })

  petWindow.webContents.on('console-message', (_e, level, msg) => {
    const prefix = ['ERR', 'WARN', 'INFO', 'LOG'][level] || '?'
    console.log(`[R:${prefix}] ${String(msg).substring(0, 500)}`)
  })

  petWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[Pet] RENDERER CRASHED:', details)
  })

  petWindow.on('closed', () => {
    petWindow = null
  })
  // 显示状态变化时同步设置页与托盘文案（包括从设置页切换显示）
  petWindow.on('show', () => {
    refreshTrayMenu()
    broadcastSettings()
  })
  petWindow.on('hide', () => {
    refreshTrayMenu()
    broadcastSettings()
  })

  if (process.env.ELECTRON_RENDERER_URL) petWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else petWindow.loadFile(resolve(__dirname, '../renderer/pet/index.html'))

  config.centerX = center.x
  config.centerY = center.y
  config.size = size
  config.alwaysOnTop = config.alwaysOnTop ?? true
  config.autoActions = config.autoActions ?? true
  config.autoActionMin = config.autoActionMin ?? 15
  config.autoActionMax = config.autoActionMax ?? 45
  config.clickAction = config.clickAction ?? true
  config.throwPhysics = config.throwPhysics ?? true
  applyAutostart(config.autostart ?? false)
  persistConfig()
}

function groupAnimations(names: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const name of names) {
    const short = name.replace(/^ANIM\//, '')
    const token = short.split(/[-_]/)[0]
    if (!groups.has(token)) groups.set(token, [])
    groups.get(token)!.push(short)
  }
  return groups
}

function showContextMenu(animations: string[], current: string): void {
  if (!petWindow) return

  const groups = groupAnimations(animations)
  const animItems: Electron.MenuItemConstructorOptions[] = []
  for (const [token, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (list.length === 1) {
      animItems.push({
        label: localizeAnimationGroup(token, list),
        type: 'radio',
        checked: current === `ANIM/${list[0]}`,
        click: () => petWindow?.webContents.send('pet:play-animation', `ANIM/${list[0]}`),
      })
    } else {
      animItems.push({
        label: `${localizeAnimationGroup(token, list)} (${list.length})`,
        submenu: list.map((short) => ({
          label: localizeAnimationName(short),
          type: 'radio' as const,
          checked: current === `ANIM/${short}`,
          click: () => petWindow?.webContents.send('pet:play-animation', `ANIM/${short}`),
        })),
      })
    }
  }

  const menu = Menu.buildFromTemplate([
    {
      label: '待机',
      click: () => petWindow?.webContents.send('pet:play-idle'),
    },
    { label: '动作 / 表情', submenu: animItems },
    { type: 'separator' },
    { label: '角色', submenu: characterMenuItems() },
    { type: 'separator' },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: config.alwaysOnTop ?? true,
      click: (item) => setAlwaysOnTop(item.checked),
    },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: config.autostart ?? false,
      click: (item) => setAutostart(item.checked),
    },
    { type: 'separator' },
    { label: '设置…', click: openSettingsWindow },
    { label: '关于 Emotelab Pet…', click: () => void showAboutDialog() },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])

  menu.popup({ window: petWindow })
}

/** 全局光标轮询：穿透状态下渲染层也能持续得到窗口相对坐标 */
function startCursorTracking(): void {
  if (cursorTimer) return
  cursorTimer = setInterval(() => {
    if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return
    const cursor = screen.getCursorScreenPoint()
    const bounds = petWindow.getContentBounds()
    petWindow.webContents.send('pet:cursor', {
      x: cursor.x - bounds.x,
      y: cursor.y - bounds.y,
    })
  }, 33)
}

ipcMain.on('pet:set-ignore-mouse', (_e, ignore: boolean) => {
  petWindow?.setIgnoreMouseEvents(ignore, { forward: true })
})

/** 拖拽结束时保存角色中心点的屏幕绝对坐标（旧接口，等同主角色） */
ipcMain.on('pet:set-position', (_e, point: { x: number; y: number }) => {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return
  const stage = ensureStage()
  const center = clampCenter(point.x, point.y)
  stage[0].x = center.x
  stage[0].y = center.y
  config.centerX = center.x
  config.centerY = center.y
  persistConfig()
})

/** 任意角色实例拖拽结束后保存位置 */
ipcMain.on('pet:set-instance-position', (_e, payload: { id: string; x: number; y: number }) => {
  if (!Number.isFinite(payload?.x) || !Number.isFinite(payload?.y)) return
  const stage = ensureStage()
  const item = stage.find((s) => s.id === payload.id)
  if (!item) return
  const center = clampCenter(payload.x, payload.y)
  item.x = center.x
  item.y = center.y
  if (stage[0].id === item.id) {
    config.centerX = center.x
    config.centerY = center.y
  }
  persistConfig()
})

/** 渲染层启动/切换角色时读取整个舞台 */
ipcMain.handle('pet:get-stage', () => stagePayload())

/** 渲染层启动时读取角色初始位置和覆盖窗口的偏移 */
ipcMain.handle('pet:get-overlay', () => {
  const size = config.size ?? DEFAULT_SIZE
  const { workArea } = screen.getPrimaryDisplay()
  return {
    centerX: config.centerX ?? workArea.x + workArea.width / 2,
    centerY: config.centerY ?? workArea.y + workArea.height / 2,
    size,
    workArea: { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height },
  }
})

ipcMain.on('pet:context-menu', (_e, payload: { animations: string[]; current: string }) => {
  showContextMenu(payload.animations, payload.current)
})

ipcMain.on('pet:rename-character', (_e, payload: { id: string; name: string }) => {
  const entry = config.characters?.find((c) => c.id === payload.id)
  const name = String(payload.name ?? '').trim()
  if (!entry || !name) return
  entry.name = name.slice(0, 24)
  persistConfig()
  refreshTrayMenu()
  broadcastSettings()
})

ipcMain.handle('pet:get-behavior', () => behaviorSettings())

ipcMain.on('pet:quit', () => app.quit())

ipcMain.handle('pet:get-character', () => currentCharacterInfo())

/**
 * 渲染层解析工坊角色的自定义贴图地址。
 * 只返回实际存在的 Regions/*.png，避免为整套 893 张贴图全部建立纹理。
 */
ipcMain.handle('pet:character-textures', (_e, payload: { id: string; names: string[] }) => {
  const entry = config.characters?.find((c) => c.id === payload?.id)
  const names = Array.isArray(payload?.names) ? payload.names.slice(0, 800) : []
  if (!entry || entry.model !== 'default' || names.length === 0) return {}

  const result: Record<string, string> = {}
  for (const name of names) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_\-/]+$/.test(name) || name.includes('..')) continue
    const rel = `Regions/${name}.png`
    if (!existsSync(join(entry.dir, ...rel.split('/')))) continue
    const url = `petfile://${entry.id}/${rel.split('/').map(encodeURIComponent).join('/')}`
    result[name] = url
  }
  return result
})

// --- 设置页 IPC ---

ipcMain.handle('settings:get', () => settingsState())

ipcMain.handle('settings:update', (_e, patch: Partial<SettingsState>) => {
  if (!patch || typeof patch !== 'object') return settingsState()

  if (typeof patch.size === 'number' && Number.isFinite(patch.size)) {
    config.size = clampNumber(patch.size, SIZE_MIN, SIZE_MAX)
    petWindow?.webContents.send('pet:size-changed', config.size)
  }
  if (typeof patch.alwaysOnTop === 'boolean') setAlwaysOnTop(patch.alwaysOnTop)
  if (typeof patch.autostart === 'boolean') setAutostart(patch.autostart)
  if (typeof patch.visible === 'boolean' && petWindow) {
    if (patch.visible) petWindow.show()
    else petWindow.hide()
    refreshTrayMenu()
  }

  let behaviorChanged = false
  if (typeof patch.autoActions === 'boolean') {
    config.autoActions = patch.autoActions
    behaviorChanged = true
  }
  if (typeof patch.clickAction === 'boolean') {
    config.clickAction = patch.clickAction
    behaviorChanged = true
  }
  if (typeof patch.throwPhysics === 'boolean') {
    config.throwPhysics = patch.throwPhysics
    behaviorChanged = true
  }
  if (typeof patch.autoActionMin === 'number' && Number.isFinite(patch.autoActionMin)) {
    config.autoActionMin = clampNumber(patch.autoActionMin, AUTO_MIN, AUTO_MAX - 5)
    behaviorChanged = true
  }
  if (typeof patch.autoActionMax === 'number' && Number.isFinite(patch.autoActionMax)) {
    config.autoActionMax = clampNumber(patch.autoActionMax, AUTO_MIN + 5, AUTO_MAX)
    behaviorChanged = true
  }
  if (behaviorChanged) {
    // 取一次规范化后的值写回，保证上限大于下限
    const behavior = behaviorSettings()
    config.autoActions = behavior.autoActions
    config.autoActionMin = behavior.autoActionMin
    config.autoActionMax = behavior.autoActionMax
    config.clickAction = behavior.clickAction
    config.throwPhysics = behavior.throwPhysics
    petWindow?.webContents.send('pet:behavior', behavior)
  }

  persistConfig()
  refreshTrayMenu()
  broadcastSettings()
  return settingsState()
})

ipcMain.handle('settings:reset-position', () => {
  const size = config.size ?? DEFAULT_SIZE
  const center = defaultCenter(size)
  const stage = ensureStage()
  stage[0].x = center.x
  stage[0].y = center.y
  config.centerX = center.x
  config.centerY = center.y
  persistConfig()
  broadcastStage()

  const { workArea } = screen.getPrimaryDisplay()
  petWindow?.webContents.send('pet:center', {
    x: center.x - workArea.x,
    y: center.y - workArea.y,
  })
  broadcastSettings()
  return settingsState()
})

/** 再放一只同名/任意角色到桌面上 */
ipcMain.handle('settings:add-instance', (_e, characterId: string) => {
  const id = String(characterId ?? '')
  const stage = ensureStage()
  if (stage.length < MAX_STAGE && stageEntryUsable(id)) {
    const { workArea } = screen.getPrimaryDisplay()
    const base = stage[0]
    // 依次向右排开，避免新角色直接叠在已有角色身上
    const offset = stage.length * 80
    const x = Math.min(Math.max(base.x + offset, workArea.x + 60), workArea.x + workArea.width - 60)
    stage.push({ id: newStageId(), characterId: id, x, y: base.y })
    persistConfig()
    broadcastStage()
    refreshTrayMenu()
    broadcastSettings()
  }
  return settingsState()
})

/** 移除任意一只角色实例；至少保留一只，避免桌面与托盘失去当前角色 */
ipcMain.handle('settings:remove-instance', (_e, instanceId: string) => {
  const stage = ensureStage()
  const index = stage.findIndex((s) => s.id === String(instanceId ?? ''))
  if (index >= 0 && stage.length > 1) {
    stage.splice(index, 1)
    // 阵容顺序没有实际含义，旧字段统一跟随第一只，仅供托盘/旧配置使用
    config.currentCharacter = stage[0].characterId
    config.centerX = stage[0].x
    config.centerY = stage[0].y
    persistConfig()
    broadcastStage()
    refreshTrayMenu()
    broadcastSettings()
  }
  return settingsState()
})

ipcMain.handle('settings:import-character', async () => {
  await importCharacter()
  return settingsState()
})

ipcMain.handle('settings:switch-character', (_e, id: string) => {
  switchCharacter(String(id ?? 'default'))
  return settingsState()
})

ipcMain.handle('settings:rename-character', (_e, payload: { id: string; name: string }) => {
  const entry = config.characters?.find((c) => c.id === payload?.id)
  const name = String(payload?.name ?? '').trim()
  if (entry && name) {
    entry.name = name.slice(0, 24)
    persistConfig()
    refreshTrayMenu()
    broadcastSettings()
  }
  return settingsState()
})

ipcMain.handle('settings:delete-character', async (_e, id: string) => {
  await removeCharacter(String(id ?? ''))
  return settingsState()
})

/** 设置页的 Steam 创意工坊列表，characterId 表示该工坊内容是否已添加 */
ipcMain.handle('workshop:list', () => {
  const characters = config.characters ?? []
  return scanWorkshopCharacters().map((item) => {
    const entry = characters.find(
      (c) =>
        c.kind === 'workshop' &&
        (c.publishedFileId === item.id ||
          (c.source ? normalizePath(c.source) === normalizePath(item.dir) : false))
    )
    return {
      id: item.id,
      title: item.title,
      preview: item.preview,
      required: item.required,
      characterId: entry?.id,
    }
  })
})

/** 解包并切换到指定工坊角色 */
ipcMain.handle('workshop:add', (_e, id: string) => {
  const item = scanWorkshopCharacters().find((i) => i.id === String(id))
  if (item) {
    const entry = addElpackCharacter(join(item.dir, 'character.elpack'), {
      kind: 'workshop',
      publishedFileId: item.id,
      source: item.dir,
    })
    if (entry) switchCharacter(entry.id)
  }
  return settingsState()
})

ipcMain.handle('app:resolve-resource', (_e, rel: string) => {
  const fs = require('fs')
  const ap = app.getAppPath()
  for (const c of [
    join(ap, 'renderer', 'pet', rel),
    join(ap, '..', 'renderer', 'pet', rel),
  ]) {
    try { if (fs.existsSync(c)) return 'file:///' + c.replace(/\\/g, '/') } catch {}
  }
  return null
})

app.on('second-instance', () => {
  if (!petWindow) return
  if (!petWindow.isVisible()) petWindow.show()
  if (petWindow.isMinimized()) petWindow.restore()
  petWindow.focus()
  refreshTrayMenu()
})

app.whenReady().then(() => {
  registerPetFileProtocol()
  setupDisplayListeners()
  createPetWindow()
  startCursorTracking()
  createTray()
  // 稍等托盘图标注册到系统后再弹，避免气泡丢失
  setTimeout(() => notify('Emotelab Pet 已启动', '桌宠已在桌面待命，可从托盘菜单管理角色与设置。'), 600)
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
