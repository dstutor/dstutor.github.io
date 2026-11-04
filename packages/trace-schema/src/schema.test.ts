import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv } from 'ajv';
import { createGenerator } from 'ts-json-schema-generator';
import { describe, expect, it } from 'vitest';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const SCHEMA_FILE = here('../schema/trace.schema.json');
const SNAPSHOTS = here('../../../tracers/datascience/snapshots/');

const committed = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'));

describe('trace.schema.json', () => {
  it('is up to date with the types (run npm run schema -w @dstutor/trace-schema)', () => {
    const generated = createGenerator({ path: here('index.ts'), tsconfig: here('../tsconfig.json'), type: 'Trace' }).createSchema('Trace');
    expect(JSON.parse(JSON.stringify(generated))).toEqual(committed);
  }, 30_000);

  const validate = new Ajv({ allErrors: true }).compile(committed);

  it('accepts every datascience snapshot', () => {
    const files = readdirSync(SNAPSHOTS).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const { trace } = JSON.parse(readFileSync(SNAPSHOTS + file, 'utf8'));
      expect(validate(trace) ? [] : validate.errors, file).toEqual([]);
    }
  });

  it('rejects a record with an unknown field or a wrongly typed one', () => {
    const { trace } = JSON.parse(readFileSync(SNAPSHOTS + 'filter-rows.json', 'utf8'));
    expect(validate([{ ...trace[0], surprise: 1 }])).toBe(false);
    expect(validate([{ ...trace[0], step_id: 1.5 }])).toBe(false);
    expect(validate([{ ...trace[0], input: { ...trace[0].input, preview: 'rows' } }])).toBe(false);
  });

  it('accepts stages, notes, row colours and panels', () => {
    const { trace } = JSON.parse(readFileSync(SNAPSHOTS + 'filter-rows.json', 'utf8'));
    const rows = trace[0].input.preview.length;
    const sub = {
      stage: 'Which keys match',
      message: 'm',
      note: 'how it runs',
      input_highlights: { row_colors: Array.from({ length: rows }, (_, i) => (i % 2 ? null : 1)) },
      panel: { kind: 'keys', key: 'Flavor', left: 'cones', right: 'stock', left_only: [{ value: 'mint', color: 0 }], both: [], right_only: [], keeps: ['both'] },
    };
    expect(validate([{ ...trace[0], sub_steps: [sub] }])).toBe(true);
    // A colour slot is one of eight
    expect(validate([{ ...trace[0], sub_steps: [{ ...sub, input_highlights: { row_colors: [9] } }] }])).toBe(false);
    expect(validate([{ ...trace[0], sub_steps: [{ ...sub, panel: { kind: 'venn' } }] }])).toBe(false);
  });

  it('accepts column types as strings, and only as strings', () => {
    const { trace } = JSON.parse(readFileSync(SNAPSHOTS + 'filter-rows.json', 'utf8'));
    const types = trace[0].input.columns.map(() => 'str');
    expect(validate([{ ...trace[0], input: { ...trace[0].input, column_types: types } }])).toBe(true);
    expect(validate([{ ...trace[0], input: { ...trace[0].input, column_types: [1] } }])).toBe(false);
  });
});
