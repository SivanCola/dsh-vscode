import MarkdownIt from 'markdown-it'
import { draftKey, maxPasteBytes, maxPasteImages, type ViewAction, type ViewEvent, type ViewState } from './view-model'
import type { Entry } from './history'
import { uiStrings as s, useLocale } from './strings'
import { settingsPage } from './settings-page'
import { matchSlash } from './slash-commands'
import { selectionToolbar } from './selection-toolbar'

declare function acquireVsCodeApi(): {
  postMessage(message: ViewAction): void
  getState(): { drafts?: Record<string, string> } | undefined
  setState(state: { drafts: Record<string, string> }): void
}

const vscode = acquireVsCodeApi()
const renderSettings = settingsPage(action => vscode.postMessage(action))
const markdown = new MarkdownIt({ html: false, linkify: false })
markdown.disable(['image', 'link', 'autolink'])
const get = (id: string) => document.getElementById(id)!
const chat = get('chat')
const input = document.querySelector('textarea')!
const pasteStatus = get('pasteStatus')
let pendingPaste: string | undefined
const slashMenu = get('slashMenu')
const slashHint = get('slashHint')
let slashIndex = 0
let slashDismissed = false
const drafts = vscode.getState()?.drafts ?? {}
const openDetails = new Set<string>()
let state: ViewState | undefined
let key = draftKey()
let sent: { id: string; text: string; draft: string } | undefined
let draftRevision = 0
let sentRevision = 0
let lastEntries = ''
let lastFocus: string | undefined
const refreshSelection = selectionToolbar(chat, () => state?.settings ? undefined : state?.sessionId, action => vscode.postMessage(action))

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, css?: string) {
  const node = document.createElement(tag)
  if (text) node.textContent = text
  if (css) node.className = css
  return node
}

function button(text: string, action: ViewAction, options: { primary?: boolean; disabled?: boolean } = {}) {
  const node = el('button', text, options.primary ? 'primary' : '')
  node.type = 'button'
  node.disabled = options.disabled ?? false
  node.onclick = () => vscode.postMessage(action)
  return node
}

function details(id: string, title: string, content: HTMLElement) {
  const node = el('details')
  node.open = openDetails.has(id)
  node.addEventListener('toggle', () => node.open ? openDetails.add(id) : openDetails.delete(id))
  node.append(el('summary', title), content)
  return node
}

function renderEntry(entry: Entry, index: number) {
  const row = el('article', undefined, `entry ${entry.kind}`)
  if (entry.kind === 'tool') {
    const content = el('div', undefined, 'toolBody')
    if (entry.input) content.append(el('b', s.input), el('pre', entry.input))
    if (entry.output) content.append(el('b', s.output), el('pre', entry.output))
    const status = entry.status in s ? s[entry.status as keyof typeof s] : entry.status
    row.append(details(`tool:${entry.id}`, `${entry.title} · ${status}`, content))
    row.dataset.callId = entry.id
    return row
  }
  if (entry.kind === 'notice') {
    row.textContent = entry.text
    return row
  }
  const content = el('div', undefined, 'message')
  if (entry.kind === 'assistant' || entry.kind === 'user') content.dataset.quoteEntry = entry.id
  if (entry.kind === 'user') content.textContent = entry.text
  else content.innerHTML = markdown.render(entry.text)
  if (entry.kind === 'thought') row.append(details(`${entry.id}:${index}`, s.thought, content))
  else row.append(el('div', entry.kind === 'user' ? s.user : s.assistant, 'author'), content)
  return row
}

function renderChat(current: ViewState) {
  const next = JSON.stringify([current.cwd, current.sessionId, current.entries, current.approvals, current.stopping])
  if (lastEntries === next) return
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 36
  lastEntries = next
  const rows = current.entries.map(renderEntry)
  for (const approval of current.approvals) {
    const card = el('div', undefined, 'approval')
    card.append(el('strong', s.permission))
    const actions = el('div', undefined, 'row')
    for (const option of approval.options) {
      const label = option.kind === 'allow_once' ? s.allow_once : option.kind === 'reject_once' ? s.reject_once : option.name
      actions.append(button(label, { type: 'permission', id: approval.id, optionId: option.optionId }, { disabled: current.stopping }))
    }
    card.append(actions)
    const tool = rows.find(row => row.dataset.callId === approval.callId)
    if (tool) tool.append(card)
    else {
      card.append(el('small', approval.callId))
      rows.push(card)
    }
  }
  chat.replaceChildren(...rows)
  if (atBottom || current.approvals.length) chat.scrollTop = chat.scrollHeight
}

