import type { ParsedPdfBlockKind } from '../../api/types';

interface RotatedBaseline {
  x: number;
  y: number;
  dx: number;
  dy: number;
  advance: number;
}

export interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  baselineY?: number;
  spaceBefore?: boolean;
  rotation?: RotatedBaseline;
}

export interface LayoutRegion {
  bbox: [number, number, number, number];
  label: ParsedPdfBlockKind;
  confidence?: number;
}

const GRAPHIC_REGION_LABELS = new Set<LayoutRegion['label']>(['chart', 'image', 'table', 'seal']);

function centroid(item: PdfTextItem): { x: number; y: number } {
  return {
    x: item.x + item.width / 2,
    y: item.y + item.height / 2,
  };
}

function contains(region: LayoutRegion, item: PdfTextItem): boolean {
  const c = centroid(item);
  return c.x >= region.bbox[0] && c.x <= region.bbox[2] && c.y >= region.bbox[1] && c.y <= region.bbox[3];
}

interface ReadingLine {
  x: number;
  y: number;
  items: PdfTextItem[];
}

function horizontalLines(items: PdfTextItem[]): ReadingLine[] {
  const lines: Array<ReadingLine & { baselineY?: number }> = [];
  for (const item of items) {
    const { x, y, baselineY } = item;
    // A drop cap can sit on a later baseline while starting the first line.
    const spansEarlierLine = baselineY !== undefined && /^\p{L}$/u.test(item.text.trim())
      && items.some(other => other.baselineY !== undefined
        && other.baselineY < baselineY - 2 && other.baselineY > y
        && other.x >= x + item.width - 2 && other.height * 2 <= item.height);
    const line = lines.find(candidate => baselineY !== undefined && !spansEarlierLine
      && candidate.baselineY !== undefined && Math.abs(candidate.baselineY - baselineY) <= 2);
    if (line) {
      line.items.push(item);
      line.x = Math.min(line.x, x);
      line.y = Math.min(line.y, y);
    } else {
      lines.push({ x, y, baselineY: spansEarlierLine ? undefined : baselineY, items: [item] });
    }
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

function sameBaseline(a: RotatedBaseline, b: RotatedBaseline): boolean {
  return a.dx * b.dx + a.dy * b.dy > 0.999
    && Math.abs((b.x - a.x) * a.dy - (b.y - a.y) * a.dx) <= 2;
}

function sortReadingOrder(items: PdfTextItem[]): PdfTextItem[] {
  const lines = horizontalLines(items.filter(item => !item.rotation));
  const rotatedLines: Array<ReadingLine & { baseline: RotatedBaseline }> = [];
  for (const item of items) {
    if (!item.rotation) continue;
    const baseline = item.rotation;
    const line = rotatedLines.find(candidate => sameBaseline(candidate.baseline, baseline));
    if (line) {
      line.items.push(item);
      line.x = Math.min(line.x, item.x);
      line.y = Math.min(line.y, item.y);
    } else {
      rotatedLines.push({ x: item.x, y: item.y, baseline, items: [item] });
    }
  }
  for (const line of rotatedLines) {
    const { dx, dy } = line.baseline;
    line.items.sort((a, b) => (a.rotation!.x - b.rotation!.x) * dx + (a.rotation!.y - b.rotation!.y) * dy);
  }
  return [...lines, ...rotatedLines].sort((a, b) => {
    if (Math.abs(a.y - b.y) <= 2) return a.x - b.x;
    return a.y - b.y;
  }).flatMap(line => line.items);
}

function joinText(items: PdfTextItem[]): string {
  let out = '';
  let prev: PdfTextItem | null = null;
  for (const item of items) {
    if (!prev) {
      out += item.text;
      prev = item;
      continue;
    }
    const prevEndX = prev.x + prev.width;
    const gap = item.x - prevEndX;
    const lineJump = item.y - prev.y;
    const prevBottom = prev.y + prev.height;
    const itemBottom = item.y + item.height;
    const verticalOverlap = Math.max(0, Math.min(prevBottom, itemBottom) - Math.max(prev.y, item.y));
    const sharesLineBand = verticalOverlap >= Math.max(1, Math.min(prev.height, item.height) * 0.5);
    const wrappedBaseline = prev.baselineY !== undefined && item.baselineY !== undefined
      && item.baselineY > prev.baselineY + 2 && item.x < prev.x;
    const lineBreak = wrappedBaseline || (!sharesLineBand && lineJump > Math.max(2, Math.min(prev.height, item.height) * 0.6));
    const explicitSpace = item.spaceBefore && prev.baselineY !== undefined && item.baselineY !== undefined
      && Math.abs(item.baselineY - prev.baselineY) <= 2;
    const avgCharWidth = item.width / Math.max(1, item.text.length);
    const spaceThreshold = Math.max(avgCharWidth * 0.3, 2);
    let needsSpace = Boolean(prev.rotation || item.rotation || explicitSpace) || lineBreak || gap > spaceThreshold;
    if (prev.rotation && item.rotation && sameBaseline(prev.rotation, item.rotation)) {
      const a = prev.rotation;
      const b = item.rotation;
      const baselineGap = (b.x - a.x) * a.dx + (b.y - a.y) * a.dy - a.advance;
      needsSpace = item.spaceBefore === true || baselineGap > 2;
    }
    out += needsSpace ? ` ${item.text}` : item.text;
    prev = item;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function regionArea(region: LayoutRegion): number {
  return Math.max(1, (region.bbox[2] - region.bbox[0]) * (region.bbox[3] - region.bbox[1]));
}

function regionScore(region: LayoutRegion): number {
  return Number.isFinite(region.confidence) ? Number(region.confidence) : 0;
}

export interface RegionTextBlock {
  region: LayoutRegion;
  text: string;
  items: PdfTextItem[];
  sourceOrder: number;
}

export function mergeTextWithRegions(regions: LayoutRegion[], textItems: PdfTextItem[]): RegionTextBlock[] {
  const sourceIndex = new Map<PdfTextItem, number>();
  for (let i = 0; i < textItems.length; i += 1) {
    sourceIndex.set(textItems[i]!, i);
  }

  const chunkSourceOrder = (items: PdfTextItem[]): number => {
    let min = Number.POSITIVE_INFINITY;
    for (const item of items) {
      const index = sourceIndex.get(item);
      if (typeof index === 'number' && index < min) min = index;
    }
    return Number.isFinite(min) ? min : Number.MAX_SAFE_INTEGER;
  };

  const indexedRegions = regions.map((region, index) => ({
    region,
    index,
    isGraphic: GRAPHIC_REGION_LABELS.has(region.label),
  }));
  const assignedByRegion = new Map<number, PdfTextItem[]>();

  for (const item of textItems) {
    const candidates = indexedRegions.filter(({ region }) => contains(region, item));
    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      // Keep text in its existing region when a graphic overlaps prose or a caption.
      if (a.isGraphic !== b.isGraphic) return a.isGraphic ? 1 : -1;
      const scoreDelta = regionScore(b.region) - regionScore(a.region);
      if (Math.abs(scoreDelta) > 1e-6) return scoreDelta;
      return regionArea(a.region) - regionArea(b.region);
    });

    const winner = candidates[0];
    // Keep excluding rotated prose and margin metadata, even if a graphic overlaps it.
    if (item.rotation && !winner.isGraphic) continue;
    const list = assignedByRegion.get(winner.index) ?? [];
    list.push(item);
    assignedByRegion.set(winner.index, list);
  }

  const out: RegionTextBlock[] = [];

  for (const { region, index, isGraphic } of indexedRegions) {
    const ordered = sortReadingOrder(assignedByRegion.get(index) ?? []);
    const text = joinText(ordered);
    if (!text && !isGraphic) continue;

    out.push({
      region,
      text,
      items: ordered,
      sourceOrder: chunkSourceOrder(ordered),
    });
  }

  out.sort((a, b) => {
    if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder;
    const ay = a.region.bbox[1];
    const by = b.region.bbox[1];
    if (Math.abs(ay - by) <= 2) return a.region.bbox[0] - b.region.bbox[0];
    return ay - by;
  });

  return out;
}
