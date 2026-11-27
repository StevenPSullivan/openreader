import type { ParsedPdfBlockKind } from '../../api/types';

export interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  // Share of the height above the baseline, when the box locates it.
  ascent?: number;
}

export interface LayoutRegion {
  bbox: [number, number, number, number];
  label: ParsedPdfBlockKind;
  confidence?: number;
}

const NON_TEXT_REGION_LABELS = new Set<LayoutRegion['label']>(['chart', 'image', 'table', 'seal']);
const TEXT_ASSIGNABLE_LABELS = new Set<LayoutRegion['label']>([
  'abstract',
  'algorithm',
  'aside_text',
  'content',
  'doc_title',
  'figure_title',
  'footer',
  'footnote',
  'formula_number',
  'header',
  'number',
  'paragraph_title',
  'reference',
  'reference_content',
  'text',
  'vision_footnote',
  'formula',
]);

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

const baselineOf = (item: PdfTextItem) => (item.ascent === undefined ? undefined : item.y + item.height * item.ascent);
const topsMatch = (a: PdfTextItem, b: PdfTextItem) => Math.abs(a.y - b.y) <= 2;

function sharesBaseline(a: PdfTextItem, b: PdfTextItem): boolean {
  const baselineA = baselineOf(a);
  const baselineB = baselineOf(b);
  return baselineA !== undefined && baselineB !== undefined && Math.abs(baselineA - baselineB) <= 1;
}

const middleOf = (item: PdfTextItem) => item.y + item.height / 2;

function cachedPerRun<T>(compute: (run: PdfTextItem) => T): (run: PdfTextItem) => T {
  const cache = new Map<PdfTextItem, T>();
  return (run) => {
    if (!cache.has(run)) cache.set(run, compute(run));
    return cache.get(run)!;
  };
}

// Runs of different sizes or fonts on one baseline, such as an inline citation
// or a larger table value, have different tops, so the top order can put a run
// after others on its baseline that lie to its right. Each run then moves back
// over those and goes before the first that belongs to its line: not a marker,
// and not reaching into another line. A marker never moves, so a subscript and
// the next line's superscript sharing a baseline stay put.
function sortReadingOrder(items: PdfTextItem[]): PdfTextItem[] {
  // Set off the baseline of a larger run beside it, as a subscript or
  // superscript is set off the word it follows: their boxes overlap vertically,
  // and their horizontal gap is within a quarter of the larger run's height.
  const isMarker = cachedPerRun((run) => items.some((other) => (
    other.height > run.height
    && !sharesBaseline(run, other)
    && Math.min(run.y + run.height, other.y + other.height) > Math.max(run.y, other.y)
    && Math.abs(Math.max(run.x - (other.x + other.width), other.x - (run.x + run.width))) <= other.height / 4
  )));
  // The highest middle, below this run's top, of a run off its baseline. A run
  // reaches into another line, as a run spanning two lines does, when that
  // middle is above the middle of the run being placed.
  const otherLineMiddle = cachedPerRun((run) => {
    let highest = Number.POSITIVE_INFINITY;
    for (const other of items) {
      const middle = middleOf(other);
      if (!sharesBaseline(other, run) && middle >= run.y && middle < highest) highest = middle;
    }
    return highest;
  });

  const ordered: PdfTextItem[] = [];
  for (const item of [...items].sort((a, b) => (topsMatch(a, b) ? a.x - b.x : a.y - b.y))) {
    let at = ordered.length;
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      const other = ordered[i]!;
      if (!sharesBaseline(item, other) || other.x < item.x || isMarker(item)) break;
      if (!isMarker(other) && otherLineMiddle(other) >= middleOf(item)) at = i;
    }
    ordered.splice(at, 0, item);
  }
  return ordered;
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
    const lineBreak = !sharesLineBand && lineJump > Math.max(2, Math.min(prev.height, item.height) * 0.6);
    const avgCharWidth = item.width / Math.max(1, item.text.length);
    const needsSpace = lineBreak || gap > Math.max(avgCharWidth * 0.3, 2);
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

  const indexedRegions = regions.map((region, index) => ({ region, index }));
  const assignableRegions = indexedRegions.filter(({ region }) => TEXT_ASSIGNABLE_LABELS.has(region.label));
  const graphicRegions = indexedRegions.filter(({ region }) => NON_TEXT_REGION_LABELS.has(region.label));
  const assignedByRegion = new Map<number, PdfTextItem[]>();

  for (const item of textItems) {
    // Text-like regions keep priority, so captions and prose that overlap a
    // graphic stay in their own blocks. Remaining text inside a table, chart,
    // image or seal belongs to that graphic block.
    let candidates = assignableRegions.filter(({ region }) => contains(region, item));
    if (candidates.length === 0) candidates = graphicRegions.filter(({ region }) => contains(region, item));
    if (candidates.length === 0) continue;

    candidates.sort((a, b) => {
      const scoreDelta = regionScore(b.region) - regionScore(a.region);
      if (Math.abs(scoreDelta) > 1e-6) return scoreDelta;
      return regionArea(a.region) - regionArea(b.region);
    });

    const winner = candidates[0];
    const list = assignedByRegion.get(winner.index) ?? [];
    list.push(item);
    assignedByRegion.set(winner.index, list);
  }

  const out: RegionTextBlock[] = [];

  for (const [regionIndex, assignedItems] of assignedByRegion.entries()) {
    const region = regions[regionIndex];
    if (!region) continue;
    if (assignedItems.length === 0) continue;
    const ordered = sortReadingOrder(assignedItems);
    const text = joinText(ordered);
    if (!text) continue;

    out.push({
      region,
      text,
      items: ordered,
      sourceOrder: chunkSourceOrder(ordered),
    });
  }

  for (const { region } of graphicRegions) {
    if (out.some((block) => block.region === region)) continue;
    out.push({
      region,
      text: '',
      items: [],
      sourceOrder: Number.MAX_SAFE_INTEGER,
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
