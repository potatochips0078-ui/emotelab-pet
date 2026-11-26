import { Assets } from 'pixi.js'
import { Spine, SpineTexture } from '@esotericsoftware/spine-pixi-v7'
import {
  Color,
  Physics,
  SkeletonBinary,
  AtlasAttachmentLoader,
  TextureAtlas,
  TextureAtlasPage,
  TextureAtlasRegion,
  Skin,
  Slider,
} from '@esotericsoftware/spine-core'
import type { Application, Texture } from 'pixi.js'
import type { Sequence, Skeleton, SkeletonData } from '@esotericsoftware/spine-core'
import { logWarn } from './logger'

/**
 * 同一份资源（按 URL）会被多个角色实例共用：骨架、基础图集、同名工坊贴图。
 * 这里按 URL 引用计数，只有最后一个使用者销毁时才真正卸载，
 * 否则移除一只角色会把其他角色的贴图一起卸掉。
 */
const assetRefs = new Map<string, { count: number; alias: string }>()

async function acquireAsset<T>(alias: string, src: string): Promise<T> {
  const entry = assetRefs.get(src)
  if (entry) {
    entry.count++
    return Assets.load<T>(entry.alias)
  }
  Assets.add({ alias, src })
  assetRefs.set(src, { count: 1, alias })
  return Assets.load<T>(alias)
}

function releaseAsset(src: string): void {
  const entry = assetRefs.get(src)
  if (!entry) return
  entry.count--
  if (entry.count > 0) return
  assetRefs.delete(src)
  try {
    Assets.unload(entry.alias)
  } catch {
    // 已经卸载过
  }
}

/** 复制一份图集结构：工坊贴图替换只影响自己的副本，不会污染共用基础图集的其他角色 */
function cloneAtlas(source: TextureAtlas): TextureAtlas {
  const clone = Object.create(TextureAtlas.prototype) as TextureAtlas
  clone.pages = []
  clone.regions = []
  const pages = new Map<TextureAtlasPage, TextureAtlasPage>()
  for (const page of source.pages) {
    const copy = new TextureAtlasPage(page.name)
    Object.assign(copy, page)
    pages.set(page, copy)
    clone.pages.push(copy)
  }
  for (const region of source.regions) {
    const page = pages.get(region.page) ?? region.page
    const copy = new TextureAtlasRegion(page, region.name)
    Object.assign(copy, region)
    copy.page = page
    clone.regions.push(copy)
  }
  return clone
}

interface CharacterMeta {
  ActiveSkins?: { Items?: { Key: string; Value: string }[] }
  SlotGroups?: {
    Name: string
    TintColor: { r: number; g: number; b: number; a: number }
    /** RenderMode 为 2 表示双色渐变染色：暗部使用 TintBlackColor */
    TintBlackColor?: { r: number; g: number; b: number; a: number }
    RenderMode?: number
  }[]
  /** EmoteLab 的滑杆取值，对应 CHAR/ 动画上的时间（秒） */
  SliderConstraints?: { Name: string; Value: number }[]
}

export interface CharacterInfo {
  id: string
  name: string
  /** 默认角色为空，走打包内的相对路径；导入角色为 petfile:// 协议地址 */
  baseUrl: string
  skel: string
  atlas: string
  meta: string | null
  /** 外观预设角色：character.json 与骨架不同目录，这里给完整地址 */
  metaUrl?: string
  /** 复用内置 CoffeeBean 骨架；创意工坊角色还会带 Regions 自定义贴图 */
  model?: 'default'
}

