import * as vscode from 'vscode'
import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { findExecutable } from './acp'
import { uiStrings as s } from './strings'

export const preferenceKey = 'newSessionModel'
export const catalogKey = 'lastModelCatalog'

const config = () => vscode.workspace.getConfiguration('deepseekHarness')
const configuredPath = () => config().get('executablePath', '').trim()

export async function chooseExecutable(reset = false) {
  let path: string | undefined
  if (!reset) {
    const files = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false, canSelectFiles: true, openLabel: s.browse })
    if (!files?.length) return false
    path = await findExecutable(files[0].fsPath)
  }
  await config().update('executablePath', path, vscode.ConfigurationTarget.Global)
  return true
}

export async function openAcpConfig(cwd: string) {
  const override = process.env.DSH_HOME
  const home = override?.trim() ? override.replace(/^~(?=$|[\\/])/, () => homedir()) : join(homedir(), '.dsh')
  const path = resolve(cwd, home, 'profiles', 'acp', 'cordis.patch.yml')
  try {
    try { await access(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // Let the launcher initialize the complete built-in profile on first use.
      await promisify(execFile)(await findExecutable(configuredPath()), ['--profile', 'acp', '--dump-default-config'],
        { cwd, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 })
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path))
    const index = doc.getText().search(/^[ \t]*-[ \t]+id:[ \t]*['"]?acp['"]?[ \t]*(?:#.*)?\r?$/m)
    const position = doc.positionAt(Math.max(0, index))
    await vscode.window.showTextDocument(doc, { preview: false, selection: new vscode.Range(position, position) })
  } catch {
    void vscode.window.showErrorMessage(`${s.configError} (${path})`)
  }
}

export async function executableSetting() {
  const path = configuredPath()
  let executable: string
  try { executable = await findExecutable(path) } catch { executable = path || s.missing }
  return { executable, configured: Boolean(path) }
}
