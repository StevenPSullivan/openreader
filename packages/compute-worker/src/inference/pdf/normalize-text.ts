import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { PdfTextItem } from './document-layout';

interface ViewportLike {
  width?: number;
  height: number;
  transform: readonly number[];
}

interface TextStyleLike {
  ascent?: number;
  descent?: number;
  vertical?: boolean;
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

function clipBounds(x: number, y: number, width: number, height: number, viewport: ViewportLike) {
  const pageWidth = viewport.width ?? Infinity;
  if (x + width <= 0 || x >= pageWidth || y + height <= 0 || y >= viewport.height) return undefined;
  const right = Math.min(x + width, pageWidth);
  const bottom = Math.min(y + height, viewport.height);
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function clipTextQuad(points: Array<{ x: number; y: number }>, viewport: ViewportLike) {
  const edges = [
    ['x', 0, 1], ['x', viewport.width ?? Infinity, -1],
    ['y', 0, 1], ['y', viewport.height, -1],
  ] as const;
  for (const [axis, boundary, direction] of edges) {
    if (points.every(point => (point[axis] - boundary) * direction >= 0)) continue;
    const clipped: typeof points = [];
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index]!;
      const end = points[(index + 1) % points.length]!;
      const startInside = (start[axis] - boundary) * direction >= 0;
      const endInside = (end[axis] - boundary) * direction >= 0;
      if (startInside) clipped.push(start);
      if (startInside !== endInside) {
        const ratio = (boundary - start[axis]) / (end[axis] - start[axis]);
        clipped.push({ x: start.x + ratio * (end.x - start.x), y: start.y + ratio * (end.y - start.y) });
      }
    }
    if (clipped.length === 0) return undefined;
    points = clipped;
  }
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return clipBounds(left, top, Math.max(...xs) - left, Math.max(...ys) - top, viewport);
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

function nativeVerticalAdvance(height: number, a: number, b: number, c: number, d: number): number {
  // Shear can add a component along the cross-column axis to the PDF.js height.
  const across = Math.abs(a * d - b * c) / Math.hypot(a, b);
  return across > 0 ? Math.max(0, height) * Math.hypot(c, d) / across : 0;
}

function distanceFromSpaceEnd(
  space: TextItem,
  text: TextItem,
  styles: Record<string, TextStyleLike>,
): number {
  const [sa, sb, sc, sd, sx, sy] = space.transform;
  const [a, b, c, d, x, y] = text.transform;
  const vertical = Boolean(styles[text.fontName]?.vertical);
  if (Boolean(styles[space.fontName]?.vertical) !== vertical) return Infinity;
  const [spaceX, spaceY] = vertical ? [-sc, -sd] : [sa, sb];
  const [textX, textY] = vertical ? [-c, -d] : [a, b];
  const length = Math.hypot(spaceX, spaceY);
  const alignment = (spaceX * textX + spaceY * textY) / (length * Math.hypot(textX, textY));
  if (length === 0 || !Number.isFinite(alignment) || alignment < 0.999) return Infinity;

  const dx = spaceX / length;
  const dy = spaceY / length;
  const along = (x - sx) * dx + (y - sy) * dy;
  const across = (x - sx) * dy - (y - sy) * dx;
  const advance = vertical ? nativeVerticalAdvance(space.height, sa, sb, sc, sd) : space.width;
  const runAdvance = vertical ? nativeVerticalAdvance(text.height, a, b, c, d) : text.width;
  if (!(Math.abs(across) <= 2 && along >= -2 && along <= advance + 2 && along + runAdvance > 0)) return Infinity;
  // An overlapping run is only a fallback for imprecise PDF text positions.
  return Math.hypot(along - advance, across) + (along < 0 ? 4 : 0);
}

const SPACE_BUCKET_SIZE = 16;

interface PendingSpace {
  item: TextItem;
  buckets: Set<PendingSpace>[];
  distance: number;
  next?: PdfTextItem;
}

function spaceBucketKeys(item: TextItem, vertical: boolean): string[] {
  const [a, b, c, d, x, y] = item.transform;
  const [dx, dy] = vertical ? [-c, -d] : [a, b];
  const length = Math.hypot(dx, dy);
  const advance = vertical ? nativeVerticalAdvance(item.height, a, b, c, d) : item.width;
  if (length === 0 || !Number.isFinite(advance)) return [];
  // Index across the writing direction so unrelated rows and columns are skipped.
  const acrossX = Math.abs(dy) > Math.abs(dx);
  const anchor = acrossX ? x : y;
  const direction = (acrossX ? dx : dy) / length;
  const start = -2 * direction;
  const end = (advance + 2) * direction;
  const first = Math.floor((anchor + Math.min(start, end) - 2) / SPACE_BUCKET_SIZE);
  const last = Math.floor((anchor + Math.max(start, end) + 2) / SPACE_BUCKET_SIZE);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last - first > 16) return ['wide'];
  return Array.from({ length: last - first + 1 }, (_, index) => `${acrossX ? 'x' : 'y'}:${first + index}`);
}

