// Bundle TypeScript and local dependencies, then run Node's assertion-based regression suite.
import { rolldown } from 'rolldown';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const dir = await mkdtemp(join(tmpdir(), 'ship-sim-tests-'));
try {
  const build = await rolldown({ input: fileURLToPath(new URL('../tests/regression.test.mjs', import.meta.url)), platform: 'node' });
  let output;
  try { ({ output } = await build.generate({ format: 'esm' })); }
  finally { await build.close(); }
  const entry = join(dir, 'regression.test.mjs');
  await writeFile(entry, output[0].code);
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', entry], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
} finally {
  await rm(dir, { recursive: true, force: true });
}
