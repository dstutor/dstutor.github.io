import { describe, expect, it } from 'vitest';
import { evaluatePandas, parsePandas } from './pandasDemo';

// Expected results come from running each cell with pandas 3.0.2 on Python 3.14 (the versions the
// pandas tutor loads in Pyodide), on the same cones table as the hero.
const DATA: Record<string, (string | number)[]> = {
  Flavor: ['strawberry', 'chocolate', 'vanilla', 'chocolate', 'strawberry', 'mint'],
  Color: ['pink', 'light brown', 'white', 'dark brown', 'pink', 'green'],
  Price: [3.55, 4.75, 4.25, 5.25, 3.95, 4.5],
};

function run(code: string) {
  const parsed = parsePandas(code, Object.keys(DATA));
  if (parsed.kind === 'error') return { error: parsed.message };
  if (parsed.kind !== 'query') return { kind: parsed.kind };
  const values = DATA[parsed.label];
  const result = evaluatePandas(parsed.op, parsed.value, { label: parsed.label, values, shown: values.map(String) });
  return 'error' in result ? { error: result.error } : { kept: result.keep };
}

const CASES: [string, object][] = [
  ["chocolate = cones[cones['Flavor'] == 'chocolate']", {"kept": [false, true, false, true, false, false]}],
  ["cones[cones['Flavor'] != 'chocolate']", {"kept": [true, false, true, false, true, true]}],
  ["cones[cones['Price'] > 4.5]", {"kept": [false, true, false, true, false, false]}],
  ["cones[cones['Price'] <= 4.25]", {"kept": [true, false, true, false, true, false]}],
  ["cones[cones['Price'] >= 4.5]", {"kept": [false, true, false, true, false, true]}],
  ["cones[cones['Price'] < 4]", {"kept": [true, false, false, false, true, false]}],
  ["cones[cones.Color == 'pink']", {"kept": [true, false, false, false, true, false]}],
  ["cones[(cones['Flavor'] >= 'n')]", {"kept": [true, false, true, false, true, false]}],
  ["cones[cones['Price'] == 'x']", {"kept": [false, false, false, false, false, false]}],
  ["cones[cones['Flavor'] != 4]", {"kept": [true, true, true, true, true, true]}],
  ["cones[cones['Price'] == 4.5]", {"kept": [false, false, false, false, false, true]}],
  ["cones[cones['flavor'] == 'mint']", {"error": "KeyError: 'flavor'"}],
  ["cones[cones.flavor == 'mint']", {"error": "AttributeError: 'DataFrame' object has no attribute 'flavor'"}],
  ["cones[cones['Price'] > 'x']", {"error": "TypeError: Invalid comparison between dtype=float64 and str"}],
  ["cones[cones['Flavor'] > 4]", {"error": "TypeError: '>' not supported between instances of 'str' and 'int'"}],
  ["cones[cones['Flavor'] < 1.5]", {"error": "TypeError: '<' not supported between instances of 'str' and 'float'"}],
  ["cones[cones['Flavor'] == chocolate]", {"error": "NameError: name 'chocolate' is not defined"}],
  ["conez[cones['Flavor'] == 'x']", {"error": "NameError: name 'conez' is not defined"}],
  ["cones[conez['Flavor'] == 'x']", {"error": "NameError: name 'conez' is not defined"}],
  ["cones[cones['Price'] > True]", {"kept": [true, true, true, true, true, true]}],
  ["cones[cones[\"Flavor\"] == \"mint\"]", {"kept": [false, false, false, false, false, true]}],
];

describe('the hero cell matches pandas', () => {
  it.each(CASES)('%s', (code, expected) => {
    expect(run(code)).toEqual(expected);
  });

  it('hands anything else to the tutor', () => {
    expect(run("cones.sort_values('Price')")).toEqual({ kind: 'unsupported' });
    expect(run("cones[cones['Price'] > 4][cones['Price'] < 5]")).toEqual({ kind: 'unsupported' });
    expect(run('import pandas as pd')).toEqual({ kind: 'empty' });
  });

  it('says True or False for every row', () => {
    const parsed = parsePandas("cones[cones['Flavor'] == 'chocolate']", Object.keys(DATA));
    if (parsed.kind !== 'query') throw new Error(parsed.kind);
    const result = evaluatePandas(parsed.op, parsed.value, { label: 'Flavor', values: DATA.Flavor, shown: DATA.Flavor.map(String) });
    expect('reasons' in result && result.reasons.slice(0, 2)).toEqual([
      "'strawberry' == 'chocolate' is False",
      "'chocolate' == 'chocolate' is True",
    ]);
  });
});
