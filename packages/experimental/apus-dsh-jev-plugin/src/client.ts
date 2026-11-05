/** HTTP System One provider for a local or remote vLLM-compatible Jev gateway. */
import { TypeSafeClient, APIError, APITimeoutError, type Questions } from '@typesafe-ai/sdk'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Context } from '@deepseek-ai/cordis'
import { parseJevResponse, JevProtocolError, validateJevRequest } from './protocol.ts'
import type { JevAnswer, JevFailure, JevProvider, JevProviderInfo, JevQuestion, JevRequest, JevResponse, JevUsage } from './types.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Fetch seam used by tests and by the built-in provider. */
export type JevFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

/** Provider error with a public Jev failure class. */
export class JevProviderError extends Error {
  override name = 'JevProviderError'

  constructor(readonly failure: JevFailure, options?: ErrorOptions) {
    super(failure.message, options)
  }
}

/** Configuration accepted by the System One HTTP provider. */
export interface SystemOneProviderOptions {
  readonly id: string
  readonly endpoint: string
  readonly model: string
  readonly effort: 'low' | 'high'
  /**
   * Wire dialect of the gateway. `openjev`/`typesafe` speak the System One
   * protocol; `chat-completions` drives any OpenAI-compatible endpoint by
   * asking a yes/no question per candidate and reading the answer's token
   * probability. Same decision, different transport.
   */
  readonly protocol?: 'openjev' | 'typesafe' | 'chat-completions'
  readonly timeoutMs: number
  /**
   * Room for the chat-completions protocol's answer. A thinking model spends
   * hundreds of tokens reasoning before its verdict, so this bounds that
   * reasoning rather than the one-word answer.
   */
  readonly maxAnswerTokens?: number
  readonly apiKeyEnv?: string
  readonly fetcher?: JevFetch
  readonly resolveApiKey?: () => Promise<string | undefined>
}


/** Normalize an HTTP endpoint without accepting embedded credentials.
 * @param endpoint - Configured gateway URL.
 * @returns Absolute URL without a trailing slash.
 */
export function normalizeJevEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
    if (url.username || url.password || url.search || url.hash) throw new Error('endpoint cannot contain credentials, query, or fragment')
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    throw new Error('jev endpoint must be an absolute http(s) URL')
  }
}

function failure(code: JevFailure['code'], message: string, status?: number, cause?: unknown): JevProviderError {
  return new JevProviderError({ code, message, ...status === undefined ? {} : { status } }, cause instanceof Error ? { cause } : undefined)
}

/**
 * Resolve a credential reference through the managed store or launch environment.
 * @param ctx - Context providing the optional credential store.
 * @param name - Credential reference, or absent for an unauthenticated gateway.
 * @returns The non-empty credential or undefined when no reference was declared.
 */
export async function resolveJevApiKey(ctx: Context, name: string | undefined): Promise<string | undefined> {
  if (name === undefined) return undefined
  const ref = credentialRef(name)
  const credentials = ctx.get('credentials')
  const value = credentials !== undefined
    ? (await credentials.resolve(ref))?.value
    : launchEnvironmentOf(ctx).get(ref)?.value
  if (value !== undefined && value.length > 0) return value
  throw failure('missing-credential', `jev provider credential ${name} is not configured`)
}

/** Built-in provider for the APUS OpenJev `/v1/systemone` gateway. */
export class SystemOneProvider implements JevProvider {
  readonly info: JevProviderInfo
  private readonly fetcher: JevFetch
  private readonly options: SystemOneProviderOptions

