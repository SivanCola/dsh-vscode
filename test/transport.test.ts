import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { dshHome, findExecutable, startAcp } from '../src/acp'
import { History, type Transcript } from '../src/history'
import { draftKey, readAction, setDraft, switchDraft } from '../src/view-model'
import { resolveLocale } from '../src/strings'

test('follows the editor language unless the user chooses an explicit locale', () => {
  assert.equal(resolveLocale('auto', 'zh-cn'), 'zh-CN')
  assert.equal(resolveLocale('auto', 'en-US'), 'en')
  assert.equal(resolveLocale('zh-CN', 'en'), 'zh-CN')
  assert.equal(resolveLocale('en', 'zh-cn'), 'en')
  assert.equal(readAction({ type: 'language', value: 'invalid' }), undefined)
})

async function temporary() { return mkdtemp(join(tmpdir(), 'dsh-vscode-test-')) }
const callbacks = {
  update: () => {},
  permission: async () => ({ outcome: { outcome: 'cancelled' } } as const),
  disconnected: () => {},
}

test('routes tool permission, updates, cancellation and an unexpected process exit', async () => {
  const cwd = await temporary()
  const updates: SessionUpdate[] = []
  let action: ((update: SessionUpdate) => void) | undefined
  let exitCount = 0
  const connection = startAcp(process.execPath, cwd, {
    update: ({ update }) => { updates.push(update); action?.(update) },
    permission: async params => ({ outcome: { outcome: 'selected', optionId: params.options[1].optionId } }),
    disconnected: () => { exitCount++ },
  }, { args: [resolve('test/fixture.mjs')] })
  try {
    assert.ok((await connection.initialize()).sessionCapabilities?.resume)
    const { sessionId } = await connection.create(cwd)
    assert.equal((await connection.configure(sessionId, 'model', 'beta')).configOptions[0].type, 'select')
    assert.equal((await connection.prompt(sessionId, ['request permission'])).stopReason, 'end_turn')
    assert.ok(updates.some(update => update.sessionUpdate === 'tool_call_update' && update.rawOutput === 'reject-once'))
    const wait = new Promise<void>(resolve => { action = () => resolve() })
    const prompt = connection.prompt(sessionId, ['wait for cancellation'])
    await wait
    await connection.cancel(sessionId)
    assert.equal((await prompt).stopReason, 'cancelled')
    await assert.rejects(connection.prompt(sessionId, ['exit fixture']))
    assert.equal(exitCount, 1)
  } finally {
    await connection.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})

test('installed dsh supports ACP v1 session recovery across processes', { skip: !process.env.DSH_TEST_REAL }, async () => {
  const cwd = await temporary()
  const executable = await findExecutable('')
  const env = { ...process.env, DSH_HOME: join(cwd, '.dsh'), DSH_TELEMETRY_DISABLED: '1' }
  const first = startAcp(executable, cwd, callbacks, { env })
  let second: ReturnType<typeof startAcp> | undefined
  try {
    assert.ok((await first.initialize()).sessionCapabilities?.resume)
    const { sessionId, configOptions } = await first.create(cwd)
    assert.ok(configOptions?.some(option => option.id === 'model'))
    await first.close(sessionId)
    await first.dispose()
    second = startAcp(executable, cwd, callbacks, { env })
    await second.initialize()
    assert.ok((await second.list(cwd)).sessions.some(session => session.sessionId === sessionId))
    await second.resume(cwd, sessionId)
    if (process.env.DSH_TEST_MODEL) {
      const result = await second.prompt(sessionId, ['Reply with the single word READY.'])
      assert.equal(result.stopReason, 'end_turn')
    }
    await second.close(sessionId)
  } finally {
    await Promise.all([first.dispose(), second?.dispose()])
    await rm(cwd, { recursive: true, force: true })
  }
})

test('persists versioned workspace history without intermediate or duplicate entries', async () => {
  const cwd = await temporary()
  const histories = new History(cwd)
  const record: Transcript = { version: 1, inProgress: true, entries: [{ kind: 'user', id: 'u1', text: 'first' }] }
  try {
    const first = histories.save('/workspace', 'session', record)
    record.entries.push({ kind: 'assistant', id: 'a1', text: 'reply' })
    const second = histories.save('/workspace', 'session', { ...record, inProgress: false })
    await Promise.all([first, second])
    assert.deepEqual(await histories.load('/workspace', 'session'), { ...record, inProgress: false })
    assert.equal(await histories.load('/other', 'session'), undefined)
    await histories.clear('/workspace', 'session')
    assert.equal(await histories.load('/workspace', 'session'), undefined)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('coalesces pending history writes without coalescing across a clear', async t => {
  const cwd = await temporary()
  t.after(() => rm(cwd, { recursive: true, force: true }))
  const history = new History(cwd)
  const entries: Transcript['entries'] = []
  const first = history.save(cwd, 'session', { version: 1, entries, inProgress: true })
  for (let index = 0; index < 20; index++) {
    entries.push({ kind: 'assistant', id: 'assistant:current', text: String(index) })
    assert.equal(history.save(cwd, 'session', { version: 1, entries, inProgress: false }), first)
  }
  const loaded = await history.load(cwd, 'session')
  assert.deepEqual(loaded?.entries.map(entry => 'text' in entry && entry.text), entries.map((_, i) => String(i)))
  assert.equal(new Set(loaded?.entries.map(entry => entry.id)).size, entries.length)
  assert.deepEqual(await history.load(cwd, 'session'), loaded)
  const pending = history.save(cwd, 'session', { version: 1, entries, inProgress: true })
  const cleared = history.clear(cwd, 'session')
  const after = history.save(cwd, 'session', { version: 1, entries: [], inProgress: false })
  assert.notEqual(pending, after)
  await Promise.all([pending, cleared, after])
  assert.deepEqual(await history.load(cwd, 'session'), { version: 1, entries: [], inProgress: false })
})

test('normalizes padded home shorthand consistently with existing literal paths', async t => {
  const cwd = await temporary()
  t.after(() => rm(cwd, { recursive: true, force: true }))
  assert.equal(dshHome(cwd, '  ~/test-acp  '), join(homedir(), 'test-acp'))
  assert.equal(dshHome(cwd, '  ~  '), homedir())
  assert.equal(dshHome(cwd, 'literal path '), join(cwd, 'literal path '))
})

test('rejects malformed webview requests', () => {
  assert.deepEqual(readAction({ type: 'send', id: 'a', text: 'hi' }), { type: 'send', id: 'a', text: 'hi' })
  assert.equal(readAction({ type: 'send', id: 'a', text: {} }), undefined)
  assert.equal(readAction({ type: 'permission', id: 'a', optionId: false }), undefined)
})

test('preserves carried drafts even when the destination draft was previously cleared to empty', () => {
  const session = draftKey('/workspace', 'old-session')
  const workspace = draftKey('/workspace')
  const drafts: Record<string, string> = { [session]: 'Keep this draft', [workspace]: '' }
  assert.deepEqual(switchDraft(drafts, session, workspace, 'Keep this draft', true), { text: 'Keep this draft', carried: true })
  assert.deepEqual(drafts, { [workspace]: 'Keep this draft' })

  setDraft(drafts, workspace, '')
  assert.deepEqual(drafts, {})

  const existing: Record<string, string> = { [session]: 'Session draft', [workspace]: 'Existing workspace draft' }
  assert.deepEqual(switchDraft(existing, session, workspace, 'Session draft', true), { text: 'Existing workspace draft', carried: false })
  assert.deepEqual(existing, { [session]: 'Session draft', [workspace]: 'Existing workspace draft' })

  assert.deepEqual(switchDraft(existing, workspace, session, 'Existing workspace draft', false), { text: 'Session draft', carried: false })
})
