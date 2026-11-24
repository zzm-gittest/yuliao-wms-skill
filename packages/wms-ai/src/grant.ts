/** Shared Host-side credential read for the panel routes and the agent tool. */

import type { Context } from '@deepseek-ai/cordis'
import { parseGrant, WMS_CREDENTIAL_KEY, type WmsGrant } from './store.ts'

/** Read the stored WMS grant, if any and well-formed. */
export async function readGrant(ctx: Context): Promise<WmsGrant | undefined> {
  const record = await ctx.credentials.readRecord(WMS_CREDENTIAL_KEY)
  if (record === undefined || record.kind !== 'grant') return undefined
  return parseGrant(record.payload)
}