  constructor(options: SystemOneProviderOptions) {
    this.options = { ...options, endpoint: normalizeJevEndpoint(options.endpoint) }
    this.info = { id: options.id, endpoint: this.options.endpoint, model: options.model }
    this.fetcher = options.fetcher ?? fetch
    if (options.timeoutMs <= 0 || options.timeoutMs > MAX_TIMER_DELAY_MS || !Number.isFinite(options.timeoutMs)) throw new Error(`jev timeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }

  /**
   * Send an authenticated model-list request so the next decision reuses an open connection.
   * @param signal - Caller cancellation propagated to Fetch.
   */
  async warm(signal?: AbortSignal): Promise<void> {
    const key = await this.options.resolveApiKey?.()
    signal?.throwIfAborted()
    const headers = key === undefined ? undefined : { authorization: `Bearer ${key}` }
    const response = await this.fetcher(`${this.options.endpoint.replace(/\/v1$/, '')}/v1/models`, {
      ...headers === undefined ? {} : { headers },
      signal: AbortSignal.any([...signal === undefined ? [] : [signal], AbortSignal.timeout(this.options.timeoutMs)]),
    })
    // Drain the body so the connection returns to the pool.
    await response.arrayBuffer()
    if (!response.ok) throw failure('http', `jev provider returned HTTP ${response.status}`, response.status)
  }

  /**
   * Send one validated typed decision request and validate the complete answer.
   * @param request - JSON state and typed questions.
   * @param signal - Caller cancellation propagated to Fetch.
   * @returns Validated answers and provider-reported usage.
   */
  async decide(request: JevRequest, signal?: AbortSignal): Promise<JevResponse> {
    signal?.throwIfAborted()
    const normalized = validateJevRequest(request)
    if (this.options.protocol === 'chat-completions') {
      return this.decideByChatCompletions(normalized, signal)
    }
    if (typeof normalized.state === 'number' || typeof normalized.state === 'boolean') {
      throw new JevProtocolError('SDK state must be text, an object, an array, or null')
    }
    const questions: Questions = {}
    for (const [name, question] of Object.entries(normalized.questions)) {
      if (question.type !== 'score') {
        questions[name] = question
      } else {
        const [first, second, ...rest] = question.criteria
        // oxlint-disable-next-line typescript/no-non-null-assertion -- validateJevRequest requires at least two score criteria.
        questions[name] = { ...question, criteria: [first!, second!, ...rest] }
      }
    }
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, this.options.timeoutMs)
    const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    const cancelled = Promise.withResolvers<never>()
    const abortWait = () => { cancelled.reject(combined.reason instanceof Error ? combined.reason : new Error('Jev request aborted', { cause: combined.reason })) }
    combined.addEventListener('abort', abortWait, { once: true })
    try {
      const key = await Promise.race([this.options.resolveApiKey?.(), cancelled.promise])
      combined.throwIfAborted()
      const client = new TypeSafeClient({
        // The SDK requires a nonempty key even for explicitly unauthenticated local gateways.
        // The transport below removes this placeholder instead of transmitting it.
        apiKey: key ?? 'unauthenticated-local-gateway',
        baseURL: this.options.endpoint.replace(/\/v1$/, ''),
        defaultModel: this.options.model,
        timeout: this.options.timeoutMs,
        retry: { maxRetries: 0 },
        logLevel: 'off',
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers)
          if (key === undefined) headers.delete('authorization')
          const response = await this.fetcher(input, { ...init, headers })
          // Keep the network body locked until drained; cloning it in the SDK races Node's abort cleanup.
          const body = response.body === null ? null : await response.arrayBuffer()
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
        },
      })
      const body = {
        state: normalized.state,
        questions,
        model: normalized.model ?? this.options.model,
        ...this.options.protocol === 'typesafe' ? {} : { effort: normalized.effort ?? this.options.effort },
      }
      const raw = await Promise.race([client.systemOne(body, { signal: combined }), cancelled.promise])
      combined.throwIfAborted()
      try {
        return parseJevResponse(raw, normalized)
      } catch (error) {
        throw failure('invalid-response', 'jev provider response failed validation', undefined, error)
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (controller.signal.aborted || error instanceof APITimeoutError) throw failure('timeout', `jev provider timed out after ${this.options.timeoutMs}ms`)
      if (error instanceof JevProviderError) throw error
      if (error instanceof APIError) {
        throw failure(error.status === 429 || error.status === 529 ? 'rate-limited' : 'http', `jev provider returned HTTP ${error.status}`, error.status)
      }
      throw failure('transport', 'jev provider request failed', undefined, error)
    } finally {
      clearTimeout(timer)
      combined.removeEventListener('abort', abortWait)
    }
  }

  /**
   * Decide an OpenAI-compatible endpoint by asking one yes/no question per
   * candidate and reading the answer token's probability.
   *
   * The reasoning the model does before answering is kept: the query walks the
   * whole token stream for the first `yes`/`no` token and takes its probability.
   * Requesting `max_tokens: 1` would capture only the model's opening word —
   * with a thinking model that is the start of its reasoning, not the verdict.
   *
   * Only `noul` questions have a yes/no form; a `choice` or `score` question
   * cannot be asked this way and is refused rather than answered with a guess.
   */
  private async decideByChatCompletions(
    request: JevRequest,
    signal?: AbortSignal,
  ): Promise<JevResponse> {
    const unsupported = Object.entries(request.questions)
      .filter(([, question]) => question.type !== 'noul')
      .map(([name]) => name)
    if (unsupported.length > 0) {
      throw new JevProtocolError(
        `chat-completions protocol supports noul questions only; got ${unsupported.join(', ')}`,
      )
    }
    const key = await this.options.resolveApiKey?.()
    signal?.throwIfAborted()
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, this.options.timeoutMs)
    const combined = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
    try {
      const answers: Record<string, JevAnswer> = {}
      let usage: JevUsage | undefined
      for (const [name, question] of Object.entries(request.questions)) {
        const outcome = await this.askYesNo(request.state, name, question, key, combined)
        answers[name] = { type: 'noul', noul: outcome.probability }
        usage = outcome.usage ?? usage
      }
      return { model: this.options.model, answers, ...usage === undefined ? {} : { usage } }
    } catch (error) {
      signal?.throwIfAborted()
      if (controller.signal.aborted) throw failure('timeout', `jev provider timed out after ${this.options.timeoutMs}ms`)
      if (error instanceof JevProviderError || error instanceof JevProtocolError) throw error
      throw failure('transport', 'jev provider request failed', undefined, error)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Ask one candidate's yes/no question and read the verdict's probability.
   *
   * `logprobs` carries every token the model emitted, reasoning included, so the
   * first `yes`/`no` token is the model's actual answer whenever it produced one.
   * A reply that never reaches a verdict is a protocol failure, not a low score:
   * reporting 0 would silently rank a candidate the model never judged.
   */
  private async askYesNo(
    state: JsonValue,
    name: string,
    question: JevQuestion,
    key: string | undefined,
    signal: AbortSignal,
  ): Promise<{ readonly probability: number; readonly usage?: JevUsage }> {
    const prompt = renderYesNoPrompt(state, name, question)
    // `this.options.endpoint` is already normalized; it may or may not name
    // its API root, so strip one `/v1` before adding the full path — appending
    // twice would 404.
    const base = this.options.endpoint.replace(/\/v1$/, '')
    const response = await this.fetcher(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...key === undefined ? {} : { authorization: `Bearer ${key}` },
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: this.options.maxAnswerTokens ?? 4096,
        logprobs: true,
        top_logprobs: 20,
      }),
      signal,
    })
    if (!response.ok) throw failure('http', `jev provider returned HTTP ${response.status}`, response.status)
    const payload = await response.json() as ChatCompletionPayload
    const probability = verdictProbability(payload, name)
    const usage = payload.usage === undefined ? undefined : {
      ...payload.usage.prompt_tokens === undefined ? {} : { inputTokens: payload.usage.prompt_tokens },
      ...payload.usage.completion_tokens === undefined ? {} : { outputTokens: payload.usage.completion_tokens },
    }
    return { probability, ...usage === undefined ? {} : { usage } }
  }
}

/** One candidate's verdict rendered as a yes/no question for a chat endpoint. */
function renderYesNoPrompt(state: JsonValue, name: string, question: JevQuestion): string {
  const criteria = question.type === 'noul' ? question.criteria : undefined
  const trueRule = criteria?.true ?? 'The candidate may provide relevant evidence, context, or constraints.'
  const falseRule = criteria?.false ?? 'The candidate is unrelated to the query.'
  return [
    `State: ${typeof state === 'string' ? state : JSON.stringify(state)}`,
    `Question ${name}: ${question.type === 'noul' ? question.instructions ?? 'Judge this candidate.' : ''}`,
    `Answer YES when: ${trueRule}`,
    `Answer NO when: ${falseRule}`,
    'Reply with exactly one word, YES or NO.',
  ].join('\n')
}

/** Shape of the fields this client reads from an OpenAI-compatible reply. */
interface ChatCompletionPayload {
  readonly choices?: readonly {
    readonly message?: { readonly content?: string | null }
    readonly logprobs?: { readonly content?: readonly {
      readonly token?: string
      readonly logprob?: number
    }[] | null } | null
  }[]
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number }
}

/**
 * The probability the model assigned to "relevant", read from its own verdict.
 *
 * Every token is scanned, not just the first: a reasoning model spends its
 * opening tokens thinking, and the verdict appears later. A reply with no
 * yes/no token never reached an answer, so it fails instead of scoring 0.
 */
function verdictProbability(payload: ChatCompletionPayload, name: string): number {
  for (const choice of payload.choices ?? []) {
    for (const entry of choice.logprobs?.content ?? []) {
      const token = entry.token?.trim().toLowerCase()
      if (token !== 'yes' && token !== 'no') continue
      if (typeof entry.logprob !== 'number' || !Number.isFinite(entry.logprob)) continue
      const probability = Math.exp(entry.logprob)
      return token === 'yes' ? probability : 1 - probability
    }
  }
  const content = payload.choices?.[0]?.message?.content ?? ''
  throw new JevProtocolError(
    `provider reply for ${name} contained no yes/no verdict (content starts ${JSON.stringify(content.slice(0, 60))})`,
  )
}
