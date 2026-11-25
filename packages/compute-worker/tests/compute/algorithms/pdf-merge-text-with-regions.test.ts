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
});
