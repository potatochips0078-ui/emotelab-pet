import { Application, Rectangle, Text } from 'pixi.js'
import type { Spine } from '@esotericsoftware/spine-pixi-v7'
import { loadCharacter } from './characterLoader'
import type { CharacterInfo } from './characterLoader'

declare global {
  interface Window {
    petAPI: {
      setIgnoreMouse: (ignore: boolean) => void
      setInstancePosition: (payload: { id: string; x: number; y: number }) => void
      getStage: () => Promise<StagePayload>
      onStage: (cb: (payload: StagePayload) => void) => void
      onCursor: (cb: (point: { x: number; y: number }) => void) => void
      onCenter: (cb: (point: { x: number; y: number }) => void) => void
      showContextMenu: (animations: string[], current: string) => void
      onPlayAnimation: (cb: (name: string) => void) => void
      onPlayIdle: (cb: () => void) => void
      onRenamePrompt: (cb: (payload: { id: string; name: string }) => void) => void
      renameCharacter: (id: string, name: string) => void
      onWindowSize: (cb: (size: number) => void) => void
      quit: () => void
      getBehavior: () => Promise<BehaviorConfig>
      onBehavior: (cb: (behavior: BehaviorConfig) => void) => void
      resolveResource: (p: string) => Promise<string | null>
      resolveCharacterTextures: (id: string, names: string[]) => Promise<Record<string, string>>
    }
  }
}

interface BehaviorConfig {
  autoActions: boolean
  autoActionMin: number
  autoActionMax: number
  clickAction: boolean
  /** 拖拽甩抛与弹跳形变；关闭后退化为普通拖放 */
  throwPhysics: boolean
}

interface StageCharacter {
  id: string
  character: CharacterInfo
  /** 屏幕上角色中心的绝对坐标 */
  x: number
  y: number
}

interface StagePayload {
  size: number
  workArea: { x: number; y: number; width: number; height: number }
  stage: StageCharacter[]
}

type MotionMode = 'idle' | 'drag' | 'throw'

interface DragSample {
  t: number
  x: number
  y: number
}

interface Insets {
  left: number
  right: number
  top: number
  bottom: number
}

/** 桌面上的一个角色实例：位置、物理、动画与定时器都各自独立 */
interface PetInstance {
  id: string
  info: CharacterInfo
  spine: Spine
  disposeAssets: () => void
  layoutBox: { x: number; y: number; width: number; height: number }
  idleAnimation: string
  currentAnimation: string
  actionPool: string[]
  autoTimer: ReturnType<typeof setTimeout> | null
  autoPlaying: boolean
  /** 角色视觉中心在窗口内的坐标 */
  center: { x: number; y: number }
  motion: MotionMode
  velocity: { x: number; y: number }
  dragTarget: { x: number; y: number }
  dragTrail: DragSample[]
  /** 上一帧是否贴地，用于只在空中→地面时触发一次落地形变 */
  grounded: boolean
  squash: { active: boolean; startedAt: number; depth: number }
  insets: Insets
}

const IDLE_ANIMATION = 'ANIM/Dance-Helltaker'

let app: Application | null = null
let canvas: HTMLCanvasElement | null = null
let instances: PetInstance[] = []
let logicalSize = 400
let stageToken = 0
let behavior: BehaviorConfig = {
  autoActions: true,
  autoActionMin: 15,
  autoActionMax: 45,
  clickAction: true,
  throwPhysics: true,
}

// --- 自动动作 ---

function clearAutoTimer(inst: PetInstance): void {
  if (inst.autoTimer) {
    clearTimeout(inst.autoTimer)
    inst.autoTimer = null
  }
}

function scheduleNextAutoAction(inst: PetInstance): void {
  clearAutoTimer(inst)
  if (!behavior.autoActions || inst.actionPool.length === 0) return
  const min = Math.max(1, behavior.autoActionMin) * 1000
  const max = Math.max(behavior.autoActionMax, behavior.autoActionMin + 1) * 1000
  inst.autoTimer = setTimeout(() => playRandomAction(inst), min + Math.random() * (max - min))
}

function playRandomAction(inst: PetInstance): void {
  if (inst.actionPool.length === 0) return
  // 拖拽/飞行期间不插播动作，落地后再继续
  if (inst.motion !== 'idle') {
    scheduleNextAutoAction(inst)
    return
  }
  const name = inst.actionPool[Math.floor(Math.random() * inst.actionPool.length)]
  inst.autoPlaying = true
  playAnimation(inst, name, false)
}

// --- 启动 ---

