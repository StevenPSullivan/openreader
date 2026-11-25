import { after, NextRequest } from 'next/server';
import { expect, test, vi } from 'vitest';
import { COMPUTE_ADMISSION_ACTION_HEADER } from '@openreader/runtime-config/compute-limit-broker';
import { POST } from '@/app/api/internal/compute/limits/complete/route';
import { advanceAudiobooksAfterOperation } from '@/lib/server/audiobooks/audiobooks';

vi.mock('next/server', async (importOriginal) => ({
  ...await importOriginal<typeof import('next/server')>(),
  after: vi.fn(),
}));
vi.mock('@openreader/database', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) },
}));
vi.mock('@/lib/server/compute-worker/credential-broker-auth', () => ({
  authenticateCredentialBrokerRequest: () => 'authorized',
}));
vi.mock('@/lib/server/compute-limits/admission', () => ({ finishComputeAdmission: vi.fn() }));
vi.mock('@/lib/server/audiobooks/audiobooks', () => ({
  advanceAudiobooksAfterOperation: vi.fn(async () => undefined),
}));

test('signals audiobook waiters when a PDF layout has no admission owner', async () => {
  const result = await POST(new NextRequest('http://localhost/api/internal/compute/limits/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [COMPUTE_ADMISSION_ACTION_HEADER]: 'pdf_layout' },
    body: JSON.stringify({ operationId: 'shared-pdf-without-admission', state: 'succeeded' }),
  }));

  expect(result.status).toBe(204);
  const callback = vi.mocked(after).mock.calls[0]?.[0];
  expect(callback).toBeTypeOf('function');
  if (typeof callback === 'function') await callback();
  expect(advanceAudiobooksAfterOperation).toHaveBeenCalledWith('shared-pdf-without-admission', undefined);
});
