import { spawn } from 'node:child_process';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.SKILL_PILOT_UI_PORT || 18777);
const base = `http://127.0.0.1:${port}`;
const harness = spawn(process.execPath, [path.join(root, 'harness.mjs')], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let harnessOutput = '';
harness.stdout.on('data', (chunk) => { harnessOutput += String(chunk); });
harness.stderr.on('data', (chunk) => { harnessOutput += String(chunk); });

const waitReady = async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(base, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

const stop = () => {
  try { harness.kill(); } catch { /* ignore */ }
};

let exitCode = 1;
try {
  if (!await waitReady()) {
    console.error('UI harness failed to start\n' + harnessOutput);
  } else {
    const check = spawn(process.execPath, [path.join(root, 'ui-check.mjs')], {
      cwd: root,
      env: { ...process.env, SKILL_PILOT_UI_BASE: base },
      stdio: 'inherit',
    });
    exitCode = await new Promise((resolve) => check.on('exit', (code) => resolve(code ?? 1)));
  }
} finally {
  stop();
}
process.exitCode = exitCode;
