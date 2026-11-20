import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { chromium, type Browser, type Frame, type Locator, type Page } from 'playwright-core'

const run = promisify(execFile)
const code = process.env.VSCODE_TEST_BINARY ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
const cli = process.env.VSCODE_TEST_CLI ?? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
const { name, version, contributes } = JSON.parse(await readFile('package.json', 'utf8'))
const artifact = resolve(process.env.VSCODE_TEST_VSIX ?? `artifacts/${name}-${version}.vsix`)
const real = process.env.DSH_UI_REAL === '1'
const model = !real || process.env.DSH_TEST_MODEL === '1'
const approvals = real && model && process.env.DSH_TEST_APPROVAL === '1'
const root = await mkdtemp(join(tmpdir(), 'dsh-vscode-editor-'))
const workspace = join(root, 'project')
const profile = join(root, 'profile')
const extensions = join(root, 'extensions')
const cliArgs = ['--user-data-dir', profile, '--extensions-dir', extensions]
const filename = join(workspace, 'editor-test.txt')
const writeSettings = async (executable: string) => writeFile(join(profile, 'User', 'settings.json'), JSON.stringify({
  'deepseekHarness.executablePath': executable,
  'workbench.startupEditor': 'none',
  'telemetry.telemetryLevel': 'off',
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'workbench.tips.enabled': false,
  'workbench.activityBar.location': 'default',
  'editor.inlineSuggest.enabled': false,
  'files.simpleDialog.enable': true,
  'window.menuStyle': 'custom',
}))
const shellQuote = (input: string) => "'" + input.replaceAll("'", "'\\''") + "'"
await mkdir(workspace, { recursive: true })
await mkdir(join(profile, 'User'), { recursive: true })
await writeFile(filename, 'Saved text')
const fixture = join(root, 'fixture')
await writeFile(fixture, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(resolve('test/fixture.mjs'))}\n`, { mode: 0o700 })
await writeSettings(real ? (process.env.DSH_TEST_BINARY ?? '/usr/local/bin/dsh') : join(root, 'missing-dsh'))
const env = {
  ...process.env,
  DSH_HOME: (real && process.env.DSH_UI_HARNESS_HOME) || join(root, 'dsh-home'),
  DSH_TELEMETRY_DISABLED: '1',
  ...(approvals ? { DSH_PERMISSION_MODE: 'read-only' } : {}),
}
if (!real) {
  const acpDir = join(env.DSH_HOME, 'profiles', 'acp')
  await mkdir(acpDir, { recursive: true })
  await writeFile(join(acpDir, 'cordis.patch.yml'), '# settings smoke\n- id: acp\n  config: {}\n')
  await writeFile(join(profile, 'User', 'keybindings.json'), JSON.stringify([
    { key: 'f7', command: 'deepseekHarness.send', when: 'deepseekHarness.chatFocused' },
  ]))
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

async function retry<T>(read: () => Promise<T | undefined>, label: string, timeout = 30_000): Promise<T> {
  const until = Date.now() + timeout
  do {
    const value = await read().catch(() => undefined)
    if (value !== undefined) return value
    await delay(250)
  } while (Date.now() < until)
  throw new Error(`Timed out waiting for ${label}`)
}

async function command(page: Page, title: string) {
  const input = page.locator('.quick-input-widget input:visible')
  await retry(async () => {
    if (!await input.count()) await page.keyboard.press('F1')
    if (!await input.count()) return
    await input.fill('>' + title, { timeout: 1000 })
    const row = page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: title }).first()
    await row.click({ timeout: 1000 })
    return true
  }, title, 12_000)
}

async function harnessFrame(page: Page): Promise<Frame> {
  return retry(async () => {
    for (const frame of page.frames()) {
      if (await frame.locator('#project strong').count()) return frame
    }
  }, 'Harness webview')
}

let editor: ReturnType<typeof spawn> | undefined
let browser: Browser | undefined
try {
  await run(cli, [...cliArgs, '--install-extension', artifact, '--force'], { env, timeout: 30_000 })
  const port = await freePort()
  editor = spawn(code, [...cliArgs, '--locale=en', '--skip-welcome', '--skip-release-notes',
    `--remote-debugging-port=${port}`, workspace, filename], { env, stdio: 'ignore' })
  const url = `http://127.0.0.1:${port}`
  const ws = await retry(async () => {
    const response = await fetch(`${url}/json/version`)
    return (await response.json()).webSocketDebuggerUrl as string
  }, 'VS Code debug socket')
  const connected = browser = await chromium.connectOverCDP(ws, { timeout: 10_000 })
  const page = await retry(async () => {
    for (const candidate of connected.contexts()[0].pages()) {
      if (await candidate.locator('.monaco-workbench').count()) return candidate
    }
  }, 'editor workbench')
  page.setDefaultTimeout(12_000)
  await page.bringToFront()
  const activityTitle = contributes.viewsContainers.activitybar[0].title
  await page.locator(`.activitybar [aria-label*="${activityTitle}"]`).first().click()
  let frame = await harnessFrame(page)
  const openSettings = async () => {
    await command(page, 'Harness Settings')
    await frame.locator('#settingsPage h1').waitFor()
  }
  const settings = async (label: string) => {
    await openSettings()
    await frame.locator('#settingsPage').getByRole('button', { name: label, exact: true }).click()
  }
  const back = () => frame.locator('#settingsBack').click()
  const language = async (value: 'auto' | 'en' | 'zh-CN') => {
    await frame.locator('#uiLanguage').selectOption(value)
    await frame.getByRole('heading', { name: value === 'zh-CN' ? 'Harness 设置' : 'Harness Settings', exact: true }).waitFor()
    await retry(async () => !(await frame.locator('#uiLanguage').isDisabled())
      && await frame.locator('#uiLanguage').inputValue() === value ? true : undefined, 'language preference')
  }
  if (!real) {
    await settings('Configure keyboard shortcuts')
    await page.locator('.keybindings-editor').getByText('Send Message', { exact: false }).first().waitFor()
    await page.keyboard.press('Meta+w')
    await settings('Open ACP configuration')
    await page.locator('.tab.active').getByText('cordis.patch.yml', { exact: true }).waitFor()
    await page.keyboard.press('Meta+w')
    await settings('Diagnostics')
    await page.locator('.part.panel').getByText('Output', { exact: true }).first().waitFor()
    await page.keyboard.press('Meta+j')
    await back()
  }
  await frame.getByRole('button', { name: 'Start a conversation' }).click()
  if (!real) {
    await frame.getByText('Cannot find dsh.', { exact: false }).waitFor()
    await settings('Choose dsh executable')
    const fileInput = page.locator('.quick-input-widget input:visible')
    await retry(async () => {
      if ((await readFile(join(profile, 'User', 'settings.json'), 'utf8')).includes(fixture)) return true
      if (await fileInput.isVisible()) {
        await fileInput.fill(fixture)
        await delay(250)
        if (await fileInput.inputValue() === fixture) await fileInput.press('Enter')
      }
    }, 'selected dsh path')
    await back()
    await frame.getByRole('button', { name: 'Reconnect' }).click()
  }
  await frame.getByText('Connected', { exact: true }).waitFor()
  await frame.locator('#options select').first().waitFor()
  const session = await frame.locator('#sessions select').inputValue()
  assert.ok(session)
  if (!real) {
    const composer = frame.locator('textarea')
    const menu = frame.getByRole('listbox', { name: 'Slash commands' })
    await composer.fill('/')
    await menu.waitFor()
    await composer.press('ArrowDown')
    await composer.press('Enter')
    assert.equal(await composer.inputValue(), '/clear')
    await composer.fill('/cl')
    assert.equal(await menu.getByRole('option').count(), 1)
    await composer.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    assert.equal(await composer.inputValue(), '/cl')
    await composer.fill('/mo')
    await composer.press('Tab')
    assert.equal(await composer.inputValue(), '/model ')
    await menu.getByRole('option', { name: /Beta/ }).click()
    await composer.press('Enter')
    await retry(async () => await frame.getByLabel('Model', { exact: true }).inputValue() === 'beta' ? true : undefined, 'slash model change')
    await composer.fill('/model unavailable')
    await frame.getByRole('button', { name: 'Send', exact: true }).click()
    await frame.getByText('Choose an available value or enter its exact ID.').waitFor()
    assert.equal(await composer.inputValue(), '/model unavailable')
    await composer.fill('/settings')
    await composer.press('Meta+Enter')
    await frame.locator('#settingsPage h1').waitFor()
    await back()
    assert.equal(await composer.inputValue(), '')
    assert.equal(await frame.locator('.entry.user').count(), 0)
    console.log('Slash menu keyboard, mouse, argument validation and local dispatch passed')
  }

  await page.locator('.monaco-editor').filter({ has: page.locator('.view-line') }).first().click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.insertText('UNSAVED_HARNESS_MARKER')
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Meta+.')
  await page.getByText('Harness: Add to conversation', { exact: true }).last().click()
  frame = await harnessFrame(page)
  await frame.locator('.chip').getByText('editor-test.txt:1–1', { exact: true }).waitFor()
  assert.equal(await readFile(filename, 'utf8'), 'Saved text')
  await page.locator('.view-line').getByText('UNSAVED_HARNESS_MARKER', { exact: true }).first().click({ button: 'right' })
  await page.getByText('Ask About Selection in Harness Chat', { exact: false }).last().click()
  await retry(async () => await frame.locator('textarea').evaluate(el => el === document.activeElement) ? true : undefined, 'editor ask focuses the composer')
  assert.equal(await frame.locator('.chip').count(), 1)
  await frame.locator('textarea').fill('Draft kept across settings')
  await openSettings()
  await language('zh-CN')
  await back()
  assert.equal(await frame.getByRole('textbox', { name: '向 DeepSeek Harness 提问' }).inputValue(), 'Draft kept across settings')
  await openSettings()
  await language('en')
  await back()
  assert.equal(await frame.locator('textarea').inputValue(), 'Draft kept across settings')
  assert.equal(await frame.locator('.chip').count(), 1)

  const send = async (text: string) => {
    await frame.locator('textarea').fill(text)
    await frame.getByRole('button', { name: 'Send', exact: true }).click()
  }
  if (model) {
    const composer = frame.locator('textarea')
    await composer.fill('Repeat only the marker in the editor selection.')
    await composer.press('Shift+Enter')
    await composer.press('End')
    await page.keyboard.insertText('Do not use tools.')
    const multiline = 'Repeat only the marker in the editor selection.\nDo not use tools.'
    assert.equal(await composer.inputValue(), multiline)
    assert.equal(await frame.locator('.entry.user').count(), 0)
    await composer.dispatchEvent('compositionstart')
    await composer.press('Enter')
    await composer.dispatchEvent('compositionend')
    assert.equal(await frame.locator('.entry.user').count(), 0)
    await composer.fill(multiline)
    await composer.click()
    await composer.press('Enter')
    await frame.locator('.assistant').getByText('UNSAVED_HARNESS_MARKER', { exact: false }).first().waitFor({ timeout: 60_000 })
    await frame.getByRole('button', { name: 'Send', exact: true }).waitFor()
    assert.equal(await frame.locator('.entry.user').count(), 1)
    assert.ok((await frame.locator('.entry.user .message').innerText()).includes(multiline))

    async function selectMarker() {
      await frame.locator('.assistant .message').first().evaluate(element => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        const marker = 'UNSAVED_HARNESS_MARKER'
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const start = node.textContent?.indexOf(marker) ?? -1
          if (start < 0) continue
          const range = document.createRange()
          range.setStart(node, start)
          range.setEnd(node, start + marker.length)
          const selection = window.getSelection()!
          selection.removeAllRanges()
          selection.addRange(range)
          return
        }
        throw new Error('Marker missing in message')
      })
    }
    await composer.fill('Repeat only the quoted text.')
    await selectMarker()
    await frame.getByRole('button', { name: 'Add to conversation', exact: true }).click()
    await frame.locator('.chip').getByText('“UNSAVED_HARNESS_MARKER”', { exact: true }).waitFor()
    await selectMarker()
    await frame.getByRole('button', { name: 'Ask in side chat', exact: true }).click()
    await retry(async () => await composer.evaluate(el => el === document.activeElement) ? true : undefined, 'quote ask focuses the composer')
    assert.equal(await frame.locator('.entry.user').count(), 1)
    assert.equal(await frame.locator('.chip').count(), 1)
    assert.equal(await composer.inputValue(), 'Repeat only the quoted text.')
    await composer.press('Enter')
    await frame.locator('.entry.user .message').getByText('Quoted text from a previous assistant message:', { exact: false }).last().waitFor()
    await frame.getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 90_000 })
    assert.equal(await frame.locator('#sessions select').inputValue(), session)
    console.log('Editor quick actions and chat quote toolbar verified on the same session')
  }

  if (!real) {
    const composer = frame.locator('textarea')
    const attach = frame.getByRole('button', { name: 'Attach files', exact: true })
    const files = frame.locator('#attachments')
    const choose = async (name: string) => {
      await attach.click()
      const picker = page.locator('.quick-input-widget input:visible')
      await picker.fill(join(workspace, name))
      await retry(async () => {
        if (!await picker.isVisible()) return true
        if (await picker.inputValue() === join(workspace, name)) await picker.press('Enter')
      }, 'attached ' + name)
      await files.getByRole('button', { name, exact: true }).waitFor()
    }
    await composer.fill('draft before picking')
    await attach.click()
    await page.locator('.quick-input-widget input:visible').press('Escape')
    assert.equal(await composer.inputValue(), 'draft before picking')
    await choose('editor-test.txt')
    await choose('editor-test.txt')
    assert.equal(await files.locator('.chip').count(), 1)
    await files.getByRole('button', { name: 'Remove attachment · editor-test.txt' }).click()
    await files.locator('.chip').waitFor({ state: 'hidden' })
    await writeFile(join(workspace, 'notes.txt'), 'FILE_CONTENT_MARKER')
    await choose('notes.txt')
    await files.getByRole('button', { name: 'notes.txt', exact: true }).click()
    await page.locator('.tab.active').getByText('notes.txt', { exact: true }).waitFor()
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64')
    await composer.fill('Keep my draft')
    await composer.evaluate((input, data) => {
      const clipboard = new DataTransfer()
      clipboard.items.add(new File([Uint8Array.from(atob(data), c => c.charCodeAt(0))], 'image.png', { type: 'image/png' }))
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
    }, image.toString('base64'))
    await files.getByRole('button', { name: /^clipboard-.*\.png$/ }).waitFor()
    assert.equal(await composer.inputValue(), 'Keep my draft')
    const defaultPaste = await composer.evaluate(input => {
      const clipboard = new DataTransfer()
      clipboard.setData('text/plain', 'ordinary text')
      return input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
    })
    assert.ok(defaultPaste, 'ordinary text stays with the native paste handler')
    await writeFile(join(workspace, 'pixel.png'), image)
    await choose('pixel.png')
    assert.equal(await files.getByText('Inline image', { exact: false }).count(), 2)
    const pdf = join(workspace, 'sample.pdf')
    await writeFile(pdf, '%PDF-1.4\n')
    await choose('sample.pdf')
    await files.getByText('Local file link', { exact: false }).waitFor()
    await rm(pdf)
    await composer.fill('')
    await frame.getByRole('button', { name: 'Send', exact: true }).click()
    await frame.locator('#feedback').getByText(/Could not read the file.*sample.pdf/).waitFor()
    assert.equal(await files.locator('.chip').count(), 4)
    await writeFile(pdf, '%PDF-1.4\n')
    await frame.getByRole('button', { name: 'Send', exact: true }).click()
    const response = frame.locator('.assistant').last()
    await response.getByText('FILE_CONTENT_MARKER', { exact: false }).first().waitFor()
    assert.equal((await response.innerText()).split(`image image/png ${image.length} bytes`).length - 1, 2)
    assert.ok((await response.innerText()).includes('linked sample.pdf file:'))
    await files.locator('.chip').first().waitFor({ state: 'hidden' })
    assert.equal((await frame.locator('.entry.user').last().innerText()).includes('FILE_CONTENT_MARKER'), false)
    console.log('Picked, previewed, removed and sent files without a message, including recovery from a missing link')
  }

  if (approvals) {
    for (const choice of ['Reject', 'Allow once']) {
      const rejected = choice === 'Reject'
      const name = rejected ? 'acp-rejected.txt' : 'acp-allowed.txt'
      const file = join(workspace, name)
      await send(`Use the bash tool to run exactly: printf %s ACP_APPROVAL_OK > "$PWD/${name}". `
        + 'First try without sandbox_permissions. If that write is denied, retry the exact same command once '
        + 'with sandbox_permissions set to workspace-write and a one-sentence justification. '
        + 'If permission is rejected, do not try any other tools or retry. Report the result and stop.')
      const request = frame.locator('.approval').filter({ hasText: 'Permission required' })
      const decision = request.getByRole('button', { name: choice, exact: true })
      await decision.waitFor({ timeout: 75_000 })
      await assert.rejects(access(file), { code: 'ENOENT' })
      const tool = frame.locator('article.tool').filter({ has: request })
      await tool.locator('summary').click()
      await tool.getByText(name, { exact: false }).first().waitFor()
      await decision.click()
      await frame.getByRole('button', { name: 'Send', exact: true }).waitFor({ timeout: 60_000 })
      await request.waitFor({ state: 'hidden' })
      if (rejected) await assert.rejects(access(file), { code: 'ENOENT' })
      else assert.equal(await readFile(file, 'utf8'), 'ACP_APPROVAL_OK')
      console.log(rejected ? 'Real tool approval: Reject left the file absent' : 'Real tool approval: Allow once wrote the expected bytes')
    }
  }

  if (!real) {
    await frame.locator('textarea').fill('simulate auth failure')
    await frame.locator('textarea').click()
    await frame.locator('textarea').press('F7')
    await frame.getByRole('button', { name: 'Open ACP configuration' }).click()
    await page.locator('.tab.active').getByText('cordis.patch.yml', { exact: true }).waitFor()
    await page.keyboard.press('Meta+w')
    console.log('Installed settings gear, dsh picker, configuration, diagnostics, shortcut editor and rebound send verified')
    async function clickAcrossChunk(button: Locator, thought: Locator) {
      await thought.waitFor({ state: 'attached' })
      await button.scrollIntoViewIfNeeded()
      const box = await button.boundingBox()
      assert.ok(box)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      const text = await thought.textContent()
      await retry(async () => (await thought.textContent()) !== text ? true : undefined, 'stream update while button is pressed')
      await page.mouse.up()
    }
    const thoughts = frame.locator('.entry.thought .message')
    for (const [choice, result] of [['Allow once', 'allow-once'], ['Reject', 'reject-once']]) {
      const nextThought = thoughts.nth(await thoughts.count())
      await send('request permission')
      await clickAcrossChunk(frame.getByRole('button', { name: choice, exact: true }), nextThought)
      const tool = frame.locator('article.tool').last()
      await tool.locator('summary', { hasText: 'Fixture tool · Completed' }).waitFor()
      await tool.locator('summary').click()
      await tool.getByText(result, { exact: true }).waitFor()
    }
    const nextThought = thoughts.nth(await thoughts.count())
    await send('wait for cancellation')
    await frame.getByText('Waiting for cancellation', { exact: true }).waitFor()
    await clickAcrossChunk(frame.getByRole('button', { name: 'Stop', exact: true }), nextThought)
    await frame.getByText('Stopped.', { exact: true }).waitFor()
    await send('wait for cancellation')
    await frame.getByRole('button', { name: 'Stop', exact: true }).waitFor()
    await frame.locator('textarea').click()
    await frame.locator('textarea').press('Escape')
    await frame.getByRole('button', { name: 'Send', exact: true }).waitFor()
    await send('ignore cancellation')
    await frame.getByRole('button', { name: 'Stop', exact: true }).click()
    await frame.getByText('Harness did not stop in time.', { exact: false }).waitFor({ timeout: 20_000 })
    await frame.getByRole('button', { name: 'Reconnect', exact: true }).click()
    await frame.getByText('Connected', { exact: true }).waitFor()
  }

  const baseline = frame.getByLabel('Model', { exact: true })
  const originalModel = await baseline.inputValue()
  const alternate = real && model ? await baseline.evaluate((element: HTMLSelectElement) => {
    const current = element.selectedOptions[0]
    const group = current.parentElement
    if (!(group instanceof HTMLOptGroupElement)) throw new Error('Expected provider groups from Harness')
    const other = Array.from(group.querySelectorAll('option')).find(item => item.value !== current.value)
    if (!other) throw new Error('A second model from the selected provider is required for this test')
    return { provider: group.label, name: other.text, value: other.value }
  }) : undefined
  const saveDefault = async () => {
    await frame.getByRole('button', { name: 'Save default' }).click()
    await frame.locator('#settingsStatus').getByText('Default saved for new conversations.').waitFor()
    await back()
  }
  if (alternate) {
    await openSettings()
    await frame.locator('#defaultProvider').selectOption({ label: alternate.provider })
    await frame.locator('#defaultModel').selectOption({ label: alternate.name })
    await language('zh-CN')
    assert.equal(await frame.locator('#defaultModel').inputValue(), alternate.value)
    if (process.env.DSH_SETTINGS_PREVIEW) await frame.locator('#settingsPage').screenshot({ path: process.env.DSH_SETTINGS_PREVIEW })
    await language('en')
    await saveDefault()
    assert.equal(await baseline.inputValue(), originalModel)
  }

  await openSettings()
  await language('zh-CN')
  const toggle = frame.getByRole('checkbox', { name: '按 Enter 发送消息' })
  assert.ok(await toggle.isChecked())
  assert.match(await frame.locator('.newlineHint').innerText(), /Shift\s*\+\s*Enter/)
  await toggle.uncheck()
  await retry(async () => (await readFile(join(profile, 'User', 'settings.json'), 'utf8')).match(/"deepseekHarness\.enterToSend"\s*:\s*false/) ? true : undefined, 'persisted Enter setting')
  await back()
  await Promise.all([
    page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame(), timeout: 20_000 }),
    command(page, 'Developer: Reload Window'),
  ])
  const reloaded = await retry(async () => {
    for (const candidate of connected.contexts()[0].pages()) {
      if (await candidate.locator('.monaco-workbench').count()) return candidate
    }
  }, 'reloaded workbench')
  frame = await harnessFrame(reloaded)
  await frame.getByText('已连接', { exact: true }).waitFor()
  await openSettings()
  assert.equal(await frame.locator('#uiLanguage').inputValue(), 'zh-CN')
  assert.equal(await frame.locator('#enterToSend').isChecked(), false)
  await language('auto')
  await back()
  await frame.getByText('Connected', { exact: true }).waitFor()
  if (model) await frame.locator('.assistant').getByText('UNSAVED_HARNESS_MARKER', { exact: false }).first().waitFor()
  assert.equal(await frame.locator('#sessions select').inputValue(), session)
  if (model) {
    const composer = frame.locator('textarea')
    const text = real ? 'Reply with the single word RESUMED.' : 'Resumed after reload'
    await composer.click()
    await composer.fill(text)
    await composer.press('Enter')
    assert.equal(await composer.inputValue(), text + '\n')
    await composer.press('Meta+Enter')
    await frame.locator('.assistant').last().getByText(real ? 'RESUMED' : 'Resumed after reload', { exact: false }).first().waitFor({ timeout: 60_000 })
  }
  if (alternate) {
    const selected = frame.getByLabel('Model', { exact: true })
    assert.equal(await selected.inputValue(), originalModel)
    async function openNew(previous: string, expectedModel: string) {
      await frame.getByRole('button', { name: 'New conversation', exact: true }).click()
      return retry(async () => {
        const id = await frame.locator('#sessions select').inputValue()
        return id && id !== previous && await selected.inputValue() === expectedModel ? id : undefined
      }, 'new conversation with expected model')
    }
    const customSession = await openNew(session, alternate.value)
    await send('Reply with exactly DEFAULT_OK and do not use tools.')
    await frame.locator('.assistant').getByText('DEFAULT_OK', { exact: false }).first().waitFor({ timeout: 90_000 })
    await frame.getByRole('button', { name: 'Send', exact: true }).waitFor()
    await openSettings()
    await frame.locator('#defaultProvider').selectOption({ label: 'Follow ACP configuration' })
    await saveDefault()
    assert.equal(await selected.inputValue(), alternate.value)
    await openNew(customSession, originalModel)
    await frame.locator('#sessions select').selectOption(customSession)
    await retry(async () => await selected.inputValue() === alternate.value ? true : undefined, 'resumed custom model')
    await frame.locator('.assistant').getByText('DEFAULT_OK', { exact: false }).first().waitFor()
    console.log('Real Harness: saved default survived reload, new model answered, following ACP restored the profile default, and resumed session kept its own model:', alternate.provider, '/', alternate.name)
  }
  if (!real) {
    await send('simulate auth failure')
    await frame.getByRole('button', { name: 'Reconnect and start a new conversation' }).click()
    await retry(async () => {
      const id = await frame.locator('#sessions select').inputValue()
      return id && id !== session ? true : undefined
    }, 'a new session after restarting the ACP profile')
    const selector = frame.locator('#sessions select')
    const retired = await selector.inputValue()
    const database = join(workspace, '.acp-fixture-sessions.json')
    const sessions: { sessionId: string }[] = JSON.parse(await readFile(database, 'utf8'))
    await writeFile(database, JSON.stringify(sessions.filter(item => item.sessionId !== retired)))
    await send('exit fixture')
    const reconnect = frame.getByRole('button', { name: 'Reconnect', exact: true })
    await reconnect.waitFor()
    const composer = frame.locator('textarea')
    await composer.fill('Keep this draft after an unavailable session')
    await reconnect.click()
    await frame.getByText('The previous Harness conversation is unavailable.', { exact: false }).waitFor()
    assert.equal(await selector.inputValue(), '')
    assert.equal(await composer.inputValue(), 'Keep this draft after an unavailable session')
    await frame.getByRole('button', { name: 'Send', exact: true }).click()
    await frame.locator('.assistant').getByText('Keep this draft after an unavailable session').waitFor()
    await settings('Use automatic discovery')
    await retry(async () => !(await readFile(join(profile, 'User', 'settings.json'), 'utf8')).includes(fixture) ? true : undefined, 'automatic dsh discovery')
  }
  console.log(real ? `Installed VSIX: real Harness session startup and reload passed${model ? ', including a model turn' : ''}`
    : 'Installed VSIX: executable discovery recovery, selection, model option, allow/reject, cancel and session reload passed')
} finally {
  if (editor && editor.exitCode === null) {
    const exited = new Promise(resolve => editor?.once('exit', resolve))
    editor.kill('SIGTERM')
    await Promise.race([exited, delay(4000)])
    if (editor.exitCode === null && editor.signalCode === null) editor.kill('SIGKILL')
  }
  await Promise.race([browser?.close().catch(() => {}), delay(2000)])
  await rm(root, { force: true, recursive: true })
}
