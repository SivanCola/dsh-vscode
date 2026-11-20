import { randomUUID } from 'node:crypto'
import { mkdir, open, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ContentBlock } from '@agentclientprotocol/sdk'

const textLimit = 256 * 1024
export const draftFileBudget = 8 * 1024 * 1024
type Payload = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }
export type FileAttachment = {
  kind: 'file'; id: string; path: string; name: string; size: number; payload?: Payload; clipboard?: boolean
}

function imageType(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
}

export async function pickFile(path: string, remaining: number, images?: boolean): Promise<FileAttachment> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error('Expected a regular file')
  const file: FileAttachment = { kind: 'file', id: randomUUID(), name: basename(path), path, size: info.size }
  if (info.size > remaining) return file
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(12)
    const prefix = await handle.read(header, 0, header.length, 0)
    const mimeType = imageType(header.subarray(0, prefix.bytesRead))
    if (mimeType ? images === false : info.size > textLimit || header.toString('ascii', 0, 5) === '%PDF-') return file
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw new Error('File changed during selection')
      offset += bytesRead
    }
    const after = await handle.stat()
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('File changed during selection')
    if (mimeType) file.payload = { type: 'image', mimeType, data: bytes.toString('base64') }
    else {
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return file }
      if (!/[\u0000-\u0008\u000e-\u001f\u007f]/.test(text)) file.payload = { type: 'text', text }
    }
    return file
  } finally { await handle.close() }
}

export async function saveClipboardImages(directory: string, images: ArrayBuffer[], remaining: number, inline?: boolean) {
  const files: FileAttachment[] = []
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    for (const image of images) {
      const bytes = Buffer.from(image)
      const mimeType = imageType(bytes)
      if (!mimeType) throw new Error('Unsupported clipboard image')
      const id = randomUUID()
      const name = `clipboard-${id.slice(0, 8)}.${mimeType.split('/')[1]}`
      const path = join(directory, `clipboard-${id}.${mimeType.split('/')[1]}`)
      const file: FileAttachment = { kind: 'file', id, path, name, size: bytes.length, clipboard: true }
      const handle = await open(path, 'wx', 0o600)
      files.push(file)
      try { await handle.writeFile(bytes) } finally { await handle.close() }
      if (inline !== false && bytes.length <= remaining) {
        file.payload = { type: 'image', mimeType, data: bytes.toString('base64') }
        remaining -= bytes.length
      }
    }
    return files
  } catch (error) {
    await Promise.all(files.map(discardClipboardImage))
    throw error
  }
}

export async function discardClipboardImage(file: FileAttachment) {
  if (file.clipboard) await rm(file.path, { force: true })
}

export function fileMode(file: FileAttachment, images?: boolean) {
  if (file.payload?.type === 'text') return 'fileText'
  if (file.payload?.type === 'image' && images !== false) return images ? 'fileImage' : 'filePendingImage'
  return 'fileLink'
}

export async function fileBlock(file: FileAttachment, images: boolean): Promise<ContentBlock> {
  if (file.payload?.type === 'text') return { type: 'text', text: `Attached file ${JSON.stringify(file.name)}:\n${file.payload.text}\n\n` }
  if (images && file.payload?.type === 'image') return file.payload
  const info = await stat(file.path)
  if (!info.isFile()) throw new Error('Expected a regular file')
  return { type: 'resource_link', name: file.name, uri: pathToFileURL(file.path).href, size: info.size }
}
