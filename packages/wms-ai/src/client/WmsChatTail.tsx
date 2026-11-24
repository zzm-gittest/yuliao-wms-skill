/**
 * Turn-tail card for the WMS relay conversation. Rendered through
 * `conversation.chat.turnTail` (outside the foldable process disclosure), it
 * mirrors the WMS PC assistant's interactive cards:
 *  - DIFF_PREVIEW: editable detail table (quantity / price inputs, supplier
 *    picks, live totals) with confirm/cancel;
 *  - GOODS_CREATE_FORM / GOODS_SPEC_FORM / GOODS_SKU_SKU: the single-goods
 *    creation flow (name/unit/category, multi-spec editor, SKU list);
 *  - other cards: clickable action chips.
 *
 * Every internal payload (`__FORM__` / `__ACTION__` / `__SELECT__...`) is
 * staged on the Host first, then sent as a friendly user text, so raw
 * commands never appear in the transcript. The relay tool picks the staged
 * payload up and forwards it to the WMS state machine.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { WMS_API_PATH, WMS_AUTH_PATH, WMS_FORM_PATH, WMS_STATE_PATH } from '../protocol.ts'
import type { WmsLastState } from '../agent.ts'
import { WMS_CHAT_TURN_DATA_KEY, type WmsChatTurnData } from './turn-wms.ts'
import css from './WmsPanel.module.css'

/** JSON object shape used for WMS payloads. */
type JsonObject = Record<string, unknown>

/** One clickable action chip. */
interface Chip {
  readonly label: string
  readonly message: string
}

/** One selectable option (supplier / customer / warehouse / unit). */
interface Opt {
  readonly id: string
  readonly label: string
}

/** Option lists loaded through the Host WMS proxy for the editable selects. */
interface OptionLists {
  readonly suppliers: readonly Opt[]
  readonly customers: readonly Opt[]
  readonly warehouses: readonly Opt[]
  readonly units: readonly Opt[]
  readonly categories: readonly Opt[]
}

/** Local editable state of one preview row (mirrors the WMS PC form model). */
interface RowState {
  readonly sourceLineId: string
  readonly skuId: string
  readonly goods: string
  readonly sku: string
  unit: string
  quantity: string
  price: string
  readonly beforeQty: string
  readonly maxQty: string
  readonly orderQuantity: string
  readonly receivedQty: string
  /** Original amount from the card, used when quantity/price are not both set. */
  readonly amountRaw: string
}

/** One editable spec row of the multi-spec editor (GOODS_SPEC_FORM). */
interface SpecState {
  specName: string
  values: string[]
}

/** One editable SKU row of the SKU list card (GOODS_SKU_FORM). */
interface SkuRowState {
  readonly specInfo: string
  skuName: string
  readonly unitName: string
  quantity: string
  price: string
}

/** Local editable state of the goods create form (GOODS_CREATE_FORM). */
interface GoodsFormState {
  goodsName: string
  unitName: string
  categoryId: string
}

/** Normalized view of the latest WMS card for the tail. */
interface TailCard {
  readonly title: string
  /** Card type, e.g. CANDIDATE / DIFF_PREVIEW / GOODS_CREATE_FORM. */
  readonly type: string
  /** WMS domain, e.g. PURCHASE_ORDER / SALES_OUT / STOCK_CHECK. */
  readonly domainType: string
  /** Partner/warehouse meta lines, e.g. 仓库：主仓. */
  readonly meta: readonly string[]
  /** Whether the WMS card allows editing rows before confirm. */
  readonly editable: boolean
  /** Whether the price column is editable. */
  readonly allowPriceEdit: boolean
  /** Whether a positive price is required on confirm (defaults to true). */
  readonly priceRequired: boolean
  /** Whether the supplier can be picked on the card. */
  readonly allowSupplierEdit: boolean
  /** Whether the customer can be picked on the card. */
  readonly allowCustomerEdit: boolean
  /** Whether the warehouse can be picked on the card. */
  readonly allowWarehouseEdit: boolean
  readonly supplierId: string
  readonly warehouseId: string
  readonly customerId: string
  /** EXEC_RESULT card fields. */
  readonly id: string
  readonly billNo: string
  readonly orderDate: string
  readonly orderStatus: string
  readonly totalAmount: string
  readonly partner: string
  readonly warehouseName: string
  /** Goods create form fields (GOODS_CREATE_FORM). */
  readonly goodsName: string
  readonly goodsUnit: string
  readonly categoryId: string
  /** Spec rows (GOODS_SPEC_FORM). */
  readonly specs: readonly SpecState[]
  /** SKU rows (GOODS_SKU_FORM). */
  readonly skuRows: readonly JsonObject[]
  readonly rows: readonly JsonObject[]
  readonly chips: readonly Chip[]
}

/** Client root context, assigned by `apply` for scope-addressed sends. */
let clientContext: {
  sessions: { scope(id: string): { get(service: 'conversation'): { send(text: string): Promise<void> } | undefined } | undefined }
} | null = null

/** Assign the client context used by tail buttons to send user messages. */
export function bindTailContext(ctx: NonNullable<typeof clientContext>): void {
  clientContext = ctx
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function firstString(...values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

/** Numeric id (or null) rendered as a plain string; empty when absent. */
function idString(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim() !== '' && value.trim() !== 'null') return value.trim()
  return ''
}

/** Sanitize a decimal input like the WMS PC page: digits, one dot, ≤2 decimals. */
function normalizeNumberInput(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value)
  const cleaned = text
    .replace(/[^\d.]/g, '')
    .replace(/\.(?=.*\.)/g, '')
    .replace(/^(\d+\.\d{0,2}).*$/, '$1')
  return cleaned.startsWith('.') ? `0${cleaned}` : cleaned
}

/** Human label for a chip message token. */
function chipLabel(message: string): string {
  if (message.startsWith('__ACTION__:')) return message.slice('__ACTION__:'.length)
  if (message.startsWith('__SELECT__GOODS:')) return `选择商品 ${message.slice('__SELECT__GOODS:'.length)}`
  if (message.startsWith('__FORM__')) return '按此表单提交'
  return message
}

function parseChips(value: unknown): readonly Chip[] {
  const chips: Chip[] = []
  for (const entry of arrayOf(value)) {
    if (typeof entry === 'string') {
      chips.push({ label: chipLabel(entry), message: entry })
      continue
    }
    if (!isObject(entry)) continue
    const message = firstString(entry['message'], entry['value'], entry['action'], entry['code'], entry['id'])
    if (message === '') continue
    chips.push({ label: firstString(entry['label'], entry['name'], entry['title'], entry['text']) || chipLabel(message), message })
  }
  return chips
}

/** Parse a WMS spec form row into the editable spec state. */
function parseSpecRow(row: JsonObject): SpecState {
  return {
    specName: typeof row['specName'] === 'string' ? row['specName'] : '',
    values: arrayOf(row['values']).map(value =>
      isObject(value) && typeof value['specValue'] === 'string' ? value['specValue'] : ''),
  }
}

/** Human-readable display of a SKU specInfo (string or object). */
function formatSpecInfo(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(entry => formatSpecInfo(entry)).filter(text => text !== '').join('；')
  }
  if (isObject(value)) {
    return Object.entries(value)
      .filter(([key]) => key !== 'id')
      .map(([key, entry]) => `${key}：${String(entry)}`)
      .join('；')
  }
  return ''
}

/** Partner/warehouse meta keys shown for a DIFF_PREVIEW card. The third
 * element is the TailCard flag that replaces the line with a dropdown; ''
 * means always show the meta line. */
const PREVIEW_META: readonly (readonly [string, string, string])[] = [
  ['supplier', '供应商', 'allowSupplierEdit'],
  ['customer', '客户', 'allowCustomerEdit'],
  ['warehouse', '仓库', 'allowWarehouseEdit'],
  ['outWarehouse', '调出仓库', ''],
  ['inWarehouse', '调入仓库', ''],
  ['linkOrderNo', '关联单号', ''],
]

