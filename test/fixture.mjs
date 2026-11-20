import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

const database = '.acp-fixture-sessions.json'
const sessions = existsSync(database) ? JSON.parse(readFileSync(database, 'utf8')) : []
const configOptions = [{
  type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'alpha',
  options: [{ value: 'alpha', name: 'Alpha' }, { value: 'beta', name: 'Beta' }],
}]
const capabilities = { promptCapabilities: { image: true }, sessionCapabilities: { list: {}, resume: {}, close: {} } }
const output = fields => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...fields }) + '\n')
const update = (sessionId, fields) => output({ method: 'session/update', params: { sessionId, update: fields } })
const reply = (id, result) => output({ id, result })
let waiting
let permissionId = 100
let rejectClose = false

function streamThoughts(turn) {
  const stream = setInterval(() => {
    if (waiting !== turn) { clearInterval(stream); return }
    update(turn.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Chunk ' } })
  }, 100)
  stream.unref()
}

for await (const line of createInterface({ input: process.stdin })) {
  const { method, id, params, result } = JSON.parse(line)
  switch (method) {
    case 'initialize':
      reply(id, { protocolVersion: 1, agentCapabilities: capabilities })
      break
    case 'session/new': {
      const sessionId = randomUUID()
      sessions.unshift({ sessionId, cwd: params.cwd, title: `Test conversation ${sessions.length + 1}` })
      writeFileSync(database, JSON.stringify(sessions))
      reply(id, { sessionId, configOptions })
      break
    }
    case 'session/list':
      reply(id, { sessions: sessions.filter(row => row.cwd === params.cwd) })
      break
    case 'session/resume':
      if (sessions.some(row => row.sessionId === params.sessionId && row.cwd === params.cwd)) reply(id, { configOptions })
      else output({ id, error: { code: -32602, message: 'Invalid params: session is not resumable' } })
      break
    case 'session/close':
      if (rejectClose) {
        rejectClose = false
        output({ id, error: { code: -32603, message: 'Fixture close failed' } })
      } else reply(id, {})
      break
    case 'session/set_config_option':
      configOptions[0].currentValue = params.value
      reply(id, { configOptions })
      break
    case 'session/prompt': {
      const text = params.prompt.map(block => {
        if (block.type === 'image') return `image ${block.mimeType} ${Buffer.from(block.data, 'base64').length} bytes`
        if (block.type === 'resource_link') return `linked ${block.name} ${block.uri}`
        return block.text
      }).join('\n')
      if (text === 'exit fixture') process.exit(9)
      if (text === 'simulate auth failure') {
        rejectClose = true
        output({ id, error: { code: -32603, message: 'Model provider returned 401' } })
        break
      }
      const { sessionId } = params
      if (text === 'wait for cancellation' || text === 'ignore cancellation') {
        waiting = { id, sessionId, ignoreCancel: text === 'ignore cancellation' }
        update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Waiting for cancellation' } })
        streamThoughts(waiting)
      } else if (text === 'request permission') {
        const toolCallId = `tool-${permissionId}`
        waiting = { id, sessionId, toolCallId, permissionId }
        update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: 'Fixture tool', kind: 'other', status: 'in_progress', rawInput: { demo: true } })
        output({ id: permissionId++, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId }, options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ] } })
        streamThoughts(waiting)
      } else {
        const marker = text.includes('UNSAVED_HARNESS_MARKER') ? 'UNSAVED_HARNESS_MARKER' : text
        update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Received **${marker}**` } })
        reply(id, { stopReason: 'end_turn' })
      }
      break
    }
    case 'session/cancel':
      if (waiting && !waiting.ignoreCancel) {
        reply(waiting.id, { stopReason: 'cancelled' })
        waiting = undefined
      }
      break
    default:
      if (waiting && waiting.permissionId === id) {
        const { id: promptId, sessionId, toolCallId } = waiting
        waiting = undefined
        const decision = result?.outcome?.optionId ?? 'cancelled'
        update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: decision })
        reply(promptId, { stopReason: 'end_turn' })
      }
  }
}
