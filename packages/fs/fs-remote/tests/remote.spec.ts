import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { RemoteFileSystem } from '../src/index.ts'

/**
 * The files the harness asks about live in the task container, not here. These
 * tests run the real probe program against a real directory — the same program
 * the container runs — and serve it over real HTTP, so what is verified is the
 * protocol and the program rather than a stand-in for either.
 */
const servers: Server[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => resolve())
  })))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Run the probe the way the container does, in a real working directory. */
function runProbe(command: string): { stdout: string; return_code: number } {
  // The command is `<python> <decoder> <script-b64> <request-b64>`; running it
  // through the shell is exactly what the container does.
  try {
    const stdout = execFileSync('sh', ['-c', command], { encoding: 'utf8' })
    return { stdout, return_code: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; status?: number }
    return { stdout: failure.stdout ?? '', return_code: failure.status ?? 1 }
  }
}

async function service(): Promise<{ endpoint: string; seen: string[] }> {
  const seen: string[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      seen.push(request.url ?? '')
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { command?: string }
      const result = runProbe(body.command ?? '')
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(result))
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { endpoint: `http://127.0.0.1:${address.port}`, seen }
}

async function fsFor(endpoint: string): Promise<RemoteFileSystem> {
  const ctx = new Context()
  await ctx.plugin(RemoteFileSystem, { endpoint, timeoutSec: 30 })
  return ctx.fs as RemoteFileSystem
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-fs-remote-'))
  roots.push(root)
  return root
}

describe('remote filesystem', () => {
  it('reads a file that exists only in the task environment', async () => {
    const root = workspace()
    writeFileSync(join(root, 'answer.txt'), 'from the task\n')
    const { endpoint, seen } = await service()
    const fs = await fsFor(endpoint)

    const target = await fs.resolve('answer.txt', { cwd: root, agentId: 'case-7' })
    const text = await fs.readText(target)

    expect(text).toBe('from the task\n')
    // The service routes by the agent's session, as the shell channel does.
    expect(seen[0]).toBe('/jobs/by-session/case-7/exec')
  })

  it('reports a missing file as not found rather than an infrastructure fault', async () => {
    const root = workspace()
    const { endpoint } = await service()
    const fs = await fsFor(endpoint)

    const target = await fs.resolve('absent.txt', { cwd: root, agentId: 'case-1' })

    expect(await fs.stat(target)).toBeUndefined()
    await expect(fs.readText(target)).rejects.toMatchObject({ code: 'FS_NOT_FOUND' })
  })

  it('lists a directory with each child addressable', async () => {
    const root = workspace()
    mkdirSync(join(root, 'pkg'))
    writeFileSync(join(root, 'pkg', 'a.py'), 'x = 1\n')
    const { endpoint } = await service()
    const fs = await fsFor(endpoint)

    const target = await fs.resolve('pkg', { cwd: root, agentId: 'case-2' })
    const entries = await fs.listDir(target)

    expect(entries.map(entry => entry.name)).toEqual(['a.py'])
    expect(await fs.readText(entries[0]!.target)).toBe('x = 1\n')
  })

  it('writes a file into the task environment', async () => {
    const root = workspace()
    const { endpoint } = await service()
    const fs = await fsFor(endpoint)

    const target = await fs.resolve('out.txt', { cwd: root, agentId: 'case-3' })
    const outcome = await fs.writeText(target, 'written by the model\n')

    expect(outcome.operation).toBe('create')
    expect(await fs.readText(target)).toBe('written by the model\n')
  })

  it('refuses a write whose version no longer matches', async () => {
    const root = workspace()
    writeFileSync(join(root, 'f.txt'), 'v1\n')
    const { endpoint } = await service()
    const fs = await fsFor(endpoint)
    const target = await fs.resolve('f.txt', { cwd: root, agentId: 'case-4' })
    const info = await fs.stat(target)
    if (info === undefined) throw new Error('expected the file to exist')
    writeFileSync(join(root, 'f.txt'), 'changed elsewhere\n')

    await expect(
      fs.writeText(target, 'mine\n', { kind: 'replaceIfVersion', version: info.version }),
    ).rejects.toMatchObject({ code: 'FS_STALE_VERSION' })
  })

  it('edits a file and reports the text on both sides', async () => {
    const root = workspace()
    writeFileSync(join(root, 'e.txt'), 'alpha beta\n')
    const { endpoint } = await service()
    const fs = await fsFor(endpoint)
    const target = await fs.resolve('e.txt', { cwd: root, agentId: 'case-5' })

    const outcome = await fs.editText(target, {
      oldString: 'beta', newString: 'gamma', replaceAll: false,
    })

    expect(outcome.before).toBe('alpha beta\n')
    expect(outcome.after).toBe('alpha gamma\n')
    expect(await fs.readText(target)).toBe('alpha gamma\n')
  })

  it('refuses an edit whose text is not in the file', async () => {
    const root = workspace()
    writeFileSync(join(root, 'g.txt'), 'nothing here\n')
    const { endpoint } = await service()
    const fs = await fsFor(endpoint)
    const target = await fs.resolve('g.txt', { cwd: root, agentId: 'case-6' })

    await expect(
      fs.editText(target, { oldString: 'absent', newString: 'x', replaceAll: false }),
    ).rejects.toMatchObject({ code: 'FS_EDIT_NOT_FOUND' })
  })

  it('refuses a request that names no agent instead of guessing a container', async () => {
    const { endpoint, seen } = await service()
    const fs = await fsFor(endpoint)

    await expect(fs.resolve('a.txt', { cwd: '/' })).rejects.toThrow(/names no agent/)
    expect(seen).toEqual([])
  })

  it('keeps two agents apart', async () => {
    const first = workspace()
    const second = workspace()
    writeFileSync(join(first, 'same.txt'), 'one\n')
    writeFileSync(join(second, 'same.txt'), 'two\n')
    const { endpoint } = await service()
    const fs = await fsFor(endpoint)

    const a = await fs.resolve('same.txt', { cwd: first, agentId: 'case-a' })
    const b = await fs.resolve('same.txt', { cwd: second, agentId: 'case-b' })

    expect(await fs.readText(a)).toBe('one\n')
    expect(await fs.readText(b)).toBe('two\n')
    expect(fs.contains(a, b)).toBe(false)
  })
})
