/**
 * Filesystem provider whose execution world is the task container a benchmark
 * owns.
 *
 * A benchmark trial hands its work to this harness, but the files it asks
 * about — the repository being fixed, the data being parsed — live in a
 * container this process never touches. A local provider would answer about
 * the harness's own filesystem, so every operation is sent to the service
 * that owns the task and its real answer comes back.
 *
 * The target key carries the agent as well as the path: one harness process
 * serves several concurrent cases, and the service needs that identity to
 * tell which container a path belongs to. Consumers treat the key as opaque,
 * which is what makes it a safe place to keep it.
 *
 * @module @deepseek-ai/dsh-fs-remote
 */

import { posix } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsErrorCode,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { PROBE_SOURCE, probeCommand, type ProbeAnswer, type ProbeRequest } from './probe.ts'

/** Validated plugin configuration. */
export interface Config {
  /** The benchmark service that owns the task containers. */
  endpoint: string
  /** Bearer credential for that service, when it requires one. */
  token?: string
  /** Per-operation budget in seconds. */
  timeoutSec: number
}

const ERROR_CODES: Record<string, true> = {
  FS_NOT_FOUND: true, FS_NOT_DIRECTORY: true, FS_NOT_TEXT: true, FS_NOT_REGULAR_FILE: true,
  FS_TOO_LARGE: true, FS_PERMISSION_DENIED: true, FS_SANDBOX_DENIED: true, FS_IO_ERROR: true,
  FS_STALE_VERSION: true, FS_NOT_OBSERVED: true, FS_AMBIGUOUS_EDIT: true,
  FS_EDIT_NOT_FOUND: true, FS_ABORTED: true,
}

/** Split a target key back into the agent that owns it and its path. */
function decode(target: FsTarget): { agentId: string; path: string } {
  const key = String(target.targetKey)
  const split = key.indexOf('\u0000')
  if (split < 0) {
    throw new FsError(`target has no owning agent: ${key}`, 'FS_IO_ERROR')
  }
  return { agentId: key.slice(0, split), path: key.slice(split + 1) }
}

function encode(agentId: string, path: string): string {
  return `${agentId}\u0000${path}`
}

