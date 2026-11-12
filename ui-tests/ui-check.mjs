import { chromium } from 'playwright-core';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const base = process.env.SKILL_PILOT_UI_BASE || 'http://127.0.0.1:18777';
const artifacts = path.join(process.cwd(), 'artifacts');
mkdirSync(artifacts, { recursive: true });
const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const consoleErrors = [];
const pageErrors = [];
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', (err) => pageErrors.push(String((err && err.message) || err)));

await page.goto(base, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(1200);
const bodyText = await page.locator('body').innerText();
check('settings overview title', bodyText.includes('技能领航员'), bodyText.slice(0, 80));
check('settings overview has open button', bodyText.includes('打开管理面板'));
check('settings overview has autonomy selector', bodyText.includes('AI 自主程度') && bodyText.includes('完全') && bodyText.includes('标准'));
check('no error boundary', !bodyText.includes('面板渲染异常'));
await page.screenshot({ path: path.join(artifacts, 'lite-overview.png') });

await page.getByRole('button', { name: '打开管理面板', exact: true }).first().click();
await page.waitForTimeout(700);
const panelText = await page.locator('body').innerText();
check('full panel opened from overview', panelText.includes('能力控制台'), panelText.slice(0, 100));

for (const label of ['运行', '能力', '配置']) {
  const count = await page.getByRole('button', { name: label, exact: true }).count();
  check(`top tab ${label}`, count >= 1, `count=${count}`);
}
for (const label of ['观察', '扩展']) {
  const count = await page.getByRole('button', { name: label, exact: true }).count();
  check(`top tab removed: ${label}`, count === 0, `count=${count}`);
}

await page.getByRole('button', { name: '能力', exact: true }).first().click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: '在线技能', exact: true }).first().click();
await page.waitForTimeout(400);
const onlineText = await page.locator('body').innerText();
check('online search panel visible', onlineText.includes('在线找技能'), onlineText.slice(0, 80));
check('lite hides registry controls', !onlineText.includes('爬取在线注册表') && !onlineText.includes('抓取 skills.sh'));
check('lite has no pro search tab', (await page.getByRole('button', { name: '专业检索', exact: true }).count()) === 0);

await page.getByRole('button', { name: '配置', exact: true }).first().click();
await page.waitForTimeout(400);
const nav = page.locator('nav[aria-label="技能领航员分区导航"]');
check('sidebar exists', await nav.count() === 1);
const sidebarText = await nav.innerText();
const sidebarFlat = sidebarText.replace(/\n/g, ' / ');
check('local dir section in sidebar', sidebarText.includes('本机技能目录'), sidebarFlat);
check('mode section in sidebar', sidebarText.includes('决策模式'), sidebarFlat);
for (const removed of ['团队与迁移', '目录压缩', '分组', '自改进', '格式转换', '决策日志', '使用统计']) {
  check(`removed section absent: ${removed}`, !sidebarText.includes(removed), sidebarFlat);
}
check('no sec-* leaked', !/sec-[a-z]+/.test(sidebarText));
check('lite search has no pro tab', (await page.getByRole('button', { name: '专业检索', exact: true }).count()) === 0);

const navBoxBefore = await nav.boundingBox();
const rightPane = await page.evaluateHandle(() => {
  const node = document.querySelector('nav[aria-label="技能领航员分区导航"]');
  return node && node.parentElement ? node.parentElement.children[node.parentElement.children.length - 1] : null;
});
const rightBox = await rightPane.boundingBox();
check('right pane is scrollable', Boolean(rightBox && rightBox.height > 100), JSON.stringify(rightBox));
await rightPane.evaluate((el) => { el.scrollTop = Math.max(200, el.scrollHeight - el.clientHeight); });
await page.waitForTimeout(500);
const navBoxAfter = await nav.boundingBox();
check('sidebar fixed while content scrolls', Boolean(navBoxBefore && navBoxAfter && Math.abs(navBoxBefore.y - navBoxAfter.y) < 2),
  `${navBoxBefore && navBoxBefore.y} -> ${navBoxAfter && navBoxAfter.y}`);
await page.screenshot({ path: path.join(artifacts, 'lite-config.png') });

const narrow = await browser.newPage({ viewport: { width: 800, height: 900 } });
await narrow.goto(base, { waitUntil: 'networkidle', timeout: 30000 });
await narrow.waitForTimeout(800);
const overflow = await narrow.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('narrow viewport no horizontal overflow', overflow <= 2, `overflow=${overflow}`);
await narrow.screenshot({ path: path.join(artifacts, 'lite-narrow-800.png') });

check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
const failed = checks.filter((item) => !item.ok);
console.log(JSON.stringify({ total: checks.length, failed: failed.length, checks, artifacts }, null, 2));
process.exitCode = failed.length ? 1 : 0;
