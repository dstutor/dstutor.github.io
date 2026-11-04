import { describe, expect, it } from 'vitest';
import { evaluatePolars, parsePolars } from './polarsDemo';

// Expected results come from running each cell with polars 1.33.1 on Python 3.14 (the versions the
// polars tutor loads in Pyodide), on the same cones table as the hero.
const DATA: Record<string, (string | number)[]> = {
  Flavor: ['strawberry', 'chocolate', 'vanilla', 'chocolate', 'strawberry', 'mint'],
  Color: ['pink', 'light brown', 'white', 'dark brown', 'pink', 'green'],
  Price: [3.55, 4.75, 4.25, 5.25, 3.95, 4.5],
};

function run(code: string) {
  const parsed = parsePolars(code, Object.keys(DATA));
  if (parsed.kind === 'error') return { error: parsed.message };
  if (parsed.kind !== 'query') return { kind: parsed.kind };
  const values = DATA[parsed.label];
  const result = evaluatePolars(parsed.op, parsed.value, { label: parsed.label, values, shown: values.map(String) });
  return 'error' in result ? { error: result.error } : { kept: result.keep };
}

const CASES: [string, object][] = [
  ["chocolate = cones.filter(pl.col('Flavor') == 'chocolate')", { kept: [false, true, false, true, false, false] }],
  ["cones.filter(pl.col('Flavor') != 'chocolate')", { kept: [true, false, true, false, true, true] }],
  ["cones.filter(pl.col('Price') > 4.5)", { kept: [false, true, false, true, false, false] }],
  ["cones.filter(pl.col('Price') <= 4.25)", { kept: [true, false, true, false, true, false] }],
  ["cones.filter(pl.col('Price') >= 4.5)", { kept: [false, true, false, true, false, true] }],
  ["cones.filter(pl.col('Price') < 4)", { kept: [true, false, false, false, true, false] }],
  ["cones.filter(pl.col('Price') > 4)", { kept: [false, true, true, true, false, true] }],
  ["cones.filter(pl.col('Color') == 'pink')", { kept: [true, false, false, false, true, false] }],
  ["cones.filter((pl.col('Flavor') >= 'n'))", { kept: [true, false, true, false, true, false] }],
  ["cones.filter(pl.col('Price') == 4.5)", { kept: [false, false, false, false, false, true] }],
  ["cones.filter(pl.col('Price') == 5.25)", { kept: [false, false, false, true, false, false] }],
  ['cones.filter(pl.col("Flavor") == "mint")', { kept: [false, false, false, false, false, true] }],
  ["cones.filter(pl.col('Price') > True)", { kept: [true, true, true, true, true, true] }],
  ["cones.filter(pl.col('Price') == True)", { kept: [false, false, false, false, false, false] }],
  ["cones.filter(pl.col('Flavor') == True)", { kept: [false, false, false, false, false, false] }],
  ["cones.filter(pl.col('Flavor') != True)", { kept: [true, true, true, true, true, true] }],
  ["cones.filter(pl.col('Flavor') > True)", { kept: [false, false, true, false, false, false] }],
  ["cones.filter(pl.col('Flavor') > False)", { kept: [true, false, true, false, true, true] }],
  ["cones.filter(pl.col('Price') > 3000000000)", { kept: [false, false, false, false, false, false] }],
  ["cones.filter(pl.col('Price') == 'x')", { error: 'polars.exceptions.ComputeError: cannot compare string with numeric type (f64)' }],
  ["cones.filter(pl.col('Price') > 'x')", { error: 'polars.exceptions.ComputeError: cannot compare string with numeric type (f64)' }],
  ["cones.filter(pl.col('Flavor') == 4)", { error: 'polars.exceptions.ComputeError: cannot compare string with numeric type (i32)' }],
  ["cones.filter(pl.col('Flavor') != 4)", { error: 'polars.exceptions.ComputeError: cannot compare string with numeric type (i32)' }],
  ["cones.filter(pl.col('Flavor') > 4)", { error: 'polars.exceptions.ComputeError: cannot compare string with numeric type (i32)' }],
  ["cones.filter(pl.col('Flavor') < 1.5)", { error: 'polars.exceptions.ComputeError: cannot compare string with numeric type (f64)' }],
  ["cones.filter(pl.col('Flavor') == 3000000000)", { error: 'polars.exceptions.ComputeError: cannot compare string with numeric type (i64)' }],
  [
    "cones.filter(pl.col('flavor') == 'mint')",
    { error: 'polars.exceptions.ColumnNotFoundError: unable to find column "flavor"; valid columns: ["Flavor", "Color", "Price"]' },
  ],
  ["cones.filter(pl.col('Flavor') == chocolate)", { error: "NameError: name 'chocolate' is not defined" }],
  // Python looks up names before polars looks for the column
  ["cones.filter(pl.col('flavor') == chocolate)", { error: "NameError: name 'chocolate' is not defined" }],
  ["conez.filter(pl.col('Flavor') == 'x')", { error: "NameError: name 'conez' is not defined" }],
];

describe('the hero cell matches polars', () => {
  it.each(CASES)('%s', (code, expected) => {
    expect(run(code)).toEqual(expected);
  });

  it('hands anything else to the tutor', () => {
    expect(run("cones.sort('Price')")).toEqual({ kind: 'unsupported' });
    expect(run("cones.filter(pl.col('Price') > 4).filter(pl.col('Price') < 5)")).toEqual({ kind: 'unsupported' });
    expect(run("cones.filter((pl.col('Price') > 4) & (pl.col('Price') < 5))")).toEqual({ kind: 'unsupported' });
    expect(run('import polars as pl')).toEqual({ kind: 'empty' });
  });

  it('says True or False for every row', () => {
    const parsed = parsePolars("cones.filter(pl.col('Flavor') == 'chocolate')", Object.keys(DATA));
    if (parsed.kind !== 'query') throw new Error(parsed.kind);
    const result = evaluatePolars(parsed.op, parsed.value, { label: 'Flavor', values: DATA.Flavor, shown: DATA.Flavor.map(String) });
    expect('reasons' in result && result.reasons.slice(0, 2)).toEqual([
      "'strawberry' == 'chocolate' is False",
      "'chocolate' == 'chocolate' is True",
    ]);
  });
});
