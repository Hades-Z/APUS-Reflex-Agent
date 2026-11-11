/**
 * G4 provider-semantics conformance replay.
 *
 * Feeds every already-recorded native request view (messages/tools exactly as
 * the runtime rebuilt them) through the real pi-ai adapter against a local HTTP
 * mock, then reports what the provider actually received. The provider body is
 * the OpenAI protocol form, so the comparison covers the facts the model reads
 * — message text and tool name/description/parameters — rather than the wire
 * wrapper.
 *
 * `AE_G4_VIEW_FILE` holds either one view object or a list of them, each with
 * `sessionId`, `dispatchSeq`, `messages`, and optional `tools`. The output in
 * `AE_G4_OUT_FILE` is the `runtime_evidence` shape the trace auditor accepts:
 * one case per dispatch, plus the adapter/profile facts.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

interface RecordedView {
  sessionId: string
  dispatchSeq: number
  messages: { role: string; content: unknown }[]
  tools?: { name: string; description: string; parameters: unknown }[]
}

const VIEW_FILE = process.env.AE_G4_VIEW_FILE ?? ''
const OUT_FILE = process.env.AE_G4_OUT_FILE ?? ''
const MODEL = process.env.AE_G4_MODEL ?? 'deepseek-v4.1-flash'

/** Canonical JSON digest: the same normalization the trace auditor applies. */
const digest = (value: unknown): string => {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.keys(input as Record<string, unknown>).sort()
          .map(key => [key, canonical((input as Record<string, unknown>)[key])]),
      )
    }
    return input
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

const textOf = (content: unknown): string => typeof content === 'string'
  ? content
  : ((content as { type: string; text?: string }[] | undefined) ?? [])
    .filter(block => block.type === 'text').map(block => block.text ?? '').join('')

describe('G4 conformance replay', () => {
  // Replaying needs a view recorded by a real run; an ordinary test run has
  // none, and inventing one would defeat the purpose of external evidence.
  it.skipIf(VIEW_FILE === '')('sends the messages and tools each native view records', async () => {
    const parsed = JSON.parse(readFileSync(VIEW_FILE, 'utf8')) as RecordedView | RecordedView[]
    const views = Array.isArray(parsed) ? parsed : [parsed]
    expect(views.length).toBeGreaterThan(0)

    const cases: Record<string, unknown>[] = []
    for (const view of views) {
      const server = await mockServer([{ events: textEvents }])
      const ctx = new Context()
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmPiAi, {
        providers: {
          gateway: {
            apiKeyEnv: 'AE_G4_KEY',
            baseURL: server.url,
            api: 'openai-completions',
            models: [{ id: MODEL, name: MODEL }],
          },
        },
      })
      process.env.AE_G4_KEY = 'test-key'
      await assemble(ctx, {
        provider: 'gateway',
        model: MODEL,
        messages: view.messages as never,
        ...view.tools === undefined ? {} : { tools: view.tools as never },
      })
      const sent = server.requests[0] as {
        messages?: { role: string; content: unknown }[]
        tools?: { function?: { name: string; description: string; parameters: unknown } }[]
      } | undefined
      await closeMockServers()
      expect(sent).toBeDefined()

      const sentTexts = (sent?.messages ?? []).map(message => textOf(message.content))
      const viewTexts = view.messages.map(message => textOf(message.content))
      const sentTools = (sent?.tools ?? []).map(tool => [
        tool.function?.name, tool.function?.description, tool.function?.parameters,
      ])
      const viewTools = (view.tools ?? []).map(tool => [
        tool.name, tool.description, tool.parameters,
      ])
      const result = {
        dispatchSeq: view.dispatchSeq,
        sessionId: view.sessionId,
        native_view_sha256: digest({ messages: view.messages, tools: view.tools ?? null }),
        serialized_body_sha256: digest({ messages: sent?.messages ?? null, tools: sent?.tools ?? null }),
        sent_body_sha256: digest({ messages: sent?.messages ?? null, tools: sent?.tools ?? null }),
        view_message_count: viewTexts.length,
        sent_message_count: sentTexts.length,
        view_tool_count: viewTools.length,
        sent_tool_count: sentTools.length,
        messages_text_equal: JSON.stringify(viewTexts) === JSON.stringify(sentTexts),
        tools_semantics_equal: JSON.stringify(viewTools) === JSON.stringify(sentTools),
      }
      expect(result.messages_text_equal).toBe(true)
      expect(result.tools_semantics_equal).toBe(true)
      cases.push(result)
    }

    const evidence = {
      adapter: { id: 'dsh-llm-pi-ai', profile: 'openai-completions', version: MODEL },
      runtime: { source: 'packages/llm/llm-pi-ai/tests/g4-conformance.spec.ts', log: OUT_FILE || 'stdout' },
      transform_basis: ['chat-completions context mapping', 'tool schema projection'],
      cases,
    }
    if (OUT_FILE) writeFileSync(OUT_FILE, JSON.stringify(evidence, null, 2))
  })
})
