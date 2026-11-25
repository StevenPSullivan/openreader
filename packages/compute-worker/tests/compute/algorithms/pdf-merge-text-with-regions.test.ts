import { describe, expect, test } from 'vitest';
import { buildPdfPageSourceUnits } from '@openreader/tts/pdf-sources';
import { mergeTextWithRegions, type LayoutRegion } from '../../../src/inference/pdf/document-layout';

describe('mergeTextWithRegions', () => {
  test('assigns text items to containing regions by centroid and joins in reading order', () => {
    const regions = [
      { bbox: [0, 0, 100, 50] as [number, number, number, number], label: 'text' as const },
      { bbox: [0, 50, 100, 100] as [number, number, number, number], label: 'figure_title' as const },
    ];

    const textItems = [
      { text: 'world', x: 40, y: 20, width: 20, height: 8 },
      { text: 'hello', x: 10, y: 20, width: 20, height: 8 },
      { text: 'Figure', x: 10, y: 70, width: 24, height: 8 },
      { text: '1.2', x: 40, y: 70, width: 10, height: 8 },
    ];

    const merged = mergeTextWithRegions(regions, textItems);
    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe('hello world');
    expect(merged[1].text).toBe('Figure 1.2');
  });

  test('drops text whose centroid is outside every region', () => {
    const regions = [
      { bbox: [0, 0, 50, 50] as [number, number, number, number], label: 'text' as const },
    ];
    const textItems = [
      { text: 'inside', x: 10, y: 10, width: 10, height: 8 },
      { text: 'outside', x: 80, y: 80, width: 12, height: 8 },
    ];

    const merged = mergeTextWithRegions(regions, textItems);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('inside');
  });

  test.each(['table', 'chart', 'image', 'seal'] as const)(
    'keeps PDF text and empty regions of kind %s',
    (label) => {
      const regions: LayoutRegion[] = [
        { bbox: [0, 0, 100, 50], label: 'text' },
        { bbox: [0, 50, 100, 100], label },
        { bbox: [0, 100, 100, 150], label: 'figure_title' },
        { bbox: [0, 150, 100, 200], label },
      ];
      const textItems = [
        { text: 'Body', x: 10, y: 20, width: 20, height: 8 },
        { text: 'Right', x: 40, y: 60, width: 20, height: 8 },
        { text: 'Left', x: 10, y: 60, width: 20, height: 8 },
        { text: 'Second row', x: 10, y: 80, width: 45, height: 8 },
        { text: 'Caption', x: 10, y: 120, width: 30, height: 8 },
      ];

      expect(mergeTextWithRegions(regions, textItems).map(({ region, text }) => ({
        label: region.label, text,
      }))).toEqual([
        { label: 'text', text: 'Body' },
        { label, text: 'Left Right Second row' },
        { label: 'figure_title', text: 'Caption' },
        { label, text: '' },
      ]);
    },
  );

  test('separates adjacent table rows with overlapping text bounds', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 100, 100], label: 'table' }], [
      { text: 'Total', x: 10, y: 30, width: 19, height: 16, baselineY: 42 },
      { text: 'Balance', x: 10, y: 38, width: 29, height: 16, baselineY: 50 },
    ]);
    expect(merged[0]?.text).toBe('Total Balance');
  });

  test('breaks close confidence ties relative to the highest-scoring region', () => {
    const table: LayoutRegion = { bbox: [0, 0, 100, 100], label: 'table', confidence: 0.9000012 };
    const chart: LayoutRegion = { bbox: [10, 10, 90, 90], label: 'chart', confidence: 0.9000006 };
    const image: LayoutRegion = { bbox: [20, 20, 80, 80], label: 'image', confidence: 0.9 };
    const label = { text: 'Total', x: 40, y: 40, width: 15, height: 10 };
    for (const regions of [[table, chart, image], [image, chart, table], [chart, table, image]]) {
      const blocks = mergeTextWithRegions(regions, [label]);
      expect(blocks.filter(block => block.text).map(block => block.region.label)).toEqual(['chart']);
    }
  });

  test('keeps a caption in its own block when a chart overlaps it', () => {
    const regions: LayoutRegion[] = [
      { bbox: [0, 0, 100, 100], label: 'chart', confidence: 0.99 },
      { bbox: [0, 75, 100, 95], label: 'figure_title', confidence: 0.8 },
    ];
    const textItems = [
      { text: 'Legend', x: 10, y: 30, width: 25, height: 8 },
      { text: 'Caption', x: 10, y: 80, width: 30, height: 8 },
    ];

    expect(mergeTextWithRegions(regions, textItems).map(({ items }) => items)).toEqual([
      [textItems[0]],
      [textItems[1]],
    ]);
  });

  test.each(['header', 'doc_title', 'paragraph_title'] as const)(
    'does not reclassify a rotated %s as graphic text',
    (label) => {
      const rotation = { x: 15, y: 50, dx: 0, dy: -1, advance: 18 };
      const merged = mergeTextWithRegions([
        { bbox: [0, 0, 100, 100], label: 'chart', confidence: 0.99 },
        { bbox: [35, 20, 95, 70], label, confidence: 0.8 },
      ], [
        { text: 'Running title', x: 54, y: 30, width: 34, height: 8 },
        { text: 'Rotated metadata', x: 40, y: 30, width: 10, height: 20, rotation: { ...rotation, x: 45 } },
        { text: 'Axis label', x: 10, y: 30, width: 10, height: 20, rotation },
      ]);
      const page = { blocks: merged.map(({ region, text }, index) => ({
        id: String(index), kind: region.label, text, fragments: [],
      })) };
      const spoken = (skipKinds: string[]) => buildPdfPageSourceUnits(page, 1, skipKinds).map(unit => unit.text);

      expect(spoken([])).toEqual(['Running title', 'Axis label']);
      expect(spoken([label])).toEqual(['Axis label']);
      expect(spoken(['chart'])).toEqual(['Running title']);
    },
  );

  test('keeps decorative drop caps attached to the same line when boxes overlap vertically', () => {
    const regions = [
      { bbox: [0, 0, 200, 120] as [number, number, number, number], label: 'text' as const },
    ];

    const textItems = [
      { text: 'I', x: 0, y: 10, width: 12, height: 60 },
      { text: 't’s funny,', x: 12, y: 40, width: 50, height: 12 },
    ];

    const merged = mergeTextWithRegions(regions, textItems);
    expect(merged).toHaveLength(1);
    expect(merged[0].text).toBe('It’s funny,');
  });

  test('keeps a drop cap before the first line even when its baseline matches a later line', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], [
      { text: 'I', x: 0, y: 10, width: 12, height: 50, baselineY: 50 },
      { text: 't’s funny.', x: 12, y: 22, width: 42, height: 12, baselineY: 32 },
      { text: 'Next line.', x: 12, y: 40, width: 42, height: 12, baselineY: 50 },
    ]);
    expect(merged.map(({ text }) => text)).toEqual(['It’s funny. Next line.']);
  });

  test('keeps an explicit word boundary after a drop cap', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], [
      { text: 'I', x: 10, y: 8, width: 12, height: 50, baselineY: 50 },
      { text: 'am here.', x: 23, y: 12, width: 48, height: 12, baselineY: 22, spaceBefore: true },
      { text: 'Next line.', x: 23, y: 40, width: 42, height: 12, baselineY: 50 },
    ]);
    expect(merged[0]?.text).toBe('I am here. Next line.');
  });

  test('keeps a drop cap separate from the slightly larger text of the second line', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], [
      { text: 'I', x: 0, y: 10, width: 12, height: 24, baselineY: 32 },
      { text: 't’s funny.', x: 12, y: 12, width: 42, height: 12, baselineY: 21.6 },
      { text: 'Next line.', x: 12, y: 22.32, width: 42, height: 12.1, baselineY: 32 },
    ]);
    expect(merged.map(({ text }) => text)).toEqual(['It’s funny. Next line.']);
  });

  test('keeps a single-letter word with the other body text near a superscript', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], [
      { text: 'Then', x: 10, y: 90.4, width: 24, height: 12, baselineY: 100 },
      { text: 'I', x: 39, y: 90.4, width: 5, height: 12, baselineY: 100 },
      { text: 'left', x: 49, y: 90.4, width: 20, height: 12, baselineY: 100 },
      { text: '1', x: 70, y: 89.2, width: 3, height: 6, baselineY: 94 },
    ]);
    expect(merged[0]?.items.map(({ text }) => text)).toEqual(['Then', 'I', 'left', '1']);
  });

  test.each([
    { boundary: 'a geometric gap', nextX: 49, spaceBefore: false, expected: 'Then I1 left' },
    { boundary: 'an explicit space', nextX: 46, spaceBefore: true, expected: 'Then I1 left' },
    { boundary: 'no space', nextX: 46, spaceBefore: false, expected: 'Then I1left' },
    { boundary: 'the next run touching it', nextX: 47, spaceBefore: false, expected: 'Then I1left' },
  ])('keeps an inline superscript in place with $boundary', ({ nextX, spaceBefore, expected }) => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], [
      { text: 'Then', x: 10, y: 90.4, width: 24, height: 12, baselineY: 100 },
      { text: 'I', x: 39, y: 90.4, width: 5, height: 12, baselineY: 100 },
      { text: 'left', x: nextX, y: 90.4, width: 20, height: 12, baselineY: 100, spaceBefore },
      { text: '1', x: 44, y: 89.2, width: 3, height: 6, baselineY: 94 },
    ]);
    expect(merged[0]?.items.map(({ text }) => text)).toEqual(['Then', 'I', '1', 'left']);
    expect(merged[0]?.text).toBe(expected);
  });

  test('places an inline superscript even when its top sits below the surrounding text', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 200, 700, 270], label: 'text' }], [
      { text: 'We kept the original word', x: 108, y: 238.71, width: 203.076, height: 18, baselineY: 255 },
      { text: '2', x: 311.076, y: 240.85, width: 5.004, height: 9, baselineY: 249 },
      { text: ', then carried on.', x: 316.08, y: 238.71, width: 139, height: 18, baselineY: 255 },
    ]);
    expect(merged[0]?.text).toBe('We kept the original word2, then carried on.');
  });

  test('keeps smaller text on an adjacent line even between the two body runs', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], [
      { text: 'Short label', x: 55, y: 77.5, width: 27, height: 7, baselineY: 82.5 },
      { text: 'Start', x: 10, y: 81, width: 40, height: 18, baselineY: 97 },
      { text: 'end', x: 85, y: 81, width: 35, height: 18, baselineY: 97 },
    ]);
    expect(merged[0]?.text).toBe('Short label Start end');
  });

  test.each([
    { x: 49, width: 7 },
    { x: 49, width: 8 },
    { x: 50, width: 8 },
  ])('keeps a chart label of width $width on its own line near x=$x', ({ x, width }) => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'chart' }], [
      { text: 'Q1', x, y: 84, width, height: 8, baselineY: 90 },
      { text: 'Start', x: 10, y: 86, width: 38, height: 15, baselineY: 100 },
    ]);
    expect(merged[0]?.text).toBe('Q1 Start');
  });

  test('keeps a narrow raised suffix slightly separated from a chart label', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'chart' }], [
      { text: 'cm', x: 10, y: 90, width: 14, height: 12, baselineY: 102 },
      { text: '2', x: 25, y: 88, width: 4, height: 6, baselineY: 94 },
    ]);
    expect(merged[0]?.text).toBe('cm2');
  });

  test('does not move a full row after a nearby lower line', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 230, 120], label: 'text' }], [
      { text: 'An independent upper row', x: 51, y: 81, width: 140, height: 10, baselineY: 90 },
      { text: 'Lower row', x: 10, y: 84, width: 40, height: 20, baselineY: 100 },
    ]);
    expect(merged[0]?.text).toBe('An independent upper row Lower row');
  });

  test('prefers a touching word over a closer line that only surrounds the mark', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 130], label: 'text' }], [
      { text: 'near', x: 10, y: 89, width: 20, height: 12, baselineY: 102 },
      { text: '1', x: 50, y: 90, width: 4, height: 6, baselineY: 96 },
      { text: 'line', x: 65, y: 89, width: 20, height: 12, baselineY: 102 },
      { text: 'far', x: 10, y: 88, width: 39, height: 18, baselineY: 110 },
    ]);
    expect(merged[0]?.items.map(({ text }) => text)).toEqual(['near', 'line', 'far', '1']);
  });

  test('keeps an explicitly spaced terminal superscript with its word', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 120, 120], label: 'text' }], [
      { text: 'Note', x: 10, y: 90.4, width: 24, height: 12, baselineY: 100 },
      { text: '[1]', x: 37, y: 90.2, width: 6, height: 6, baselineY: 95, spaceBefore: true },
    ]);
    expect(merged[0]?.text).toBe('Note [1]');
  });

  test.each([28, 29, 30, 30.5])('keeps a wider numeric superscript starting near x=%d', (x) => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 120, 120], label: 'text' }], [
      { text: 'cm', x: 10, y: 20, width: 20, height: 20, baselineY: 40 },
      { text: '12345', x, y: 18, width: 24, height: 8, baselineY: 26 },
    ]);
    expect(merged[0]?.text).toBe('cm12345');
  });

  test('keeps a separator between different rotated lines', () => {
    const items = ['A', 'B', 'C'].map((text, i) => {
      const x = 100 + i * 2;
      const y = 10 + i * 10;
      return { text, x, y, width: 8, height: 10, rotation: { x, y, dx: 0, dy: 1, advance: 10 } };
    });
    const regions: LayoutRegion[] = [{ bbox: [0, 0, 200, 120], label: 'chart' }];
    expect(mergeTextWithRegions(regions, items)[0]?.text).toBe('AB C');
    expect(mergeTextWithRegions(regions, [...items].reverse())[0]?.text).toBe('AB C');
  });

  test('uses the same order for nearby rotated labels in either input order', () => {
    const items = [
      { text: 'Upper', x: 30, y: 10 },
      { text: 'Middle', x: 20, y: 12 },
      { text: 'Lower', x: 10, y: 14 },
    ].map(item => ({ ...item, width: 8, height: 12,
      rotation: { x: item.x, y: item.y, dx: 0, dy: 1, advance: 12 } }));
    const regions: LayoutRegion[] = [{ bbox: [0, 0, 100, 100], label: 'chart' }];
    expect(mergeTextWithRegions(regions, items)[0]?.text).toBe('Middle Upper Lower');
    expect(mergeTextWithRegions(regions, [...items].reverse())[0]?.text).toBe('Middle Upper Lower');
  });

  test('honors explicit spaces between runs in the same line with different baselines', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], [
      { text: 'Net', x: 10, y: 88.4, width: 15, height: 12, baselineY: 98 },
      { text: 'profit', x: 26, y: 92.4, width: 25, height: 12, baselineY: 102, spaceBefore: true },
      { text: 'grew', x: 56, y: 90.4, width: 25, height: 12, baselineY: 100 },
    ]);
    expect(merged[0]?.text).toBe('Net profit grew');
  });

  test('does not insert a space when shorter text touches a superscript', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], [
      { text: 'Then', x: 10, y: 90.4, width: 24, height: 12, baselineY: 100 },
      { text: 'I', x: 39, y: 90.4, width: 5, height: 12, baselineY: 100 },
      { text: '1', x: 44, y: 89.2, width: 3, height: 6, baselineY: 94 },
      { text: 'left', x: 47, y: 93.6, width: 20, height: 8, baselineY: 100 },
    ]);
    expect(merged[0]?.text).toBe('Then I1left');
  });

  test('keeps runs on the same line when their baselines differ slightly', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], [
      { text: 'prefix', x: 10, y: 90.4, width: 25, height: 12, baselineY: 100 },
      { text: 'word', x: 40, y: 88.4, width: 24, height: 12, baselineY: 98 },
      { text: '1', x: 64, y: 89.2, width: 3, height: 6, baselineY: 94 },
      { text: 'tail', x: 67, y: 92.4, width: 20, height: 12, baselineY: 102 },
    ]);
    expect(merged[0]?.text).toBe('prefix word1tail');
  });

  test.each([
    { order: ['middle', 'left', 'right'] as const },
    { order: ['right', 'middle', 'left'] as const },
  ])('orders a line with slightly shifted baselines from input $order', ({ order }) => {
    const items = {
      left: { text: 'left', x: 10, y: 92.4, width: 24, height: 12, baselineY: 102 },
      middle: { text: 'middle', x: 40, y: 90.4, width: 24, height: 12, baselineY: 100 },
      right: { text: 'right', x: 70, y: 88.4, width: 24, height: 12, baselineY: 98 },
    };
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], order.map(key => items[key]));
    expect(merged[0]?.text).toBe('left middle right');
  });

  test.each([89.2, 87.4])('preserves a space before a raised reference at y=%d', (y) => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], [
      { text: 'Note', x: 10, y: 90.4, width: 24, height: 12, baselineY: 100 },
      { text: '[1]', x: 35, y, width: 6, height: 6, baselineY: 94, spaceBefore: true },
      { text: 'then', x: 50, y: 90.4, width: 25, height: 12, baselineY: 100 },
    ]);
    expect(merged[0]?.text).toBe('Note [1] then');
  });

  test('places medial and terminal superscripts on the same raised baseline independently', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], [
      { text: 'word', x: 10, y: 90.4, width: 24, height: 12, baselineY: 100 },
      { text: '1', x: 34, y: 89.2, width: 3, height: 6, baselineY: 94 },
      { text: 'next', x: 45, y: 90.4, width: 24, height: 12, baselineY: 100 },
      { text: '2', x: 69, y: 89.2, width: 3, height: 6, baselineY: 94 },
    ]);
    expect(merged[0]?.text).toBe('word1 next2');
  });

  test.each([
    { first: '1', second: '2', width: 3 },
    { first: '12', second: '34', width: 7 },
  ])('keeps superscript $first and $second with adjacent short words', ({ first, second, width }) => {
    const secondWordX = 17 + width;
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], [
      { text: 'A', x: 10, y: 90.4, width: 6, height: 12, baselineY: 100 },
      { text: first, x: 16, y: 89.2, width, height: 6, baselineY: 94 },
      { text: 'B', x: secondWordX, y: 90.4, width: 5, height: 12, baselineY: 100, spaceBefore: true },
      { text: second, x: secondWordX + 5, y: 89.2, width, height: 6, baselineY: 94 },
    ]);
    expect(merged[0]?.text).toBe(`A${first} B${second}`);
  });

  test('keeps adjoining raised glyphs together at the end of the line', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], [
      { text: 'word', x: 10, y: 90.4, width: 24, height: 12, baselineY: 100 },
      { text: '1', x: 34, y: 87.25, width: 3, height: 8, baselineY: 94 },
      { text: 'a', x: 37, y: 87.3, width: 3, height: 7.5, baselineY: 94 },
      { text: 'Next line', x: 10, y: 105, width: 45, height: 12, baselineY: 114 },
    ]);
    expect(merged[0]?.text).toBe('word1a Next line');
  });

  test('keeps a raised citation in order after another raised citation moves', () => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], [
      { text: 'A', x: 10, y: 90.4, width: 6, height: 12, baselineY: 100 },
      { text: '12', x: 16, y: 89.2, width: 8, height: 7, baselineY: 94 },
      { text: 'I', x: 25, y: 90.4, width: 3, height: 12, baselineY: 100 },
      { text: '34', x: 31, y: 89.2, width: 8, height: 7, baselineY: 94 },
      { text: 'tail', x: 42, y: 90.4, width: 20, height: 12, baselineY: 100 },
    ]);
    expect(merged[0]?.items.map(({ text }) => text)).toEqual(['A', '12', 'I', '34', 'tail']);
  });

  test.each([10, 34, 46])('keeps a line break after a superscript when the next line starts at x=%i', (nextX) => {
    const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 140], label: 'text' }], [
      { text: 'word', x: 10, y: 84, width: 24, height: 18, baselineY: 100 },
      { text: '1', x: 34, y: 86, width: 4, height: 8, baselineY: 92 },
      { text: 'Next line', x: nextX, y: 92, width: 45, height: 18, baselineY: 108 },
    ]);
    expect(merged[0]?.text).toBe('word1 Next line');
  });

  test.each([{ punctuation: ',', gap: 0 }, { punctuation: '"', gap: 1 }])(
    'keeps closing punctuation $punctuation attached after an inline superscript',
    ({ punctuation, gap }) => {
      const merged = mergeTextWithRegions([{ bbox: [0, 0, 200, 120], label: 'text' }], [
        { text: 'word', x: 10, y: 90.4, width: 24, height: 12, baselineY: 100 },
        { text: punctuation, x: 37 + gap, y: 90.4, width: 3, height: 12, baselineY: 100 },
        { text: 'next', x: 45, y: 90.4, width: 24, height: 12, baselineY: 100 },
        { text: '1', x: 34, y: 89.2, width: 3, height: 6, baselineY: 94 },
      ]);
      expect(merged[0]?.text).toBe(`word1${punctuation} next`);
    },
  );
});
