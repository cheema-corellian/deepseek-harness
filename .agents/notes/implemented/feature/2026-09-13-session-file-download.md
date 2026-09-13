# Agent Note: Session file download

Status: implemented

English | [中文](2026-09-13-session-file-download.zh.md)

## Problem

Generic file uploads persist byte-for-byte and ride the session log as `FileBlock` references, but the Chat file card renders as a plain span with no download affordance, the existing `session/attachment` Remote serves images only, and the ZIP export carries original bytes without a per-file URL, so a user cannot fetch back the exact uploaded file from the conversation that owns it.

## Decision

`dsh-session-log-export` owns a second exact Fetch route, `GET`/`HEAD /api/session/file?sessionId=<id>&attachmentId=<opaque-id>`, reusing its attachment-reference collector, live-session flush, and persistence read handle. Session-log membership is the only authority: the handler flushes and reads the stored root log, finds the first file reference whose opaque attachment id matches, and answers `404` for an unknown session or an unreferenced id, `400` for a malformed query, and path-free `500` when the stored log cannot be read. The stored reference owns the response: `Content-Length` is the recorded byte length, the media type is a narrow extension map with an `application/octet-stream` fallback plus `nosniff` and `sandbox` headers, and `Content-Disposition` is an attachment disposition built from a re-sanitized leaf with both quoted and RFC 5987 filenames. `GET` streams `attachments.readFileStream` through a WHATWG stream without collecting the file, skipping empty chunks and erroring rather than truncating on storage failure; `HEAD` runs the same authorization and returns headers with no body. The durable Chat file card becomes an anchor to that URL built from the viewed session id and the stored attachment id with identical card layout, while submission echoes and pre-admission previews keep the plain span because they have no durable membership yet.

## Alternatives considered

- **A new file-download package.** Rejected: the export package already mounts the exact service tuple (session-query, persistence, attachments, live sessions) and the reference collector, so a new package would duplicate the flush/read/scan path for one route.
- **A `session/attachmentFile` Typert Remote returning base64.** Rejected: the acceptance needs a typed binary URL the browser download manager can open, not another JSON envelope; base64 also re-inflates bytes the store already streams.
- **Reusing `GET /api/file?path=` with the stored host path.** Rejected: that route serves execution-world paths through the filesystem provider, while the requirement forbids accepting arbitrary paths or exposing host paths; opaque session plus attachment identity keeps the authority inside the log.
- **Trusting the content hash alone.** Rejected: the digest names bytes but proves nothing about who may read them; only a reference inside the addressed session log authorizes the read, which is also what denies wrong-session and foreign-attachment probes with the same `404`.
- **Putting the route on Session Controller next to `session/attachment`.** Rejected: that controller owns live-agent RPC authorization, while the file bytes need the export package's flush plus persistence-handle read that already feeds the ZIP; one narrow exported finder (`findFileAttachmentInArtifact`) is the whole cross-surface interface.

## Consequences

- Chat file cards are real links with no new component and no layout change; anchors share the `fileCard` class with `nosniff`-safe bytes behind them, and the binary URL never resolves to SPA HTML because unregistered paths stay `404`.
- Gateways admit exactly one new `GET`/`HEAD` path with the same session-identity and tombstone checks as export; no unary allowlist, storage, or filesystem surface changes.
- Media types stay heuristic (extension map, octet-stream fallback) because `FileAttachmentRef` carries no media field; unknown types download safely rather than render.
- Unbounded file retention and the deferred attachment garbage-collection question from generic file upload are unchanged.

## Testing

`packages/session-query/session-log-export/tests/file-download.host.spec.ts` pins exact bytes, length, disposition, HEAD preflight without streaming, foreign/wrong-session/missing-session `404`, malformed-query `400`, missing-service and unreadable-log `500`, empty-chunk skipping, and mid-stream failure, and is red on base where the route is unregistered. `packages/client/ui-chat/tests/file-card.client.spec.tsx` pins the anchor URL shape, the durable anchor render, and the scopeless span fallback, and is red on base where the card is span-only. The export package scope holds 100% statements/branches/functions/lines across its host suites.
