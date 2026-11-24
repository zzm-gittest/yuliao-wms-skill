/**
 * Main-chat integration: a user-invocable skill (`/yuliao-wms`) plus a
 * model-facing tool (`wms_ai_chat`).
 *
 * Relay mode: the main dsh chat IS the WMS assistant conversation. Each user
 * message is forwarded verbatim to the WMS PC AI state machine through the
 * tool, and the model echoes WMS's reply back into the chat stream without
 * adding anything. dsh-session -> WMS conversationId mapping lives here so
 * the model never handles ids or tokens.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import { readGrant } from './grant.ts'
import { takePendingMessage } from './form.ts'
import { WMS_CREDENTIAL_KEY, type WmsGrant } from './store.ts'
import { WMS_CHAT_TOOL_NAME } from './protocol.ts'

/** Skill name invoked as `/yuliao-wms` in the composer. */
export const WMS_SKILL_NAME = 'yuliao-wms'

/** Tool name exposed to the model once the skill is loaded. */
export const WMS_TOOL_NAME = WMS_CHAT_TOOL_NAME

/** One cached WMS response for the turn-tail card view (raw card JSON included). */
export interface WmsLastState {
  /** Raw WMS card JSON from the latest `wms_ai_chat` reply, null when the reply had no card. */
  readonly card: unknown
  /** WMS reply text. */
  readonly reply: string
  /** State-machine step, e.g. WAIT_CONFIRM_EXEC. */
  readonly step: string
  /** Card type, e.g. CANDIDATE / DIFF_PREVIEW / EXEC_RESULT. */
  readonly cardType: string
}

/** Per dsh session: the latest WMS response, read by the Host state route. */
const lastStates = new Map<string, WmsLastState>()

/** Read the cached latest WMS response for a dsh session (tail card view). */
export function readWmsState(sessionId: string): WmsLastState | undefined {
  return lastStates.get(sessionId)
}

const BT = '`'
/**
 * Skill body injected by tool-skill on `/wms-document`.
 *
 * Relay mode: the model is a dumb pipe. The WMS PC assistant's own state
 * machine drives the conversation; the model forwards each user message and
 * echoes WMS's reply verbatim into the main chat. It must not narrate,
 * analyze, ask its own questions, or add any framing text.
 */
const SKILL_CONTENT = [
  '# WMS 业务单据助手（对话透传模式）',
  '',
  `用户通过 ${BT}/yuliao-wms${BT} 进入 WMS 进销存单据对话（采购单、销售单、出入库等）。这个主聊天框现在就是 WMS AI 助手本人的对话界面：WMS 说什么，你就原样说什么；用户说什么，你就原样转发给 WMS。整个状态机（候选商品→单据预览→确认开单）都在 WMS 侧运行。`,
  '',
  '## 每一轮的动作',
  '',
  `1. 用户每发来一条消息，调用一次 ${BT}${WMS_TOOL_NAME}${BT} 工具。`,
  `2. 把工具返回的 reply 和 card 内容**一字不差地**输出给用户（候选商品列表、单据预览的每一行都要保留），然后停止，等待用户下一条消息。`,
  '',
  '## message 的传法',
  '',
  '- 默认：用户消息原文，不要改写、不要总结。',
  '- 开单请求规范化（重要）：当用户消息是在**描述一笔新的开单请求**（采购/入库/销售/退货等，含商品名和数量）时，在**原句末尾追加规范化明细段**再发送：原句 + `；` + 每个商品一段 `商品名,数量[,单价]`（多个商品用 `；` 分隔；用户明确说了单价才写第三段，没说就只写 `商品名,数量` 两段，不要补 0）。商品名保留用户原词（去掉"采购/进货/帮我"等动词和"向XX"供应商短语），数量取数值（去掉箱/台/斤等单位），单价按"每X元/单价X元"解析。例：`向牛飞冷链采购3箱苹果，每箱500元` → `向牛飞冷链采购3箱苹果，每箱500元；苹果,3,500`；`采购笔记本 macbook air M5 24G内存 512G存储，100台` → `采购笔记本 macbook air M5 24G内存 512G存储，100台；笔记本 macbook air M5 24G内存512G存储,100`。不要改动原句本身，不要把明细段说给用户听。',
  '- 非开单消息（查询、确认、选择、追问、修改数量等后续对话）保持原句不动，不加明细段。',
  '- 映射规则（重要）：WMS 回复里若带「可选操作」或候选列表，用户用自然语言选择其中一项时（如「批量新增」「创建采购订单」「第2个」），发送该项对应的完整指令（如 `__ACTION__:BATCH_ADD_UNSPEC`、`__SELECT__GOODS:1355`），不要发送选项文字本身。',
  `- 用户在预览卡片点【确认】后，消息就是「确认」二字；卡片表单已由工具自动携带，你照常把「确认」转发给工具即可。`,
  `- 用户想看还能做什么 → 发送 ${BT}__ACTIONS__${BT}。`,
  '- 用户要求退出登录（「退出登录」「注销」等）→ 照常把消息原文转发给工具即可，登出由工具执行，把返回的 reply 原样输出。',
  '- hint 是给你的内部指引，绝对不要输出给用户。',
  '',
  '## 严格禁止',
  '',
  '- 不要说「好的」「我来帮您」「让我为您」之类的自己的开场白或结语，你的回复里只允许出现 WMS 的内容。',
  '- 不要自己分析需求、解释状态机步骤或阶段，不要总结 WMS 接下来会做什么。',
  '- 不要替 WMS 追问用户，也不要替用户回答 WMS 的问题。',
  '- 一轮只调用一次工具；WMS 回复完就停，不要连续调用。',
  '',
  `若工具返回「WMS 未连接」（cardType=AUTH_NEEDED），告诉用户已在下方聊天卡片给出了 WMS 登录窗口：请在卡片里填写 WMS 地址、账号、密码完成登录，登录成功后重新发送刚才的需求即可，除此之外不要输出其他内容。`,
  '',
].join('\n')

