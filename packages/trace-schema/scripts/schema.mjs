// Writes schema/trace.schema.json from the types in src/index.ts. src/schema.test.ts generates it
// the same way and fails when the committed file is out of date.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const schema = createGenerator({ path: here('../src/index.ts'), tsconfig: here('../tsconfig.json'), type: 'Trace' }).createSchema('Trace');
writeFileSync(here('../schema/trace.schema.json'), JSON.stringify(schema, null, 2) + '\n');
console.log('wrote schema/trace.schema.json');
