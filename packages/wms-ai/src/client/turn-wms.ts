/**
 * Turn-scoped record of the latest `wms_ai_chat` relay call. The turn-tail
 * slot (`conversation.chat.turnTail`) renders outside the foldable process
 * disclosure, so the WMS card actions (table, confirm/cancel buttons) stay
 * visible after the turn closes. Only calls issued by the relay skill are
 * recorded; the card payload itself is fetched from the Host state route.
 */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { WMS_CHAT_TOOL_NAME } from '../protocol.ts'

/** One captured relay call: its tool-call id and the forwarded message. */
export interface WmsChatTurnData {
  readonly callId: string
  readonly message: string
}

/** Definition kind and its owned turn-data key must match (assembler invariant). */
export const WMS_CHAT_TURN_DATA_KEY = 'wms-chat'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** The relay call this Turn made to the WMS PC assistant. */
    'wms-chat': WmsChatTurnData
  }
}

interface WmsChatState {
  readonly turn: number
  readonly calls: Readonly<Record<string, string>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read the verbatim `message` argument from a tool call's raw JSON arguments. */
function relayMessage(argumentsRaw: unknown): string | null {
  if (typeof argumentsRaw !== 'string' || argumentsRaw === '') return null
  let parsed: unknown
  try { parsed = JSON.parse(argumentsRaw) } catch { return null }
  if (!isRecord(parsed)) return null
  const message = parsed['message']
  return typeof message === 'string' && message.trim() !== '' ? message : null
}

/**
 * Accumulate relay calls for one Turn. The last call wins; a Turn without a
 * relay call publishes no turn data, so the tail renders nothing for it.
 */
export const wmsChatTurnDefinition: ConversationNodeDefinition<WmsChatState> = {
  kind: WMS_CHAT_TURN_DATA_KEY,
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call' && event.data.name === WMS_CHAT_TOOL_NAME) {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('wms-chat start requires turn/start')
    return { turn: match.event.data.turn, calls: {} }
  },
  update: (context, match) => {
    if (match.event.type !== 'tool/call') return context.state
    const callId = String(match.event.data.callId)
    const message = relayMessage(match.event.data.arguments)
    if (message === null) return context.state
    return { ...context.state, calls: { ...context.state.calls, [callId]: message } }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    const callIds = Object.keys(context.state.calls)
    if (callIds.length === 0) return null
    const callId = callIds[callIds.length - 1]
    if (callId === undefined) return null
    const message = context.state.calls[callId]
    if (message === undefined) return null
    const value: WmsChatTurnData = { callId, message }
    if (previous?.kind === 'turn'
      && previous.key === WMS_CHAT_TURN_DATA_KEY
      && isRecord(previous.value)
      && previous.value['callId'] === value.callId
      && previous.value['message'] === value.message) return previous
    return { kind: 'turn', turn: context.state.turn, key: WMS_CHAT_TURN_DATA_KEY, value }
  },
}
