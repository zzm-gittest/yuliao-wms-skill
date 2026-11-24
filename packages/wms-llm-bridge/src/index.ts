/** WMS LLM bridge: anonymous HTTP endpoints serving WMS model calls with dsh's configured model. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import z from '@deepseek-ai/schemastery'
import { createChatHandler, createVisionHandler } from './handler.ts'

/** Cordis function-plugin name. */
export const name = 'wms-llm-bridge'

/** Host services required before the routes can register. */
export const inject = ['webServer', 'llm', 'agentDefaultModel']

/** Bridge configuration. The shared secret is a plain string here because this
 * plugin is deployed only on the trusted local/private dsh instance; WMS must
 * hold the same value in dsh.gateway.bridge-token. */
export interface Config {
  /** Exact path of the chat endpoint. */
  readonly chatPath: string
  /** Exact path of the vision endpoint. */
  readonly visionPath: string
  /** Header name carrying the shared secret. */
  readonly headerName: string
  /** Shared secret, >= 16 chars. Must match WMS dsh.gateway.bridge-token. */
  readonly sharedSecret: string
  /** Positive raw body ceiling in bytes. */
  readonly maxBodyBytes: number
  /** Default max output tokens when WMS omits it. */
  readonly maxTokens: number
  /** Per-request model timeout in ms; 0 disables. */
  readonly timeoutMs: number
}

export const Config: z<Config> = z.object({
  chatPath: z.string().default('/wms-llm/chat'),
  visionPath: z.string().default('/wms-llm/vision'),
  headerName: z.string().default('X-WMS-Bridge-Token'),
  sharedSecret: z.string().min(16).required(),
  maxBodyBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1024 * 1024),
  maxTokens: z.number().step(1).min(1).default(4096),
  timeoutMs: z.number().step(1).min(0).default(90000),
})

/** Validate route facts that Schemastery cannot express. */
function assertConfig(config: Config): void {
  for (const path of [config.chatPath, config.visionPath]) {
    if (!path.startsWith('/') || path === '/' || path.endsWith('/')
      || path.includes('?') || path.includes('#')) {
      throw new Error(`wms-llm-bridge: invalid route path "${path}"`)
    }
  }
  if (config.chatPath === config.visionPath) {
    throw new Error('wms-llm-bridge: chat and vision paths must differ')
  }
}

/** Register the two anonymous bridge routes on the injected WebServer. */
export function apply(ctx: Context, config: Config): void {
  assertConfig(config)
  const handlerConfig = {
    sharedSecret: config.sharedSecret,
    headerName: config.headerName,
    maxBodyBytes: config.maxBodyBytes,
    maxTokens: config.maxTokens,
    timeoutMs: config.timeoutMs,
  }
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact' as const,
      auth: 'anonymous' as const,
      path: config.chatPath,
      handler: createChatHandler(ctx, handlerConfig),
    }),
    `wms-llm-bridge: ${config.chatPath}`,
  )
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact' as const,
      auth: 'anonymous' as const,
      path: config.visionPath,
      handler: createVisionHandler(),
    }),
    `wms-llm-bridge: ${config.visionPath}`,
  )
}
