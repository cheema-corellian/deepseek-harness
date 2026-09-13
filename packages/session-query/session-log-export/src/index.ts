/** Session-log download command and Host-owned streaming route. */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-attachment'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  fileDownloadDisposition,
  fileDownloadMediaType,
  findFileAttachmentInArtifact,
  flushLiveSessionLog,
  readSessionLogText,
  sessionLogExportDeps,
  sessionLogZipFilename,
  streamSessionLogZip,
  type SessionLogCompressionLevel,
  type SessionLogExportReady,
} from './archive.ts'

export {
  attachmentRefsInArtifact,
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  fileDownloadDisposition,
  fileDownloadMediaType,
  findFileAttachmentInArtifact,
  flushLiveSessionLog,
  readSessionLogText,
  safeFileDownloadName,
  serializeSessionLog,
  SESSION_LOG_FILENAME,
  sessionLogExportDeps,
  sessionLogZipEntries,
  sessionLogZipFilename,
  streamSessionLogZip,
} from './archive.ts'
export type {
  SessionLogCompressionLevel,
  SessionLogExportDeps,
  SessionLogExportReady,
  SessionLogZipEntry,
} from './archive.ts'

export const name = 'session-log-download'
export const inject = ['commands', 'connection']

/** Stable browser download path retained across the transport migration. */
export const SESSION_LOG_EXPORT_PATH = '/api/session.export'

/**
 * Stable browser path for one persisted session-owned file download. The query
 * carries opaque `sessionId` plus `attachmentId`; the stored session log is
 * the only authority and the stored reference owns filename, media, and bytes.
 */
export const SESSION_FILE_PATH = '/api/session/file'

/** Session-log archive policy. */
export interface Config {
  /** DEFLATE level for each ZIP entry. @default 6 */
  readonly compressionLevel?: SessionLogCompressionLevel
}

/** Validate Session-log archive configuration. */
export const Config: Schema<Config> = Schema.object({
  compressionLevel: Schema.number().step(1).min(0).max(9)
    .default(DEFAULT_SESSION_LOG_COMPRESSION_LEVEL) as Schema<SessionLogCompressionLevel>,
})

