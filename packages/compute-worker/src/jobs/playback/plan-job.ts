import type { TtsPlaybackPlanJobRequest, TtsPlaybackPlanJobResult } from '../../operations/contracts';
import type { JobHandlerContext } from '../context';
import type { JobAttempt } from '../../operations/types';
import { resolveAndPersistTtsPlaybackPlan } from './plan';
import { ttsPlaybackPlanRequestSchema, type TtsPlaybackPlanCapableRequest } from './schemas';

export function createTtsPlaybackPlanHandler(input: JobHandlerContext) {
  return async function runTtsPlaybackPlan(payload: TtsPlaybackPlanJobRequest, queueWaitMs: number, attempt?: JobAttempt): Promise<TtsPlaybackPlanJobResult> {
    const { pdfParserVersion, ...request } = payload;
    const parsed = ttsPlaybackPlanRequestSchema.parse(request);
    const startedAt = Date.now();
    const plan = await resolveAndPersistTtsPlaybackPlan({
      request: { ...parsed, sessionId: `plan:${parsed.documentId}:${parsed.settingsHash}` } satisfies TtsPlaybackPlanCapableRequest,
      storage: input.storage,
      s3Prefix: input.s3Prefix,
      // Durable jobs queued before parser versioning still use the original layout.
      pdfParserVersion: pdfParserVersion ?? null,
      attempt,
    });
    return {
      planObjectKey: plan.planObjectKey,
      planSignature: plan.planSignature,
      startOrdinal: plan.startOrdinal,
      plannedCount: plan.plannedSegments.length,
      timing: { queueWaitMs, computeMs: Date.now() - startedAt },
    };
  };
}
