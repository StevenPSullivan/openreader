import { beforeEach, describe, expect, test, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  usage: vi.fn(),
  totals: vi.fn(),
  audioDocumentIds: [] as string[],
  reclaim: vi.fn(),
  owned: new Set<string>(),
  workerAvailable: true,
  authorized: true,
  pinned: vi.fn(),
  lock: vi.fn(),
}));

vi.mock('@/lib/server/admin/settings', () => ({ getRuntimeConfig: async () => ({}) }));
vi.mock('@/lib/server/storage/usage', () => ({
  getStorageUsage: mocks.totals,
  storageCapBytes: () => null,
  listAudioDocumentIds: async () => mocks.audioDocumentIds,
}));

vi.mock('@/lib/server/compute-worker/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/server/compute-worker/client')>(),
  isComputeWorkerAvailable: () => mocks.workerAvailable,
  getComputeWorkerClient: () => ({
    getUserStorageUsage: mocks.usage,
    reclaimTtsPlaybackCache: mocks.reclaim,
  }),
}));
vi.mock('@/lib/server/auth/auth', () => ({
  requireAuthContext: async () => (mocks.authorized
    ? { userId: 'user-1' }
    : Response.json({ error: 'Unauthorized' }, { status: 401 })),
}));
vi.mock('@/lib/server/tts/storage-scope', () => ({
  resolveDocumentStorageScope: async (request: NextRequest) => {
    const body = await request.json().catch(() => null) as { documentId?: string } | null;
    if (!body?.documentId) return Response.json({ error: 'Invalid request payload' }, { status: 400 });
    return {
      documentId: body.documentId,
      scope: { storageUserId: 'user-1', documentVersion: 3, readerType: 'pdf' },
      settingsHash: 'current-hash',
      parsed: {},
      narrationRevision: 'r'.repeat(32),
    };
  },
  pinnedSettingsHashes: mocks.pinned,
  refreshStorageIdentity: async (resolved: unknown) => resolved,
  listOwnedDocumentIds: async () => new Set(mocks.owned),
  filterOwnedDocumentIds: async (_userId: string, ids: string[]) => new Set(ids.filter((id) => mocks.owned.has(id))),
}));
vi.mock('@/lib/server/audiobooks/audiobooks', () => ({ withDocumentAudiobookLock: mocks.lock }));
vi.mock('@/lib/server/logger', () => ({
  createRequestLogger: () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }),
}));

import { POST as documentUsage } from '@/app/api/tts/storage/document/route';
import { POST as documentReclaim } from '@/app/api/tts/storage/document/reclaim/route';
import { GET as libraryUsage } from '@/app/api/tts/storage/route';
import { POST as libraryReclaim } from '@/app/api/tts/storage/reclaim/route';

const post = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, {
  method: 'POST', body: JSON.stringify(body),
});

const variant = (documentVersion: number, settingsHash: string, bytes: number) => (
  { documentVersion, settingsHash, bytes, objects: 1 }
);

const reclaimResult = {
  reclaimedVariants: 1, deletedAudioObjects: 2, deletedSidecarObjects: 1, deletedExportObjects: 0,
  invalidatedPlaybackSessions: 0, invalidatedJobOperations: 0,
};