function render(current: ViewState) {
  if (state?.locale !== current.locale) {
    useLocale(current.locale)
    document.documentElement.lang = current.locale
    document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(node => {
      node.textContent = s[node.dataset.i18n as keyof typeof s]
    })
    input.placeholder = s.prompt
    input.setAttribute('aria-label', s.prompt)
    chat.setAttribute('aria-label', s.session)
    get('settingsPage').setAttribute('aria-label', s.settings)
    lastEntries = ''
  }
  const navigating = Boolean(state?.settings) !== Boolean(current.settings)
  const openingFirstSession = !state?.sessionId && !!current.sessionId && current.busy && sent?.draft === key
  state = current
  renderSettings(current.settings, current.approvals.length, current.language, current.enterToSend)
  if (navigating) vscode.postMessage({ type: 'focus', focused: !current.settings && document.hasFocus() })
  const nextKey = draftKey(current.cwd, current.sessionId)
  if (key !== nextKey) {
    if (openingFirstSession && sent && drafts[nextKey] === undefined) {
      drafts[nextKey] = input.value
      delete drafts[key]
      sent.draft = nextKey
      vscode.setState({ drafts })
    } else {
      input.value = drafts[nextKey] ?? ''
      draftRevision++
    }
    key = nextKey
    resetSlash()
    chat.scrollTop = chat.scrollHeight
  }
  const project = get('project')
  project.replaceChildren(el('strong', current.workspace ?? 'DeepSeek Harness'), el('span', s[current.connection], 'status'))
  const sessions = get('sessions')
  const selector = el('select')
  selector.setAttribute('aria-label', s.session)
  selector.append(new Option(s.restore, ''))
  for (const session of current.sessions) selector.append(new Option(session.title || s.unnamed, session.id))
  if (current.sessionId && !current.sessions.some(row => row.id === current.sessionId)) {
    selector.append(new Option(s.unnamed, current.sessionId))
  }
  selector.value = current.sessionId ?? ''
  selector.disabled = current.busy || !current.sessions.length
  selector.onchange = () => {
    if (selector.value) vscode.postMessage({ type: 'resume', id: selector.value })
  }
  sessions.replaceChildren(selector,
    button(current.sessionId ? s.newSession : s.noSession, { type: 'new' }, { disabled: current.busy }),
    button(s.refresh, { type: 'refresh' }, { disabled: current.busy }),
  )
  if (current.hasMore) sessions.append(button(s.more, { type: 'more' }, { disabled: current.busy }))
  if (current.sessionId && current.entries.length) sessions.append(button(s.clear, { type: 'clear' }, { disabled: current.busy }))

  renderChat(current)
  const feedback = get('feedback')
  const status = current.error ?? (current.stopping ? s.stopping : current.running ? s.running : current.connection === 'connecting' ? s.connecting : '')
  feedback.replaceChildren(el('div', status, current.error ? 'error' : ''))
  if (current.missingExecutable) feedback.append(button(s.browse, { type: 'browse' }, { disabled: current.busy }))
  if (current.connection === 'disconnected') feedback.append(button(s.reconnect, { type: 'reconnect' }, { disabled: current.busy }))
  if (current.error) feedback.append(button(s.diagnostics, { type: 'diagnostics' }))
  if (current.error && current.authenticationError) feedback.append(
    button(s.openConfig, { type: 'openConfig' }),
    button(s.restartNew, { type: 'restartNew' }, { disabled: current.busy }),
  )

  get('attachments').replaceChildren(...current.attachments.map(item => {
    const chip = el('div', undefined, 'chip')
    const label = item.label
    if (item.file) {
      const preview = button(label, { type: 'previewFile', id: item.id })
      preview.className = 'file-name'
      preview.title = `${s.previewFile} · ${item.file.path}`
      const size = item.file.size < 1024 ? `${item.file.size} B` : item.file.size < 1024 * 1024
        ? `${Math.ceil(item.file.size / 1024)} KiB` : `${(item.file.size / (1024 * 1024)).toFixed(1)} MiB`
      chip.append(preview, el('small', `${size} · ${s[item.file.mode]}`))
    } else {
      chip.append(el('span', label))
      chip.title = label
    }
    const remove = button('×', { type: 'remove', id: item.id }, { disabled: current.busy })
    remove.setAttribute('aria-label', `${s.remove} · ${label}`)
    chip.append(remove)
    return chip
  }))
  const options = get('options')
  options.replaceChildren()
  for (const option of current.options) {
    if (option.type !== 'select') continue
    const name = option.id === 'model' ? s.sessionModel : option.id === 'reasoning_effort' ? s.sessionReasoning : option.name
    const label = el('label', name)
    const select = el('select')
    select.setAttribute('aria-label', name)
    for (const item of option.options) {
      if ('group' in item) {
        const group = el('optgroup')
        group.label = item.name
        for (const value of item.options) group.append(new Option(value.name, value.value))
        select.append(group)
      } else select.append(new Option(item.name, item.value))
    }
    select.value = option.currentValue
    select.disabled = current.busy
    select.onchange = () => vscode.postMessage({ type: 'configure', id: option.id, value: select.value })
    label.append(select)
    options.append(label)
  }
  renderSlash()
  renderSend()
  refreshSelection()
  if (current.composerFocus && current.composerFocus !== lastFocus && !current.settings) {
    lastFocus = current.composerFocus
    input.focus()
    vscode.postMessage({ type: 'focusReceived', id: current.composerFocus })
  }
}