/** Per dsh-session WMS conversation id. Process-local; a restart starts fresh. */
const conversations = new Map<string, string>()

/** Resolve the dsh session id from the tool execution context. */
function sessionKey(exec: { agent?: { session: { id: string } } }): string {
  return exec.agent?.session.id ?? 'wms-default'
}

/** Thrown when WMS replies with code 401: the stored token is expired or invalid. */
class WmsAuthError extends Error {}

/** User messages that mean "log out of WMS"; handled locally, never relayed. */
const LOGOUT_RE = /^(退出登录|退出登陆|注销登录|注销|登出|退出\s*wms\s*登录|退出wms)([。！!？?\s]*)$/i

/** Call a WMS JSON API with the stored bearer token, never exposing it to the model. */
async function callWms(
  grant: WmsGrant,
  path: string,
  body: unknown,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const onAbort = (): void => controller.abort()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(grant.baseUrl + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${grant.token}`,
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    })
    const text = await response.text()
    let json: unknown
    try { json = JSON.parse(text) } catch { json = { code: response.status, msg: text } }
    if (json === null || typeof json !== 'object') throw new Error('WMS 返回非 JSON')
    const envelope = json as Record<string, unknown>
    // RuoYi reports auth failures as HTTP 200 + error code (measured: an
    // invalid/expired token yields { code: 403, msg: '没有权限...' } on both
    // /start and /chat; 401 kept for other deployments). Surface them as a
    // dedicated error so the tool asks for an inline re-login.
    if (envelope['code'] === 401 || envelope['code'] === 403 || response.status === 401 || response.status === 403) {
      throw new WmsAuthError('WMS 登录已失效')
    }
    return envelope
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

/** Read the inner payload of a RuoYi `{ code, data, msg }` envelope. */
function payloadOf(envelope: Record<string, unknown>): Record<string, unknown> {
  if (envelope['data'] !== null && typeof envelope['data'] === 'object') {
    return envelope['data'] as Record<string, unknown>
  }
  return envelope
}

/** Preferred column order for card detail tables (WMS PC assistant order). */
const COLUMN_ORDER: readonly string[] = [
  'goods', 'goodsName', 'sku', 'skuName', 'unit', 'unitName',
  'orderQuantity', 'receivedQty', 'beforeQty', 'quantity', 'checkQty', 'diffQty', 'maxQty',
  'price', 'costPrice', 'amount', 'totalAmount',
]

/** Chinese labels for card detail table columns (missing keys fall back to the raw key). */
const COLUMN_LABELS: Record<string, string> = {
  goods: '商品', goodsName: '商品', sku: '规格', skuName: '规格',
  unit: '单位', unitName: '单位',
  orderQuantity: '订单数量', receivedQty: '已处理数量', beforeQty: '账面数',
  quantity: '数量', checkQty: '实盘数量', diffQty: '差异数量', maxQty: '可用上限',
  price: '单价', costPrice: '成本价', amount: '金额', totalAmount: '合计金额',
}

/** Internal columns never shown to the user. */
const HIDDEN_COLUMNS: ReadonlySet<string> = new Set(['skuId', 'sourceLineId', 'id', 'specInfo'])

/** Columns rendered as currency (¥). */
const CURRENCY_COLUMNS: ReadonlySet<string> = new Set(['price', 'costPrice', 'amount', 'totalAmount'])

/** Render a numeric value as ¥ currency; empty string when not numeric. */
function formatMoney(value: unknown): string {
  const num = typeof value === 'number' ? value : Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(num)) return ''
  return `¥${num.toFixed(2)}`
}

/** Reorder raw column keys into the WMS PC presentation order. */
function orderColumns(columns: Iterable<string>): string[] {
  const rank = (key: string): number => {
    const index = COLUMN_ORDER.indexOf(key)
    return index === -1 ? COLUMN_ORDER.length + 99 : index
  }
  return [...columns].sort((a, b) => rank(a) - rank(b))
}

/** Render object rows as a Markdown table with Chinese headers and ¥ amounts. */
function renderDetailTable(objects: readonly Record<string, unknown>[]): string[] {
  const columns = orderColumns([...new Set(objects.flatMap(row => Object.keys(row)
    .filter(key => !HIDDEN_COLUMNS.has(key)
      && row[key] !== null && row[key] !== undefined && typeof row[key] !== 'object')))])
  if (columns.length === 0) return []
  const lines = [
    '',
    `| ${columns.map(column => COLUMN_LABELS[column] ?? column).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
  ]
  for (const row of objects) {
    lines.push(`| ${columns.map(column => CURRENCY_COLUMNS.has(column)
      ? formatMoney(row[column]) : String(row[column] ?? '')).join(' | ')} |`)
  }
  lines.push('')
  return lines
}

/** Render any card-like object to compact, model-readable Chinese text. */
function describeCard(card: unknown): string {
  if (card === null || card === undefined) return ''
  if (typeof card === 'string') return card
  if (typeof card !== 'object') return String(card)
  const value = card as Record<string, unknown>
  const type = typeof value['type'] === 'string' ? value['type'] : ''
  const title = typeof value['title'] === 'string' ? value['title'] : ''

  // DIFF_PREVIEW / EXEC_RESULT: every detail (title, header info, table,
  // buttons) is rendered by the tail card in the UI. Emit no card text at all
  // so the model relays only the WMS reply sentence.
  if (type === 'DIFF_PREVIEW' || type === 'EXEC_RESULT') return ''

  const lines: string[] = []
  if (title) lines.push(`【${title}】`)
  const text = value['text'] ?? value['message'] ?? value['content']
  if (typeof text === 'string' && text) lines.push(text)
  const rows = value['rows'] ?? value['items'] ?? value['details']
  if (Array.isArray(rows) && rows.length > 0) {
    const objects = rows.filter((row): row is Record<string, unknown> =>
      row !== null && typeof row === 'object' && !Array.isArray(row))
    if (objects.length === rows.length) {
      // Render as a Markdown table so the relayed reply shows a real table in chat.
      lines.push(...renderDetailTable(objects))
    } else {
      for (const row of rows) {
        if (typeof row === 'string') { lines.push(`- ${row}`); continue }
        if (row !== null && typeof row === 'object') {
          const cells = Object.entries(row as Record<string, unknown>)
            .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
            .map(([k, v]) => `${k}=${String(v)}`)
          lines.push(`- ${cells.join('，')}`)
        }
      }
    }
  }
  if (lines.length === 0) return type ? `卡片类型：${type}` : JSON.stringify(value)
  return type ? `[${type}] ${lines.join('\n')}` : lines.join('\n')
}

/** Extract clickable chips (label → internal command) from a raw card. */
function chipsOf(card: unknown): readonly (readonly [string, string])[] {
  if (card === null || typeof card !== 'object') return []
  const value = card as Record<string, unknown>
  const source = value['chips'] ?? value['actions'] ?? value['quickActions'] ?? value['options'] ?? value['choices']
  const entries: unknown[] = Array.isArray(source) ? [...source] : []
  // Candidate cards carry the "none of these" escape in `otherOption`.
  if (value['otherOption'] !== null && typeof value['otherOption'] === 'object') {
    entries.push(value['otherOption'])
  }
  const result: (readonly [string, string])[] = []
  for (const entry of entries) {
    if (typeof entry === 'string') { result.push([entry, entry]); continue }
    if (entry === null || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const message = typeof item['message'] === 'string' ? item['message']
      : typeof item['value'] === 'string' ? item['value'] : ''
    if (message === '') continue
    const label = typeof item['label'] === 'string' ? item['label']
      : typeof item['name'] === 'string' ? item['name'] : message
    result.push([label, message])
  }
  return result
}

/** Next-step guidance derived from state-machine step and card type. */
function hintFor(step: string, cardType: string): string {
  if (cardType === 'CANDIDATE' || step.includes('GOODS')) return '把候选商品列给用户请选择；用户选定后发送 __SELECT__GOODS:<商品id>'
  if (cardType === 'DIFF_PREVIEW' || step.includes('CONFIRM')) return '单据标题、供应商/客户/仓库选择、明细表格和确认取消按钮都由界面下方的可编辑卡片展示，你只输出 reply 原文这一句话，不要输出卡片标题、供应商或任何说明文字，不要自己画表格；用户在卡片点【确认】后消息就是「确认」，照常转发即可；用户直接说「确认/同意」时发送 确认'
  if (cardType === 'EXEC_RESULT' || step.includes('DONE') || step.includes('FINISH')) return '单据头信息（类型/单号/供应商/日期/总金额/状态）、明细表格和修改/审核/删除按钮都由界面下方的执行结果卡片展示，你只输出 reply 原文这一句话，不要输出任何表格、[EXEC_RESULT] 或说明文字'
  if (cardType === 'ACTION_LIST' || step.includes('ACTION')) return '列出可执行动作供用户选择'
  return '按 reply 内容继续追问用户，把回答作为 message 发送'
}

/** Internal mapping for typed chip selection; never shown to the user. */
function chipsHint(card: unknown): string {
  const mapping = chipsOf(card)
    .filter(([label, message]) => message !== label)
    .map(([label, message]) => `${label} → ${message}`)
    .join('；')
  if (mapping === '') return ''
  return `；用户用文字选择操作时的指令映射（仅供内部转发，绝对不要输出给用户）：${mapping}`
}

/** Register the skill contribution and the model-facing WMS tool. */
export function registerAgentIntegration(ctx: Context, timeoutMs: number): void {
  ctx.effect(() => ctx.skills.register({
    name: WMS_SKILL_NAME,
    description: '创建/处理 WMS 进销存业务单据（采购单、销售单、出库/入库等）。用户输入 /yuliao-wms 后进入单据创建对话：自然语言描述需求→选商品→核对预览→确认开单。仅在用户显式调用本 skill 时使用。',
    source: 'runtime' as const,
    content: SKILL_CONTENT,
    invocation: { modelInvocable: false, userInvocable: true },
  }), 'wms-ai: document skill')

  // Relay tool: forwards one message per turn to the WMS PC AI state machine
  // and returns its reply verbatim. The model echoes it into the main chat;
  // there is no embedded card in this mode.
  ctx.effect(() => ctx.tools.register(defineTool({
    name: WMS_TOOL_NAME,
    description: 'Send one message to the connected WMS PC AI assistant and return its current state, reply and card. Use only after /yuliao-wms skill is loaded. Each call advances the document-creation state machine by one step.',
    parameters: {
      message: {
        type: 'string',
        required: true,
        description: 'The message to send to WMS: the user request verbatim, a selection like __SELECT__GOODS:1355, 确认 to execute, __ACTIONS__ for the action list, or __CLEAR__ to clear context.',
      },
      reset: {
        type: 'boolean',
        description: 'Set true to end the current WMS conversation and start a new one before sending the message.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          conversationId: { type: 'string', required: true },
          step: { type: 'string', required: true },
          reply: { type: 'string', required: true },
          cardType: { type: 'string', required: true },
          card: { type: 'string', required: true },
          hint: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const parts = [
          value.ok ? '' : '⚠️ WMS 调用未成功。',
          value.reply,
          value.card,
          `👉 ${value.hint}`,
        ].filter(part => part !== '')
        return [{ type: 'text' as const, text: parts.join('\n\n') }]
      },
    },
    presentCall: (args) => ({
      card: 'generic' as const,
      title: `WMS 助手：${args.message.slice(0, 40)}`,
      kind: 'other' as const,
      rawInput: args.message,
    }),
    async execute(args, exec) {
      const key = sessionKey(exec)
      const grant = await readGrant(ctx)

      // "退出登录" style requests: log out locally (and best-effort on the WMS
      // side) instead of relaying the text into the document state machine.
      if (LOGOUT_RE.test(args.message.trim())) {
        if (grant === undefined) {
          lastStates.set(key, { card: null, reply: '当前没有登录 WMS。', step: '', cardType: '' })
          return {
            ok: true, conversationId: '', step: '', reply: '当前没有登录 WMS，无需退出。',
            cardType: '', card: '', hint: '告知用户当前未登录 WMS。',
          }
        }
        // Best-effort server-side logout so the JWT is invalidated on WMS too;
        // a dead/invalid token here is fine, the local grant is dropped anyway.
        try {
          await callWms(grant, '/logout', {}, Math.min(timeoutMs, 10_000), exec.signal)
        } catch { /* ignore: token may already be expired */ }
        await ctx.credentials.deleteRecord(WMS_CREDENTIAL_KEY)
        conversations.delete(key)
        const reply = `已退出 WMS 登录（${grant.loginUser}）。下次使用 WMS 助手时，会直接在聊天里给出登录窗口。`
        lastStates.set(key, { card: null, reply, step: 'LOGGED_OUT', cardType: '' })
        return {
          ok: true, conversationId: '', step: 'LOGGED_OUT', reply,
          cardType: '', card: '', hint: '告知用户已退出登录；下次使用会先在聊天里弹出登录窗口。',
        }
      }

      if (grant === undefined) {
        // No grant: surface the inline sign-in card in the chat tail instead of
        // sending the user to the (removed) right-sidebar panel.
        lastStates.set(key, { card: null, reply: '', step: '', cardType: 'AUTH_NEEDED' })
        return {
          ok: false, conversationId: '', step: '', reply: 'WMS 未连接。已在下方聊天卡片给出 WMS 登录窗口，请填写 WMS 地址、账号、密码完成登录，然后重新发送你的需求。',
          cardType: 'AUTH_NEEDED', card: '', hint: '提示用户在下方卡片完成 WMS 登录。',
        }
      }

      let conversationId = conversations.get(key)
      // Card submissions (confirm forms, action chips) stage their internal
      // payload on the Host and send a friendly text as the user message;
      // swap the payload in here so raw commands never enter the transcript.
      let message = args.message
      const stagedMessage = takePendingMessage(key)
      if (stagedMessage !== undefined && stagedMessage.visible === args.message) {
        message = stagedMessage.payload
      }
      try {
        if (args.reset === true || conversationId === undefined) {
          const startEnvelope = await callWms(grant, '/wms/ai/pc/start', {}, timeoutMs, exec.signal)
          const start = payloadOf(startEnvelope)
          const cid = start['conversationId'] ?? start['id']
          if (typeof cid !== 'string' || cid === '') throw new Error('WMS 未返回 conversationId')
          conversationId = cid
          conversations.set(key, cid)
        }

        const envelope = await callWms(grant, '/wms/ai/pc/chat', {
          conversationId,
          message,
        }, timeoutMs, exec.signal)
        console.log(`[wms-ai] chat session=${key} conversation=${conversationId} message=${JSON.stringify(message)} reset=${String(args.reset === true)}`)
        const data = payloadOf(envelope)
        console.log(`[wms-ai] chat response: ${JSON.stringify(envelope).slice(0, 1500)}`)
        const code = typeof data['code'] === 'number' ? data['code'] : typeof envelope['code'] === 'number' ? envelope['code'] : 0
        const context = data['context'] !== null && typeof data['context'] === 'object'
          ? data['context'] as Record<string, unknown> : {}
        const step = typeof context['step'] === 'string' ? context['step'] : ''
        const cardValue = data['card']
        const cardTypeValue = cardValue !== null && typeof cardValue === 'object'
          ? (cardValue as Record<string, unknown>)['type'] : undefined
        const cardType = typeof cardTypeValue === 'string' ? cardTypeValue : ''
        const reply = typeof data['text'] === 'string' ? data['text']
          : typeof data['msg'] === 'string' ? data['msg'] : ''
        const ok = code === 200 || code === 0
        if (ok) {
          // Cache for the turn-tail card view (GET /api/wms-ai/state).
          lastStates.set(key, { card: cardValue ?? null, reply, step, cardType })
        }
        return {
          ok,
          conversationId,
          step,
          reply,
          cardType,
          card: describeCard(cardValue),
          hint: hintFor(step, cardType) + chipsHint(cardValue),
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        if (error instanceof WmsAuthError) {
          // Stored token expired or revoked: ask for a fresh sign-in inline.
          lastStates.set(key, { card: null, reply: '', step: '', cardType: 'AUTH_NEEDED' })
          return {
            ok: false, conversationId: '', step: '', reply: 'WMS 登录已失效。已在下方聊天卡片给出 WMS 登录窗口，请重新登录后再发送你的需求。',
            cardType: 'AUTH_NEEDED', card: '', hint: '提示用户在下方卡片重新登录 WMS。',
          }
        }
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false, conversationId: conversationId ?? '', step: '', reply: `WMS 请求失败：${message}`,
          cardType: '', card: '', hint: '让用户重试，或检查 WMS 是否在运行。',
        }
      }
    },
  })), 'wms-ai: chat tool')
}
