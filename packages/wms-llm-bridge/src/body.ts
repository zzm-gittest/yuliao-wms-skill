/** Bounded raw HTTP body intake for the WMS LLM bridge. */

import type { IncomingMessage } from 'node:http'

/** HTTP refusal whose message is safe to return without request data. */
export class BridgeHttpError extends Error {
  override readonly name = 'BridgeHttpError'

  constructor(
    readonly status: 400 | 401 | 405 | 413 | 415 | 503,
    message: string,
  ) {
    super(message)
  }
}

/** Parse a decimal Content-Length or reject an ambiguous header. */
function contentLength(request: IncomingMessage): number | undefined {
  const value = request.headers['content-length']
  if (value === undefined) return undefined
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new BridgeHttpError(400, 'invalid Content-Length')
  }
  const length = Number(value)
  if (!Number.isSafeInteger(length)) throw new BridgeHttpError(413, 'request body is too large')
  return length
}

/**
 * Read one request body as exact, bounded UTF-8 text.
 * @param request - incoming request before any parser consumes it.
 * @param maxBodyBytes - positive byte ceiling.
 * @returns the decoded body after EOF.
 */
export async function readBoundedUtf8Body(
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<string> {
  const declared = contentLength(request)
  if (declared !== undefined && declared > maxBodyBytes) {
    request.resume()
    throw new BridgeHttpError(413, 'request body is too large')
  }

  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string)
      size += chunk.byteLength
      if (size > maxBodyBytes) {
        request.resume()
        throw new BridgeHttpError(413, 'request body is too large')
      }
      chunks.push(chunk)
    }
  } catch (error: unknown) {
    if (error instanceof BridgeHttpError) throw error
    throw new BridgeHttpError(400, 'request body was aborted')
  }
  if (!request.complete) throw new BridgeHttpError(400, 'request body was aborted')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))
  } catch {
    throw new BridgeHttpError(400, 'request body is not valid UTF-8')
  }
}
