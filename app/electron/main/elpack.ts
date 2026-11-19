import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { inflateRawSync } from 'zlib'

/** .elpack 的 JSON 头，只关心角色渲染需要的字段 */
export interface ElpackHeader {
  SchemaVersion?: number
  ContentType?: string
  SharedModelKey?: string
  DisplayName?: string
  MinEmoteLabVersion?: string
  SkeletonEntry?: string
  AtlasEntry?: string
  PresetEntry?: string
}

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localOffset: number
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
/** 防御异常包：限制条目数与解压总大小 */
const MAX_ENTRIES = 4000
const MAX_TOTAL_BYTES = 512 * 1024 * 1024

/** 只读文件头，扫描工坊目录时不必加载整个 10MB+ 包 */
export function readElpackHeader(file: string): ElpackHeader {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(24)
    if (readSync(fd, head, 0, 24, 0) !== 24) throw new Error('角色包过小')
    checkMagic(head)
    const headerLength = head.readUInt32LE(8)
    if (headerLength <= 0 || headerLength > 1024 * 1024) throw new Error('角色包头部长度异常')
    const body = Buffer.alloc(headerLength)
    if (readSync(fd, body, 0, headerLength, 24) !== headerLength) throw new Error('角色包头部不完整')
    return JSON.parse(body.toString('utf8').replace(/^\uFEFF/, '')) as ElpackHeader
  } finally {
    closeSync(fd)
  }
}

function checkMagic(head: Buffer): void {
  if (head.length < 24 || head.toString('latin1', 0, 4) !== 'ELPK') {
    throw new Error('不是有效的 EmoteLab 角色包（缺少 ELPK 标识）')
  }
  const version = head.readUInt32LE(4)
  if (version !== 1) throw new Error(`暂不支持的角色包版本：${version}`)
}

/** ZIP 文件名可能是 UTF-8，也可能是 CP437；工坊内容以 UTF-8 为主 */
function decodeName(buf: Buffer, offset: number, length: number): string {
  return buf.toString('utf8', offset, offset + length)
}

/** 规范化 ZIP 内路径，拒绝绝对路径与目录穿越 */
function safeRelative(name: string): string | null {
  const rel = name.replace(/\\/g, '/')
  if (!rel || rel.startsWith('/') || rel.includes('\0')) return null
  const parts = rel.split('/').filter((p) => p && p !== '.')
  if (parts.length === 0 || parts.some((p) => p === '..')) return null
  return parts.join('/')
}

function findEndOfCentralDirectory(buf: Buffer, start: number, end: number): number {
  const min = Math.max(start, end - 65557)
  for (let i = end - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i
  }
  throw new Error('角色包负载不是有效的 ZIP 文件')
}

function readZipEntries(buf: Buffer, start: number, end: number): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buf, start, end)
  const disk = buf.readUInt16LE(eocd + 4)
  const centralDisk = buf.readUInt16LE(eocd + 6)
  if (disk !== 0 || centralDisk !== 0) throw new Error('不支持分卷角色包')
  let count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || offset === 0xffffffff) throw new Error('暂不支持 ZIP64 角色包')
  if (count > MAX_ENTRIES) throw new Error('角色包条目过多')

  const entries: ZipEntry[] = []
  let p = start + offset
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || buf.readUInt32LE(p) !== CENTRAL_SIGNATURE) {
      throw new Error('角色包目录结构损坏')
    }
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const nameLength = buf.readUInt16LE(p + 28)
    const extraLength = buf.readUInt16LE(p + 30)
    const commentLength = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = decodeName(buf, p + 46, nameLength)
    entries.push({ name, method, compressedSize, localOffset })
    p += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readEntryData(buf: Buffer, payloadStart: number, entry: ZipEntry): Buffer {
  const local = payloadStart + entry.localOffset
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL_SIGNATURE) {
    throw new Error(`角色包条目损坏：${entry.name}`)
  }
  const nameLength = buf.readUInt16LE(local + 26)
  const extraLength = buf.readUInt16LE(local + 28)
  const dataStart = local + 30 + nameLength + extraLength
  if (dataStart + entry.compressedSize > buf.length) {
    throw new Error(`角色包条目越界：${entry.name}`)
  }
  const raw = buf.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.method === 0) return raw
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw)
    } catch {
      throw new Error(`角色包条目解压失败：${entry.name}`)
    }
  }
  throw new Error(`不支持的角色包压缩方式：${entry.method}`)
}

export interface ExtractedElpack {
  header: ElpackHeader
  /** 写入的角色预设文件名（固定为 character.json） */
  presetFile: string
  regionCount: number
}

/**
 * 解出工坊角色包：预设 JSON 写成 character.json，Regions/**.png 按原路径落盘。
 * 注意 Regions/WeightTransfer/*.png 不是辅助文件，它们是自定义皮肤真正的可见外观。
 */
export function extractElpack(file: string, targetDir: string): ExtractedElpack {
  const buf = readFileSync(file)
  checkMagic(buf)
  const headerLength = buf.readUInt32LE(8)
  const payloadLength = buf.readUInt32LE(12)
  const payloadStart = 24 + headerLength
  if (headerLength <= 0 || payloadLength <= 0 || payloadStart + payloadLength > buf.length) {
    throw new Error('角色包负载长度异常')
  }

  const header = JSON.parse(buf.toString('utf8', 24, 24 + headerLength).replace(/^\uFEFF/, '')) as ElpackHeader
  const entries = readZipEntries(buf, payloadStart, payloadStart + payloadLength)

  const jsonEntry =
    entries.find((e) => header.PresetEntry && e.name === header.PresetEntry) ??
    entries.find((e) => /^[^/]+\.json$/i.test(e.name))
  if (!jsonEntry) throw new Error('角色包中没有找到角色预设 JSON')

  const regionEntries = entries.filter((e) => {
    const rel = safeRelative(e.name)
    return rel && /^Regions\/[^/].*\.png$/i.test(rel)
  })
  if (regionEntries.length === 0) throw new Error('角色包中没有找到自定义贴图')

  let total = 0
  mkdirSync(targetDir, { recursive: true })
  // 重新解包时先清掉旧贴图，避免残留已删除的 region
  rmSync(join(targetDir, 'Regions'), { recursive: true, force: true })

  const preset = readEntryData(buf, payloadStart, jsonEntry)
  writeFileSync(join(targetDir, 'character.json'), preset)

  let regionCount = 0
  for (const entry of regionEntries) {
    const rel = safeRelative(entry.name)
    if (!rel) continue
    const data = readEntryData(buf, payloadStart, entry)
    total += data.length
    if (total > MAX_TOTAL_BYTES) throw new Error('角色包解压后体积过大')
    const out = join(targetDir, ...rel.split('/'))
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, data)
    regionCount++
  }

  return { header, presetFile: 'character.json', regionCount }
}
