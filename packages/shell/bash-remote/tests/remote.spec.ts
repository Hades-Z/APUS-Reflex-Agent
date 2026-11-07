import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { RemoteBashExecutor } from '../src/index.ts'

/**
 * The task environment is not in this process: a benchmark service owns it
 * and runs commands there. These tests pin the wire contract — which command
 * is sent, where, and how the real output comes back — against a real HTTP
 * server rather than a stubbed client, because the endpoint and the request
 * are what the other side must agree with.
 */
interface Received {
  path: string
  authorization: string | undefined
  body: Record<string, unknown>
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
})

async function service(answer: (received: Received) => { status: number; body: unknown }): Promise<{ endpoint: string; seen: Received[] }> {
  const seen: Received[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const received: Received = {
        path: request.url ?? '',
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      }
      seen.push(received)
      const { status, body } = answer(received)
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(body))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { endpoint: `http://127.0.0.1:${address.port}`, seen }
}

async function executorFor(endpoint: string, token?: string): Promise<RemoteBashExecutor> {
  const ctx = new Context()
  await ctx.plugin(RemoteBashExecutor, {
    endpoint,
    ...token === undefined ? {} : { token },
    timeoutMs: 5_000,
    maxTimeoutMs: 10_000,
  })
  return ctx.shell as RemoteBashExecutor
}

describe('remote bash executor', () => {
  it('runs the command in the environment the service owns', async () => {
    const { endpoint, seen } = await service(() => ({
      status: 200,
      body: { stdout: 'task-file.txt\n', stderr: '', return_code: 0 },
    }))
    const executor = await executorFor(endpoint)

    const result = await (await executor.execute(executor.resolve({
      command: 'ls', agentId: 'case-7', workdir: '/app',
    }))).result()

    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('task-file.txt\n')
    // The service routes by the agent's session, and gets the command verbatim.
    expect(seen[0]?.path).toBe('/jobs/by-session/case-7/exec')
    expect(seen[0]?.body).toMatchObject({ command: 'ls', workdir: '/app' })
  })

  it('sends the credential the service requires', async () => {
    const { endpoint, seen } = await service(() => ({ status: 200, body: { stdout: '', return_code: 0 } }))
    const executor = await executorFor(endpoint, 'service-token')

    await (await executor.execute(executor.resolve({ command: 'ls', agentId: 'case-1' }))).result()

    expect(seen[0]?.authorization).toBe('Bearer service-token')
  })

  it('refuses a request that names no agent instead of guessing an environment', async () => {
    const { endpoint, seen } = await service(() => ({ status: 200, body: { stdout: '', return_code: 0 } }))
    const executor = await executorFor(endpoint)

    await expect(executor.execute(executor.resolve({ command: 'ls' }))).rejects.toThrow(/names no agent/)

    // Nothing was sent: a wrong environment would run against the wrong task.
    expect(seen).toEqual([])
  })

  it('surfaces a service failure instead of reporting success', async () => {
    const { endpoint } = await service(() => ({ status: 503, body: { error: 'channel gone' } }))
    const executor = await executorFor(endpoint)

    await expect(
      executor.execute(executor.resolve({ command: 'ls', agentId: 'case-1' })),
    ).rejects.toThrow(/503/)
  })

  it('keeps a non-zero exit code as the command outcome', async () => {
    const { endpoint } = await service(() => ({
      status: 200,
      body: { stdout: '', stderr: 'no such file', return_code: 2 },
    }))
    const executor = await executorFor(endpoint)

    const result = await (await executor.execute(executor.resolve({
      command: 'cat missing', agentId: 'case-1',
    }))).result()

    expect(result.exitCode).toBe(2)
    expect(result.stderr.text).toBe('no such file')
  })
})
