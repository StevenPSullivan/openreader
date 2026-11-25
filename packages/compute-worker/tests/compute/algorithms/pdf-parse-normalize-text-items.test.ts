import { describe, expect, test } from 'vitest';

import { mergeTextWithRegions } from '../../../src/inference/pdf/document-layout';
import { normalizeTextItemsForLayout, scaleTextItemForLayout } from '../../../src/inference/pdf/normalize-text';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

function makeTextItem(
  str: string,
  transform: [number, number, number, number, number, number],
  width = 100,
): TextItem {
  return {
    str,
    transform,
    width,
    height: Math.abs(transform[3]),
    dir: 'ltr',
    fontName: 'test',
    hasEOL: false,
  } as unknown as TextItem;
}

describe('normalizeTextItemsForLayout', () => {
  test('keeps rotated chart labels and leaves rotated margin text out of prose', () => {
    const horizontal = makeTextItem(
      'Powered by large language models',
      [10, 0, 0, 10, 100, 600],
    );

    const margin = makeTextItem('Margin metadata', [0, 10, -10, 0, 30, 600]);
    const axis = makeTextItem('Axis label', [0, 10, -10, 0, 112, 300], 45);
    const oppositeAxis = makeTextItem('Second axis', [0, -10, 10, 0, 184, 345], 45);
    const diagonal = makeTextItem('Diagonal label', [6, 8, -8, 6, 230, 320], 40);

    const normalized = normalizeTextItemsForLayout([horizontal, margin, axis, oppositeAxis, diagonal], {
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    }, {
      test: { ascent: 0.8, descent: -0.2 },
    });
    expect(normalized[2]).toMatchObject({
      text: 'Axis label', x: 104, y: 455, width: 10, height: 45, rotation: { dx: 0, dy: -1 },
    });
    expect(normalized[3]).toMatchObject({
      text: 'Second axis', x: 182, y: 455, width: 10, height: 45, rotation: { dx: 0, dy: 1 },
    });
    expect(normalized[4]?.x).toBeCloseTo(223.6);
    expect(normalized[4]?.y).toBeCloseTo(443.2);
    const merged = mergeTextWithRegions([
      { label: 'text', bbox: [15, 90, 300, 220] },
      { label: 'chart', bbox: [95, 410, 350, 600] },
    ], normalized);
    expect(merged.map(({ text }) => text)).toEqual([
      'Powered by large language models', 'Diagonal label Axis label Second axis',
    ]);
  });

  test('drops heavily skewed text runs', () => {
    const skewed = makeTextItem('Watermark', [10, 5, 2, 10, 200, 500]);

    const normalized = normalizeTextItemsForLayout([skewed], {
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    }, {
      test: { ascent: 0.8, descent: -0.2 },
    });
    expect(normalized).toEqual([]);
  });

  test('uses a native vertical font’s downward advance for region assignment', () => {
    const items = [
      { ...makeTextItem('Chart label', [10, 0, 0, 10, 50, 700], 10), height: 40 },
      { ...makeTextItem('Vertical prose', [10, 0, 0, 10, 110, 700], 10), height: 40 },
    ];
    const styles = { test: { ascent: 0.8, vertical: true } };
    const normalized = normalizeTextItemsForLayout(items, {
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    }, styles);
    expect(normalized[0]).toMatchObject({
      x: 48, y: 100, width: 10, height: 40,
      rotation: { dy: 1, advance: 40 },
    });
    expect(normalized[0]?.rotation?.dx).toBeCloseTo(0);
    const merged = mergeTextWithRegions([
      { bbox: [38, 98, 70, 150], label: 'chart' },
      { bbox: [98, 98, 130, 150], label: 'text' },
    ], normalized);
    expect(merged.map(({ text }) => text)).toEqual(['Chart label', 'Vertical prose']);
  });

  test.each([{ columns: [110, 50] }, { columns: [50, 110] }])(
    'reads native vertical columns in the PDF order $columns', ({ columns }) => {
      const items = columns.flatMap((x, i) => [
        { ...makeTextItem(`Column ${i + 1}`, [10, 0, 0, 10, x, 700], 10), height: 40 },
        { ...makeTextItem('continued', [10, 0, 0, 10, x, 655], 10), height: 40 },
      ]);
      const normalized = normalizeTextItemsForLayout(items, {
        height: 800,
        transform: [1, 0, 0, -1, 0, 800],
      }, { test: { ascent: 0.8, vertical: true } });
      const merged = mergeTextWithRegions([{ bbox: [30, 90, 140, 200], label: 'text' }], normalized);
      expect(merged[0]?.text).toBe('Column 1 continued Column 2 continued');
    },
  );

  test('keeps native vertical column order alongside horizontal text', () => {
    const items = normalizeTextItemsForLayout([
      makeTextItem('Heading.', [10, 0, 0, 10, 50, 740], 46),
      { ...makeTextItem('Right column.', [10, 0, 0, 10, 110, 700], 10), fontName: 'vertical', height: 40 },
      { ...makeTextItem('Left column.', [10, 0, 0, 10, 50, 700], 10), fontName: 'vertical', height: 40 },
      makeTextItem('Footer.', [10, 0, 0, 10, 50, 630], 38),
    ], { height: 800, transform: [1, 0, 0, -1, 0, 800] }, {
      test: { ascent: 0.8 },
      vertical: { ascent: 0.8, vertical: true },
    });
    const merged = mergeTextWithRegions([{ bbox: [30, 40, 140, 190], label: 'text' }], items);
    expect(merged[0]?.text).toBe('Heading. Right column. Left column. Footer.');
  });

  test('uses the width of a horizontally scaled native vertical font', () => {
    const run = { ...makeTextItem('Wide label', [30, 0, 0, 10, 50, 700], 30), height: 40 };
    const items = normalizeTextItemsForLayout([run], {
      height: 800, transform: [1, 0, 0, -1, 0, 800],
    }, { test: { ascent: 0.8, vertical: true } });
    expect(items[0]).toMatchObject({ x: 44, width: 30 });
    const merged = mergeTextWithRegions([{ bbox: [55, 95, 85, 150], label: 'chart' }], items);
    expect(merged[0]?.text).toBe('Wide label');
  });

  test('uses the start of a stretched native vertical run to select its region', () => {
    const items = normalizeTextItemsForLayout([
      { ...makeTextItem('Chart label', [30, 0, 0, 10, 50, 700], 30), height: 120 },
      { ...makeTextItem('Clipped label', [30, 0, 0, 10, 110, 810], 30), height: 40 },
    ], { height: 800, transform: [1, 0, 0, -1, 0, 800] }, { test: { ascent: 0.8, vertical: true } });
    const blocks = mergeTextWithRegions([
      { label: 'chart', bbox: [55, 95, 85, 145] },
      { label: 'image', bbox: [55, 145, 85, 200] },
      { label: 'seal', bbox: [100, 0, 140, 30] },
    ], items);
    expect(blocks.map(({ text }) => text)).toEqual(['Chart label', 'Clipped label', '']);
  });

  test('keeps baseline order and explicit space in a split bottom-to-top label', () => {
    const runs = [
      makeTextItem('Net', [0, 10, -10, 0, 112, 300], 15),
      makeTextItem(' ', [0, 10, -10, 0, 112, 315], 1.5),
      makeTextItem('profit', [0, 10, -10, 0, 112, 316.5], 24),
      makeTextItem('FY26', [10, 0, 0, 10, 153, 310], 20),
      makeTextItem('margin', [0, 10, -10, 0, 112, 353], 30),
    ];
    const normalized = normalizeTextItemsForLayout(runs, {
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    }, { test: { ascent: 0.8 } });

    const chart = mergeTextWithRegions([{ label: 'chart', bbox: [95, 410, 350, 600] }], normalized);
    expect(chart.map(({ text }) => text)).toEqual(['Net profit margin FY26']);
  });

  test('keeps text that is upright after applying the page rotation', () => {
    const body = makeTextItem('Upright in the reader', [0, 10, -10, 0, 40, 100], 90);
    const normalized = normalizeTextItemsForLayout([body], {
      height: 612,
      transform: [0, 1, 1, 0, 0, 0],
    }, { test: { ascent: 0.8 } });

    expect(normalized).toEqual([
      { text: 'Upright in the reader', x: 100, y: 32, width: 90, height: 10, baselineY: 40 },
    ]);
  });

  test.each([0, 0.4])('keeps prose slightly skewed by %d and turned by page rotation', (skew) => {
    const body = [
      makeTextItem('First line.', [10, skew, skew, 10, 40, 300], 90),
      makeTextItem('Second line.', [10, skew, skew, 10, 40, 280], 90),
    ];
    const normalized = normalizeTextItemsForLayout(body, {
      height: 612,
      transform: [0, 1, 1, 0, 0, 0],
    }, { test: { ascent: 0.8 } });
    const items = normalized.map(item => scaleTextItemForLayout(item, 2, 2));
    const blocks = mergeTextWithRegions([{ label: 'text', bbox: [530, 60, 640, 280] }], items);
    expect(blocks.map(({ text }) => text)).toEqual(['First line. Second line.']);
  });

  test('keeps axis-aligned upside-down text in a matching prose region', () => {
    const items = normalizeTextItemsForLayout([
      makeTextItem('Upside-down body text', [-10, 0, 0, -10, 100, 300], 35),
    ], { height: 800, transform: [1, 0, 0, -1, 0, 800] }, { test: { ascent: 0.8 } });
    const blocks = mergeTextWithRegions([{ label: 'text', bbox: [50, 475, 160, 525] }], items);
    expect(blocks.map(({ text }) => text)).toEqual(['Upside-down body text']);
  });

  test('places superscripts inside the same sentence when the page is rotated', () => {
    const body = [
      makeTextItem('word', [12, 0, 0, 12, 40, 300], 25),
      makeTextItem('1', [6, 0, 0, 6, 65, 304], 4),
      makeTextItem('next', [12, 0, 0, 12, 74, 300], 25),
    ];
    const normalized = normalizeTextItemsForLayout(body, {
      height: 612,
      transform: [0, 1, 1, 0, 0, 0],
    }, { test: { ascent: 0.8 } });
    const blocks = mergeTextWithRegions([{ label: 'text', bbox: [280, 30, 350, 120] }], normalized);
    expect(blocks.map(({ text }) => text)).toEqual(['word1 next']);
  });

  test('reads rotated prose and its superscript together between upright lines', () => {
    const items = normalizeTextItemsForLayout([
      makeTextItem('Upright heading.', [0, 10, -10, 0, 20, 270], 76),
      makeTextItem('First', [12, 0, 0, 12, 40, 300], 25),
      makeTextItem('1', [6, 0, 0, 6, 65, 304], 4),
      makeTextItem('line.', [12, 0, 0, 12, 74, 300], 25),
      makeTextItem('Second line.', [12, 0, 0, 12, 40, 280], 64),
      makeTextItem('Upright note.', [0, 10, -10, 0, 115, 270], 72),
    ], { height: 612, transform: [0, 1, 1, 0, 0, 0] }, { test: { ascent: 0.8 } });
    const blocks = mergeTextWithRegions([{ label: 'text', bbox: [250, 8, 350, 125] }], items);
    expect(blocks[0]?.text).toBe('Upright heading. First1 line. Second line. Upright note.');
    expect(blocks[0]?.items).toEqual(items);
  });

  test('orders a heading and an adjacent sideways passage by their displayed top', () => {
    const items = normalizeTextItemsForLayout([
      makeTextItem('Heading.', [0, 10, -10, 0, 40, 210], 60),
      makeTextItem('Sideways note.', [10, 0, 0, 10, 36, 300], 65),
    ], { height: 612, transform: [0, 1, 1, 0, 0, 0] }, { test: { ascent: 0.8 } });
    const blocks = mergeTextWithRegions([{ label: 'text', bbox: [180, 25, 350, 108] }], items);
    expect(blocks[0]?.text).toBe('Heading. Sideways note.');
  });

  test('keeps separate sideways passages on either side of upright text', () => {
    const items = normalizeTextItemsForLayout([
      makeTextItem('Sideways first.', [10, 0, 0, 10, 40, 300], 30),
      makeTextItem('Heading.', [0, 10, -10, 0, 100, 270], 60),
      makeTextItem('Sideways last.', [10, 0, 0, 10, 150, 280], 35),
    ], { height: 612, transform: [0, 1, 1, 0, 0, 0] }, { test: { ascent: 0.8 } });
    const blocks = mergeTextWithRegions([{ label: 'text', bbox: [240, 30, 350, 195] }], items);
    expect(blocks[0]?.text).toBe('Sideways first. Heading. Sideways last.');
    expect(blocks[0]?.items).toEqual(items);
  });

  test('reads rows and columns of a table in page order after rotation', () => {
    const items = normalizeTextItemsForLayout([
      makeTextItem('Total', [10, 0, 0, 10, 40, 300], 26),
      makeTextItem('100', [10, 0, 0, 10, 95, 300], 18),
      makeTextItem('Balance', [10, 0, 0, 10, 40, 280], 40),
      makeTextItem('90', [10, 0, 0, 10, 95, 280], 12),
    ], { height: 612, transform: [0, 1, 1, 0, 0, 0] });
    const blocks = mergeTextWithRegions([{ label: 'table', bbox: [260, 35, 320, 120] }], items);
    expect(blocks[0]?.text).toBe('Total 100 Balance 90');
    expect(blocks[0]?.items).toEqual(items);
  });

  test('allows native vertical prose when page rotation makes the writing upright', () => {
    const run = { ...makeTextItem('Vertical prose', [0, 10, -10, 0, 40, 100], 10), height: 40 };
    const normalized = normalizeTextItemsForLayout([run], {
      height: 612,
      transform: [0, 1, 1, 0, 0, 0],
    }, { test: { ascent: 0.8, vertical: true } });
    const blocks = mergeTextWithRegions([{ label: 'text', bbox: [80, 30, 120, 100] }], normalized);
    expect(blocks.map(({ text }) => text)).toEqual(['Vertical prose']);
  });

  test.each([false, true])('joins sheared native vertical fragments (explicit space: %s)', (spaceBefore) => {
    const space = { ...makeTextItem(' ', [10, 0, 6, 10, 76, 660], 0), height: 1 };
    const items = normalizeTextItemsForLayout([
      { ...makeTextItem('First', [10, 0, 6, 10, 100, 700], 10), height: 40 },
      ...(spaceBefore ? [space] : []),
      { ...makeTextItem('second', [10, 0, 6, 10, spaceBefore ? 75.4 : 76, spaceBefore ? 659 : 660], 10), height: 40 },
    ], { height: 800, transform: [1, 0, 0, -1, 0, 800] }, { test: { ascent: 0.8, vertical: true } });
    const blocks = mergeTextWithRegions([{ label: 'chart', bbox: [40, 90, 115, 195] }], items);
    expect(blocks[0]?.text).toBe(spaceBefore ? 'First second' : 'Firstsecond');
  });

  test('uses visible bounds to assign a rotated label at the page edge', () => {
    const run = makeTextItem('Edge label', [-10, 0, 0, -10, 17, 300], 80);
    const normalized = normalizeTextItemsForLayout([run], {
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    }, { test: { ascent: 0.8 } });
    expect(normalized[0]).toMatchObject({ x: 0, width: 17, rotation: { x: 17, advance: 80 } });
    const blocks = mergeTextWithRegions([{ label: 'chart', bbox: [0, 475, 25, 525] }], normalized);
    expect(blocks.map(({ text }) => text)).toEqual(['Edge label']);
  });

  test('excludes a diagonal run whose bounds overlap the page but whose text is outside', () => {
    const diagonal = Math.SQRT1_2 * 10;
    const run = makeTextItem('Outside', [diagonal, diagonal, -diagonal, diagonal, -16, 96], Math.sqrt(800));
    const items = normalizeTextItemsForLayout([run], { width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100] },
      { test: { ascent: 0.8 } });
    expect(items).toEqual([]);
  });

  test('does not assign a fully clipped label to a graphic at the page edge', () => {
    const run = makeTextItem('Outside the page', [-10, 0, 0, -10, -20, 300], 80);
    const normalized = normalizeTextItemsForLayout([run], {
      width: 612,
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    }, { test: { ascent: 0.8 } });
    const blocks = mergeTextWithRegions([{ label: 'chart', bbox: [0, 475, 25, 525] }], normalized);
    expect(blocks[0]?.text).toBe('');
  });

  test('uses visible bounds to assign a horizontal label at the page edge', () => {
    const runs = [
      makeTextItem('Edge', [10, 0, 0, 10, 94, 50], 16),
      makeTextItem('Outside', [10, 0, 0, 10, 105, 50], 30),
    ];
    const items = normalizeTextItemsForLayout(runs, {
      width: 100, height: 100, transform: [1, 0, 0, -1, 0, 100],
    }, { test: { ascent: 0.8 } });
    expect(items).toMatchObject([{ x: 94, width: 6, baselineY: 50 }]);
    const blocks = mergeTextWithRegions([{ label: 'chart', bbox: [80, 30, 100, 60] }], items);
    expect(blocks[0]?.text).toBe('Edge');
  });

  test('reads rows in their source direction when upside-down prose is rotated by the page', () => {
    const body = [
      makeTextItem('First line.', [-10, 0, 0, -10, 150, 280], 90),
      makeTextItem('Second line.', [-10, 0, 0, -10, 150, 300], 90),
    ];
    const normalized = normalizeTextItemsForLayout(body, {
      height: 612,
      transform: [0, 1, 1, 0, 0, 0],
    });
    const blocks = mergeTextWithRegions([{ label: 'text', bbox: [250, 45, 340, 160] }], normalized);
    expect(blocks.map(({ text }) => text)).toEqual(['First line. Second line.']);
  });

  test('does not transfer a space from a different row to touching fragments', () => {
    const runs = [
      makeTextItem('Net', [10, 0, 0, 10, 100, 300], 15),
      makeTextItem(' ', [10, 0, 0, 10, 115, 320], 1.5),
      makeTextItem('profit', [10, 0, 0, 10, 115, 300], 25),
    ];
    const normalized = normalizeTextItemsForLayout(runs, {
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    });
    const blocks = mergeTextWithRegions([{ label: 'chart', bbox: [90, 475, 160, 510] }], normalized);
    expect(blocks.map(({ text }) => text)).toEqual(['Netprofit']);
  });

  test('matches each explicit space when extraction interleaves two rows', () => {
    const runs = [
      makeTextItem('Net', [10, 0, 0, 10, 100, 300], 15),
      makeTextItem(' ', [10, 0, 0, 10, 115, 300], 1),
      makeTextItem('FY26', [10, 0, 0, 10, 100, 280], 25),
      makeTextItem(' ', [10, 0, 0, 10, 125, 280], 1),
      makeTextItem('profit', [10, 0, 0, 10, 116, 300], 25),
      makeTextItem('estimate', [10, 0, 0, 10, 126, 280], 35),
    ];
    const items = normalizeTextItemsForLayout(runs, { height: 800, transform: [1, 0, 0, -1, 0, 800] });
    const blocks = mergeTextWithRegions([{ label: 'chart', bbox: [90, 475, 170, 530] }], items);
    expect(blocks[0]?.text).toBe('Net profit FY26 estimate');
  });

  test('does not rescan unmatched spaces from earlier rows', () => {
    let spaceTransformReads = 0;
    const runs = Array.from({ length: 64 }, (_, row) => {
      const y = 1400 - row * 20;
      const { transform, ...space } = makeTextItem(' ', [10, 0, 0, 10, 20, y], 1);
      return [{
        ...space,
        get transform() {
          spaceTransformReads += 1;
          return transform;
        },
      }, makeTextItem(`Row ${row}`, [10, 0, 0, 10, 80, y], 30)];
    }).flat();
    const items = normalizeTextItemsForLayout(runs, { height: 1500, transform: [1, 0, 0, -1, 0, 1500] });
    expect(items).toHaveLength(64);
    expect(items.every(item => !item.spaceBefore)).toBe(true);
    expect(spaceTransformReads).toBeLessThan(64 * 6);
  });

  test.each([
    { width: 1, nextX: 117 },
    { width: 1.25, nextX: 117 },
    { width: 1.25, nextX: 118.75 },
  ])('keeps the explicit space after a suffix of width $width before x=$nextX', ({ width, nextX }) => {
    const runs = [
      makeTextItem('Net', [10, 0, 0, 10, 100, 300], 15),
      makeTextItem(' ', [10, 0, 0, 10, 116, 300], 1),
      makeTextItem('1', [10, 0, 0, 10, 115, 300], width),
      makeTextItem('next', [10, 0, 0, 10, nextX, 300], 18),
    ];
    const items = normalizeTextItemsForLayout(runs, { height: 800, transform: [1, 0, 0, -1, 0, 800] });
    expect(items.map(item => Boolean(item.spaceBefore))).toEqual([false, false, true]);
    const blocks = mergeTextWithRegions([{ label: 'chart', bbox: [90, 475, 160, 525] }], items);
    expect(blocks[0]?.text).toBe('Net1 next');
  });

  test('keeps narrow spaces without adding spaces between adjacent fragments', () => {
    const runs = [
      makeTextItem('Net', [10, 0, 0, 10, 100, 300], 15),
      makeTextItem(' ', [10, 0, 0, 10, 115, 300], 1.5),
      makeTextItem('Ignored', [10, 5, 2, 10, 116, 300], 1),
      makeTextItem('pro', [10, 0, 0, 10, 116.5, 300], 13),
      makeTextItem('fit', [10, 0, 0, 10, 129.5, 300], 11),
    ];
    const normalized = normalizeTextItemsForLayout(runs, {
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    });

    const blocks = mergeTextWithRegions([{ label: 'chart', bbox: [90, 475, 160, 510] }], normalized);
    expect(blocks.map(({ text }) => text)).toEqual(['Net profit']);
  });

  test.each([
    { nextY: 315, expected: 'Netprofit' },
    { nextY: 316.5, expected: 'Net profit' },
  ])('uses scaled advance for a rotated label ending at $nextY', ({ nextY, expected }) => {
    const normalized = normalizeTextItemsForLayout([
      makeTextItem('Net', [0, 10, -10, 0, 112, 300], 15),
      makeTextItem('profit', [0, 10, -10, 0, 112, nextY], 24),
    ], { height: 800, transform: [1, 0, 0, -1, 0, 800] });
    const items = normalized.map(item => scaleTextItemForLayout(item, 1.4, 1.5));

    const blocks = mergeTextWithRegions([{ label: 'chart', bbox: [130, 675, 190, 760] }], items);
    expect(blocks.map(({ text }) => text)).toEqual([expected]);
  });

  test('keeps a smaller inline citation in left-to-right order on its baseline', () => {
    const body = [
      makeTextItem('Sentence one', [12, 0, 0, 12, 50, 300], 65),
      makeTextItem('(Citation.)', [6, 0, 0, 6, 119, 300], 24),
      makeTextItem('Sentence two.', [12, 0, 0, 12, 148, 300], 72),
      makeTextItem('Next line.', [12, 0, 0, 12, 50, 284], 48),
    ];
    const normalized = normalizeTextItemsForLayout(body, {
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    }, { test: { ascent: 0.8 } });

    const blocks = mergeTextWithRegions([{ label: 'text', bbox: [40, 480, 225, 525] }], normalized);
    expect(blocks.map(({ text }) => text)).toEqual(['Sentence one (Citation.) Sentence two. Next line.']);
  });

  test.each([
    { citationSize: 6, citationX: 119, bodyX: 50 },
    { citationSize: 6, citationX: 139, bodyX: 50 },
    { citationSize: 6, citationX: 149, bodyX: 60 },
    { citationSize: 12, citationX: 119, bodyX: 50 },
  ])('keeps a size-$citationSize citation at x=$citationX on its baseline', ({ citationSize, citationX, bodyX }) => {
    const body = [
      makeTextItem('Sentence one', [12, 0, 0, 12, bodyX, 300], 65),
      makeTextItem('(Citation.)', [citationSize, 0, 0, citationSize, citationX, 300], 24),
      makeTextItem('Next', [20, 0, 0, 20, 50, 291.2], 65),
      makeTextItem('line.', [20, 0, 0, 20, citationX + 29, 291.2], 72),
    ];
    const normalized = normalizeTextItemsForLayout(body, {
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    }, { test: { ascent: 0.8 } });

    const blocks = mergeTextWithRegions([{ label: 'text', bbox: [40, 480, 255, 530] }], normalized);
    expect(blocks.map(({ text }) => text)).toEqual(['Sentence one (Citation.) Next line.']);
  });

  test('keeps a citation on the baseline of a single-letter word', () => {
    const body = [
      makeTextItem('I', [12, 0, 0, 12, 50, 300], 5),
      makeTextItem('(Citation.)', [6, 0, 0, 6, 139, 300], 24),
      makeTextItem('Next', [20, 0, 0, 20, 50, 291.2], 65),
      makeTextItem('line.', [20, 0, 0, 20, 168, 291.2], 72),
    ];
    const normalized = normalizeTextItemsForLayout(body, {
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    }, { test: { ascent: 0.8 } });

    const blocks = mergeTextWithRegions([{ label: 'text', bbox: [40, 480, 255, 530] }], normalized);
    expect(blocks.map(({ text }) => text)).toEqual(['I (Citation.) Next line.']);
  });

  test('accounts for non-zero page origins in the viewport transform', () => {
    const croppedPageLine = makeTextItem(
      'Vasher turned away.',
      [11.2, 0, 0, 11.2, 127.5, 644.4128],
      100,
    );

    const normalized = normalizeTextItemsForLayout([croppedPageLine], {
      height: 666.0074,
      transform: [1, 0, 0, -1, -53.4352, 720.565],
    }, {
      test: { ascent: 0.716, descent: -0.269 },
    });

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.x).toBeCloseTo(74.0648, 4);
    expect(normalized[0]?.y).toBeCloseTo(68.1356, 2);
  });

  test('uses font ascent to place decorative initials closer to the visible glyph top', () => {
    const dropCap = makeTextItem(
      'I',
      [60, 0, 0, 60, 111.1326, 434.46],
      9.18,
    );

    const normalized = normalizeTextItemsForLayout([dropCap], {
      height: 666.0074,
      transform: [1, 0, 0, -1, -53.4352, 720.565],
    }, {
      test: { ascent: 0.638, descent: -0.134 },
    });

    expect(normalized).toHaveLength(1);
    expect(normalized[0]?.y).toBeCloseTo(247.825, 3);
  });
});
