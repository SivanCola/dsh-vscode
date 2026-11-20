import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { discardClipboardImage, draftFileBudget, fileBlock, fileMode, pickFile, pruneClipboardImages, saveClipboardImages } from '../src/file-attachment'
import { readAction } from '../src/view-model'

test('clipboard images can be linked, removed, and rolled back after a bad batch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-paste-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const png = Uint8Array.from(Buffer.from('89504e470d0a1a0a', 'hex')).buffer
  const action = { type: 'pasteImages', id: '1', draft: 'draft', images: [png] }
  assert.deepEqual(readAction(action), action)
  assert.equal(readAction({ ...action, images: [runInNewContext('new ArrayBuffer(8)')] })?.type, 'pasteImages')
  assert.equal(readAction({ ...action, images: ['not bytes'] }), undefined)
  const [file] = await saveClipboardImages(dir, [png], draftFileBudget, false)
  assert.deepEqual(await readFile(file.path), Buffer.from(png))
  assert.equal((await fileBlock(file, false)).type, 'resource_link')
  await discardClipboardImage(file)
  await assert.rejects(saveClipboardImages(dir, [png, new ArrayBuffer(8)], draftFileBudget))
  assert.deepEqual(await readdir(dir), [])
})

test('expires old clipboard files while keeping recent links and unrelated files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-paste-retention-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const png = Uint8Array.from(Buffer.from('89504e470d0a1a0a', 'hex')).buffer
  const [expired, recent] = await saveClipboardImages(dir, [png, png], draftFileBudget, false)
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
  await Promise.all([utimes(expired.path, old, old), utimes(recent.path, old, old), writeFile(join(dir, 'keep.png'), '')])
  await fileBlock(recent, false)
  await pruneClipboardImages(dir)
  assert.deepEqual((await readdir(dir)).sort(), [recent.path.slice(dir.length + 1), 'keep.png'].sort())
})

test('captures text at selection time and keeps large or binary files as resource links', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, '文件 #1.txt')
  await writeFile(path, '选中时的文本')
  const selected = await pickFile(path, draftFileBudget)
  await writeFile(path, 'later')
  assert.deepEqual(await fileBlock(selected, false), { type: 'text', text: 'Attached file "文件 #1.txt":\n选中时的文本\n\n' })
  for (const data of [Buffer.from([0xff, 0]), Buffer.from('%PDF-1.7'), Buffer.alloc(256 * 1024 + 1, 65)]) {
    await writeFile(path, data)
    const file = await pickFile(path, draftFileBudget)
    assert.equal(fileMode(file, true), 'fileLink')
    assert.deepEqual(await fileBlock(file, true), { type: 'resource_link', uri: pathToFileURL(path).href, name: file.name, size: data.length })
  }
  assert.equal(fileMode(await pickFile(path, 0)), 'fileLink')
  await assert.rejects(pickFile(dir, draftFileBudget))
})

test('uses actual image bytes and follows the capabilities of the sending connection', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-attach-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'picture')
  const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64')
  await writeFile(path, data)
  const file = await pickFile(path, draftFileBudget)
  assert.equal(fileMode(file), 'filePendingImage')
  assert.equal(fileMode(file, false), 'fileLink')
  assert.deepEqual(await fileBlock(file, true), { type: 'image', mimeType: 'image/png', data: data.toString('base64') })
  assert.equal((await fileBlock(file, false)).type, 'resource_link')
  assert.equal((await pickFile(path, draftFileBudget, false)).payload, undefined)
  await rm(path)
  await assert.rejects(fileBlock(file, false))
})
