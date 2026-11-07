/**
 * Bash executor that runs each command where the task actually lives.
 *
 * A Terminal-Bench or SWE-bench trial hands its work to this harness, but the
 * task's files are in a container this process never touches. Running `bash`
 * here would answer about the harness's own filesystem, so every command is
 * sent to the service that owns that container and its real output comes
 * back.
 *
 * The request carries the agent id because one harness process serves many
 * concurrent cases: without it the service cannot tell which environment a
 * command belongs to.
 *
 * Only foreground commands are served. A background command needs a process
 * handle this executor cannot vouch for, and answering one with a finished
 * result would report work that is still running.
 *
 * @module @deepseek-ai/dsh-bash-remote
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type {
  CollectedOutput,
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellProcess,
  ShellProcessRead,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell'
import { clampTimeout, deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

/** Validated plugin configuration. */
export interface Config {
  /** The benchmark service that owns the task environments. */
  endpoint: string
  /** Bearer credential for that service, when it requires one. */
  token?: string
  /** Default command timeout in milliseconds. */
  timeoutMs: number
  /** Upper bound for a caller's own timeout. */
  maxTimeoutMs: number
  /** Default working directory, when the caller names none. */
  cwd?: string
}

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_TIMEOUT_MS = 3_600_000

function emptyOutput(): CollectedOutput {
  return { text: '', truncated: false }
}

function output(text: string, maxBytes: number): CollectedOutput {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) return { text, truncated: false }
  // Cut on a character boundary so the model never sees a half-encoded glyph.
  return { text: Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8'), truncated: true }
}

/** One finished remote command, presented as the handle the seam requires. */
function settledExecution(
  result: ShellRunResult,
): ShellExecution {
  const proc: ShellExecution = {
    status: 'completed',
    exitCode: result.exitCode,
    signal: null,
    done: Promise.resolve(),
    readOutput: (): ShellProcessRead => ({ delta: '', lossy: false }),
    observed: {
      stdout: { readFrom: (from: number) => ({ text: '', nextOffset: from, lossy: false }) },
      stderr: { readFrom: (from: number) => ({ text: '', nextOffset: from, lossy: false }) },
    },
    kill: (): boolean => false,
    result: async () => result,
  }
  return proc
}

/** What the service answers for one command. */
interface RemoteAnswer {
  stdout?: unknown
  stderr?: unknown
  return_code?: unknown
  refused?: unknown
}

export class RemoteBashExecutor extends ShellExecutor {
  static Config = z.object({
    endpoint: z.string().required(),
    token: z.string(),
    timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
    maxTimeoutMs: z.number().default(DEFAULT_MAX_TIMEOUT_MS),
    cwd: z.string(),
  })

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      ...request.agentId === undefined ? {} : { agentId: request.agentId },
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
      timeoutMs: clampTimeout(
        request.timeoutMs,
        this.config.timeoutMs,
        this.config.maxTimeoutMs,
        'bash-remote: request.timeoutMs',
      ),
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...request.signal ? { signal: request.signal } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    if (spec.onExpiry === 'none') {
      // A background command needs a handle this executor cannot produce.
      throw new Error(
        'bash-remote: background commands are not served; run this command in the foreground',
      )
    }
    const agentId = spec.agentId
    if (agentId === undefined) {
      throw new Error(
        'bash-remote: the request names no agent, so the service cannot tell which '
        + 'task environment this command belongs to',
      )
    }

    const d = deadline(spec.signal, spec.timeoutMs, 'BASH_TIMEOUT')
    try {
      const answer = await this._post(agentId, spec, d.signal)
      const timedOut = timeoutOf(d.signal, 'BASH_TIMEOUT') !== undefined
      return settledExecution({
        exitCode: timedOut ? null : this._returnCode(answer),
        signal: null,
        timedOut,
        aborted: d.signal.aborted && !timedOut,
        timeoutMs: spec.timeoutMs,
        stdout: timedOut ? emptyOutput() : output(this._text(answer.stdout), spec.stdoutMaxBytes),
        stderr: timedOut ? emptyOutput() : output(this._text(answer.stderr), spec.stdoutMaxBytes),
      })
    } finally {
      d[Symbol.dispose]()
    }
  }

  private _returnCode(answer: RemoteAnswer): number | null {
    const code = answer.return_code
    return typeof code === 'number' && Number.isFinite(code) ? code : null
  }

  private _text(value: unknown): string {
    return typeof value === 'string' ? value : ''
  }

  /** Send one command to the service and wait for its answer. */
  private async _post(
    agentId: string, spec: ShellExecSpec, signal: AbortSignal,
  ): Promise<RemoteAnswer> {
    const endpoint = this.config.endpoint.replace(/\/$/, '')
    const response = await fetch(`${endpoint}/jobs/by-session/${encodeURIComponent(agentId)}/exec`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.config.token === undefined ? {} : { Authorization: `Bearer ${this.config.token}` },
      },
      body: JSON.stringify({
        command: spec.command,
        workdir: spec.workdir,
        timeout_sec: Math.ceil(spec.timeoutMs / 1000),
      }),
      signal,
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(
        `bash-remote: the task service answered ${response.status}: ${detail.slice(0, 500)}`,
      )
    }
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) {
      throw new Error('bash-remote: the task service answered a non-object body')
    }
    return body as RemoteAnswer
  }
}

export default RemoteBashExecutor

export type { ShellProcess }
