import { uiStrings as s } from './strings'
import type { ViewAction, ViewState } from './view-model'

const commands = [
  { name: 'new', label: 'newSession', action: 'new' },
  { name: 'clear', label: 'clear', action: 'clear' },
  { name: 'model', label: 'sessionModel', option: 'model' },
  { name: 'reasoning', label: 'sessionReasoning', option: 'reasoning_effort' },
  { name: 'settings', label: 'settings', action: 'settings' },
  { name: 'diagnostics', label: 'diagnostics', action: 'diagnostics' },
] as const

type Command = typeof commands[number]
type CommandState = Pick<ViewState, 'connection' | 'options' | 'sessionId'>
type Choice = { text: string; label: string }
type Match = { choices: Choice[]; action?: ViewAction; hint?: string }

function available(command: Command, state: CommandState) {
  if ('option' in command) return state.connection === 'connected' && state.options.some(o => o.id === command.option && o.type === 'select')
  return command.name !== 'clear' || !!state.sessionId
}

/** Only a single-line command in the first column belongs to the command menu. */
export function matchSlash(text: string, state: CommandState): Match | undefined {
  if (/[\r\n]/.test(text)) return
  const parts = /^\/([a-z\d_-]*)(?:[ \t]+(.*))?$/i.exec(text)
  if (!parts) return
  const [, token, argument] = parts
  const name = token.toLowerCase()
  const command = commands.find(item => item.name === name)
  const choices = commands.filter(item => available(item, state) && item.name.startsWith(name))
    .map(item => ({ text: '/' + item.name + ('option' in item ? ' ' : ''), label: s[item.label] }))
  if (!command) return { choices: argument === undefined ? choices : [], hint: s.slashUnknown }
  if (!available(command, state)) return { choices: [], hint: s.slashUnavailable }
  if ('action' in command) {
    if (argument?.trim()) return { choices: [], hint: s.slashNoArgument }
    return { choices, action: { type: command.action } }
  }
  if (argument === undefined) return { choices, hint: s.slashArgument }
  const option = state.options.find(o => o.id === command.option)
  if (option?.type !== 'select') return { choices: [], hint: s.slashUnavailable }
  const values = option.options.flatMap(item => 'group' in item
    ? item.options.map(entry => ({ ...entry, label: item.name + ' · ' + entry.name }))
    : [{ ...item, label: item.name }])
  const query = argument.trim().toLowerCase()
  const named = values.filter(item => item.name.toLowerCase() === query)
  const value = values.find(item => item.value === argument.trim()) ?? (named.length === 1 ? named[0] : undefined)
  return {
    choices: values.filter(item => (item.value + ' ' + item.label).toLowerCase().includes(query))
      .map(item => ({ text: '/' + name + ' ' + item.value, label: item.label })),
    action: value ? { type: 'configure', id: command.option, value: value.value } : undefined,
    hint: s.slashArgument,
  }
}
