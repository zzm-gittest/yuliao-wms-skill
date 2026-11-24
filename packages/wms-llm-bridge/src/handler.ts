/** HTTP handlers for the WMS LLM bridge: shared-secret auth and model dispatch via dsh. */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  BlockAssembler,
  type FinishReason,
  type GenerateOptions,
  type RequestUserInput,
  type TextBlock,
} from '@deepseek-ai/dsh-llm'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { readBoundedUtf8Body, BridgeHttpError } from './body.ts'

/** Handler values validated once at plugin load. */
export interface BridgeHandlerConfig {
  /** Secret every WMS call must present in the header. */
  readonly sharedSecret: string
  /** Header name carrying the shared secret. */
  readonly headerName: string
  /** Positive raw body ceiling in bytes. */
  readonly maxBodyBytes: number
  /** Default max output tokens when the caller omits it. */
  readonly maxTokens: number
  /** Optional read deadline in milliseconds. */
  readonly timeoutMs: number
}

/** One chat request from WMS, mirroring the AIGW internal proxy contract. */
interface ChatRequest {
  modelName?: string
  messages?: readonly { role: string; content: string }[]
  temperature?: number
  maxTokens?: number
  jsonMode?: boolean
  requestId?: string
  callerTenantId?: string
  callerUserId?: string
  usageScene?: string
}

/** Require one unambiguous non-empty request header (case-insensitive name). */
function requiredHeader(request: IncomingMessage, name: string): string {
  // Node lower-cases incoming header names; headersDistinct is keyed that way too.
  const values = request.headersDistinct[name.toLowerCase()]
  const value = values?.[0]
  if (values?.length !== 1 || value === undefined || value.trim() === '') {
    throw new BridgeHttpError(400, `missing ${name} header`)
  }
  return value
}

/** Constant-time shared-secret comparison. */
function verifySecret(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}

/** Whether Content-Type names JSON with at most one UTF-8 charset parameter. */
function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false
  const parts = value.split(';').map(part => part.trim())
  const [mediaType, parameter, ...extra] = parts
  if (mediaType?.toLowerCase() !== 'application/json') return false
  if (parameter === undefined) return true
  return extra.length === 0 && /^charset=(?:utf-8|"utf-8")$/i.test(parameter)
}

/** Send one JSON response exactly once. */
function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent) return
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

/** Extract and validate the chat request body. */
function parseChatRequest(body: string): ChatRequest {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new BridgeHttpError(400, 'request body is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BridgeHttpError(400, 'request body must be a JSON object')
  }
  return parsed as ChatRequest
}

/** Build dsh user messages from the WMS messages array. */
function toUserInputs(messages: readonly { role: string; content: string }[] | undefined): RequestUserInput[] {
  if (messages === undefined || messages.length === 0) {
    throw new BridgeHttpError(400, 'messages must be a non-empty array')
  }
  const systemParts: string[] = []
  const userInputs: RequestUserInput[] = []
  let lastUser = ''
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content ?? '')
    } else if (message.role === 'user') {
      lastUser = message.content ?? ''
      userInputs.push({ role: 'user', content: [{ type: 'text', text: lastUser }] })
    } else if (message.role === 'assistant') {
      // One-shot extraction: assistant turns are dropped; WMS sends system+user only.
    }
  }
  if (userInputs.length === 0) throw new BridgeHttpError(400, 'at least one user message is required')
  return userInputs
}

/** Extract a system prompt from the leading system messages. */
function toSystem(messages: readonly { role: string; content: string }[] | undefined): string | undefined {
  if (messages === undefined) return undefined
  const parts = messages.filter(m => m.role === 'system').map(m => m.content ?? '')
  return parts.length === 0 ? undefined : parts.join('\n')
}

/**
 * Create the chat route handler. It serves WMS with dsh's own configured model;
 * no API key is read by this plugin at any point.
 */
export function createChatHandler(ctx: Context, config: BridgeHandlerConfig): WebRoute['handler'] {
  return async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.setHeader('allow', 'POST')
        throw new BridgeHttpError(405, 'method not allowed')
      }
      if (!isJsonContentType(request.headers['content-type'])) {
        throw new BridgeHttpError(415, 'content type must be application/json')
      }
      const supplied = requiredHeader(request, config.headerName)
      if (!verifySecret(supplied, config.sharedSecret)) {
        throw new BridgeHttpError(401, 'invalid bridge token')
      }
      const body = await readBoundedUtf8Body(request, config.maxBodyBytes)
      const input = parseChatRequest(body)
      const messages = toUserInputs(input.messages)
      const system = toSystem(input.messages)

      const selection = ctx.agentDefaultModel.currentSelection()
      const controller = new AbortController()
      response.once('close', () => controller.abort())
      if (config.timeoutMs > 0) {
        const timer = setTimeout(() => controller.abort(), config.timeoutMs)
        controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
      }

      const prepared = await ctx.llm.prepareCall({
        ...selection,
        maxTokens: input.maxTokens ?? config.maxTokens,
        ...input.temperature === undefined ? {} : { temperature: input.temperature },
      }, controller.signal)
      const options: GenerateOptions = {
        ...prepared.config,
        ...system === undefined ? {} : { system },
        messages,
        signal: controller.signal,
      }

      const assembler = new BlockAssembler()
      let finish: FinishReason | undefined
      for await (const chunk of prepared.stream(options)) {
        assembler.push(chunk)
        if (chunk.type === 'finish') finish = chunk.reason
      }
      if (finish?.kind === 'error') {
        throw new BridgeHttpError(503, `model failure: ${finish.failure.code}: ${finish.failure.message}`)
      }
      if (finish?.kind === 'aborted') {
        throw new BridgeHttpError(503, 'model call aborted or timed out')
      }
      const answer = assembler.blocks()
        .filter((block): block is TextBlock => block.type === 'text')
        .map(block => block.text)
        .join('')

      respondJson(response, 200, {
        code: 200,
        msg: 'ok',
        data: {
          answer,
          modelName: prepared.config.model,
          providerCode: prepared.config.provider,
          requestId: input.requestId ?? null,
          finishReason: finish?.kind === 'stop' ? 'STOP' : 'MAX_TOKENS',
          costMs: null,
          usage: null,
        },
      })
    } catch (error: unknown) {
      if (error instanceof BridgeHttpError) {
        respondJson(response, error.status, { code: error.status, msg: error.message })
        return
      }
      ctx.logger.warn('wms-llm-bridge: chat request failed')
      respondJson(response, 503, { code: 503, msg: 'bridge unavailable' })
    }
  }
}

/**
 * Vision endpoint placeholder. Image inputs in dsh are durable attachment blocks
 * (see ImageBlock/ImageAttachmentRef), not raw base64; wiring WMS base64 through
 * the attachment service is deferred to phase P3. Text purchase-order flows do
 * not use this endpoint.
 */
export function createVisionHandler(): WebRoute['handler'] {
  return (_request, response) => {
    respondJson(response, 501, {
      code: 501,
      msg: 'vision bridge not implemented yet (phase P3); use text chat for purchase orders',
    })
  }
}