describe('storage routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.owned = new Set();
    mocks.workerAvailable = true;
    mocks.authorized = true;
    mocks.reclaim.mockResolvedValue(reclaimResult);
    mocks.pinned.mockReset();
    mocks.pinned.mockResolvedValue([]);
    mocks.lock.mockReset();
    mocks.lock.mockImplementation((_scope: unknown, _documentId: string, run: () => Promise<unknown>) => run());
    mocks.usage.mockResolvedValue({ documents: [], scannedObjects: 0, truncated: false });
  });

  test('measures one document against the current cache identity', async () => {
    mocks.usage.mockResolvedValueOnce({
      documents: [{
        documentId: 'doc-1',
        variants: [variant(3, 'current-hash', 120), variant(3, 'old-voice', 80)],
        exports: [],
        derivedBytes: 50,
        derivedObjects: 2,
      }],
      scannedObjects: 4,
      truncated: false,
    });
    const response = await documentUsage(post('/api/tts/storage/document', { documentId: 'doc-1' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      currentAudioBytes: 120, unusedAudioBytes: 80, documentDataBytes: 50, truncated: false,
    });
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({
      storageUserId: 'user-1', documentId: 'doc-1', derivedDocumentIds: ['doc-1'], includePlayback: true,
    }), expect.anything());
  });

  test('rejects invalid document payloads and reports a missing worker', async () => {
    expect((await documentUsage(post('/api/tts/storage/document', {}))).status).toBe(400);
    mocks.workerAvailable = false;
    expect((await documentUsage(post('/api/tts/storage/document', { documentId: 'doc-1' }))).status).toBe(503);
    expect((await documentReclaim(post('/api/tts/storage/document/reclaim', { documentId: 'doc-1' }))).status).toBe(503);
    expect(mocks.usage).not.toHaveBeenCalled();
    expect(mocks.reclaim).not.toHaveBeenCalled();
  });

  test('reports a retryable measurement timeout instead of a generic storage error', async () => {
    mocks.usage.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
    const response = await documentUsage(post('/api/tts/storage/document', { documentId: 'doc-1' }));
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect((await response.json()).error).toContain('Try again');
  });

  test('explains an older worker missing the storage endpoint', async () => {
    const { ComputeWorkerClient } = await import('@/lib/server/compute-worker/client');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Not found' }, { status: 404 })));
    try {
      const client = new ComputeWorkerClient({ baseUrl: 'http://worker.test', token: 'test-token' });
      const error = await client.getUserStorageUsage({ storageUserId: 'user-1', includePlayback: true,
        derivedDocumentIds: [], namespace: null })
        .catch((error: unknown) => error);
      mocks.usage.mockRejectedValueOnce(error);
      const response = await documentUsage(post('/api/tts/storage/document', { documentId: 'doc-1' }));
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain('Redeploy the worker to match the web version');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('reclaims a document while keeping the current version and settings', async () => {
    const response = await documentReclaim(post('/api/tts/storage/document/reclaim', { documentId: 'doc-1' }));
    expect(response.status).toBe(200);
    expect(mocks.reclaim).toHaveBeenCalledWith({
      storageUserId: 'user-1',
      documentId: 'doc-1',
      keep: { documentVersion: 3, settingsHash: 'current-hash' },
      notAfter: expect.any(Number),
    }, expect.anything());
  });

  test('keeps and reports audio pinned to an earlier PDF layout the same way', async () => {
    mocks.pinned.mockResolvedValue(['pinned-hash']);
    const pinnedExport = { documentVersion: 3, settingsHash: 'pinned-hash', planObjectKey: 'plan.json', bytes: 400, objects: 2 };
    mocks.usage.mockResolvedValue({
      documents: [{
        documentId: 'doc-1',
        variants: [variant(3, 'current-hash', 120), variant(3, 'pinned-hash', 70), variant(3, 'old-voice', 80), variant(2, 'pinned-hash', 30)],
        exports: [pinnedExport],
        derivedBytes: 50,
        derivedObjects: 2,
      }],
      scannedObjects: 8,
      truncated: false,
      exportsComplete: true,
    });
    const usage = await documentUsage(post('/api/tts/storage/document', { documentId: 'doc-1' }));
    expect(await usage.json()).toEqual({
      currentAudioBytes: 120 + 70 + 400, unusedAudioBytes: 80 + 30, documentDataBytes: 50, truncated: false,
    });
    await documentReclaim(post('/api/tts/storage/document/reclaim', { documentId: 'doc-1' }));
    expect(mocks.reclaim).toHaveBeenCalledWith({
      storageUserId: 'user-1',
      documentId: 'doc-1',
      keep: { documentVersion: 3, settingsHash: 'current-hash', settingsHashes: ['pinned-hash'] },
      notAfter: expect.any(Number),
    }, expect.anything());
    // Both requests judged the same report.
    expect(mocks.pinned.mock.calls.map((call) => call[1])).toEqual([
      { exportsComplete: true, exports: [pinnedExport] }, { exportsComplete: true, exports: [pinnedExport] },
    ]);
  });

  test('reclaims a reparsed PDF while holding its audiobook lock', async () => {
    const response = await documentReclaim(post('/api/tts/storage/document/reclaim', { documentId: 'doc-1' }));
    expect(response.status).toBe(200);
    expect(mocks.lock).toHaveBeenCalledWith(expect.objectContaining({ storageUserId: 'user-1' }), 'doc-1', expect.any(Function));

    // Another audiobook command still running on Postgres asks the caller to retry.
    const { ApiRequestError } = await import('@/lib/server/api/responses');
    mocks.lock.mockRejectedValueOnce(new ApiRequestError(503, 'AUDIOBOOK_BUSY', 'Another request for this audiobook is still running.', 5_000));
    const busy = await documentReclaim(post('/api/tts/storage/document/reclaim', { documentId: 'doc-1' }));
    expect(busy.status).toBe(503);
    expect(busy.headers.get('Retry-After')).toBe('5');
    expect((await busy.json()).code).toBe('AUDIOBOOK_BUSY');
  });

  test('keeps and reports the whole current version when the report is incomplete', async () => {
    mocks.pinned.mockResolvedValue(null);
    mocks.usage.mockResolvedValue({
      documents: [{
        documentId: 'doc-1',
        variants: [variant(3, 'current-hash', 120), variant(3, 'old-layout', 70), variant(2, 'current-hash', 30)],
        exports: [],
        derivedBytes: 50,
        derivedObjects: 2,
      }],
      scannedObjects: 200_000,
      truncated: true,
      exportsComplete: false,
    });
    const usage = await documentUsage(post('/api/tts/storage/document', { documentId: 'doc-1' }));
    expect(await usage.json()).toEqual({
      currentAudioBytes: 120 + 70, unusedAudioBytes: 30, documentDataBytes: 50, truncated: true,
    });
    await documentReclaim(post('/api/tts/storage/document/reclaim', { documentId: 'doc-1' }));
    expect(mocks.reclaim).toHaveBeenCalledWith({
      storageUserId: 'user-1',
      documentId: 'doc-1',
      keep: { documentVersion: 3 },
      notAfter: expect.any(Number),
    }, expect.anything());
  });

  test('reads the SQL total without measuring storage, including while the worker is down', async () => {
    mocks.workerAvailable = false;
    const total = { documentBytes: 20, audioBytes: 140, totalBytes: 160, documentCount: 1, orphanedAudioBytes: 40, orphanedDocumentCount: 1 };
    mocks.totals.mockResolvedValue(new Map([['user-1', total]]));
    const response = await libraryUsage(new NextRequest('http://localhost/api/tts/storage'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...total, capBytes: null });
    expect(mocks.totals).toHaveBeenCalledWith(['user-1']);
    expect(mocks.usage).not.toHaveBeenCalled();
  });

  test('requires a session for library storage', async () => {
    mocks.authorized = false;
    expect((await libraryUsage(new NextRequest('http://localhost/api/tts/storage'))).status).toBe(401);
    expect((await libraryReclaim(post('/api/tts/storage/reclaim', { target: 'all' }))).status).toBe(401);
    expect(mocks.usage).not.toHaveBeenCalled();
  });

  test('reclaims only orphaned documents in bounded batches', async () => {
    mocks.owned = new Set(['kept']);
    mocks.audioDocumentIds = ['kept', 'a', 'b', 'c', 'd', 'e', 'f'];
    const response = await libraryReclaim(post('/api/tts/storage/reclaim', { target: 'orphaned' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reclaimedDocuments: 5, remainingDocuments: 1, deletedObjects: 15 });
    const reclaimed = mocks.reclaim.mock.calls.map(([input]) => input);
    expect(reclaimed.map((input) => input.documentId)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(reclaimed.every((input) => input.keep === null && input.storageUserId === 'user-1')).toBe(true);
  });

  test('rejects unknown library reclaim targets', async () => {
    expect((await libraryReclaim(post('/api/tts/storage/reclaim', { target: 'derived' }))).status).toBe(400);
    expect(mocks.reclaim).not.toHaveBeenCalled();
  });
});