function resetSlash() {
  slashIndex = 0
  slashDismissed = false
  slashHint.textContent = ''
}

function renderSlash() {
  const match = state && !state.settings && !state.busy && document.activeElement === input && !slashDismissed
    ? matchSlash(input.value, state) : undefined
  const choices = match?.choices ?? []
  slashIndex = Math.min(slashIndex, Math.max(0, choices.length - 1))
  slashMenu.hidden = !choices.length
  slashMenu.setAttribute('aria-label', s.slashCommands)
  slashMenu.replaceChildren(...choices.map((choice, index) => {
    const row = el('div', choice.text.trimEnd() + ' · ' + choice.label)
    row.id = 'slash-option-' + index
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(index === slashIndex))
    row.onmousedown = e => e.preventDefault()
    row.onclick = () => completeSlash(choice.text)
    return row
  }))
  if (choices.length) input.setAttribute('aria-activedescendant', 'slash-option-' + slashIndex)
  else input.removeAttribute('aria-activedescendant')
}

function completeSlash(text: string) {
  input.value = text
  input.focus()
  input.setSelectionRange(text.length, text.length)
  input.dispatchEvent(new Event('input'))
  if (!text.endsWith(' ')) {
    slashDismissed = true
    renderSlash()
  }
}

function renderSend() {
  const actions = get('actions')
  const attach = button(s.attachFiles, { type: 'attachFiles' }, { disabled: !state || state.busy })
  attach.className = 'attach-files'
  if (state?.running) {
    actions.replaceChildren(attach, button(state.stopping ? s.stopping : s.stop, { type: 'stop' }, { disabled: state.stopping }))
  } else {
    const send = el('button', s.send, 'primary')
    send.type = 'submit'
    send.disabled = !state || state.busy || !!pendingPaste || (!input.value.trim() && !state.attachments.length)
    actions.replaceChildren(attach, send)
  }
}

