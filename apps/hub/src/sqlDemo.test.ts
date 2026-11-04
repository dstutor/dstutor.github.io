import { describe, expect, it } from 'vitest';
import { candidateBindings, evaluateSql, parseSql } from './sqlDemo';

const DATA: Record<string, (string | number)[]> = {
  Flavor: ['strawberry', 'chocolate', 'vanilla', 'chocolate', 'strawberry', 'mint'],
  Color: ['pink', 'light brown', 'white', 'dark brown', 'pink', 'green'],
  Price: [3.55, 4.75, 4.25, 5.25, 3.95, 4.5],
};

function run(code: string) {
  const parsed = parseSql(code, Object.keys(DATA));
  if (parsed.kind === 'error') return { error: parsed.message };
  if (parsed.kind !== 'query') return { kind: parsed.kind };
  const values = DATA[parsed.label];
  const result = evaluateSql(parsed.op, parsed.value, { label: parsed.label, values, shown: values.map(String) }, parsed.where);
  return 'error' in result ? { error: result.error } : { kept: result.keep };
}

// Generated from DuckDB 1.5.1 (CPython 3.14; Pyodide gives the same): each query run on the
// hero's cones table, with the rows it kept or the error it raised.
const CASES: [string, { kept: boolean[] } | { error: string }][] = [
  ["-- DuckDB SQL\nSELECT * FROM cones WHERE Flavor = 'chocolate'", {"kept": [false, true, false, true, false, false]}],
  ["select * from cones where flavor = 'chocolate';", {"kept": [false, true, false, true, false, false]}],
  ["SELECT * FROM CONES WHERE COLOR = 'pink'", {"kept": [true, false, false, false, true, false]}],
  ["SELECT * FROM cones WHERE \"flavor\" = 'mint'", {"kept": [false, false, false, false, false, true]}],
  ["SELECT * FROM cones WHERE Flavor == 'mint'", {"kept": [false, false, false, false, false, true]}],
  ["SELECT * FROM cones WHERE Flavor != 'chocolate'", {"kept": [true, false, true, false, true, true]}],
  ["SELECT * FROM cones WHERE Flavor <> 'chocolate'", {"kept": [true, false, true, false, true, true]}],
  ["SELECT * FROM cones WHERE Flavor = 'Chocolate'", {"kept": [false, false, false, false, false, false]}],
  ["SELECT * FROM cones WHERE Flavor >= 'n'", {"kept": [true, false, true, false, true, false]}],
  ["SELECT * FROM cones WHERE Color = 'light brown'", {"kept": [false, true, false, false, false, false]}],
  ["SELECT * FROM cones WHERE Flavor = 'it''s'", {"kept": [false, false, false, false, false, false]}],
  ["SELECT * FROM cones WHERE Flavor='mint'", {"kept": [false, false, false, false, false, true]}],
  ["SELECT * FROM cones WHERE Price > 4.5", {"kept": [false, true, false, true, false, false]}],
  ["SELECT * FROM cones WHERE Price <= 4.25", {"kept": [true, false, true, false, true, false]}],
  ["SELECT * FROM cones WHERE Price >= 4.5", {"kept": [false, true, false, true, false, true]}],
  ["SELECT * FROM cones WHERE Price < 4", {"kept": [true, false, false, false, true, false]}],
  ["SELECT * FROM cones WHERE Price>4", {"kept": [false, true, true, true, false, true]}],
  ["SELECT * FROM cones WHERE Price = 4.50", {"kept": [false, false, false, false, false, true]}],
  ["SELECT * FROM cones WHERE Price <= 4.250", {"kept": [true, false, true, false, true, false]}],
  ["SELECT * FROM cones WHERE Price > 4.", {"kept": [false, true, true, true, false, true]}],
  ["SELECT * FROM cones WHERE Price > .5", {"kept": [true, true, true, true, true, true]}],
  ["SELECT * FROM cones WHERE Price > 1e2", {"kept": [false, false, false, false, false, false]}],
  ["SELECT * FROM cones WHERE Price > 99999999999", {"kept": [false, false, false, false, false, false]}],
  ["SELECT * FROM cones WHERE Price > '4.5'", {"kept": [false, true, false, true, false, false]}],
  ["SELECT * FROM cones WHERE Price = ' 4.5'", {"kept": [false, false, false, false, false, true]}],
  ["SELECT * FROM cones WHERE Price = TRUE", {"kept": [false, false, false, false, false, false]}],
  ["SELECT * FROM cones WHERE Price <> TRUE", {"kept": [true, true, true, true, true, true]}],
  ["SELECT * FROM cones WHERE Price != FALSE", {"kept": [true, true, true, true, true, true]}],
  ["SELECT * FROM cones WHERE Price = NULL", {"kept": [false, false, false, false, false, false]}],
  ["SELECT * FROM cones WHERE Flavor != NULL", {"kept": [false, false, false, false, false, false]}],
  ["SELECT * FROM cones WHERE Price > 4 ;", {"kept": [false, true, true, true, false, true]}],
  ["SELECT * FROM cones WHERE Price > TRUE", {"error": "Binder Error: Cannot compare values of type DOUBLE and type BOOLEAN - an explicit cast is required\n\nLINE 1: SELECT * FROM cones WHERE Price > TRUE\n                                        ^"}],
  ["SELECT * FROM cones WHERE Price > 'x'", {"error": "Conversion Error: Could not convert string 'x' to DOUBLE\n\nLINE 1: SELECT * FROM cones WHERE Price > 'x'\n                                          ^"}],
  ["SELECT * FROM cones WHERE Price = 'x'", {"error": "Conversion Error: Could not convert string 'x' to DOUBLE\n\nLINE 1: SELECT * FROM cones WHERE Price = 'x'\n                                          ^"}],
  ["SELECT * FROM cones WHERE Price > '4.5x'", {"error": "Conversion Error: Could not convert string '4.5x' to DOUBLE\n\nLINE 1: SELECT * FROM cones WHERE Price > '4.5x'\n                                          ^"}],
  ["SELECT * FROM cones WHERE Price > ''", {"error": "Conversion Error: Could not convert string '' to DOUBLE\n\nLINE 1: SELECT * FROM cones WHERE Price > ''\n                                          ^"}],
  ["SELECT * FROM cones WHERE Flavor = 4", {"error": "Conversion Error: Could not convert string 'strawberry' to INT32 when casting from source column Flavor\n\nLINE 1: SELECT * FROM cones WHERE Flavor = 4\n                                  ^"}],
  ["SELECT * FROM cones WHERE Flavor <> 4", {"error": "Conversion Error: Could not convert string 'strawberry' to INT32 when casting from source column Flavor\n\nLINE 1: SELECT * FROM cones WHERE Flavor <> 4\n                                  ^"}],
  ["SELECT * FROM cones WHERE Flavor > 4", {"error": "Binder Error: Cannot compare values of type VARCHAR and type INTEGER_LITERAL - an explicit cast is required\n\nLINE 1: SELECT * FROM cones WHERE Flavor > 4\n                                         ^"}],
  ["SELECT * FROM cones WHERE Flavor < 4", {"error": "Binder Error: Cannot compare values of type VARCHAR and type INTEGER_LITERAL - an explicit cast is required\n\nLINE 1: SELECT * FROM cones WHERE Flavor < 4\n                                         ^"}],
  ["SELECT * FROM cones WHERE Flavor = 99999999999", {"error": "Conversion Error: Could not convert string 'strawberry' to INT64 when casting from source column Flavor\n\nLINE 1: SELECT * FROM cones WHERE Flavor = 99999999999\n                                  ^"}],
  ["SELECT * FROM cones WHERE Flavor = 1.5", {"error": "Conversion Error: Could not convert string \"strawberry\" to DECIMAL(2,1) when casting from source column Flavor\n\nLINE 1: SELECT * FROM cones WHERE Flavor = 1.5\n                                  ^"}],
  ["SELECT * FROM cones WHERE Flavor <> 1.5", {"error": "Conversion Error: Could not convert string \"strawberry\" to DECIMAL(2,1) when casting from source column Flavor\n\nLINE 1: SELECT * FROM cones WHERE Flavor <> 1.5\n                                  ^"}],
  ["SELECT * FROM cones WHERE Flavor = 4.0", {"error": "Conversion Error: Could not convert string \"strawberry\" to DECIMAL(2,1) when casting from source column Flavor\n\nLINE 1: SELECT * FROM cones WHERE Flavor = 4.0\n                                  ^"}],
  ["SELECT * FROM cones WHERE Flavor > 1.5", {"error": "Binder Error: Cannot compare values of type VARCHAR and type DECIMAL(2,1) - an explicit cast is required\n\nLINE 1: SELECT * FROM cones WHERE Flavor > 1.5\n                                         ^"}],
  ["SELECT * FROM cones WHERE Flavor = TRUE", {"error": "Conversion Error: Could not convert string 'strawberry' to BOOL when casting from source column Flavor\n\nLINE 1: SELECT * FROM cones WHERE Flavor = TRUE\n                                  ^"}],
  ["SELECT * FROM cones WHERE Flavor <> TRUE", {"error": "Conversion Error: Could not convert string 'strawberry' to BOOL when casting from source column Flavor\n\nLINE 1: SELECT * FROM cones WHERE Flavor <> TRUE\n                                  ^"}],
  ["SELECT * FROM cones WHERE Flavor > FALSE", {"error": "Binder Error: Cannot compare values of type VARCHAR and type BOOLEAN - an explicit cast is required\n\nLINE 1: SELECT * FROM cones WHERE Flavor > FALSE\n                                         ^"}],
  ["SELECT * FROM cones WHERE Flavor >= TRUE", {"error": "Binder Error: Cannot compare values of type VARCHAR and type BOOLEAN - an explicit cast is required\n\nLINE 1: SELECT * FROM cones WHERE Flavor >= TRUE\n                                         ^"}],
  ["SELECT * FROM cones WHERE Flavr = 'x'", {"error": "Binder Error: Referenced column \"Flavr\" not found in FROM clause!\nCandidate bindings: \"Flavor\", \"Color\"\n\nLINE 1: SELECT * FROM cones WHERE Flavr = 'x'\n                                  ^"}],
  ["SELECT * FROM cones WHERE flavr = 'x'", {"error": "Binder Error: Referenced column \"flavr\" not found in FROM clause!\nCandidate bindings: \"Flavor\", \"Color\"\n\nLINE 1: SELECT * FROM cones WHERE flavr = 'x'\n                                  ^"}],
  ["SELECT * FROM cones WHERE Prise > 4", {"error": "Binder Error: Referenced column \"Prise\" not found in FROM clause!\nCandidate bindings: \"Price\"\n\nLINE 1: SELECT * FROM cones WHERE Prise > 4\n                                  ^"}],
  ["SELECT * FROM cones WHERE colour = 'pink'", {"error": "Binder Error: Referenced column \"colour\" not found in FROM clause!\nCandidate bindings: \"Color\", \"Flavor\"\n\nLINE 1: SELECT * FROM cones WHERE colour = 'pink'\n                                  ^"}],
  ["SELECT * FROM cones WHERE x = 1", {"error": "Binder Error: Referenced column \"x\" not found in FROM clause!\nCandidate bindings: \"Color\"\n\nLINE 1: SELECT * FROM cones WHERE x = 1\n                                  ^"}],
  ["SELECT * FROM cones WHERE Taste = 'sweet'", {"error": "Binder Error: Referenced column \"Taste\" not found in FROM clause!\nCandidate bindings: \"Price\"\n\nLINE 1: SELECT * FROM cones WHERE Taste = 'sweet'\n                                  ^"}],
  ["SELECT * FROM cones WHERE p = 1", {"error": "Binder Error: Referenced column \"p\" not found in FROM clause!\nCandidate bindings: \"Color\"\n\nLINE 1: SELECT * FROM cones WHERE p = 1\n                                  ^"}],
  ["SELECT * FROM cones WHERE vanilla = 1", {"error": "Binder Error: Referenced column \"vanilla\" not found in FROM clause!\nCandidate bindings: \"Color\"\n\nLINE 1: SELECT * FROM cones WHERE vanilla = 1\n                                  ^"}],
  ["SELECT * FROM cones WHERE Flavor = chocolate", {"error": "Binder Error: Referenced column \"chocolate\" not found in FROM clause!\nCandidate bindings: \"Color\"\n\nLINE 1: SELECT * FROM cones WHERE Flavor = chocolate\n                                           ^"}],
  ["SELECT * FROM cones WHERE Flavor = \"chocolate\"", {"error": "Binder Error: Referenced column \"chocolate\" not found in FROM clause!\nCandidate bindings: \"Color\"\n\nLINE 1: SELECT * FROM cones WHERE Flavor = \"chocolate\"\n                                           ^"}],
  ["SELECT * FROM cones WHERE Flavr = chocolate", {"error": "Binder Error: Referenced column \"Flavr\" not found in FROM clause!\nCandidate bindings: \"Flavor\", \"Color\"\n\nLINE 1: SELECT * FROM cones WHERE Flavr = chocolate\n                                  ^"}],
  ["SELECT * FROM conez WHERE Flavor = 'x'", {"error": "Catalog Error: Table with name conez does not exist!\nDid you mean \"cones\"?\n\nLINE 1: SELECT * FROM conez WHERE Flavor = 'x'\n                      ^"}],
  ["SELECT * FROM cone WHERE Flavor = 'x'", {"error": "Catalog Error: Table with name cone does not exist!\nDid you mean \"cones\"?\n\nLINE 1: SELECT * FROM cone WHERE Flavor = 'x'\n                      ^"}],
  ["SELECT * FROM cnoes WHERE Flavor = 'x'", {"error": "Catalog Error: Table with name cnoes does not exist!\nDid you mean \"cones\"?\n\nLINE 1: SELECT * FROM cnoes WHERE Flavor = 'x'\n                      ^"}],
  ["SELECT * FROM scones WHERE Flavor = 'x'", {"error": "Catalog Error: Table with name scones does not exist!\nDid you mean \"cones\"?\n\nLINE 1: SELECT * FROM scones WHERE Flavor = 'x'\n                      ^"}],
  ["SELECT * FROM conez WHERE Flavr = 'x'", {"error": "Catalog Error: Table with name conez does not exist!\nDid you mean \"cones\"?\n\nLINE 1: SELECT * FROM conez WHERE Flavr = 'x'\n                      ^"}],
  ["-- DuckDB SQL\nSELECT * FROM cones WHERE Flavr = 'x'", {"error": "Binder Error: Referenced column \"Flavr\" not found in FROM clause!\nCandidate bindings: \"Flavor\", \"Color\"\n\nLINE 2: SELECT * FROM cones WHERE Flavr = 'x'\n                                  ^"}],
  ["-- DuckDB SQL\nSELECT * FROM conez WHERE Flavor = 'x'", {"error": "Catalog Error: Table with name conez does not exist!\nDid you mean \"cones\"?\n\nLINE 2: SELECT * FROM conez WHERE Flavor = 'x'\n                      ^"}],
  ["SELECT *\nFROM cones\nWHERE Price > 'x'", {"error": "Conversion Error: Could not convert string 'x' to DOUBLE\n\nLINE 3: WHERE Price > 'x'\n                      ^"}],
  ["SELECT *\nFROM cones\nWHERE Flavor > 4", {"error": "Binder Error: Cannot compare values of type VARCHAR and type INTEGER_LITERAL - an explicit cast is required\n\nLINE 3: WHERE Flavor > 4\n                     ^"}],
];