interface SessionLogConnection {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

const REQUESTED: CommandResult = {
  kind: 'success',
  text: 'Session log download requested.',
}

/**
 * Register the Web-only `/export` command, the authenticated ZIP download
 * route, and the authenticated single-file download route.
 * @param ctx - Host context carrying the human-command registry.
 * @param config - resolved compression policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(() => ctx.commands.register({
    definitionId: brandString<CommandDefinitionId>('@deepseek-ai/dsh-session-log-export'),
    name: 'export',
    description: 'Download this Session log as a ZIP archive',
    handler: invocation => Promise.resolve(invocation.rawInput.trim() === ''
      ? REQUESTED
      : { kind: 'error', text: 'The Web /export command does not accept a path.' }),
  }), 'session-log-download: command')
  connectionOf(ctx).fetch.register({
    path: SESSION_LOG_EXPORT_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const response = await sessionLogExportResponse(
        ctx,
        request,
        config.compressionLevel ?? DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
      )
      if (request.method === 'GET') return response
      await response.body?.cancel()
      return new Response(null, { status: response.status, headers: response.headers })
    },
  })
  connectionOf(ctx).fetch.register({
    path: SESSION_FILE_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const response = await sessionFileResponse(ctx, request)
      if (request.method === 'GET') return response
      await response.body?.cancel()
      return new Response(null, { status: response.status, headers: response.headers })
    },
  })
}

function connectionOf(ctx: Context): SessionLogConnection {
  return Reflect.get(ctx, 'connection') as SessionLogConnection
}

async function sessionLogExportResponse(
  ctx: Context,
  request: Request,
  compressionLevel: SessionLogCompressionLevel,
): Promise<Response> {
  const url = new URL(request.url)
  const query = Object.fromEntries(url.searchParams)
  const sessionIdValue = query['sessionId']
  const descendantsValue = query['includeDescendants']
  if (sessionIdValue === undefined || sessionIdValue.length === 0
    || (descendantsValue !== undefined && descendantsValue !== 'true' && descendantsValue !== 'false')) {
    return new Response('missing or invalid sessionId query parameter', { status: 400 })
  }
  const sessionId = brandString<SessionId>(sessionIdValue)
  const deps = sessionLogExportDeps(ctx)
  if (deps.sessionQuery === undefined
    || deps.sessionPersistence === undefined
    || deps.attachments === undefined) {
    return new Response(
      'session log export is unavailable: missing session-query, session-persistence, or attachments service',
      { status: 500 },
    )
  }
  const ready: SessionLogExportReady = {
    sessionQuery: deps.sessionQuery,
    sessionPersistence: deps.sessionPersistence,
    attachments: deps.attachments,
    sessions: deps.sessions,
  }
  let rootContent: string | undefined
  try {
    await flushLiveSessionLog(deps, sessionId, request.signal)
    rootContent = await readSessionLogText(deps.sessionPersistence, sessionId, request.signal)
    request.signal.throwIfAborted()
  } catch {
    request.signal.throwIfAborted()
    // Root preparation failure (flush, open, or read): answer 500 without
    // echoing the error, which may carry absolute host paths into the
    // browser error bar.
    return new Response('session log export failed to read the stored log', { status: 500 })
  }
  if (rootContent === undefined) {
    return new Response('session not found', { status: 404 })
  }
  const response = new Response(
    streamSessionLogZip(
      ready,
      rootContent,
      sessionId,
      descendantsValue === 'true',
      compressionLevel,
      request.signal,
    ),
    {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${sessionLogZipFilename(sessionId)}"`,
      },
    },
  )
  return response
}

const SESSION_FILE_BASE_HEADERS = {
  'cache-control': 'private, no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'",
} as const

/**
 * Answer one authenticated single-file download from persisted session
 * membership. The stored log must name the opaque attachment id; the stored
 * reference owns filename, media type, and byte length. Query values never
 * become paths and host paths never reach the browser.
 * @param ctx - Host context carrying export services.
 * @param request - authenticated GET/HEAD request with sessionId+attachmentId.
 * @returns exact file bytes with a safe attachment disposition, or 400/404/500.
 */
async function sessionFileResponse(ctx: Context, request: Request): Promise<Response> {
  const url = new URL(request.url)
  const sessionIds = url.searchParams.getAll('sessionId')
  const attachmentIds = url.searchParams.getAll('attachmentId')
  if (sessionIds.length !== 1 || attachmentIds.length !== 1) {
    return new Response('missing or invalid session file query parameters', {
      status: 400,
      headers: { ...SESSION_FILE_BASE_HEADERS },
    })
  }
  const sessionIdValue = sessionIds[0] as string
  const attachmentIdValue = attachmentIds[0] as string
  if (sessionIdValue.length === 0 || attachmentIdValue.length === 0) {
    return new Response('missing or invalid session file query parameters', {
      status: 400,
      headers: { ...SESSION_FILE_BASE_HEADERS },
    })
  }
  const sessionId = brandString<SessionId>(sessionIdValue)
  const deps = sessionLogExportDeps(ctx)
  if (deps.sessionPersistence === undefined || deps.attachments === undefined) {
    return new Response(
      'session file download is unavailable: missing session-persistence or attachments service',
      { status: 500, headers: { ...SESSION_FILE_BASE_HEADERS } },
    )
  }
  let rootContent: string | undefined
  try {
    await flushLiveSessionLog(deps, sessionId, request.signal)
    rootContent = await readSessionLogText(deps.sessionPersistence, sessionId, request.signal)
    request.signal.throwIfAborted()
  } catch {
    request.signal.throwIfAborted()
    return new Response('session file download failed to read the stored log', {
      status: 500,
      headers: { ...SESSION_FILE_BASE_HEADERS },
    })
  }
  if (rootContent === undefined) {
    return new Response('session not found', {
      status: 404,
      headers: { ...SESSION_FILE_BASE_HEADERS },
    })
  }
  const ref = findFileAttachmentInArtifact(rootContent, attachmentIdValue)
  if (ref === undefined) {
    return new Response('attachment is not referenced by this session', {
      status: 404,
      headers: { ...SESSION_FILE_BASE_HEADERS },
    })
  }
  const headers: Record<string, string> = {
    ...SESSION_FILE_BASE_HEADERS,
    'content-type': fileDownloadMediaType(ref),
    'content-disposition': fileDownloadDisposition(ref),
    'content-length': String(ref.bytes),
  }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  const chunks = deps.attachments.readFileStream(ref, request.signal)
  return new Response(fileChunkStream(chunks, request.signal), { status: 200, headers })
}

/**
 * Bridge one bounded attachment chunk iteration into a WHATWG byte stream.
 * Empty chunks are skipped; a storage or integrity failure errors the stream
 * rather than shipping truncated bytes.
 * @param chunks - exact file bytes in order from the attachment store.
 * @param signal - request cancellation combined with consumer cancellation.
 * @returns the file byte stream.
 */
function fileChunkStream(
  chunks: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of chunks) {
          signal.throwIfAborted()
          if (chunk.byteLength === 0) continue
          controller.enqueue(chunk.slice())
        }
        controller.close()
      } catch (error) {
        controller.error(error instanceof Error ? error : new Error(String(error)))
      }
    },
    cancel() {
      // Request signal owns cancellation; consumer cancel drops the reader.
    },
  })
}