export function normalizeTextItemsForLayout(
  items: TextItem[],
  viewport: ViewportLike,
  styles: Record<string, TextStyleLike> = {},
): PdfTextItem[] {
  const normalized: PdfTextItem[] = [];
  const pendingSpaces = new Map<string, Set<PendingSpace>>();
  const matchedSpaces = new Set<PendingSpace>();
  for (const item of items) {
    if (typeof item.str !== 'string' || !item.str) continue;
    const transform = item.transform;
    if (!Array.isArray(transform) || transform.length < 6) continue;

    const [a, b, c, d, x, y] = transform;
    if (![a, b, c, d, x, y].every(Number.isFinite)) continue;
    const style = styles[item.fontName ?? ''];
    if (!item.str.trim()) {
      const buckets = spaceBucketKeys(item, Boolean(style?.vertical)).map(key => {
        const bucket = pendingSpaces.get(key) ?? new Set<PendingSpace>();
        pendingSpaces.set(key, bucket);
        return bucket;
      });
      const space: PendingSpace = { item, buckets, distance: Infinity };
      for (const bucket of buckets) bucket.add(space);
      continue;
    }
    const finish = (run: PdfTextItem) => {
      for (const key of [`x:${Math.floor(x / SPACE_BUCKET_SIZE)}`, `y:${Math.floor(y / SPACE_BUCKET_SIZE)}`, 'wide']) {
        for (const space of pendingSpaces.get(key) ?? []) {
          const distance = distanceFromSpaceEnd(space.item, item, styles);
          if (distance >= space.distance) continue;
          // A run that overlaps the space may be followed by a closer match.
          space.distance = distance;
          space.next = run;
          matchedSpaces.add(space);
          if (distance < 1e-6) {
            for (const bucket of space.buckets) bucket.delete(space);
          }
        }
      }
      normalized.push(run);
    };
    const sourceAxisAligned = Math.abs(b) <= 0.5 && Math.abs(c) <= 0.5;
    // A PDF page rotation can turn a text run upright in the reader's viewport.
    const [va = 1, vb = 0, vc = 0, vd = 1] = viewport.transform;
    const baselineX = va * a + vc * b;
    const baselineY = vb * a + vd * b;
    const upX = va * c + vc * d;
    const upY = vb * c + vd * d;
    const isRotated = Math.abs(baselineY) > 0.5 || Math.abs(upX) > 0.5 || baselineX < 0 || upY > 0;
    const width = Math.max(0, Number(item.width ?? 0));
    const height = Math.max(1, isRotated ? Math.hypot(c, d) : Math.abs(upY));
    const topOffset = resolveTopOffset(height, style);
    const origin = applyViewportTransform(x, y, viewport.transform);
    if (style?.vertical) {
      const crossLength = Math.hypot(baselineX, baselineY);
      const writingLength = Math.hypot(upX, upY);
      if (crossLength === 0 || writingLength === 0) continue;
      const dx = -upX / writingLength;
      const dy = -upY / writingLength;
      const advance = nativeVerticalAdvance(item.height, a, b, c, d) * writingLength / Math.hypot(c, d);
      const columnWidth = Math.max(1, crossLength);
      const ascent = resolveTopOffset(columnWidth, style);
      const crossDx = baselineX / crossLength;
      const crossDy = baselineY / crossLength;
      const startX = origin.x + ascent * crossDx;
      const startY = origin.y + ascent * crossDy;
      const advanceX = dx * advance;
      const advanceY = dy * advance;
      const crossX = -crossDx * columnWidth;
      const crossY = -crossDy * columnWidth;
      const bounds = clipTextQuad([
        { x: startX, y: startY },
        { x: startX + advanceX, y: startY + advanceY },
        { x: startX + advanceX + crossX, y: startY + advanceY + crossY },
        { x: startX + crossX, y: startY + crossY },
      ], viewport);
      if (!bounds) continue;
      // PDF.js measures the vertical advance with the horizontal scale. When
      // the axes differ, the first glyph is more reliable for region assignment.
      const writingHeight = Math.abs(upX * crossDy - upY * crossDx);
      const regionAnchor = Math.abs(crossLength - writingHeight) > 0.5
        ? { x: startX + crossX / 2, y: startY + crossY / 2 }
        : undefined;
      finish({
        text: item.str,
        ...bounds,
        ...(regionAnchor ? { regionAnchor } : {}),
        rotation: {
          x: origin.x, y: origin.y, dx, dy, advance,
          nativeVertical: true,
          readableAsProse: sourceAxisAligned || dy > 0.999,
        },
      });
      continue;
    }
    if (isRotated) {
      const baselineLength = Math.hypot(a, b);
      const fontHeight = Math.hypot(c, d);
      const viewportBaselineLength = Math.hypot(baselineX, baselineY);
      if (baselineLength === 0 || fontHeight === 0 || viewportBaselineLength === 0) continue;
      // Tilted labels have perpendicular font axes. Keep excluding sheared runs.
      if (!sourceAxisAligned && Math.abs(a * c + b * d) / (baselineLength * fontHeight) > 0.05) continue;

      const advanceX = a * width / baselineLength;
      const advanceY = b * width / baselineLength;
      const topX = x + c * topOffset / fontHeight;
      const topY = y + d * topOffset / fontHeight;
      const corners = [
        applyViewportTransform(topX, topY, viewport.transform),
        applyViewportTransform(topX + advanceX, topY + advanceY, viewport.transform),
        applyViewportTransform(topX + advanceX - c, topY + advanceY - d, viewport.transform),
        applyViewportTransform(topX - c, topY - d, viewport.transform),
      ];
      const bounds = clipTextQuad(corners, viewport);
      if (!bounds) continue;
      const reverseX = a < 0;
      const reverseY = d < 0;
      const sourceY = reverseY ? y : -y;
      finish({
        text: item.str,
        ...bounds,
        rotation: {
          x: origin.x,
          y: origin.y,
          dx: baselineX / viewportBaselineLength,
          dy: baselineY / viewportBaselineLength,
          advance: width * viewportBaselineLength / baselineLength,
          readableAsProse: sourceAxisAligned,
          source: sourceAxisAligned ? {
            x: reverseX ? -x : x, y: sourceY - topOffset, width, height,
            baselineY: sourceY, reverseX, reverseY,
          } : undefined,
        },
      });
      continue;
    }

    // Map the baseline from PDF user space before applying the font ascent.
    const bounds = clipBounds(origin.x, origin.y - topOffset, width, height, viewport);
    if (!bounds) continue;
    finish({
      text: item.str,
      ...bounds,
      baselineY: origin.y,
    });
  }
  for (const space of matchedSpaces) space.next!.spaceBefore = true;
  return normalized;
}

