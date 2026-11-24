import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { PdfTextItem } from './document-layout';

interface ViewportLike {
  height: number;
  transform: readonly number[];
}

interface TextStyleLike {
  ascent?: number;
  descent?: number;
}

function applyViewportTransform(
  x: number,
  y: number,
  transform: readonly number[],
): { x: number; y: number } {
  const a = Number(transform[0] ?? 1);
  const b = Number(transform[1] ?? 0);
  const c = Number(transform[2] ?? 0);
  const d = Number(transform[3] ?? 1);
  const e = Number(transform[4] ?? 0);
  const f = Number(transform[5] ?? 0);
  return {
    x: (a * x) + (c * y) + e,
    y: (b * x) + (d * y) + f,
  };
}

function resolveTopOffset(height: number, style: TextStyleLike | undefined): number {
  const ascent = Number(style?.ascent);
  if (Number.isFinite(ascent) && ascent > 0) {
    return height * ascent;
  }

  const descent = Number(style?.descent);
  if (Number.isFinite(descent) && descent < 0) {
    return height * (1 + descent);
  }

  return height;
}

export function normalizeTextItemsForLayout(
  items: TextItem[],
  viewport: ViewportLike,
  styles: Record<string, TextStyleLike> = {},
): PdfTextItem[] {
  const normalized: PdfTextItem[] = [];
  let spaceBefore = false;
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.str) continue;
    if (!item.str.trim()) {
      spaceBefore = true;
      continue;
    }
    const explicitSpace = spaceBefore;
    spaceBefore = false;
    const transform = item.transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;

    const [a, b, c, d, x, y] = transform;
    if (![a, b, c, d, x, y].every(Number.isFinite)) continue;
    // A PDF page rotation can turn a text run upright in the reader's viewport.
    const [va = 1, vb = 0, vc = 0, vd = 1] = viewport.transform;
    const baselineX = va * a + vc * b;
    const baselineY = vb * a + vd * b;
    const upX = va * c + vc * d;
    const upY = vb * c + vd * d;
    const isRotated = Math.abs(baselineY) > 0.5 || Math.abs(upX) > 0.5 || baselineX < 0 || upY > 0;
    const width = Math.max(0, Number(item.width ?? 0));
    const height = Math.max(1, isRotated ? Math.hypot(c, d) : Math.abs(upY));
    const topOffset = resolveTopOffset(height, styles[item.fontName ?? '']);
    const origin = applyViewportTransform(x, y, viewport.transform);
    if (isRotated) {
      const baselineLength = Math.hypot(a, b);
      const fontHeight = Math.hypot(c, d);
      const viewportBaselineLength = Math.hypot(baselineX, baselineY);
      if (baselineLength === 0 || fontHeight === 0 || viewportBaselineLength === 0) continue;
      // Tilted labels have perpendicular font axes. Keep excluding sheared runs.
      if (Math.abs(a * c + b * d) / (baselineLength * fontHeight) > 0.05) continue;

      const advanceX = a * width / baselineLength;
      const advanceY = b * width / baselineLength;
      const topX = x + c * topOffset / fontHeight;
      const topY = y + d * topOffset / fontHeight;
      const corners = [
        applyViewportTransform(topX, topY, viewport.transform),
        applyViewportTransform(topX + advanceX, topY + advanceY, viewport.transform),
        applyViewportTransform(topX - c, topY - d, viewport.transform),
        applyViewportTransform(topX + advanceX - c, topY + advanceY - d, viewport.transform),
      ];
      const xs = corners.map(corner => corner.x);
      const ys = corners.map(corner => corner.y);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      normalized.push({
        text: item.str,
        x: Math.max(0, left),
        y: Math.max(0, top),
        width: Math.max(...xs) - left,
        height: Math.max(...ys) - top,
        rotation: {
          x: origin.x,
          y: origin.y,
          dx: baselineX / viewportBaselineLength,
          dy: baselineY / viewportBaselineLength,
          advance: width * viewportBaselineLength / baselineLength,
          spaceBefore: explicitSpace,
        },
      });
      continue;
    }

    // Map the baseline from PDF user space before applying the font ascent.
    normalized.push({
      text: item.str,
      x: Math.max(0, origin.x),
      y: Math.max(0, origin.y - topOffset),
      width,
      height,
      baselineY: origin.y,
    });
  }
  return normalized;
}