export class RemoteFileSystem extends FileSystem {
  static Config = z.object({
    endpoint: z.string().required(),
    token: z.string(),
    timeoutSec: z.number().default(120),
  })

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
  }

  override async resolve(
    path: string,
    opts?: { cwd?: string; signal?: AbortSignal; agentId?: string },
  ): Promise<FsTarget> {
    if (opts?.agentId === undefined) {
      throw new FsError(
        'the request names no agent, so the service cannot tell which task container '
        + 'this path belongs to',
        'FS_IO_ERROR',
      )
    }
    const answer = await this._call(
      opts.agentId,
      { op: 'resolve', path, ...opts.cwd === undefined ? {} : { cwd: opts.cwd } },
      opts.signal,
    )
    const resolved = typeof answer.path === 'string' ? answer.path : path
    return { targetKey: FsTargetKey(encode(opts.agentId, resolved)), displayPath: resolved }
  }

  override processPath(target: FsTarget): string {
    return decode(target).path
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    void hostPath
    // The task container shares no path with this host.
    return undefined
  }

  override fileUrl(target: FsTarget): string {
    return pathToFileURL(this.processPath(target)).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const outer = decode(parent)
    const inner = decode(child)
    if (outer.agentId !== inner.agentId) return false
    const relative = posix.relative(outer.path, inner.path)
    return relative === '' || (!relative.startsWith('../') && relative !== '..' && !posix.isAbsolute(relative))
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const { agentId, path } = decode(target)
    const answer = await this._call(agentId, { op: 'stat', path }, signal)
    if (answer.exists === false) return undefined
    return {
      version: FsVersion(String(answer.version ?? '')),
      type: answer.type ?? 'other',
      ...typeof answer.size === 'number' ? { size: answer.size } : {},
    }
  }

  override async lstat(
    path: string, opts?: { cwd?: string }, signal?: AbortSignal,
  ): Promise<FsPathInfo | undefined> {
    // lstat is path-shaped, so it carries no agent. One process serves several
    // cases, and guessing which container a bare path belongs to would answer
    // about the wrong task; the callers that need it are UI and persistence
    // paths that never run against a task environment.
    void path
    void opts
    signal?.throwIfAborted()
    throw new FsError(
      'a path alone does not say which task container it belongs to',
      'FS_IO_ERROR',
    )
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const { agentId, path } = decode(target)
    const answer = await this._call(agentId, { op: 'read', path }, signal)
    return typeof answer.text === 'string' ? answer.text : ''
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    // The whole text arrives in one answer; yielding it in chunks keeps the
    // caller's interface identical without a second protocol.
    const text = await this.readText(target, signal)
    return (async function* () {
      const chunk = 64 * 1024
      for (let at = 0; at < text.length; at += chunk) {
        signal?.throwIfAborted()
        yield text.slice(at, at + chunk)
      }
    })()
  }

  override async readBytes(
    target: FsTarget, signal: AbortSignal | undefined, maxBytes: number,
  ): Promise<Uint8Array> {
    const { agentId, path } = decode(target)
    const answer = await this._call(agentId, { op: 'bytes', path, maxBytes }, signal)
    return Buffer.from(String(answer.base64 ?? ''), 'base64')
  }

  override async readByteRange(
    target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const { agentId, path } = decode(target)
    const answer = await this._call(
      agentId, { op: 'range', path, offset: range.offset, length: range.length }, signal,
    )
    return Buffer.from(String(answer.base64 ?? ''), 'base64')
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const { agentId, path } = decode(target)
    const answer = await this._call(agentId, { op: 'list', path }, signal)
    return (answer.entries ?? []).map(entry => ({
      name: entry.name,
      type: entry.type,
      target: {
        targetKey: FsTargetKey(encode(agentId, posix.join(path, entry.name))),
        displayPath: posix.join(path, entry.name),
      },
      ...entry.version ? { version: FsVersion(entry.version) } : {},
      ...typeof entry.size === 'number' ? { size: entry.size } : {},
    }))
  }

  override async writeText(
    target: FsTarget, content: string, expected?: FsWriteIntent,
    signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    void sandboxPolicy
    const { agentId, path } = decode(target)
    const request: ProbeRequest = {
      op: 'write', path, content,
      ...expected?.kind === 'createIfAbsent' ? { createOnly: true } : {},
      ...expected?.kind === 'replaceIfVersion' ? { expectedVersion: String(expected.version) } : {},
    }
    const answer = await this._call(agentId, request, signal)
    return {
      operation: answer.operation === 'create' ? 'create' : 'update',
      version: FsVersion(String(answer.version ?? '')),
      before: typeof answer.before === 'string' ? answer.before : null,
      after: content.replace(/\r\n/g, '\n'),
    }
  }

  override async editText(
    target: FsTarget, edit: FsEditRequest, expected?: { version: FsVersion },
    signal?: AbortSignal, sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsEditOutcome> {
    void sandboxPolicy
    const { agentId, path } = decode(target)
    const request: ProbeRequest = {
      op: 'edit', path,
      old: edit.oldString, new: edit.newString, replaceAll: edit.replaceAll,
      ...expected === undefined ? {} : { expectedVersion: String(expected.version) },
    }
    const answer = await this._call(agentId, request, signal)
    return {
      version: FsVersion(String(answer.version ?? '')),
      before: String(answer.before ?? ''),
      after: String(answer.after ?? ''),
    }
  }

  /**
   * Run one probe in the task container and return its answer.
   *
   * A failure the caller can act on arrives as a code inside a successful
   * answer; a service that could not run the probe at all throws, because a
   * container that never answered is not the same fact as a missing file.
   */
  private async _call(
    agentId: string, request: ProbeRequest, signal?: AbortSignal,
  ): Promise<ProbeAnswer> {
    if (!agentId) {
      throw new FsError('the request names no agent', 'FS_IO_ERROR')
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
        body: JSON.stringify({
          command: probeCommand(request),
          timeout_sec: this.config.timeoutSec,
        }),
        ...signal === undefined ? {} : { signal },
      },
    )
    if (!response.ok) {
      const detail = await response.text()
      throw new FsError(
        `the task service answered ${response.status}: ${detail.slice(0, 500)}`,
        'FS_IO_ERROR',
      )
    }
    const body: unknown = await response.json()
    const stdout = typeof body === 'object' && body !== null
      ? (body as { stdout?: unknown }).stdout
      : undefined
    if (typeof stdout !== 'string') {
      throw new FsError('the task service answered no output', 'FS_IO_ERROR')
    }
    let answer: ProbeAnswer
    try {
      answer = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as ProbeAnswer
    } catch {
      throw new FsError(`the probe answered unreadable output: ${stdout.slice(0, 300)}`, 'FS_IO_ERROR')
    }
    if (answer.ok === false) {
      const code = answer.code !== undefined && Object.hasOwn(ERROR_CODES, answer.code)
        ? answer.code as FsErrorCode
        : 'FS_IO_ERROR'
      throw new FsError(answer.message ?? 'filesystem operation failed', code)
    }
    return answer
  }
}

export default RemoteFileSystem

export { PROBE_SOURCE }
