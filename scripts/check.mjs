import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
let count = 0;
for (const directory of ['guard', 'scripts']) for (const name of fs.readdirSync(path.join(root, directory))) {
  if (!/\.(?:cjs|mjs|js)$/.test(name)) continue;
  execFileSync(process.execPath, ['--check', path.join(root, directory, name)], { stdio: 'inherit' }); count++;
}
console.log(`Syntax checks passed for ${count} JavaScript files`);
