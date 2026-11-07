import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { RemoteSubprocessRuntime } from '../src/index.ts'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/**
 * `glob` and `grep` run `ripgrep` through the subprocess seam rather than a
 * filesystem provider, so they need this runtime to reach the task container.
 * These tests run real commands through a real HTTP server, which is the same
 * path the container takes.
 */
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
})

async function service(): Promise<{ endpoint: string; seen: Array<{ url: string; command: string }> }> {
  const seen: Array<{ url: string; command: string }> = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { command?: string }
      seen.push({ url: request.url ?? '', command: body.command ?? '' })
      let stdout = ''
      let returnCode = 0
      try {
        stdout = execFileSync('sh', ['-c', body.command ?? ''], { encoding: 'utf8' })
      } catch (error) {
        const failure = error as { stdout?: string; status?: number }
        stdout = failure.stdout ?? ''
        returnCode = failure.status ?? 1
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ stdout, stderr: '', return_code: returnCode }))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { endpoint: `http://127.0.0.1:${address.port}`, seen }
}

async function runtimeFor(endpoint: string): Promise<RemoteSubprocessRuntime> {
  const ctx = new Context()
  await ctx.plugin(RemoteSubprocessRuntime, { endpoint, timeoutSec: 30 })
  return ctx.subprocess as RemoteSubprocessRuntime
}

function spec(overrides: Partial<SubprocessSpawnSpec> = {}): SubprocessSpawnSpec {
  return {
    argv: ['echo', 'hello from the task'],
    cwd: '/tmp',
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
    graceMs: 1000,
    agentId: 'case-7',
    ...overrides,
  } as SubprocessSpawnSpec
}

describe('remote subprocess runtime', () => {
  it('runs a command in the environment the service owns', async () => {
    const { endpoint, seen } = await service()
    const runtime = await runtimeFor(endpoint)

    const handle = runtime.spawn(spec())
    const outcome = await handle.done

    expect(outcome.exitCode).toBe(0)
    expect(handle.collected.stdout?.readFrom(0).text).toBe('hello from the task\n')
    // The service routes by the agent's session, as the other channels do.
    expect(seen[0]?.url).toBe('/jobs/by-session/case-7/exec')
  })

  it('quotes arguments so the container runs them unchanged', async () => {
    const { endpoint } = await service()
    const runtime = await runtimeFor(endpoint)
    const tricky = "it's a $(dangerous) value"

    const handle = runtime.spawn(spec({
      argv: ['printf', '%s', tricky],
      stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
    } as Partial<SubprocessSpawnSpec>))
    await handle.done

    // The value survives the shell intact: it is printed, not executed.
    expect(handle.collected.stdout?.readFrom(0).text).toBe(tricky)
  })

  it('runs in the working directory the spec names', async () => {
    const { endpoint } = await service()
    const runtime = await runtimeFor(endpoint)

    const handle = runtime.spawn(spec({ argv: ['pwd'], cwd: '/tmp' }))
    await handle.done

    expect(handle.collected.stdout?.readFrom(0).text.trim()).toBe('/tmp')
  })

  it('keeps a non-zero exit as the command outcome', async () => {
    const { endpoint } = await service()
    const runtime = await runtimeFor(endpoint)

    const handle = runtime.spawn(spec({ argv: ['sh', '-c', 'exit 3'] }))
    const outcome = await handle.done

    expect(outcome.exitCode).toBe(3)
  })

  it('refuses a spec that names no agent instead of guessing a container', async () => {
    const { endpoint, seen } = await service()
    const runtime = await runtimeFor(endpoint)

    const handle = runtime.spawn(spec({ agentId: undefined }))

    await expect(handle.done).rejects.toThrow(/names no agent/)
    expect(seen).toEqual([])
  })

  it('reports the shell the task container has, but no terminal to allocate', async () => {
    const { endpoint } = await service()
    const runtime = await runtimeFor(endpoint)

    // Shell-selection facts are answerable; a terminal is not, and saying so
    // is better than handing back a handle that could never carry input.
    expect(await runtime.terminalEnvironment()).toMatchObject({ platform: 'posix' })
    await expect(runtime.spawnTerminal()).rejects.toThrow(/terminal/)
  })
})
