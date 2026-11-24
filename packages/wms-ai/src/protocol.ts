/** Shared wire protocol between the dsh WMS panel and its Host half. */

/** Tool name that opens the self-contained WMS assistant card in the chat stream. */
export const WMS_OPEN_TOOL_NAME = 'wms_open_wms'

/** Relay tool name: forwards one user message to the WMS PC AI state machine. */
export const WMS_CHAT_TOOL_NAME = 'wms_ai_chat'

/** Base path for all Host-proxied WMS API calls (registered on the owner-only /api channel). */
export const WMS_API_PATH = '/api/wms-ai/proxy'

/** Auth route: POST ?action=status|signin|signout (registered on the owner-only /api channel). */
export const WMS_AUTH_PATH = '/api/wms-ai/auth'

/** State route: GET ?session=<dsh session id> returns the latest WMS card for that session. */
export const WMS_STATE_PATH = '/api/wms-ai/state'

/** Form route: POST { session, payload } stages a preview-card `__FORM__` payload. */
export const WMS_FORM_PATH = '/api/wms-ai/form'

/** Credential key scope/id for the WMS login grant. */
export const CREDENTIAL_SCOPE = 'wms-ai'
export const CREDENTIAL_ID = 'default'

/** One WMS API call requested by the browser panel. */
export interface WmsProxyRequest {
  /** WMS relative path, e.g. /wms/ai/pc/actions. Must start with /. */
  readonly path: string
  /** HTTP method. Defaults to GET. */
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** JSON body for POST/PUT. */
  readonly body?: unknown
  /** Pass the upstream response through as raw bytes (e.g. PDF print endpoints). */
  readonly binary?: boolean
}

/** Result of a WMS API call, forwarded verbatim from WMS. */
export interface WmsProxyResult {
  readonly ok: boolean
  readonly status: number
  /** Parsed WMS JSON body, or raw text when not JSON. */
  readonly data: unknown
}

/** Connection status surfaced to the panel. */
export interface WmsAuthStatus {
  readonly connected: boolean
  readonly baseUrl: string | null
  /** Tenant id from the stored grant, if any. Never includes the token. */
  readonly tenantId: string | null
  readonly hint: string | null
}