async function bootstrap(): Promise<void> {
  const pixiApp = new Application({
    backgroundAlpha: 0,
    resizeTo: window,
    antialias: true,
    preserveDrawingBuffer: true,
  })
  app = pixiApp
  canvas = pixiApp.view as HTMLCanvasElement
  document.getElementById('app')!.appendChild(canvas)
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'

  setupHitTest()
  setupDrag()
  setupContextMenu()
  setupRenameOverlay()

  // 物理、形变与角色间碰撞都挂在渲染 ticker 上，不产生额外 IPC
  pixiApp.ticker.add(() => {
    const dt = pixiApp.ticker.deltaMS / 1000
    for (const inst of [...instances]) updateMotion(inst, dt)
    for (const inst of [...instances]) updateSquash(inst)
    resolveCollisions()
  })

  window.petAPI.onCenter(({ x, y }) => {
    const primary = instances[0]
    if (!primary) return
    stopMotion(primary)
    moveCharacter(primary, x, y)
  })

  window.petAPI.onPlayAnimation((name) => {
    const primary = instances[0]
    if (primary) playAnimation(primary, name)
  })
  window.petAPI.onPlayIdle(() => {
    const primary = instances[0]
    if (primary) playAnimation(primary, primary.idleAnimation)
  })
  window.petAPI.onStage((payload) => {
    applyStage(payload).catch((err) => console.error('[Pet] apply stage failed:', err))
  })
  window.petAPI.onBehavior((next) => {
    behavior = next
    for (const inst of instances) {
      // 关闭弹跳时立刻结束正在进行的甩抛，回到普通拖放
      if (!next.throwPhysics) {
        stopMotion(inst)
        applyCharacterPosition(inst)
      }
      scheduleNextAutoAction(inst)
    }
  })

  window.addEventListener('resize', () => {
    pixiApp.renderer.resize(window.innerWidth, window.innerHeight)
    for (const inst of instances) {
      fitSpine(inst)
      moveCharacter(inst, inst.center.x, inst.center.y)
    }
  })

  window.petAPI.onWindowSize((size) => {
    logicalSize = size
    for (const inst of instances) {
      fitSpine(inst)
      moveCharacter(inst, inst.center.x, inst.center.y)
    }
  })

  try {
    behavior = await window.petAPI.getBehavior()
  } catch (err) {
    console.warn('[Pet] read behavior failed:', err)
  }

  try {
    await applyStage(await window.petAPI.getStage())
  } catch (err) {
    console.error('[Pet] FAILED to load stage:', err)
    showError(`加载失败\n${(err as Error).message}`)
  }
}

/**
 * 对齐舞台：新增/移除实例，角色变化时原地重载。
 * token 用于丢弃过期结果，避免快速切换时旧角色覆盖新角色。
 */
async function applyStage(payload: StagePayload): Promise<void> {
  if (!app) return
  const token = ++stageToken
  logicalSize = payload.size

  const wanted = new Map(payload.stage.map((item) => [item.id, item]))
  for (const inst of [...instances]) {
    if (!wanted.has(inst.id)) destroyInstance(inst)
  }

  for (const item of payload.stage) {
    if (token !== stageToken) return
    const local = {
      x: item.x - payload.workArea.x,
      y: item.y - payload.workArea.y,
    }
    const existing = instances.find((inst) => inst.id === item.id)
    if (!existing) {
      const created = await createInstance(item, local)
      if (token !== stageToken) {
        if (created) destroyInstance(created)
        return
      }
    } else if (existing.info.id !== item.character.id) {
      await reloadInstance(existing, item.character, local)
      if (token !== stageToken) return
    } else {
      existing.info = item.character
      moveCharacter(existing, local.x, local.y)
    }
  }

  resolveCollisions()
  warmupHitTest()
}

async function createInstance(
  item: StageCharacter,
  local: { x: number; y: number }
): Promise<PetInstance | null> {
  if (!app) return null
  try {
    const loaded = await loadCharacter(app, item.character)
    const inst: PetInstance = {
      id: item.id,
      info: item.character,
      spine: loaded.spine,
      disposeAssets: loaded.dispose,
      layoutBox: { x: 0, y: 0, width: 1, height: 1 },
      idleAnimation: IDLE_ANIMATION,
      currentAnimation: IDLE_ANIMATION,
      actionPool: [],
      autoTimer: null,
      autoPlaying: false,
      center: { x: local.x, y: local.y },
      motion: 'idle',
      velocity: { x: 0, y: 0 },
      dragTarget: { x: local.x, y: local.y },
      dragTrail: [],
      grounded: true,
      squash: { active: false, startedAt: 0, depth: 1 },
      insets: { left: 0.35, right: 0.35, top: 0.42, bottom: 0.42 },
    }
    setupIdle(inst)
    app.stage.addChild(inst.spine)
    instances.push(inst)
    console.log('[Pet] character loaded:', inst.id, item.character.id, item.character.name)

    fitSpine(inst)
    moveCharacter(inst, local.x, local.y)
    // 量轮廓需要同步读回整块画面，放到首帧显示之后再做，避免启动时卡顿
    setTimeout(() => {
      if (!instances.includes(inst)) return
      measureVisualInsets(inst)
      moveCharacter(inst, inst.center.x, inst.center.y)
    }, 600)
    return inst
  } catch (err) {
    console.error('[Pet] create instance failed:', item.character.id, err)
    return null
  }
}

