/**
 * WMS AI assistant plugin, browser half: register the relay turn-tail card
 * (table + action buttons, and the inline WMS sign-in card when not
 * authenticated) shown under the assistant's reply for turns that called the
 * `wms_ai_chat` tool. All WMS calls go through the Host's authenticated /api
 * routes; the JWT never reaches the browser.
 *
 * The old right-sidebar panel is gone: the main chat itself is the WMS
 * conversation, and sign-in happens inline in the chat tail when the relay
 * tool reports AUTH_NEEDED.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { WmsChatTail } from './WmsChatTail.tsx'
import { bindTailContext } from './WmsChatTail.tsx'
import { wmsChatTurnDefinition } from './turn-wms.ts'

/** Required browser services: slots, the turn-data registry, and session sends. */
export const inject = ['slots', 'uiConversation', 'sessions']

/**
 * Client plugin body.
 * @param ctx - client root context carrying the slot and tab registries.
 */
export function apply(ctx: ClientContext): void {
  bindTailContext(ctx as unknown as Parameters<typeof bindTailContext>[0])

  // Relay mode: the main chat itself is the WMS conversation (skill
  // `/yuliao-wms` + `wms_ai_chat` tool, host half). The turn tail renders
  // the latest WMS card as a table with clickable actions that send their
  // message into the conversation as the user; when the tool reports
  // AUTH_NEEDED it renders the inline WMS sign-in card instead.
  ctx.effect(() => ctx.uiConversation.events.register(wmsChatTurnDefinition), 'wms-ai: relay turn definition')
  ctx.effect(() => ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
    { name: 'conversation.chat.turnTail', id: '@deepseek-ai/dsh-wms-ai' },
    WmsChatTail,
  )), 'wms-ai: relay turn-tail card')
}