/** Parse a raw WMS card JSON into the tail view; null when it has no visible content. */
function parseTailCard(raw: unknown): TailCard | null {
  if (!isObject(raw)) return null
  const type = firstString(raw['type'], raw['cardType'])
  if (type === '') return null
  const formModel = isObject(raw['formModel']) ? raw['formModel'] as JsonObject : {}
  const editable = raw['editable'] === true
  const rowsSource = editable && Array.isArray(formModel['items']) ? formModel['items'] : raw['items']
  const meta: string[] = []
  for (const [key, label, editFlag] of PREVIEW_META) {
    // Skip lines that the inline dropdown already covers.
    if (editFlag !== '' && raw[editFlag] === true) continue
    const entry = raw[key]
    if (typeof entry === 'string' && entry !== '') meta.push(`${label}：${entry}`)
  }
  const chipsSource = type === 'CANDIDATE'
    ? (raw['options'] ?? raw['choices'] ?? raw['actions'] ?? raw['quickActions'])
    : (raw['actions'] ?? raw['quickActions'] ?? raw['options'] ?? raw['choices'])
  // Candidate cards (goods / supplier / warehouse / customer) carry the
  // "none of these" escape hatch in a separate `otherOption` field.
  const chipEntries: unknown[] = Array.isArray(chipsSource) ? [...chipsSource] : []
  if (isObject(raw['otherOption'])) chipEntries.push(raw['otherOption'])
  const specSource = Array.isArray(formModel['specs']) ? formModel['specs'] : raw['specs']
  const skuSource = Array.isArray(formModel['skuList']) ? formModel['skuList'] : raw['skuList']
  return {
    type,
    title: firstString(raw['title'], raw['name']),
    domainType: firstString(raw['domainType']),
    meta,
    editable,
    allowPriceEdit: raw['allowPriceEdit'] === true,
    priceRequired: raw['priceRequired'] !== false,
    allowSupplierEdit: raw['allowSupplierEdit'] === true,
    allowCustomerEdit: raw['allowCustomerEdit'] === true,
    allowWarehouseEdit: raw['allowWarehouseEdit'] === true,
    supplierId: idString(formModel['supplierId']),
    warehouseId: idString(formModel['warehouseId']),
    customerId: idString(formModel['customerId']),
    id: idString(raw['id']),
    billNo: firstString(raw['billNo'], raw['orderNo'], raw['inNo'], raw['returnNo'], raw['checkNo']),
    orderDate: firstString(raw['orderDate'], raw['inDate'], raw['returnDate']),
    orderStatus: firstString(raw['orderStatus'], raw['approveStatus'], raw['checkStatus']),
    totalAmount: normalizeNumberInput(raw['totalAmount']),
    partner: firstString(raw['partner'], raw['supplierName'], raw['customerName']),
    warehouseName: firstString(raw['warehouse'], raw['warehouseName']),
    goodsName: typeof formModel['goodsName'] === 'string' ? formModel['goodsName'] : '',
    goodsUnit: typeof formModel['unitName'] === 'string' ? formModel['unitName'] : '',
    categoryId: idString(formModel['categoryId']),
    specs: arrayOf(specSource).filter(isObject).map(parseSpecRow),
    skuRows: arrayOf(skuSource).filter(isObject),
    rows: arrayOf(rowsSource).filter(isObject),
    chips: parseChips(chipEntries),
  }
}

/** Initialize editable row state from the raw card rows. */
function initRows(rows: readonly JsonObject[]): readonly RowState[] {
  return rows.map(row => ({
    sourceLineId: idString(row['sourceLineId']),
    skuId: idString(row['skuId']),
    goods: typeof row['goods'] === 'string' ? row['goods'] : '',
    sku: typeof row['sku'] === 'string' ? row['sku'] : '',
    unit: typeof row['unit'] === 'string' ? row['unit'] : '',
    quantity: normalizeNumberInput(row['quantity']),
    price: normalizeNumberInput(row['price']),
    beforeQty: normalizeNumberInput(row['beforeQty']),
    maxQty: normalizeNumberInput(row['maxQty']),
    orderQuantity: normalizeNumberInput(row['orderQuantity']),
    receivedQty: normalizeNumberInput(row['receivedQty']),
    amountRaw: normalizeNumberInput(row['amount']),
  }))
}

/** Initialize editable SKU rows from the GOODS_SKU_FORM card. */
function initSkuRows(rows: readonly JsonObject[]): readonly SkuRowState[] {
  return rows.map(row => ({
    specInfo: formatSpecInfo(row['specInfo']),
    skuName: typeof row['skuName'] === 'string' ? row['skuName'] : '',
    unitName: typeof row['unitName'] === 'string' ? row['unitName'] : '',
    quantity: normalizeNumberInput(row['quantity']),
    price: normalizeNumberInput(row['price']),
  }))
}

/** Format a numeric string/number as ¥ currency; em dash when not numeric. */
function money(value: string | number | null): string {
  const num = typeof value === 'number' ? value : value === '' || value === null ? Number.NaN : Number(value)
  if (!Number.isFinite(num)) return '—'
  return `¥${num.toFixed(2)}`
}

/** Live amount of a row: quantity × price when both are set, else the card amount. */
function rowAmount(row: RowState): number | null {
  const quantity = Number(row.quantity)
  const price = Number(row.price)
  if (row.quantity !== '' && row.price !== '' && Number.isFinite(quantity) && Number.isFinite(price)) {
    return quantity * price
  }
  const raw = Number(row.amountRaw)
  return row.amountRaw !== '' && Number.isFinite(raw) ? raw : null
}

/** Load a supplier/customer/warehouse/unit option list through the Host WMS proxy. */
async function fetchOptions(path: string, nameKey: string): Promise<readonly Opt[]> {
  try {
    const response = await fetch(WMS_API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, method: 'GET' }),
    })
    const payload = await response.json() as unknown
    if (!isObject(payload) || payload['ok'] !== true) return []
    const data = payload['data']
    const list = isObject(data)
      ? (Array.isArray(data['data']) ? data['data'] : Array.isArray(data['rows']) ? data['rows'] : [])
      : Array.isArray(data) ? data : []
    return list.filter(isObject).map(row => ({
      id: idString(row['id']),
      label: firstString(row[nameKey], row['name']),
    })).filter(option => option.id !== '' && option.label !== '')
  } catch {
    return []
  }
}

/** Load the goods category tree through the Host WMS proxy, flattened. */
async function fetchCategoryOptions(): Promise<readonly Opt[]> {
  try {
    const response = await fetch(WMS_API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/wms/goodsCategory/list', method: 'GET' }),
    })
    const payload = await response.json() as unknown
    if (!isObject(payload) || payload['ok'] !== true) return []
    const data = payload['data']
    const tree = isObject(data)
      ? (Array.isArray(data['data']) ? data['data'] : Array.isArray(data['rows']) ? data['rows'] : [])
      : Array.isArray(data) ? data : []
    const result: Opt[] = []
    const walk = (items: readonly unknown[]): void => {
      for (const item of items) {
        if (!isObject(item)) continue
        if (item['status'] === '1') continue
        const id = idString(item['id'])
        const label = firstString(item['categoryName'], item['name'])
        if (id !== '' && label !== '') result.push({ id, label })
        if (Array.isArray(item['children'])) walk(item['children'])
      }
    }
    walk(tree)
    return result
  } catch {
    return []
  }
}

/** Create a unit or a top-level goods category through the WMS proxy. Returns the new id or ''. */
async function createUnitOrCategory(path: string, body: JsonObject): Promise<{ ok: boolean; id: string; msg: string }> {
  try {
    const response = await fetch(WMS_API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, method: 'POST', body }),
    })
    const payload = await response.json() as unknown
    if (!isObject(payload) || payload['ok'] !== true) return { ok: false, id: '', msg: '创建失败，请稍后重试' }
    const result = payload['data']
    if (!isObject(result) || result['code'] !== 200) {
      const msg = isObject(result) && typeof result['msg'] === 'string' ? result['msg'] : '创建失败，请稍后重试'
      return { ok: false, id: '', msg }
    }
    return { ok: true, id: idString(result['data']), msg: '' }
  } catch {
    return { ok: false, id: '', msg: '创建失败，请稍后重试' }
  }
}

/** Validate the edited rows with the WMS PC rules; returns an error message or ''. */
function validateRows(
  card: TailCard,
  rows: readonly RowState[],
  selection: { readonly supplierId: string; readonly customerId: string; readonly warehouseId: string },
): string {
  if (rows.length === 0) return '至少保留一条商品明细'
  if (card.allowSupplierEdit && selection.supplierId === '') return '请先选择供应商'
  if (card.allowCustomerEdit && selection.customerId === '') return '请先选择客户'
  if (card.allowWarehouseEdit && selection.warehouseId === '') return '请先选择仓库'
  for (const row of rows) {
    const quantity = Number(row.quantity)
    if (row.quantity === '' || !Number.isFinite(quantity) || quantity <= 0) {
      return `商品【${row.goods || row.sku || '未知'}】数量必须大于 0`
    }
    const maxQty = row.maxQty === '' ? null : Number(row.maxQty)
    if (maxQty !== null && Number.isFinite(maxQty) && quantity > maxQty) {
      return `商品【${row.goods || row.sku || '未知'}】数量不能超过上限 ${row.maxQty}`
    }
    if (card.allowPriceEdit && card.priceRequired) {
      const price = Number(row.price)
      if (row.price === '' || !Number.isFinite(price) || price <= 0) {
        return `商品【${row.goods || row.sku || '未知'}】单价必须大于 0，请在卡片中录入`
      }
    }
  }
  return ''
}

