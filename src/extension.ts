import * as vscode from 'vscode'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { RequestError } from '@agentclientprotocol/sdk'
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk'
import { ConnectionError, findExecutable, startAcp, type AcpConnection } from './acp'
import { History, type Entry } from './history'
import { discardClipboardImage, draftFileBudget, fileBlock, fileMode, pickFile, pruneClipboardImages, saveClipboardImages } from './file-attachment'
import { draftKey, readAction, readRequestId, type Approval, type Selection, type ViewAction, type ViewEvent, type ViewState } from './view-model'
import { isLanguage, resolveLocale, uiStrings as strings, useLocale } from './strings'
import { catalogKey, chooseExecutable, executableSetting, openAcpConfig, preferenceKey } from './settings'
import { applyDefaultModel, modelGroups, type ModelGroup, type ModelPreference } from './model-preference'
import type { SessionConfigOption } from '@agentclientprotocol/sdk'

const section = 'deepseekHarness'
const viewId = `${section}.chat`
const cancelled = { outcome: { outcome: 'cancelled' } } as const
const stopTimeout = 10_000
const streamPublishDelay = 32
const streamSaveDelay = 250

type Root = { path: string; name: string; uri: vscode.Uri }

export function activate(context: vscode.ExtensionContext) {
  const chat = new HarnessView(context)
  controller = chat
  context.subscriptions.push(
    chat.output,
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(`${section}.language`)) chat.refreshLanguage()
      if (e.affectsConfiguration(`${section}.enterToSend`)) chat.refreshEnterToSend()
    }),
    vscode.window.registerWebviewViewProvider(viewId, chat),
    vscode.commands.registerCommand(`${section}.openChat`, () => chat.openChat()),
    vscode.commands.registerCommand(`${section}.addSelection`, () => chat.addSelection()),
    vscode.commands.registerCommand(`${section}.askSelection`, () => chat.addSelection(true)),
    vscode.languages.registerCodeActionsProvider('*', {
      provideCodeActions(document, range) {
        const editor = vscode.window.activeTextEditor
        if (!editor || editor.document !== document || editor.selection.isEmpty || !editor.selection.intersection(range)
          || !vscode.workspace.getWorkspaceFolder(document.uri) || !vscode.workspace.isTrusted) return []
        return [['addSelection', strings.addQuote], ['askSelection', strings.askQuote]].map(([command, title]) => {
          const action = new vscode.CodeAction(`Harness: ${title}`, vscode.CodeActionKind.QuickFix)
          action.command = { command: `${section}.${command}`, title }
          return action
        })
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand(`${section}.showOutput`, () => chat.output.show()),
    vscode.commands.registerCommand(`${section}.settings`, () => chat.settings()),
    vscode.commands.registerCommand(`${section}.send`, () => chat.submit()),
    vscode.commands.registerCommand(`${section}.stop`, () => chat.stop()),
  )
}

let controller: HarnessView | undefined
export async function deactivate() { await controller?.dispose() }

type PendingApproval = {
  view: Approval
  finish(value: RequestPermissionResponse): void
}

class HarnessView implements vscode.WebviewViewProvider {
  readonly output = vscode.window.createOutputChannel('dsh-vscode')
  private readonly history?: History
  private view?: vscode.Webview
  private sidebar?: vscode.WebviewView
  private connection?: AcpConnection
  private starting?: AcpConnection
  private processCwd?: string
  private connectionError?: ConnectionError
  private root?: Root
  private cursor?: string
  private generation = 0
  private disposed = false
  private operation?: Promise<void>
  private restoration?: Promise<void>
  private turn?: Promise<void>
  private stopTimer?: ReturnType<typeof setTimeout>
  private publishTimer?: ReturnType<typeof setTimeout>
  private saveTimer?: ReturnType<typeof setTimeout>
  private lastChunk?: { entry: Entry; messageId: string | null | undefined }
  private readonly selections = new Map<string, Selection[]>()
  private imagePrompts?: boolean
  private acceptFileTurn?: () => void
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly state: ViewState = {
    enterToSend: vscode.workspace.getConfiguration(section).get('enterToSend', true),
    language: 'auto', locale: 'en',
    revision: 0, connection: 'idle', busy: false, canList: false, hasMore: false,
    running: false, stopping: false, missingExecutable: false, sessions: [], entries: [],
    options: [], attachments: [], approvals: [],
  }

  constructor(private readonly context: vscode.ExtensionContext) {
    if (context.storageUri) this.history = new History(context.storageUri.fsPath)
    if (vscode.workspace.isTrusted) {
      void pruneClipboardImages(this.clipboardDirectory).catch(() => this.output.appendLine('Clipboard image cleanup failed'))
    }
    this.refreshLanguage()
  }

  private get clipboardDirectory() {
    return join((this.context.storageUri ?? this.context.globalStorageUri).fsPath, 'clipboard-images')
  }

  refreshEnterToSend() {
    this.state.enterToSend = vscode.workspace.getConfiguration(section).get('enterToSend', true)
    this.publish()
  }
  refreshLanguage() {
    const value = vscode.workspace.getConfiguration(section).get('language')
    this.state.language = isLanguage(value) ? value : 'auto'
    this.state.locale = resolveLocale(this.state.language, vscode.env.language)
    const previous = strings
    useLocale(this.state.locale)
    if (strings !== previous) {
      const key = (Object.keys(previous) as (keyof typeof previous)[]).find(k => previous[k] === this.state.error)
      if (key) this.state.error = strings[key]
      if (this.state.settings) {
        this.state.settings.feedback = ''
        if (this.state.settings.executable === previous.missing) this.state.settings.executable = strings.missing
      }
    }
    this.publish()
  }

  private get attachmentKey() { return draftKey(this.root?.path, this.state.sessionId) }
  get launchDirectory() { return this.processCwd ?? this.root?.path ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd() }
  submit() { if (!this.state.busy && !this.state.settings) this.post({ type: 'submit' }) }
  async openChat() {
    this.state.settings = undefined
    await vscode.commands.executeCommand(`${viewId}.focus`)
    this.publish()
  }
  private settingsGroups() {
    return this.activeId ? modelGroups(this.state.options) : this.context.globalState.get<ModelGroup[]>(catalogKey, [])
  }
  async settings() {
    await vscode.commands.executeCommand(`${viewId}.focus`)
    if (!this.state.settings) {
      this.state.settings = {
        ...await executableSetting(), groups: this.settingsGroups(), pending: false, feedback: '',
        preference: this.context.globalState.get<ModelPreference>(preferenceKey),
      }
    }
    this.publish()
  }
  private async changeSettings(action: Extract<ViewAction, { type: 'saveDefault' | 'language' | 'enterToSend' }> | { type: 'followAcp' | 'settingsBrowse' | 'settingsReset' }) {
    const page = this.state.settings
    if (!page || page.pending) return
    page.pending = true
    page.feedback = ''
    this.publish()
    try {
      if (action.type === 'enterToSend') {
        await vscode.workspace.getConfiguration(section).update('enterToSend', action.value, vscode.ConfigurationTarget.Global)
        this.refreshEnterToSend()
      } else if (action.type === 'language') {
        await vscode.workspace.getConfiguration(section).update('language', action.value === 'auto' ? undefined : action.value, vscode.ConfigurationTarget.Global)
        this.refreshLanguage()
      } else if (action.type === 'settingsBrowse' || action.type === 'settingsReset') {
        if (await chooseExecutable(action.type === 'settingsReset')) {
          Object.assign(page, await executableSetting())
          page.feedback = strings.nextConnection
        }
      } else {
        let preference: ModelPreference | undefined
        if (action.type === 'saveDefault') {
          const group = this.settingsGroups().find(item => item.id === action.group)
          const model = group?.models.find(item => item.value === action.value)
          if (!group || !model) throw new Error(strings.modelUnavailable)
          preference = { group: group.id, providerName: group.name, modelName: model.name, value: model.value }
        }
        await this.context.globalState.update(preferenceKey, preference)
        page.preference = preference
        page.feedback = strings.saved
      }
    } catch {
      page.feedback = action.type === 'enterToSend' ? strings.keySaveError : action.type === 'language' ? strings.languageError
        : action.type === 'settingsBrowse' || action.type === 'settingsReset' ? strings.missing : strings.savingFailed
    } finally {
      page.pending = false
      this.publish()
    }
  }
  private get attachments() { return this.selections.get(this.attachmentKey) ?? [] }
  private set attachments(items: Selection[]) {
    if (items.length) this.selections.set(this.attachmentKey, items)
    else this.selections.delete(this.attachmentKey)
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.sidebar = view
    const visibility = () => {
      if (!view.visible) void vscode.commands.executeCommand('setContext', 'deepseekHarness.chatFocused', false)
      void vscode.commands.executeCommand('setContext', 'deepseekHarness.chatVisible', view.visible)
    }
    void visibility()
    const visibilityListener = view.onDidChangeVisibility(visibility)
    const web = this.view = view.webview
    web.options = { enableScripts: true, localResourceRoots: [
      vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media'),
    ] }
    const asset = (path: string) => web.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, path))
    const nonce = randomUUID()
    web.html = `<!doctype html>
      <html lang="${this.state.locale}"><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource}; script-src 'nonce-${nonce}';">
      <link rel="stylesheet" href="${asset('media/chat.css')}"><title>dsh-vscode</title>
      </head><body><header><div id="project"></div><div id="sessions"></div></header>
      <main id="chat" aria-label="${strings.session}"></main>
      <footer><div id="feedback" role="status"></div><div id="attachments"></div><div id="options"></div>
      <form><div class="composer"><div id="slashMenu" role="listbox" hidden></div>
        <textarea rows="3" aria-controls="slashMenu" aria-autocomplete="list" aria-label="${strings.prompt}" placeholder="${strings.prompt}"></textarea></div>
        <div id="slashHint" role="status"></div><div id="pasteStatus" role="status"></div><div id="actions"></div></form>
      </footer><section id="settingsPage" aria-label="${strings.settings}" hidden>
        <button id="settingsBack" class="back" type="button"><span aria-hidden="true">←</span> ${strings.back}</button>
        <h1 data-i18n="settings">${strings.settings}</h1>
        <section><h2 id="languageHeading" data-i18n="language">${strings.language}</h2>
          <select id="uiLanguage" aria-labelledby="languageHeading">
            <option value="auto" data-i18n="autoLanguage">${strings.autoLanguage}</option><option value="zh-CN" lang="zh-CN">简体中文</option><option value="en" lang="en">English</option>
          </select></section>
        <section><h2 data-i18n="composerKeys">${strings.composerKeys}</h2>
          <label class="inputToggle"><input type="checkbox" id="enterToSend"><span data-i18n="enterToSend">${strings.enterToSend}</span></label>
          <div class="newlineHint"><span data-i18n="newline">${strings.newline}</span><span><kbd>Shift</kbd> + <kbd>Enter</kbd></span></div>
          <div class="settingsLinks"><button id="editShortcuts" data-i18n="shortcuts">${strings.shortcuts}</button></div>
        </section>
        <section><h2 data-i18n="defaultModel">${strings.defaultModel}</h2>
          <label for="defaultProvider" data-i18n="provider">${strings.provider}</label><select id="defaultProvider"></select>
          <div id="defaultModelField"><label for="defaultModel" data-i18n="modelLabel">${strings.modelLabel}</label><select id="defaultModel"></select></div>
          <p id="catalogHint" hidden data-i18n="needCatalog">${strings.needCatalog}</p>
          <button class="primary" id="saveDefault" type="button" data-i18n="saveDefault">${strings.saveDefault}</button>
        </section>
        <section><h2 data-i18n="runtime">${strings.runtime}</h2><code id="runtimePath"></code>
          <div class="row"><button id="selectRuntime" data-i18n="browse">${strings.browse}</button><button id="resetRuntime" data-i18n="automatic">${strings.automatic}</button></div>
        </section>
        <section><h2 data-i18n="toolsTitle">${strings.toolsTitle}</h2><div class="settingsLinks">
          <button id="editProfile" data-i18n="openConfig">${strings.openConfig}</button>
          <button id="showDiagnostics" data-i18n="diagnostics">${strings.diagnostics}</button>
        </div></section><p id="settingsStatus" role="status"></p>
      </section>
      <script nonce="${nonce}" src="${asset('dist/webview.js')}"></script></body></html>`
    const listener = web.onDidReceiveMessage(input => this.receive(input))
    view.onDidDispose(() => {
      listener.dispose()
      visibilityListener.dispose()
      void vscode.commands.executeCommand('setContext', 'deepseekHarness.chatVisible', false)
      void vscode.commands.executeCommand('setContext', 'deepseekHarness.chatFocused', false)
      if (this.view === web) { this.view = undefined; this.sidebar = undefined }
    })
  }

  private receive(input: unknown) {
    const action = readAction(input)
    if (!action || this.disposed) {
      if (input && typeof input === 'object' && 'type' in input) {
        const id = readRequestId(input)
        if (id && input.type === 'pasteImages') this.post({ type: 'pasteFinished', id, error: strings.pasteFailed })
        if (id && input.type === 'send') this.post({ type: 'sendRejected', id })
      }
      return
    }
    if (action.type === 'pasteImages') {
      if (this.state.busy || this.state.settings || !vscode.workspace.isTrusted || this.attachmentKey !== action.draft) {
        this.post({ type: 'pasteFinished', id: action.id, error: strings.pasteBusy })
        return
      }
      this.run('pasteImages', async () => {
        let error: string | undefined
        try {
          const files = await saveClipboardImages(this.clipboardDirectory, action.images, this.remainingFileBudget, this.imagePrompts)
          if (this.disposed || this.attachmentKey !== action.draft) {
            await Promise.all(files.map(discardClipboardImage))
            error = strings.pasteBusy
          } else {
            this.attachments = [...this.attachments, ...files.map(file => ({ ...file, source: vscode.Uri.file(file.path).toString() }))]
          }
        } catch { error = strings.pasteFailed }
        this.post({ type: 'pasteFinished', id: action.id, error })
      })
      return
    }
    if (action.type === 'focusReceived') {
      if (this.state.composerFocus === action.id) this.state.composerFocus = undefined
      return
    }
    if (action.type === 'quoted') {
      if (this.state.settings || action.session !== this.state.sessionId) return
      const entry = this.state.entries.find(row => row.id === action.id && (row.kind === 'user' || row.kind === 'assistant'))
      if (!entry || (entry.kind !== 'user' && entry.kind !== 'assistant')) return
      if (!this.attachments.some(item => item.kind === 'quote' && item.entryId === entry.id && item.text === action.text)) {
        this.attachments = [...this.attachments, { kind: 'quote', id: randomUUID(), entryId: entry.id, role: entry.kind, text: action.text }]
      }
      if (action.ask) this.state.composerFocus = randomUUID()
      this.publish()
      return
    }
    if (action.type === 'focus') {
      void vscode.commands.executeCommand('setContext', 'deepseekHarness.chatFocused', action.focused && !this.state.settings)
      return
    }
    if (action.type === 'ready') {
      this.publish()
      this.ensureRestore()
      return
    }
    if (action.type === 'diagnostics') { this.output.show(); return }
    if (action.type === 'previewFile') {
      const file = this.attachments.find(item => item.kind === 'file' && item.id === action.id)
      if (file?.kind === 'file') void vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(file.source))
        .then(undefined, () => vscode.window.showWarningMessage(`${strings.fileUnreadable} ${file.name}`))
      return
    }
    if (action.type === 'settings') { void this.settings(); return }
    if (action.type === 'back') { void this.openChat(); return }
    if (action.type === 'shortcuts') {
      void vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', `@ext:${this.context.extension.id}`)
      return
    }
    if (action.type === 'settingsBrowse' || action.type === 'settingsReset' || action.type === 'saveDefault' || action.type === 'followAcp' || action.type === 'language' || action.type === 'enterToSend') {
      void this.changeSettings(action)
      return
    }
    if (action.type === 'openConfig') { void openAcpConfig(this.launchDirectory); return }
    if (action.type === 'permission') {
      const pending = this.approvals.get(action.id)
      if (!this.state.stopping && pending?.view.options.some(option => option.optionId === action.optionId)) {
        pending.finish({ outcome: { outcome: 'selected', optionId: action.optionId } })
      }
      return
    }
    if (action.type === 'stop') { void this.stop(); return }
    if (action.type === 'remove') {
      if (this.state.busy) return
      const removed = this.attachments.find(item => item.id === action.id)
      if (removed?.kind === 'file') void discardClipboardImage(removed).catch(() => this.output.appendLine('Clipboard image cleanup failed'))
      this.attachments = this.attachments.filter(entry => entry.id !== action.id)
      this.publish()
      return
    }
    if (action.type === 'send') {
      if (this.state.busy || this.state.settings || !vscode.workspace.isTrusted || (!action.text.trim() && !this.attachments.length)) {
        this.post({ type: 'sendRejected', id: action.id })
        return
      }
      this.turn = this.send(action.id, action.text).finally(() => { this.turn = undefined })
      return
    }
    if (this.state.busy || !vscode.workspace.isTrusted) return
    this.run(action.type, async () => {
      switch (action.type) {
        case 'attachFiles': return this.attachFiles()
        case 'new': return this.open(await this.chooseFolder())
        case 'resume':
          if (this.root && this.state.sessions.some(session => session.id === action.id)) return this.open(this.root, action.id)
          return
        case 'refresh': case 'more': {
          const root = this.root ?? await this.chooseFolder()
          if (root) { await this.connect(root.path); this.setRoot(root); await this.list(action.type === 'more') }
          return
        }
        case 'reconnect': return this.open(this.root ?? await this.chooseFolder(), this.state.sessionId)
        case 'browse':
          if (await chooseExecutable()) await this.open(this.root ?? await this.chooseFolder(), this.state.sessionId)
          return
        case 'restartNew': return this.restartNew()
        case 'clear': return this.clearHistory()
        case 'configure': return this.configure(action.id, action.value)
      }
    })
  }

  private ensureRestore(preferred?: Root) {
    if (!this.restoration && !this.state.busy && vscode.workspace.isTrusted) {
      this.restoration = this.run('restore', () => this.restore(preferred))
    }
    return this.restoration
  }

  private async restore(preferred?: Root) {
    const folders = vscode.workspace.workspaceFolders ?? []
    const previous = this.context.workspaceState.get<{ path: string; id: string }>('lastSession')
    const roots = preferred ? [preferred] : (await Promise.allSettled(folders.map(folder => this.folderRoot(folder))))
      .flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
    if (this.disposed) return
    const previousRoot = previous && roots.find(root => root.path === previous.path)
    if (previousRoot && previous) {
      this.setRoot(previousRoot)
      this.state.sessionId = previous.id
      this.state.entries = await this.readHistory(previousRoot.path, previous.id)
      this.publish()
      return this.open(previousRoot, previous.id)
    }
    if (roots.length === 1) this.setRoot(roots[0])
  }

  private async chooseFolder() {
    const folders = vscode.workspace.workspaceFolders ?? []
    if (!folders.length) throw new Error(strings.workspace)
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: strings.pickFolder })
    return folder && this.folderRoot(folder)
  }

  private async folderRoot(folder: vscode.WorkspaceFolder): Promise<Root> {
    return { path: await realpath(folder.uri.fsPath), name: folder.name, uri: folder.uri }
  }

  private get remainingFileBudget() {
    return this.attachmentModes(this.attachments).remaining
  }

  private attachmentModes(items: Selection[]) {
    let remaining = draftFileBudget
    const modes = new Map<string, ReturnType<typeof fileMode>>()
    for (const item of items) {
      if (item.kind !== 'file') continue
      const mode = fileMode(item, this.imagePrompts, remaining)
      if (mode !== 'fileLink') remaining -= item.size
      modes.set(item.id, mode)
    }
    return { modes, remaining }
  }

  private async attachFiles() {
    const files = await vscode.window.showOpenDialog({
      canSelectFiles: true, canSelectFolders: false, canSelectMany: true, openLabel: strings.attachFiles,
      defaultUri: this.root?.uri,
    })
    if (!files?.length || this.disposed) return
    const failed: string[] = []
    let remaining = this.remainingFileBudget
    for (const uri of files) {
      if (this.attachments.some(item => item.kind === 'file' && item.path === uri.fsPath)) continue
      try {
        if (!['file', 'vscode-remote'].includes(uri.scheme)) throw new Error('Expected a filesystem URI')
        const file = await pickFile(uri.fsPath, remaining, this.imagePrompts)
        this.attachments = [...this.attachments, { ...file, source: uri.toString() }]
        if (file.payload) remaining -= file.size
      } catch { failed.push(vscode.workspace.asRelativePath(uri)) }
    }
    if (failed.length) void vscode.window.showWarningMessage(`${strings.fileUnreadable} ${failed.join(', ')}`)
    this.state.composerFocus = randomUUID()
  }

  async addSelection(ask = false) {
    const editor = vscode.window.activeTextEditor
    const folder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)
    if (!editor || !folder || editor.selection.isEmpty) {
      void vscode.window.showWarningMessage(strings.selectionFolder)
      return
    }
    const { document, selection } = editor
    const last = selection.end.character === 0 && selection.end.line > selection.start.line
      ? selection.end.line : selection.end.line + 1
    const snapshots = {
      kind: 'editor' as const,
      id: randomUUID(), file: relative(folder.uri.fsPath, document.uri.fsPath),
      lines: `${selection.start.line + 1}–${last}`, language: document.languageId,
      text: document.getText(selection),
    }
    try {
      const root = await this.folderRoot(folder)
      const firstOpen = !this.sidebar && !this.restoration
      const restoring = this.ensureRestore(root)
      if (firstOpen) {
        await this.openChat()
        if (!ask) await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
      }
      await restoring
      if (this.disposed) return
      if (this.root?.path !== root.path && (this.state.sessionId || this.state.busy)) {
        void vscode.window.showWarningMessage(strings.selectionMismatch)
        return
      }
      this.setRoot(root)
      if (!this.attachments.some(item => item.kind === 'editor' && item.file === snapshots.file && item.lines === snapshots.lines && item.text === snapshots.text)) {
        this.attachments = [...this.attachments, snapshots]
      }
      this.state.settings = undefined
      if (ask) {
        await this.openChat()
        this.state.composerFocus = randomUUID()
      } else if (this.sidebar) this.sidebar.show(true)
      else {
        await this.openChat()
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup')
      }
      this.publish()
    } catch (error) { this.report('selection', error) }
  }

  private setRoot(root: Root) {
    if (this.root?.path !== root.path) {
      this.cursor = undefined
      this.state.hasMore = false
      this.state.sessions = []
    }
    this.root = root
    this.state.cwd = root.path
    this.state.workspace = root.name
  }

  private async connect(cwd: string) {
    if (!vscode.workspace.isTrusted || this.disposed) throw new Error(strings.trust)
    if (this.connection) return this.connection
    const generation = ++this.generation
    this.connectionError = undefined
    this.state.connection = 'connecting'
    this.publish()
    try {
      const executable = await findExecutable(vscode.workspace.getConfiguration(section).get('executablePath', '').trim())
      if (this.disposed) throw new Error(strings.connectionError)
      const connection = this.starting = startAcp(executable, cwd, {
        update: event => { if (generation === this.generation) this.update(event) },
        permission: (event, signal) => generation === this.generation ? this.permission(event, signal) : Promise.resolve(cancelled),
        disconnected: error => { if (generation === this.generation && !this.disposed) this.disconnect(error) },
      })
      const capabilities = await connection.initialize()
      if (this.disposed || generation !== this.generation) throw new Error(strings.connectionError)
      if (!capabilities.sessionCapabilities?.resume || !capabilities.sessionCapabilities.close
        || !capabilities.sessionCapabilities.list) throw new ConnectionError('protocol', strings.capability)
      this.connection = connection
      this.imagePrompts = capabilities.promptCapabilities?.image === true
      this.processCwd = cwd
      this.state.connection = 'connected'
      this.state.canList = true
      this.output.appendLine('ACP v1 connected')
      return connection
    } catch (error) {
      await this.starting?.dispose()
      this.state.connection = 'disconnected'
      throw error
    } finally { this.starting = undefined; this.publish() }
  }

  private async resume(connection: AcpConnection, root: Root, id: string) {
    try { return await connection.resume(root.path, id) } catch (error) {
      if (!(error instanceof RequestError) || error.code !== -32602
        || !/session is not resumable|session cwd does not match|session not found/i.test(error.message)) throw error
      if (this.root?.path === root.path) {
        if (!this.activeId && this.state.sessionId === id) {
          if (this.saveTimer) this.persist()
          const draft = this.attachments
          this.selections.delete(this.attachmentKey)
          this.state.sessionId = undefined
          this.state.entries = []
          this.attachments = [...this.attachments, ...draft]
          this.setError(strings.sessionUnavailable)
          this.publish()
          const previous = this.context.workspaceState.get<{ path: string; id: string }>('lastSession')
          if (previous?.id === id && previous.path === root.path) {
            await this.context.workspaceState.update('lastSession', undefined).then(undefined,
              () => this.output.appendLine('Could not clear the saved session reference'))
          }
        }
        try { await this.list(false) } catch { this.output.appendLine('Session list refresh failed after resume') }
      }
      throw new Error(strings.sessionUnavailable)
    }
  }

  private async open(root?: Root, id?: string, fromSend = false) {
    if (!root) return
    let connection = await this.connect(root.path)
    const oldId = this.state.sessionId
    if (oldId && oldId === id && this.state.connection === 'connected' && this.activeId === id) return
    const preference = this.context.globalState.get<ModelPreference>(preferenceKey)
    const response = id ? await this.resume(connection, root, id) : await connection.create(root.path)
    if (connection !== this.connection || this.disposed) return
    const sessionId = id ?? ('sessionId' in response ? response.sessionId : undefined)
    if (typeof sessionId !== 'string') throw new Error(strings.failedOperation)
    const configure = async (transport: AcpConnection, options: SessionConfigOption[] = []) => {
      try {
        await this.rememberCatalog(options)
        return id ? options : await applyDefaultModel(options, preference, async value =>
          (await transport.configure(sessionId, 'model', value)).configOptions, strings.modelUnavailable)
      } catch (error) {
        await this.closeSession(transport, sessionId)
        throw error
      }
    }
    let options = await configure(connection, response.configOptions ?? [])
    if (this.activeId && !await this.closeSession(connection, this.activeId)) {
      this.resetConnection()
      await connection.dispose()
      if (this.disposed) return
      connection = await this.connect(root.path)
      options = await configure(connection, (await this.resume(connection, root, sessionId)).configOptions ?? [])
      this.setError()
    }
    if (connection !== this.connection || this.disposed) return
    if (this.saveTimer) this.persist()
    const entries = id ? await this.readHistory(root.path, sessionId) : []
    if (connection !== this.connection || this.disposed) return
    const previousAttachmentKey = this.attachmentKey
    const outgoingAttachments = this.attachments
    const keepAttachments = !oldId && !id && (!this.root || this.root.path === root.path)
    this.setRoot(root)
    this.activeId = sessionId
    this.state.sessionId = sessionId
    if (keepAttachments && outgoingAttachments.length) {
      this.selections.delete(previousAttachmentKey)
      this.attachments = outgoingAttachments
    }
    this.state.options = options
    this.state.entries = entries
    await this.context.workspaceState.update('lastSession', { path: root.path, id: sessionId })
    this.publish()
    if (!fromSend) await this.list(false)
  }

  private activeId?: string

  private async rememberCatalog(options: SessionConfigOption[]) {
    const groups = modelGroups(options)
    const store = this.context.globalState
    if (JSON.stringify(groups) !== JSON.stringify(store.get(catalogKey))) await store.update(catalogKey, groups)
  }

  private async list(append: boolean) {
    if (!this.connection || !this.root) return
    if (append && !this.cursor) return
    const result = await this.connection.list(this.root.path, append ? this.cursor : undefined)
    this.cursor = result.nextCursor ?? undefined
    this.state.hasMore = !!this.cursor
    this.state.sessions = [...new Map([
      ...(append ? this.state.sessions : []),
      ...result.sessions.map(session => ({ id: session.sessionId, title: session.title || '' })),
    ].map(item => [item.id, item])).values()]
  }

  private async readHistory(cwd: string, sessionId: string): Promise<Entry[]> {
    try {
      const value = await this.history?.load(cwd, sessionId)
      if (!value) return [{ kind: 'notice', id: randomUUID(), text: strings.noHistory }]
      if (value.inProgress) value.entries.push({ kind: 'notice', id: randomUUID(), text: strings.interrupted })
      return value.entries
    } catch {
      return [{ kind: 'notice', id: randomUUID(), text: strings.lostHistory }]
    }
  }

  private async clearHistory() {
    if (!this.root || !this.state.sessionId) return
    const confirm = await vscode.window.showWarningMessage(strings.clearConfirm, { modal: true }, strings.clearAction)
    if (confirm !== strings.clearAction) return
    if (this.saveTimer) this.persist()
    const entries = this.state.entries
    this.state.entries = []
    try { await this.history?.clear(this.root.path, this.state.sessionId) } catch (error) {
      this.state.entries = [...entries, ...this.state.entries]
      throw error
    }
  }

  private async restartNew() {
    if (this.connection) {
      const connection = this.connection
      const activeId = this.activeId
      this.resetConnection()
      if (activeId) await this.closeSession(connection, activeId, 1500)
      await connection.dispose()
    }
    this.state.connection = 'idle'
    await this.open(this.root ?? await this.chooseFolder())
  }

  private async closeSession(connection: AcpConnection, id: string, timeout?: number) {
    try { await connection.close(id, timeout); return true } catch {
      this.output.appendLine('ACP session close failed')
      return false
    }
  }

  private async configure(id: string, value: string) {
    const option = this.state.options.find(option => option.id === id && option.type === 'select')
    if (option?.type !== 'select' || !option.options.some(item => 'group' in item
      ? item.options.some(entry => entry.value === value) : item.value === value)) return
    if (this.connection && this.activeId) this.state.options = (await this.connection.configure(this.activeId, id, value)).configOptions
  }

  private async send(id: string, text: string) {
    const previousKey = draftKey(this.root?.path, this.state.sessionId)
    const selection = [...this.attachments]
    let accepted = false
    this.state.busy = true
    this.setError()
    this.publish()
    try {
      if (!this.activeId) await this.open(this.root ?? await this.chooseFolder(), this.state.sessionId, true)
      const connection = this.connection
      const sessionId = this.activeId
      if (!connection || !sessionId || this.disposed) return
      const blocks: Parameters<AcpConnection['prompt']>[1] = []
      const transcript: string[] = []
      const { modes } = this.attachmentModes(selection)
      for (const item of selection) {
        if (item.kind === 'file') {
          const mode = modes.get(item.id)!
          try { blocks.push(await fileBlock(item, !!this.imagePrompts, mode !== 'fileLink')) }
          catch {
            this.setError(`${strings.fileUnreadable} ${item.name}`)
            return
          }
          transcript.push(`📎 ${item.name} · ${strings[mode]}`)
        } else {
          const content = item.kind === 'editor'
            ? `Editor selection in ${item.file}, lines ${item.lines} (${item.language}):\n${item.text}`
            : `Quoted text from a previous ${item.role} message:\n${item.text}`
          blocks.push(content + '\n\n')
          transcript.push(content)
        }
      }
      if (this.disposed || this.connection !== connection) return
      if (text.trim()) { blocks.push(text.trim()); transcript.push(text.trim()) }
      this.state.entries.push({ kind: 'user', id: randomUUID(), text: transcript.join('\n\n') })
      this.state.running = true
      void vscode.commands.executeCommand('setContext', 'deepseekHarness.running', true)
      const accept = () => {
        this.acceptFileTurn = undefined
        accepted = true
        for (const item of selection) {
          if (item.kind === 'file' && modes.get(item.id) === 'fileImage') {
            void discardClipboardImage(item).catch(() => this.output.appendLine('Clipboard image cleanup failed'))
          }
        }
        this.attachments = this.attachments.filter(item => !selection.some(sent => item.id === sent.id))
        this.post({ type: 'accepted', id, sessionKey: previousKey })
      }
      if (selection.some(item => item.kind === 'file')) this.acceptFileTurn = accept
      else accept()
      this.persist()
      this.publish()
      const result = await connection.prompt(sessionId, blocks)
      this.acceptFileTurn?.()
      if (result.stopReason === 'cancelled') this.notice(strings.stopped)
      else if (result.stopReason !== 'end_turn') this.notice(`${strings.limited} (${result.stopReason})`)
    } catch (error) {
      if (this.state.running) this.notice(strings.interrupted)
      this.report('prompt', error)
    } finally {
      clearTimeout(this.stopTimer)
      this.stopTimer = undefined
      this.acceptFileTurn = undefined
      this.state.busy = this.state.running = this.state.stopping = false
      void vscode.commands.executeCommand('setContext', 'deepseekHarness.running', false)
      this.cancelApprovals()
      this.persist()
      if (!accepted) this.post({ type: 'sendRejected', id })
      this.publish()
    }
  }

  async stop() {
    const connection = this.connection
    if (!connection || !this.activeId || !this.state.running || this.state.stopping) return
    this.state.stopping = true
    this.publish()
    const timer = this.stopTimer = setTimeout(() => {
      connection.abort(new ConnectionError('timeout', strings.stopTimeout))
    }, stopTimeout)
    try {
      const sending = connection.cancel(this.activeId)
      this.cancelApprovals()
      await sending
    } catch (error) {
      if (this.stopTimer !== timer) return
      clearTimeout(timer)
      this.stopTimer = undefined
      this.state.stopping = false
      this.report('cancel', error)
      this.publish()
    }
  }

  private update({ sessionId, update }: SessionNotification) {
    if (sessionId !== this.activeId) return
    if (['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update'].includes(update.sessionUpdate)) this.acceptFileTurn?.()
    if (update.sessionUpdate === 'config_option_update') {
      this.state.options = update.configOptions
      void this.rememberCatalog(update.configOptions).catch(() => this.output.appendLine('Model catalog cache update failed'))
    }
    if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
      const kind = update.sessionUpdate === 'agent_message_chunk' ? 'assistant' : 'thought'
      if (update.content.type === 'text') {
        const last = this.state.entries.at(-1)
        if (last?.kind === kind && this.lastChunk?.entry === last && this.lastChunk.messageId === update.messageId) {
          last.text += update.content.text
        } else {
          const entry: Entry = { kind, id: randomUUID(), text: update.content.text }
          this.state.entries.push(entry)
          this.lastChunk = { entry, messageId: update.messageId }
        }
      }
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const existing = this.state.entries.find((row): row is Extract<Entry, { kind: 'tool' }> => row.kind === 'tool' && row.id === update.toolCallId)
      const row = existing ?? { kind: 'tool', id: update.toolCallId, title: update.toolCallId, status: 'pending' }
      row.title = update.title ?? row.title
      row.status = update.status ?? row.status
      if (update.rawInput != null) row.input = displayValue(update.rawInput)
      if (update.rawOutput != null) row.output = displayValue(update.rawOutput)
      else if (update.content?.length) row.output = displayValue(update.content)
      if (!existing) this.state.entries.push(row)
    }
    this.saveTimer ??= setTimeout(() => this.persist(), streamSaveDelay)
    this.publishTimer ??= setTimeout(() => this.publish(), streamPublishDelay)
  }

  private permission(params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    if (params.sessionId !== this.activeId || this.disposed || this.state.stopping || signal.aborted) return Promise.resolve(cancelled)
    this.acceptFileTurn?.()
    const id = randomUUID()
    const view = { id, callId: params.toolCall.toolCallId, options: params.options }
    return new Promise(resolve => {
      const abort = () => finish(cancelled)
      const finish = (result: RequestPermissionResponse) => {
        if (!this.approvals.delete(id)) return
        signal.removeEventListener('abort', abort)
        resolve(result)
        this.publish()
      }
      this.approvals.set(id, { view, finish })
      signal.addEventListener('abort', abort, { once: true })
      this.publish()
    })
  }

  private cancelApprovals() {
    for (const approval of this.approvals.values()) approval.finish(cancelled)
  }

  private resetConnection() {
    ++this.generation
    this.connection = undefined
    this.activeId = undefined
    this.processCwd = undefined
    this.state.connection = 'disconnected'
    this.imagePrompts = undefined
    this.state.canList = false
    this.state.options = []
  }

  private disconnect(error: ConnectionError) {
    this.resetConnection()
    this.connectionError = error
    this.cancelApprovals()
    this.report('connection', error)
    this.publish()
  }

  private report(stage: string, error: unknown) {
    const kind = error instanceof ConnectionError ? error.kind : error instanceof Error ? error.name : 'Error'
    const known = error instanceof Error && Object.values(strings).includes(error.message)
    const authentication = error instanceof Error
      && /authentication fail|invalid[ _-]+api[ _-]+key|incorrect api key|invalid credentials|\b401\b|ACCOUNT_SIGN_IN_REQUIRED|ACCOUNT_TOKEN_INVALID|MISSING_CREDENTIAL|INVALID_CREDENTIAL|no credential for provider route|sign in to (?:your )?DeepSeek/i.test(error.message)
    const disconnected = this.state.connection === 'disconnected' ? this.connectionError : undefined
    const message = authentication ? strings.authentication : known ? error.message : kind === 'executable' ? strings.missing
      : disconnected?.message === strings.stopTimeout ? strings.stopTimeout
      : disconnected || error instanceof ConnectionError || stage === 'connection' ? strings.connectionError : strings.failedOperation
    this.setError(message, authentication ? 'authentication' : kind === 'executable' ? 'executable' : undefined)
    const status = error instanceof ConnectionError && ['exit', 'spawn'].includes(error.kind) ? ` (${error.message})` : ''
    this.output.appendLine(`${stage}: ${authentication ? 'model authentication failed' : kind}${status}`)
  }

  private setError(error?: string, kind?: 'authentication' | 'executable') {
    this.state.error = error
    this.state.authenticationError = kind === 'authentication'
    this.state.missingExecutable = kind === 'executable'
  }

  private run(stage: string, action: () => Promise<void>) {
    this.state.busy = true
    if (stage !== 'attachFiles' && stage !== 'pasteImages') this.setError()
    this.publish()
    this.operation = action().catch(error => this.report(stage, error)).finally(() => {
      this.operation = undefined
      this.state.busy = false
      this.publish()
    })
    return this.operation
  }

  private notice(text: string) { this.state.entries.push({ kind: 'notice', id: randomUUID(), text }) }

  private persist() {
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    if (!this.history || !this.root || !this.state.sessionId) return
    void this.history.save(this.root.path, this.state.sessionId, {
      version: 1, inProgress: this.state.running, entries: this.state.entries,
    }).catch(() => {
      if (this.state.error) return
      this.setError(strings.saveError)
      this.publish()
    })
  }

  private post(event: ViewEvent) { void this.view?.postMessage(event) }

  private publish() {
    clearTimeout(this.publishTimer)
    this.publishTimer = undefined
    if (this.disposed) return
    if (this.state.settings) this.state.settings.groups = this.settingsGroups()
    this.state.revision++
    const { modes } = this.attachmentModes(this.attachments)
    this.state.attachments = this.attachments.map(item => item.kind === 'file' ? {
      id: item.id, label: item.name, file: { size: item.size, mode: modes.get(item.id)!, path: item.path },
    } : ({
      id: item.id, label: item.kind === 'editor' ? `${item.file}:${item.lines}` : `“${item.text.replace(/\s+/g, ' ').slice(0, 80)}”`,
    }))
    this.state.approvals = [...this.approvals.values()].map(pending => pending.view)
    this.post({ type: 'state', state: this.state })
  }

  async dispose() {
    this.disposed = true
    clearTimeout(this.stopTimer)
    this.stopTimer = undefined
    clearTimeout(this.publishTimer)
    this.cancelApprovals()
    const connection = this.connection
    if (connection && this.activeId) await this.closeSession(connection, this.activeId, 1500)
    await Promise.all([connection?.dispose(), this.starting?.dispose()])
    await this.turn
    if (this.saveTimer) this.persist()
    for (const items of this.selections.values()) {
      for (const item of items) {
        if (item.kind === 'file') await discardClipboardImage(item).catch(() => {})
      }
    }
    await this.history?.flush()
  }
}

function displayValue(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return text.length > 30_000 ? `${text.slice(0, 30_000)}…` : text
}
