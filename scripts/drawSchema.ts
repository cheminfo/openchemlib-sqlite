/**
 * Draw the library's tables as `docs/schema.svg`, from scratch databases this
 * checkout creates, so the drawing cannot drift from the code. A test fails
 * when they differ: run `npm run schema-svg` after changing a table.
 */

import { writeFileSync } from 'node:fs';

import { schemaSvg, schemaSvgPath } from './schema/schemaSvg.ts';

writeFileSync(schemaSvgPath(), await schemaSvg());
process.stdout.write(`written ${schemaSvgPath()}\n`);
