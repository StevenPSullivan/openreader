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
    // A font without metrics, so its full height sits above the baseline.
    tall: {},
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

    // A citation just under where the line above ends is not that line's marker.
    expect(runOrder([inFont('tall', [
      ...line(72, 768.76, ['First line ends here', 12.99, 0, 86.7]), ...line(72, 756.28, ['Second line', 12.99, 0, 79.9]),
      ...line(156.2, 756.28, ['(cite)', 8.72, 0, 27.8]), ...line(184.8, 756.28, ['ends.', 12.99, 0, 33.5]),
    ])])).toEqual(['First line ends here', 'Second line', '(cite)', 'ends.']);

    // A label and a slightly smaller value whose font puts its top higher.
    const [label, value] = line(72, 600, ['Pressure ', 24], ['50 psi', 23.5]);
    expect(runOrder([[label!], inFont('tall', [value!])])).toEqual(['Pressure ', '50 psi']);

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

    // A larger value on the next row whose top is level with this row's.
    expect(readAtRenderScale([
      line(72, 513, ['Alder', 11]), line(200, 513, ['North', 12]),
      line(130, 500, ['50', 24]), line(200, 500, ['South', 12]),
    ], 'table')[0]!.items.map((item) => item.text)).toEqual(['Alder', 'North', '50', 'South']);

    // A mixed-size upper row, and a lower-row value whose top matches two of its
    // cells. The value's box reaches into the upper row, as a run spanning two
    // lines does, so nothing moves across it; the upper row still reads in order.
    const reachingValue = readAtRenderScale([
      line(72, 513, ['Alder', 12]), line(192, 513, ['North', 10]), line(312, 513, ['Active', 12]),
      line(72, 501, ['Birch', 12]), line(230, 501, ['50', 24]), line(312, 501, ['Closed', 12]),
    ], 'table')[0]!.items.map((item) => item.text);
    expect(reachingValue.slice(0, 3)).toEqual(['Alder', 'North', 'Active']);
    expect([...reachingValue.slice(3)].sort()).toEqual(['50', 'Birch', 'Closed']);

    // On an 11 pt row pitch the top order already puts that value inside the
    // upper row; the lower row's other cells still stay out of it.
    const tight = readAtRenderScale([
      line(72, 513, ['Alder', 12]), line(192, 513, ['North', 10]), line(312, 513, ['Active', 12]),
      line(72, 502, ['Birch', 12]), line(230, 502, ['50', 24]), line(312, 502, ['Closed', 12]),
    ], 'table')[0]!.items.map((item) => item.text);
    const upperRow = ['Alder', 'North', 'Active'].map((cell) => tight.indexOf(cell));
    expect(upperRow).toEqual([...upperRow].sort((a, b) => a - b));
    expect(Math.min(tight.indexOf('Birch'), tight.indexOf('Closed'))).toBeGreaterThan(Math.max(...upperRow));

    // A large cell above a smaller one in its column does not make that cell a marker.
    const tableOf = (lines: TextItem[][]) => readAtRenderScale(lines, 'table')[0]!.items.map((item) => item.text);
    expect(tableOf([inFont('low', [
      ...line(72, 501.43, ['Label one', 7.89, 0, 53.4]), ...line(298.9, 501.43, ['BIG', 16.45, 0, 59.8]),
      ...line(72, 489.63, ['Label two', 7.89, 0, 31.2]), ...line(298.9, 489.63, ['Value', 13.22, 0, 54.1]),
    ])])).toEqual(['Label one', 'BIG', 'Label two', 'Value']);

    // A word followed by a subscript is not a marker, so the unit before it still moves.
    expect(tableOf([inFont('low', [
      ...line(72, 512.47, ['Value', 9.33, 0, 103.8]), ...line(178.2, 512.47, ['unit', 5.64, 0, 18]),
      ...line(196.5, 512.47, ['Word', 9.33, 0, 74.7]), ...line(271.5, 509.52, ['sub', 4.91, 0, 2.9]),
    ])])).toEqual(['Value', 'unit', 'Word', 'sub']);

    // Larger headings above rows of smaller labels and values.
    expect(readAtRenderScale([
      line(72, 640, ['Station heading', 15]), line(232, 640, ['Pressure heading', 15]),
      line(72, 620, ['Alder', 10]), line(232, 620, ['40 psi', 12]),
      line(72, 604, ['Birch', 10]), line(232, 604, ['45 psi', 12]),
    ], 'table')[0]!.items.map((item) => item.text))
      .toEqual(['Station heading', 'Pressure heading', 'Alder', '40 psi', 'Birch', '45 psi']);

    // Larger lower-row cells whose boxes reach into a smaller upper row.
    const reaching = readAtRenderScale([
      line(72, 513, ['Alder', 8]), line(192, 513, ['North', 8]), line(312, 513, ['Active', 8]),
      line(72, 501, ['Birch', 18]), line(230, 501, ['50', 20]), line(312, 501, ['Closed', 18]),
    ], 'table')[0]!.items.map((item) => item.text);
    expect(Math.min(reaching.indexOf('Birch'), reaching.indexOf('Closed')))
      .toBeGreaterThan(Math.max(...['Alder', 'North', 'Active'].map((cell) => reaching.indexOf(cell))));
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

    // A large run at the right spanning two lines, on the second line's baseline.
    expect(runOrder([
      line(72, 600, ['First line text', 12]),
      line(450, 586, ['27', 27.5]),
      line(72, 586, ['Second ', 12], ['line.', 12]),
    ])).toEqual(['First line text', '27', 'Second ', 'line.']);
    // The same when the second line starts with a larger value, whose top is higher.
    expect(runOrder([inFont('tall', [
      ...line(72, 701.21, ['First', 11.61, 0, 45.8]), ...line(507, 691.42, ['27', 21.28, 0, 24.6]),
      ...line(72, 691.42, ['40 psi', 15.64, 0, 43.3]), ...line(117.6, 691.42, ['then', 11.61, 0, 72.3]),
    ])])).toEqual(['First', '27', '40 psi', 'then']);
  });

  test('keeps raised and lowered markers from linking lines', () => {
    // A subscript and the next line's smaller superscript on one baseline.
    expect(runOrder([
      line(72, 600, ['Hydrogen is H', 12], ['2', 8, -4]),
      line(72, 590, ['Volume is m', 12], ['3', 6, 6]),
    ])).toEqual(['Hydrogen is H', '2', 'Volume is m', '3']);
    // On 12 pt leading the two markers sort next to each other; neither moves the other.
    const adjacent = runOrder([
      line(72, 600, ['Hydrogen is H', 12], ['2', 8, -4]),
      line(72, 588, ['Volume is m', 12], ['3', 6, 8]),
    ]);
    expect(adjacent.indexOf('2')).toBeLessThan(adjacent.indexOf('3'));
    // A lower row's superscript raised onto the upper row's baseline stays with its word.
    const raised = readAtRenderScale([
      line(72, 515.7, ['Alpha', 8]), line(296, 515.7, ['Gamma', 8]),
      line(72, 509.15, ['Delta', 10]), line(97, 515.63, ['2', 5.3]),
    ], 'table')[0]!.items.map((item) => item.text);
    expect(raised.indexOf('2')).toBeGreaterThan(raised.indexOf('Gamma'));
    // A lower row's superscript raised near, not onto, the upper row's baseline.
    const near = readAtRenderScale([inFont('low', [
      ...line(72, 504.62, ['Upper one', 8.5, 0, 91.4]), ...line(166.2, 504.62, ['Upper two', 8.5, 0, 92.2]),
      ...line(72, 493.32, ['Lower one', 8.5, 0, 41.5]), ...line(115.6, 493.32, ['Lower two', 8.5, 0, 43.9]),
      ...line(159.2, 502.35, ['sup', 4.52, 0, 2.7]), ...line(164, 493.32, ['Lower three', 8.5, 0, 32.4]),
    ])], 'table')[0]!.items.map((item) => item.text);
    expect(near.indexOf('sup')).toBeGreaterThan(near.indexOf('Upper two'));
    // A superscript on another line's subscript baseline does not move past it.
    const onSubscript = readAtRenderScale([inFont('tall', [
      ...line(140, 547.71, ['Row three', 8.63, 0, 91.5]), ...line(231.7, 545.29, ['sub', 6.15, 0, 7.4]),
      ...line(72, 534.9, ['Row four', 8.63, 0, 33.4]), ...line(106.1, 545.29, ['sup', 4.54, 0, 5.4]),
      ...line(113.8, 534.9, ['rest', 8.63, 0, 69.9]),
    ])], 'table')[0]!.items.map((item) => item.text);
    expect(onSubscript.indexOf('sub')).toBeLessThan(onSubscript.indexOf('sup'));
    // The same pair in a table whose other cells share the subscript's size.
    const inTable = readAtRenderScale([
      line(300, 640, ['Laboratory sample values', 8]), line(300, 628, ['Measured at the north station', 8]),
      line(72, 600, ['Hydrogen is H', 12], ['2', 8, -4]),
      line(72, 588, ['Volume is m', 12], ['3', 6, 8]),
    ], 'table')[0]!.items.map((item) => item.text);
    expect(inTable.indexOf('2')).toBeLessThan(inTable.indexOf('3'));

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
