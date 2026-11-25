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

  test('uses the layout coordinates for gaps along a rotated label', () => {
    const normalized = normalizeTextItemsForLayout([
      makeTextItem('Net', [0, 10, -10, 0, 112, 300], 15),
      makeTextItem('profit', [0, 10, -10, 0, 112, 316.5], 24),
    ], { height: 800, transform: [1, 0, 0, -1, 0, 800] });
    const items = normalized.map(item => scaleTextItemForLayout(item, 1.4, 1.5));

    const blocks = mergeTextWithRegions([{ label: 'chart', bbox: [130, 675, 190, 760] }], items);
    expect(blocks.map(({ text }) => text)).toEqual(['Net profit']);
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

  test('keeps a small citation on its line when the next line has a taller text box', () => {
    const body = [
      makeTextItem('Sentence one', [12, 0, 0, 12, 50, 300], 65),
      makeTextItem('(Citation.)', [6, 0, 0, 6, 119, 300], 24),
      makeTextItem('Next line.', [20, 0, 0, 20, 50, 291.2], 80),
    ];
    const normalized = normalizeTextItemsForLayout(body, {
      height: 800,
      transform: [1, 0, 0, -1, 0, 800],
    }, { test: { ascent: 0.8 } });

    const blocks = mergeTextWithRegions([{ label: 'text', bbox: [40, 480, 225, 530] }], normalized);
    expect(blocks.map(({ text }) => text)).toEqual(['Sentence one (Citation.) Next line.']);
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