describe('the hero cell matches DuckDB', () => {
  it.each(CASES)('%s', (code, expected) => {
    expect(run(code)).toEqual(expected);
  });

  it('hands anything else to the tutor', () => {
    expect(run('SELECT * FROM cones')).toEqual({ kind: 'unsupported' });
    expect(run("SELECT Flavor FROM cones WHERE Price > 4")).toEqual({ kind: 'unsupported' });
    expect(run("SELECT * FROM cones WHERE Price > 4 AND Flavor = 'mint'")).toEqual({ kind: 'unsupported' });
    expect(run('SELECT * FROM cones WHERE Flavor = Color')).toEqual({ kind: 'unsupported' });
    expect(run("SELECT * FROM cones WHERE Price > 4; SELECT 1")).toEqual({ kind: 'unsupported' });
    expect(run("SELECT * FROM cones WHERE Flavor = 1e2")).toEqual({ kind: 'unsupported' });
    // A table name far from cones: DuckDB would suggest one of its own system tables
    expect(run("SELECT * FROM icecream WHERE Flavor = 'x'")).toEqual({ kind: 'unsupported' });
    expect(run('-- just a comment')).toEqual({ kind: 'empty' });
  });

  it('ranks misspelled columns the way DuckDB does', () => {
    // From DuckDB's Candidate bindings for each name (CPython and Pyodide agree)
    expect(candidateBindings('Flavr')).toEqual(['Flavor', 'Color']);
    expect(candidateBindings('colour')).toEqual(['Color', 'Flavor']);
    expect(candidateBindings('olor')).toEqual(['Color', 'Flavor']);
    expect(candidateBindings('fla')).toEqual(['Flavor', 'Color']);
    expect(candidateBindings('PRICE2')).toEqual(['Price']);
    expect(candidateBindings('Pr')).toEqual(['Price']);
    expect(candidateBindings('a')).toEqual(['Flavor']);
    expect(candidateBindings('zzz')).toEqual(['Color']);
    expect(candidateBindings('name')).toEqual(['Price']);
  });

  it('says true or false for every row', () => {
    const parsed = parseSql("SELECT * FROM cones WHERE Flavor = 'chocolate'", Object.keys(DATA));
    if (parsed.kind !== 'query') throw new Error(parsed.kind);
    const result = evaluateSql(parsed.op, parsed.value, { label: 'Flavor', values: DATA.Flavor, shown: DATA.Flavor.map(String) }, parsed.where);
    expect('reasons' in result && result.reasons.slice(0, 2)).toEqual([
      "'strawberry' = 'chocolate' is false",
      "'chocolate' = 'chocolate' is true",
    ]);
  });
});
