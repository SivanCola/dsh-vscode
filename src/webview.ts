import MarkdownIt from 'markdown-it'
import { draftKey, maxPasteBytes, maxPasteImages, setDraft, switchDraft, type Approval, type ViewAction, type ViewEvent, type ViewState } from './view-model'
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
let pasteTimer: ReturnType<typeof setTimeout> | undefined
const slashMenu = get('slashMenu')
const slashHint = get('slashHint')
let slashIndex = 0
let slashDismissed = false
const drafts = vscode.getState()?.drafts ?? {}
const entryRows = new Map<string, { row: HTMLElement; entry: Entry }>()
const approvalCards = new Map<string, { card: HTMLElement; options: string }>()
const sectionKeys = new Map<string, string>()
let state: ViewState | undefined
let key = draftKey()
let sent: { id: string; text: string; draft: string } | undefined
let draftRevision = 0
let sentRevision = 0
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

function details(content: HTMLElement) {
  const node = el('details')
  node.append(el('summary'), content)
  return node
}

function renderEntry(entry: Entry, localeChanged: boolean) {
  const id = `${entry.kind}:${entry.id}`
  const cached = entryRows.get(id)
  const previous = cached?.entry
  const row = cached?.row ?? el('article', undefined, `entry ${entry.kind}`)
  entryRows.set(id, { row, entry })
  if (entry.kind === 'tool') {
    if (!previous) {
      row.append(details(el('div', undefined, 'toolBody')))
      row.dataset.callId = entry.id
    }
    if (previous?.kind !== 'tool' || previous.title !== entry.title || previous.status !== entry.status || localeChanged) {
      const status = entry.status in s ? s[entry.status as keyof typeof s] : entry.status
      row.querySelector('summary')!.textContent = `${entry.title} · ${status}`
    }
    if (previous?.kind !== 'tool' || previous.input !== entry.input || previous.output !== entry.output || localeChanged) {
      const content = row.querySelector('.toolBody')!
      content.replaceChildren()
      if (entry.input) content.append(el('b', s.input), el('pre', entry.input))
      if (entry.output) content.append(el('b', s.output), el('pre', entry.output))
    }
    return row
  }
  if (entry.kind === 'notice') {
    if (previous?.kind !== entry.kind || previous.text !== entry.text) row.textContent = entry.text
    return row
  }
  if (!cached) {
    const content = el('div', undefined, 'message')
    if (entry.kind === 'thought') row.append(details(content))
    else {
      content.dataset.quoteEntry = entry.id
      row.append(el('div', undefined, 'author'), content)
    }
  }
  if (!cached || localeChanged) {
    if (entry.kind === 'thought') row.querySelector('summary')!.textContent = s.thought
    else row.querySelector('.author')!.textContent = entry.kind === 'user' ? s.user : s.assistant
  }
  if (previous?.kind !== entry.kind || previous.text !== entry.text) {
    const content = row.querySelector('.message')!
    if (entry.kind === 'user') content.textContent = entry.text
    else content.innerHTML = markdown.render(entry.text)
  }
  return row
}

function renderApproval(approval: Approval, stopping: boolean, localeChanged: boolean) {
  const options = JSON.stringify(approval.options)
  const previous = approvalCards.get(approval.id)
  const card = previous?.card ?? el('div', undefined, 'approval')
  if (previous?.options !== options || localeChanged) {
    const actions = el('div', undefined, 'row')
    for (const option of approval.options) {
      const label = option.kind === 'allow_once' ? s.allow_once : option.kind === 'reject_once' ? s.reject_once : option.name
      actions.append(button(label, { type: 'permission', id: approval.id, optionId: option.optionId }))
    }
    card.replaceChildren(el('strong', s.permission), actions, el('small', approval.callId))
    approvalCards.set(approval.id, { card, options })
  }
  card.querySelectorAll('button').forEach(control => { control.disabled = stopping })
  return card
}

