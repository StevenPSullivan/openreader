import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/lib/server/storage/s3', () => ({
  getS3Config: () => ({ bucket: 'bucket' }),
  getS3InternalClient: () => ({ send: mocks.send }),
}));
vi.mock('@/lib/server/compute-worker/client', () => ({ getComputeWorkerClient: vi.fn() }));

import { readTtsPlaybackPlanArtifact, ttsPlaybackPlanArtifactExists } from '@/lib/server/tts/playback-plans';

const body = JSON.stringify({ schemaVersion: 1, segments: [{ ordinal: 0, text: 'A sentence.' }] });

beforeEach(() => {
  mocks.send.mockReset().mockResolvedValue({ Body: { transformToString: async () => body } });
});

test('reads an immutable plan artifact once per object key', async () => {
  const first = await readTtsPlaybackPlanArtifact('plans/cached.json');
  const second = await readTtsPlaybackPlanArtifact('plans/cached.json');
  expect(second).toBe(first);
  expect(first.artifact.segments).toHaveLength(1);
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

test('retries a plan artifact whose read failed', async () => {
  mocks.send.mockRejectedValueOnce(new Error('unavailable'));
  await expect(readTtsPlaybackPlanArtifact('plans/flaky.json')).rejects.toThrow('unavailable');
  await expect(readTtsPlaybackPlanArtifact('plans/flaky.json')).resolves.toMatchObject({ body });
  expect(mocks.send).toHaveBeenCalledTimes(2);
});

test('checks that a plan is still stored in storage, not in the cache', async () => {
  await readTtsPlaybackPlanArtifact('plans/removed.json');
  mocks.send.mockReset().mockRejectedValue(Object.assign(new Error('missing'), { name: 'NotFound' }));
  expect(await ttsPlaybackPlanArtifactExists('plans/removed.json')).toBe(false);
  expect(mocks.send.mock.calls[0]?.[0]?.constructor?.name).toBe('HeadObjectCommand');
  mocks.send.mockReset().mockResolvedValue({});
  expect(await ttsPlaybackPlanArtifactExists('plans/removed.json')).toBe(true);
});
