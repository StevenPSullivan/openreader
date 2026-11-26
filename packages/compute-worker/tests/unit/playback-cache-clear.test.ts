import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { clearTtsPlaybackArtifacts } from '../../src/playback/cache-clear';
import type { ArtifactStorage } from '../../src/infrastructure/storage';
import { listMemoryChildPrefixes } from '../fixtures/memory-storage';

class MemoryStorage implements ArtifactStorage {
  async putFile(): Promise<void> { throw new Error('not implemented'); }
  readonly objects = new Map<string, Buffer>();
  readonly modifiedAt = new Map<string, number>();

  async listChildPrefixes(prefix: string, options?: { startAfter?: string; limit?: number }) {
    return listMemoryChildPrefixes(this.objects.keys(), prefix, options);
  }

  async readObject(key: string): Promise<ArrayBuffer> {
    const value = this.objects.get(key);
    if (!value) throw new Error('not found');
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }

  async objectExists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async listPrefix(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }

  async *listPrefixPages(prefix: string) {
    yield [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, size: value.byteLength, lastModifiedMs: this.modifiedAt.get(key) ?? 0 }));
  }

  async putObject(key: string, body: Buffer | Uint8Array): Promise<void> {
    this.objects.set(key, Buffer.from(body));
  }

  async putParsedPdf(): Promise<string> {
    throw new Error('not implemented');
  }
}

/** Audio deletes fast; sidecar deletes are slow, so they are still running when audio stops or fails. */
async function parallelDeletions(storage: MemoryStorage, prefix: string, documentId: string, audioCount: number) {
  const userHash = createHash('sha256').update('user-1').digest('hex');
  const audio = `${prefix}/tts_playback_segments_audio_v1/users/user-1/docs/${documentId}/3/old/`;
  const sidecars = `${prefix}/tts_playback_segments_v1/users/${userHash}/docs/${documentId}/3/old/segments/`;
  for (let index = 0; index < audioCount; index += 1) await storage.putObject(`${audio}${String(index).padStart(3, '0')}.mp3`, Buffer.from('a'));
  for (let index = 0; index < 32; index += 1) await storage.putObject(`${sidecars}${index}.json`, Buffer.from('{}'));
  const state = { inFlight: 0, audioBatchesDone: 0 };
  const deleteObject = storage.deleteObject.bind(storage);
  return { audio, sidecars, state, wrap: (failAudio = false) => {
    storage.deleteObject = async (key: string) => {
      state.inFlight += 1;
      try {
        const isAudio = key.startsWith(audio);
        await new Promise((resolve) => setTimeout(resolve, isAudio ? 1 : 40));
        if (isAudio && failAudio) throw new Error('S3 delete failed');
        await deleteObject(key);
      } finally {
        state.inFlight -= 1;
      }
    };
  } };
}