/** 同一个实例切换到另一个角色：保留位置，替换骨架与资源 */
async function reloadInstance(
  inst: PetInstance,
  info: CharacterInfo,
  local: { x: number; y: number }
): Promise<void> {
  if (!app) return
  const index = instances.indexOf(inst)
  if (index < 0) return

  clearAutoTimer(inst)
  inst.squash.active = false
  stopMotion(inst)
  // 先在销毁前摘出实例表：destroy 后 Spine 的 transform 为 null，
  // 若它仍在表里，ticker 下一帧读 inst.spine.scale 会抛错并把整个渲染循环停住
  instances.splice(index, 1)
  app.stage.removeChild(inst.spine)
  inst.spine.destroy({ children: true, texture: false, baseTexture: false })
  inst.disposeAssets()

  try {
    const loaded = await loadCharacter(app, info)
    inst.spine = loaded.spine
    inst.disposeAssets = loaded.dispose
    inst.info = info
    inst.center = { x: local.x, y: local.y }
    inst.insets = { left: 0.35, right: 0.35, top: 0.42, bottom: 0.42 }
    setupIdle(inst)
    app.stage.addChildAt(inst.spine, Math.min(index, app.stage.children.length))
    instances.splice(Math.min(index, instances.length), 0, inst)
    fitSpine(inst)
    moveCharacter(inst, local.x, local.y)
    measureVisualInsets(inst)
  } catch (err) {
    console.error('[Pet] reload instance failed:', info.id, err)
  }
}

function setupIdle(inst: PetInstance): void {
  const animations = inst.spine.skeleton.data.animations
  const idle =
    inst.spine.skeleton.data.findAnimation(IDLE_ANIMATION) ??
    animations.find((a) => /idle/i.test(a.name)) ??
    animations[0]

  inst.idleAnimation = idle?.name ?? IDLE_ANIMATION
  inst.currentAnimation = inst.idleAnimation
  inst.actionPool = animations
    .filter((a) => a.name !== inst.idleAnimation && !/idle/i.test(a.name))
    .map((a) => a.name)
  inst.autoPlaying = false

  // 自动播放的动作结束后回到 idle，并安排下一次
  inst.spine.state.addListener({
    complete: () => {
      if (inst.autoPlaying) {
        inst.autoPlaying = false
        playAnimation(inst, inst.idleAnimation, true)
      }
    },
  })

  inst.layoutBox = unionBounds(inst.spine, idle?.duration ?? 0)
  // 采样会推进动画状态，重新回到待机
  if (idle) inst.spine.state.setAnimation(0, idle.name, true)
  scheduleNextAutoAction(inst)
}

function destroyInstance(inst: PetInstance): void {
  clearAutoTimer(inst)
  const index = instances.indexOf(inst)
  if (index >= 0) instances.splice(index, 1)
  if (app) app.stage.removeChild(inst.spine)
  inst.spine.destroy({ children: true, texture: false, baseTexture: false })
  inst.disposeAssets()
}

function showError(message: string): void {
  if (!app) return
  const errText = new Text(message, { fill: 0xff0000, fontSize: 16 })
  errText.x = 10
  errText.y = 130
  app.stage.addChild(errText)
}

/** 采样整段动画，取包围盒并集，避免动作幅度大时被窗口裁掉 */
function unionBounds(
  spineInstance: Spine,
  duration: number
): { x: number; y: number; width: number; height: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const sample = (): void => {
    const b = spineInstance.skeleton.getBoundsRect()
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.width)
    maxY = Math.max(maxY, b.y + b.height)
  }

  spineInstance.update(0)
  sample()
  if (duration > 0) {
    const steps = Math.max(1, Math.min(60, Math.ceil(duration * 30)))
    const dt = duration / steps
    for (let i = 0; i < steps; i++) {
      spineInstance.update(dt)
      sample()
    }
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** 缩放只按用户选择的逻辑尺寸计算，窗口尺寸固定后角色大小不再变化 */
function fitSpine(inst: PetInstance): void {
  const s = Math.min(logicalSize / inst.layoutBox.width, logicalSize / inst.layoutBox.height) * 0.95
  inst.spine.scale.set(s)
  applyCharacterPosition(inst)
}

/** 把角色包围盒中心对齐到 center */
function applyCharacterPosition(inst: PetInstance): void {
  const s = inst.spine.scale.x
  inst.spine.x = inst.center.x - (inst.layoutBox.x + inst.layoutBox.width / 2) * s
  inst.spine.y = inst.center.y - (inst.layoutBox.y + inst.layoutBox.height / 2) * s
}

function playAnimation(inst: PetInstance, name: string, loop = true): void {
  if (!inst.spine.skeleton.data.findAnimation(name)) {
    console.warn('[Pet] animation not found:', name)
    return
  }
  inst.currentAnimation = name
  inst.spine.state.setAnimation(0, name, loop)

  if (name === inst.idleAnimation) {
    // 回到待机：允许再次自动随机
    inst.autoPlaying = false
    scheduleNextAutoAction(inst)
  } else if (loop) {
    // 用户手动选择的循环动作：停止自动随机
    inst.autoPlaying = false
    clearAutoTimer(inst)
  }
}

// --- 点击、拖拽与透明区域穿透 ---
interface PointerGesture {
  pointerId: number
  inst: PetInstance
  /** 角色中心相对指针的偏移，保证按下瞬间角色不跳位 */
  grabX: number
  grabY: number
  startScreenX: number
  startScreenY: number
  dragging: boolean
}

const DRAG_THRESHOLD = 5
const HIT_CACHE_MS = 120

let gesture: PointerGesture | null = null
let ignoringMouse = true
let renameOpen = false
let lastPointer = { x: -1, y: -1 }
/** 同一像素的命中结果缓存，避免高频重复触发 GPU 读回 */
let hitCache = { x: -1, y: -1, at: 0, value: false }
/** 允许角色超出屏幕边缘的比例，1 表示轮廓恰好贴边 */
const OVERHANG = 0.85

function setMouseIgnore(ignore: boolean): void {
  if (ignore === ignoringMouse) return
  ignoringMouse = ignore
  window.petAPI.setIgnoreMouse(ignore)
}

function updateHit(x = lastPointer.x, y = lastPointer.y): void {
  lastPointer = { x, y }
  // 按压和重命名期间必须持续接收鼠标，不能随动画轮廓切换穿透
  if (gesture || renameOpen) {
    setMouseIgnore(false)
    return
  }
  setMouseIgnore(!isOnCharacter(x, y))
}

function setupHitTest(): void {
  window.addEventListener('mousemove', (e) => updateHit(e.clientX, e.clientY))
  window.petAPI.onCursor(({ x, y }) => updateHit(x, y))
}

/** 只认角色实际绘制出来的像素，透明区域仍然穿透；多角色时取画布并集 */
function isOnCharacter(x: number, y: number): boolean {
  if (!app || instances.length === 0) return false
  const w = window.innerWidth
  const h = window.innerHeight
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x >= w || y >= h) return false

  const px = Math.floor(x)
  const py = Math.floor(y)
  const now = Date.now()
  if (px === hitCache.x && py === hitCache.y && now - hitCache.at < HIT_CACHE_MS) {
    return hitCache.value
  }

  let over = false
  try {
    // Extract 以左下角为原点，只读一个像素的 alpha
    over = app.renderer.extract.pixels(undefined, new Rectangle(px, h - py - 1, 1, 1))[3] > 16
  } catch {
    // 读取失败时按不可点击处理，避免误挡桌面
  }
  hitCache = { x: px, y: py, at: now, value: over }
  return over
}