function renderChat(current: ViewState, changedSession: boolean, localeChanged: boolean) {
  const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 36
  if (changedSession) {
    entryRows.clear()
    approvalCards.clear()
    chat.replaceChildren()
  }
  const entryIds = new Set(current.entries.map(entry => `${entry.kind}:${entry.id}`))
  for (const [id, { row }] of entryRows) {
    if (!entryIds.has(id)) { row.remove(); entryRows.delete(id) }
  }
  const approvalIds = new Set(current.approvals.map(approval => approval.id))
  for (const [id, { card }] of approvalCards) {
    if (!approvalIds.has(id)) { card.remove(); approvalCards.delete(id) }
  }
  const rows = current.entries.map(entry => renderEntry(entry, localeChanged))
  let newApproval: HTMLElement | undefined
  for (const approval of current.approvals) {
    const added = !approvalCards.has(approval.id)
    const card = renderApproval(approval, current.stopping, localeChanged)
    if (added) newApproval = card
    const tool = entryRows.get(`tool:${approval.callId}`)?.row
    const inline = tool && (added || card.parentNode === tool)
    card.querySelector('small')!.hidden = !!inline
    if (inline) { if (card.parentNode !== tool) tool.append(card) }
    else rows.push(card)
  }
  let child = chat.firstChild
  for (const row of rows) {
    if (row === child) child = child.nextSibling
    else chat.insertBefore(row, child)
  }
  if (changedSession || (atBottom && !document.activeElement?.closest('.approval'))) chat.scrollTop = chat.scrollHeight
  if (newApproval && !current.settings) newApproval.scrollIntoView({ block: 'nearest' })
}

function render(current: ViewState) {
  const previous = state
  const localeChanged = previous?.locale !== current.locale
  if (localeChanged) {
    useLocale(current.locale)
    document.documentElement.lang = current.locale
    document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(node => {
      node.textContent = s[node.dataset.i18n as keyof typeof s]
    })
    input.placeholder = s.prompt
    input.setAttribute('aria-label', s.prompt)
    chat.setAttribute('aria-label', s.session)
    get('settingsPage').setAttribute('aria-label', s.settings)
    sectionKeys.clear()
  }
  const navigating = Boolean(state?.settings) !== Boolean(current.settings)
  const openingFirstSession = !state?.sessionId && !!current.sessionId && current.busy && sent?.draft === key
  state = current
  renderSettings(current.settings, current.approvals.length, current.language, current.enterToSend)
  if (navigating) vscode.postMessage({ type: 'focus', focused: !current.settings && document.hasFocus() })
  const nextKey = draftKey(current.cwd, current.sessionId)
  const changedSession = key !== nextKey
  if (changedSession) {
    const unavailableSession = previous?.sessionId && !current.sessionId && previous.cwd === current.cwd
      && current.error === s.sessionUnavailable
    const next = switchDraft(drafts, key, nextKey, input.value, Boolean(openingFirstSession || unavailableSession))
    if (next.carried) {
      if (sent?.draft === key) sent.draft = nextKey
      vscode.setState({ drafts })
    } else {
      input.value = next.text
      draftRevision++
    }
    key = nextKey
    resetSlash()
  }
  renderSection('project', [current.workspace, current.connection], () => renderProject(current))
  renderSection('sessions', [current.sessionId, current.sessions, current.busy, current.hasMore, !!current.entries.length], () => renderSessions(current))
  renderChat(current, changedSession, localeChanged)
  renderSection('feedback', [current.error, current.stopping, current.running, current.connection, current.missingExecutable,
    current.authenticationError, current.busy], () => renderFeedback(current))
  renderSection('attachments', [current.attachments, current.busy], () => renderAttachments(current))
  renderSection('options', [current.options, current.busy], () => renderOptions(current))
  renderSlash()
  renderSend()
  refreshSelection()
  if (current.composerFocus && current.composerFocus !== lastFocus && !current.settings) {
    lastFocus = current.composerFocus
    input.focus()
    vscode.postMessage({ type: 'focusReceived', id: current.composerFocus })
  }
}

