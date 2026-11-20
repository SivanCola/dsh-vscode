import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import {
  client as createAcpClientApp, methods, ndJsonStream, PROTOCOL_VERSION,
  type PromptRequest, type RequestPermissionRequest, type RequestPermissionResponse, type SessionNotification,
} from '@agentclientprotocol/sdk'

import { name as clientName, version as clientVersion } from '../package.json'

export class ConnectionError extends Error {
  constructor(readonly kind: 'executable' | 'spawn' | 'protocol' | 'exit' | 'timeout', message: string) {
    super(message)
  }
}

export async function findExecutable(configured: string): Promise<string> {
  const names = process.platform === 'win32' ? ['dsh.exe'] : ['dsh']
  if (configured && !isAbsolute(configured)) throw new ConnectionError('executable', 'Expected an absolute executable path')
  const directories = (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
  if (process.platform === 'darwin') directories.push('/usr/local/bin', '/opt/homebrew/bin')
  const candidates = configured ? [configured] : directories.flatMap(dir => names.map(name => join(dir, name)))
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // Try the next executable location.
    }
  }
  throw new ConnectionError('executable', 'dsh is not executable')
}

export function startAcp(
  command: string, cwd: string,
  callbacks: {
    update(params: SessionNotification): void
    permission(params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse>
    disconnected(error: ConnectionError): void
  },
  { args = ['--profile', 'acp'], env = process.env } = {},
) {
  const child = spawn(command, args, { cwd, env, stdio: 'pipe', windowsHide: true })
  child.stderr.resume()
  // Protocol disconnect handles pending RPCs. Pipe failures can also emit Node errors.
  child.stdin.on('error', () => {})
  child.stdout.on('error', () => {})
  let disposed = false
  const app = createAcpClientApp({ name: clientName })
    .onNotification(methods.client.session.update, ({ params }) => {
      if (!disposed) callbacks.update(params)
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params, signal }) => callbacks.permission(params, signal))
  const connection = app.connect(ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  ))
  const agent = connection.agent
  const disconnected = (error: ConnectionError) => {
    if (!disposed) {
      disposed = true
      void stopProcess(child)
      callbacks.disconnected(error)
    }
  }
  child.once('error', error => disconnected(new ConnectionError('spawn', (error as NodeJS.ErrnoException).code ?? 'Spawn failed')))
  child.once('close', (code, signal) => disconnected(new ConnectionError('exit', `dsh exited (${code ?? signal ?? 'unknown'})`)))
  void connection.closed.then(() => {
    disconnected(new ConnectionError('exit', 'ACP connection closed'))
  }, () => disconnected(new ConnectionError('protocol', 'ACP transport failed')))

  async function bounded<T>(operation: Promise<T>, ms = 20_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new ConnectionError('timeout', 'ACP request timed out')
        reject(error)
        disconnected(error)
        connection.close(error)
      }, ms)
    })
    try { return await Promise.race([operation, timeout]) } finally { clearTimeout(timer) }
  }

  return {
    async initialize() {
      const response = await bounded(agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
        clientInfo: { name: clientName, version: clientVersion },
      }))
      if (response.protocolVersion !== 1) throw new ConnectionError('protocol', `ACP v${response.protocolVersion}`)
      return response.agentCapabilities ?? {}
    },
    async create(directory: string) {
      return bounded(agent.request(methods.agent.session.new, { cwd: await realpath(directory), mcpServers: [] }))
    },
    async resume(directory: string, sessionId: string) {
      return bounded(agent.request(methods.agent.session.resume, { cwd: await realpath(directory), mcpServers: [], sessionId }))
    },
    async list(directory: string, cursor?: string) {
      return bounded(agent.request(methods.agent.session.list, { cwd: await realpath(directory), cursor }))
    },
    close(sessionId: string, timeout = 8_000) {
      return bounded(agent.request(methods.agent.session.close, { sessionId }), timeout)
    },
    prompt(sessionId: string, blocks: (string | PromptRequest['prompt'][number])[]) {
      const prompt: PromptRequest['prompt'] = blocks.map(block => typeof block === 'string' ? { type: 'text', text: block } : block)
      return agent.request(methods.agent.session.prompt, { sessionId, prompt })
    },
    cancel(sessionId: string) {
      return agent.notify(methods.agent.session.cancel, { sessionId })
    },
    configure(sessionId: string, configId: string, value: string) {
      return bounded(agent.request(methods.agent.session.setConfigOption, { sessionId, configId, value }))
    },
    async dispose() {
      disposed = true
      await stopProcess(child)
    },
  }
}

async function stopProcess(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
  const wait = (ms: number) => new Promise<void>(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref()
    void closed.then(() => { clearTimeout(timer); resolve() })
  })
  child.stdin.end()
  await wait(1800)
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await wait(1700)
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await wait(700)
}

export type AcpConnection = ReturnType<typeof startAcp>
export type AcpCapabilities = Awaited<ReturnType<AcpConnection['initialize']>>