export function scaleTextItemForLayout(item: PdfTextItem, scaleX: number, scaleY: number): PdfTextItem {
  const scaled = {
    ...item,
    x: item.x * scaleX,
    y: item.y * scaleY,
    width: item.width * scaleX,
    height: item.height * scaleY,
    baselineY: item.baselineY === undefined ? undefined : item.baselineY * scaleY,
    ...(item.regionAnchor ? { regionAnchor: { x: item.regionAnchor.x * scaleX, y: item.regionAnchor.y * scaleY } } : {}),
  };
  const rotation = item.rotation;
  if (!rotation) return scaled;
  const dx = rotation.dx * scaleX;
  const dy = rotation.dy * scaleY;
  const stretch = Math.hypot(dx, dy);
  const crossStretch = Math.hypot(rotation.dy * scaleX, rotation.dx * scaleY);
  const source = rotation.source;
  return {
    ...scaled,
    rotation: {
      ...rotation,
      x: rotation.x * scaleX,
      y: rotation.y * scaleY,
      dx: dx / stretch,
      dy: dy / stretch,
      advance: rotation.advance * stretch,
      source: source ? {
        ...source,
        x: source.x * stretch,
        y: source.y * crossStretch,
        width: source.width * stretch,
        height: source.height * crossStretch,
        baselineY: source.baselineY * crossStretch,
      } : undefined,
    },
  };
}