/** 首次读回会触发 GPU 管线初始化，提前做一次避免首次点击卡顿 */
function warmupHitTest(): void {
  if (instances.length === 0) return
  const primary = instances[0]
  isOnCharacter(primary.center.x, primary.center.y)
}

/** 命中最上层的实例：数组顺序即绘制顺序，后加入的在上 */
function pickInstance(x: number, y: number): PetInstance | null {
  for (let i = instances.length - 1; i >= 0; i--) {
    const inst = instances[i]
    const s = inst.spine.scale.x
    const left = inst.spine.x + inst.layoutBox.x * s
    const top = inst.spine.y + inst.layoutBox.y * s
    const right = left + inst.layoutBox.width * s
    const bottom = top + inst.layoutBox.height * s
    if (x >= left - 6 && x <= right + 6 && y >= top - 6 && y <= bottom + 6) return inst
  }
  return null
}

/** 把实例移到最上层，拖拽时不被其他角色遮住 */
function bringToFront(inst: PetInstance): void {
  const index = instances.indexOf(inst)
  if (index < 0 || index === instances.length - 1) return
  instances.splice(index, 1)
  instances.push(inst)
  if (app) {
    app.stage.removeChild(inst.spine)
    app.stage.addChild(inst.spine)
  }
}

/**
 * 量一次角色真实绘制的像素范围，算出四边相对中心点的间隙。
 * 逻辑框（size×size）比角色本体大很多，按逻辑框夹边界会留出很大空白。
 */
function measureVisualInsets(inst: PetInstance): void {
  if (!app) return
  const screenW = app.renderer.screen.width
  const screenH = app.renderer.screen.height
  const s = inst.spine.scale.x
  const boxLeft = inst.spine.x + inst.layoutBox.x * s
  const boxTop = inst.spine.y + inst.layoutBox.y * s
  const left = Math.max(0, Math.floor(boxLeft))
  const top = Math.max(0, Math.floor(boxTop))
  const right = Math.min(screenW, Math.ceil(boxLeft + inst.layoutBox.width * s))
  const bottom = Math.min(screenH, Math.ceil(boxTop + inst.layoutBox.height * s))
  const w = right - left
  const h = bottom - top
  if (w <= 0 || h <= 0) return

  // 只显示当前角色再读回，避免相邻角色的像素被算进轮廓
  const hidden: Spine[] = []
  for (const other of instances) {
    if (other !== inst && other.spine.visible) {
      other.spine.visible = false
      hidden.push(other.spine)
    }
  }

  let pixels: Uint8Array | Uint8ClampedArray | null = null
  try {
    app.renderer.render(app.stage)
    // Extract 的 y 轴以画面底部为原点
    pixels = app.renderer.extract.pixels(undefined, new Rectangle(left, screenH - bottom, w, h))
  } catch {
    pixels = null
  } finally {
    for (const spine of hidden) spine.visible = true
    app.renderer.render(app.stage)
  }
  if (!pixels || pixels.length < w * h * 4) return

  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (pixels[(y * w + x) * 4 + 3] > 16) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return

  // 读回的行序是自下而上，换算回自上而下
  const visualTop = top + h - 1 - maxY
  const visualBottom = top + h - 1 - minY
  const size = Math.max(1, logicalSize)
  inst.insets = {
    left: Math.max(0, inst.center.x - (left + minX)) / size,
    right: Math.max(0, left + maxX - inst.center.x) / size,
    top: Math.max(0, inst.center.y - visualTop) / size,
    bottom: Math.max(0, visualBottom - inst.center.y) / size,
  }
}

