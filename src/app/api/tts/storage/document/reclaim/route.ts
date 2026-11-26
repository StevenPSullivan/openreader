import { NextRequest, NextResponse } from 'next/server';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { pinnedSettingsHashes, resolveDocumentStorageScope } from '@/lib/server/tts/storage-scope';
import { withDocumentAudiobookLock } from '@/lib/server/audiobooks/audiobooks';
import { ApiRequestError } from '@/lib/server/api/responses';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Deletions stop by this point; the worker then answers within the timeout,
// which leaves the route time to respond before `maxDuration`.
const RECLAIM_DELETE_WINDOW_MS = 35_000;
const RECLAIM_WORKER_TIMEOUT_MS = 55_000;

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
    // The worker starts no deletion after `notAfter` and answers once any batch
    // in flight is done, well before the request is abandoned.
    const notAfter = Date.now() + RECLAIM_DELETE_WINDOW_MS;
    const signal = AbortSignal.timeout(RECLAIM_WORKER_TIMEOUT_MS);
    // A PDF that a reparse changed can have audiobooks on an earlier layout.
    const pinsEarlierLayouts = resolved.scope.readerType === 'pdf' && resolved.narrationRevision !== null;
    const reclaim = async () => {
      // Keep exactly what the storage screen reports as current.
      let pinned: string[] | null = [];
      if (pinsEarlierLayouts) {
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
    };
    // No audiobook may start between choosing what to keep and the worker's
    // last deletion, or its new file could be deleted under an earlier
    // layout's hash. Every PDF takes the lock, because a reparse can publish
    // a revision while reclaim runs.
    const result = resolved.scope.readerType === 'pdf'
      ? await withDocumentAudiobookLock(resolved.scope, resolved.documentId, reclaim)
      : await reclaim();
    return NextResponse.json(result);
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
