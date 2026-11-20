import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type Entry =
  | { kind: 'user' | 'assistant' | 'thought' | 'notice'; id: string; text: string }
  | { kind: 'tool'; id: string; title: string; status: string; input?: string; output?: string }

export type Transcript = { version: 1; entries: Entry[]; inProgress: boolean }

function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'string') return false
  if (!('kind' in value)) return false
  if (value.kind === 'tool') {
    return 'title' in value && typeof value.title === 'string' && 'status' in value && typeof value.status === 'string'
      && (!('input' in value) || typeof value.input === 'string') && (!('output' in value) || typeof value.output === 'string')
  }
  return (value.kind === 'user' || value.kind === 'assistant' || value.kind === 'thought' || value.kind === 'notice')
    && 'text' in value && typeof value.text === 'string'
}

export class History {
  private pending = Promise.resolve()
  private readonly queued = new Map<string, { content: string; done: Promise<void> }>()

  constructor(private readonly root: string) {}

  private path(cwd: string, id: string) {
    const key = createHash('sha256').update(JSON.stringify([cwd, id])).digest('hex')
    return join(this.root, `${key}.json`)
  }

  async load(cwd: string, id: string): Promise<Transcript | undefined> {
    await this.pending
    let content: string
    try {
      content = await readFile(this.path(cwd, id), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const value: unknown = JSON.parse(content)
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
      || !('entries' in value) || !Array.isArray(value.entries) || !value.entries.every(isEntry)
      || !('inProgress' in value) || typeof value.inProgress !== 'boolean') {
      throw new Error('Invalid transcript file')
    }
    const seen = new Set<string>()
    const entries = value.entries.map((entry, index) => {
      const key = `${entry.kind}:${entry.id}`
      const duplicate = seen.has(key)
      seen.add(key)
      if (!duplicate || (entry.kind !== 'assistant' && entry.kind !== 'thought')) return entry
      const id = createHash('sha256').update(JSON.stringify([cwd, entry.id, index])).digest('hex')
      return { ...entry, id: `legacy:${id}` }
    })
    return { version: 1, entries, inProgress: value.inProgress }
  }

  save(cwd: string, id: string, value: Transcript) {
    const path = this.path(cwd, id)
    const content = JSON.stringify(value)
    const queued = this.queued.get(path)
    if (queued) {
      queued.content = content
      return queued.done
    }
    const snapshot = {
      content,
      done: this.enqueue(async () => {
        if (this.queued.get(path) === snapshot) this.queued.delete(path)
        await mkdir(this.root, { recursive: true })
        const temp = `${path}.${randomUUID()}.tmp`
        try {
          await writeFile(temp, snapshot.content, { mode: 0o600 })
          await rename(temp, path)
        } finally {
          await rm(temp, { force: true })
        }
      }),
    }
    this.queued.set(path, snapshot)
    return snapshot.done
  }

  clear(cwd: string, id: string) {
    const path = this.path(cwd, id)
    this.queued.delete(path)
    return this.enqueue(() => rm(path, { force: true }))
  }

  flush() { return this.pending }

  private enqueue(write: () => Promise<void>) {
    const operation = this.pending.then(write)
    this.pending = operation.catch(() => {})
    return operation
  }
}