interface MotionBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * 角色中心点的活动范围。
 * 纵向用整段 idle 的包围盒并集（layoutBox）计算半高，保证任何待机姿势下脚都不会沉到画面外；
 * 横向仍按实测轮廓留出边距。
 */
function characterBounds(inst: PetInstance): MotionBounds {
  const size = Math.max(1, logicalSize)
  const s = inst.spine.scale.x && Number.isFinite(inst.spine.scale.x) ? inst.spine.scale.x : 0.5
  const halfHeight =
    Number.isFinite(inst.layoutBox.height) && inst.layoutBox.height > 0
      ? (inst.layoutBox.height / 2) * s
      : size / 2
  const left = Math.min(inst.insets.left * size * OVERHANG, window.innerWidth)
  const right = Math.min(inst.insets.right * size * OVERHANG, window.innerWidth)
  const top = Math.min(halfHeight, window.innerHeight / 2)
  const bottom = Math.min(halfHeight, window.innerHeight / 2)
  return {
    minX: left,
    minY: top,
    maxX: Math.max(left, window.innerWidth - right),
    // 底部不允许溢出：脚底正好贴在工作区底边，避免沉到任务栏下面
    maxY: Math.max(top, window.innerHeight - bottom - 1),
  }
}

/** 按角色真实轮廓夹取位置 */
function moveCharacter(inst: PetInstance, x: number, y: number): void {
  const bounds = characterBounds(inst)
  inst.center = {
    x: Math.min(Math.max(x, bounds.minX), bounds.maxX),
    y: Math.min(Math.max(y, bounds.minY), bounds.maxY),
  }
  applyCharacterPosition(inst)
}

// --- 拖拽甩抛物理：参数与曲线对齐 dsh-pet ---

/** 拖拽弹簧刚度 / 阻尼（过阻尼，跟手且不抖动） */
const SPRING_K = 200
const SPRING_C = 30
/** 拖拽轨迹保留窗口 */
const TRAIL_KEEP_MS = 200
/** 初速估算窗口：只取松手前这一段 */
const RELEASE_WINDOW_MS = 150
/** 松手前停顿超过它 = 温柔放下 */
const RELEASE_STALE_MS = 150
const MIN_SPAN_MS = 20
/** 高回报率鼠标的分段最小 dt */
const SEG_MIN_DT_MS = 8
/** 低于此速度不抛，原地放下 */
const DEAD_ZONE_SPEED = 500
/** 甩出速度软上限 */
const MAX_THROW_SPEED = 3600
/** 初速 = 端点均值与峰值加权 */
const PEAK_WEIGHT = 0.5
const ACCEL_REF = 8000
const ACCEL_GAIN_MAX = 0.6

/** 抛掷物理 */
const GRAVITY = 1400
const RESTITUTION = 0.78
const GROUND_FRICTION = 2.5
const REST_VY = 40
const REST_VX = 15
const MAX_STEP_DT = 0.05
const SUBSTEP_PX = 8
const SUBSTEP_MAX = 64

/** 角色间碰撞 */
const COLLISION_RESTITUTION = 0.55
const COLLISION_SLOP = 0.5
/** 撞上静止角色时，给它这个速度以上才真正弹开 */
const COLLISION_KICK = 60

/** Q 弹挤压 */
const SQ_DURATION_MS = 220
const SQ_CLICK_SQUASH = 0.55
const SQ_SOFT_SPEED = 300
const SQ_HARD_SPEED = 1500
const SQ_MAX_SQUASH = 0.55

/** 软钳速：单调递增且渐近不超过 MAX_THROW_SPEED */
function softClampSpeed(speed: number): number {
  if (speed <= 0) return 0
  return MAX_THROW_SPEED * (1 - Math.exp(-speed / MAX_THROW_SPEED))
}

/** 由拖拽轨迹估算松手初速；null = 温柔放下 */
function estimateReleaseVelocity(trail: DragSample[], now: number): { vx: number; vy: number } | null {
  if (trail.length === 0) return null
  const last = trail[trail.length - 1]
  if (now - last.t > RELEASE_STALE_MS) return null
  const win = trail.filter((s) => now - s.t <= RELEASE_WINDOW_MS)
  if (win.length < 2) return null

  const t0 = win[0].t
  const x0 = win[0].x
  const y0 = win[0].y
  const t1 = win[win.length - 1].t
  const x1 = win[win.length - 1].x
  const y1 = win[win.length - 1].y
  const spanMs = t1 - t0
  if (spanMs < MIN_SPAN_MS) return null

  const baseVx = ((x1 - x0) / spanMs) * 1000
  const baseVy = ((y1 - y0) / spanMs) * 1000
  const baseSpeed = Math.hypot(baseVx, baseVy)
  if (baseSpeed < 1e-6) return null

  // 分段速度：过密采样向前合并，避免把抖动放大成虚假峰值
  const segments: { speed: number; tEnd: number }[] = []
  let px = x0
  let py = y0
  let pt = t0
  for (const sample of win.slice(1)) {
    const dt = sample.t - pt
    if (dt < SEG_MIN_DT_MS) continue
    segments.push({ speed: (Math.hypot(sample.x - px, sample.y - py) / dt) * 1000, tEnd: sample.t })
    px = sample.x
    py = sample.y
    pt = sample.t
  }
  const peakSpeed = segments.length ? Math.max(...segments.map((s) => s.speed)) : baseSpeed

  // 末段仍在加速时放大初速（最多 60%）
  let accel = 0
  if (segments.length >= 2) {
    const lastSeg = segments[segments.length - 1]
    const firstSeg = segments[0]
    accel = (lastSeg.speed - firstSeg.speed) / Math.max((lastSeg.tEnd - firstSeg.tEnd) / 1000, MIN_SPAN_MS / 1000)
  }

  const speedBeforeClamp =
    ((1 - PEAK_WEIGHT) * baseSpeed + PEAK_WEIGHT * peakSpeed) *
    (1 + Math.min(Math.max(accel, 0) / ACCEL_REF, 1) * ACCEL_GAIN_MAX)
  const speed = softClampSpeed(speedBeforeClamp)
  if (speed < DEAD_ZONE_SPEED) return null
  return { vx: (baseVx / baseSpeed) * speed, vy: (baseVy / baseSpeed) * speed }
}

