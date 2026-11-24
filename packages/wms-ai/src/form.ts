/**
 * Per-dsh-session staging of card-submitted payloads (`__FORM__` / `__ACTION__`
 * / `__SELECT__...`).
 *
 * When the user submits a tail card or clicks an action chip, the client posts
 * the internal payload here together with the friendly text to display, then
 * sends that friendly text as the user message — so raw commands never appear
 * in the chat transcript. The relay tool picks the staged payload up on the
 * next `wms_ai_chat` call and forwards it to WMS.
 */

/** One staged card submission: the WMS payload and the visible user text. */
export interface PendingMessage {
  readonly payload: string
  readonly visible: string
}

/** session id -> pending staged message (consumed once). */
const pendingMessages = new Map<string, PendingMessage>()

/** Stage a payload for the next relay call of this session. */
export function stagePendingMessage(sessionId: string, message: PendingMessage): void {
  pendingMessages.set(sessionId, message)
}

/** Take (and clear) the staged message; undefined when nothing staged. */
export function takePendingMessage(sessionId: string): PendingMessage | undefined {
  const value = pendingMessages.get(sessionId)
  if (value !== undefined) pendingMessages.delete(sessionId)
  return value
}