export async function resolveResourceUrl(relativePath: string): Promise<string> {
  if (window.petAPI) {
    const url = await window.petAPI.resolveResource(relativePath)
    if (url) return url
  }
  return import.meta.env.BASE_URL + relativePath.replace(/^\//, '')
}

/** 皮肤名形如 G_Outfit/Hand[Required]/Hand1：最后一段是选项，其余是分组名 */
function skinGroupName(fullName: string): string {
  const parts = fullName.split('/')
  parts.pop()
  return parts.join('/')
}

/** EmoteLab 角色由多个可选皮肤叠加而成，按 character.json 中的 ActiveSkins 组合。 */
function buildEmoteLabSkin(data: SkeletonData, meta: CharacterMeta): Skin {
  const skin = new Skin('emotelab')
  if (data.defaultSkin) skin.addSkin(data.defaultSkin)

  const coveredGroups = new Set<string>()
  for (const item of meta.ActiveSkins?.Items ?? []) {
    const target = item.Value
    const found = data.skins.find((s) => {
      const leaf = s.name.split('/').pop()
      return leaf === target || s.name === target
    })
    if (found) {
      skin.addSkin(found)
      coveredGroups.add(skinGroupName(found.name))
    }
  }

  // [Required] 分组在 EmoteLab 里必定选中一项，但导出的预设可能省略（如 Hand/Leg），
  // 缺了会导致手脚等部件不显示，这里补上该组的第一个选项。
  const filled: string[] = []
  for (const s of data.skins) {
    const group = skinGroupName(s.name)
    if (!/\[Required\]$/.test(group) || coveredGroups.has(group)) continue
    coveredGroups.add(group)
    skin.addSkin(s)
    filled.push(s.name.split('/').pop() ?? s.name)
  }
  if (filled.length > 0) console.log('[Pet] 补齐必需皮肤分组:', filled.join(', '))

  return skin
}

/** EmoteLab 用槽位名末尾的 [Group] 标记染色分组，颜色取自 SlotGroups。 */
function applySlotTints(data: SkeletonData, meta: CharacterMeta): void {
  const groups = new Map((meta.SlotGroups ?? []).map((g) => [g.Name, g]))
  if (groups.size === 0) return

  for (const slotData of data.slots) {
    const m = /\[([^\]]+)\]$/.exec(slotData.name)
    if (!m) continue
    const group = groups.get(m[1])
    if (!group) continue

    const tint = group.TintColor
    slotData.setupPose.color.set(tint.r, tint.g, tint.b, tint.a)

    // 渐变发色贴图是白→黑灰度图，RenderMode 2 时暗部应染成 TintBlackColor。
    // 必须在 Skeleton 构造前写入：Slot 只有在 setupPose.darkColor 非空时才会分配
    // pose.darkColor，否则运行时会给暗部填黑色，导致发梢渐变发黑。
    const dark = group.TintBlackColor
    if (group.RenderMode === 2 && dark) {
      if (!slotData.setupPose.darkColor) slotData.setupPose.darkColor = new Color()
      slotData.setupPose.darkColor.set(dark.r, dark.g, dark.b, dark.a)
    }
  }
}

/** 一次加载持有的资源，dispose 时只释放这次加载的贴图 */
export interface LoadedCharacter {
  spine: Spine
  dispose: () => void
}

/**
 * character.json 里的滑动条对应骨架内置的 Spine Slider 约束（Character/xxx），
 * 取值就是该约束动画上的时间。Slider 会把动画以叠加方式应用到骨骼上，
 * 并以自身的 setupPose.time 作为「等于默认姿态」的零点；
 * 直接按绝对姿态播放 CHAR/xxx 动画会得到完全不同的幅度（例如把 0 当成极端姿态），
 * 所以这里必须走骨架自带的 Slider，才能和 EmoteLab 里的显示一致。
 */
function applySliderConstraints(skeleton: Skeleton, meta: CharacterMeta): void {
  const items = meta.SliderConstraints ?? []
  if (items.length === 0) return

  for (const item of items) {
    if (!Number.isFinite(item.Value)) continue
    const slider = skeleton.constraints.find(
      (c): c is Slider => c instanceof Slider && c.data.name === item.Name
    )
    // 骨架里没有这个滑杆就跳过（例如从别的模型带过来的配置）
    if (!slider) continue
    slider.pose.time = item.Value
    slider.pose.mix = 1
  }
  // Slider 在每次 updateWorldTransform 时自行应用，这里先算一次供后续测量包围盒
  skeleton.updateWorldTransform(Physics.update)
}

/** 收集皮肤实际引用的 atlas region 名，只按需加载工坊贴图 */
function collectRegionNames(skin: Skin): Set<string> {
  const names = new Set<string>()
  for (const entry of skin.getAttachments()) {
    const sequence = (entry.attachment as { sequence?: Sequence }).sequence
    if (!sequence) continue
    for (const region of sequence.regions as TextureAtlasRegion[]) {
      if (region?.name) names.add(region.name)
    }
  }
  return names
}

/**
 * 创意工坊角色复用内置 CoffeeBean 图集，但贴图来自角色包里的 Regions/*.png。
 * PNG 是未裁剪的原始画布，因此为每个用到的 region 单独建页，
 * 用原始 offsets 推出裁剪区域在该画布中的 UV，再替换图集里的 region 与各附件序列。
 */