/** 一帧该积几步：快速甩抛时拆步，避免跨过落地/反弹帧 */
function throwSubsteps(vx: number, vy: number, dt: number): number {
  const travel = Math.hypot(vx, vy) * Math.min(Math.max(dt, 0), MAX_STEP_DT)
  if (!(travel > SUBSTEP_PX)) return 1
  return Math.min(SUBSTEP_MAX, Math.ceil(travel / SUBSTEP_PX))
}

/** 落地冲击速度 → 压扁幅度（越狠压得越深） */
function landingSquash(impactSpeed: number): number {
  const t = Math.min(Math.max((Math.abs(impactSpeed) - SQ_SOFT_SPEED) / (SQ_HARD_SPEED - SQ_SOFT_SPEED), 0), 1)
  return Math.min(0.8, 1 - t * (1 - SQ_MAX_SQUASH))
}

/** 挤压曲线：前 45% ease-in 下压，后段 easeOutBack 回弹过冲 */
function squashScale(u: number, depth: number): number {
  if (u < 0.45) {
    const p = u / 0.45
    return 1 - (1 - depth) * p * p
  }
  const p = (u - 0.45) / 0.55
  const c1 = 1.70158
  const c3 = c1 + 1
  const f = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2)
  return Math.min(1.12, depth + (1 - depth) * Math.max(f, 0))
}

function startSquash(inst: PetInstance, depth: number): void {
  inst.squash.active = true
  inst.squash.startedAt = performance.now()
  inst.squash.depth = depth
}

/** 以脚底为锚点做纵向压扁，脚不会离地 */
function updateSquash(inst: PetInstance): void {
  if (!inst.squash.active) return
  const u = Math.min((performance.now() - inst.squash.startedAt) / SQ_DURATION_MS, 1)
  const q = squashScale(u, inst.squash.depth)
  const s = inst.spine.scale.x
  const bottom = inst.layoutBox.y + inst.layoutBox.height
  inst.spine.scale.y = s * q
  inst.spine.y = inst.center.y - (inst.layoutBox.y + inst.layoutBox.height / 2) * s + bottom * s * (1 - q)
  if (u >= 1) {
    inst.squash.active = false
    inst.spine.scale.y = s
    applyCharacterPosition(inst)
  }
}

/** 结束拖拽/飞行，回到静置状态 */
function stopMotion(inst: PetInstance): void {
  inst.motion = 'idle'
  inst.velocity = { x: 0, y: 0 }
  inst.dragTrail = []
  inst.grounded = false
}

function commitPosition(inst: PetInstance): void {
  window.petAPI.setInstancePosition({
    id: inst.id,
    x: inst.center.x + window.screenX,
    y: inst.center.y + window.screenY,
  })
}

function startThrow(inst: PetInstance, vx: number, vy: number): void {
  inst.motion = 'throw'
  inst.velocity = { x: vx, y: vy }
  inst.grounded = false
  inst.dragTrail = []
  clearAutoTimer(inst)
}

