import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchSlash } from '../src/slash-commands'
import type { ViewState } from '../src/view-model'

const session: Pick<ViewState, 'connection' | 'sessionId' | 'options'> = {
  connection: 'connected', sessionId: 'active', options: [
    { type: 'select', id: 'model', name: 'Model', currentValue: 'a',
      options: [
        { group: 'one', name: 'One', options: [{ name: 'Flash', value: 'a' }] },
        { group: 'two', name: 'Two', options: [{ name: 'Flash', value: 'b' }] },
      ] },
    { type: 'select', id: 'reasoning_effort', name: 'Reasoning', currentValue: 'low',
      options: [{ name: 'High', value: 'high' }] },
  ],
}

test('keeps ordinary prompts, file paths and multiline text in the chat flow', () => {
  for (const text of ['explain /clear', '/src/main.ts', '/clear\nplease explain', ' /clear']) {
    assert.equal(matchSlash(text, session), undefined)
  }
})

test('intercepts unknown commands, invalid arguments and unavailable actions', () => {
  for (const text of ['/unknown', '/bad_command2', '/clear extra', '/reasoning medium']) {
    const match = matchSlash(text, session)
    assert.ok(match?.hint)
    assert.equal(match.action, undefined)
  }
  assert.deepEqual(matchSlash('/clear', session)?.action, { type: 'clear' })
  assert.equal(matchSlash('/model a', { ...session, connection: 'disconnected' })?.action, undefined)
})

test('uses advertised IDs to distinguish duplicate model names and configure reasoning', () => {
  assert.equal(matchSlash('/model Flash', session)?.action, undefined)
  assert.deepEqual(matchSlash('/model Flash', session)?.choices.map(c => c.text), ['/model a', '/model b'])
  assert.deepEqual(matchSlash('/model b', session)?.action, { type: 'configure', id: 'model', value: 'b' })
  assert.deepEqual(matchSlash('/reasoning High', session)?.action, { type: 'configure', id: 'reasoning_effort', value: 'high' })
})
