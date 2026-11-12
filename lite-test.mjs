import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { apply } from './index.js';

const SKILLS = [
  { name: 'lark-sheets', description: '飞书电子表格：创建和操作电子表格。', source: 'user-dsh', provider: 'filesystem' },
  { name: 'office-xlsx', description: 'Excel workbooks and formulas.', source: 'bundled', provider: 'filesystem' },
];
const ALLOWED_TOOLS = new Set(['skill_scout', 'skill_feedback', 'skill_manage', 'capability_check', 'acquire_skill', 'open_skill_pilot']);
const ALLOWED_ROUTES = [
  '/skill-pilot/data', '/skill-pilot/settings', '/skill-pilot/secrets', '/skill-pilot/scout',
  '/skill-pilot/capabilities', '/skill-pilot/acquire', '/skill-pilot/install', '/skill-pilot/security/scan',
  '/skill-pilot/feedback', '/skill-pilot/skill', '/skill-pilot/bulk', '/skill-pilot/skills/discover',
  '/skill-pilot/fs', '/skill-pilot/usage', '/skill-pilot/online',
];

const storeDir = mkdtempSync(path.join(os.tmpdir(), 'skill-pilot-lite-'));
const tools = [];
const routes = new Map();
const ctx = {
  tools: { register: (def) => { tools.push(def); return () => {}; }, guard: () => () => {}, restrict: () => () => {} },
  on: () => () => {},
  effect: (fn) => { fn(); return () => {}; },
  inject: (deps, cb) => cb({ webServer: { register: (route) => { routes.set(route.path, route); return () => {}; } } }),
  systemPrompt: { section: () => () => {}, getSectionOrder: () => 2400 },
  workingDirectory: { ensure: async () => 'D:\\work' },
  skills: { list: async () => SKILLS, get: async (name) => ({ name, content: `# ${name}\n` }) },
  get: () => undefined,
};
apply(ctx, { storeDir, debug: false });

assert.deepEqual(tools.map((def) => def.name).sort(), [...ALLOWED_TOOLS].sort(), 'lite tools only');
for (const route of routes.keys()) {
  assert.ok(ALLOWED_ROUTES.some((prefix) => route === prefix || route.startsWith(`${prefix}/`)), `removed route leaked: ${route}`);
}
for (const removed of ['/skill-pilot/team/policy', '/skill-pilot/backup/list', '/skill-pilot/market/status', '/skill-pilot/mcp/package']) {
  assert.equal(routes.has(removed), false, `removed route present: ${removed}`);
}

async function request(route, req) {
  const chunks = [];
  const res = { statusCode: 200, setHeader() {}, writeHead(status) { this.statusCode = status; }, end(chunk) { if (chunk) chunks.push(String(chunk)); } };
  await route.handler(req, res);
  return { status: res.statusCode, body: JSON.parse(chunks.join('')) };
}

const data = await request(routes.get('/skill-pilot/data'), { method: 'GET', url: '/skill-pilot/data', headers: {}, socket: { remoteAddress: '127.0.0.1' } });
assert.equal(data.body.ok, true);
assert.equal(data.body.counts.total, 2);
assert.ok(data.body.writeToken, 'write token exposed');

const noToken = await request(routes.get('/skill-pilot/settings'), {
  method: 'POST', url: '/skill-pilot/settings', headers: { 'content-type': 'application/json' },
  socket: { remoteAddress: '127.0.0.1' }, on() {}, resume() {},
});
assert.equal(noToken.status, 403, 'write without token rejected');

console.log(JSON.stringify({ ok: true, tools: tools.map((def) => def.name), routes: routes.size, skills: data.body.counts.total }, null, 2));

const scout = tools.find((def) => def.name === 'skill_scout');
const scoutResult = await scout.execute({ query: 'Excel 表格' }, { agent: { id: 'lite-scout' } });
assert.ok(scoutResult && typeof scoutResult.text === 'string' && scoutResult.text.includes('技能雷达'), 'scout returns radar text');
console.log(JSON.stringify({ ok: true, scoutChars: scoutResult.text.length }, null, 2));