describe('playback cache clear', () => {
  test('a deadline-bounded clear reports a stop only after a parallel deletion has settled', async () => {
    const storage = new MemoryStorage();
    const prefix = 'openreader-test';
    const documentId = 'c'.repeat(64);
    const setup = await parallelDeletions(storage, prefix, documentId, 40);
    setup.wrap();
    let checks = 0;
    // The deadline passes after the first audio batch, while sidecars are still being deleted.
    const shouldStop = () => (checks += 1) > 2;
    const cleared = clearTtsPlaybackArtifacts({
      storage, s3Prefix: prefix, shouldStop,
      scope: { storageUserId: 'user-1', documentId, documentVersion: 3, settingsHash: 'old', namespace: null },
    });
    await expect(cleared).rejects.toThrow('stopped');
    expect(setup.state.inFlight).toBe(0);
    expect([...storage.objects.keys()].filter((key) => key.startsWith(setup.sidecars))).toHaveLength(0);
  });

  test('a deadline-bounded clear reports a failed deletion only after every deletion it started has settled', async () => {
    const storage = new MemoryStorage();
    const prefix = 'openreader-test';
    const documentId = 'd'.repeat(64);
    const setup = await parallelDeletions(storage, prefix, documentId, 8);
    setup.wrap(true);
    const cleared = clearTtsPlaybackArtifacts({
      storage, s3Prefix: prefix, shouldStop: () => false,
      scope: { storageUserId: 'user-1', documentId, documentVersion: 3, settingsHash: 'old', namespace: null },
    });
    await expect(cleared).rejects.toThrow('S3 delete failed');
    expect(setup.state.inFlight).toBe(0);
    expect([...storage.objects.keys()].filter((key) => key.startsWith(setup.sidecars))).toHaveLength(0);
  });

  test('a stopped clear finishes the batch in flight and starts no other', async () => {
    const storage = new MemoryStorage();
    const prefix = 'openreader-test';
    const documentId = 'a'.repeat(64);
    const audio = `${prefix}/tts_playback_segments_audio_v1/users/user-1/docs/${documentId}/3/old/`;
    for (let index = 0; index < 70; index += 1) await storage.putObject(`${audio}${String(index).padStart(3, '0')}.mp3`, Buffer.from('a'));
    // The deadline passes while the first batch is being deleted.
    let deadlinePassed = false;
    let inFlight = 0;
    let finishedWhileStopped = 0;
    const deleteObject = storage.deleteObject.bind(storage);
    storage.deleteObject = async (key: string) => {
      inFlight += 1;
      deadlinePassed = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await deleteObject(key);
      inFlight -= 1;
      if (deadlinePassed) finishedWhileStopped += 1;
    };
    await expect(clearTtsPlaybackArtifacts({
      storage, s3Prefix: prefix, shouldStop: () => deadlinePassed,
      scope: { storageUserId: 'user-1', documentId, documentVersion: 3, settingsHash: 'old', namespace: null },
    })).rejects.toThrow('stopped');
    // The clear returned only after its in-flight batch, one batch of 32, was done.
    expect(inFlight).toBe(0);
    expect(finishedWhileStopped).toBe(32);
    expect([...storage.objects.keys()].filter((key) => key.startsWith(audio))).toHaveLength(70 - 32);
  });

  test('deletes only the requested playback scope and matching export artifacts', async () => {
    const storage = new MemoryStorage();
    const prefix = 'openreader-test';
    const documentId = 'a'.repeat(64);
    const foreignDocumentId = 'b'.repeat(64);
    const userHash = createHash('sha256').update('user-1').digest('hex');
    await storage.putObject(`${prefix}/tts_playback_segments_audio_v1/users/user-1/docs/${documentId}/3/settings/audio.mp3`, Buffer.from('audio'));
    await storage.putObject(`${prefix}/tts_playback_segments_v1/users/${userHash}/docs/${documentId}/3/settings/segments/0.json`, Buffer.from('{}'));
    await storage.putObject(`${prefix}/tts_playback_plan_v1/${documentId}/3/pdf/plan.json`, Buffer.from('{}'));
    const exportScope = `${prefix}/tts_playback_exports_v1/users/user-1/docs/${documentId}`;
    await storage.putObject(`${exportScope}/export-a/metadata.json`, Buffer.from(JSON.stringify({
      storageUserId: 'user-1', documentId, documentVersion: 3,
    })));
    await storage.putObject(`${exportScope}/export-a/artifact.mp3`, Buffer.from('export'));
    await storage.putObject(`${exportScope}/export-old/metadata.json`, Buffer.from(JSON.stringify({
      storageUserId: 'user-1', documentId, documentVersion: 2,
    })));
    await storage.putObject(`${prefix}/tts_playback_exports_v1/users/user-1/docs/${foreignDocumentId}/export-b/metadata.json`, Buffer.from(JSON.stringify({
      storageUserId: 'user-1', documentId: foreignDocumentId, documentVersion: 3,
    })));

    const result = await clearTtsPlaybackArtifacts({
      storage,
      s3Prefix: prefix,
      scope: { storageUserId: 'user-1', documentId, documentVersion: 3, readerType: 'pdf', namespace: null },
    });

    expect(result).toEqual({
      deletedAudioObjects: 1,
      deletedSidecarObjects: 1,
      deletedPlanObjects: 1,
      deletedExportObjects: 2,
    });
    expect(storage.objects.has(`${exportScope}/export-a/artifact.mp3`)).toBe(false);
    expect(storage.objects.has(`${exportScope}/export-old/metadata.json`)).toBe(true);
    expect(storage.objects.has(`${prefix}/tts_playback_exports_v1/users/user-1/docs/${foreignDocumentId}/export-b/metadata.json`)).toBe(true);
  });

  test('a settings-scoped clear deletes only that variant and keeps the shared plan', async () => {
    const storage = new MemoryStorage();
    const prefix = 'openreader-test';
    const documentId = 'a'.repeat(64);
    const userHash = createHash('sha256').update('user-1').digest('hex');
    const audioRoot = `${prefix}/tts_playback_segments_audio_v1/users/user-1/docs/${documentId}/3`;
    const sidecarRoot = `${prefix}/tts_playback_segments_v1/users/${userHash}/docs/${documentId}/3`;
    await storage.putObject(`${audioRoot}/unused/audio.mp3`, Buffer.from('a'));
    await storage.putObject(`${audioRoot}/current/audio.mp3`, Buffer.from('a'));
    await storage.putObject(`${sidecarRoot}/unused/segments/0.json`, Buffer.from('{}'));
    await storage.putObject(`${sidecarRoot}/current/segments/0.json`, Buffer.from('{}'));
    await storage.putObject(`${prefix}/tts_playback_plan_v1/${documentId}/3/pdf/plan.json`, Buffer.from('{}'));
    const exportScope = `${prefix}/tts_playback_exports_v1/users/user-1/docs/${documentId}`;
    await storage.putObject(`${exportScope}/unused-export/metadata.json`, Buffer.from(JSON.stringify({
      documentVersion: 3, settingsHash: 'unused',
    })));
    await storage.putObject(`${exportScope}/current-export/metadata.json`, Buffer.from(JSON.stringify({
      documentVersion: 3, settingsHash: 'current',
    })));

    const result = await clearTtsPlaybackArtifacts({
      storage,
      s3Prefix: prefix,
      scope: { storageUserId: 'user-1', documentId, documentVersion: 3, settingsHash: 'unused', namespace: null },
    });

    expect(result).toEqual({
      deletedAudioObjects: 1,
      deletedSidecarObjects: 1,
      deletedPlanObjects: 0,
      deletedExportObjects: 1,
    });
    expect([...storage.objects.keys()].sort()).toEqual([
      `${audioRoot}/current/audio.mp3`,
      `${exportScope}/current-export/metadata.json`,
      `${prefix}/tts_playback_plan_v1/${documentId}/3/pdf/plan.json`,
      `${sidecarRoot}/current/segments/0.json`,
    ].sort());
  });

  test('rejects a settings-scoped clear without a document version', async () => {
    await expect(clearTtsPlaybackArtifacts({
      storage: new MemoryStorage(),
      s3Prefix: 'openreader-test',
      scope: { storageUserId: 'user-1', documentId: 'a'.repeat(64), settingsHash: 'unused', namespace: null },
    })).rejects.toThrow('requires a document version');
  });
});
