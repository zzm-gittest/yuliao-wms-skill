/** WMS credential record shape and safe read helpers (Host side only). */

import { credentialKey, type CredentialKey } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { CREDENTIAL_ID, CREDENTIAL_SCOPE } from './protocol.ts'

/** The stored grant payload. The JWT never leaves the Host process. */
export interface WmsGrant {
  readonly version: 1
  readonly baseUrl: string
  readonly token: string
  /** RuoYi resolves tenant from the token; kept here for display only. */
  readonly loginUser: string
  readonly connectedAt: number
  readonly expiresAt: number | null
}

/** Key this plugin's authorization flow writes. */
export const WMS_CREDENTIAL_KEY: CredentialKey = credentialKey(CREDENTIAL_SCOPE, CREDENTIAL_ID)

/** Validate an unknown credential payload as a WMS grant. */
export function parseGrant(payload: unknown): WmsGrant | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  if (record.version !== 1) return undefined
  if (typeof record.baseUrl !== 'string' || typeof record.token !== 'string') return undefined
  if (typeof record.loginUser !== 'string' || typeof record.connectedAt !== 'number') return undefined
  return {
    version: 1,
    baseUrl: record.baseUrl,
    token: record.token,
    loginUser: record.loginUser,
    connectedAt: record.connectedAt,
    expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : null,
  }
}
