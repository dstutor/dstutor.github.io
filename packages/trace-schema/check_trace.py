"""Hold a trace to the contract the frontend reads (README.md), for any tracer's tests.

    from check_trace import trace_problems
    assert trace_problems(trace) == []

Three layers, each one something the visualization depends on:
  1. strict JSON: what the runner sends must parse in the browser (no NaN or Infinity);
  2. schema/trace.schema.json, generated from src/index.ts: shapes, types, no unknown fields;
  3. what a JSON Schema cannot say: rows as wide as the columns, highlights that point at rows
     and columns that exist, step ids in order, source lines in order.

Runs under CPython with jsonschema (tracers/*/requirements-test.txt), no Pyodide needed.
"""
import json
import os

from jsonschema import Draft7Validator

SCHEMA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'schema', 'trace.schema.json')

_validator = None


def _schema_validator():
    global _validator
    if _validator is None:
        with open(SCHEMA_PATH, encoding='utf-8') as f:
            schema = json.load(f)
        Draft7Validator.check_schema(schema)
        _validator = Draft7Validator(schema)
    return _validator


def trace_problems(trace):
    """Every way trace breaks the contract, as readable strings; [] when it holds."""
    try:
        data = json.loads(json.dumps(trace, allow_nan=False))
    except (TypeError, ValueError) as e:
        return [f'not strict JSON: {e}']

    problems = [
        f'{"/".join(str(p) for p in error.absolute_path) or "trace"}: {error.message}'
        for error in sorted(_schema_validator().iter_errors(data), key=lambda e: list(e.absolute_path))
    ]
    if problems:
        return problems

    last_step = None
    for i, record in enumerate(data):
        where = f'[{i}] {record["operation"]} (step {record["step_id"]})'
        if last_step is not None and record['step_id'] <= last_step:
            problems.append(f'{where}: step_id {record["step_id"]} does not follow {last_step}')
        last_step = record['step_id']

        problems += _state_problems(f'{where} input', record['input'])
        problems += _state_problems(f'{where} output', record['output'])

        site = record.get('site')
        if site and not 1 <= site['stmt_start'] <= site['line'] <= site['stmt_end']:
            problems.append(f'{where} site: lines must satisfy 1 <= stmt_start <= line <= stmt_end, got {site}')

        for j, sub in enumerate(record.get('sub_steps') or []):
            at = f'{where} sub_steps[{j}]'
            # A frame without its own output_state shows the record's output
            output = sub.get('output_state', record['output'])
            if 'output_state' in sub:
                problems += _state_problems(f'{at} output_state', output)
            problems += _highlight_problems(f'{at} input_highlights', sub.get('input_highlights'), record['input'])
            problems += _highlight_problems(f'{at} output_highlights', sub.get('output_highlights'), output)
            for key in ('aux_table', 'aux_output'):
                if key in sub:
                    problems += _state_problems(f'{at} {key}', sub[key]['state'])
                    problems += _highlight_problems(f'{at} {key} highlights', sub[key].get('highlights'), sub[key]['state'])
    return problems


def _state_problems(where, state):
    if state.get('error'):
        return []  # a table that could not be read is shown as its error
    problems = []
    width = len(state['columns'])
    if state['num_columns'] != width:
        problems.append(f'{where}: num_columns {state["num_columns"]} but {width} columns')
    for r, row in enumerate(state['preview']):
        if len(row) != width:
            problems.append(f'{where}: preview row {r} has {len(row)} values for {width} columns')
    if len(state['preview']) > state['num_rows']:
        problems.append(f'{where}: preview has {len(state["preview"])} rows but num_rows is {state["num_rows"]}')
    if state.get('index_columns', 0) > width:
        problems.append(f'{where}: index_columns {state["index_columns"]} but only {width} columns')
    return problems


def _highlight_problems(where, highlights, state):
    if not highlights or state.get('error'):
        return []
    problems = []
    rows = len(state['preview'])
    columns = set(state['columns'])
    for key in ('rows', 'rows_removed'):
        bad = [r for r in highlights.get(key, []) if not 0 <= r < rows]
        if bad:
            problems.append(f'{where}: {key} {bad} outside the {rows} preview rows')
    missing = [c for c in highlights.get('columns', []) if c not in columns]
    if missing:
        problems.append(f'{where}: columns {missing} not in {sorted(columns)}')
    bad_cells = [cell for cell in highlights.get('cells', []) if not (0 <= cell[0] < rows and cell[1] in columns)]
    if bad_cells:
        problems.append(f'{where}: cells {bad_cells} outside the table')
    return problems