/** Build the `__FORM__` payload the WMS state machine expects on confirm. */
function buildFormPayload(
  rows: readonly RowState[],
  selection: { readonly supplierId: string; readonly customerId: string; readonly warehouseId: string },
): string {
  const items = rows.map(row => {
    const item: JsonObject = {}
    if (row.sourceLineId !== '') item['sourceLineId'] = Number(row.sourceLineId)
    if (row.skuId !== '') item['skuId'] = Number(row.skuId)
    if (row.unit !== '') item['unit'] = row.unit
    item['quantity'] = Number(row.quantity)
    item['price'] = row.price === '' ? null : Number(row.price)
    if (row.maxQty !== '') item['maxQty'] = Number(row.maxQty)
    return item
  })
  const form: JsonObject = { items, _submitAction: 'CONFIRM_EXEC' }
  if (selection.supplierId !== '') form['supplierId'] = Number(selection.supplierId)
  if (selection.warehouseId !== '') form['warehouseId'] = Number(selection.warehouseId)
  if (selection.customerId !== '') form['customerId'] = Number(selection.customerId)
  return '__FORM__' + JSON.stringify(form)
}

/** Build the `__FORM__` payload for the goods create / spec / sku cards. */
function buildGoodsFormPayload(
  base: { readonly goodsName: string; readonly goodsUnit: string },
  submitAction: string,
  extra: (form: JsonObject) => void,
): string {
  const form: JsonObject = {
    goodsName: base.goodsName,
    unitName: base.goodsUnit,
    _submitAction: submitAction,
  }
  extra(form)
  return '__FORM__' + JSON.stringify(form)
}

/** Metadata of one executable WMS domain (EXEC_RESULT card actions). */
interface ExecDomain {
  readonly label: string
  readonly partnerLabel: string
  readonly basePath: string
  readonly hasWarehouse: boolean
}

/** Domains whose 修改/审核/删除 actions are wired to WMS REST endpoints. */
const EXEC_DOMAINS: Readonly<Record<string, ExecDomain>> = {
  PURCHASE_ORDER: { label: '采购订单', partnerLabel: '供应商', basePath: '/wms/purchaseOrder', hasWarehouse: false },
  PO: { label: '采购订单', partnerLabel: '供应商', basePath: '/wms/purchaseOrder', hasWarehouse: false },
  PURCHASE_IN: { label: '采购入库', partnerLabel: '供应商', basePath: '/wms/purchaseIn', hasWarehouse: true },
  PURCHASE_RETURN: { label: '采购退货', partnerLabel: '供应商', basePath: '/wms/purchaseReturn', hasWarehouse: true },
  SALES_ORDER: { label: '销售订单', partnerLabel: '客户', basePath: '/wms/salesOrder', hasWarehouse: false },
}

/** Local display state of an EXEC_RESULT card (kept up to date after actions). */
interface ExecView {
  readonly callKey: string
  readonly domainType: string
  readonly id: string
  readonly billNo: string
  readonly partner: string
  readonly warehouse: string
  readonly orderDate: string
  readonly orderStatus: string
  readonly totalAmount: string
  readonly rows: readonly JsonObject[]
  readonly deleted: boolean
}

/** One editable row of the inline EXEC_RESULT editor. */
interface ExecEditRow {
  readonly index: number
  readonly goods: string
  readonly sku: string
  readonly unit: string
  quantity: string
  price: string
}

/** Call a WMS REST endpoint through the Host proxy; returns the RuoYi payload. */
async function wmsApi(path: string, method: 'GET' | 'PUT' | 'POST' | 'DELETE', body?: unknown): Promise<JsonObject | null> {
  try {
    const response = await fetch(WMS_API_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, method, body }),
    })
    const payload = await response.json() as unknown
    if (!isObject(payload) || payload['ok'] !== true) return null
    return isObject(payload['data']) ? payload['data'] as JsonObject : null
  } catch {
    return null
  }
}

/** Normalize an order object from GET /wms/{domain}/{id} into the ExecView. */
function execViewFromOrder(callKey: string, domainType: string, order: JsonObject): ExecView {
  const items = arrayOf(order['items']).filter(isObject)
  return {
    callKey,
    domainType,
    id: idString(order['id']),
    billNo: firstString(order['orderNo'], order['inNo'], order['returnNo']),
    partner: firstString(order['supplierName'], order['customerName']),
    warehouse: firstString(order['warehouseName']),
    orderDate: firstString(order['orderDate'], order['inDate'], order['returnDate']).slice(0, 10),
    orderStatus: firstString(order['orderStatus'], order['approveStatus']),
    totalAmount: normalizeNumberInput(order['totalAmount']),
    rows: items,
    deleted: false,
  }
}

/** Read the relay call captured for this turn; undefined when the turn made none. */
function turnData(props: PropsRuntime<'conversation.chat.turnTail'>): WmsChatTurnData | undefined {
  const value = props.turn.data.get(WMS_CHAT_TURN_DATA_KEY)
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  const callId = value['callId']
  const message = value['message']
  if (typeof callId !== 'string' || typeof message !== 'string') return undefined
  return { callId, message }
}

/** Send one message into the dsh conversation as the user. */
function sendAsUser(sessionId: string, text: string): void {
  const conversation = clientContext?.sessions.scope(sessionId)?.get('conversation')
  if (conversation === undefined) return
  void conversation.send(text).catch((error: unknown) => {
    console.error('[wms-ai] tail send failed:', error)
  })
}

/** Props of a `conversation.chat.turnTail` entry plus the session standard kit. */
type WmsTailProps = PropsRuntime<'conversation.chat.turnTail'> & { readonly sessionId: string }

/** Column headers of the preview table (order mirrors the WMS PC page). */
function previewHeaders(card: TailCard, rows: readonly RowState[], editable: boolean): readonly string[] {
  const headers = ['商品', '规格', '单位']
  if (rows.some(row => row.orderQuantity !== '')) headers.push('订单数量')
  if (rows.some(row => row.receivedQty !== '')) {
    headers.push(card.domainType === 'SALES_OUT' ? '已出库数量' : '已入库数量')
  }
  if (card.domainType === 'STOCK_CHECK') headers.push('账面数')
  headers.push('数量')
  if (rows.some(row => row.maxQty !== '')) {
    headers.push(card.domainType === 'PURCHASE_RETURN' || card.domainType === 'SALES_RETURN'
      ? '可退货数量' : card.domainType === 'SALES_OUT' ? '可出库数量' : '可用上限')
  }
  headers.push('单价', '金额')
  if (editable) headers.push('操作')
  return headers
}

/**
 * Inline WMS sign-in card rendered in the chat tail when the relay tool
 * reports AUTH_NEEDED (no stored grant, or the stored token got a 401).
 * Replaces the old right-sidebar sign-in panel.
 */
