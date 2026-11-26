import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolved: { value: null as Record<string, unknown> | null },
  reclaim: vi.fn(),
  usage: vi.fn(),
}));

vi.mock('@/lib/server/tts/storage-scope', () => ({
  resolveDocumentStorageScope: async () => mocks.resolved.value,
  pinnedSettingsHashes: async () => [],
}));
vi.mock('@/lib/server/compute-worker/client', () => ({
  isComputeWorkerAvailable: () => true,
  getComputeWorkerClient: () => ({ reclaimTtsPlaybackCache: mocks.reclaim, getUserStorageUsage: mocks.usage }),
}));
vi.mock('@/lib/server/logger', () => ({
  createRequestLogger: () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }),
}));

import { POST as reclaimRoute } from '@/app/api/tts/storage/document/reclaim/route';
import { withDocumentAudiobookLock } from '@/lib/server/audiobooks/audiobooks';

const DOCUMENT_ID = 'a'.repeat(64);
const scope = { userId: 'user-1', storageUserId: 'user-1', documentVersion: 3, readerType: 'pdf' };
const done = { reclaimedVariants: 1, deletedAudioObjects: 1, deletedSidecarObjects: 1, deletedExportObjects: 0,
  invalidatedPlaybackSessions: 0, invalidatedJobOperations: 0 };
const post = () => reclaimRoute(new NextRequest('http://localhost/api/tts/storage/document/reclaim', {
  method: 'POST', body: JSON.stringify({ documentId: DOCUMENT_ID }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.usage.mockResolvedValue({ documents: [], scannedObjects: 0, truncated: false, exportsComplete: true });
});

describe('reclaim and audiobook publishing', () => {
  test.each([
    ['a reparsed PDF', 'c'.repeat(32)],
    // A reparse can publish the first revision while this reclaim runs.
    ['a PDF without a revision yet', null],
  ])('an audiobook waits until the worker has finished deleting for %s', async (_label, narrationRevision) => {
    mocks.resolved.value = { documentId: DOCUMENT_ID, scope, settingsHash: 'current', parsed: {}, narrationRevision };
    let finishWorker!: () => void;
    let workerFinished = false;
    mocks.reclaim.mockImplementation(() => new Promise((resolve) => {
      finishWorker = () => { workerFinished = true; resolve(done); };
    }));

    const response = post();
    await vi.waitFor(() => expect(mocks.reclaim).toHaveBeenCalledOnce());
    let publishedWhileDeleting: boolean | undefined;
    const publish = withDocumentAudiobookLock(scope as never, DOCUMENT_ID, async () => {
      publishedWhileDeleting = !workerFinished;
    });
    // The worker is still deleting: a deletion in flight past the old 50 s
    // abort would be here. The publisher must not run yet.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(publishedWhileDeleting).toBeUndefined();
    finishWorker();
    expect((await response).status).toBe(200);
    await publish;
    expect(publishedWhileDeleting).toBe(false);
  });

  test('the worker is told to stop deleting well before the request is abandoned', async () => {
    mocks.resolved.value = { documentId: DOCUMENT_ID, scope, settingsHash: 'current', parsed: {}, narrationRevision: null };
    mocks.reclaim.mockResolvedValue({ ...done, stoppedEarly: true });
    const before = Date.now();
    const response = await post();
    expect(await response.json()).toMatchObject({ stoppedEarly: true });
    const [request, options] = mocks.reclaim.mock.calls[0]!;
    expect(request.notAfter).toBeGreaterThanOrEqual(before + 30_000);
    expect(request.notAfter).toBeLessThanOrEqual(Date.now() + 40_000);
    // The worker call itself outlasts the deletion window, so the lock is held
    // until the worker has answered.
    expect(options.signal.aborted).toBe(false);
  });

  test('other readers reclaim without the audiobook lock', async () => {
    mocks.resolved.value = { documentId: DOCUMENT_ID, scope: { ...scope, readerType: 'epub' }, settingsHash: 'current', parsed: {}, narrationRevision: null };
    let finishWorker!: () => void;
    mocks.reclaim.mockImplementation(() => new Promise((resolve) => { finishWorker = () => resolve(done); }));
    const response = post();
    await vi.waitFor(() => expect(mocks.reclaim).toHaveBeenCalledOnce());
    let published = false;
    await withDocumentAudiobookLock({ ...scope, readerType: 'epub' } as never, DOCUMENT_ID, async () => { published = true; });
    expect(published).toBe(true);
    finishWorker();
    expect((await response).status).toBe(200);
  });
});
