/**
 * session/file host path: GET/HEAD streams exact persisted file bytes only
 * when the addressed session log names the opaque attachment id. Membership
 * is the authority; a content hash alone never authorizes a read.
 */

import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { SessionAccess, SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import * as SessionLogExport from '../src/index.ts'

const sid = (id: string): SessionId => id as SessionId

function header(id: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: sid(id),
    createdAt: 1000,
    isSeeded: false,
    cwd: '/proj',
    delegationDepth: 0,
  }
}

interface StoredLog {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
}

function log(id: string, events: readonly SessionEvent[]): StoredLog {
  return { header: header(id), events }
}

function fileEvent(id: string, name = 'notes.txt', bytes = 5): SessionEvent {
  return {
    type: 'user/message', seq: SessionSeq(1), time: 1000,
    data: { content: [{ type: 'file', attachment: { attachmentId: id, name, bytes } }] },
  } as unknown as SessionEvent
}

function readHandle(stored: StoredLog): SessionHandle {
  return {
    id: stored.header.id,
    header: stored.header,
    access: 'read',
    inheritedEventCount: 0,
    read: async () => ({ eventState: 'detached', events: structuredClone(stored.events) }),
    close: async () => {},
  } as unknown as SessionHandle
}

async function buildFileApi(
  logs: Record<string, StoredLog>,
  services: {
    readFileStream?: (ref: FileAttachmentRef, signal?: AbortSignal) => AsyncIterable<Uint8Array>
    attachments?: boolean
    open?: (id: SessionId, access: SessionAccess) => Promise<SessionHandle>
  } = {},
) {
  const ctx = new Context()
  ctx.provide('commands', { register: () => () => {} } as never)
  ctx.provide('sessionQuery', { traceSession: async () => { throw new Error('unused') } } as never)
  if (services.attachments !== false) {
    ctx.provide('sessionPersistence', {
      stat: async (id: SessionId) => {
        if (services.open !== undefined) return { header: header(String(id)) }
        const stored = logs[id]
        return stored === undefined ? undefined : { header: stored.header }
      },
      open: services.open ?? (async (id: SessionId) => {
        const stored = logs[id]
        if (stored === undefined) throw new SessionPersistenceNotFoundError(id)
        return readHandle(stored)
      }),
    } as never)
    ctx.provide('attachments', {
      imageLimits: {} as never,
      readFileStream: services.readFileStream ?? (async function* () {
        throw new Error('fixture has no files')
      }),
    } as never)
  } else {
    ctx.provide('sessionPersistence', {
      stat: async () => undefined,
      open: async (id: SessionId) => { throw new SessionPersistenceNotFoundError(id) },
    } as never)
  }
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const fiber = ctx.plugin(SessionLogExport, {})
  await fiber.await()
  return connection.createSharedFetchHandler('/api')
}

function fileUrl(sessionId: string, attachmentId: string): string {
  return `http://host${SessionLogExport.SESSION_FILE_PATH}?sessionId=${encodeURIComponent(sessionId)}&attachmentId=${encodeURIComponent(attachmentId)}`
}