/** 逐帧推进拖拽弹簧与抛掷积分 */
function updateMotion(inst: PetInstance, dtRaw: number): void {
  if (inst.motion === 'idle') return
  const dt = Math.min(Math.max(dtRaw, 0), MAX_STEP_DT)
  if (dt <= 0) return
  const bounds = characterBounds(inst)

  if (inst.motion === 'drag') {
    inst.velocity.x += ((inst.dragTarget.x - inst.center.x) * SPRING_K - inst.velocity.x * SPRING_C) * dt
    inst.velocity.y += ((inst.dragTarget.y - inst.center.y) * SPRING_K - inst.velocity.y * SPRING_C) * dt
    const x = inst.center.x + inst.velocity.x * dt
    const y = inst.center.y + inst.velocity.y * dt
    if (x <= bounds.minX || x >= bounds.maxX) inst.velocity.x = 0
    if (y <= bounds.minY || y >= bounds.maxY) inst.velocity.y = 0
    moveCharacter(
      inst,
      Math.min(Math.max(x, bounds.minX), bounds.maxX),
      Math.min(Math.max(y, bounds.minY), bounds.maxY)
    )
    return
  }

  // 飞行：重力 + 撞其他角色/四边反弹 + 地面摩擦
  const impactVy = inst.velocity.y
  const substeps = throwSubsteps(inst.velocity.x, inst.velocity.y, dt)
  const stepDt = dt / substeps
  let bounced = false
  let atRest = false

  for (let i = 0; i < substeps; i++) {
    inst.velocity.y += GRAVITY * stepDt
    let x = inst.center.x + inst.velocity.x * stepDt
    let y = inst.center.y + inst.velocity.y * stepDt

    if (x < bounds.minX) {
      x = bounds.minX
      inst.velocity.x = Math.abs(inst.velocity.x) * RESTITUTION
      bounced = true
    } else if (x > bounds.maxX) {
      x = bounds.maxX
      inst.velocity.x = -Math.abs(inst.velocity.x) * RESTITUTION
      bounced = true
    }
    if (y < bounds.minY) {
      y = bounds.minY
      inst.velocity.y = Math.abs(inst.velocity.y) * RESTITUTION
      bounced = true
    } else if (y >= bounds.maxY) {
      y = bounds.maxY
      inst.velocity.x *= Math.max(0, 1 - GROUND_FRICTION * stepDt)
      if (Math.abs(inst.velocity.y) < REST_VY) inst.velocity.y = 0
      else inst.velocity.y = -Math.abs(inst.velocity.y) * RESTITUTION
      bounced = true
    }

    inst.center = { x, y }
    applyCharacterPosition(inst)
    const grounded = y >= bounds.maxY - 1
    // 只在空中→地面的那一帧触发一次落地形变
    if (bounced && grounded && !inst.grounded) startSquash(inst, landingSquash(impactVy))
    inst.grounded = grounded

    const speed = Math.hypot(inst.velocity.x, inst.velocity.y)
    atRest =
      (grounded && Math.abs(inst.velocity.y) < 1 && Math.abs(inst.velocity.x) < REST_VX) ||
      (bounced && speed < REST_VY && Math.abs(inst.velocity.y) < 1)
    if (atRest) break
  }

  applyCharacterPosition(inst)
  if (atRest) {
    stopMotion(inst)
    commitPosition(inst)
    scheduleNextAutoAction(inst)
  }
}

// --- 角色间碰撞：水平互斥推挤 + 撞击弹开 ---

/** 碰撞用身体宽度：取实测轮廓均值再收窄，避免头发和道具形成空气墙 */
function footprint(inst: PetInstance): { halfW: number; halfH: number } {
  const s = inst.spine.scale.x && Number.isFinite(inst.spine.scale.x) ? inst.spine.scale.x : 0.5
  const halfH = Math.max(8, (inst.layoutBox.height * s) / 2)
  const visualHalfW = ((inst.insets.left + inst.insets.right) / 2) * logicalSize
  return { halfW: Math.max(10, visualHalfW * 0.75), halfH }
}

function resolveCollisions(): void {
  for (let i = 0; i < instances.length; i++) {
    for (let j = i + 1; j < instances.length; j++) {
      resolvePair(instances[i], instances[j])
    }
  }
}

function resolvePair(a: PetInstance, b: PetInstance): void {
  if (!a.spine.visible || !b.spine.visible) return
  const fa = footprint(a)
  const fb = footprint(b)
  // 纵向完全不重叠就不可能碰到
  if (Math.abs(b.center.y - a.center.y) >= fa.halfH + fb.halfH) return

  const overlap = fa.halfW + fb.halfW - Math.abs(b.center.x - a.center.x)
  if (overlap <= COLLISION_SLOP) return

  const n = b.center.x >= a.center.x ? 1 : -1
  // 正在被拖拽的角色视为无限质量，只推别人
  const invA = a.motion === 'drag' ? 0 : 1
  const invB = b.motion === 'drag' ? 0 : 1
  const invSum = invA + invB
  if (invSum === 0) return

  const push = overlap - COLLISION_SLOP
  if (invA > 0) moveCharacter(a, a.center.x - n * push * (invA / invSum), a.center.y)
  if (invB > 0) moveCharacter(b, b.center.x + n * push * (invB / invSum), b.center.y)

  // 关闭甩抛物理时只做位置分离，不产生弹开
  if (!behavior.throwPhysics) return
  const rel = (b.velocity.x - a.velocity.x) * n
  if (rel >= 0) return

  const impulse = (-(1 + COLLISION_RESTITUTION) * rel) / invSum
  if (invA > 0) applyCollisionImpulse(a, -impulse * invA * n)
  if (invB > 0) applyCollisionImpulse(b, impulse * invB * n)
}

/** 被撞到的静止角色获得速度并从地面弹出去 */
function applyCollisionImpulse(inst: PetInstance, dvx: number): void {
  if (Math.abs(dvx) < COLLISION_KICK) return
  if (inst.motion === 'idle') {
    inst.motion = 'throw'
    inst.grounded = false
    inst.velocity = { x: dvx, y: 0 }
    clearAutoTimer(inst)
  } else if (inst.motion === 'throw') {
    inst.velocity.x += dvx
  }
}

// --- 指针交互 ---

