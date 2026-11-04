// Every tracer's Python tests (tracers/<lib>/*_test.py) under CPython: $PYTHON, else python3.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRACERS = join(dirname(fileURLToPath(import.meta.url)), '..', 'tracers');
const python = process.env.PYTHON || 'python3';
let failed = false;
for (const lib of readdirSync(TRACERS).sort()) {
  const dir = join(TRACERS, lib);
  if (!existsSync(join(dir, 'tracer.py'))) continue;
  console.log(`\ntracers/${lib}`);
  const result = spawnSync(python, ['-m', 'unittest', 'discover', '-p', '*_test.py'], { cwd: dir, stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
