import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { Entry } from './history'
import type { ModelGroup, ModelPreference } from './model-preference'
import { isLanguage, type Locale, type Language } from './strings'
import type { FileAttachment, fileMode } from './file-attachment'

export type SettingsPage = {
  groups: ModelGroup[]; preference?: ModelPreference; executable: string; configured: boolean
  pending: boolean; feedback: string
}

export type Selection = (FileAttachment & { source: string }) | ({ id: string; text: string } & (
  { kind: 'editor'; file: string; lines: string; language: string }
  | { kind: 'quote'; entryId: string; role: 'user' | 'assistant' }
))
export type Approval = { id: string; callId: string; options: { optionId: string; name: string; kind: string }[] }
export type ViewState = {
  enterToSend: boolean
  language: Language
  locale: Locale
  settings?: SettingsPage
  revision: number
  cwd?: string
  workspace?: string
  sessionId?: string
  sessions: { id: string; title: string }[]
  hasMore: boolean
  connection: 'idle' | 'connecting' | 'connected' | 'disconnected'
  busy: boolean
  canList: boolean
  running: boolean
  stopping: boolean
  error?: string
  missingExecutable: boolean
  authenticationError?: boolean
  options: SessionConfigOption[]
  entries: Entry[]
  attachments: { id: string; label: string; file?: { size: number; mode: ReturnType<typeof fileMode>; path: string } }[]
  composerFocus?: string
  approvals: Approval[]
}

export type ViewAction =
  | { type: 'pasteImages'; id: string; draft: string; images: ArrayBuffer[] }
  | { type: 'quoted'; session: string; id: string; text: string; ask: boolean }
  | { type: 'focusReceived'; id: string }
  | { type: 'enterToSend'; value: boolean }
  | { type: 'language'; value: Language }
  | { type: 'back' | 'shortcuts' | 'settings' | 'attachFiles' }
  | { type: 'settingsBrowse' | 'settingsReset' | 'followAcp' }
  | { type: 'saveDefault'; group: string | null; value: string }
  | { type: 'focus'; focused: boolean }
  | { type: 'ready' | 'new' | 'more' | 'refresh' | 'stop' | 'reconnect' | 'browse' | 'clear' | 'diagnostics' | 'openConfig' | 'restartNew' }
  | { type: 'resume' | 'remove' | 'previewFile'; id: string }
  | { type: 'send'; id: string; text: string }
  | { type: 'permission'; id: string; optionId: string }
  | { type: 'configure'; id: string; value: string }

export function readAction(input: unknown): ViewAction | undefined {
  if (typeof input !== 'object' || input === null || !('type' in input)) return
  const id = 'id' in input && typeof input.id === 'string' && input.id.length < 500 ? input.id : undefined
  switch (input.type) {
    case 'pasteImages': {
      if (!id || !('draft' in input) || typeof input.draft !== 'string' || !('images' in input)
        || !Array.isArray(input.images) || !input.images.length || input.images.length > maxPasteImages) return
      let bytes = 0
      for (const image of input.images) {
        if (!(image instanceof ArrayBuffer) || !image.byteLength) return
        bytes += image.byteLength
      }
      return bytes <= maxPasteBytes ? { type: 'pasteImages', id, draft: input.draft, images: input.images } : undefined
    }
    case 'focusReceived': return id ? { type: 'focusReceived', id } : undefined
    case 'quoted':
      return id && 'session' in input && typeof input.session === 'string' && 'text' in input
        && typeof input.text === 'string' && input.text.trim() && 'ask' in input && typeof input.ask === 'boolean'
        ? { type: 'quoted', session: input.session, id, text: input.text, ask: input.ask } : undefined
    case 'enterToSend': return 'value' in input && typeof input.value === 'boolean' ? { type: 'enterToSend', value: input.value } : undefined
    case 'language': return 'value' in input && isLanguage(input.value) ? { type: 'language', value: input.value } : undefined
    case 'attachFiles': case 'back': case 'settings': case 'settingsBrowse': case 'settingsReset': case 'shortcuts': case 'followAcp':
      return { type: input.type }
    case 'saveDefault':
      return 'group' in input && (input.group === null || typeof input.group === 'string')
        && 'value' in input && typeof input.value === 'string'
        ? { type: 'saveDefault', group: input.group, value: input.value } : undefined
    case 'focus': return 'focused' in input && typeof input.focused === 'boolean' ? { type: 'focus', focused: input.focused } : undefined
    case 'ready': case 'new': case 'more': case 'refresh': case 'stop':
    case 'reconnect': case 'browse': case 'clear': case 'diagnostics':
    case 'openConfig': case 'restartNew':
      return { type: input.type }
    case 'resume': case 'remove': case 'previewFile':
      return id ? { type: input.type, id } : undefined
    case 'send':
      return id && 'text' in input && typeof input.text === 'string'
        ? { type: 'send', id, text: input.text } : undefined
    case 'permission':
      return id && 'optionId' in input && typeof input.optionId === 'string'
        ? { type: 'permission', id, optionId: input.optionId } : undefined
    case 'configure':
      return id && 'value' in input && typeof input.value === 'string'
        ? { type: 'configure', id, value: input.value } : undefined
  }
}

export type ViewEvent =
  | { type: 'pasteFinished'; id: string; error?: string }
  | { type: 'submit' }
  | { type: 'state'; state: ViewState }
  | { type: 'accepted'; id: string; sessionKey: string }

export function draftKey(cwd?: string, sessionId?: string) {
  return JSON.stringify([cwd ?? '', sessionId ?? ''])
}

export const maxPasteBytes = 8 * 1024 * 1024
export const maxPasteImages = 32
