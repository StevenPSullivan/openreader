import type { ParsedPdfBlockKind } from '../../api/types';

interface TextBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RotatedBaseline {
  x: number;
  y: number;
  dx: number;
  dy: number;
  advance: number;
  nativeVertical?: boolean;
  readableAsProse?: boolean;
  source?: TextBounds & { baselineY: number; reverseX: boolean; reverseY: boolean };
}

export interface PdfTextItem extends TextBounds {
  text: string;
  baselineY?: number;
  spaceBefore?: boolean;
  regionAnchor?: { x: number; y: number };
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

function contains(region: LayoutRegion, c: { x: number; y: number }): boolean {
  return c.x >= region.bbox[0] && c.x <= region.bbox[2] && c.y >= region.bbox[1] && c.y <= region.bbox[3];
}

interface ReadingLine {
  x: number;
  y: number;
  baselineY?: number;
  items: PdfTextItem[];
}

function horizontalLines(items: PdfTextItem[], inlineRuns: Set<PdfTextItem>, isGraphic: boolean): ReadingLine[] {
  const lines: ReadingLine[] = [];
  const minHeight = items.reduce((min, item) => Math.min(min, item.height), Infinity);
  const ordered = [...items].sort((a, b) =>
    (a.baselineY ?? Infinity) - (b.baselineY ?? Infinity) || a.x - b.x);
  let baselineLine: (ReadingLine & { baselineY: number }) | undefined;
  let previousBaseline = -Infinity;
  for (const item of ordered) {
    const { x, y, baselineY } = item;
    // A drop cap can sit on a later baseline while starting at the top of the first line.
    const spansEarlierLine = baselineY !== undefined && item.height >= 2 * minHeight && /^\p{L}$/u.test(item.text.trim())
      && !items.some(other => other !== item && other.baselineY !== undefined
        && Math.abs(other.baselineY - baselineY) <= 2
        && (other.height >= item.height || Math.abs(other.y - y) <= 2))
      && items.some(other => other.baselineY !== undefined
        && other.baselineY < baselineY - 2 && other.baselineY > y
        && other.x >= x + item.width - 2 && other.height * 2 <= item.height);
    if (baselineY === undefined || spansEarlierLine) {
      lines.push({ x, y, items: [item] });
      continue;
    }
    // Allow small offsets within a line without chaining across several baselines.
    if (baselineLine && baselineY - previousBaseline <= 2 && baselineY - baselineLine.baselineY <= 4) {
      baselineLine.items.push(item);
      baselineLine.x = Math.min(baselineLine.x, x);
      baselineLine.y = Math.min(baselineLine.y, y);
    } else {
      baselineLine = { x, y, baselineY, items: [item] };
      lines.push(baselineLine);
    }
    previousBaseline = baselineY;
  }
  const byBaseline = lines.filter((line): line is ReadingLine & { baselineY: number } =>
    line.baselineY !== undefined);
  const maxAscent = byBaseline.reduce((max, line) => Math.max(max, line.baselineY - line.y), 0);
  // Work upward so each candidate body line has already kept or moved its own runs.
  for (let index = byBaseline.length - 2; index >= 0; index -= 1) {
    const line = byBaseline[index]!;
    const lowerLines = [];
    for (let next = index + 1; next < byBaseline.length; next += 1) {
      const candidate = byBaseline[next]!;
      if (candidate.baselineY - line.baselineY > maxAscent) break;
      if (line.baselineY >= candidate.y && line.baselineY < candidate.baselineY - 2) lowerLines.push(candidate);
    }
    if (lowerLines.length === 0) continue;

    const runs: Array<{
      items: PdfTextItem[];
      x: number;
      right: number;
      top: number;
      bottom: number;
      height: number;
    }> = [];
    for (const item of line.items.sort((a, b) => a.x - b.x)) {
      const run = runs.at(-1);
      if (run && item.x - run.right <= 2) {
        run.items.push(item);
        run.right = Math.max(run.right, item.x + item.width);
        run.top = Math.min(run.top, item.y);
        run.bottom = Math.max(run.bottom, item.y + item.height);
        run.height = Math.max(run.height, item.height);
      } else {
        runs.push({
          items: [item], x: item.x, right: item.x + item.width,
          top: item.y, bottom: item.y + item.height, height: item.height,
        });
      }
    }

    line.items = [];
    let retainedBodyHeight = 0;
    for (const run of runs) {
      const numeric = run.items.every(item => /^\p{Nd}+$/u.test(item.text.trim()));
      const graphicGap = numeric ? 1 : 0.5;
      const compact = run.right - run.x <= 2 * run.height;
      let body: ReadingLine | undefined;
      const directGap = compact
        ? Math.max(2, !isGraphic && run.items[0]?.spaceBefore ? run.height / 2 : 0)
        : 0.5;
      for (const candidate of lowerLines) {
        if (run.height <= retainedBodyHeight || (!compact && !numeric)) break;
        const peers = candidate.items.filter(peer => peer.height > run.height && !inlineRuns.has(peer));
        const left = peers.filter(peer => {
          if (peer.x >= run.x) return false;
          const gap = run.x - peer.x - peer.width;
          // Graphic labels may overlap vertically without belonging to the same line.
          return isGraphic ? Math.abs(gap) <= graphicGap : gap >= -2;
        });
        if (left.length === 0) continue;
        const overlap = (peer: PdfTextItem) =>
          Math.min(run.bottom, peer.y + peer.height) - Math.max(run.top, peer.y);
        const halfHeight = run.height / 2;
        if (left.some(peer => run.x - peer.x - peer.width <= directGap && overlap(peer) > halfHeight)) {
          body = candidate;
          break;
        }
        if (!body && compact) {
          const right = peers.filter(peer => peer.x >= run.right - 2);
          if (right.length > 0
              && (left.some(peer => overlap(peer) >= halfHeight) || right.some(peer => overlap(peer) >= halfHeight))) {
            body = candidate;
          }
        }
      }
      for (const item of run.items) {
        (body ?? line).items.push(item);
        if (body) inlineRuns.add(item);
      }
      // Text that stays on this baseline anchors smaller runs that follow it.
      if (!body) retainedBodyHeight = Math.max(retainedBodyHeight, run.height);
    }
    if (line.items.length > 0) {
      line.x = line.items[0]!.x;
      line.y = line.items.reduce((top, item) => Math.min(top, item.y), Infinity);
    }
  }
  const nonemptyLines = lines.filter(line => line.items.length > 0);
  for (const line of nonemptyLines) line.items.sort((a, b) => a.x - b.x);
  return nonemptyLines;
}

function sameBaseline(a: RotatedBaseline, b: RotatedBaseline): boolean {
  return a.dx * b.dx + a.dy * b.dy > 0.999
    && Math.abs((b.x - a.x) * a.dy - (b.y - a.y) * a.dx) <= 2;
}

function orderRows(lines: ReadingLine[], rowY: (line: ReadingLine) => number): ReadingLine[] {
  lines.sort((a, b) => rowY(a) - rowY(b) || a.x - b.x);
  const ordered: ReadingLine[] = [];
  for (let start = 0; start < lines.length;) {
    const top = rowY(lines[start]!);
    let end = start + 1;
    while (end < lines.length && rowY(lines[end]!) - top <= 2) end += 1;
    ordered.push(...lines.slice(start, end).sort((a, b) => a.x - b.x));
    start = end;
  }
  return ordered;
}

function sortReadingOrder(
  items: PdfTextItem[],
  inlineRuns: Set<PdfTextItem>,
  isGraphic: boolean,
  paragraphs: ReadingLine[] = [],
): ReadingLine[] {
  const lines = horizontalLines(items.filter(item => !item.rotation), inlineRuns, isGraphic);
  const rotatedLines: Array<ReadingLine & { baseline: RotatedBaseline; sourceIndex: number }> = [];
  const rotated = items.flatMap((item, sourceIndex) => item.rotation
    ? [{ item, baseline: item.rotation, sourceIndex }] : []);
  // Choose baseline representatives in the same order regardless of PDF object order.
  rotated.sort(({ baseline: a }, { baseline: b }) => a.x - b.x || a.y - b.y || a.dx - b.dx || a.dy - b.dy);
  for (const { item, baseline, sourceIndex } of rotated) {
    const line = rotatedLines.find(candidate =>
      candidate.baseline.nativeVertical === baseline.nativeVertical && sameBaseline(candidate.baseline, baseline));
    if (line) {
      line.items.push(item);
      line.x = Math.min(line.x, item.x);
      line.y = Math.min(line.y, item.y);
      line.sourceIndex = Math.min(line.sourceIndex, sourceIndex);
    } else {
      rotatedLines.push({ x: item.x, y: item.y, baseline, items: [item], sourceIndex });
    }
  }
  for (const line of rotatedLines) {
    const { dx, dy } = line.baseline;
    line.items.sort((a, b) => (a.rotation!.x - b.rotation!.x) * dx + (a.rotation!.y - b.rotation!.y) * dy);
  }
  const horizontal = orderRows(lines, line => line.baselineY ?? line.y);
  const sideways = orderRows([...rotatedLines, ...paragraphs], line => line.y);
  const ordered: ReadingLine[] = [];
  let nextSideways = 0;
  // Use displayed positions across orientations and retain baseline order within prose.
  for (const line of horizontal) {
    while (nextSideways < sideways.length) {
      const candidate = sideways[nextSideways]!;
      const delta = candidate.y - line.y;
      if (Math.abs(delta) <= 2 ? candidate.x >= line.x : delta > 0) break;
      ordered.push(candidate);
      nextSideways += 1;
    }
    ordered.push(line);
  }
  ordered.push(...sideways.slice(nextSideways));
  // Preserve the PDF's column direction without moving nearby horizontal lines.
  const columns = rotatedLines.filter(line => line.baseline.nativeVertical)
    .sort((a, b) => a.sourceIndex - b.sourceIndex);
  if (columns.length < 2) return ordered;
  const columnSet = new Set<ReadingLine>(columns);
  let columnIndex = 0;
  return ordered.map(line => columnSet.has(line) ? columns[columnIndex++]! : line);
}

function joinText(lines: ReadingLine[], inlineRuns: ReadonlySet<PdfTextItem>): string {
  const membership = new Map<PdfTextItem, ReadingLine>();
  for (const line of lines) {
    for (const item of line.items) membership.set(item, line);
  }
  let out = '';
  let prev: PdfTextItem | null = null;
  let lastBodyItem: PdfTextItem | undefined;
  let inlineEnd = -Infinity;
  for (const item of membership.keys()) {
    const bodyBeforeInline = lastBodyItem;
    const previousInlineEnd = inlineEnd;
    const isInline = inlineRuns.has(item);
    if (isInline) {
      inlineEnd = Math.max(inlineEnd, item.x + item.width);
    } else {
      lastBodyItem = item;
      inlineEnd = -Infinity;
    }
    if (!prev) {
      out += item.text;
      prev = item;
      continue;
    }
    const line = membership.get(item)!;
    const previousLine = membership.get(prev)!;
    const sameLine = line === previousLine;
    const followsInline = !isInline && inlineRuns.has(prev);
    const spacingFrom = followsInline && bodyBeforeInline ? bodyBeforeInline : prev;
    const physicalGap = item.x - (followsInline ? previousInlineEnd : prev.x + prev.width);
    // Recover a compressed word gap only when the raised run leaves visible space.
    const restoreWordGap = followsInline && physicalGap > 0.5
      && !/^[\p{Pe}\p{Pf}'",.;:!?%…。，、；：！？،؛؟]/u.test(item.text.trimStart());
    const gap = restoreWordGap ? Math.max(physicalGap, item.x - spacingFrom.x - spacingFrom.width) : physicalGap;
    const lineJump = item.y - prev.y;
    const prevBottom = prev.y + prev.height;
    const itemBottom = item.y + item.height;
    const verticalOverlap = Math.max(0, Math.min(prevBottom, itemBottom) - Math.max(prev.y, item.y));
    const sharesLineBand = verticalOverlap >= Math.max(1, Math.min(prev.height, item.height) * 0.5);
    const wrappedBaseline = prev.baselineY !== undefined && item.baselineY !== undefined
      && item.baselineY > prev.baselineY + 2 && item.x < prev.x;
    const distinctBaselines = !sameLine && line.baselineY !== undefined && previousLine.baselineY !== undefined;
    const lineBreak = followsInline ? !sameLine
      : distinctBaselines || wrappedBaseline
        || (!sharesLineBand && lineJump > Math.max(2, Math.min(prev.height, item.height) * 0.6));
    const followsDropCap = previousLine.baselineY === undefined && prev.baselineY !== undefined
      && sharesLineBand && item.x >= prev.x + prev.width - 2;
    const explicitSpace = item.spaceBefore && (sameLine || followsDropCap);
    const avgCharWidth = item.width / Math.max(1, item.text.length);
    const spaceThreshold = Math.max(avgCharWidth * 0.3, 2);
    let needsSpace = Boolean(prev.rotation || item.rotation || explicitSpace) || lineBreak || gap > spaceThreshold;
    if (sameLine && prev.rotation && item.rotation) {
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

function splitSidewaysPassages(items: PdfTextItem[], upright: PdfTextItem[]): PdfTextItem[][] {
  const passages: PdfTextItem[][] = [];
  let passage: PdfTextItem[] = [];
  let bottom = -Infinity;
  for (const item of items.sort((a, b) => a.y - b.y)) {
    // An upright line in the gap separates passages with the same orientation.
    if (item.y > bottom && upright.some(line => line.y >= bottom && line.y + line.height <= item.y)) {
      if (passage.length > 0) passages.push(passage);
      passage = [];
      bottom = -Infinity;
    }
    passage.push(item);
    bottom = Math.max(bottom, item.y + item.height);
  }
  if (passage.length > 0) passages.push(passage);
  return passages;
}

function readRegion(items: PdfTextItem[], isGraphic: boolean) {
  const remaining: PdfTextItem[] = [];
  const rotated = new Map<number, PdfTextItem[]>();
  for (const item of items) {
    const source = item.rotation?.source;
    if (!source) {
      remaining.push(item);
      continue;
    }
    const orientation = Number(source.reverseX) + 2 * Number(source.reverseY);
    const group = rotated.get(orientation) ?? [];
    group.push(item);
    rotated.set(orientation, group);
  }

  // Read compatible sideways text in its original axes, then place it by its
  // displayed bounds alongside any other text in the region.
  const paragraphs = new Map<ReadingLine, string>();
  const upright = remaining.filter(item => !item.rotation);
  for (const items of [...rotated.values()].flatMap(group => splitSidewaysPassages(group, upright))) {
    const originals = new Map<PdfTextItem, PdfTextItem>(items.map(item => {
      const { x, y, width, height, baselineY } = item.rotation!.source!;
      return [{ ...item, x, y, width, height, baselineY, rotation: undefined }, item];
    }));
    const inlineRuns = new Set<PdfTextItem>();
    const lines = sortReadingOrder([...originals.keys()], inlineRuns, isGraphic);
    const displayItems = lines.flatMap(line => line.items.map(item => originals.get(item)!));
    paragraphs.set({
      x: displayItems.reduce((left, item) => Math.min(left, item.x), Infinity),
      y: displayItems.reduce((top, item) => Math.min(top, item.y), Infinity),
      items: displayItems,
    }, joinText(lines, inlineRuns));
  }

  const inlineRuns = new Set<PdfTextItem>();
  const lines = sortReadingOrder(remaining, inlineRuns, isGraphic, [...paragraphs.keys()]);
  const parts: string[] = [];
  let start = 0;
  for (const [index, line] of lines.entries()) {
    const paragraph = paragraphs.get(line);
    if (paragraph === undefined) continue;
    if (start < index) parts.push(joinText(lines.slice(start, index), inlineRuns));
    parts.push(paragraph);
    start = index + 1;
  }
  if (start < lines.length) parts.push(joinText(lines.slice(start), inlineRuns));
  return { text: parts.filter(Boolean).join(' '), items: lines.flatMap(line => line.items) };
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
    const anchor = item.regionAnchor;
    const anchored = anchor ? indexedRegions.filter(({ region }) => contains(region, anchor)) : [];
    const center = centroid(item);
    const candidates = anchored.length > 0 ? anchored : indexedRegions.filter(({ region }) => contains(region, center));
    if (candidates.length === 0) continue;

    // Keep prose and captions ahead of graphics. Break close confidence ties by area.
    const textRegions = candidates.filter(candidate => !candidate.isGraphic);
    const eligible = textRegions.length > 0 ? textRegions : candidates;
    const bestScore = eligible.reduce((best, { region }) => Math.max(best, regionScore(region)), -Infinity);
    const winner = eligible.reduce<(typeof eligible)[number] | undefined>((best, candidate) => {
      if (bestScore - regionScore(candidate.region) > 1e-6) return best;
      return !best || regionArea(candidate.region) < regionArea(best.region) ? candidate : best;
    }, undefined)!;
    // Keep off-axis margin text out of prose, even if the region overlaps a graphic.
    if (item.rotation && !item.rotation.readableAsProse && !winner.isGraphic) continue;
    const list = assignedByRegion.get(winner.index) ?? [];
    list.push(item);
    assignedByRegion.set(winner.index, list);
  }

  const out: RegionTextBlock[] = [];

  for (const { region, index, isGraphic } of indexedRegions) {
    const assigned = assignedByRegion.get(index) ?? [];
    const { text, items } = readRegion(assigned, isGraphic);
    if (!text && !isGraphic) continue;

    out.push({
      region,
      text,
      items,
      sourceOrder: chunkSourceOrder(items),
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