function WmsInlineAuthCard(): ReactNode {
  const [baseUrl, setBaseUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [connectedAs, setConnectedAs] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (username.trim() === '' || password === '') { setError('请输入账号和密码'); return }
    setBusy(true); setError('')
    try {
      const body: Record<string, string> = { username: username.trim(), password }
      if (baseUrl.trim() !== '') body['baseUrl'] = baseUrl.trim()
      const response = await fetch(`${WMS_AUTH_PATH}?action=signin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => null) as unknown
      if (response.ok && isObject(payload) && payload['connected'] === true) {
        setConnectedAs(typeof payload['hint'] === 'string' && payload['hint'] !== '' ? payload['hint'] : username.trim())
      } else {
        setError(isObject(payload) && typeof payload['error'] === 'string' ? payload['error'] : '登录失败，请检查地址、账号和密码')
      }
    } catch (submitError: unknown) {
      setError(`登录失败：${submitError instanceof Error ? submitError.message : String(submitError)}`)
    } finally {
      setBusy(false)
    }
  }

  if (connectedAs !== null) {
    return (
      <div className={css.card} data-wms-tail="AUTH_OK">
        <div className={css.cardTitle}>WMS 已连接</div>
        <div className={css.cardText}>登录账号：{connectedAs}。请重新发送你的需求，继续处理。</div>
      </div>
    )
  }
  return (
    <div className={css.card} data-wms-tail="AUTH_NEEDED">
      <div className={css.cardTitle}>连接 WMS</div>
      <div className={css.cardText}>WMS 未连接或登录已失效，请在此完成登录。</div>
      <div className={css.loginField}>
        <label className={css.loginLabel}>WMS 地址（留空使用默认地址）</label>
        <input className={css.loginInput} value={baseUrl} placeholder="http://127.0.0.1:8080"
          disabled={busy} onChange={event => { setError(''); setBaseUrl(event.target.value) }} />
      </div>
      <div className={css.loginField}>
        <label className={css.loginLabel}>账号</label>
        <input className={css.loginInput} value={username} placeholder="WMS 登录账号"
          disabled={busy} onChange={event => { setError(''); setUsername(event.target.value) }} />
      </div>
      <div className={css.loginField}>
        <label className={css.loginLabel}>密码</label>
        <input className={css.loginInput} type="password" value={password} autoComplete="current-password"
          disabled={busy} onChange={event => { setError(''); setPassword(event.target.value) }}
          onKeyDown={event => { if (event.key === 'Enter') void submit() }} />
      </div>
      {error !== '' && <div className={css.warnText}>{error}</div>}
      <div className={css.cardActions}>
        <button type="button" className={css.primaryButton} disabled={busy}
          onClick={() => void submit()}>{busy ? '登录中…' : '登录'}</button>
      </div>
    </div>
  )
}

/**
 * The tail card: editable preview table + confirm/cancel for DIFF_PREVIEW,
 * goods-creation forms, action chips for other cards. Renders nothing for
 * turns that made no relay call or when WMS returned no card.
 */
export function WmsChatTail(props: WmsTailProps): ReactNode {
  const data = turnData(props)
  const [state, setState] = useState<WmsLastState | null | undefined>(undefined)
  const [rows, setRows] = useState<readonly RowState[] | null>(null)
  const [error, setError] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [options, setOptions] = useState<OptionLists>(
    { suppliers: [], customers: [], warehouses: [], units: [], categories: [] })
  // null = not initialized from the card yet; '' = nothing picked (user must choose).
  const [supplierSel, setSupplierSel] = useState<string | null>(null)
  const [customerSel, setCustomerSel] = useState<string | null>(null)
  const [warehouseSel, setWarehouseSel] = useState<string | null>(null)
  // Goods-creation card states.
  const [goodsForm, setGoodsForm] = useState<GoodsFormState | null>(null)
  const [specs, setSpecs] = useState<readonly SpecState[] | null>(null)
  const [skuRows, setSkuRows] = useState<readonly SkuRowState[] | null>(null)
  // EXEC_RESULT card states (view / inline edit / confirm-before-action).
  const [exec, setExec] = useState<ExecView | null>(null)
  const [editMode, setEditMode] = useState(false)
  const [editRaw, setEditRaw] = useState<JsonObject | null>(null)
  const [editRows, setEditRows] = useState<readonly ExecEditRow[] | null>(null)
  const [editDate, setEditDate] = useState('')
  const [editPartner, setEditPartner] = useState('')
  const [editWarehouse, setEditWarehouse] = useState('')
  const [confirmAsk, setConfirmAsk] = useState<'' | 'approve' | 'delete'>('')
  const [execBusy, setExecBusy] = useState(false)
  const [execError, setExecError] = useState('')
  // Inline "add unit / add category" editors of the goods create form.
  const [unitAddOpen, setUnitAddOpen] = useState(false)
  const [unitAddName, setUnitAddName] = useState('')
  const [unitAddBusy, setUnitAddBusy] = useState(false)
  const [categoryAddOpen, setCategoryAddOpen] = useState(false)
  const [categoryAddName, setCategoryAddName] = useState('')
  const [categoryAddBusy, setCategoryAddBusy] = useState(false)

  const callKey = data?.callId ?? ''
  useEffect(() => {
    if (callKey === '') return
    let live = true
    void (async () => {
      try {
        const response = await fetch(`${WMS_STATE_PATH}?session=${encodeURIComponent(props.sessionId)}`)
        const payload = await response.json() as { ok?: boolean; state?: WmsLastState | null }
        if (live) setState(payload.ok === true ? payload.state ?? null : null)
      } catch {
        if (live) setState(null)
      }
    })()
    return () => { live = false }
  }, [callKey, props.sessionId])

  const card = useMemo(() => state === undefined || state === null ? null : parseTailCard(state.card), [state])

  // Read-only rows for display when the card is not (or no longer) editable.
  const readOnlyRows = useMemo(() => card === null ? [] : initRows(card.rows), [card])

  // Initialize editable rows once an editable preview card arrives. The
  // supplier/customer/warehouse dropdowns start empty: the user picks them
  // explicitly (WMS may remember a previous partner but we do not preselect).
  useEffect(() => {
    if (card === null || rows !== null || !card.editable || card.type !== 'DIFF_PREVIEW') return
    setRows(initRows(card.rows))
    setSupplierSel('')
    setCustomerSel('')
    setWarehouseSel('')
  }, [card, rows])

  // Initialize the goods-creation card states.
  useEffect(() => {
    if (card === null) return
    if (card.type === 'GOODS_CREATE_FORM' && goodsForm === null) {
      setGoodsForm({ goodsName: card.goodsName, unitName: card.goodsUnit, categoryId: card.categoryId })
    }
    if (card.type === 'GOODS_SPEC_FORM' && specs === null) setSpecs(card.specs)
    if (card.type === 'GOODS_SKU_FORM' && skuRows === null) setSkuRows(initSkuRows(card.skuRows))
  }, [card, goodsForm, specs, skuRows])

  // Initialize (or rebuild for a newer turn) the EXEC_RESULT view state.
  useEffect(() => {
    if (card === null || card.type !== 'EXEC_RESULT' || card.id === '') return
    if (exec !== null && exec.callKey === callKey) return
    setExec({
      callKey,
      domainType: card.domainType,
      id: card.id,
      billNo: card.billNo,
      partner: card.partner,
      warehouse: card.warehouseName,
      orderDate: card.orderDate.slice(0, 10),
      orderStatus: card.orderStatus,
      totalAmount: card.totalAmount,
      rows: card.rows,
      deleted: false,
    })
    setEditMode(false)
    setEditRaw(null)
    setEditRows(null)
    setConfirmAsk('')
    setExecError('')
  }, [card, exec, callKey])

  // Load partner/warehouse option lists when the inline editor opens.
  useEffect(() => {
    if (!editMode) return
    const domain = exec === null ? undefined : EXEC_DOMAINS[exec.domainType]
    if (domain === undefined) return
    let live = true
    void (async () => {
      if (domain.partnerLabel === '供应商' && options.suppliers.length === 0) {
        const suppliers = await fetchOptions('/wms/supplier/list', 'supplierName')
        if (live && suppliers.length > 0) setOptions(current => ({ ...current, suppliers }))
      }
      if (domain.partnerLabel === '客户' && options.customers.length === 0) {
        const customers = await fetchOptions('/wms/customer/list', 'customerName')
        if (live && customers.length > 0) setOptions(current => ({ ...current, customers }))
      }
      if (domain.hasWarehouse && options.warehouses.length === 0) {
        const warehouses = await fetchOptions('/wms/warehouse/list', 'warehouseName')
        if (live && warehouses.length > 0) setOptions(current => ({ ...current, warehouses }))
      }
    })()
    return () => { live = false }
  }, [editMode, exec, options])

  // Load option lists through the WMS proxy when the card needs them.
  useEffect(() => {
    if (card === null || card.type !== 'DIFF_PREVIEW' || !card.editable) {
      if (card !== null && card.type === 'GOODS_CREATE_FORM') {
        let live = true
        void (async () => {
          if (options.units.length === 0) {
            const units = await fetchOptions('/wms/unit/list', 'unitName')
            if (live && units.length > 0) setOptions(current => ({ ...current, units }))
          }
          if (options.categories.length === 0) {
            const categories = await fetchCategoryOptions()
            if (live && categories.length > 0) setOptions(current => ({ ...current, categories }))
          }
        })()
        return () => { live = false }
      }
      return
    }
    let live = true
    void (async () => {
      if (card.allowSupplierEdit && options.suppliers.length === 0) {
        const suppliers = await fetchOptions('/wms/supplier/list', 'supplierName')
        if (live && suppliers.length > 0) setOptions(current => ({ ...current, suppliers }))
      }
      if (card.allowCustomerEdit && options.customers.length === 0) {
        const customers = await fetchOptions('/wms/customer/list', 'customerName')
        if (live && customers.length > 0) setOptions(current => ({ ...current, customers }))
      }
      if (card.allowWarehouseEdit && options.warehouses.length === 0) {
        const warehouses = await fetchOptions('/wms/warehouse/list', 'warehouseName')
        if (live && warehouses.length > 0) setOptions(current => ({ ...current, warehouses }))
      }
    })()
    return () => { live = false }
  }, [card, options])

  // Inline sign-in card: the relay tool could not reach WMS (no grant or 401).
  // Rendered instead of the regular card; the user signs in and resends.
  if (state != null && state.cardType === 'AUTH_NEEDED') return <WmsInlineAuthCard />

  if (data === undefined || state === undefined || state === null || card === null) return null

  const send = (text: string): void => {
    setSubmitted(true)
    sendAsUser(props.sessionId, text)
  }

  /** Stage an internal payload on the Host, then send the friendly text. */
  const stageAndSend = async (payload: string, visible: string): Promise<void> => {
    try {
      const response = await fetch(WMS_FORM_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: props.sessionId, payload, visible }),
      })
      if (!response.ok) console.error('[wms-ai] stage payload failed: HTTP', response.status)
    } catch (stagingError: unknown) {
      console.error('[wms-ai] stage payload failed:', stagingError)
    }
    send(visible)
  }

  /** Chip click: internal commands are staged (the label becomes the visible text). */
  const sendChip = (chip: Chip): void => {
    if (chip.message.startsWith('__') && chip.message !== chip.label) {
      void stageAndSend(chip.message, chip.label)
      return
    }
    send(chip.message)
  }

  // Non-preview cards: goods-creation forms, then clickable action chips.
  if (card.type === 'GOODS_CREATE_FORM' && goodsForm !== null) {
    const update = (patch: Partial<GoodsFormState>): void => {
      setGoodsForm(current => current === null ? current : { ...current, ...patch })
    }
    const submitGoods = (action: string): void => {
      if (goodsForm.goodsName.trim() === '') { setError('商品名称不能为空'); return }
      if (goodsForm.categoryId === '') { setError('请选择商品分类'); return }
      const category = options.categories.find(option => option.id === goodsForm.categoryId)
      void stageAndSend(buildGoodsFormPayload(
        { goodsName: goodsForm.goodsName.trim(), goodsUnit: goodsForm.unitName },
        action,
        form => {
          form['categoryId'] = Number(goodsForm.categoryId)
          if (category !== undefined) form['categoryName'] = category.label
        },
      ), action === 'GO_MULTI_SPEC' ? '进入多规格设置' : '保存新增商品')
    }
    // Inline-create a unit, then refresh the list and pick the new one.
    const submitNewUnit = async (): Promise<void> => {
      const name = unitAddName.trim()
      if (name === '') { setError('请输入单位名称'); return }
      setUnitAddBusy(true); setError('')
      const result = await createUnitOrCategory('/wms/unit', { unitName: name })
      const units = result.ok ? await fetchOptions('/wms/unit/list', 'unitName') : options.units
      setUnitAddBusy(false)
      if (!result.ok) { setError(result.msg); return }
      if (units.length > 0) setOptions(current => ({ ...current, units }))
      update({ unitName: name })
      setUnitAddOpen(false); setUnitAddName('')
    }
    // Inline-create a top-level (parentId=0) goods category, refresh and pick it.
    const submitNewCategory = async (): Promise<void> => {
      const name = categoryAddName.trim()
      if (name === '') { setError('请输入分类名称'); return }
      setCategoryAddBusy(true); setError('')
      const result = await createUnitOrCategory('/wms/goodsCategory', { categoryName: name, parentId: 0 })
      const categories = result.ok ? await fetchCategoryOptions() : options.categories
      setCategoryAddBusy(false)
      if (!result.ok) { setError(result.msg); return }
      if (categories.length > 0) setOptions(current => ({ ...current, categories }))
      const newId = categories.find(option => option.label === name)?.id ?? result.id
      update({ categoryId: newId === '' ? result.id : newId })
      setCategoryAddOpen(false); setCategoryAddName('')
    }
    return (
      <div className={css.card} data-wms-tail={card.type}>
        {card.title !== '' && <div className={css.cardTitle}>{card.title}</div>}
        <div className={css.inlineForm}>
          <label className={css.inlineLabel}>商品名称 *</label>
          <input className={`${css.cellInput} ${css.grow}`} value={goodsForm.goodsName} placeholder="请输入商品名称"
            disabled={submitted} onChange={event => { setError(''); update({ goodsName: event.target.value }) }} />
        </div>
        <div className={css.inlineForm}>
          <label className={css.inlineLabel}>单位</label>
          <select className={`${css.select} ${css.grow}`} value={goodsForm.unitName} disabled={submitted}
            onChange={event => { setError(''); update({ unitName: event.target.value }) }}>
            <option value="">请选择单位</option>
            {options.units.map(option => <option key={option.id} value={option.label}>{option.label}</option>)}
          </select>
          <button type="button" className={css.textButton} disabled={submitted}
            onClick={() => { setError(''); setUnitAddOpen(current => !current); setCategoryAddOpen(false) }}>新增</button>
        </div>
        {unitAddOpen && (
          <div className={css.inlineForm}>
            <label className={css.inlineLabel}>新单位</label>
            <input className={`${css.cellInput} ${css.grow}`} value={unitAddName} placeholder="输入单位名称，如：箱、台"
              disabled={unitAddBusy || submitted}
              onChange={event => { setError(''); setUnitAddName(event.target.value) }} />
            <button type="button" className={css.secondaryButton} disabled={unitAddBusy || submitted}
              onClick={() => void submitNewUnit()}>确定</button>
            <button type="button" className={css.textButton} disabled={unitAddBusy}
              onClick={() => { setUnitAddOpen(false); setUnitAddName('') }}>取消</button>
          </div>
        )}
        <div className={css.inlineForm}>
          <label className={css.inlineLabel}>分类 *</label>
          <select className={`${css.select} ${css.grow}`} value={goodsForm.categoryId} disabled={submitted}
            onChange={event => { setError(''); update({ categoryId: event.target.value }) }}>
            <option value="">请选择分类</option>
            {options.categories.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
          <button type="button" className={css.textButton} disabled={submitted}
            onClick={() => { setError(''); setCategoryAddOpen(current => !current); setUnitAddOpen(false) }}>新增</button>
        </div>
        {categoryAddOpen && (
          <div className={css.inlineForm}>
            <label className={css.inlineLabel}>新分类</label>
            <input className={`${css.cellInput} ${css.grow}`} value={categoryAddName} placeholder="输入一级分类名称"
              disabled={categoryAddBusy || submitted}
              onChange={event => { setError(''); setCategoryAddName(event.target.value) }} />
            <button type="button" className={css.secondaryButton} disabled={categoryAddBusy || submitted}
              onClick={() => void submitNewCategory()}>确定</button>
            <button type="button" className={css.textButton} disabled={categoryAddBusy}
              onClick={() => { setCategoryAddOpen(false); setCategoryAddName('') }}>取消</button>
          </div>
        )}
        {error !== '' && <div className={css.warnText}>{error}</div>}
        <div className={css.cardActions}>
          <button type="button" className={css.primaryButton} disabled={submitted}
            onClick={() => { submitGoods('SAVE_NO_SPEC') }}>保存</button>
          <button type="button" className={css.secondaryButton} disabled={submitted}
            onClick={() => { submitGoods('GO_MULTI_SPEC') }}>多规格设置</button>
        </div>
      </div>
    )
  }

  if (card.type === 'GOODS_SPEC_FORM' && specs !== null) {
    const submitSpec = (action: string): void => {
      const valid = specs.some(spec => spec.specName.trim() !== '' && spec.values.some(value => value.trim() !== ''))
      if (action === 'GO_SKU_LIST' && !valid) { setError('请至少录入一组规格和值'); return }
      void stageAndSend(buildGoodsFormPayload(
        { goodsName: card.goodsName, goodsUnit: card.goodsUnit },
        action,
        form => { form['specs'] = specs.map(spec => ({
          specName: spec.specName,
          values: spec.values.map(value => ({ specValue: value })),
        })) },
      ), action === 'GO_SKU_LIST' ? '生成SKU列表' : '返回并按无规格保存')
    }
    return (
      <div className={css.card} data-wms-tail={card.type}>
        {card.title !== '' && <div className={css.cardTitle}>{card.title}</div>}
        <div className={css.previewMeta}>商品：{card.goodsName || '—'}　单位：{card.goodsUnit || '个'}</div>
        {specs.map((spec, specIndex) => (
          <div key={specIndex} className={css.specBlock}>
            <div className={css.formRow}>
              <input className={`${css.cellInput} ${css.grow}`} value={spec.specName} placeholder="规格名称，如：颜色、尺寸"
                disabled={submitted} onChange={event => {
                  setSpecs(current => current === null ? current : current.map((row, i) =>
                    i === specIndex ? { ...row, specName: event.target.value } : row))
                }} />
              <button type="button" className={css.textButton} disabled={submitted}
                onClick={() => { setSpecs(current => current === null ? current : current.filter((_, i) => i !== specIndex)) }}>删除规格</button>
            </div>
            {spec.values.map((value, valueIndex) => (
              <div key={valueIndex} className={css.formRow}>
                <input className={`${css.cellInput} ${css.grow}`} value={value} placeholder="规格值，如：红色、L"
                  disabled={submitted} onChange={event => {
                    setSpecs(current => current === null ? current : current.map((row, i) => i === specIndex
                      ? { ...row, values: row.values.map((v, vi) => vi === valueIndex ? event.target.value : v) }
                      : row))
                  }} />
                <button type="button" className={css.textButton} disabled={submitted}
                  onClick={() => {
                    setSpecs(current => current === null ? current : current.map((row, i) => i === specIndex
                      ? { ...row, values: row.values.filter((_, vi) => vi !== valueIndex) }
                      : row))
                  }}>删除</button>
              </div>
            ))}
            <button type="button" className={css.secondaryButton} disabled={submitted}
              onClick={() => {
                setSpecs(current => current === null ? current : current.map((row, i) =>
                  i === specIndex ? { ...row, values: [...row.values, ''] } : row))
              }}>添加规格值</button>
          </div>
        ))}
        <button type="button" className={css.secondaryButton} disabled={submitted}
          onClick={() => { setSpecs(current => current === null ? current : [...current, { specName: '', values: [''] }]) }}>新增规格</button>
        {error !== '' && <div className={css.warnText}>{error}</div>}
        <div className={css.cardActions}>
          <button type="button" className={css.primaryButton} disabled={submitted}
            onClick={() => { submitSpec('GO_SKU_LIST') }}>下一步</button>
          <button type="button" className={css.secondaryButton} disabled={submitted}
            onClick={() => { submitSpec('BACK_TO_NO_SPEC') }}>返回</button>
        </div>
      </div>
    )
  }

  if (card.type === 'GOODS_SKU_FORM' && skuRows !== null) {
    const submitSku = (action: string): void => {
      if (action === 'SAVE_MULTI_SPEC') {
        if (skuRows.length === 0) { setError('请至少保留一条 SKU'); return }
        const invalid = skuRows.find(row => row.skuName.trim() === ''
          || Number(row.quantity) <= 0 || Number(row.price) <= 0)
        if (invalid !== undefined) { setError('SKU名称、数量和采购单价都必须填写且大于0'); return }
      }
      void stageAndSend(buildGoodsFormPayload(
        { goodsName: card.goodsName, goodsUnit: card.goodsUnit },
        action,
        form => {
          form['skuList'] = skuRows.map(row => ({
            skuName: row.skuName,
            specInfo: row.specInfo,
            unitName: row.unitName,
            quantity: Number(row.quantity),
            price: Number(row.price),
          }))
        },
      ), action === 'SAVE_MULTI_SPEC' ? '保存多规格商品' : '返回并按无规格保存')
    }
    return (
      <div className={css.card} data-wms-tail={card.type}>
        {card.title !== '' && <div className={css.cardTitle}>{card.title}</div>}
        <div className={css.previewMeta}>商品：{card.goodsName || '—'}　单位：{card.goodsUnit || '个'}</div>
        <div className={css.tableWrap}>
          <table className={css.table}>
            <thead>
              <tr>
                <th className={css.th}>规格组合</th>
                <th className={css.th}>SKU名称</th>
                <th className={css.th}>单位</th>
                <th className={css.th}>数量</th>
                <th className={css.th}>采购单价</th>
                <th className={css.th}>操作</th>
              </tr>
            </thead>
            <tbody>
              {skuRows.map((row, index) => (
                <tr key={index}>
                  <td className={css.td}>{row.specInfo || '—'}</td>
                  <td className={css.td}>
                    <input className={css.cellInput} value={row.skuName} placeholder="请输入SKU名称" disabled={submitted}
                      onChange={event => {
                        setSkuRows(current => current === null ? current : current.map((item, i) =>
                          i === index ? { ...item, skuName: event.target.value } : item))
                      }} />
                  </td>
                  <td className={css.td}>{row.unitName || card.goodsUnit || '个'}</td>
                  <td className={css.td}>
                    <input className={css.cellInput} value={row.quantity} placeholder="0" inputMode="decimal" disabled={submitted}
                      onChange={event => {
                        setSkuRows(current => current === null ? current : current.map((item, i) =>
                          i === index ? { ...item, quantity: normalizeNumberInput(event.target.value) } : item))
                      }} />
                  </td>
                  <td className={css.td}>
                    <input className={css.cellInput} value={row.price} placeholder="0.00" inputMode="decimal" disabled={submitted}
                      onChange={event => {
                        setSkuRows(current => current === null ? current : current.map((item, i) =>
                          i === index ? { ...item, price: normalizeNumberInput(event.target.value) } : item))
                      }} />
                  </td>
                  <td className={css.td}>
                    <button type="button" className={css.textButton} disabled={submitted}
                      onClick={() => { setSkuRows(current => current === null ? current : current.filter((_, i) => i !== index)) }}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {error !== '' && <div className={css.warnText}>{error}</div>}
        <div className={css.cardActions}>
          <button type="button" className={css.primaryButton} disabled={submitted}
            onClick={() => { submitSku('SAVE_MULTI_SPEC') }}>保存</button>
          <button type="button" className={css.secondaryButton} disabled={submitted}
            onClick={() => { submitSku('BACK_TO_NO_SPEC') }}>返回</button>
        </div>
      </div>
    )
  }

  if (card.type === 'EXEC_RESULT' && exec !== null) {
    const domain = EXEC_DOMAINS[exec.domainType]
    const editable = domain !== undefined && !exec.deleted && String(exec.orderStatus) === '0'
    const statusText = exec.deleted ? '已删除' : String(exec.orderStatus) === '1' ? '已审核'
      : String(exec.orderStatus) === '0' ? '待审核' : exec.orderStatus || '—'
    const partnerLabel = domain?.partnerLabel ?? '往来单位'
    const total = exec.rows.reduce((sum, row) => {
      const amount = Number(row['amount'])
      return Number.isFinite(amount) ? sum + amount : sum
    }, 0)

    /** Re-read the order from WMS and update the view state. */
    const refreshExec = async (): Promise<void> => {
      if (domain === undefined) return
      const payload = await wmsApi(`${domain.basePath}/${exec.id}`, 'GET')
      const order = payload !== null && payload['code'] === 200 && isObject(payload['data'])
        ? payload['data'] as JsonObject : null
      if (order === null) {
        setExecError(firstString(payload?.['msg']) || '刷新单据失败，请稍后重试')
        return
      }
      setExec(execViewFromOrder(callKey, exec.domainType, order))
    }

    /** Open the inline editor with the full order fetched from WMS. */
    const openEditor = async (): Promise<void> => {
      if (domain === undefined) return
      setExecError('')
      setExecBusy(true)
      const payload = await wmsApi(`${domain.basePath}/${exec.id}`, 'GET')
      setExecBusy(false)
      const order = payload !== null && payload['code'] === 200 && isObject(payload['data'])
        ? payload['data'] as JsonObject : null
      if (order === null) {
        setExecError(firstString(payload?.['msg']) || '读取单据失败，请稍后重试')
        return
      }
      setEditRaw(order)
      const dateKey = exec.domainType === 'PURCHASE_IN' ? 'inDate'
        : exec.domainType === 'PURCHASE_RETURN' ? 'returnDate' : 'orderDate'
      setEditDate(String(order[dateKey] ?? '').slice(0, 10))
      setEditPartner(idString(order['supplierId'] ?? order['customerId']))
      setEditWarehouse(idString(order['warehouseId']))
      setEditRows(arrayOf(order['items']).filter(isObject).map((item, index) => ({
        index,
        goods: firstString(item['goodsName'], item['goods']),
        sku: firstString(item['skuName'], item['sku']),
        unit: firstString(item['unitName'], item['unit']),
        quantity: normalizeNumberInput(item['quantity']),
        price: normalizeNumberInput(item['price']),
      })))
      setEditMode(true)
    }

    /** PUT the edited order back to WMS, then refresh the view. */
    const saveEdit = async (): Promise<void> => {
      if (domain === undefined || editRaw === null || editRows === null) return
      if (editRows.length === 0) { setExecError('至少保留一条明细'); return }
      if (editPartner === '') { setExecError(`请选择${domain.partnerLabel}`); return }
      const invalid = editRows.find(row => row.quantity === '' || Number(row.quantity) <= 0
        || row.price === '' || Number(row.price) <= 0)
      if (invalid !== undefined) {
        setExecError(`【${invalid.goods || invalid.sku || '未知商品'}】的数量和单价必须大于 0`)
        return
      }
      setExecError('')
      setExecBusy(true)
      const rawItems = arrayOf(editRaw['items']).filter(isObject)
      const items = rawItems.flatMap((item, index) => {
        const row = editRows.find(entry => entry.index === index)
        if (row === undefined) return []
        const quantity = Number(row.quantity)
        const price = Number(row.price)
        return [{ ...item, quantity, price, amount: quantity * price }]
      })
      const body: JsonObject = { ...editRaw, items }
      if (domain.partnerLabel === '供应商') body['supplierId'] = Number(editPartner)
      else body['customerId'] = Number(editPartner)
      if (domain.hasWarehouse && editWarehouse !== '') body['warehouseId'] = Number(editWarehouse)
      const dateKey = exec.domainType === 'PURCHASE_IN' ? 'inDate'
        : exec.domainType === 'PURCHASE_RETURN' ? 'returnDate' : 'orderDate'
      if (editDate !== '') {
        const original = String(editRaw[dateKey] ?? '')
        body[dateKey] = original.length > 10 ? `${editDate}${original.slice(10)}` : editDate
      }
      const payload = await wmsApi(domain.basePath, 'PUT', body)
      setExecBusy(false)
      if (payload === null || payload['code'] !== 200) {
        setExecError(firstString(payload?.['msg']) || '保存修改失败，请稍后重试')
        return
      }
      setEditMode(false)
      await refreshExec()
    }

    /** Approve the order (POST .../approve/{id}); after this it locks. */
    const approve = async (): Promise<void> => {
      if (domain === undefined) return
      setExecError('')
      setExecBusy(true)
      const payload = await wmsApi(`${domain.basePath}/approve/${exec.id}`, 'POST')
      setExecBusy(false)
      if (payload === null || payload['code'] !== 200) {
        setExecError(firstString(payload?.['msg']) || '审核失败，请稍后重试')
        setConfirmAsk('')
        return
      }
      setConfirmAsk('')
      await refreshExec()
    }

    /** Delete the order (DELETE .../{id}); the card shows the deleted state. */
    const remove = async (): Promise<void> => {
      if (domain === undefined) return
      setExecError('')
      setExecBusy(true)
      const payload = await wmsApi(`${domain.basePath}/${exec.id}`, 'DELETE')
      setExecBusy(false)
      if (payload === null || payload['code'] !== 200) {
        setExecError(firstString(payload?.['msg']) || '删除失败，请稍后重试')
        setConfirmAsk('')
        return
      }
      setConfirmAsk('')
      setExec(current => current === null ? current
        : { ...current, deleted: true, rows: [], orderStatus: 'deleted' })
    }

    /** Print the order: fetch the backend-generated PDF and open a preview. */
    const print = async (): Promise<void> => {
      if (domain === undefined) return
      setExecError('')
      setExecBusy(true)
      try {
        const response = await fetch(WMS_API_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: `${domain.basePath}/print/pdf/${exec.id}`, method: 'GET', binary: true }),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.includes('application/pdf')) {
          // The upstream answered JSON instead of a PDF (e.g. an error).
          const payload = await response.json().catch(() => null) as unknown
          const message = isObject(payload) ? firstString(payload['msg'], payload['data']) : ''
          throw new Error(message || 'WMS 未返回 PDF，请稍后重试')
        }
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const win = window.open(url, '_blank')
        if (win === null) {
          // Popup blocked: fall back to a hidden iframe print dialog.
          const iframe = document.createElement('iframe')
          iframe.style.display = 'none'
          iframe.src = url
          document.body.appendChild(iframe)
          iframe.addEventListener('load', () => { iframe.contentWindow?.print() })
        }
        window.setTimeout(() => URL.revokeObjectURL(url), 60000)
      } catch (error: unknown) {
        setExecError(error instanceof Error ? error.message : String(error))
      } finally {
        setExecBusy(false)
      }
    }

    if (editMode && domain !== undefined && editRows !== null) {
      const editTotal = editRows.reduce((sum, row) => sum + Number(row.quantity || 0) * Number(row.price || 0), 0)
      return (
        <div className={css.card} data-wms-tail="EXEC_EDIT">
          <div className={css.cardTitle}>修改{domain.label}（单号：{exec.billNo || exec.id}）</div>
          <div className={css.inlineForm}>
            <label className={css.inlineLabel}>{domain.partnerLabel}</label>
            <select className={css.select} value={editPartner} disabled={execBusy}
              onChange={event => { setExecError(''); setEditPartner(event.target.value) }}>
              {editPartner === '' && <option value="">请选择{domain.partnerLabel}</option>}
              {(domain.partnerLabel === '供应商' ? options.suppliers : options.customers).map(option => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
            <label className={css.inlineLabel}>日期</label>
            <input type="date" className={css.cellInput} value={editDate} disabled={execBusy}
              onChange={event => { setExecError(''); setEditDate(event.target.value) }} />
            {domain.hasWarehouse && (
              <select className={css.select} value={editWarehouse} disabled={execBusy}
                onChange={event => { setExecError(''); setEditWarehouse(event.target.value) }}>
                {editWarehouse === '' && <option value="">请选择仓库</option>}
                {options.warehouses.map(option => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            )}
          </div>
          <div className={css.tableWrap}>
            <table className={css.table}>
              <thead>
                <tr>
                  <th className={css.th}>商品</th>
                  <th className={css.th}>规格</th>
                  <th className={css.th}>单位</th>
                  <th className={css.th}>数量</th>
                  <th className={css.th}>单价</th>
                  <th className={css.th}>金额</th>
                  <th className={css.th}>操作</th>
                </tr>
              </thead>
              <tbody>
                {editRows.map((row, position) => (
                  <tr key={row.index}>
                    <td className={css.td}>{row.goods || '—'}</td>
                    <td className={css.td}>{row.sku || '—'}</td>
                    <td className={css.td}>{row.unit || '—'}</td>
                    <td className={css.td}>
                      <input className={css.cellInput} value={row.quantity} placeholder="0" inputMode="decimal" disabled={execBusy}
                        onChange={event => {
                          setEditRows(current => current === null ? current : current.map((item, i) =>
                            i === position ? { ...item, quantity: normalizeNumberInput(event.target.value) } : item))
                        }} />
                    </td>
                    <td className={css.td}>
                      <input className={css.cellInput} value={row.price} placeholder="0.00" inputMode="decimal" disabled={execBusy}
                        onChange={event => {
                          setEditRows(current => current === null ? current : current.map((item, i) =>
                            i === position ? { ...item, price: normalizeNumberInput(event.target.value) } : item))
                        }} />
                    </td>
                    <td className={`${css.td} ${css.num}`}>{money(Number(row.quantity || 0) * Number(row.price || 0))}</td>
                    <td className={css.td}>
                      <button type="button" className={css.textButton} disabled={execBusy}
                        onClick={() => { setEditRows(current => current === null ? current : current.filter((_, i) => i !== position)) }}>删除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className={`${css.td} ${css.totalTd}`}>合计</td>
                  <td className={css.td} colSpan={4} />
                  <td className={`${css.td} ${css.num} ${css.totalTd}`}>{money(editTotal)}</td>
                  <td className={css.td} />
                </tr>
              </tfoot>
            </table>
          </div>
          {execError !== '' && <div className={css.warnText}>{execError}</div>}
          <div className={css.cardActions}>
            <button type="button" className={css.primaryButton} disabled={execBusy}
              onClick={() => { void saveEdit() }}>保存修改</button>
            <button type="button" className={css.secondaryButton} disabled={execBusy}
              onClick={() => { setEditMode(false); setExecError('') }}>取消</button>
          </div>
        </div>
      )
    }

    return (
      <div className={css.card} data-wms-tail="EXEC_RESULT">
        <div className={css.cardTitle}>{state.reply !== '' ? state.reply : `${domain?.label ?? '单据'}执行结果`}</div>
        <div className={css.execGrid}>
          <span className={css.execItem}><b>类型：</b>{domain?.label ?? exec.domainType}</span>
          <span className={css.execItem}><b>单号：</b>{exec.billNo || exec.id}</span>
          <span className={css.execItem}><b>{partnerLabel}：</b>{exec.partner || '—'}</span>
          <span className={css.execItem}><b>下单日期：</b>{exec.orderDate || '—'}</span>
          <span className={css.execItem}><b>总金额：</b>{money(exec.totalAmount === '' ? null : Number(exec.totalAmount))}</span>
          <span className={css.execItem}><b>状态：</b>{statusText}</span>
        </div>
        {!exec.deleted && exec.rows.length > 0 && (
          <div className={css.tableWrap}>
            <table className={css.table}>
              <thead>
                <tr>
                  <th className={css.th}>商品</th>
                  <th className={css.th}>规格</th>
                  <th className={css.th}>单位</th>
                  <th className={css.th}>数量</th>
                  <th className={css.th}>单价</th>
                  <th className={css.th}>金额</th>
                </tr>
              </thead>
              <tbody>
                {exec.rows.map((row, index) => {
                  const quantity = Number(row['quantity'])
                  const price = Number(row['price'])
                  const rawAmount = Number(row['amount'])
                  const amount = Number.isFinite(rawAmount) ? rawAmount
                    : Number.isFinite(quantity) && Number.isFinite(price) ? quantity * price : null
                  return (
                    <tr key={index}>
                      <td className={css.td}>{firstString(row['goods'], row['goodsName']) || '—'}</td>
                      <td className={css.td}>{firstString(row['sku'], row['skuName']) || '—'}</td>
                      <td className={css.td}>{firstString(row['unit'], row['unitName']) || '—'}</td>
                      <td className={css.td}>{Number.isFinite(quantity) ? quantity : '—'}</td>
                      <td className={css.td}>{Number.isFinite(price) ? money(price) : '—'}</td>
                      <td className={`${css.td} ${css.num}`}>{money(amount)}</td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td className={`${css.td} ${css.totalTd}`}>合计</td>
                  <td className={css.td} colSpan={4} />
                  <td className={`${css.td} ${css.num} ${css.totalTd}`}>{money(total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {exec.deleted && <div className={css.previewMeta}>{domain?.label ?? '单据'}已删除。</div>}
        {execError !== '' && <div className={css.warnText}>{execError}</div>}
        {domain !== undefined && !exec.deleted && (
          <div className={css.cardActions}>
            {confirmAsk === '' && (
              <>
                <button type="button" className={css.secondaryButton} disabled={!editable || execBusy}
                  onClick={() => { void openEditor() }}>修改</button>
                <button type="button" className={css.secondaryButton} disabled={!editable || execBusy}
                  onClick={() => { setConfirmAsk('approve') }}>审核</button>
                <button type="button" className={css.secondaryButton}
                  disabled={exec.deleted || String(exec.orderStatus) !== '1' || execBusy}
                  onClick={() => { void print() }}>打印</button>
                <button type="button" className={css.secondaryButton} disabled={!editable || execBusy}
                  onClick={() => { setConfirmAsk('delete') }}>删除</button>
              </>
            )}
            {confirmAsk === 'approve' && (
              <>
                <span className={css.previewMeta}>确认审核通过该{domain.label}？审核后将不可再修改。</span>
                <button type="button" className={css.primaryButton} disabled={execBusy}
                  onClick={() => { void approve() }}>确定</button>
                <button type="button" className={css.secondaryButton} disabled={execBusy}
                  onClick={() => { setConfirmAsk('') }}>取消</button>
              </>
            )}
            {confirmAsk === 'delete' && (
              <>
                <span className={css.previewMeta}>确认删除该{domain.label}？删除后不可恢复。</span>
                <button type="button" className={css.primaryButton} disabled={execBusy}
                  onClick={() => { void remove() }}>确定</button>
                <button type="button" className={css.secondaryButton} disabled={execBusy}
                  onClick={() => { setConfirmAsk('') }}>取消</button>
              </>
            )}
          </div>
        )}
      </div>
    )
  }

  if (card.type !== 'DIFF_PREVIEW') {
    return (
      <div className={css.card} data-wms-tail={card.type}>
        {card.title !== '' && <div className={css.cardTitle}>{card.title}</div>}
        <div className={css.cardActions}>
          {card.chips.map(chip => (
            <button key={`${chip.message}-${chip.label}`} type="button" className={css.chip}
              disabled={submitted} onClick={() => { sendChip(chip) }}>{chip.label}</button>
          ))}
        </div>
      </div>
    )
  }

  // DIFF_PREVIEW: keep showing the user's edited rows even after submitting.
  const editing = card.editable && rows !== null && !submitted
  const displayRows: readonly RowState[] = card.editable && rows !== null ? rows : readOnlyRows
  const headers = previewHeaders(card, displayRows, editing)
  const total = displayRows.reduce((sum, row) => {
    const amount = rowAmount(row)
    return amount === null ? sum : sum + amount
  }, 0)
  const unitEditable = editing && (card.domainType === 'PURCHASE_ORDER' || card.domainType === 'PO')

  const updateRow = (index: number, field: 'quantity' | 'price' | 'unit', raw: string): void => {
    setRows(current => current === null ? current : current.map((row, i) => {
      if (i !== index) return row
      if (field === 'unit') return { ...row, unit: raw }
      let next = normalizeNumberInput(raw)
      if (field === 'quantity' && next !== '') {
        const maxQty = row.maxQty === '' ? null : Number(row.maxQty)
        const quantity = Number(next)
        if (maxQty !== null && Number.isFinite(maxQty) && Number.isFinite(quantity) && quantity > maxQty) {
          next = row.maxQty
        }
      }
      return { ...row, [field]: next }
    }))
  }

  const removeRow = (index: number): void => {
    setRows(current => current === null ? current : current.filter((_, i) => i !== index))
  }

  const selection = {
    supplierId: supplierSel ?? '',
    customerId: customerSel ?? '',
    warehouseId: warehouseSel ?? '',
  }

  // Confirm: stage the __FORM__ payload on the Host (invisible to the chat
  // transcript), then send a plain 「确认」 user message. The relay tool picks
  // the staged payload up and forwards it to WMS.
  const confirm = async (): Promise<void> => {
    if (rows === null) return
    const problem = validateRows(card, rows, selection)
    if (problem !== '') {
      setError(problem)
      return
    }
    setError('')
    await stageAndSend(buildFormPayload(rows, selection), '确认')
  }

  return (
    <div className={css.card} data-wms-tail={card.type}>
      {card.title !== '' && <div className={css.cardTitle}>{card.title}</div>}
      {card.meta.length > 0 && <div className={css.previewMeta}>{card.meta.join('　')}</div>}
      {editing && card.allowSupplierEdit && (
        <div className={css.inlineForm}>
          <label className={css.inlineLabel}>供应商</label>
          <select className={css.select} value={selection.supplierId} disabled={submitted}
            onChange={event => { setError(''); setSupplierSel(event.target.value) }}>
            {selection.supplierId === '' && <option value="">请选择供应商</option>}
            {options.suppliers.map(option => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </div>
      )}
      {editing && card.allowCustomerEdit && (
        <div className={css.inlineForm}>
          <label className={css.inlineLabel}>客户</label>
          <select className={css.select} value={selection.customerId} disabled={submitted}
            onChange={event => { setError(''); setCustomerSel(event.target.value) }}>
            {selection.customerId === '' && <option value="">请选择客户</option>}
            {options.customers.map(option => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </div>
      )}
      {editing && card.allowWarehouseEdit && (
        <div className={css.inlineForm}>
          <label className={css.inlineLabel}>仓库</label>
          <select className={css.select} value={selection.warehouseId} disabled={submitted}
            onChange={event => { setError(''); setWarehouseSel(event.target.value) }}>
            {selection.warehouseId === '' && <option value="">请选择仓库</option>}
            {options.warehouses.map(option => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </div>
      )}
      <div className={css.tableWrap}>
        <table className={css.table}>
          <thead>
            <tr>{headers.map(header => <th key={header} className={css.th}>{header}</th>)}</tr>
          </thead>
          <tbody>
            {displayRows.map((row, index) => {
              const amount = rowAmount(row)
              const cells: ReactNode[] = [
                <td key="goods" className={css.td}>{row.goods || '—'}</td>,
                <td key="sku" className={css.td}>{row.sku || '—'}</td>,
                <td key="unit" className={css.td}>{unitEditable
                  ? <input className={css.cellInput} value={row.unit} placeholder="单位可选" disabled={submitted}
                    onChange={event => { updateRow(index, 'unit', event.target.value) }} />
                  : (row.unit || '—')}</td>,
              ]
              if (headers.includes('订单数量')) cells.push(<td key="oq" className={css.td}>{row.orderQuantity || 0}</td>)
              if (headers.includes('已入库数量') || headers.includes('已出库数量')) {
                cells.push(<td key="rq" className={css.td}>{row.receivedQty || 0}</td>)
              }
              if (card.domainType === 'STOCK_CHECK') cells.push(<td key="bq" className={css.td}>{row.beforeQty || 0}</td>)
              cells.push(<td key="qty" className={css.td}>{editing
                ? <input className={css.cellInput} value={row.quantity} placeholder="0" inputMode="decimal" disabled={submitted}
                  onChange={event => { updateRow(index, 'quantity', event.target.value) }} />
                : (row.quantity || '—')}</td>)
              if (headers.includes('可用上限') || headers.includes('可退货数量') || headers.includes('可出库数量')) {
                cells.push(<td key="mq" className={css.td}>{row.maxQty || 0}</td>)
              }
              cells.push(<td key="price" className={css.td}>{editing && card.allowPriceEdit
                ? <input className={css.cellInput} value={row.price} placeholder="0.00" inputMode="decimal" disabled={submitted}
                  onChange={event => { updateRow(index, 'price', event.target.value) }} />
                : money(row.price === '' ? null : Number(row.price))}</td>)
              cells.push(<td key="amount" className={`${css.td} ${css.num}`}>{money(amount)}</td>)
              if (editing) {
                cells.push(<td key="op" className={css.td}>
                  <button type="button" className={css.textButton} disabled={submitted}
                    onClick={() => { removeRow(index) }}>删除</button>
                </td>)
              }
              return <tr key={`${row.skuId}-${index}`}>{cells}</tr>
            })}
          </tbody>
          <tfoot>
            <tr>
              <td className={`${css.td} ${css.totalTd}`}>合计</td>
              <td className={css.td} colSpan={Math.max(headers.length - 2 - (editing ? 1 : 0), 1)} />
              <td className={`${css.td} ${css.num} ${css.totalTd}`}>{money(total)}</td>
              {editing && <td className={css.td} />}
            </tr>
          </tfoot>
        </table>
      </div>
      {!editing && !submitted && (
        <div className={css.previewMeta}>可在下方点击【确认】或【取消】。</div>
      )}
      {editing && displayRows.length === 0 && (
        <div className={css.previewMeta}>商品选错了？点【取消】终止本次创建，再重新描述要采购的商品。</div>
      )}
      {error !== '' && <div className={css.warnText}>{error}</div>}
      <div className={css.cardActions}>
        {editing && (
          <button type="button" className={css.primaryButton} disabled={displayRows.length === 0}
            onClick={() => { void confirm() }}>确认</button>
        )}
        {!editing && !submitted && (
          <button type="button" className={css.primaryButton} onClick={() => { send('确认') }}>确认</button>
        )}
        <button type="button" className={css.secondaryButton} disabled={submitted}
          onClick={() => { send('取消') }}>取消</button>
      </div>
    </div>
  )
}