function renderSection(id: string, values: unknown[], update: () => void) {
  const key = JSON.stringify(values)
  if (sectionKeys.get(id) === key) return
  sectionKeys.set(id, key)
  update()
}

function renderProject(current: ViewState) {
  const project = get('project')
  project.replaceChildren(el('strong', current.workspace ?? 'dsh-vscode'), el('span', s[current.connection], 'status'))
}

function renderSessions(current: ViewState) {
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
}

function renderFeedback(current: ViewState) {
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
}

function renderAttachments(current: ViewState) {
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
}

function renderOptions(current: ViewState) {
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

const attachButton = button(s.attachFiles, { type: 'attachFiles' }, { disabled: true })
attachButton.className = 'attach-files'
const sendButton = el('button', s.send, 'primary')
sendButton.type = 'submit'
sendButton.disabled = true
const stopButton = button(s.stop, { type: 'stop' })
stopButton.hidden = true
get('actions').append(attachButton, sendButton, stopButton)

function renderSend() {
  if (attachButton.textContent !== s.attachFiles) attachButton.textContent = s.attachFiles
  attachButton.disabled = !state || state.busy
  if (sendButton.textContent !== s.send) sendButton.textContent = s.send
  sendButton.hidden = !!state?.running
  sendButton.disabled = !state || state.busy || !!sent || !!pendingPaste || (!input.value.trim() && !state.attachments.length)
  const label = state?.stopping ? s.stopping : s.stop
  if (stopButton.textContent !== label) stopButton.textContent = label
  stopButton.hidden = !state?.running
  stopButton.disabled = !!state?.stopping
}

function finishPaste(id: string, error?: string) {
  if (id !== pendingPaste) return
  clearTimeout(pasteTimer)
  pendingPaste = undefined
  pasteStatus.textContent = error ?? ''
  renderSend()
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
  pasteTimer = setTimeout(() => finishPaste(id, s.pasteFailed), 30_000)
  pasteStatus.textContent = s.pastingImage
  renderSend()
  try {
    const images = await Promise.all(files.map(file => file.arrayBuffer()))
    if (id !== pendingPaste) return
    if (images.some(image => !image.byteLength)) throw new Error('Empty clipboard image')
    if (images.reduce((sum, image) => sum + image.byteLength, 0) > maxPasteBytes) {
      finishPaste(id, s.pasteLimit)
      return
    }
    vscode.postMessage({ type: 'pasteImages', id, draft, images })
  } catch {
    finishPaste(id, s.pasteFailed)
  }
})

input.addEventListener('input', () => {
  if (!pendingPaste) pasteStatus.textContent = ''
  resetSlash()
  setDraft(drafts, key, input.value)
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
  renderSend()
  vscode.postMessage({ type: 'send', id: sent.id, text: sent.text })
})
window.addEventListener('message', ({ data }: MessageEvent<ViewEvent>) => {
  if (data.type === 'pasteFinished' && data.id === pendingPaste) {
    finishPaste(data.id, data.error)
  }
  if (data.type === 'submit' && !state?.settings && !composing) input.form?.requestSubmit()
  if (data.type === 'accepted' && sent?.id === data.id) {
    const draft = sent.draft
    if ((drafts[draft] ?? '') === sent.text && (key !== draft || sentRevision === draftRevision)) {
      delete drafts[draft]
      vscode.setState({ drafts })
      if (key === draft) input.value = ''
    }
    sent = undefined
    renderSend()
  }
  if (data.type === 'sendRejected' && sent?.id === data.id) {
    sent = undefined
    renderSend()
  }
  if (data.type === 'state' && (!state || data.state.revision > state.revision)) {
    render(data.state)
  }
})
vscode.postMessage({ type: 'ready' })
const syncFocus = () => vscode.postMessage({ type: 'focus', focused: document.hasFocus() })
window.addEventListener('focus', syncFocus)
window.addEventListener('blur', syncFocus)
syncFocus()
