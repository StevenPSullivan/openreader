import { and, eq, inArray } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '@openreader/database';
import { documents } from '@openreader/database/schema';
import { buildTtsPlaybackPlanningInput, parseTtsPlaybackRequestBody } from '@/lib/server/tts/playback-request';
import { resolveSegmentDocumentScope, type ResolvedSegmentDocumentScope } from '@/lib/server/tts/segments-auth';
import { liveAudiobookVariants } from '@/lib/server/audiobooks/audiobooks';
import { resolvePdfNarrationRevision } from '@/lib/server/tts/pdf-narration-revision';
import type { ParsedTtsPlaybackRequestBody } from '@/lib/server/tts/playback-request';

export type DocumentStorageScope = {
  documentId: string;
  scope: ResolvedSegmentDocumentScope;
  /** The cache identity the reader would request now for this document. */
  settingsHash: string;
  /** The settings payload the identity was built from. */
  parsed: ParsedTtsPlaybackRequestBody;
  /** The current PDF layout's narration revision, if a reparse set one. */
  narrationRevision: string | null;
};

/**
 * Resolve the current playback cache identity for a document from the same
 * settings payload the reader sends for plans and sessions, so "current" audio
 * here is exactly the audio the next playback would reuse.
 */
export async function resolveDocumentStorageScope(
  request: NextRequest,
): Promise<DocumentStorageScope | Response> {
  const parsed = parseTtsPlaybackRequestBody(await request.json().catch(() => null));
  if (!parsed) return NextResponse.json({ error: 'Invalid request payload' }, { status: 400 });
  const scope = await resolveSegmentDocumentScope(request, parsed.documentId);
  if (scope instanceof Response) return scope;
  // Storage measures against the published layout, whatever plan the request
  // names. Audio for an earlier layout's plan is kept through its export.
  const narrationRevision = scope.readerType === 'pdf'
    ? await resolvePdfNarrationRevision(parsed.documentId, scope)
    : null;
  const { settingsHash } = await buildTtsPlaybackPlanningInput(parsed, scope, { narrationRevision });
  return { documentId: parsed.documentId, scope, settingsHash, parsed, narrationRevision };
}

/**
 * The identity of the layout published now, for a scope resolved earlier in
 * the request. PDF reclaim calls this once it holds the audiobook lock.
 */
export async function refreshStorageIdentity(resolved: DocumentStorageScope): Promise<DocumentStorageScope> {
  if (resolved.scope.readerType !== 'pdf') return resolved;
  const narrationRevision = await resolvePdfNarrationRevision(resolved.documentId, resolved.scope);
  const { settingsHash } = await buildTtsPlaybackPlanningInput(resolved.parsed, resolved.scope, { narrationRevision });
  return { ...resolved, settingsHash, narrationRevision };
}

/**
 * Other cache identities of this version that are still in use after a Force
 * reparse: audio made with the current settings on an earlier PDF layout,
 * which an export or a live audiobook request was built from. An identity is
 * kept only when the current settings on that layout produce exactly it, so
 * audio for other voices or settings stays reclaimable. The storage screen and
 * reclaim use the same set.
 *
 * Null means the report cannot rule out an export on an earlier layout (not
 * every export was listed and attributed), so the whole current version is
 * kept. Only a layout a reparse changed can have earlier-layout exports.
 */
export async function pinnedSettingsHashes(
  resolved: DocumentStorageScope,
  report: {
    exportsComplete?: boolean;
    exports: ReadonlyArray<{ documentVersion: number | null; settingsHash: string | null; planObjectKey?: string }>;
  },
): Promise<string[] | null> {
  const { scope, documentId, parsed } = resolved;
  if (scope.readerType !== 'pdf' || resolved.narrationRevision === null) return [];
  const { exports } = report;
  const unattributed = exports.some((row) => row.documentVersion === null || row.settingsHash === null
    || (row.documentVersion === scope.documentVersion && row.settingsHash !== resolved.settingsHash && !row.planObjectKey));
  if (report.exportsComplete !== true || unattributed) return null;
  const candidates: Array<{ settingsHash: string; narrationRevision: string | null }> = [];
  for (const row of exports) {
    if (row.documentVersion !== scope.documentVersion || !row.settingsHash || !row.planObjectKey
      || row.settingsHash === resolved.settingsHash) continue;
    // A plan that is gone resolves to the current layout, which never matches.
    candidates.push({
      settingsHash: row.settingsHash,
      narrationRevision: await resolvePdfNarrationRevision(documentId, scope, row.planObjectKey),
    });
  }
  for (const variant of await liveAudiobookVariants(scope, documentId)) {
    if (variant.settingsHash !== resolved.settingsHash) candidates.push(variant);
  }
  const currentOn = new Map<string | null, string>();
  const pinned: string[] = [];
  for (const { settingsHash, narrationRevision } of candidates) {
    if (pinned.includes(settingsHash)) continue;
    let current = currentOn.get(narrationRevision);
    if (current === undefined) {
      current = (await buildTtsPlaybackPlanningInput(parsed, scope, { narrationRevision })).settingsHash;
      currentOn.set(narrationRevision, current);
    }
    if (current === settingsHash) pinned.push(settingsHash);
  }
  return pinned;
}

export async function listOwnedDocumentIds(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(eq(documents.userId, userId)) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/** Re-check ownership right before deleting, so a just-restored document keeps its audio. */
export async function filterOwnedDocumentIds(userId: string, documentIds: string[]): Promise<Set<string>> {
  if (documentIds.length === 0) return new Set();
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.userId, userId), inArray(documents.id, documentIds))) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}
