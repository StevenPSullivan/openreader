import { describe, expect, test } from 'vitest';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { mergeTextWithRegions } from '../../../src/inference/pdf/document-layout';
import { normalizeTextItemsForLayout } from '../../../src/inference/pdf/normalize-text';

type Run = [text: string, size: number, rise?: number];

// Runs set left to right from x on one PDF baseline, as pdf.js reports them.
function line(x: number, baseline: number, ...runs: Run[]) {
  return runs.map(([str, size, rise = 0]) => {
    const width = str.length * size * 0.5;
    const item = { str, transform: [size, 0, 0, size, x, baseline + rise], width, fontName: 'f' };
    x += width;
    return item as unknown as TextItem;
  });
}

// Places runs on a US Letter page the way the parser does at its 1.5 render scale.
function readAtRenderScale(...lines: TextItem[][]) {
  const scale = 1.5;
  const items = normalizeTextItemsForLayout(lines.flat(), { height: 792, transform: [1, 0, 0, -1, 0, 792] }, {
    f: { ascent: 0.905, descent: -0.212 },
  }).map((item) => ({
    ...item,
    x: item.x * scale,
    y: item.y * scale,
    width: item.width * scale,
    height: item.height * scale,
  }));
  return mergeTextWithRegions([{ bbox: [0, 0, 612 * scale, 792 * scale], label: 'text' }], items);
}

describe('PDF line reading order', () => {
  test('reads a smaller citation in place on its line', () => {
    const merged = readAtRenderScale(
      line(72, 686, ['Sentence one ', 12], ['(Smith 2020.)', 8], [' Sentence two.', 12]),
      line(72, 672, ['The next line follows.', 12]),
    );
    expect(merged.map((block) => block.text)).toEqual(['Sentence one (Smith 2020.) Sentence two. The next line follows.']);
  });

  test('reads a larger value in place, row by row', () => {
    const row = (baseline: number, cells: string[]) => cells.flatMap((cell, column) => (
      line([72, 172, 292, 372][column]!, baseline, [cell, column === 3 ? 15 : 11])
    ));
    const merged = readAtRenderScale(
      row(690, ['Alder', '38 degrees', 'Left', '40 psi']),
      row(662, ['Birch', '41 degrees', 'Right', '45 psi']),
    );
    expect(merged.map((block) => block.text)).toEqual(['Alder 38 degrees Left 40 psi Birch 41 degrees Right 45 psi']);
  });

  test('reads superscript and subscript markers in place', () => {
    const merged = readAtRenderScale(
      line(72, 626, ['Then I', 12], ['1', 6, 4], [' went back.', 12]),
      line(72, 612, ['Water is H', 12], ['2', 6, -2], ['O today.', 12]),
    );
    expect(merged.map((block) => block.text)).toEqual(['Then I1 went back. Water is H2O today.']);
  });

  test('reads same-size words with uneven baselines left to right', () => {
    const merged = readAtRenderScale(line(72, 700, ['Uneven ', 12, 1.5], ['baselines ', 12, -1.5], ['stay in order.', 12, 1.5]));
    expect(merged.map((block) => block.text)).toEqual(['Uneven baselines stay in order.']);
  });

  test('keeps adjacent lines apart', () => {
    const merged = readAtRenderScale(
      line(100, 580, ['Solid leading one.', 12]),
      line(72, 568, ['Solid leading two.', 12]),
      line(100, 544, ['A small note above.', 8]),
      line(72, 530, ['A larger line.', 16]),
      line(100, 520, ['A small note below.', 8]),
    );
    expect(merged.map((block) => block.text)).toEqual([
      'Solid leading one. Solid leading two. A small note above. A larger line. A small note below.',
    ]);
  });

  test('keeps a multi-line drop cap with its first line', () => {
    // The cap sits on the third baseline, level with the first line's top and
    // centred on the second line. One cap starts just above that top, the other
    // just below it.
    for (const capSize of [43, 42.8]) {
      const merged = readAtRenderScale(
        line(72, 446, ['O', capSize]),
        line(72 + capSize * 0.5, 474, ['nce the rain ', 12], ['stopped.', 12]),
        line(72 + capSize * 0.5, 460, ['Everyone followed ', 12], ['the track.', 12]),
        line(72 + capSize * 0.5, 446, ['The shops ', 12], ['were open.', 12]),
        line(72, 432, ['Back at the margin.', 12]),
      );
      expect(merged.map((block) => block.text)).toEqual([
        'Once the rain stopped. Everyone followed the track. The shops were open. Back at the margin.',
      ]);
    }
  });

  test('keeps text clipped by the top page edge in order', () => {
    // The larger run's top is clamped to the page edge; the smaller run's is not.
    const edge = readAtRenderScale(line(72, 781, ['Chapter 3 ', 12], ['Results', 16]));
    expect(edge[0]?.items.map((item) => item.text)).toEqual(['Chapter 3 ', 'Results']);

    // A line mostly above the page edge stays before the line below it.
    const clipped = readAtRenderScale(
      line(100, 791, ['Clipped header', 12]),
      line(72, 777, ['Body text starts here.', 12]),
    );
    expect(clipped[0]?.items.map((item) => item.text)).toEqual(['Clipped header', 'Body text starts here.']);
  });
});
