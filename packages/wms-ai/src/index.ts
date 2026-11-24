/**
 * WMS AI assistant plugin, Host half.
 *
 * Two responsibilities, both keeping the WMS JWT inside the Host process:
 *  1. A sign-in route that logs into WMS (/systemLogin, no captcha) and stores
 *     the JWT as a credential record (never returned to the browser).
 *  2. An owner-only connection.fetch route that proxies WMS API calls on behalf
 *     of the browser panel, injecting Authorization header from the stored JWT.
 *
 * The browser half (exports["./client"]) renders the panel, collects the WMS
 * address/credentials through its own form, and calls these routes over the
 * authenticated /api channel. It never receives the JWT.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import z from '@deepseek-ai/schemastery'
import { WMS_API_PATH, WMS_AUTH_PATH, WMS_FORM_PATH, WMS_STATE_PATH, type WmsAuthStatus, type WmsProxyRequest, type WmsProxyResult } from './protocol.ts'
import { readGrant } from './grant.ts'
import { WMS_CREDENTIAL_KEY, type WmsGrant } from './store.ts'
import { readWmsState, registerAgentIntegration } from './agent.ts'
import { stagePendingMessage } from './form.ts'

/** Cordis plugin name. */
export const name = 'wms-ai'

/** Host services required. */
export const inject = ['credentials', 'connection', 'tools', 'skills']

/** Plugin configuration. The WMS default URL is a convenience, not a secret. */
export interface Config {
  /** Default WMS base URL pre-filled in the sign-in form. */
  readonly defaultBaseUrl: string
  /** Login endpoint path. /systemLogin skips captcha and is intended for system callers. */
  readonly loginPath: string
  /** Request timeout in milliseconds. */
  readonly timeoutMs: number
}

export const Config: z<Config> = z.object({
  defaultBaseUrl: z.string().default('http://127.0.0.1:8080'),
  loginPath: z.string().default('/systemLogin'),
  timeoutMs: z.number().step(1).min(1000).default(30000),
})

/** Normalize a base URL by stripping trailing slashes. */
function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/** Build a JSON Response with a fixed status. */
function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** Sign-in request from the browser form. */
interface SignInRequest {
  readonly baseUrl?: string
  readonly username: string
  readonly password: string
}

/** Register the sign-in / status / sign-out routes. */
function registerAuthRoutes(ctx: Context, config: Config): void {
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: WMS_AUTH_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        try {
          const url = new URL(request.url)
          const action = url.searchParams.get('action') ?? 'status'

          if (action === 'status') {
            const grant = await readGrant(ctx)
            const status: WmsAuthStatus = grant === undefined
              ? { connected: false, baseUrl: null, tenantId: null, hint: null }
              : { connected: true, baseUrl: grant.baseUrl, tenantId: null, hint: grant.loginUser }
            return jsonResponse(200, status)
          }

          if (action === 'signout') {
            await ctx.credentials.deleteRecord(WMS_CREDENTIAL_KEY)
            return jsonResponse(200, { ok: true })
          }

          if (action === 'signin') {
            let input: SignInRequest
            try {
              input = await request.json() as SignInRequest
            } catch {
              return jsonResponse(400, { ok: false, error: 'invalid JSON body' })
            }
            const baseUrl = normalizeBaseUrl(input.baseUrl || config.defaultBaseUrl)
            if (!input.username?.trim() || !input.password) {
              return jsonResponse(400, { ok: false, error: '账号和密码不能为空' })
            }
            const controller = AbortSignal.timeout(config.timeoutMs)
            let response: Response
            try {
              response = await fetch(baseUrl + config.loginPath, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ username: input.username.trim(), password: input.password }),
                signal: controller,
              })
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : String(error)
              return jsonResponse(502, { ok: false, error: `无法连接 WMS: ${message}` })
            }
            if (!response.ok) return jsonResponse(502, { ok: false, error: `WMS 登录失败: HTTP ${response.status}` })
            const payload = await response.json() as { code?: number; msg?: string; token?: string }
            if (payload.code !== 200 || typeof payload.token !== 'string' || payload.token === '') {
              return jsonResponse(401, { ok: false, error: payload.msg || 'WMS 登录响应缺少 token' })
            }
            const grant: WmsGrant = {
              version: 1,
              baseUrl,
              token: payload.token,
              loginUser: input.username.trim(),
              connectedAt: Date.now(),
              expiresAt: null,
            }
            await ctx.credentials.modifyRecord(WMS_CREDENTIAL_KEY, () => Promise.resolve({ kind: 'grant', payload: grant }))
            // Return a safe status; never the token.
            const status: WmsAuthStatus = { connected: true, baseUrl, tenantId: null, hint: grant.loginUser }
            return jsonResponse(200, status)
          }

          return jsonResponse(400, { ok: false, error: `unknown action: ${action}` })
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          return jsonResponse(500, { ok: false, error: message })
        }
      },
    }),
    `wms-ai: auth routes ${WMS_AUTH_PATH}`,
  )
}