describe('session/file download endpoint', () => {
  it('streams exact stored bytes with length and safe attachment disposition', async () => {
    const digest = 'a'.repeat(64)
    const id = `sha256:${digest}`
    const bytes = Uint8Array.of(72, 69, 76, 76, 79)
    const api = await buildFileApi({ 'session-a': log('session-a', [fileEvent(id, 'notes.txt', 5)]) }, {
      readFileStream: ref => (async function* (): AsyncIterable<Uint8Array> {
        expect(ref).toMatchObject({ attachmentId: id, name: 'notes.txt', bytes: 5 })
        yield bytes.slice(0, 2)
        yield bytes.slice(2)
      })(),
    })
    const response = await api.fetch(new Request(fileUrl('session-a', id)))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('content-disposition')).toContain('attachment; filename="notes.txt"')
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''notes.txt")
    expect(response.headers.get('content-length')).toBe('5')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-type')).not.toContain('text/html')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })

  it('preflights the same headers through HEAD without a body', async () => {
    const digest = 'b'.repeat(64)
    const id = `sha256:${digest}`
    let streamed = false
    const api = await buildFileApi({ 'session-a': log('session-a', [fileEvent(id, 'report.csv', 3)]) }, {
      readFileStream: () => (async function* (): AsyncIterable<Uint8Array> {
        streamed = true
        yield Uint8Array.of(1, 2, 3)
      })(),
    })
    const response = await api.fetch(new Request(fileUrl('session-a', id), { method: 'HEAD' }))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    expect(response.headers.get('content-disposition')).toContain('report.csv')
    expect(response.headers.get('content-length')).toBe('3')
    expect(response.body).toBeNull()
    expect(streamed).toBe(false)
  })

  it('serves a non-Latin filename through GET with exact bytes and decodable extended filename', async () => {
    const digest = 'e'.repeat(64)
    const id = `sha256:${digest}`
    const name = '报告.txt'
    const bytes = Uint8Array.of(1, 2, 3)
    const api = await buildFileApi({ 'session-a': log('session-a', [fileEvent(id, name, 3)]) }, {
      readFileStream: ref => (async function* (): AsyncIterable<Uint8Array> {
        expect(ref.name).toBe(name)
        yield bytes
      })(),
    })
    const response = await api.fetch(new Request(fileUrl('session-a', id)))
    expect(response.status).toBe(200)
    const disposition = response.headers.get('content-disposition') ?? ''
    expect(/^[\x20-\x7E]*$/.test(disposition)).toBe(true)
    expect(disposition).toContain('attachment; filename="__.txt"')
    expect(disposition).not.toMatch(/报告/)
    const extended = disposition.split("filename*=UTF-8''")[1] ?? ''
    expect(extended.length).toBeGreaterThan(0)
    expect(decodeURIComponent(extended)).toBe(name)
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  })

  it('preflights a non-Latin filename through HEAD without opening file bytes', async () => {
    const digest = 'f'.repeat(64)
    const id = `sha256:${digest}`
    const name = '报告.txt'
    let streamed = false
    const api = await buildFileApi({ 'session-a': log('session-a', [fileEvent(id, name, 3)]) }, {
      readFileStream: () => (async function* (): AsyncIterable<Uint8Array> {
        streamed = true
        yield Uint8Array.of(1, 2, 3)
      })(),
    })
    const response = await api.fetch(new Request(fileUrl('session-a', id), { method: 'HEAD' }))
    expect(response.status).toBe(200)
    const disposition = response.headers.get('content-disposition') ?? ''
    expect(/^[\x20-\x7E]*$/.test(disposition)).toBe(true)
    expect(disposition).toContain('filename="__.txt"')
    const extended = disposition.split("filename*=UTF-8''")[1] ?? ''
    expect(decodeURIComponent(extended)).toBe(name)
    expect(response.headers.get('content-length')).toBe('3')
    expect(response.body).toBeNull()
    expect(streamed).toBe(false)
  })

  it('sanitizes quote, control, and path characters in actual GET and HEAD responses', async () => {
    const cases: Array<[string, string]> = [
      ['a"b.txt', 'a_b.txt'],
      ['a\\b.txt', 'a_b.txt'],
      ['a/b.txt', 'a_b.txt'],
      ['a\x01b.txt', 'a_b.txt'],
      ['.', 'file'],
      ['..', 'file'],
    ]
    for (const [index, [stored, safe]] of cases.entries()) {
      const digest = `${index}`.repeat(64).slice(0, 64)
      const id = `sha256:${digest}`
      const api = await buildFileApi({ 'session-a': log('session-a', [fileEvent(id, stored, 1)]) }, {
        readFileStream: () => (async function* (): AsyncIterable<Uint8Array> {
          yield Uint8Array.of(7)
        })(),
      })
      const getResponse = await api.fetch(new Request(fileUrl('session-a', id)))
      expect(getResponse.status).toBe(200)
      const getDisposition = getResponse.headers.get('content-disposition') ?? ''
      expect(/^[\x20-\x7E]*$/.test(getDisposition)).toBe(true)
      expect(getDisposition).toContain(`filename="${safe}"`)
      const getExtended = getDisposition.split("filename*=UTF-8''")[1] ?? ''
      expect(decodeURIComponent(getExtended)).toBe(safe)
      expect(new Uint8Array(await getResponse.arrayBuffer())).toEqual(Uint8Array.of(7))

      const headApi = await buildFileApi({ 'session-a': log('session-a', [fileEvent(id, stored, 1)]) })
      const headResponse = await headApi.fetch(new Request(fileUrl('session-a', id), { method: 'HEAD' }))
      expect(headResponse.status).toBe(200)
      const headDisposition = headResponse.headers.get('content-disposition') ?? ''
      expect(/^[\x20-\x7E]*$/.test(headDisposition)).toBe(true)
      expect(headDisposition).toContain(`filename="${safe}"`)
    }
  })

  it('percent-encodes extended-value punctuation per RFC 5987 in the actual response', async () => {
    const digest = '9'.repeat(64)
    const id = `sha256:${digest}`
    const name = "a'b(c)*d.txt"
    const api = await buildFileApi({ 'session-a': log('session-a', [fileEvent(id, name, 1)]) }, {
      readFileStream: () => (async function* (): AsyncIterable<Uint8Array> {
        yield Uint8Array.of(7)
      })(),
    })
    const response = await api.fetch(new Request(fileUrl('session-a', id)))
    expect(response.status).toBe(200)
    const disposition = response.headers.get('content-disposition') ?? ''
    expect(/^[\x20-\x7E]*$/.test(disposition)).toBe(true)
    expect(disposition).toContain(`filename="${name}"`)
    const extended = disposition.split("filename*=UTF-8''")[1] ?? ''
    expect(extended).not.toMatch(/['()*]/)
    expect(extended).toContain('%27')
    expect(extended).toContain('%28')
    expect(extended).toContain('%29')
    expect(extended).toContain('%2A')
    expect(decodeURIComponent(extended)).toBe(name)
    await response.arrayBuffer()
  })

  it('bounds production for an unread slow consumer', async () => {
    const digest = '1'.repeat(64)
    const id = `sha256:${digest}`
    let produced = 0
    const total = 100
    const api = await buildFileApi({ 'session-a': log('session-a', [fileEvent(id, 'big.bin', total)]) }, {
      readFileStream: () => (async function* (): AsyncIterable<Uint8Array> {
        for (let index = 0; index < total; index += 1) {
          produced += 1
          yield Uint8Array.of(index & 0xff)
        }
      })(),
    })
    const response = await api.fetch(new Request(fileUrl('session-a', id)))
    expect(response.status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(produced).toBeLessThan(total)
    expect(produced).toBeLessThanOrEqual(2)
    await response.body?.cancel()
  })

  it('cancels an active provider read and releases its iterator', async () => {
    const digest = '2'.repeat(64)
    const id = `sha256:${digest}`
    let openedSignal: AbortSignal | undefined
    let cleaned = false
    const api = await buildFileApi({ 'session-a': log('session-a', [fileEvent(id, 'notes.txt', 2)]) }, {
      readFileStream: (_ref, signal) => (async function* (): AsyncIterable<Uint8Array> {
        openedSignal = signal
        try {
          yield Uint8Array.of(9, 9)
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => { reject(new Error('provider aborted')) }, { once: true })
          })
          yield Uint8Array.of(8)
        } finally {
          cleaned = true
        }
      })(),
    })
    const response = await api.fetch(new Request(fileUrl('session-a', id)))
    expect(response.status).toBe(200)
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const first = await reader?.read()
    expect(first?.done).toBe(false)
    expect(first?.value).toEqual(Uint8Array.of(9, 9))
    expect(openedSignal).toBeInstanceOf(AbortSignal)
    expect(openedSignal?.aborted).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(cleaned).toBe(false)
    await reader?.cancel(new Error('consumer gone'))
    for (let attempt = 0; attempt < 50 && !cleaned; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(cleaned).toBe(true)
    expect(openedSignal?.aborted).toBe(true)
  })

  it('denies a foreign attachment and a wrong session with 404', async () => {
    const digest = 'c'.repeat(64)
    const id = `sha256:${digest}`
    const api = await buildFileApi({
      'session-a': log('session-a', [fileEvent(id, 'owned.txt', 5)]),
      'session-b': log('session-b', [fileEvent(`sha256:${'d'.repeat(64)}`, 'other.txt', 5)]),
    })
    const foreign = await api.fetch(new Request(fileUrl('session-a', `sha256:${'f'.repeat(64)}`)))
    expect(foreign.status).toBe(404)
    const wrongSession = await api.fetch(new Request(fileUrl('session-b', id)))
    expect(wrongSession.status).toBe(404)
    expect(foreign.headers.get('content-type')).not.toContain('text/html')
  })

  it('denies a deleted (missing) session with 404', async () => {
    const api = await buildFileApi({})
    const response = await api.fetch(new Request(fileUrl('session-gone', `sha256:${'e'.repeat(64)}`)))
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('session not found')
  })

  it('rejects missing, empty, and duplicated query identities with 400', async () => {
    const api = await buildFileApi({})
    const base = `http://host${SessionLogExport.SESSION_FILE_PATH}`
    for (const target of [
      `${base}?sessionId=a`,
      `${base}?attachmentId=sha256:${'a'.repeat(64)}`,
      `${base}?sessionId=&attachmentId=sha256:${'a'.repeat(64)}`,
      `${base}?sessionId=a&attachmentId=`,
      `${base}?sessionId=a&sessionId=b&attachmentId=sha256:${'a'.repeat(64)}`,
      `${base}?sessionId=a&attachmentId=x&attachmentId=y`,
    ]) {
      const response = await api.fetch(new Request(target))
      expect(response.status).toBe(400)
    }
  })

  it('answers 500 when the deployment mounts no attachments service', async () => {
    const api = await buildFileApi({}, { attachments: false })
    const response = await api.fetch(new Request(fileUrl('session-a', `sha256:${'a'.repeat(64)}`)))
    expect(response.status).toBe(500)
    expect(await response.text()).toContain('attachments')
  })

  it('answers 500 when the stored log cannot be read', async () => {
    const api = await buildFileApi({}, {
      open: async () => { throw new Error('EACCES: permission denied') },
    })
    const response = await api.fetch(new Request(fileUrl('session-a', `sha256:${'a'.repeat(64)}`)))
    expect(response.status).toBe(500)
  })

  it('skips empty chunks and errors the stream when file bytes fail', async () => {
    const digest = 'a'.repeat(64)
    const id = `sha256:${digest}`
    const emptySkipping = await buildFileApi({ 'session-a': log('session-a', [fileEvent(id, 'notes.txt', 5)]) }, {
      readFileStream: () => (async function* (): AsyncIterable<Uint8Array> {
        yield new Uint8Array()
        yield Uint8Array.of(1, 2, 3, 4, 5)
      })(),
    })
    const skipped = await emptySkipping.fetch(new Request(fileUrl('session-a', id)))
    expect(new Uint8Array(await skipped.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3, 4, 5))
    const cancellable = await emptySkipping.fetch(new Request(fileUrl('session-a', id)))
    await cancellable.body?.cancel()

    const failing = await buildFileApi({ 'session-a': log('session-a', [fileEvent(id, 'notes.txt', 5)]) }, {
      readFileStream: () => (async function* (): AsyncIterable<Uint8Array> {
        yield Uint8Array.of(1)
        throw new Error('file bytes missing')
      })(),
    })
    const failed = await failing.fetch(new Request(fileUrl('session-a', id)))
    expect(failed.status).toBe(200)
    await expect(failed.arrayBuffer()).rejects.toThrow('file bytes missing')

    const nonError = await buildFileApi({ 'session-a': log('session-a', [fileEvent(id, 'notes.txt', 5)]) }, {
      readFileStream: () => (async function* (): AsyncIterable<Uint8Array> {
        yield Uint8Array.of(1)
        throw 'plain failure'
      })(),
    })
    const nonErrorResponse = await nonError.fetch(new Request(fileUrl('session-a', id)))
    await expect(nonErrorResponse.arrayBuffer()).rejects.toThrow('plain failure')
  })
})

describe('session/file download helpers', () => {
  it('finds the stored reference by opaque id and sanitizes the header name', () => {
    const digest = 'a'.repeat(64)
    const id = `sha256:${digest}`
    const content = `${JSON.stringify({ type: 'session', version: 1, id: 's', createdAt: 1, isSeeded: false, delegationDepth: 0 })}\n${JSON.stringify({ type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'file', attachment: { attachmentId: id, name: 'a/b.txt', bytes: 2 } }] } })}\n`
    expect(SessionLogExport.findFileAttachmentInArtifact(content, id)).toMatchObject({ name: 'a/b.txt' })
    expect(SessionLogExport.findFileAttachmentInArtifact(content, `sha256:${'f'.repeat(64)}`)).toBeUndefined()
    expect(SessionLogExport.safeFileDownloadName({ attachmentId: id, name: 'a/b.txt', bytes: 2 } as FileAttachmentRef)).toBe('a_b.txt')
    expect(SessionLogExport.safeFileDownloadName({ attachmentId: id, name: '.', bytes: 1 } as FileAttachmentRef)).toBe('file')
    expect(SessionLogExport.fileDownloadDisposition({ attachmentId: id, name: 'notes.txt', bytes: 1 } as FileAttachmentRef)).toContain('attachment; filename="notes.txt"')
    const media: Array<[string, string]> = [
      ['notes.txt', 'text/plain; charset=utf-8'],
      ['doc.md', 'text/markdown; charset=utf-8'],
      ['doc.markdown', 'text/markdown; charset=utf-8'],
      ['rows.csv', 'text/csv; charset=utf-8'],
      ['data.json', 'application/json'],
      ['lines.jsonl', 'application/json'],
      ['doc.pdf', 'application/pdf'],
      ['shot.png', 'image/png'],
      ['photo.jpg', 'image/jpeg'],
      ['photo.jpeg', 'image/jpeg'],
      ['anim.gif', 'image/gif'],
      ['shot.webp', 'image/webp'],
      ['archive.bin', 'application/octet-stream'],
      ['noext', 'application/octet-stream'],
    ]
    for (const [name, expected] of media) {
      expect(SessionLogExport.fileDownloadMediaType({ attachmentId: id, name, bytes: 1 } as FileAttachmentRef)).toBe(expected)
    }
  })
})
