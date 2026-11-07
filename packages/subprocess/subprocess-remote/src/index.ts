/**
 * Subprocess runtime that runs each command in the task container a benchmark
 * owns.
 *
 * Some tools — `glob` and `grep` among them — are spawn-backed rather than
 * filesystem-provider methods: they run `ripgrep` through this seam. With a
 * local runtime those searches answer about the harness's own filesystem, so
 * a path the task provides reports "no such directory" while the task is
 * waiting for the answer.
 *
 * Every spawn is one command with a complete answer, so the handle this
 * runtime returns is already settled: there is no live process here, and
 * pretending otherwise would let a caller wait for output that will never
 * grow.
 *
 * @module @deepseek-ai/dsh-subprocess-remote
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
} from '@deepseek-ai/dsh-subprocess'

/** Validated plugin configuration. */
export interface Config {
  /** The benchmark service that owns the task containers. */
  endpoint: string
  /** Bearer credential for that service, when it requires one. */
  token?: string
  /** Per-command budget in seconds. */
  timeoutSec: number
}

export class RemoteSubprocessRuntime extends SubprocessRuntime {
  static Config = z.object({
    endpoint: z.string().required(),
    token: z.string(),
    timeoutSec: z.number().default(600),
  })

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
  }

  override async resolveExecutable(
    command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal,
  ): Promise<string> {
    // The executable is resolved where it runs, so it is reported as named;
    // the container's own PATH decides what that means there.
    void env
    void signal
    return command
  }

  override terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    // The task container is Linux with a POSIX shell; a caller that needs a
    // terminal is refused separately by spawnTerminal.
    void signal
    return Promise.resolve({ platform: 'posix', shell: '/bin/sh' })
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const collects = [spec.stdio.stdout, spec.stdio.stderr] as Array<
      SubprocessCollect | 'ignore' | 'inherit' | { data: string } | undefined
    >
    const wantsStdout = typeof collects[0] === 'object' && collects[0] !== null && 'maxBytes' in collects[0]
    const wantsStderr = typeof collects[1] === 'object' && collects[1] !== null && 'maxBytes' in collects[1]
    const collected = wantsStdout || wantsStderr
    const stdin = spec.stdio.stdin

    // The command is what the spec's argv would have run, in the same working
    // directory, with stdin piped through when the caller provided it.
    const command = buildCommand(spec.argv, {
      cwd: spec.cwd,
      ...typeof stdin === 'object' && stdin !== null && 'data' in stdin
        ? { stdin: stdin.data }
        : {},
    })

    const execution = this._run(command, spec.agentId)
    let settled: { outcome: SubprocessOutcome; stdout: string; stderr: string } | undefined

    const handle: SubprocessHandle = {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: {},
      done: execution.then((result) => {
        settled = result
        return result.outcome
      }),
      terminate: () => {},
      waitForExit: () => execution.then(() => true),
    }

    if (collected) {
      // The readers are created once the command answers, so a consumer that
      // reads after `done` sees the real streams rather than an empty tail.
      const reader = (stream: 'stdout' | 'stderr'): SubprocessOutputReader => ({
        readFrom(fromByte: number) {
          const text = settled === undefined ? '' : settled[stream]
          const start = Math.max(0, Math.min(fromByte, text.length))
          return { text: text.slice(start), nextOffset: text.length, lossy: false }
        },
      })
      Object.assign(handle, {
        collected: {
          ...wantsStdout ? { stdout: reader('stdout') } : {},
          ...wantsStderr ? { stderr: reader('stderr') } : {},
        },
      })
    }
    return handle
  }

  override spawnTerminal(): Promise<never> {
    return Promise.reject(
      new Error('the task container does not expose a terminal through this runtime'),
    )
  }

  /** Run one command in the task container. */
  private async _run(
    command: string, agentId: string | undefined,
  ): Promise<{ outcome: SubprocessOutcome; stdout: string; stderr: string }> {
    if (agentId === undefined || !agentId) {
      throw new Error(
        'dsh-subprocess-remote: the spec names no agent, so the service cannot '
        + 'tell which task container this command belongs to',
      )
    }
    const service = this.config.endpoint.replace(/\/$/, '')
    const response = await fetch(
      `${service}/jobs/by-session/${encodeURIComponent(agentId)}/exec`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.config.token === undefined ? {} : { Authorization: `Bearer ${this.config.token}` },
        },
        body: JSON.stringify({ command, timeout_sec: this.config.timeoutSec }),
      },
    )
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`the task service answered ${response.status}: ${detail.slice(0, 500)}`)
    }
    const body = (await response.json()) as { stdout?: unknown; stderr?: unknown; return_code?: unknown }
    return {
      outcome: {
        exitCode: typeof body.return_code === 'number' ? body.return_code : null,
        signal: null,
      },
      stdout: typeof body.stdout === 'string' ? body.stdout : '',
      stderr: typeof body.stderr === 'string' ? body.stderr : '',
    }
  }
}

/** Compose a shell command line from a spawn spec. */
function buildCommand(
  argv: readonly string[], options: { cwd: string; stdin?: string },
): string {
  if (argv.length === 0) throw new Error('dsh-subprocess-remote: spawn requires an executable')
  const quoted = argv.map(shellQuote).join(' ')
  const cd = `cd ${shellQuote(options.cwd)} && `
  const feed = options.stdin === undefined
    ? ''
    : `printf %s ${shellQuote(options.stdin)} | `
  return `${cd}${feed}${quoted}`
}

/** Quote one argument so the container's shell passes it through unchanged. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, '\'\\\'\'')}'`
}

export default RemoteSubprocessRuntime