/** Register the owner-only WMS API proxy route. */
function registerProxyRoute(ctx: Context, config: Config): void {
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: WMS_API_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        try {
          const grant = await readGrant(ctx)
          if (grant === undefined) {
            return jsonResponse(401, { ok: false, status: 401, data: 'WMS 未连接，请先登录' } as WmsProxyResult)
          }
          let input: WmsProxyRequest
          try {
            input = await request.json() as WmsProxyRequest
          } catch {
            return jsonResponse(400, { ok: false, status: 400, data: 'invalid JSON body' } as WmsProxyResult)
          }
          if (typeof input.path !== 'string' || !input.path.startsWith('/')) {
            return jsonResponse(400, { ok: false, status: 400, data: 'path must start with /' } as WmsProxyResult)
          }
          const method = input.method ?? 'GET'
          const url = grant.baseUrl + input.path
          const headers: Record<string, string> = {
            Authorization: `Bearer ${grant.token}`,
            'Content-Type': 'application/json',
          }
          const init: RequestInit = { method, headers, signal: AbortSignal.timeout(config.timeoutMs) }
          if ((method === 'POST' || method === 'PUT' || method === 'DELETE') && input.body !== undefined) {
            init.body = JSON.stringify(input.body)
          }
          const response = await fetch(url, init)
          // Binary passthrough (e.g. PDF print endpoints): stream the raw body.
          if (input.binary === true) {
            const passthrough = new Headers()
            for (const key of ['content-type', 'content-disposition']) {
              const headerValue = response.headers.get(key)
              if (headerValue !== null) passthrough.set(key, headerValue)
            }
            if (response.status === 401) {
              await ctx.credentials.deleteRecord(WMS_CREDENTIAL_KEY)
            }
            return new Response(await response.arrayBuffer(), { status: response.status, headers: passthrough })
          }
          const text = await response.text()
          let data: unknown = text
          try { data = JSON.parse(text) } catch { /* keep raw text */ }
          const result: WmsProxyResult = { ok: response.ok, status: response.status, data }
          if (response.status === 401) {
            // Token likely expired: drop the stored grant so the UI prompts re-login.
            await ctx.credentials.deleteRecord(WMS_CREDENTIAL_KEY)
          }
          return jsonResponse(200, result)
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          return jsonResponse(502, { ok: false, status: 502, data: `WMS 代理请求失败: ${message}` } as WmsProxyResult)
        }
      },
    }),
    `wms-ai: proxy route ${WMS_API_PATH}`,
  )
}

/** Register the owner-only route exposing the latest WMS card for a dsh session. */
function registerStateRoute(ctx: Context): void {
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: WMS_STATE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        try {
          const url = new URL(request.url)
          const sessionId = url.searchParams.get('session') ?? ''
          if (sessionId === '') return jsonResponse(400, { ok: false, error: 'missing session' })
          const state = readWmsState(sessionId)
          return jsonResponse(200, { ok: true, state: state ?? null })
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          return jsonResponse(500, { ok: false, error: message })
        }
      },
    }),
    `wms-ai: state route ${WMS_STATE_PATH}`,
  )
}

/** Register the route staging preview-card form payloads for the relay tool. */
function registerFormRoute(ctx: Context): void {
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: WMS_FORM_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request: Request): Promise<Response> => {
        try {
          let input: { session?: string; payload?: string; visible?: string }
          try {
            input = await request.json() as { session?: string; payload?: string; visible?: string }
          } catch {
            return jsonResponse(400, { ok: false, error: 'invalid JSON body' })
          }
          const sessionId = typeof input.session === 'string' ? input.session : ''
          const payload = typeof input.payload === 'string' ? input.payload : ''
          const visible = typeof input.visible === 'string' && input.visible !== '' ? input.visible : '确认'
          if (sessionId === '' || !payload.startsWith('__')) {
            return jsonResponse(400, { ok: false, error: 'session and internal payload required' })
          }
          stagePendingMessage(sessionId, { payload, visible })
          return jsonResponse(200, { ok: true })
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          return jsonResponse(500, { ok: false, error: message })
        }
      },
    }),
    `wms-ai: form route ${WMS_FORM_PATH}`,
  )
}

/** Plugin body. */
export function apply(ctx: Context, config: Config): void {
  registerAuthRoutes(ctx, config)
  registerProxyRoute(ctx, config)
  registerStateRoute(ctx)
  registerFormRoute(ctx)
  registerAgentIntegration(ctx, config.timeoutMs)
}
