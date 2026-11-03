import { describe, expect, it } from 'vitest';
import { evaluate, parseCell, type Column } from './whereDemo';

// Expected results come from running each cell with datascience 0.18.1 on Python 3.14
// (the versions the tutor loads in Pyodide), on the same cones table as the hero.
const DATA: Record<string, (string | number)[]> = {
  Flavor: ['strawberry', 'chocolate', 'vanilla', 'chocolate', 'strawberry', 'mint'],
  Color: ['pink', 'light brown', 'white', 'dark brown', 'pink', 'green'],
  Price: [3.55, 4.75, 4.25, 5.25, 3.95, 4.5],
};
const LABELS = Object.keys(DATA);

function run(code: string) {
  const parsed = parseCell(code, LABELS);
  if (parsed.kind === 'error') return { error: parsed.message };
  if (parsed.kind !== 'query') return { kind: parsed.kind };
  const values = DATA[parsed.query.label];
  const column: Column = { label: parsed.query.label, values, shown: values.map(String) };
  const result = evaluate(parsed.query, column);
  return 'error' in result ? { error: result.error } : { kept: result.keep };
}

const CASES: [string, object][] = [
  ["chocolate = cones.where('Flavor', 'chocolate')", { kept: [false, true, false, true, false, false] }],
  ["cones.where('Flavor', \"mint\")", { kept: [false, false, false, false, false, true] }],
  ["cones.where('Price', 4.75)", { kept: [false, true, false, false, false, false] }],
  ["cones.where('Price', 4.5)", { kept: [false, false, false, false, false, true] }],
  ["cones.where('Price', are.above(4.5))", { kept: [false, true, false, true, false, false] }],
  ["cones.where('Price', are.below(4))", { kept: [true, false, false, false, true, false] }],
  ["cones.where('Price', are.above_or_equal_to(4.5))", { kept: [false, true, false, true, false, true] }],
  ["cones.where('Price', are.below_or_equal_to(4.25))", { kept: [true, false, true, false, true, false] }],
  ["cones.where('Price', are.between(4, 4.75))", { kept: [false, false, true, false, false, true] }],
  ["cones.where('Price', are.strictly_between(3.55, 4.75))", { kept: [false, false, true, false, true, true] }],
  ["cones.where('Price', are.between_or_equal_to(3.55, 4.75))", { kept: [true, true, true, false, true, true] }],
  ["cones.where('Flavor', are.containing('berry'))", { kept: [true, false, false, false, true, false] }],
  ["cones.where('Color', are.contained_in('dark brown and pink'))", { kept: [true, false, false, true, true, false] }],
  ["cones.where('Flavor', are.not_equal_to('chocolate'))", { kept: [true, false, true, false, true, true] }],
  ["cones.where('Price', are.not_above(4.25))", { kept: [true, false, true, false, true, false] }],
  ["cones.where('Flavor', are.not_containing('o'))", { kept: [true, false, true, false, true, true] }],
  ["cones.where(0, 'vanilla')", { kept: [false, false, true, false, false, false] }],
  ["cones.where(column_or_label='Color', value_or_predicate='pink')", { kept: [true, false, false, false, true, false] }],
  ["cones.where('flavor', 'chocolate')", { error: "ValueError: label \"flavor\" not in labels ('Flavor', 'Color', 'Price')" }],
  ["cones.where('Flavor', chocolate)", { error: "NameError: name 'chocolate' is not defined" }],
  ["cones.where('Flavor', are.above(4))", { error: "TypeError: '>' not supported between instances of 'numpy.str_' and 'int'" }],
  ["cones.where('Price', are.containing('4'))", { error: "TypeError: argument of type 'numpy.float64' is not a container or iterable" }],
  ["cones.where('Price', are.above(1, 2))", { error: "TypeError: are.above() takes 1 positional argument but 2 were given" }],
  ["cones.where('Price', are.bigger(1))", { error: "AttributeError: type object 'are' has no attribute 'bigger'" }],
  ["conez.where('Price', 4)", { error: "NameError: name 'conez' is not defined" }],
  ["cones.where()", { error: "TypeError: Table.where() missing 1 required positional argument: 'column_or_label'" }],
  ["cones.where('Price', are.above('x'))", { error: "UFuncTypeError: ufunc 'greater' did not contain a loop with signature matching types (<class 'numpy.dtypes.Float64DType'>, <class 'numpy.dtypes.StrDType'>) -> None" }],
  ["cones.where('Flavor', are.containing(4))", { error: "TypeError: 'in <string>' requires string as left operand, not int" }],
  ["cones.where('Price', are.contained_in(4))", { error: "TypeError: argument of type 'int' is not a container or iterable" }],
  ["cones.where('Flavor', are.contained_in('chocolate mint'))", { kept: [false, true, false, true, false, true] }],
  ["cones.where('Price', are.not_between(4, 5))", { kept: [true, false, false, true, true, false] }],
  ["cones.where('Price', True)", { kept: [false, false, false, false, false, false] }],
  ["cones.where('Flavor', 'chocolate'", { error: "SyntaxError: '(' was never closed" }],
];

describe('the hero cell matches datascience', () => {
  it.each(CASES)('%s', (code, expected) => {
    expect(run(code)).toEqual(expected);
  });

  it('hands anything else to the tutor', () => {
    expect(run('cones.sort("Price")')).toEqual({ kind: 'unsupported' });
    expect(run('x = 1\ncones.where("Price", x)')).toEqual({ kind: 'unsupported' });
    expect(run('# just a comment\nfrom datascience import *')).toEqual({ kind: 'empty' });
  });

  it('describes each row the way the step does', () => {
    const parsed = parseCell("cones.where('Price', are.above(4.5))", LABELS);
    if (parsed.kind !== 'query') throw new Error(parsed.kind);
    const result = evaluate(parsed.query, { label: 'Price', values: DATA.Price, shown: ['3.55', '4.75', '4.25', '5.25', '3.95', '4.50'] });
    expect('reasons' in result && result.reasons.slice(0, 2)).toEqual(["3.55 isn't above 4.5", '4.75 is above 4.5']);
  });
});