input.addEventListener('paste', async event => {
  const data = event.clipboardData
  if (!data) return
  const files = Array.from(data.files).filter(file => file.type.startsWith('image/'))
  if (!files.length) return
  event.preventDefault()
  if (!state || state.busy || pendingPaste) { pasteStatus.textContent = s.pasteBusy; return }
  if (files.length > maxPasteImages || files.reduce((sum, file) => sum + file.size, 0) > maxPasteBytes) {
    pasteStatus.textContent = s.pasteLimit
    return
  }
  const draft = key
  const id = pendingPaste = crypto.randomUUID()
  pasteStatus.textContent = s.pastingImage
  renderSend()
  try {
    const images = await Promise.all(files.map(file => file.arrayBuffer()))
    if (images.some(image => !image.byteLength)) throw new Error('Empty clipboard image')
    vscode.postMessage({ type: 'pasteImages', id, draft, images })
  } catch {
    pendingPaste = undefined
    pasteStatus.textContent = s.pasteFailed
    renderSend()
  }
})

input.addEventListener('input', () => {
  if (!pendingPaste) pasteStatus.textContent = ''
  resetSlash()
  drafts[key] = input.value
  draftRevision++
  vscode.setState({ drafts })
  renderSlash()
  renderSend()
})
input.addEventListener('focus', renderSlash)
input.addEventListener('blur', () => { slashMenu.hidden = true; input.removeAttribute('aria-activedescendant') })
let composing = false
input.addEventListener('compositionstart', () => { composing = true })
input.addEventListener('compositionend', () => { composing = false })
input.addEventListener('keydown', event => {
  if (event.defaultPrevented) return
  if (composing || event.isComposing || event.keyCode === 229) {
    // Keep candidate confirmation with the IME, including legacy Chromium composition events.
    event.stopPropagation()
    return
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (!slashMenu.hidden && !event.shiftKey && state) {
    const match = matchSlash(input.value, state)
    const choice = match?.choices[slashIndex]
    if (match && choice && ['ArrowDown', 'ArrowUp', 'Escape', 'Tab', 'Enter'].includes(event.key)) {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        slashDismissed = true
        renderSlash()
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const count = match.choices.length
        slashIndex = (slashIndex + (event.key === 'ArrowDown' ? 1 : -1) + count) % count
        renderSlash()
        slashMenu.children[slashIndex]?.scrollIntoView({ block: 'nearest' })
      } else if (!event.repeat) {
        if (event.key === 'Enter' && state.enterToSend && match.action && choice.text === input.value) input.form?.requestSubmit()
        else completeSlash(choice.text)
      }
      return
    }
  }
  if (event.key !== 'Enter') return
  if (event.shiftKey || !state?.enterToSend) return
  event.preventDefault()
  event.stopPropagation()
  if (!event.repeat) input.form?.requestSubmit()
})
input.form?.addEventListener('submit', event => {
  event.preventDefault()
  if (!state || state.busy || sent || pendingPaste || (!input.value.trim() && !state.attachments.length)) return
  const command = matchSlash(input.value, state)
  if (command) {
    if (command.action) {
      vscode.postMessage(command.action)
      completeSlash('')
    } else {
      input.focus()
      slashHint.textContent = command.hint ?? ''
    }
    return
  }
  sent = { id: crypto.randomUUID(), text: input.value, draft: key }
  sentRevision = draftRevision
  vscode.postMessage({ type: 'send', id: sent.id, text: sent.text })
})
window.addEventListener('message', ({ data }: MessageEvent<ViewEvent>) => {
  if (data.type === 'pasteFinished' && data.id === pendingPaste) {
    pendingPaste = undefined
    pasteStatus.textContent = data.error ?? ''
    renderSend()
  }
  if (data.type === 'submit' && !state?.settings && !composing) input.form?.requestSubmit()
  if (data.type === 'accepted' && sent?.id === data.id) {
    const draft = sent.draft
    if (drafts[draft] === sent.text && (key !== draft || sentRevision === draftRevision)) {
      delete drafts[draft]
      vscode.setState({ drafts })
      if (key === draft) input.value = ''
    }
    sent = undefined
  }
  if (data.type === 'state' && (!state || data.state.revision > state.revision)) {
    if (!data.state.busy) sent = undefined
    render(data.state)
  }
})
vscode.postMessage({ type: 'ready' })
const syncFocus = () => vscode.postMessage({ type: 'focus', focused: document.hasFocus() })
window.addEventListener('focus', syncFocus)
window.addEventListener('blur', syncFocus)
syncFocus()
