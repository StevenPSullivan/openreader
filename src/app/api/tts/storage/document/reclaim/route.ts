import { NextRequest, NextResponse } from 'next/server';
import { getComputeWorkerClient, isComputeWorkerAvailable } from '@/lib/server/compute-worker/client';
import { createRequestLogger } from '@/lib/server/logger';
import { errorResponse } from '@/lib/server/errors/next-response';
import { pinnedSettingsHashes, resolveDocumentStorageScope } from '@/lib/server/tts/storage-scope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
    const signal = AbortSignal.timeout(50_000);
    // Keep exactly what the storage screen reports as current.
    let pinned: string[] | null = [];
    if (resolved.scope.readerType === 'pdf' && resolved.narrationRevision !== null) {
      const report = await client.getUserStorageUsage({
        storageUserId: resolved.scope.storageUserId,
        includePlayback: true,
        documentId: resolved.documentId,
        derivedDocumentIds: [],
        namespace: null,
      }, { signal });
      pinned = await pinnedSettingsHashes(resolved, {
        truncated: report.truncated,
        exports: report.documents.find((row) => row.documentId === resolved.documentId)?.exports ?? [],
      });
    }
    const result = await client.reclaimTtsPlaybackCache({
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
    }, { signal });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, {
      logger,
      event: 'tts.storage.document_reclaim_failed',
      msg: 'Failed to reclaim unused document audio',
      apiErrorMessage: 'Failed to reclaim unused audio',
      normalize: { code: 'TTS_STORAGE_RECLAIM_FAILED', errorClass: 'storage' },
    });
  }
}
