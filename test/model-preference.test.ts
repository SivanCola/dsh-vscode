import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { applyDefaultModel, modelGroups } from '../src/model-preference'

const options: SessionConfigOption[] = [{
  id: 'model', name: 'Model', type: 'select', currentValue: 'a:1',
  options: [
    { group: 'a', name: 'A', options: [{ name: 'Chat', value: 'a:1' }] },
    { group: 'b', name: 'B', options: [{ name: 'Chat', value: 'opaque-B' }] },
  ],
}]
const saved = { group: 'b', providerName: 'B', modelName: 'Chat', value: 'opaque-B' }
test('uses the saved opaque value even when another provider uses the same display name', async () => {
  const applied = await applyDefaultModel(options, saved, async value => {
    assert.equal(value, 'opaque-B')
    return [{ ...options[0], currentValue: value } as SessionConfigOption]
  }, 'unavailable')
  assert.deepEqual(modelGroups(applied), modelGroups(options))
})
test('follow uses the returned profile options without a configuration request', async () => {
  assert.equal(await applyDefaultModel(options, undefined, async () => assert.fail(), 'unavailable'), options)
})
test('rejects removed choices and an unconfirmed change before sending', async () => {
  await assert.rejects(applyDefaultModel([], saved, async () => assert.fail(), 'unavailable'), /unavailable/)
  await assert.rejects(applyDefaultModel(options, saved, async () => options, 'unavailable'), /unavailable/)
})
