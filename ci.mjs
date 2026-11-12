import { spawnSync } from 'node:child_process';

let failures = 0;
const run = (label, args) => {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const passed = result.status === 0;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${label}`);
  if (!passed) {
    failures += 1;
    console.log((result.stdout || '') + (result.stderr || ''));
  }
  return passed;
};

run('syntax index', ['--check', 'index.js']);
run('syntax client', ['--check', 'client.js']);
run('lite contracts', ['lite-test.mjs']);
run('client registration', ['client-harness.mjs']);

console.log(failures ? `\nCI FAILED (${failures})` : '\nCI PASSED');
process.exit(failures ? 1 : 0);
