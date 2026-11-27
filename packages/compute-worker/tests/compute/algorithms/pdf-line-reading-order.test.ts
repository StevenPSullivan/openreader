import { describe, expect, test } from 'vitest';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { mergeTextWithRegions, type LayoutRegion } from '../../../src/inference/pdf/document-layout';
import { normalizeTextItemsForLayout } from '../../../src/inference/pdf/normalize-text';

type Run = [text: string, size: number, rise?: number, width?: number];

// Runs set left to right from x on one PDF baseline, as pdf.js reports them.
function line(x: number, baseline: number, ...runs: Run[]) {
  return runs.map(([str, size, rise = 0, width = str.length * size * 0.5]) => {
    const item = { str, transform: [size, 0, 0, size, x, baseline + rise], width, fontName: 'f' };
    x += width;
    return item as unknown as TextItem;
  });
}

// Places runs on a US Letter page the way the parser does at its 1.5 render scale.
function readAtRenderScale(lines: TextItem[][], label: LayoutRegion['label'] = 'text') {
  const scale = 1.5;
  const items = normalizeTextItemsForLayout(lines.flat(), { height: 792, transform: [1, 0, 0, -1, 0, 792] }, {
    f: { ascent: 0.905, descent: -0.212 },
    // A font with only a descent, so 70% of its height sits above the baseline.
    low: { descent: -0.3 },
  }).map((item) => ({
    ...item,
    x: item.x * scale,
    y: item.y * scale,
    width: item.width * scale,
    height: item.height * scale,
  }));
  return mergeTextWithRegions([{ bbox: [0, 0, 612 * scale, 792 * scale], label }], items);
}

const inFont = (fontName: string, items: TextItem[]) => items.map((item) => ({ ...item, fontName }) as TextItem);
const runOrder = (lines: TextItem[][]) => readAtRenderScale(lines)[0]!.items.map((item) => item.text);

describe('PDF line reading order', () => {
  test('reads a smaller citation in place on its line', () => {
    const merged = readAtRenderScale([
      line(72, 686, ['Sentence one ', 12], ['(Smith 2020.)', 8], [' Sentence two.', 12]),
      line(72, 672, ['The next line follows.', 12]),
    ]);
    expect(merged.map((block) => block.text)).toEqual(['Sentence one (Smith 2020.) Sentence two. The next line follows.']);

    // Body and citation fonts with different ascents still share the baseline.
    const [one, citation, two] = line(72, 686, ['Sentence one ', 13], ['(Smith 2020.)', 8], [' Sentence two.', 13]);
    expect(runOrder([inFont('low', [one!, two!]), [citation!]])).toEqual(['Sentence one ', '(Smith 2020.)', ' Sentence two.']);

    // A citation at half the body size.
    expect(runOrder([line(57, 639, ['The survey was repeated ', 12], ['(Station log, 2025.)', 6], [' Staff confirmed it.', 12])]))
      .toEqual(['The survey was repeated ', '(Station log, 2025.)', ' Staff confirmed it.']);
  });

  test('reads a larger value in place, row by row, in text and table regions', () => {
    const row = (baseline: number, cells: string[]) => cells.flatMap((cell, column) => (
      line([72, 172, 292, 372][column]!, baseline, [cell, column === 3 ? 15 : 11])
    ));
    for (const label of ['text', 'table'] as const) {
      const merged = readAtRenderScale([
        row(690, ['Alder', '38 degrees', 'Left', '40 psi']),
        row(662, ['Birch', '41 degrees', 'Right', '45 psi']),
      ], label);
      expect(merged.map((block) => block.text)).toEqual(['Alder 38 degrees Left 40 psi Birch 41 degrees Right 45 psi']);
    }
  });

  test('keeps adjacent lines apart', () => {
    expect(runOrder([
      line(100, 580, ['Solid leading one.', 12]),
      line(72, 568, ['Solid leading two.', 12]),
      line(100, 541, ['A small note 11 pt above.', 8]),
      line(72, 530, ['A larger line.', 16]),
      line(60, 523, ['A small note 7 pt below.', 8]),
    ])).toEqual(['Solid leading one.', 'Solid leading two.', 'A small note 11 pt above.', 'A larger line.', 'A small note 7 pt below.']);

    // A chart value over three times its label's size, with the label 9 pt below.
    expect(runOrder([line(100, 400, ['40%', 24]), line(90, 391, ['Growth', 8])])).toEqual(['40%', 'Growth']);
  });

  test('keeps raised and lowered markers from linking lines', () => {
    const cases = [
      // A subscript above the next line's superscript on solid leading.
      [line(72, 500, ['Water is H', 12], ['2', 8, -3.5], ['O here.', 12]), line(72, 488, ['Area is m', 12], ['2', 8, 4.75], [' too.', 12])],
      // On 10 pt leading a high superscript sits just under the line above.
      [line(72, 500, ['Water is H', 12], ['2', 6, -1], ['O here.', 12]), line(72, 490, ['Area is m', 12], ['2', 6, 6], [' too.', 12])],
    ];
    for (const lines of cases) {
      const order = runOrder(lines);
      expect(order.indexOf('O here.')).toBeLessThan(order.indexOf('Area is m'));
      expect(order.indexOf('Area is m')).toBeLessThan(order.indexOf(' too.'));
    }
  });

  test('keeps drop caps with their first line', () => {
    const paragraph = (cap: TextItem[], indent: number, leading: number, lines: number) => [
      cap,
      ...['nce the rain ', 'Everyone followed ', 'The shops '].slice(0, lines).map((text, index) => (
        line(indent, 474 - leading * index, [text, 12], ['go on.', 12])
      )),
      line(72, 474 - leading * lines, ['Back at the margin.', 12]),
    ];
    const expected = (lines: number) => [
      ['O', 'nce the rain ', 'Everyone followed ', 'The shops '].slice(0, lines + 1).flatMap((text, index) => (index ? [text, 'go on.'] : [text])),
      'Back at the margin.',
    ].flat();

    // Three lines: the cap's top just above and just below the first line's.
    for (const capSize of [43, 42.8]) {
      expect(runOrder(paragraph(line(72, 446, ['O', capSize]), 72 + capSize * 0.5, 14, 3))).toEqual(expected(3));
    }
    // Two lines at twice the body size, on solid and tighter leading, and a cap
    // wider than each run beside it.
    for (const [leading, width] of [[12, 12], [10.5, 12], [12, 30]] as const) {
      const cap = line(72, 474 - leading, ['O', 24, 0, width]);
      expect(runOrder(paragraph(cap, 72 + width, leading, 2))).toEqual(expected(2));
    }
    // One run beside the cap: the line's two baselines tie, and the first
    // line's higher one wins over the cap's.
    expect(runOrder([
      line(72, 462, ['O', 24]),
      line(84, 474, ['pen the report.', 12]),
      line(83, 462, ['Then review the chart.', 12]),
    ])).toEqual(['O', 'pen the report.', 'Then review the chart.']);
  });

  test('keeps text clipped by the top page edge in order', () => {
    // Only the largest run's top is clamped to the page edge.
    expect(runOrder([line(72, 781, ['Chapter ', 10], ['3 ', 11], ['Results', 13])])).toEqual(['Chapter ', '3 ', 'Results']);

    // A clamped box no longer locates its baseline: this smaller line sits
    // where the clipped line's box would put it.
    expect(runOrder([
      line(100, 791, ['Clipped header', 12]),
      line(72, 781.14, ['Small line below.', 8]),
    ])).toEqual(['Clipped header', 'Small line below.']);
  });
});
