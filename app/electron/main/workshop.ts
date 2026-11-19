import { execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { nativeImage } from 'electron'
import { readElpackHeader } from './elpack'

/** 创意工坊内容所属的 EmoteLab AppID */
const APP_ID = '4301100'

export interface WorkshopItem {
  /** Steam PublishedFileId */
  id: string
  /** 工坊内容目录（含 character.elpack / preview.png / workshop.meta.json） */
  dir: string
  title: string
  /** 角色名取自 .elpack 头，失败时回退到工坊标题 */
  displayName?: string
  /** 预览图缩略图，data URL */
  preview?: string
  required?: string[]
}

interface WorkshopMeta {
  Title?: string
  PreviewImageFileName?: string
  RequiredPublishedFileIds?: string[]
  ContentType?: string
}

function readJson<T>(file: string): T | null {
  try {
    if (!existsSync(file)) return null
    // Steam 写出的 JSON 带 UTF-8 BOM
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** Steam 安装目录在进程内只探测一次：reg query 是同步子进程，重复调用会卡住主进程 */
let cachedRoot: { value: string | null } | null = null

/** 从注册表读取 Steam 安装目录，失败时尝试常见路径 */
function steamRoot(): string | null {
  if (cachedRoot) return cachedRoot.value

  const keys = ['HKCU\\Software\\Valve\\Steam', 'HKCU\\Software\\WOW6432Node\\Valve\\Steam']
  for (const key of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'SteamPath'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(out)
      const value = m?.[1]?.trim()
      if (value && existsSync(value)) {
        cachedRoot = { value }
        return value
      }
    } catch {
      // 没有该注册表项时继续尝试
    }
  }

  const candidates = [
    join(process.env['ProgramFiles(x86)'] ?? '', 'Steam'),
    join(process.env.ProgramFiles ?? '', 'Steam'),
  ]
  const fallback = candidates.find((p) => p && existsSync(p)) ?? null
  cachedRoot = { value: fallback }
  return fallback
}

/** 解析 libraryfolders.vdf，得到所有 Steam 库目录 */
function libraryRoots(root: string): string[] {
  const roots = new Set<string>([root])
  const vdf = join(root, 'steamapps', 'libraryfolders.vdf')
  try {
    const text = readFileSync(vdf, 'utf8')
    // 新版格式："path" "D:\\SteamLibrary"
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/gi)) {
      roots.add(m[1].replace(/\\\\/g, '\\'))
    }
    // 旧版格式："1" "D:\\SteamLibrary"
    for (const m of text.matchAll(/"\d+"\s+"([^"]+)"/g)) {
      roots.add(m[1].replace(/\\\\/g, '\\'))
    }
  } catch {
    // 没有该文件时只用主库
  }
  return [...roots].filter((p) => existsSync(p))
}

function previewUrl(file: string): string | undefined {
  try {
    if (!existsSync(file)) return undefined
    const image = nativeImage.createFromPath(file)
    if (image.isEmpty()) return undefined
    const small = image.resize({ width: 96, quality: 'good' })
    return small.toDataURL()
  } catch {
    return undefined
  }
}

interface CacheEntry {
  /** character.elpack 的修改时间与大小，任一变化都视为 Steam 更新了内容 */
  mtimeMs: number
  size: number
  dir: string
  item: WorkshopItem
}

/** 进程内扫描缓存：按工坊目录 + elpack 修改时间/大小命中（同一内容可能存在于多个库） */
const cache = new Map<string, CacheEntry>()

/** 扫描所有 Steam 库中的 EmoteLab 创意工坊角色 */
export function scanWorkshopCharacters(): WorkshopItem[] {
  const root = steamRoot()
  if (!root) {
    cache.clear()
    return []
  }

  const items = new Map<string, WorkshopItem>()
  const seen = new Set<string>()
  for (const library of libraryRoots(root)) {
    const contentDir = join(library, 'steamapps', 'workshop', 'content', APP_ID)
    let entries: string[]
    try {
      entries = readdirSync(contentDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      continue
    }

    for (const id of entries) {
      const dir = join(contentDir, id)
      const elpack = join(dir, 'character.elpack')
      let mtimeMs = 0
      let size = 0
      try {
        const stat = statSync(elpack)
        mtimeMs = stat.mtimeMs
        size = stat.size
      } catch {
        continue
      }

      seen.add(dir)
      const hit = cache.get(dir)
      if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
        items.set(id, hit.item)
        continue
      }

      const meta = readJson<WorkshopMeta>(join(dir, 'workshop.meta.json'))
      let headerName: string | undefined
      try {
        headerName = readElpackHeader(elpack).DisplayName
      } catch (e) {
        console.warn('[Pet] 读取工坊角色包失败', elpack, e)
      }

      const previewFile = meta?.PreviewImageFileName || 'preview.png'
      const item: WorkshopItem = {
        id,
        dir,
        title: (meta?.Title || headerName || `工坊角色 ${id}`).trim(),
        displayName: headerName,
        preview: previewUrl(join(dir, previewFile)),
        required: meta?.RequiredPublishedFileIds,
      }
      cache.set(dir, { mtimeMs, size, dir, item })
      items.set(id, item)
    }
  }

  // Steam 取消订阅或删除后，把缓存里的旧条目一起清掉
  for (const dir of [...cache.keys()]) {
    if (!seen.has(dir)) cache.delete(dir)
  }

  return [...items.values()].sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
}
