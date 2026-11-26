import { after, NextRequest, NextResponse } from 'next/server';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import {
  pinnedSettingsHashes,
  refreshStorageIdentity,
  resolveDocumentStorageScope,
  type DocumentStorageScope,
} from '@/lib/server/tts/storage-scope';
import { withDocumentAudiobookLock } from '@/lib/server/audiobooks/audiobooks';
import { ApiRequestError } from '@/lib/server/api/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// PDF reclaim: the worker starts no deletion this long after the lock is taken,
// and answers once every deletion it started has settled.
const RECLAIM_DELETE_WINDOW_MS = 35_000;
// The browser gets an answer by now, even if the worker has not answered yet.
const RECLAIM_RESPONSE_DEADLINE_MS = 50_000;
// Upper bound for a worker that never answers. Past its deadline it starts no
// deletion, so only a single hung deletion batch could reach this.
const RECLAIM_WORKER_CEILING_MS = 10 * 60_000;

type ComputeWorkerClient = ReturnType<typeof getComputeWorkerClient>;

/**
 * Reclaim a document's audio generated with other settings or older document
 * versions. The current cache identity, its sessions, and the shared reading
 * plan are kept, so active playback with the current settings is unaffected.
 */
export async function POST(request: NextRequest) {
  const { logger } = createRequestLogger({ route: '/api/tts/storage/document/reclaim', request });
  try {
    const resolved = await resolveDocumentStorageScope(request);
    if (resolved instanceof Response) return resolved;
    if (!isComputeWorkerAvailable()) {
      return NextResponse.json({ error: 'Compute worker is required to reclaim audio.' }, { status: 503 });
    }
    const client = getComputeWorkerClient();
    if (resolved.scope.readerType !== 'pdf') {
      const result = await client.reclaimTtsPlaybackCache({
        storageUserId: resolved.scope.storageUserId,
        documentId: resolved.documentId,
        keep: {
          documentVersion: resolved.scope.documentVersion,
          settingsHash: resolved.settingsHash,
        },
      }, { signal: AbortSignal.timeout(45_000) });
      return NextResponse.json(result);
    }

    // No audiobook may start between choosing what to keep and the worker's
    // last deletion, or its new file could be deleted under an earlier
    // layout's hash. The lock is released only once the worker has answered,
    // even if this response has to be sent first.
    const work = withDocumentAudiobookLock(resolved.scope, resolved.documentId, () => reclaimPdf(client, resolved));
    const answered = await withinDeadline(work, RECLAIM_RESPONSE_DEADLINE_MS);
    if (!answered) {
      after(() => work.then(() => undefined, (error: unknown) => {
        logger.warn({ event: 'tts.storage.document_reclaim_late_failure', error: String(error) },
          'Reclaim failed after its response');
      }));
      return NextResponse.json({
        error: 'Reclaiming unused audio is still finishing. Check storage again shortly.',
        code: 'TTS_STORAGE_RECLAIM_PENDING',
      }, { status: 503, headers: { 'Retry-After': '10' } });
    }
    return NextResponse.json(answered.result);
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return NextResponse.json({ error: error.message, code: error.code }, {
        status: error.status,
        ...(error.retryAfterMs ? { headers: { 'Retry-After': String(Math.max(1, Math.ceil(error.retryAfterMs / 1000))) } } : {}),
      });
    }
    return errorResponse(error, {
      logger,
      event: 'tts.storage.document_reclaim_failed',
      msg: 'Failed to reclaim unused document audio',
      apiErrorMessage: 'Failed to reclaim unused audio',
      normalize: { code: 'TTS_STORAGE_RECLAIM_FAILED', errorClass: 'storage' },
    });
  }
}

/** Runs with the document's audiobook lock held. */
async function reclaimPdf(client: ComputeWorkerClient, requested: DocumentStorageScope) {
  // Read the published layout now that no audiobook can start.
  const resolved = await refreshStorageIdentity(requested);
  const notAfter = Date.now() + RECLAIM_DELETE_WINDOW_MS;
  const signal = AbortSignal.timeout(RECLAIM_WORKER_CEILING_MS);
  // Keep exactly what the storage screen reports as current. Only a layout a
  // reparse changed can have audiobooks on an earlier layout.
  let pinned: string[] | null = [];
  if (resolved.narrationRevision !== null) {
    const report = await client.getUserStorageUsage({
      storageUserId: resolved.scope.storageUserId,
      includePlayback: true,
      documentId: resolved.documentId,
      derivedDocumentIds: [],
      namespace: null,
    }, { signal });
    pinned = await pinnedSettingsHashes(resolved, {
      exportsComplete: report.exportsComplete,
      exports: report.documents.find((row) => row.documentId === resolved.documentId)?.exports ?? [],
    });
  }
  return client.reclaimTtsPlaybackCache({
    storageUserId: resolved.scope.storageUserId,
    documentId: resolved.documentId,
    // Without a complete report, every variant of this version is kept.
    keep: pinned === null
      ? { documentVersion: resolved.scope.documentVersion }
      : {
        documentVersion: resolved.scope.documentVersion,
        settingsHash: resolved.settingsHash,
        ...(pinned.length ? { settingsHashes: pinned } : {}),
      },
    notAfter,
  }, { signal });
}

/** The work's result if it settles within `ms`; its failure is rethrown. */
async function withinDeadline<T>(work: Promise<T>, ms: number): Promise<{ result: T } | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([work.then((result) => ({ result })), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