function setupDrag(): void {
  if (!canvas) return
  const target = canvas

  target.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || renameOpen || gesture) return
    if (!isOnCharacter(e.clientX, e.clientY)) return
    const inst = pickInstance(e.clientX, e.clientY)
    if (!inst) return
    e.preventDefault()
    target.setPointerCapture(e.pointerId)
    bringToFront(inst)
    gesture = {
      pointerId: e.pointerId,
      inst,
      grabX: inst.center.x - e.clientX,
      grabY: inst.center.y - e.clientY,
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      dragging: false,
    }
    // 拎起角色时准备轨迹；真正开始拖动后才接管物理状态
    if (behavior.throwPhysics) {
      inst.dragTarget = { x: inst.center.x, y: inst.center.y }
      inst.dragTrail = []
    }
    setMouseIgnore(false)
  })

  target.addEventListener('pointermove', (e) => {
    if (!gesture || e.pointerId !== gesture.pointerId) return
    const inst = gesture.inst
    // 鼠标键已经松开却丢掉了 pointerup 时，主动收尾，避免手势卡死挡住桌面
    if (e.buttons === 0) {
      finishGesture(target, gesture.pointerId, false, e.clientX, e.clientY)
      return
    }
    if (!gesture.dragging) {
      const distance = Math.hypot(
        e.screenX - gesture.startScreenX,
        e.screenY - gesture.startScreenY,
      )
      if (distance <= DRAG_THRESHOLD) return
      gesture.dragging = true
      if (behavior.throwPhysics) {
        // 飞行中被抓住：立刻停止抛掷，改由弹簧接管
        inst.motion = 'drag'
        inst.velocity = { x: 0, y: 0 }
        clearAutoTimer(inst)
      }
    }
    if (!behavior.throwPhysics) {
      // 关闭弹跳时保持原来的直接拖放
      moveCharacter(inst, e.clientX + gesture.grabX, e.clientY + gesture.grabY)
      return
    }
    // 弹簧跟手：记录目标点和轨迹，实际位移由 ticker 推进
    inst.dragTarget = {
      x: e.clientX + gesture.grabX,
      y: e.clientY + gesture.grabY,
    }
    const now = performance.now()
    inst.dragTrail.push({ t: now, x: e.clientX, y: e.clientY })
    const cutoff = now - TRAIL_KEEP_MS
    while (inst.dragTrail.length > 0 && inst.dragTrail[0].t < cutoff) inst.dragTrail.shift()
  })

  // 统一挂在 window 上：指针捕获期间事件仍会冒泡到这里，丢失捕获时也能收到
  window.addEventListener('pointerup', (e) => {
    finishGesture(target, e.pointerId, e.button === 0, e.clientX, e.clientY)
  })
  window.addEventListener('pointercancel', (e) => {
    finishGesture(target, e.pointerId, false)
  })
  window.addEventListener('lostpointercapture', (e) => {
    finishGesture(target, e.pointerId, false)
  })
  window.addEventListener('blur', () => {
    if (gesture) finishGesture(target, gesture.pointerId, false)
  })
}

function finishGesture(
  target: HTMLCanvasElement,
  pointerId: number,
  allowClick: boolean,
  x?: number,
  y?: number,
): void {
  if (!gesture || gesture.pointerId !== pointerId) return
  const inst = gesture.inst
  const wasDragging = gesture.dragging
  gesture = null
  if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
  if (wasDragging) {
    if (behavior.throwPhysics) {
      const velocity = estimateReleaseVelocity(inst.dragTrail, performance.now())
      if (velocity) {
        startThrow(inst, velocity.vx, velocity.vy)
      } else {
        // 温柔放下
        stopMotion(inst)
        commitPosition(inst)
        scheduleNextAutoAction(inst)
      }
    } else {
      // 换算成屏幕绝对坐标交给主进程持久化
      commitPosition(inst)
    }
  }
  updateHit(x ?? lastPointer.x, y ?? lastPointer.y)
  if (allowClick && !wasDragging && behavior.clickAction && inst.motion === 'idle') {
    if (behavior.throwPhysics) startSquash(inst, SQ_CLICK_SQUASH)
    playRandomAction(inst)
  }
}

// --- 重命名弹层 ---
function setupRenameOverlay(): void {
  const layer = document.getElementById('rename') as HTMLDivElement
  const input = document.getElementById('rename-input') as HTMLInputElement
  const okBtn = document.getElementById('rename-ok') as HTMLButtonElement
  const cancelBtn = document.getElementById('rename-cancel') as HTMLButtonElement
  let currentId = ''

  const finish = (commit: boolean): void => {
    if (!renameOpen) return
    renameOpen = false
    layer.hidden = true
    updateHit()
    if (commit) {
      const name = input.value.trim()
      if (name) window.petAPI.renameCharacter(currentId, name)
    }
  }

  window.petAPI.onRenamePrompt(({ id, name }) => {
    currentId = id
    input.value = name
    renameOpen = true
    layer.hidden = false
    input.focus()
    input.select()
  })

  okBtn.addEventListener('click', () => finish(true))
  cancelBtn.addEventListener('click', () => finish(false))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true)
    else if (e.key === 'Escape') finish(false)
  })
}

// --- 右键菜单 ---
function setupContextMenu(): void {
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (renameOpen || instances.length === 0) return
    const inst = pickInstance(e.clientX, e.clientY) ?? instances[0]
    bringToFront(inst)
    const names = inst.spine.skeleton.data.animations
      .map((a) => a.name)
      .filter((n) => n.startsWith('ANIM/'))
    window.petAPI.showContextMenu(names, inst.currentAnimation)
  })
}

bootstrap().catch((e) => {
  console.error('[Pet] bootstrap FAILED:', e)
})