async function applyCustomTextures(
  data: SkeletonData,
  atlas: TextureAtlas,
  skin: Skin,
  info: CharacterInfo,
  acquireTexture: (src: string) => Promise<Texture>
): Promise<void> {
  if (info.model !== 'default' || !window.petAPI?.resolveCharacterTextures) return
  const names = [...collectRegionNames(skin)]
  if (names.length === 0) return

  let resolved: Record<string, string>
  try {
    resolved = await window.petAPI.resolveCharacterTextures(info.id, names)
  } catch (e) {
    logWarn('[Pet] 解析工坊贴图失败:', e)
    return
  }

  const replacements = new Map<string, TextureAtlasRegion>()
  for (const [name, src] of Object.entries(resolved)) {
    const old = atlas.findRegion(name)
    if (!old) continue

    try {
      const texture = await acquireTexture(src)
      if (texture.width !== old.originalWidth || texture.height !== old.originalHeight) {
        logWarn(
          '[Pet] 工坊贴图尺寸与图集不一致，跳过:',
          name,
          `${texture.width}x${texture.height}`,
          `期望 ${old.originalWidth}x${old.originalHeight}`
        )
        continue
      }

      const page = new TextureAtlasPage(name)
      page.width = texture.width
      page.height = texture.height
      page.minFilter = old.page.minFilter
      page.magFilter = old.page.magFilter
      page.uWrap = old.page.uWrap
      page.vWrap = old.page.vWrap
      page.pma = old.page.pma

      const region = new TextureAtlasRegion(page, name)
      // PNG 坐标原点在左上角，atlas 的 offsetY 从底部量起，这里换算成裁剪区域左上角
      region.x = old.offsetX
      region.y = page.height - old.offsetY - old.height
      region.width = old.width
      region.height = old.height
      region.offsetX = old.offsetX
      region.offsetY = old.offsetY
      region.originalWidth = old.originalWidth
      region.originalHeight = old.originalHeight
      region.index = old.index
      region.u = region.x / page.width
      region.v = region.y / page.height
      region.u2 = (region.x + region.width) / page.width
      region.v2 = (region.y + region.height) / page.height

      // 必须在 region 创建之后设置页纹理，setTexture 会把纹理同步到已存在的 region
      page.setTexture(SpineTexture.from(texture.baseTexture))

      replacements.set(name, region)
    } catch (e) {
      logWarn('[Pet] 加载工坊贴图失败:', name, e)
    }
  }

  if (replacements.size === 0) return
  for (let i = 0; i < atlas.regions.length; i++) {
    const replacement = replacements.get(atlas.regions[i].name)
    if (replacement) atlas.regions[i] = replacement
  }

  // 附件在解析骨架时已绑定旧 region，需要替换序列里的引用并重算 UV
  const patched = new Set<unknown>()
  const skins = [data.defaultSkin, ...data.skins].filter((s): s is Skin => !!s)
  for (const item of skins) {
    for (const entry of item.getAttachments()) {
      const attachment = entry.attachment as {
        sequence?: Sequence
        updateSequence?: () => void
      }
      const sequence = attachment.sequence
      if (!sequence) continue
      let changed = false
      for (let i = 0; i < sequence.regions.length; i++) {
        const region = sequence.regions[i] as TextureAtlasRegion | null
        const replacement = region ? replacements.get(region.name) : undefined
        if (replacement) {
          sequence.regions[i] = replacement
          changed = true
        }
      }
      if (changed && attachment.updateSequence && !patched.has(attachment)) {
        patched.add(attachment)
        attachment.updateSequence()
      }
    }
  }
  console.log('[Pet] 工坊自定义贴图已应用:', replacements.size)
}

export async function loadCharacter(
  _app: Application,
  info: CharacterInfo
): Promise<LoadedCharacter> {
  // 预设/工坊角色的骨架与图集都来自内置 CoffeeBean，baseUrl 只用于取 character.json
  const builtinBase = (await resolveResourceUrl('default-character')) + '/'
  const base = info.model === 'default' ? builtinBase : info.baseUrl || builtinBase
  const url = (file: string): string =>
    base.endsWith('/') ? base + file : `${base}/${file}`

  const generation = Date.now().toString(36)
  let assetSeq = 0
  // 记录本次加载引用到的资源 URL，销毁时按引用计数释放
  const usedSrcs: string[] = []
  const acquire = <T>(kind: string, src: string): Promise<T> => {
    usedSrcs.push(src)
    return acquireAsset<T>(`char-${info.id}-${generation}-${kind}-${assetSeq++}`, src)
  }
  const dispose = (): void => {
    while (usedSrcs.length) releaseAsset(usedSrcs.pop()!)
  }

  let meta: CharacterMeta = {}
  if (info.meta) {
    meta = await acquire<CharacterMeta>('meta', info.metaUrl ?? url(info.meta))
  }

  const skelBytes = await acquire<Uint8Array>('skel', url(info.skel))
  const sharedAtlas = await acquire<TextureAtlas>('atlas', url(info.atlas))
  // 每个角色用独立副本，工坊贴图替换不会串到其他角色
  const textureAtlas = cloneAtlas(sharedAtlas)

  const attachmentLoader = new AtlasAttachmentLoader(textureAtlas)
  const skeletonBinary = new SkeletonBinary(attachmentLoader)
  skeletonBinary.scale = 1

  const skeletonData = skeletonBinary.readSkeletonData(skelBytes)
  const compositeSkin = buildEmoteLabSkin(skeletonData, meta)

  await applyCustomTextures(skeletonData, textureAtlas, compositeSkin, info, (src) =>
    acquire<Texture>('tex', src)
  )

  applySlotTints(skeletonData, meta)

  const spine = new Spine({ skeletonData })
  spine.skeleton.setSkin(compositeSkin)
  spine.skeleton.setupPose()
  // 滑杆姿态必须在皮肤就绪后应用，并且要早于渲染层测量包围盒
  applySliderConstraints(spine.skeleton, meta)

  return { spine, dispose }
}
