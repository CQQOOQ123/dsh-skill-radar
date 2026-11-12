/**
 * dsh-skill-pilot — 技能领航员。
 *
 * 三件事：
 *  1. 任务前 / 任务中检索：BM25（中文字符 bigram 兜底）+ 正文标题信号 + 使用频次 + 时间衰减 + 置顶，
 *     只返回「名字 + 一句用途 + 打分理由」，正文仍由 `skill` 工具按需加载。
 *  2. 统一管理：skill 开关 / 置顶 / 使用统计 + 插件启用状态（经 ctx.pluginManager）。
 *  3. 约束：被关闭的技能从目录行里过滤掉，`skill` 调用被 guard 拒绝。
 *
 * 零依赖、纯 ESM，与 dsh-memory-index 同一种 Host 插件形态。
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, cpSync, statSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-skill-pilot-lite';

export const LITE = true;
export const inject = ['tools', 'skills', 'systemPrompt', 'workingDirectory'];

const CATALOG_LINE = /^-\s+`([a-z0-9]+(?:-[a-z0-9]+)*)`:\s*/;
const CJK_RUN = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g;
const LATIN = /[a-z0-9][a-z0-9_+.#/-]{1,}/g;

const AUTONOMY_LEVELS = ['manual', 'suggest', 'standard', 'full'];

const DEFAULT_SETTINGS = {
  schema: 3,
  autonomy: 'standard',
  allowPluginControl: false,
  catalogMode: 'compact',
  radarMinScore: 1.2,
  radarMinCoverage: 0.18,
  priorBaseBoost: 8,
  priorCategoryBoost: 1,
  qualityGateEnabled: true,
  qualityGateMinCoverage: 0.2,
  qualityGateMinDistinct: 2,
  qualityGateMinMargin: 1.0,
  autoLoadScore: 2.5,
  autoLoadCoverage: 0.25,
  autoLoadMax: 1,
  maxBodyChars: 4000,
  sessionBudgetTokens: 15000,
  embeddingEnabled: false,
  embeddingBaseUrl: '',
  embeddingModel: 'text-embedding-3-small',
  embeddingApiKeyEnv: 'OPENAI_API_KEY',
  embeddingTopN: 20,
  takeoverSkill: false,
  deferScout: false,
  onlineSources: [
    { name: 'GitHub', kind: 'github', url: '', enabled: true, priority: 10 },
  ],
  securityScanDefault: true,
  requireSignature: false,
  installDir: '',
  autoAcquire: false,
  autoDisableBroken: false,
  autoSearch: true,
  autoEnable: false,
  dryRun: false,
  trustedOwners: [],
  nudges: true,
  actionBudget: 3,
  healthCheckHours: 24,
  registryRefreshHours: 24,
  skillsShRefreshHours: 24,
  skillsShLimit: 2000,
  useSkillsSh: true,
  idleDisableDays: 0,
  cacheHours: 24,
  extraSkillDirs: [],
  primarySkillDir: '',
  disabledSkillDirs: [],
  paused: false,
  marketEnabled: false,
  marketIndexUrl: '',
  proSources: [
    { name: 'MDN 文档', kind: 'mdn', regions: ['GLOBAL'], trust: 'official', maxAgeDays: 730, enabled: true, priority: 10 },
    { name: '东方财富研报', kind: 'eastmoney-report', regions: ['CN'], trust: 'medium', maxAgeDays: 180, enabled: true, priority: 8 },
    { name: '东方财富行情', kind: 'eastmoney-quote', regions: ['CN'], trust: 'high', maxAgeDays: 1, enabled: true, priority: 8 },
    { name: 'SEC EDGAR', kind: 'sec-edgar', regions: ['US'], trust: 'official', maxAgeDays: 3650, enabled: true, priority: 9 },
    { name: 'arXiv', kind: 'arxiv', regions: ['GLOBAL'], trust: 'high', maxAgeDays: 3650, enabled: true, priority: 7 },
    { name: 'OpenAlex', kind: 'openalex', regions: ['GLOBAL'], trust: 'medium', maxAgeDays: 3650, enabled: true, priority: 6 },
    { name: 'Tavily', kind: 'tavily', regions: ['GLOBAL'], trust: 'medium', maxAgeDays: 1, enabled: false, priority: 5 },
    { name: 'EU Open Data', kind: 'eu-data', regions: ['EU'], trust: 'official', maxAgeDays: 730, enabled: true, priority: 8 },
    { name: '日本法令', kind: 'jp-egov', regions: ['JP'], trust: 'official', maxAgeDays: 3650, enabled: true, priority: 7 },
  ],
};

function normalizeProSources(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, 14) : [];
  const kinds = ['mdn', 'eastmoney-report', 'eastmoney-quote', 'sec-edgar', 'arxiv', 'openalex', 'tavily', 'eu-data', 'jp-egov'];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim().slice(0, 40);
    const kind = String(item.kind || '').trim();
    if (!name || !kinds.includes(kind)) continue;
    out.push({
      name,
      kind,
      regions: (Array.isArray(item.regions) ? item.regions : ['GLOBAL'])
        .map((region) => String(region).toUpperCase())
        .filter((region) => ['CN', 'US', 'EU', 'JP', 'GLOBAL'].includes(region))
        .slice(0, 4),
      trust: ['official', 'high', 'medium', 'low'].includes(item.trust) ? item.trust : 'medium',
      maxAgeDays: Number.isFinite(Number(item.maxAgeDays)) ? Math.max(1, Math.min(Number(item.maxAgeDays), 36500)) : 3650,
      enabled: item.enabled !== false,
      priority: Number.isFinite(Number(item.priority)) ? Math.max(0, Math.min(Number(item.priority), 100)) : 5,
    });
  }
  const defaults = DEFAULT_SETTINGS.proSources.map((source) => ({ ...source }));
  for (const fallback of defaults) {
    if (!out.some((source) => source.kind === fallback.kind)) out.push(fallback);
  }
  return out.length ? out : defaults.slice(0, 1);
}

function normalizeOnlineSources(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, 8) : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const name = String(item.name || '').trim().slice(0, 40);
    if (!name) continue;
    const kind = item.kind === 'web' ? 'web' : 'github';
    const url = String(item.url || '').trim().slice(0, 500);
    if (kind === 'web' && !/^https?:\/\//i.test(url)) continue;
    out.push({
      name,
      kind,
      url,
      enabled: item.enabled !== false,
      priority: Number.isFinite(Number(item.priority)) ? Math.max(0, Math.min(Number(item.priority), 100)) : 5,
    });
  }
  return out.length ? out : DEFAULT_SETTINGS.onlineSources.map((source) => ({ ...source }));
}

const LEVEL_POLICY = {
  manual: 'MANUAL: the operator picks skills. Do not auto-search or auto-load; call `skill_scout` only when the user explicitly asks about skills or the task is genuinely blocked. Do not change skill or plugin switches.',
  suggest: 'SUGGEST: a radar of likely skills is injected at the start of each turn. Use `skill_scout` for non-trivial work and load only the 1-2 skills that clearly fit. Do not change switches.',
  standard: 'AUTO: scout before non-trivial work and auto-load the fitting skill yourself. You may pin/unpin skills; enabling, disabling, and plugin switches stay with the operator.',
  full: 'FULL: you may also enable/disable or pin skills when it clearly improves the workflow. Prefer pin over disable, never disable a pinned skill, and explain each change. Plugin switches stay with the operator unless allowed.',
};

// 中英互扩：DSH 的技能描述约一半中文一半英文，单一语种查询会漏掉另一半。
const LEXICON = [
  ['插件', ['plugin', 'extension']],
  ['技能', ['skill', 'capability']],
  ['工具', ['tool', 'utility']],
  ['开发', ['develop', 'development', 'implement', 'build']],
  ['编程', ['programming', 'coding', 'code']],
  ['代码', ['code', 'coding', 'source']],
  ['调试', ['debug', 'troubleshoot']],
  ['测试', ['test', 'testing', 'qa']],
  ['部署', ['deploy', 'deployment', 'release']],
  ['文档', ['document', 'docs', 'documentation']],
  ['表格', ['sheet', 'spreadsheet', 'excel', 'table']],
  ['公式', ['formula', 'formulas']],
  ['重算', ['recalculate', 'refresh']],
  ['重新计算', ['recalculate', 'refresh']],
  ['计算', ['calculate', 'calculation']],
  ['刷新', ['refresh', 'recalculate']],
  ['幻灯', ['slide', 'slides', 'presentation', 'pptx']],
  ['演示', ['presentation', 'slides']],
  ['数据', ['data', 'dataset']],
  ['数据库', ['database', 'sql']],
  ['分析', ['analysis', 'analyze', 'analytics']],
  ['报告', ['report', 'reporting']],
  ['研报', ['research', 'report']],
  ['研究', ['research', 'survey']],
  ['论文', ['paper', 'arxiv', 'latex', 'academic']],
  ['写作', ['write', 'writing', 'authoring']],
  ['设计', ['design', 'visual', 'ui', 'ux']],
  ['前端', ['frontend', 'front-end', 'web', 'react']],
  ['后端', ['backend', 'server', 'api']],
  ['页面', ['page', 'landing', 'webpage']],
  ['组件', ['component', 'widget']],
  ['图片', ['image', 'picture', 'png', 'generate']],
  ['图像', ['image', 'vision']],
  ['视频', ['video', 'clip', 'movie']],
  ['音频', ['audio', 'sound']],
  ['语音', ['voice', 'speech', 'audio']],
  ['飞书', ['feishu', 'lark']],
  ['邮件', ['email', 'mail']],
  ['日历', ['calendar', 'schedule']],
  ['日程', ['calendar', 'schedule', 'agenda']],
  ['任务', ['task', 'todo']],
  ['审批', ['approval', 'approve']],
  ['知识库', ['wiki', 'knowledge']],
  ['会议', ['meeting', 'vc']],
  ['纪要', ['minutes', 'summary']],
  ['云盘', ['drive', 'cloud', 'storage']],
  ['画板', ['whiteboard', 'board']],
  ['财务', ['finance', 'financial']],
  ['股票', ['stock', 'equity']],
  ['基金', ['fund']],
  ['行情', ['market', 'quote']],
  ['财报', ['financials', 'earnings']],
  ['估值', ['valuation']],
  ['搜索', ['search', 'find']],
  ['网页', ['web', 'browser', 'page']],
  ['浏览器', ['browser', 'playwright']],
  ['自动化', ['automation', 'automate']],
  ['办公', ['office', 'docx', 'xlsx', 'pptx']],
  ['压缩', ['compact', 'compaction', 'compress']],
  ['记忆', ['memory']],
  ['会话', ['session', 'conversation']],
  ['执行', ['execute', 'execution', 'run']],
  ['管理', ['manage', 'manager', 'management']],
  ['配置', ['config', 'configuration']],
  ['安装', ['install', 'installation']],
  ['面板', ['panel', 'dashboard', 'ui']],
  ['架构', ['architecture']],
  ['重构', ['refactor', 'restructure']],
  ['优化', ['optimize', 'performance']],
  ['翻译', ['translate', 'translation']],
  ['识别', ['recognition', 'recognize', 'transcribe']],
  ['地图', ['map', 'industry']],
  ['行业', ['industry', 'sector']],
  ['公司', ['company', 'corporate']],
  ['风险', ['risk']],
  ['模型', ['model', 'llm']],
  ['提示词', ['prompt']],
  ['上下文', ['context']],
  ['索引', ['index', 'indexing']],
  ['缓存', ['cache', 'caching']],
  ['实验', ['experiment', 'benchmark']],
  ['评估', ['evaluate', 'evaluation', 'benchmark']],
  ['接口', ['api', 'endpoint']],
  ['服务', ['service', 'server']],
  ['账号', ['account', 'auth', 'login']],
  ['权限', ['permission', 'access']],
  ['安全', ['security', 'secure']],
  ['腾讯', ['tencent']],
  ['阿里', ['aliyun', 'alibaba']],
  ['字节', ['bytedance', 'doubao']],
  ['钉钉', ['dingtalk']],
  ['微信', ['wechat']],
  ['支付', ['payment', 'pay']],
  ['爬虫', ['crawler', 'scrape', 'scraping']],
  ['正则', ['regex', 'regexp']],
  ['监控', ['monitor', 'observability']],
  ['日志', ['log', 'logs']],
  ['终端', ['terminal', 'shell', 'pty']],
  ['命令行', ['cli', 'command']],
  ['工作流', ['workflow']],
  ['团队', ['team', 'teammate']],
  ['子代理', ['subagent', 'agent']],
  ['代理', ['agent']],
  ['目标', ['goal']],
  ['计划', ['plan', 'planning']],
  ['落地页', ['landing', 'frontend', 'webpage', 'page']],
  ['发散', ['divergent', 'diverge', 'ideation']],
  ['思维', ['thinking', 'ideation', 'brainstorm']],
  ['方向', ['direction']],
  ['产品', ['product']],
  ['像素', ['pixel', 'spritesheet']],
  ['宠物', ['pet', 'pets']],
  ['剪辑', ['edit', 'editing', 'cut']],
  ['字幕', ['subtitle', 'caption']],
  ['渲染', ['render', 'rendering']],
  ['新建', ['create', 'new']],
  ['天气', ['weather']],
  ['占用', ['usage', 'occupancy', 'tokens']],
];

const NUDGE_PATTERNS = [
  { key: 'pdf', label: 'PDF', re: /\bpdf\b|pdf$/i, exts: ['pdf'] },
  { key: 'excel', label: 'Excel/表格', re: /\b(xlsx?|excel|csv)\b|表格|电子表格|\.csv\b/i, exts: ['xls', 'xlsx', 'csv'] },
  { key: 'ppt', label: 'PPT/演示', re: /\b(pptx?|powerpoint)\b|演示文稿|幻灯片/i, exts: ['ppt', 'pptx'] },
  { key: 'word', label: 'Word/文档', re: /\b(docx?|word)\b|word 文档/i, exts: ['doc', 'docx'] },
  { key: 'markdown', label: 'Markdown', re: /markdown|\.md\b/i, exts: ['md'] },
  { key: 'lark', label: '飞书/Lark', re: /飞书|lark/i, exts: [] },
  { key: 'finance', label: '股票/行情', re: /股票|行情|a 股|选股/i, exts: [] },
  { key: 'image', label: '图片/海报', re: /图片|海报|配图|插画/i, exts: ['png', 'jpg', 'jpeg', 'webp'] },
  { key: 'video', label: '视频', re: /视频|剪辑|动画/i, exts: ['mp4', 'mov', 'mkv'] },
  { key: 'error', label: '报错/调试', re: /(TypeError|ReferenceError|SyntaxError|Traceback|报错|异常栈|stack trace)/i, exts: [] },
  { key: 'external', label: '外部信息', re: /最新|今天|实时|研报|论文|法规|政策|新闻/i, exts: [] },
];

const POLICY_HEAD = `<skill-pilot>
A skill pilot is watching this session. Use \`skill_scout\` to find the few skills that fit a task, and load only the 1-3 that clearly match with the \`skill\` tool. Use \`capability_check\` before claiming a capability gap, \`acquire_skill\` to find (and, only in full autonomy with auto-acquire, install) a missing skill. When the user asks how to open/manage skills or plugins, call \`open_skill_pilot\` to give them a clickable open button. \`skill_manage\` reports and changes skill/plugin switches subject to the active autonomy mode; disabled skills are hidden from the catalog and cannot be loaded. Never load a skill just to check it.
</skill-pilot>`;

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const autonomy = AUTONOMY_LEVELS.includes(source.autonomy) ? source.autonomy : DEFAULT_SETTINGS.autonomy;
  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(Math.max(number, min), max);
  };
  return {
    schema: 3,
    autonomy,
    allowPluginControl: source.allowPluginControl === true,
    catalogMode: ['full', 'compact', 'names'].includes(source.catalogMode) ? source.catalogMode : DEFAULT_SETTINGS.catalogMode,
    radarMinScore: clamp(source.radarMinScore, 0, 100, DEFAULT_SETTINGS.radarMinScore),
    radarMinCoverage: clamp(source.radarMinCoverage, 0, 1, DEFAULT_SETTINGS.radarMinCoverage),
    priorBaseBoost: clamp(source.priorBaseBoost, 0, 10, DEFAULT_SETTINGS.priorBaseBoost),
    priorCategoryBoost: clamp(source.priorCategoryBoost, 0, 10, DEFAULT_SETTINGS.priorCategoryBoost),
    qualityGateEnabled: source.qualityGateEnabled !== false,
    qualityGateMinCoverage: clamp(source.qualityGateMinCoverage, 0, 1, DEFAULT_SETTINGS.qualityGateMinCoverage),
    qualityGateMinDistinct: Math.floor(clamp(source.qualityGateMinDistinct, 1, 5, DEFAULT_SETTINGS.qualityGateMinDistinct)),
    qualityGateMinMargin: clamp(source.qualityGateMinMargin, 0, 10, DEFAULT_SETTINGS.qualityGateMinMargin),
    autoLoadScore: clamp(source.autoLoadScore, 0, 100, DEFAULT_SETTINGS.autoLoadScore),
    autoLoadCoverage: clamp(source.autoLoadCoverage, 0, 1, DEFAULT_SETTINGS.autoLoadCoverage),
    autoLoadMax: Math.floor(clamp(source.autoLoadMax, 0, 2, DEFAULT_SETTINGS.autoLoadMax)),
    maxBodyChars: Math.floor(clamp(source.maxBodyChars, 500, 20000, DEFAULT_SETTINGS.maxBodyChars)),
    sessionBudgetTokens: Math.floor(clamp(source.sessionBudgetTokens, 0, 200000, DEFAULT_SETTINGS.sessionBudgetTokens)),
    embeddingEnabled: source.embeddingEnabled === true,
    embeddingBaseUrl: typeof source.embeddingBaseUrl === 'string' ? source.embeddingBaseUrl.trim() : '',
    embeddingModel: typeof source.embeddingModel === 'string' && source.embeddingModel.trim() ? source.embeddingModel.trim() : DEFAULT_SETTINGS.embeddingModel,
    embeddingApiKeyEnv: typeof source.embeddingApiKeyEnv === 'string' && source.embeddingApiKeyEnv.trim() ? source.embeddingApiKeyEnv.trim() : DEFAULT_SETTINGS.embeddingApiKeyEnv,
    embeddingTopN: Math.floor(clamp(source.embeddingTopN, 5, 100, DEFAULT_SETTINGS.embeddingTopN)),
    takeoverSkill: source.takeoverSkill === true,
    deferScout: source.deferScout === true,
    onlineSources: normalizeOnlineSources(source.onlineSources),
    securityScanDefault: source.securityScanDefault !== false,
    requireSignature: source.requireSignature === true,
    installDir: typeof source.installDir === 'string' ? source.installDir.slice(0, 500) : '',
    autoAcquire: source.autoAcquire === true,
    autoDisableBroken: source.autoDisableBroken === true,
    autoSearch: source.autoSearch !== false,
    autoEnable: source.autoEnable === true,
    dryRun: source.dryRun === true,
    trustedOwners: (Array.isArray(source.trustedOwners) ? source.trustedOwners : [])
      .map((owner) => String(owner || '').trim().toLowerCase().replace(/\/.*$/, ''))
      .filter((owner) => /^[a-z0-9._-]+$/.test(owner))
      .slice(0, 20),
    nudges: source.nudges !== false,
    actionBudget: Math.floor(clamp(source.actionBudget, 0, 20, DEFAULT_SETTINGS.actionBudget)),
    healthCheckHours: Math.floor(clamp(source.healthCheckHours, 0, 168, DEFAULT_SETTINGS.healthCheckHours)),
    registryRefreshHours: Math.floor(clamp(source.registryRefreshHours, 0, 168, DEFAULT_SETTINGS.registryRefreshHours)),
    skillsShRefreshHours: Math.floor(clamp(source.skillsShRefreshHours, 0, 168, DEFAULT_SETTINGS.skillsShRefreshHours)),
    skillsShLimit: Math.floor(clamp(source.skillsShLimit, 100, 10000, DEFAULT_SETTINGS.skillsShLimit)),
    useSkillsSh: source.useSkillsSh !== false,
    idleDisableDays: Math.floor(clamp(source.idleDisableDays, 0, 365, DEFAULT_SETTINGS.idleDisableDays)),
    cacheHours: Math.floor(clamp(source.cacheHours, 0, 168, DEFAULT_SETTINGS.cacheHours)),
    extraSkillDirs: Array.isArray(source.extraSkillDirs)
      ? source.extraSkillDirs.map(String).filter(Boolean).slice(0, 10) : [],
    primarySkillDir: typeof source.primarySkillDir === 'string' ? source.primarySkillDir.slice(0, 500) : '',
    disabledSkillDirs: Array.isArray(source.disabledSkillDirs)
      ? source.disabledSkillDirs.map(String).filter(Boolean).slice(0, 30) : [],
    paused: source.paused === true,
    marketEnabled: source.marketEnabled === true,
    marketIndexUrl: typeof source.marketIndexUrl === 'string' ? source.marketIndexUrl.slice(0, 300) : '',
    proSources: normalizeProSources(source.proSources),
  };
}

// v1 的阈值是按旧打分写的，升级后必须换回新默认，否则老 state 会把新算法卡死。
function migrateSettings(raw) {
  const next = normalizeSettings(raw);
  if (!raw || !Number.isFinite(Number(raw.schema)) || Number(raw.schema) < 3) {
    next.radarMinScore = DEFAULT_SETTINGS.radarMinScore;
    next.radarMinCoverage = DEFAULT_SETTINGS.radarMinCoverage;
    next.autoLoadScore = DEFAULT_SETTINGS.autoLoadScore;
    next.autoLoadCoverage = DEFAULT_SETTINGS.autoLoadCoverage;
  }
  return next;
}

function composePolicy(settings, disabled, toolName = 'skill') {
  const head = POLICY_HEAD.replace(/`skill`/g, `\`${toolName}\``);
  const level = LEVEL_POLICY[settings.autonomy] || LEVEL_POLICY.standard;
  const lines = [head, `Mode ${settings.autonomy.toUpperCase()}: ${level}`];
  if (disabled.length) {
    lines.push(`Operator-disabled skills (never load, never follow, ignore their catalog entries): ${disabled.map((name) => `\`${name}\``).join(', ')}.`);
  }
  return lines.join('\n');
}

function escapeText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function estimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const char of String(text || '')) {
    if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.95 + other / 4);
}

function renderSkillContent(skill) {
  const resource = skill && skill.resourceBase;
  let guidance = `Resources for this skill are managed by provider "${escapeText((skill && skill.provider) || 'unknown')}". Load referenced resources only as needed.`;
  if (resource && resource.kind === 'directory') {
    guidance = `Base directory for this skill: ${escapeText(resource.path)}\nResolve relative paths mentioned by this skill against the base directory. Load referenced resources only as needed.`;
  } else if (resource && resource.kind === 'url') {
    guidance = `Base URL for this skill: ${escapeText(resource.url)}\nResolve relative URLs mentioned by this skill against the base URL. Load referenced resources only as needed.`;
  }
  return `<skill_content name="${escapeText(skill.name)}">
<skill_resources>
${guidance}
</skill_resources>

<skill_instructions>
${skill.content}
</skill_instructions>
</skill_content>`;
}

// ---------------------------------------------------------------------------
// 文本信号
// ---------------------------------------------------------------------------

function addToken(map, token, weight) {
  if (!token) return;
  map.set(token, (map.get(token) || 0) + weight);
}

function stem(word) {
  if (word.length <= 4) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('es')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  if (word.endsWith('ing') && word.length > 6) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 5) return word.slice(0, -2);
  return word;
}

function tokenize(text, weight = 1) {
  const out = new Map();
  if (text === undefined || text === null) return out;
  const value = String(text).toLowerCase();
  for (const match of value.matchAll(LATIN)) {
    addToken(out, match[0], weight);
    const base = stem(match[0]);
    if (base !== match[0]) addToken(out, base, 0.72 * weight);
  }
  for (const run of value.match(CJK_RUN) || []) {
    for (let i = 0; i < run.length; i += 1) {
      addToken(out, run[i], 0.35 * weight);
      if (i + 1 < run.length) addToken(out, run.slice(i, i + 2), weight);
    }
  }
  return out;
}

// 把中文词扩成英文词、把英文词扩成中文 bigram，让中英描述能互相命中。
function expandIntoTokens(text, tokens, weight) {
  if (!text) return;
  const value = String(text).toLowerCase();
  for (const [chinese, english] of LEXICON) {
    if (value.includes(chinese)) {
      for (const term of english) addToken(tokens, term, weight);
    }
    for (const term of english) {
      if (!value.includes(term)) continue;
      const cjkTokens = tokenize(chinese);
      for (const [token, count] of cjkTokens) addToken(tokens, token, 0.6 * weight * count);
    }
  }
}

function mergeTokens(target, source, weight) {
  for (const [term, count] of source) addToken(target, term, count * weight);
  return target;
}

// 查询侧的噪声控制：虚词直接丢，泛化词降权，避免「检索/上网」这类词把金融搜索技能顶上来。
const STOPWORDS = new Set([
  '的', '了', '吗', '呢', '吧', '啊', '我', '你', '他', '她', '它', '们', '是', '有', '和', '与', '或',
  '在', '就', '都', '也', '又', '很', '太', '更', '最', '要', '会', '能', '可', '被', '把', '给', '对',
  '从', '到', '为', '以', '及', '等', '个', '些', '点', '种', '样', '里', '上', '下', '中', '这', '那',
  '帮我', '我们', '你们', '他们', '这个', '那个', '这些', '那些', '一个', '一种', '一下', '看看',
  '怎么', '怎么样', '是不是', '能不能', '可不可以', '可以', '需要', '然后', '还有', '开始', '做吧',
  '现在', '已经', '就是', '只是', '如果', '但是', '所以', '因为', '而且', '或者', '以及', '进行',
  '问题', '事情', '东西', '方面', '时候', '什么', '哪些', '哪个', '这种', '那一种', '最好', '最强',
  '比较', '非常', '真的', '直接', '先', '再', '还', '请', '帮', '做', '弄', '搞', '干',
  '我看', '看', '今天', '明天', '昨天', '本周', '上周', '这周', '谢谢', '辛苦', '多少',
  '占用', '用量', '上下文', '消耗', '余额', '套餐',
]);

const GENERIC_TERMS = new Map([
  ['检索', 0.22], ['搜索', 0.22], ['上网', 0.25], ['参考', 0.25], ['看看', 0.2], ['查一下', 0.25],
  ['能力', 0.35], ['功能', 0.35], ['工具', 0.45], ['方法', 0.4], ['方案', 0.4], ['项目', 0.55],
  ['系统', 0.55], ['平台', 0.55], ['数据', 0.75], ['文件', 0.75], ['文档', 0.85], ['处理', 0.55],
  ['分析', 0.75], ['生成', 0.75], ['写', 0.6], ['改', 0.6], ['查', 0.6], ['用', 0.35],
  ['search', 0.3], ['tool', 0.5], ['data', 0.7], ['file', 0.7], ['document', 0.8], ['generate', 0.7],
]);

function queryTokensOf(text) {
  const tokens = tokenize(text);
  const out = new Map();
  for (const [term, count] of tokens) {
    if (STOPWORDS.has(term)) continue;
    addToken(out, term, count * (GENERIC_TERMS.get(term) || 1));
  }
  for (const part of String(text || '').toLowerCase().split(/[-_/]+/)) {
    if (part.length > 1) addToken(out, part, 0.9);
  }
  expandIntoTokens(text, out, 0.85);
  return out;
}

// 领域词直接映射到技能名前缀，避免「飞书文档」被腾讯文档抢走。
const FAMILY_HINTS = [
  ['飞书', ['lark']],
  ['腾讯', ['tencent']],
  ['微信', ['wechat']],
  ['钉钉', ['dingtalk']],
  ['股票', ['hithink', 'mx']],
  ['行情', ['hithink', 'mx']],
  ['基金', ['hithink', 'mx']],
  ['研报', ['lingxi', 'hithink']],
  ['财务', ['hithink', 'mx']],
];

function queryFamilies(text) {
  const value = String(text || '').toLowerCase();
  const out = new Set();
  for (const [word, families] of FAMILY_HINTS) {
    if (!value.includes(word)) continue;
    for (const family of families) out.add(family);
  }
  return out;
}

function docLength(tokens) {
  let total = 0;
  for (const count of tokens.values()) total += count;
  return total || 1;
}

function headingsOf(content) {
  const out = [];
  if (!content) return out;
  for (const line of String(content).slice(0, 20000).split('\n')) {
    const match = /^#{1,4}\s+(.+)$/.exec(line.trim());
    if (match) out.push(match[1].trim());
    if (out.length >= 40) break;
  }
  return out;
}

function clip(text, limit) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function daysAgo(ts) {
  if (!ts) return 999;
  return Math.max(0, (Date.now() - ts) / 86400000);
}

function whenLabel(ts) {
  if (!ts) return '未用过';
  const days = daysAgo(ts);
  if (days < 1 / 24) return `${Math.max(1, Math.round(days * 24 * 60))} 分钟前`;
  if (days < 1) return `${Math.round(days * 24)} 小时前`;
  return `${Math.round(days)} 天前`;
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

function stateFile(storeDir) {
  return path.join(storeDir, 'state.json');
}

function loadState(storeDir) {
  const empty = { version: 1, skills: {}, stats: {}, groups: {}, categories: {}, samples: [], metricsHistory: [], teamPolicy: null, audit: [], pluginHistory: [], onlineRegistry: [], installHistory: [], decisions: [], outcomes: {}, routing: {}, health: null, actionLog: [], updatedAt: 0 };
  try {
    const raw = readFileSync(stateFile(storeDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1) {
      parsed.skills = parsed.skills || {};
      parsed.stats = parsed.stats || {};
      parsed.groups = parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {};
      parsed.categories = parsed.categories && typeof parsed.categories === 'object' ? parsed.categories : {};
      parsed.samples = Array.isArray(parsed.samples) ? parsed.samples : [];
      parsed.metricsHistory = Array.isArray(parsed.metricsHistory) ? parsed.metricsHistory : [];
      parsed.teamPolicy = parsed.teamPolicy && typeof parsed.teamPolicy === 'object' ? parsed.teamPolicy : null;
      parsed.outcomes = parsed.outcomes && typeof parsed.outcomes === 'object' ? parsed.outcomes : {};
      parsed.audit = Array.isArray(parsed.audit) ? parsed.audit : [];
      parsed.pluginHistory = Array.isArray(parsed.pluginHistory) ? parsed.pluginHistory : [];
      parsed.onlineRegistry = Array.isArray(parsed.onlineRegistry) ? parsed.onlineRegistry : [];
      parsed.installHistory = Array.isArray(parsed.installHistory) ? parsed.installHistory : [];
      parsed.decisions = Array.isArray(parsed.decisions) ? parsed.decisions : [];
      parsed.routing = parsed.routing && typeof parsed.routing === 'object' ? parsed.routing : {};
      parsed.health = parsed.health && typeof parsed.health === 'object' ? parsed.health : null;
      parsed.actionLog = Array.isArray(parsed.actionLog) ? parsed.actionLog : [];
      return parsed;
    }
  } catch (error) {
    try {
      const raw = readFileSync(stateFile(storeDir));
      writeFileSync(`${stateFile(storeDir)}.corrupt-${Date.now()}`, raw);
    } catch { /* keep original */ }
    const backupDir = path.join(storeDir, 'state-backups');
    try {
      const files = readdirSync(backupDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const name of files.slice(0, 5)) {
        try {
          const parsed = JSON.parse(readFileSync(path.join(backupDir, name), 'utf8'));
          if (parsed && parsed.version === 1) {
            parsed.recovery = { at: Date.now(), from: path.join(backupDir, name), error: String((error && error.message) || error) };
            return parsed;
          }
        } catch { /* try older backup */ }
      }
    } catch { /* no backups */ }
  }
  return empty;
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

function errorStatus(error) {
  const message = String((error && error.message) || error || '');
  if (/不存在|没有.*记录|not found|no such/i.test(message)) return 404;
  if (/已存在|exists|conflict/i.test(message)) return 409;
  if (/需要|必须|非法|越界|invalid|required|forbidden|cannot|不能|缺少/i.test(message)) return 400;
  return 500;
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const storeDir = (config && config.storeDir)
    || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'skill-pilot');
  const catalogFilter = config.catalogFilter !== false;
  const bodyAware = config.bodyAware !== false;
  const maxBodyEnrich = Math.min(Math.max(Number(config.maxBodyEnrich) || 16, 4), 48);
  const topLimit = Math.min(Math.max(Number(config.topLimit) || 8, 3), 20);
  const debug = config.debug === true;

  const LITE_ALLOWED_TOOLS = new Set(['skill_scout', 'skill_feedback', 'skill_manage', 'capability_check', 'acquire_skill', 'open_skill_pilot']);
  const registerLiteTool = (definition) => {
    if (LITE && !LITE_ALLOWED_TOOLS.has(definition.name)) return;
    ctx.tools.register(definition);
  };

  let state = loadState(storeDir);
  state.settings = migrateSettings(state.settings);
  let saveTimer = null;

  // ---- 加密凭据：AES-256-GCM，密钥文件 0600（不进入设置/日志/模型上下文）----
  const secretsKeyFile = path.join(storeDir, 'secrets.key');
  const secretsFile = path.join(storeDir, 'secrets.enc');
  let secretsCache = null;
  function masterKey() {
    try {
      const existing = readFileSync(secretsKeyFile);
      if (existing.length === 32) return existing;
    } catch { /* create below */ }
    mkdirSync(storeDir, { recursive: true });
    const key = randomBytes(32);
    writeFileSync(secretsKeyFile, key, { mode: 0o600 });
    return key;
  }
  function readSecrets() {
    if (secretsCache) return secretsCache;
    try {
      const payload = JSON.parse(readFileSync(secretsFile, 'utf8'));
      const decipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(payload.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString('utf8');
      secretsCache = JSON.parse(plain);
    } catch {
      secretsCache = {};
    }
    return secretsCache;
  }
  function writeSecrets(map) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(map), 'utf8'), cipher.final()]);
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(secretsFile, JSON.stringify({
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    }), { mode: 0o600 });
    secretsCache = map;
  }
  function putSecret(name, value) {
    const map = { ...readSecrets() };
    if (value) map[name] = { value, updatedAt: Date.now() };
    else delete map[name];
    writeSecrets(map);
  }
  function getSecret(name) {
    const entry = readSecrets()[name];
    return entry && typeof entry.value === 'string' ? entry.value : '';
  }

  // ---- 使用事件日志（图表数据源）---------------------------------------
  const eventsFile = path.join(storeDir, 'events.ndjson');
  const usageEvents = [];
  const dayKey = (ts) => {
    const date = new Date(ts);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  };
  const loadUsageEvents = () => {
    try {
      const cutoff = Date.now() - 120 * 86400000;
      for (const line of readFileSync(eventsFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event && event.t >= cutoff) usageEvents.push(event);
        } catch { /* skip a torn line */ }
      }
      if (usageEvents.length > 20000) usageEvents.splice(0, usageEvents.length - 20000);
    } catch { /* first run */ }
  };
  loadUsageEvents();
  const recordEvent = (kind, name, extra) => {
    const event = { t: Date.now(), kind, name, ...(extra || {}) };
    usageEvents.push(event);
    if (usageEvents.length > 20000) usageEvents.splice(0, usageEvents.length - 20000);
    try {
      mkdirSync(storeDir, { recursive: true });
      appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, 'utf8');
    } catch { /* stats must never break a turn */ }
  };
  const recordAudit = (entry) => {
    state.audit = Array.isArray(state.audit) ? state.audit : [];
    state.audit.push({ t: Date.now(), ...(entry || {}) });
    if (state.audit.length > 500) state.audit.splice(0, state.audit.length - 500);
    persist();
  };
  // 决策日志：记录"为什么选它/结果如何"，给后续会话复用。
  const recordDecision = (entry) => {
    state.decisions = Array.isArray(state.decisions) ? state.decisions : [];
    const item = { t: Date.now(), ...(entry || {}) };
    state.decisions.push(item);
    if (state.decisions.length > 300) state.decisions.splice(0, state.decisions.length - 300);
    persist();
    return item;
  };
  const recordSample = (entry) => {
    state.samples = Array.isArray(state.samples) ? state.samples : [];
    state.samples.push({ t: Date.now(), ...(entry || {}) });
    if (state.samples.length > 500) state.samples.splice(0, state.samples.length - 500);
    persist();
  };
  const recordFeedback = (entry) => {
    const skill = String((entry && entry.skill) || '').trim();
    if (!skill) return { ok: false, error: 'skill required' };
    const success = entry.success === true;
    state.outcomes = state.outcomes && typeof state.outcomes === 'object' ? state.outcomes : {};
    const current = state.outcomes[skill] || { ok: 0, fail: 0, last: 0 };
    if (success) current.ok = (current.ok || 0) + 1;
    else current.fail = (current.fail || 0) + 1;
    current.last = Date.now();
    current.query = String((entry && entry.query) || '').slice(0, 300);
    state.outcomes[skill] = current;
    recordDecision({ kind: 'feedback', query: current.query, skill, outcome: success ? 'success' : 'failed', note: String((entry && entry.note) || '').slice(0, 200) });
    recordSample({ source: 'feedback', query: current.query, expected: skill, chosen: skill, hit: success });
    recordAudit({ actor: 'ai', action: 'feedback', target: skill, detail: success ? 'success' : 'failed' });
    persist();
    return { ok: true, skill, okCount: current.ok, failCount: current.fail };
  };
  const normalizeRouteKey = (query) => String(query || '').trim().toLowerCase().slice(0, 300);
  const pushAction = (entry) => {
    state.actionLog = Array.isArray(state.actionLog) ? state.actionLog : [];
    state.actionLog.push({ at: Date.now(), ...(entry || {}) });
    if (state.actionLog.length > 50) state.actionLog.splice(0, state.actionLog.length - 50);
    persist();
  };
  function learnRoute(query, skillName) {
    const key = normalizeRouteKey(query);
    if (!key || !skillName) return;
    state.routing = state.routing && typeof state.routing === 'object' ? state.routing : {};
    const previous = state.routing[key];
    state.routing[key] = {
      skill: skillName,
      count: (previous && previous.skill === skillName ? Number(previous.count) || 0 : 0) + 1,
      at: Date.now(),
    };
    recordDecision({ kind: 'load', query: key, skill: skillName });
  }
  function applyRoutingBoost(scored, queryText) {
    const key = normalizeRouteKey(queryText);
    const routes = state.routing || {};
    if (!key) return scored;
    let route = routes[key];
    if (!route) {
      for (const [stored, info] of Object.entries(routes)) {
        if (stored && (key.includes(stored) || stored.includes(key))) {
          route = info;
          break;
        }
      }
    }
    if (!route || !route.skill) return scored;
    for (const item of scored) {
      if (item.doc.name === route.skill) item.score += 3;
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }


  function usageReport(rangeDays) {
    const days = Math.max(1, Math.min(Math.floor(rangeDays) || 7, 90));
    const start = Date.now() - days * 86400000;
    const buckets = new Map();
    const bySkill = new Map();
    let loads = 0;
    let autos = 0;
    let toggles = 0;
    for (const event of usageEvents) {
      if (!event || event.t < start) continue;
      const key = dayKey(event.t);
      const bucket = buckets.get(key) || { date: key, loads: 0, auto: 0, toggles: 0 };
      if (event.kind === 'load' || event.kind === 'auto') {
        loads += 1;
        bySkill.set(event.name, (bySkill.get(event.name) || 0) + 1);
        if (event.kind === 'auto') {
          autos += 1;
          bucket.auto += 1;
        }
        bucket.loads += 1;
      } else if (event.kind === 'toggle') {
        toggles += 1;
        bucket.toggles += 1;
      }
      buckets.set(key, bucket);
    }
    const series = [];
    for (let index = days - 1; index >= 0; index -= 1) {
      const key = dayKey(Date.now() - index * 86400000);
      series.push(buckets.get(key) || { date: key, loads: 0, auto: 0, toggles: 0 });
    }
    const top = [...bySkill.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    let lastLoadAt = 0;
    let lastToggleAt = 0;
    for (const event of usageEvents) {
      if (!event) continue;
      if ((event.kind === 'load' || event.kind === 'auto') && event.t > lastLoadAt) lastLoadAt = event.t;
      if (event.kind === 'toggle' && event.t > lastToggleAt) lastToggleAt = event.t;
    }
    return {
      rangeDays: days,
      series,
      top,
      totals: { loads, autos, toggles, lastLoadAt, lastToggleAt, auditCount: Array.isArray(state.audit) ? state.audit.length : 0 },
    };
  }
  const stateBackupDir = path.join(storeDir, 'state-backups');
  const persistNow = () => {
    try {
      mkdirSync(storeDir, { recursive: true });
      state.updatedAt = Date.now();
      if (existsSync(stateFile(storeDir))) {
        try {
          mkdirSync(stateBackupDir, { recursive: true });
          copyFileSync(stateFile(storeDir), path.join(stateBackupDir, `state-${Date.now()}.json`));
          const backups = readdirSync(stateBackupDir).filter((name) => name.endsWith('.json')).sort();
          for (const name of backups.slice(0, Math.max(0, backups.length - 5))) {
            try { rmSync(path.join(stateBackupDir, name), { force: true }); } catch { /* keep */ }
          }
        } catch { /* backup is best effort */ }
      }
      writeAtomic(stateFile(storeDir), JSON.stringify(state, null, 2));
    } catch (error) {
      if (debug) console.error('dsh-skill-pilot: persist failed', error);
    }
  };
  const persist = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      persistNow();
    }, 600);
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
  };
  const flushState = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    persistNow();
  };
  const exitFlush = () => flushState();
  process.once('exit', exitFlush);

  function pruneManagedDirs() {
    const targets = [
      { dir: path.join(storeDir, 'mcp-packages'), keep: 30 },
      { dir: path.join(storeDir, 'skill-backups'), keep: 20 },
    ];
    for (const target of targets) {
      try {
        if (!existsSync(target.dir)) continue;
        const entries = readdirSync(target.dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => {
            const full = path.join(target.dir, entry.name);
            let mtime = 0;
            try { mtime = statSync(full).mtimeMs; } catch { /* ignore */ }
            return { full, mtime };
          })
          .sort((a, b) => b.mtime - a.mtime);
        let removed = 0;
        for (const entry of entries.slice(target.keep)) {
          try { rmSync(entry.full, { recursive: true, force: true }); removed += 1; } catch { /* keep */ }
        }
        if (removed) recordAudit({ actor: 'system', action: 'prune_store', target: path.basename(target.dir), detail: `${removed} removed` });
      } catch { /* best effort */ }
    }
  }
  pruneManagedDirs();

  const skillMeta = (skillName) => (state.skills[skillName] || (state.skills[skillName] = {}));
  const isEnabled = (skillName) => skillMeta(skillName).enabled !== false;
  const disabledNames = () => {
    const out = new Set();
    for (const [key, meta] of Object.entries(state.skills)) {
      if (meta && meta.enabled === false) out.add(key);
    }
    return out;
  };

  // 会话级缓存的软上限：超过后淘汰最久未访问的会话，避免长期运行内存只增不减。
  const SESSION_CACHE_LIMIT = 200;
  function sessionMap() {
    const map = new Map();
    return {
      get(key) {
        if (!map.has(key)) return undefined;
        const value = map.get(key);
        map.delete(key);
        map.set(key, value);
        return value;
      },
      set(key, value) {
        if (map.has(key)) map.delete(key);
        map.set(key, value);
        while (map.size > SESSION_CACHE_LIMIT) {
          const oldest = map.keys().next().value;
          if (oldest === undefined) break;
          map.delete(oldest);
        }
        return this;
      },
      has(key) { return map.has(key); },
      delete(key) { return map.delete(key); },
      clear() { map.clear(); },
      get size() { return map.size; },
      keys() { return map.keys(); },
      values() { return map.values(); },
      entries() { return map.entries(); },
    };
  }

  // 每一次会话里已经加载过的技能，避免重复推荐
  const loaded = sessionMap();
  // 自动雷达：每个 turn 只注入一次；按会话记 token 预算
  const injectedTurns = sessionMap();
  const autoUsage = sessionMap();
  // 主动提示：每个会话最多 2 条，按模式去重
  const nudgeSeen = sessionMap();
  // 动作级自主：每个会话的自动动作计数（受 actionBudget 限制）
  const autoActionCounts = sessionMap();
  const recentFileCache = new Map();

  function recentWorkspaceFiles(cwd) {
    if (!cwd) return [];
    const cached = recentFileCache.get(cwd);
    if (cached && Date.now() - cached.at < 30000) return cached.files;
    const supported = /\.(pdf|xlsx?|pptx?|docx?|csv|md|png|jpe?g|webp|mp4|mov|mkv)$/i;
    const files = [];
    try {
      for (const name of readdirSync(cwd).slice(0, 300)) {
        if (!supported.test(name)) continue;
        try {
          const info = statSync(path.join(cwd, name));
          if (info.isFile() && Date.now() - info.mtimeMs < 10 * 60000) files.push(name);
        } catch { /* skip unreadable */ }
      }
    } catch { /* ignore */ }
    const result = files.slice(0, 5);
    recentFileCache.set(cwd, { at: Date.now(), files: result });
    return result;
  }
  // 接管 skill 工具（可选）：隐藏内置目录发布，改用 skill_load + 自注入紧凑目录
  const takeover = { on: false, error: '' };
  const takeoverCatalog = new Map();
  const toolName = () => (takeover.on ? 'skill_load' : 'skill');

  // ---- 索引缓存 ----------------------------------------------------------
  let indexCache = new Map();
  const headingCache = new Map();
  const invalidate = () => {
    indexCache = new Map();
    headingCache.clear();
  };
  ctx.on('skills/change', invalidate);
  ctx.effect(() => () => {
    process.removeListener('exit', exitFlush);
    flushState();
    invalidate();
    clearTakeoverAgents();
  });

  async function lookupOptions(agent, signal) {
    const cwd = agent && ctx.workingDirectory
      ? await ctx.workingDirectory.ensure(agent, signal)
      : process.cwd();
    return { cwd, scope: agent, signal };
  }

  const FIELD_WEIGHTS = { name: 2.0, when: 1.6, desc: 1.0, headings: 1.0, extra: 0.5 };

  async function buildDocs(agent, signal) {
    const options = await lookupOptions(agent, signal);
    const key = `${(agent && agent.id) || 'global'}|${options.cwd}`;
    const cached = indexCache.get(key);
    if (cached && Date.now() - cached.time < 20000) return cached;
    const skills = await ctx.skills.list({ cwd: options.cwd, scope: agent, signal });
    const docs = [];
    for (const skill of skills) {
      const meta = state.skills[skill.name] || {};
      const stat = state.stats[skill.name] || {};
      const fields = {
        name: tokenize(skill.name.replace(/-/g, ' ')),
        when: tokenize(skill.whenToUse || ''),
        desc: tokenize(skill.description || ''),
        headings: new Map(),
        extra: new Map(),
      };
      expandIntoTokens(`${skill.name.replace(/-/g, ' ')} ${skill.description || ''} ${skill.whenToUse || ''}`, fields.extra, 1);
      const lens = {};
      for (const field of Object.keys(FIELD_WEIGHTS)) lens[field] = docLength(fields[field]);
      docs.push({
        name: skill.name,
        description: skill.description || '',
        whenToUse: skill.whenToUse || '',
        source: skill.source || '',
        provider: skill.provider || '',
        fields,
        lens,
        count: Number(stat.count) || 0,
        last: Number(stat.last) || 0,
        pin: meta.pin === true,
        enabled: meta.enabled !== false,
        headings: null,
      });
    }
    const df = new Map();
    for (const doc of docs) {
      const seen = new Set();
      for (const field of Object.keys(FIELD_WEIGHTS)) {
        for (const term of doc.fields[field].keys()) seen.add(term);
      }
      for (const term of seen) df.set(term, (df.get(term) || 0) + 1);
    }
    const total = docs.length;
    const avgLen = {};
    for (const field of Object.keys(FIELD_WEIGHTS)) {
      avgLen[field] = docs.reduce((sum, doc) => sum + doc.lens[field], 0) / (total || 1);
    }
    const built = { time: Date.now(), cwd: options.cwd, docs, df, total, avgLen, byName: new Map(docs.map((d) => [d.name, d])) };
    indexCache.set(key, built);
    return built;
  }

  // 把只读扫描到的外部技能并入检索索引（用于几百技能基准；不改变 scout 的默认视图）。
  async function buildDocsWithExternal(agent, signal) {
    const base = await buildDocs(agent, signal);
    let external = Array.isArray(state.interop && state.interop.skills) ? state.interop.skills : [];
    if (!external.length) {
      try { external = scanInterop().skills; } catch { external = []; }
    }
    const existing = new Set(base.docs.map((doc) => doc.name));
    const extra = [];
    for (const skill of external) {
      if (!skill || !skill.name || existing.has(skill.name)) continue;
      existing.add(skill.name);
      const fields = {
        name: tokenize(String(skill.name).replace(/-/g, ' ')),
        when: tokenize(''),
        desc: tokenize(String(skill.description || '')),
        headings: new Map(),
        extra: new Map(),
      };
      expandIntoTokens(`${String(skill.name).replace(/-/g, ' ')} ${skill.description || ''}`, fields.extra, 1);
      const lens = {};
      for (const field of Object.keys(FIELD_WEIGHTS)) lens[field] = docLength(fields[field]);
      extra.push({
        name: skill.name, description: skill.description || '', whenToUse: '',
        source: skill.platform || 'external', provider: skill.format || 'external',
        fields, lens, count: 0, last: 0, pin: false, enabled: true, headings: null,
      });
    }
    const baseDocs = base.docs.map((doc) => ({ ...doc, base: true }));
    const docs = baseDocs.concat(extra);
    const df = new Map();
    for (const doc of docs) {
      const seen = new Set();
      for (const field of Object.keys(FIELD_WEIGHTS)) {
        for (const term of doc.fields[field].keys()) seen.add(term);
      }
      for (const term of seen) df.set(term, (df.get(term) || 0) + 1);
    }
    const avgLen = {};
    for (const field of Object.keys(FIELD_WEIGHTS)) {
      avgLen[field] = docs.reduce((sum, doc) => sum + doc.lens[field], 0) / (docs.length || 1);
    }
    return {
      ...base, docs, df, avgLen, total: docs.length,
      byName: new Map(docs.map((doc) => [doc.name, doc])),
      externalCount: extra.length,
    };
  }


  function gateTop(scored, params = {}) {    const top = scored && scored[0];
    if (!top) return { accepted: false, top: null, margin: 0 };
    const second = scored[1];
    const margin = second && second.score > 0 ? top.score / second.score : 9;
    const minCoverage = Number(params.minCoverage ?? 0.3);
    const minDistinct = Number(params.minDistinct ?? 2);
    const minMargin = Number(params.minMargin ?? 1.05);
    return {
      accepted: top.coverage >= minCoverage && (top.matchedTerms || []).length >= minDistinct && margin >= minMargin,
      top,
      margin,
    };
  }



  async function loadEvalCases() {
    const casesFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'eval', 'cases.json');
    return JSON.parse(readFileSync(casesFile, 'utf8'));
  }

  const k1 = 1.2;
  const b = 0.75;

  function scoreDocs(index, queryTokens, agentId, includeDisabled, queryText, families, priors = {}) {
    const sessionLoaded = loaded.get(agentId) || new Set();
    const queryCats = CATEGORY_RULES
      .filter((rule) => rule.test && rule.test.test(String(queryText || '')))
      .map((rule) => rule.key);
    let totalQueryWeight = 0;
    for (const weight of queryTokens.values()) totalQueryWeight += weight;
    const loweredQuery = String(queryText || '').trim().toLowerCase();
    const scored = [];
    for (const doc of index.docs) {
      if (!includeDisabled && !doc.enabled) continue;
      let score = 0;
      let matchedWeight = 0;
      let distinct = 0;
      const matchedTerms = [];
      for (const [term, qWeight] of queryTokens) {
        const df = index.df.get(term) || 1;
        const idf = Math.log(1 + (index.total - df + 0.5) / (df + 0.5));
        let termScore = 0;
        let matched = false;
        for (const field of Object.keys(FIELD_WEIGHTS)) {
          const tf = doc.fields[field].get(term) || 0;
          if (tf <= 0) continue;
          matched = true;
          const avg = index.avgLen[field] || 1;
          termScore += FIELD_WEIGHTS[field] * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.lens[field]) / avg)));
        }
        if (!matched) continue;
        score += qWeight * termScore;
        matchedWeight += qWeight;
        distinct += 1;
        if (matchedTerms.length < 3 && term.length > 1) matchedTerms.push(term);
      }
      const coverage = totalQueryWeight > 0 ? matchedWeight / totalQueryWeight : 0;
      score *= 0.55 + 0.45 * coverage;
      if (loweredQuery && (loweredQuery.includes(doc.name) || doc.name.replace(/-/g, ' ').includes(loweredQuery))) score += 6;
      if (families && families.size) {
        for (const family of families) {
          if (doc.name === family || doc.name.startsWith(`${family}-`)) {
            score += 3;
            break;
          }
        }
      }
      let nameHits = 0;
      for (const term of queryTokens.keys()) {
        if (term.length > 1 && doc.fields.name.has(term)) nameHits += 1;
      }
      score += Math.min(nameHits, 3) * 1.2;
      if (doc.pin) score += 3;
      if (doc.count > 0) score += 0.8 * Math.log1p(doc.count);
      if (doc.last) score += 0.6 * Math.exp(-daysAgo(doc.last) / 14);
      if (sessionLoaded.has(doc.name)) score -= 0.6;
      if (!doc.enabled) score *= 0.2;
      if (doc.source.startsWith('project')) score += 0.3;
      if (doc.base && coverage > 0) score += Number(priors.baseBoost ?? state.settings.priorBaseBoost ?? 0.8) * (0.4 + 0.6 * coverage);
      if (queryCats.length && queryCats.includes(categoryOf(doc))) score += Number(priors.categoryBoost ?? state.settings.priorCategoryBoost ?? 1.0);
      const outcome = state.outcomes && state.outcomes[doc.name];
      if (outcome) score += 0.8 * Math.log1p(Number(outcome.ok) || 0) - 1.2 * Math.log1p(Number(outcome.fail) || 0);
      scored.push({ doc, score, coverage, distinct, matchedTerms });
    }
    return scored.sort((a, b2) => b2.score - a.score || b2.coverage - a.coverage);
  }

  async function deepen(index, scored, options, signal) {
    if (!bodyAware) return scored;
    const candidates = scored.slice(0, maxBodyEnrich);
    await Promise.all(candidates.map(async (item) => {
      const doc = item.doc;
      if (doc.headings !== null) return;
      const cachedHeadings = headingCache.get(doc.name);
      if (cachedHeadings) {
        doc.headings = cachedHeadings;
        mergeTokens(doc.fields.headings, cachedHeadings, 1);
        doc.lens.headings = docLength(doc.fields.headings);
        return;
      }
      try {
        const skill = await ctx.skills.get(doc.name, { cwd: options.cwd, scope: options.scope, signal });
        const tokens = tokenize(headingsOf(skill && skill.content).join(' · '));
        doc.headings = tokens;
        headingCache.set(doc.name, tokens);
        mergeTokens(doc.fields.headings, tokens, 1);
        doc.lens.headings = docLength(doc.fields.headings);
      } catch {
        doc.headings = new Map();
      }
    }));
    return scored;
  }

  // ---- 可选语义重排（OpenAI 兼容 /embeddings；默认关闭）---------------
  const embeddingState = { ready: false, error: '', model: '', vectorCount: 0 };
  let embeddingCache = new Map();
  const embeddingFile = path.join(storeDir, 'embeddings-cache.json');
  try {
    const raw = JSON.parse(readFileSync(embeddingFile, 'utf8'));
    if (raw && raw.vectors && typeof raw.vectors === 'object') {
      embeddingCache = new Map(Object.entries(raw.vectors));
    }
  } catch { /* first run */ }
  const saveEmbeddingCache = () => {
    try {
      mkdirSync(storeDir, { recursive: true });
      writeAtomic(embeddingFile, JSON.stringify({
        model: state.settings.embeddingModel,
        vectors: Object.fromEntries(embeddingCache),
      }));
    } catch { /* cache is best effort */ }
  };

  async function callEmbeddings(texts) {
    const settings = state.settings;
    const base = settings.embeddingBaseUrl.replace(/\/+$/, '');
    const apiKey = process.env[settings.embeddingApiKeyEnv] || '';
    const response = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model: settings.embeddingModel, input: texts }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`embeddings HTTP ${response.status}`);
    const json = await response.json();
    const data = Array.isArray(json.data) ? json.data : [];
    if (data.length !== texts.length) throw new Error('embeddings length mismatch');
    return data.map((item) => item.embedding);
  }

  function docText(doc) {
    const headings = [...doc.fields.headings.keys()].slice(0, 20).join(' ');
    return `${doc.name.replace(/-/g, ' ')} · ${doc.whenToUse || ''} · ${doc.description || ''} · ${headings}`;
  }

  async function ensureEmbeddings(index) {
    const settings = state.settings;
    const missing = [];
    for (const doc of index.docs) {
      const text = docText(doc);
      const key = `${settings.embeddingModel}:${digestOf(text)}`;
      if (!embeddingCache.has(key)) missing.push({ key, text });
    }
    if (missing.length) {
      const vectors = await callEmbeddings(missing.map((item) => item.text));
      missing.forEach((item, i) => embeddingCache.set(item.key, vectors[i]));
      saveEmbeddingCache();
    }
    let count = 0;
    for (const doc of index.docs) {
      const key = `${settings.embeddingModel}:${digestOf(docText(doc))}`;
      const vector = embeddingCache.get(key);
      if (vector) {
        doc.vector = vector;
        count += 1;
      }
    }
    embeddingState.ready = index.docs.length > 0 && count === index.docs.length;
    embeddingState.vectorCount = count;
    embeddingState.model = settings.embeddingModel;
  }

  function cosine(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      dot += a[index] * b[index];
      normA += a[index] * a[index];
      normB += b[index] * b[index];
    }
    return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
  }

  async function rerankWithEmbedding(index, query, scored, force) {
    const settings = state.settings;
    if (!settings.embeddingBaseUrl) return scored;
    if (!settings.embeddingEnabled && force !== true) return scored;
    try {
      await ensureEmbeddings(index);
      const [queryVector] = await callEmbeddings([query]);
      const pool = scored.slice(0, settings.embeddingTopN);
      for (const item of pool) {
        const semantic = item.doc.vector ? cosine(queryVector, item.doc.vector) : 0;
        item.semantic = Number(semantic.toFixed(3));
        item.score = item.score * 0.55 + semantic * 6;
      }
      embeddingState.error = '';
      embeddingState.ready = true;
      return [...pool, ...scored.slice(settings.embeddingTopN)].sort((a, b) => b.score - a.score);
    } catch (error) {
      embeddingState.error = String((error && error.message) || error);
      embeddingState.ready = false;
      return scored;
    }
  }

  function explain(item, query) {
    const doc = item.doc;
    const lowered = String(query || '').trim().toLowerCase();
    const reasons = [];
    if (lowered && (lowered.includes(doc.name) || doc.name.includes(lowered))) reasons.push('名称直接命中');
    if (doc.pin) reasons.push('已置顶');
    if (doc.count > 0) reasons.push(`用过 ${doc.count} 次`);
    if (doc.last && daysAgo(doc.last) < 14) reasons.push('最近用过');
    if (item.matchedTerms && item.matchedTerms.length) {
      reasons.push(`命中 ${item.matchedTerms.slice(0, 3).join('/')} · 覆盖 ${Math.round(item.coverage * 100)}%`);
    }
    if (!reasons.length) reasons.push(doc.whenToUse ? clip(doc.whenToUse, 40) : '关键词相关');
    return reasons.join(' · ');
  }

  // ---- 在线技能搜索（多来源；默认 GitHub，显式请求才联网）----------------
  async function searchGithubRepos(query, limit, signal) {
    const candidates = [`${query} agent skill`, `${query} skill`, query];
    for (const candidate of candidates) {
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(candidate)}&sort=stars&order=desc&per_page=${limit}`;
      const response = await fetch(url, {
        headers: {
          'user-agent': 'skill-pilot/1.0',
          accept: 'application/vnd.github+json',
          ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
        },
        signal: signal || AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      const json = await response.json();
      const items = Array.isArray(json.items) ? json.items : [];
      if (!items.length) continue;
      return items.map((item) => ({
        name: item.full_name,
        description: item.description || '',
        stars: Number(item.stargazers_count) || 0,
        url: item.html_url,
        install: `npx skills add ${item.full_name}`,
      }));
    }
    return [];
  }

  async function searchGithubCode(query, limit, signal) {
    const token = process.env.GITHUB_TOKEN || getSecret('github');
    if (!token) return { authRequired: true, results: [] };
    const response = await fetch(`https://api.github.com/search/code?q=${encodeURIComponent(`filename:SKILL.md ${query}`)}&per_page=${Math.min(Math.max(Number(limit) || 5, 1), 10)}`, {
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': 'skill-pilot/1.0',
        accept: 'application/vnd.github+json',
      },
      signal: signal || AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`GitHub code HTTP ${response.status}`);
    const json = await response.json();
    return {
      authRequired: false,
      results: (json.items || []).map((item) => ({
        name: `${item.repository.full_name}/${item.path.split('/').slice(-2, -1)[0] || item.path}`,
        description: `GitHub Code Search · ${item.path}`,
        url: item.html_url,
        repo: item.repository.full_name,
        path: item.path,
        source: 'GitHub Code',
        priority: 95,
      })),
    };
  }

  async function searchWebSource(query, source, limit, signal) {
    const target = source.url.includes('{q}')
      ? source.url.replaceAll('{q}', encodeURIComponent(query))
      : source.url;
    const headers = { 'user-agent': 'Mozilla/5.0 skill-pilot/1.0' };
    const sourceToken = getSecret(`source:${source.name}`);
    if (sourceToken) headers.authorization = `Bearer ${sourceToken}`;
    const response = await fetch(target, {
      headers,
      signal: signal || AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    const results = [];
    const seen = new Set();
    const navigation = new Set([
      'skills', 'packs', 'topics', 'official', 'audits', 'docs', 'blog', 'login', 'sign in',
      'pricing', 'about', 'home', 'all', 'search', 'leaderboard', 'trending', 'marketplace',
      'community', 'changelog', 'submit', 'explore', 'dashboard',
    ]);
    const loweredQuery = String(query || '').toLowerCase();
    for (const match of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const label = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (label.length < 2 || navigation.has(label.toLowerCase())) continue;
      let href = match[1];
      try {
        href = new URL(href, target).toString();
      } catch {
        continue;
      }
      if (!/^https?:\/\//i.test(href) || seen.has(href)) continue;
      seen.add(href);
      const relevance = label.toLowerCase().includes(loweredQuery) || href.toLowerCase().includes(loweredQuery) ? 2 : 1;
      results.push({ name: label.slice(0, 120), description: '', stars: 0, url: href, install: '', relevance });
    }
    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, limit).map(({ relevance: _relevance, ...item }) => item);
  }

  async function searchOnlineSkills(query, limit, signal) {
    const size = Math.min(Math.max(Number(limit) || 5, 1), 10);
    const sources = (state.settings.onlineSources || [])
      .filter((source) => source.enabled !== false)
      .sort((a, b) => b.priority - a.priority);
    if (!sources.length) throw new Error('没有启用的在线来源');
    const results = searchRegistry(query, Math.min(2, size));
    try {
      const code = await searchGithubCode(query, Math.min(2, size), signal);
      for (const item of code.results) results.push(item);
    } catch { /* code search requires a token and is optional */ }
    const perSourceCap = Math.max(1, Math.ceil(size / sources.length));
    for (const source of sources) {
      const remaining = size - results.length;
      if (remaining <= 0) break;
      try {
        const found = source.kind === 'github'
          ? await searchGithubRepos(query, Math.min(remaining, perSourceCap), signal)
          : await searchWebSource(query, source, Math.min(remaining, perSourceCap), signal);
        for (const item of found) {
          results.push({ ...item, source: source.name, priority: source.priority });
        }
      } catch (error) {
        results.push({
          name: `${source.name} 搜索失败`,
          description: String((error && error.message) || error),
          stars: 0,
          url: '',
          install: '',
          source: source.name,
          priority: source.priority,
          error: true,
        });
      }
    }
    return results.slice(0, size);
  }

  // ---- 技能级在线索引（把 GitHub 仓库索引成 SKILL.md 条目）----------------
  async function githubJson(url, signal) {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'skill-pilot/1.0',
        accept: 'application/vnd.github+json',
        ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
      signal: signal || AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    return response.json();
  }

  async function githubRaw(repo, branch, filePath, signal) {
    const encoded = encodeURI(filePath).replace(/%2F/gi, '/');
    const response = await fetch(`https://raw.githubusercontent.com/${repo}/${branch}/${encoded}`, {
      headers: { 'user-agent': 'skill-pilot/1.0' },
      signal: signal || AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`raw HTTP ${response.status}`);
    return response.text();
  }

  function parseSkillDoc(text, filePath) {
    let name = '';
    let description = '';
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || '');
    if (frontmatter) {
      for (const line of frontmatter[1].split(/\r?\n/)) {
        const match = /^([a-zA-Z_]+):\s*(.*)$/.exec(line.trim());
        if (!match) continue;
        const value = match[2].replace(/^['"]|['"]$/g, '').trim();
        if (match[1] === 'name') name = value;
        if (match[1] === 'description') description = value;
      }
    }
    if (!name) {
      const heading = /\n#\s+(.+)/.exec(`\n${text}`);
      name = heading ? heading[1].trim() : (filePath.split('/').slice(-2, -1)[0] || 'unnamed-skill');
    }
    if (!description || /^[|>][-+]?$/.test(description)) {
      const line = String(text || '').split(/\r?\n/).find((item) => item.trim() && !item.trim().startsWith('#') && !item.trim().startsWith('---'));
      description = line ? line.trim().slice(0, 200) : '';
    }
    return { name: name.slice(0, 80), description: description.slice(0, 300) };
  }

  function searchRegistry(query, limit) {
    const entries = Array.isArray(state.onlineRegistry) ? state.onlineRegistry : [];
    const lowered = String(query || '').toLowerCase();
    const tokens = lowered.split(/[\s,，、/]+/).filter((token) => token.length > 1);
    return entries
      .map((entry) => {
        const haystack = `${entry.name} ${entry.description}`.toLowerCase();
        let score = 0;
        for (const token of tokens) if (haystack.includes(token)) score += 1;
        if (entry.name.toLowerCase().includes(lowered)) score += 2;
        const usage = state.stats[entry.name] ? Number(state.stats[entry.name].count) || 0 : 0;
        const sourceWeight = entry.source === 'skills.sh' ? 3 : entry.source === 'GitHub Code' ? 2.5 : 2;
        const daysOld = entry.fetchedAt ? Math.max(0, Math.floor((Date.now() - entry.fetchedAt) / 86400000)) : 30;
        score += sourceWeight + Math.min(3, usage) + Math.max(0, 3 - daysOld * 0.1);
        return { entry, score, daysOld };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry, score }) => ({
        name: entry.name,
        description: entry.description,
        stars: 0,
        url: entry.url,
        install: '',
        repo: entry.repo,
        path: entry.path,
        source: entry.source === 'skills.sh' ? 'skills.sh' : '本地索引',
        priority: entry.source === 'skills.sh' ? 98 : 100,
        registryScore: score,
        sourceUrl: entry.sourceUrl || entry.url,
        fetchedAt: entry.fetchedAt || entry.indexedAt || 0,
        stale: Boolean(entry.fetchedAt && Date.now() - entry.fetchedAt > 7 * 86400000),
      }));
  }

  async function indexRepo(repo, signal) {
    const meta = await githubJson(`https://api.github.com/repos/${repo}`, signal);
    const branch = meta.default_branch || 'main';
    const tree = await githubJson(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`, signal);
    const files = (tree.tree || [])
      .filter((node) => node.type === 'blob' && /(^|\/)SKILL\.md$/i.test(node.path))
      .slice(0, 40);
    const entries = [];
    for (const file of files) {
      try {
        const parsed = parseSkillDoc(await githubRaw(repo, branch, file.path, signal), file.path);
        entries.push({
          ...parsed,
          repo,
          path: file.path,
          url: `https://github.com/${repo}/blob/${branch}/${file.path}`,
          indexedAt: Date.now(),
        });
      } catch { /* skip unreadable skill */ }
    }
    state.onlineRegistry = (Array.isArray(state.onlineRegistry) ? state.onlineRegistry : [])
      .filter((entry) => entry.repo !== repo)
      .concat(entries)
      .slice(-10000);
    persist();
    recordAudit({ actor: 'ui', action: 'registry_index', target: repo, detail: `${entries.length} skills` });
    return { repo, indexed: entries.length, total: state.onlineRegistry.length };
  }

  const SCAN_RULES = [
    ['high', 'pipe-to-shell', /(curl|wget)[^\n|]*\|\s*(ba)?sh/i],
    ['high', 'eval', /\beval\s*\(/],
    ['high', 'rm-rf-root', /rm\s+-rf\s+\/(\s|$)/],
    ['high', 'base64-exec', /base64\s+(-d|--decode)[^\n]*\|\s*(ba)?sh/i],
    ['high', 'code-exec', /\b(child_process|os\.system|subprocess\.(run|call|Popen))\b/],
    ['high', 'credential-path', /(\.ssh\/|id_rsa|credentials\.json)/i],
    ['high', 'secret-env', /process\.env\.[A-Z_]*(KEY|TOKEN|SECRET)/],
    ['medium', 'network-fetch', /\b(curl|wget)\b|fetch\(|https?:\/\//],
    ['medium', 'package-install', /\b(npm\s+install|pip\s+install|git\s+clone)\b/],
    ['medium', 'chmod-777', /chmod\s+777/],
    ['medium', 'sudo', /\bsudo\b/],
    ['medium', 'file-write', /\b(writeFile|appendFile|unlinkSync|rmSync|fs\.promises)\b/],
  ];

  function scanText(text) {
    const findings = [];
    let high = 0;
    let medium = 0;
    const lines = String(text || '').split(/\r?\n/);
    for (const [level, rule, regex] of SCAN_RULES) {
      for (const line of lines) {
        if (!regex.test(line)) continue;
        findings.push({ level, rule, snippet: line.trim().slice(0, 160) });
        if (level === 'high') high += 1;
        else medium += 1;
        break;
      }
    }
    return {
      risk: high ? 'high' : medium ? 'medium' : 'low',
      score: Math.min(100, high * 40 + medium * 10),
      findings: findings.slice(0, 20),
    };
  }

  async function scanRepo(repo, pathHint, signal) {
    const meta = await githubJson(`https://api.github.com/repos/${repo}`, signal);
    const branch = meta.default_branch || 'main';
    const tree = await githubJson(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`, signal);
    const files = (tree.tree || []).filter((node) => node.type === 'blob' && /(^|\/)SKILL\.md$/i.test(node.path));
    const targets = pathHint ? [pathHint] : files.slice(0, 3).map((file) => file.path);
    if (!targets.length) targets.push('README.md');
    const scans = [];
    for (const filePath of targets.slice(0, 3)) {
      try {
        const content = await githubRaw(repo, branch, filePath, signal);
        const base = scanText(content);
        scans.push({
          path: filePath, ...base,
          quality: {
            bytes: content.length,
            headings: (content.match(/^#{1,6}\s+/gm) || []).length,
            codeBlocks: (content.match(/```/g) || []).length / 2,
            hasFrontmatter: /^---\r?\n[\s\S]*?\r?\n---/.test(content),
            hasSteps: /(^|\n)\s*(1\.|步骤|step\s*1)/i.test(content),
          },
        });
      } catch (error) {
        scans.push({ path: filePath, risk: 'unknown', score: 0, findings: [], error: String((error && error.message) || error) });
      }
    }
    const metadata = {
      stars: Number(meta.stargazers_count) || 0,
      license: meta.license ? meta.license.spdx_id : null,
      updatedAt: meta.pushed_at || '',
      archived: meta.archived === true,
    };
    let risk = scans.some((scan) => scan.risk === 'high') ? 'high' : scans.some((scan) => scan.risk === 'medium') ? 'medium' : 'low';
    let score = Math.max(0, ...scans.map((scan) => scan.score || 0));
    if (metadata.stars < 10) score += 10;
    if (!metadata.license) score += 10;
    if (metadata.archived) {
      score += 20;
      risk = 'high';
    }
    if (risk === 'low' && score >= 20) risk = 'medium';
    const primary = scans[0] && scans[0].quality ? scans[0].quality : {};
    let qualityScore = 0;
    if ((primary.bytes || 0) >= 800) qualityScore += 25;
    else if ((primary.bytes || 0) >= 300) qualityScore += 12;
    if ((primary.headings || 0) >= 3) qualityScore += 20;
    if ((primary.codeBlocks || 0) >= 1) qualityScore += 15;
    if (primary.hasFrontmatter) qualityScore += 10;
    if (primary.hasSteps) qualityScore += 10;
    if (metadata.license) qualityScore += 10;
    if (metadata.stars >= 100) qualityScore += 10;
    const freshnessDays = metadata.updatedAt ? (Date.now() - Date.parse(metadata.updatedAt)) / 86400000 : 9999;
    if (freshnessDays < 365) qualityScore += 10;
    if (risk === 'medium') qualityScore -= 10;
    if (risk === 'high') qualityScore -= 30;
    return {
      repo, branch, metadata, files: targets, risk, score: Math.min(100, score), scans,
      quality: {
        score: Math.max(0, Math.min(100, qualityScore)),
        grade: qualityScore >= 70 ? 'good' : qualityScore >= 40 ? 'fair' : 'poor',
        signals: primary,
      },
    };
  }

  function installRoot() {
    const configured = typeof state.settings.installDir === 'string' ? state.settings.installDir.trim() : '';
    return configured ? path.resolve(configured) : path.join(os.homedir(), '.agents', 'skills');
  }

  async function firstSkillPath(repo, signal) {
    const meta = await githubJson(`https://api.github.com/repos/${repo}`, signal);
    const branch = meta.default_branch || 'main';
    const tree = await githubJson(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`, signal);
    const file = (tree.tree || []).find((node) => node.type === 'blob' && /(^|\/)SKILL\.md$/i.test(node.path));
    if (!file) throw new Error('仓库里没有 SKILL.md');
    return { branch, path: file.path };
  }

  async function installSkill(repo, filePath, options, signal) {
    const opts = options || {};
    const meta = await githubJson(`https://api.github.com/repos/${repo}`, signal);
    const branch = meta.default_branch || 'main';
    const selectedPath = filePath || (await firstSkillPath(repo, signal)).path;
    if (!/^[\w./ -]+$/.test(selectedPath) || selectedPath.split('/').includes('..')) {
      throw new Error('非法的技能文件路径');
    }
    const content = await githubRaw(repo, branch, selectedPath, signal);
    const parsed = parseSkillDoc(content, selectedPath);
    let targetName = parsed.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    if (!targetName || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(targetName)) throw new Error('无法从 SKILL.md 确定合法技能名');
    let scan = null;
    if (state.settings.securityScanDefault !== false) {
      scan = await scanRepo(repo, selectedPath, signal);
      if (scan.risk === 'high' && opts.force !== true) return { ok: false, blocked: 'high', scan };
      if (scan.risk === 'medium' && opts.confirm !== true) return { ok: false, blocked: 'medium', scan };
    }
    const root = installRoot();
    const targetDir = path.join(root, targetName);
    let backup = '';
    if (existsSync(targetDir)) {
      if (opts.overwrite !== true) return { ok: false, blocked: 'exists', name: targetName, dir: targetDir };
      backup = path.join(storeDir, 'skill-backups', `${targetName}-${Date.now()}`);
      mkdirSync(backup, { recursive: true });
      cpSync(targetDir, backup, { recursive: true });
    }
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(path.join(targetDir, 'SKILL.md'), content, 'utf8');
    const manifestFiles = [{ path: 'SKILL.md', sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) }];
    if (opts.multifile !== false) {
      try {
        const tree = await githubJson(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`, signal);
        const dir = path.posix.dirname(selectedPath);
        const allow = /\.(md|json|ya?ml|txt|py|js|mjs|ts|csv|html|css|toml|ini)$/i;
        const siblings = (tree.tree || [])
          .filter((node) => node.type === 'blob' && node.path !== selectedPath
            && (dir === '.' ? !node.path.includes('/') : node.path.startsWith(`${dir}/`))
            && allow.test(node.path) && Number(node.size || 0) <= 1024 * 1024)
          .slice(0, 30);
        for (const node of siblings) {
          try {
            const raw = await githubRaw(repo, branch, node.path, signal);
            const rel = path.posix.relative(dir === '.' ? '' : dir, node.path);
            const dest = path.join(targetDir, rel);
            mkdirSync(path.dirname(dest), { recursive: true });
            writeFileSync(dest, raw, 'utf8');
            manifestFiles.push({ path: rel, sha256: createHash('sha256').update(raw).digest('hex'), bytes: Buffer.byteLength(raw) });
          } catch { /* skip one resource */ }
        }
      } catch { /* tree optional */ }
    }
    let commit = '';
    try {
      const commits = await githubJson(`https://api.github.com/repos/${repo}/commits?per_page=1`, signal);
      commit = commits && commits[0] ? String(commits[0].sha || '') : '';
    } catch { /* commit optional */ }
    const sha256 = manifestFiles[0].sha256;
    const integrity = createHash('sha256')
      .update(manifestFiles.map((file) => `${file.path}:${file.sha256}`).sort().join('\n'))
      .digest('hex');
    const signature = signIntegrity(integrity);
    const manifest = {
      name: targetName,
      repo,
      path: selectedPath,
      branch,
      commit,
      version: commit ? commit.slice(0, 8) : 'unversioned',
      sha256,
      integrity,
      signature,
      files: manifestFiles,
      installedAt: Date.now(),
      risk: scan ? scan.risk : 'unchecked',
    };
    writeFileSync(path.join(targetDir, 'install.json'), JSON.stringify(manifest, null, 2), 'utf8');
    const entry = {
      name: targetName,
      repo,
      path: selectedPath,
      dir: targetDir,
      backup,
      risk: scan ? scan.risk : 'unchecked',
      commit,
      version: manifest.version,
      integrity,
      fileCount: manifestFiles.length,
      sha256,
      at: Date.now(),
    };
    state.installHistory = (Array.isArray(state.installHistory) ? state.installHistory : []).concat([entry]).slice(-50);
    state.onlineRegistry = (Array.isArray(state.onlineRegistry) ? state.onlineRegistry : [])
      .filter((item) => item.name !== targetName)
      .concat([{
        name: targetName,
        description: parsed.description,
        repo,
        path: selectedPath,
        url: `https://github.com/${repo}/blob/${branch}/${selectedPath}`,
        indexedAt: Date.now(),
      }])
      .slice(-10000);
    persist();
    recordAudit({ actor: 'ui', action: 'install', target: targetName, detail: `${repo}${scan ? ` risk=${scan.risk}` : ''}` });
    return { ok: true, name: targetName, dir: targetDir, backup, risk: scan ? scan.risk : 'unchecked', manifest };
  }

  function verifyInstall(name) {
    const history = Array.isArray(state.installHistory) ? state.installHistory : [];
    const entry = [...history].reverse().find((item) => item.name === name);
    if (!entry) throw new Error(`没有 ${name} 的安装记录`);
    const manifestFile = path.join(entry.dir, 'install.json');
    if (!existsSync(manifestFile)) throw new Error('install.json 缺失');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const mismatches = [];
    let actualIntegrity = createHash('sha256').update('').digest('hex');
    const actualFiles = [];
    for (const file of manifest.files || []) {
      const target = path.join(entry.dir, file.path);
      if (!existsSync(target)) {
        mismatches.push({ path: file.path, reason: 'missing' });
        actualFiles.push({ path: file.path, sha256: '' });
        continue;
      }
      const hash = createHash('sha256').update(readFileSync(target)).digest('hex');
      actualFiles.push({ path: file.path, sha256: hash });
      if (hash !== file.sha256) mismatches.push({ path: file.path, reason: 'sha256' });
    }
    if (actualFiles.length) {
      actualIntegrity = createHash('sha256')
        .update(actualFiles.map((file) => `${file.path}:${file.sha256}`).sort().join('\n'))
        .digest('hex');
    }
    const signatureValid = verifyIntegrity(actualIntegrity, manifest.signature);
    return {
      name, version: manifest.version || '', commit: manifest.commit || '',
      fileCount: (manifest.files || []).length, verified: mismatches.length === 0 && signatureValid,
      hashOk: mismatches.length === 0, signatureValid,
      mismatches, dir: entry.dir, integrity: manifest.integrity || '',
    };
  }

  async function rollbackInstall(name) {
    const history = (Array.isArray(state.installHistory) ? state.installHistory : []).filter((entry) => entry.name === name);
    const last = history[history.length - 1];
    if (!last) throw new Error(`没有 ${name} 的安装记录`);
    const targetDir = last.dir || path.join(installRoot(), name);
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    if (last.backup && existsSync(last.backup)) {
      mkdirSync(targetDir, { recursive: true });
      cpSync(last.backup, targetDir, { recursive: true });
    }
    state.installHistory = (Array.isArray(state.installHistory) ? state.installHistory : []).filter((entry) => entry !== last && existsSync(entry.dir));
    state.onlineRegistry = (Array.isArray(state.onlineRegistry) ? state.onlineRegistry : []).filter((entry) => entry.name !== name);
    persist();
    recordAudit({ actor: 'ui', action: 'install_rollback', target: name, detail: last.backup ? 'restored backup' : 'removed' });
    return { name, restored: Boolean(last.backup), dir: targetDir };
  }

  // ---- 能力地图 / 缺口获取 / 决策日志 ---------------------------------
  async function capabilityReport(agent, task, limit) {
    const index = await buildDocs(agent, undefined);
    const queryTokens = queryTokensOf(task);
    let scored = scoreDocs(index, queryTokens, agent && agent.id, false, task, queryFamilies(task));
    scored = await rerankWithEmbedding(index, task, scored);
    const top = scored.filter((item) => item.score > 0.02).slice(0, Math.min(Math.max(Number(limit) || 5, 1), 8));
    const best = top[0];
    const level = !best ? 'missing' : best.score >= 2.5 && best.coverage >= 0.2 ? 'owned' : best.score >= 1.2 ? 'partial' : 'missing';
    return { level, top };
  }

  async function crawlRegistry(options, signal) {
    const source = options || {};
    const queries = (Array.isArray(source.queries) && source.queries.length ? source.queries : ['agent skills', 'claude skills'])
      .map((query) => String(query).trim())
      .filter(Boolean)
      .slice(0, 3);
    const limitRepos = Math.min(Math.max(Number(source.limitRepos) || 5, 1), 10);
    const repos = [];
    for (const query of queries) {
      if (repos.length >= limitRepos) break;
      try {
        const found = await searchGithubRepos(query, Math.min(5, limitRepos), signal);
        for (const item of found) {
          if (item.name && !repos.includes(item.name)) repos.push(item.name);
        }
      } catch { /* rate limit or network: keep other queries */ }
    }
    const selected = repos.slice(0, limitRepos);
    const results = [];
    for (const repo of selected) {
      try {
        const indexed = await indexRepo(repo, signal);
        results.push({ repo, indexed: indexed.indexed });
      } catch (error) {
        results.push({ repo, error: String((error && error.message) || error) });
      }
    }
    return { queries, repos: selected, results, total: (state.onlineRegistry || []).length };
  }

  function decodeHtml(text) {
    return String(text || '')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }

  async function crawlSkillsSh(limit, signal, enrichLimit) {
    const size = Math.min(Math.max(Number(limit) || Number(state.settings.skillsShLimit) || 2000, 50), 10000);
    const indexResponse = await fetch('https://www.skills.sh/sitemap.xml', {
      headers: { 'user-agent': 'skill-pilot/1.0' }, signal: signal || AbortSignal.timeout(20000),
    });
    if (!indexResponse.ok) throw new Error(`skills.sh sitemap HTTP ${indexResponse.status}`);
    const indexXml = await indexResponse.text();
    const sitemaps = [...indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map((match) => match[1].trim())
      .filter((url) => /sitemap-skills/.test(url));
    const urls = [];
    for (const sitemapUrl of sitemaps.slice(0, 4)) {
      if (urls.length >= size) break;
      try {
        const response = await fetch(sitemapUrl, {
          headers: { 'user-agent': 'skill-pilot/1.0' }, signal: signal || AbortSignal.timeout(30000),
        });
        if (!response.ok) continue;
        const xml = await response.text();
        for (const match of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
          const url = match[1].trim();
          if (!/^https:\/\/www\.skills\.sh\/[^/]+\/[^/]+\/.+/.test(url)) continue;
          urls.push(url);
          if (urls.length >= size) break;
        }
      } catch { /* keep other sitemaps */ }
    }
    const now = Date.now();
    const entries = urls.slice(0, size).map((url) => {
      const parts = url.replace('https://www.skills.sh/', '').split('/');
      const owner = parts[0] || '';
      const repo = parts[1] || '';
      const skill = parts.slice(2).join('/') || repo;
      return {
        name: skill,
        description: '',
        repo: `${owner}/${repo}`,
        path: '',
        url,
        source: 'skills.sh',
        sourceUrl: url,
        fetchedAt: now,
        indexedAt: now,
      };
    });
    const enrichCount = Math.min(Math.max(Number(enrichLimit) || 0, 0), 60);
    for (const entry of entries.slice(0, enrichCount)) {
      try {
        const page = await fetch(entry.url, {
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; skill-pilot/1.0)' },
          signal: AbortSignal.timeout(8000),
        });
        if (!page.ok) continue;
        const html = await page.text();
        const match = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)
          || /<meta\s+property="og:description"\s+content="([^"]*)"/i.exec(html);
        if (match) entry.description = decodeHtml(match[1]).slice(0, 300);
      } catch { /* enrichment is optional */ }
    }
    const existing = Array.isArray(state.onlineRegistry) ? state.onlineRegistry : [];
    const byUrl = new Map(existing.map((entry) => [entry.url, entry]));
    for (const entry of entries) byUrl.set(entry.url, { ...(byUrl.get(entry.url) || {}), ...entry });
    state.onlineRegistry = [...byUrl.values()].slice(-10000);
    persist();
    recordAudit({ actor: 'ui', action: 'skills_sh_crawl', detail: `${entries.length} skills` });
    return {
      indexed: entries.length,
      total: state.onlineRegistry.length,
      sample: entries.slice(0, 5).map((entry) => ({ name: entry.name, repo: entry.repo })),
    };
  }

  async function enrichSkillsSh(limit, signal) {
    const size = Math.min(Math.max(Number(limit) || 20, 1), 60);
    const entries = (Array.isArray(state.onlineRegistry) ? state.onlineRegistry : [])
      .filter((entry) => entry.source === 'skills.sh' && !entry.description)
      .slice(0, size);
    let enriched = 0;
    for (const entry of entries) {
      try {
        const page = await fetch(entry.url, {
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; skill-pilot/1.0)' },
          signal: signal || AbortSignal.timeout(8000),
        });
        if (!page.ok) continue;
        const html = await page.text();
        const match = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html)
          || /<meta\s+property="og:description"\s+content="([^"]*)"/i.exec(html);
        if (match) {
          entry.description = decodeHtml(match[1]).slice(0, 300);
          enriched += 1;
        }
      } catch { /* skip page */ }
    }
    if (enriched) persist();
    return { enriched, total: entries.length };
  }

  // ---- 只读互操作扫描：外部技能/插件/MCP 配置（不改外部文件）-----------
  function interopRoots() {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const profileDir = process.env.DSH_PROFILE_DIR || path.join(home, 'profiles', 'desktop');
    const cwd = process.cwd();
    let dataHome = '';
    try { dataHome = path.dirname(realpathSync(home)); } catch { /* keep empty */ }
    const roots = [
      { path: path.join(home, 'skills'), platform: 'dsh', format: 'skill-md' },
      { path: path.join(home, '..', 'agents', 'skills'), platform: 'dsh-agents', format: 'skill-md' },
      ...(dataHome ? [{ path: path.join(dataHome, 'agents', 'skills'), platform: 'dsh-agents', format: 'skill-md' }] : []),
      { path: path.join(profileDir, 'skills'), platform: 'dsh-profile', format: 'skill-md' },
      { path: path.join(cwd, '.dsh', 'skills'), platform: 'project-dsh', format: 'skill-md' },
      { path: path.join(cwd, '.agents', 'skills'), platform: 'project-agents', format: 'skill-md' },
      { path: path.join(cwd, '.claude', 'skills'), platform: 'claude', format: 'skill-md' },
      { path: path.join(os.homedir(), '.claude', 'skills'), platform: 'claude', format: 'skill-md' },
      { path: path.join(cwd, '.codex', 'skills'), platform: 'codex', format: 'skill-md' },
      { path: path.join(os.homedir(), '.codex', 'skills'), platform: 'codex', format: 'skill-md' },
    ];
    const seen = new Set();
    return roots.filter((root) => {
      if (seen.has(root.path)) return false;
      seen.add(root.path);
      return existsSync(root.path);
    });
  }

  function parseSkillMeta(text) {
    const source = String(text || '');
    const meta = {};
    const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (block) {
      for (const line of block[1].split(/\r?\n/)) {
        const match = /^([A-Za-z_-]+):\s*(.*)$/.exec(line.trim());
        if (match) meta[match[1]] = match[2].replace(/^["']|["']$/g, '');
      }
    }
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    if (!meta.description || /^[|>][-+]?$/.test(meta.description)) {
      const line = body.split(/\r?\n/).find((item) => item.trim() && !item.trim().startsWith('#'));
      meta.description = line ? line.trim().slice(0, 240) : '';
    }
    return {
      name: String(meta.name || meta.title || '').trim(),
      description: String(meta.description || '').slice(0, 300),
      whenToUse: String(meta.whenToUse || meta.when_to_use || '').slice(0, 240),
    };
  }

  function walkSkillDirs(root, platform, format, out, depth) {
    if (depth > 2) return;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const file = path.join(dir, 'SKILL.md');
      if (existsSync(file)) {
        try {
          const meta = parseSkillMeta(readFileSync(file, 'utf8'));
          out.push({
            name: meta.name || entry.name,
            description: meta.description,
            whenToUse: meta.whenToUse,
            path: file,
            platform,
            format,
          });
        } catch { /* unreadable */ }
      }
      walkSkillDirs(dir, platform, format, out, depth + 1);
    }
  }

  function scanMcpConfigs() {
    const candidates = [
      path.join(os.homedir(), '.cursor', 'mcp.json'),
      path.join(os.homedir(), '.claude', 'claude_desktop_config.json'),
      path.join(process.env.APPDATA || '', 'Claude', 'claude_desktop_config.json'),
      path.join(os.homedir(), '.codex', 'config.json'),
    ];
    const found = [];
    for (const file of candidates) {
      if (!file || !existsSync(file)) continue;
      try {
        const json = JSON.parse(readFileSync(file, 'utf8'));
        const servers = json.mcpServers || json.servers || {};
        for (const name of Object.keys(servers)) found.push({ name, config: file });
      } catch { /* not JSON */ }
    }
    return found;
  }

  function scanInterop(extraDirs = [], options = {}) {
    const roots = options.onlyPath
      ? [{ path: options.onlyPath, platform: 'custom', format: 'custom' }]
      : interopRoots();
    let customRoots = [];
    if (!options.onlyPath) {
      customRoots = [...(Array.isArray(state.settings.extraSkillDirs) ? state.settings.extraSkillDirs : []), ...(Array.isArray(extraDirs) ? extraDirs : [])]
        .map((item) => String(item || '').trim())
        .filter((item, index, list) => item && list.indexOf(item) === index);
      for (const dir of customRoots) {
        try {
          if (existsSync(dir) && statSync(dir).isDirectory()) roots.push({ path: dir, platform: 'custom', format: 'custom' });
        } catch { /* inaccessible custom dir */ }
      }
    }
    const skills = [];
    for (const root of roots) {
      try {
        const rootFile = path.join(root.path, 'SKILL.md');
        if (existsSync(rootFile)) {
          const meta = parseSkillMeta(readFileSync(rootFile, 'utf8'));
          skills.push({
            name: meta.name || path.basename(root.path),
            description: meta.description,
            whenToUse: meta.whenToUse,
            path: rootFile,
            platform: root.platform,
            format: root.format,
          });
        }
      } catch { /* unreadable root skill */ }
      walkSkillDirs(root.path, root.platform, root.format, skills, 0);
    }
    const byName = new Map();
    const duplicates = [];
    for (const skill of skills) {
      if (byName.has(skill.name)) {
        duplicates.push({ name: skill.name, kept: byName.get(skill.name).path, skipped: skill.path });
        continue;
      }
      byName.set(skill.name, skill);
    }
    const mcpServers = scanMcpConfigs();
    const result = {
      scannedAt: Date.now(),
      roots,
      skills: [...byName.values()],
      mcpServers,
      duplicates,
      count: byName.size,
      mcpCount: mcpServers.length,
      customRoots,
    };
    state.interop = result;
    persist();
    recordAudit({ actor: 'system', action: 'interop_scan', detail: `${result.count} skills / ${result.mcpCount} mcp` });
    return result;
  }

  // ---- P4 维护自主：更新检查 / 坏技能修复 --------------------------------
  async function maintenanceScan(names, apply) {
    const history = Array.isArray(state.installHistory) ? state.installHistory : [];
    const targetNames = Array.isArray(names) && names.length
      ? names.map(String)
      : history.map((entry) => entry.name);
    const updates = [];
    for (const entry of history) {
      try {
        const meta = await githubJson(`https://api.github.com/repos/${entry.repo}`);
        const pushed = meta.pushed_at ? Date.parse(meta.pushed_at) : 0;
        if (pushed && pushed > Number(entry.at || 0) + 60000) {
          updates.push({ name: entry.name, repo: entry.repo, pushedAt: meta.pushed_at, installedAt: entry.at });
        }
      } catch { /* repo unavailable */ }
    }
    const results = [];
    for (const name of targetNames) {
      const entry = [...history].reverse().find((item) => item.name === name);
      const dir = entry ? entry.dir : path.join(installRoot(), name);
      const file = path.join(dir, 'SKILL.md');
      const item = { name, dir, status: 'ok', problems: [], repaired: false, disabled: false };
      try {
        const raw = readFileSync(file, 'utf8');
        if (!raw.trim()) item.problems.push('SKILL.md 为空');
        const parsed = parseSkillDoc(raw, file);
        if (!parsed || !parsed.name) item.problems.push('无法解析技能名');
        for (const command of parseRequires(raw)) {
          if (!commandExists(command)) item.problems.push(`缺少命令：${command}`);
        }
        for (const key of parseRequiresEnv(raw)) {
          if (!process.env[key]) item.problems.push(`缺少环境变量：${key}`);
        }
      } catch (error) {
        item.problems.push(`无法读取 SKILL.md：${String((error && error.message) || error)}`);
      }
      if (item.problems.length) {
        item.status = 'broken';
        if (apply === true) {
          if (entry && entry.repo) {
            try {
              const reinstalled = await installSkill(entry.repo, entry.path, { overwrite: true, confirm: true, force: false });
              if (reinstalled.ok) {
                item.repaired = true;
                item.status = 'repaired';
                recordAudit({ actor: 'maintenance', action: 'repair_skill', target: name, detail: entry.repo });
              } else {
                item.problems.push(`修复被阻止：${reinstalled.blocked || reinstalled.error || 'unknown'}`);
              }
            } catch (error) {
              item.problems.push(`修复失败：${String((error && error.message) || error)}`);
            }
          }
          if (!item.repaired) {
            const meta = skillMeta(name);
            if (meta.pin === true) {
              item.problems.push('置顶技能，跳过自动禁用');
            } else {
              meta.enabled = false;
              item.disabled = true;
              recordAudit({ actor: 'maintenance', action: 'disable_broken', target: name, detail: item.problems.join('；') });
            }
          }
        }
      }
      results.push(item);
    }
    const broken = results.filter((item) => item.status === 'broken');
    const repaired = results.filter((item) => item.repaired);
    const disabled = results.filter((item) => item.disabled);
    if (apply === true) {
      invalidate();
      persist();
    }
    const report = {
      at: Date.now(),
      apply: apply === true,
      checked: results.length,
      broken: broken.length,
      repaired: repaired.length,
      disabled: disabled.length,
      updates,
      results,
    };
    state.maintenance = report;
    persist();
    recordAudit({ actor: 'maintenance', action: 'scan', detail: `${report.checked} checked, ${broken.length} broken, ${repaired.length} repaired` });
    return report;
  }

  // ---- B4 签名与信任：本地 Ed25519 发布者密钥 --------------------------
  function signingKey() {
    const dir = path.join(storeDir, 'trust');
    const keyFile = path.join(dir, 'signing.key');
    const pubFile = path.join(dir, 'signing.pub');
    if (existsSync(keyFile) && existsSync(pubFile)) {
      return { privateKey: readFileSync(keyFile, 'utf8'), publicKey: readFileSync(pubFile, 'utf8') };
    }
    mkdirSync(dir, { recursive: true });
    const pair = generateKeyPairSync('ed25519');
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
    writeFileSync(keyFile, privateKey, { encoding: 'utf8', mode: 0o600 });
    writeFileSync(pubFile, publicKey, 'utf8');
    return { privateKey, publicKey };
  }

  function signIntegrity(integrity) {
    const keys = signingKey();
    return {
      algo: 'ed25519',
      publicKey: keys.publicKey,
      value: sign(null, Buffer.from(String(integrity)), keys.privateKey).toString('base64'),
    };
  }

  function verifyIntegrity(integrity, signature) {
    if (!signature || signature.algo !== 'ed25519' || !signature.value || !signature.publicKey) return false;
    try {
      return verify(null, Buffer.from(String(integrity)), signature.publicKey, Buffer.from(signature.value, 'base64'));
    } catch {
      return false;
    }
  }

  // D1：在会话里主动提示严重告警（每会话一次/每类）。
  const alertSeen = new Map();
  async function maybeAlerts(payload, decision) {
    const agent = payload && payload.agent;
    if (!agent || !agent.id) return decision;
    let report;
    try { report = computeAlerts(); } catch { return decision; }
    const urgent = (report.alerts || []).filter((item) => item.severity === 'critical' || item.severity === 'warning').slice(0, 3);
    if (!urgent.length) return decision;
    const key = `${agent.id}:${urgent.map((item) => item.id).join(',')}`;
    if (alertSeen.get(agent.id) === key) return decision;
    alertSeen.set(agent.id, key);
    return {
      ...decision,
      messages: [...decision.messages, {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `<system-reminder>\nSkill Pilot 告警：\n${urgent.map((item) => `- ${item.title}：${item.detail}`).join('\n')}\n可在面板「运行指标」查看并处理。\n</system-reminder>` }],
        source: { kind: 'skill-pilot-alert', form: 'alert' },
      }],
    };
  }

  // ---- C1 团队策略：团队下发 + 个人本地分离 -----------------------------








  // ---- C2 多平台：路径与配置位置（不依赖特定 OS）-----------------------


  // ---- D1 告警：预算 / 错误 / 健康 / 安装异常 ---------------------------
  function computeAlerts() {
    const alerts = [];
    if (state.recovery && state.recovery.at) {
      alerts.push({ id: 'recovery', severity: 'critical', title: '状态文件损坏，已从备份恢复', detail: `来源：${state.recovery.from || '备份'}` });
    }
    const budget = Math.max(0, Number(state.settings.actionBudget ?? 3));
    const used = state.autoActions && state.autoActions.day === new Date().toISOString().slice(0, 10)
      ? Number(state.autoActions.count) || 0 : 0;
    if (budget > 0 && used >= budget) {
      alerts.push({ id: 'budget', severity: 'critical', title: '今日自动动作预算已用完', detail: `${used}/${budget}，后续自动安装会被拒绝。` });
    } else if (budget > 0 && used / budget >= 0.8) {
      alerts.push({ id: 'budget', severity: 'warning', title: '自动动作预算接近上限', detail: `${used}/${budget}。` });
    }
    const decisions = Array.isArray(state.decisions) ? state.decisions : [];
    const errors = decisions.filter((entry) => ['blocked', 'budget-blocked', 'install-blocked', 'verify-failed'].includes(entry.outcome));
    const errorRate = decisions.length ? errors.length / decisions.length : 0;
    if (errors.length >= 3 && errorRate >= 0.1) {
      alerts.push({ id: 'errors', severity: 'warning', title: '自动动作错误率偏高', detail: `${errors.length}/${decisions.length}（${(errorRate * 100).toFixed(1)}%）。` });
    }
    if (state.health && Number(state.health.issues) > 0) {
      alerts.push({ id: 'health', severity: 'warning', title: '技能体检发现问题', detail: `${state.health.issues} 个技能异常，去「健康」查看。` });
    }
    const installs = Array.isArray(state.installHistory) ? state.installHistory : [];
    const missing = installs.filter((entry) => !existsSync(entry.dir));
    if (missing.length) {
      alerts.push({ id: 'installs', severity: 'warning', title: '安装记录有失效目录', detail: `${missing.length} 条记录目录不存在，可执行安装记录清理。` });
    }
    if (state.teamPolicy && state.teamPolicy.enforced && Object.keys(state.teamPolicy.enforced).length) {
      alerts.push({ id: 'team', severity: 'info', title: '团队策略生效中', detail: `强制项：${Object.keys(state.teamPolicy.enforced).join(', ')}` });
    }
    const samples = Array.isArray(state.samples) ? state.samples : [];
    if (samples.length < 50) {
      alerts.push({ id: 'samples', severity: 'info', title: '真实样本偏少', detail: `当前 ${samples.length} 条；自改进建议在 ≥50 条后启用。` });
    }
    return { at: Date.now(), alerts, critical: alerts.filter((item) => item.severity === 'critical').length };
  }

  // ---- D4 备份 / 恢复（状态 + 资源；不备份 Token）----------------------
  function backupRoot() {
    return path.join(storeDir, 'backups');
  }












  const REGIONS = [
    { key: 'CN', label: '中国', locale: 'zh-CN', re: /中国|国内|a 股|沪深|人民币|茅台|a股/i },
    { key: 'US', label: '美国', locale: 'en-US', re: /美国|美股|纳斯达克|纽交所|美元|\bsec\b|u\.s\./i },
    { key: 'EU', label: '欧盟', locale: 'en-GB', re: /欧盟|欧洲|欧元|gdpr|eur-lex|\beu\b/i },
    { key: 'JP', label: '日本', locale: 'ja-JP', re: /日本|日元|东京|日经/i },
  ];

  function regionOf(text) {
    const value = String(text || '');
    return REGIONS.find((region) => region.re.test(value))
      || { key: 'GLOBAL', label: '全球', locale: 'en' };
  }



  async function searchProSource(query, source, limit, signal) {
    const text = String(query || '').trim();
    const timeout = () => (signal || AbortSignal.timeout(15000));
    if (source.kind === 'mdn') {
      const response = await fetch(`https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(text)}&locale=zh-CN`, {
        headers: { 'user-agent': 'skill-pilot/1.0' }, signal: timeout(),
      });
      if (!response.ok) throw new Error(`MDN HTTP ${response.status}`);
      const json = await response.json();
      return (json.documents || []).slice(0, limit).map((doc) => ({
        title: doc.title,
        url: `https://developer.mozilla.org${doc.mdn_url}`,
        description: String(doc.summary || '').replace(/\s+/g, ' ').slice(0, 200),
        publishedAt: '',
      }));
    }
    if (source.kind === 'eastmoney-report') {
      const end = new Date();
      const begin = new Date(Date.now() - 120 * 86400000);
      const format = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const url = `https://reportapi.eastmoney.com/report/list?cb=datatable&industryCode=*&pageSize=30&industry=*&rating=&ratingChange=&beginTime=${format(begin)}&endTime=${format(end)}&pageNo=1&fields=&qType=0&orgCode=&code=*&rcode=&p=1&pageNum=1`;
      const response = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://data.eastmoney.com/report/' }, signal: timeout(),
      });
      if (!response.ok) throw new Error(`研报 HTTP ${response.status}`);
      const raw = await response.text();
      const json = JSON.parse(raw.replace(/^[^(]*\(/, '').replace(/\)\s*$/, ''));
      const rows = Array.isArray(json.data) ? json.data : [];
      const tokens = text.toLowerCase().split(/\s+/).filter((token) => token.length > 1);
      const filtered = tokens.length
        ? rows.filter((row) => tokens.some((token) => String(row.title || '').toLowerCase().includes(token)
          || String(row.stockName || '').includes(token)))
        : rows;
      return filtered.slice(0, limit).map((row) => ({
        title: row.title,
        description: `${row.orgSName || ''} · ${String(row.publishDate || '').slice(0, 10)} · ${row.stockName || ''}`,
        url: `https://data.eastmoney.com/report/info/${row.infoCode}.html`,
        publishedAt: String(row.publishDate || '').slice(0, 10),
      }));
    }
    if (source.kind === 'eastmoney-quote') {
      const suggestResponse = await fetch(`https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(text)}&type=14`, {
        headers: { 'user-agent': 'Mozilla/5.0' }, signal: timeout(),
      });
      if (!suggestResponse.ok) throw new Error(`行情 suggest HTTP ${suggestResponse.status}`);
      const suggest = await suggestResponse.json();
      const first = (suggest && suggest.QuotationCodeTable && suggest.QuotationCodeTable.Data || [])[0];
      if (!first) throw new Error('未找到标的');
      const code = String(first.Code || '');
      const market = code.startsWith('6') ? '1' : '0';
      const quoteResponse = await fetch(`https://push2.eastmoney.com/api/qt/stock/get?secid=${market}.${code}&fields=f43,f57,f58,f170`, {
        headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://quote.eastmoney.com/' }, signal: timeout(),
      });
      if (!quoteResponse.ok) throw new Error(`行情 HTTP ${quoteResponse.status}`);
      const quote = await quoteResponse.json();
      const data = (quote && quote.data) || {};
      const price = Number(data.f43);
      const change = Number(data.f170);
      return [{
        title: `${data.f58 || first.Name}（${data.f57 || code}）`,
        description: `现价 ${Number.isFinite(price) ? (price / 100).toFixed(2) : '?'} · 涨跌幅 ${Number.isFinite(change) ? (change / 100).toFixed(2) : '?'}%`,
        url: `https://quote.eastmoney.com/${market === '1' ? 'sh' : 'sz'}${code}.html`,
        publishedAt: new Date().toISOString(),
      }];
    }
    if (source.kind === 'sec-edgar') {
      const response = await fetch(`https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(text)}&forms=10-K`, {
        headers: { 'user-agent': 'skill-pilot/1.0 (contact@example.com)', accept: 'application/json' }, signal: timeout(),
      });
      if (!response.ok) throw new Error(`SEC HTTP ${response.status}`);
      const json = await response.json();
      const hits = (json.hits && json.hits.hits) || [];
      return hits.slice(0, limit).map((hit) => {
        const sourceInfo = hit._source || {};
        const names = Array.isArray(sourceInfo.display_names) ? sourceInfo.display_names : [];
        return {
          title: `${names[0] || 'SEC filing'} · ${sourceInfo.form || '10-K'}`,
          description: `file_date ${sourceInfo.file_date || ''} · period ${sourceInfo.period_ending || ''}`,
          url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(text)}&type=${encodeURIComponent(sourceInfo.form || '10-K')}`,
          publishedAt: sourceInfo.file_date || '',
        };
      });
    }
    if (source.kind === 'arxiv') {
      const response = await fetch(`http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(text)}&max_results=${limit}`, {
        headers: { 'user-agent': 'skill-pilot/1.0' }, signal: timeout(),
      });
      if (!response.ok) throw new Error(`arXiv HTTP ${response.status}`);
      const xml = await response.text();
      const entries = [];
      for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const block = match[1];
        const title = (/<title>([\s\S]*?)<\/title>/.exec(block) || [])[1] || '';
        const id = (/<id>([\s\S]*?)<\/id>/.exec(block) || [])[1] || '';
        const published = (/<published>([\s\S]*?)<\/published>/.exec(block) || [])[1] || '';
        entries.push({
          title: title.replace(/\s+/g, ' ').trim(),
          description: `arXiv · ${String(published).slice(0, 10)}`,
          url: id.trim(),
          publishedAt: String(published).slice(0, 10),
        });
        if (entries.length >= limit) break;
      }
      return entries;
    }
    if (source.kind === 'openalex') {
      const response = await fetch(`https://api.openalex.org/works?search=${encodeURIComponent(text)}&per_page=${limit}`, {
        headers: { 'user-agent': 'skill-pilot/1.0' }, signal: timeout(),
      });
      if (!response.ok) throw new Error(`OpenAlex HTTP ${response.status}`);
      const json = await response.json();
      return (json.results || []).slice(0, limit).map((work) => ({
        title: work.title || work.display_name || '',
        description: `OpenAlex · ${work.publication_date || ''} · cited ${work.cited_by_count || 0}`,
        url: work.doi || work.id || '',
        publishedAt: work.publication_date || '',
      }));
    }
    if (source.kind === 'tavily') {      const token = getSecret('source:Tavily');
      if (!token) throw new Error('缺少 Tavily token（请在来源与凭据中配置）');
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'skill-pilot/1.0' },
        body: JSON.stringify({ api_key: token, query: text, max_results: limit }),
        signal: timeout(),
      });
      if (!response.ok) throw new Error(`Tavily HTTP ${response.status}`);
      const json = await response.json();
      return (json.results || []).slice(0, limit).map((item) => ({
        title: item.title || item.url || '',
        description: String(item.content || '').slice(0, 200),
        url: item.url || '',
        publishedAt: item.published_date || new Date().toISOString(),
      }));
    }
    if (source.kind === 'eu-data') {
      const response = await fetch(`https://data.europa.eu/api/hub/search/search?q=${encodeURIComponent(text)}&limit=${limit}`, {
        headers: { 'user-agent': 'skill-pilot/1.0', accept: 'application/json' }, signal: timeout(),
      });
      if (!response.ok) throw new Error(`EU Open Data HTTP ${response.status}`);
      const json = await response.json();
      const rows = (json.result && json.result.results) || [];
      return rows.slice(0, limit).map((row) => {
        const title = row.title && (row.title.en || row.title[Object.keys(row.title)[0]]) || row.id || '';
        const description = row.description && (row.description.en || row.description[Object.keys(row.description)[0]]) || '';
        return {
          title: String(title).slice(0, 160),
          description: String(description).replace(/\s+/g, ' ').slice(0, 200),
          url: row.landingPage || row.resource || '',
          publishedAt: row.modified || '',
        };
      });
    }
    if (source.kind === 'jp-egov') {
      const response = await fetch('https://elaws.e-gov.go.jp/api/1/lawlists/1', {
        headers: { 'user-agent': 'skill-pilot/1.0' }, signal: timeout(),
      });
      if (!response.ok) throw new Error(`e-Gov HTTP ${response.status}`);
      const xml = await response.text();
      const rows = [];
      for (const match of xml.matchAll(/<LawName>([\s\S]*?)<\/LawName>[\s\S]*?<LawId>([\s\S]*?)<\/LawId>/g)) {
        const title = match[1].trim();
        if (!title.includes(text)) continue;
        rows.push({
          title,
          description: '日本法令（e-Gov 法令データ）',
          url: `https://elaws.e-gov.go.jp/document?lawid=${encodeURIComponent(match[2].trim())}`,
          publishedAt: '',
        });
        if (rows.length >= limit) break;
      }
      return rows;
    }
    throw new Error(`未知来源类型 ${source.kind}`);
  }

  function decorateProResult(item, source) {
    const fetchedAt = Date.now();
    const raw = String(item.publishedAt || '');
    const published = raw
      ? Date.parse(raw.length === 10 ? `${raw}T00:00:00Z` : raw)
      : NaN;
    const ageDays = Number.isFinite(published) ? Math.max(0, Math.floor((fetchedAt - published) / 86400000)) : 0;
    const stale = Number.isFinite(published) && ageDays > (source.maxAgeDays || 3650);
    return {
      ...item,
      source: source.name,
      trust: source.trust || 'medium',
      fetchedAt,
      ageDays,
      stale,
      citation: `[${source.name}] ${item.title}${raw ? ` (${raw})` : ''} ${item.url || ''}`.trim(),
    };
  }

  const cacheFile = path.join(storeDir, 'knowledge-cache.json');
  let knowledgeCache = null;
  function loadKnowledgeCache() {
    if (knowledgeCache) return knowledgeCache;
    try {
      knowledgeCache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    } catch {
      knowledgeCache = {};
    }
    return knowledgeCache;
  }
  function knowledgeGet(key) {
    const map = loadKnowledgeCache();
    const entry = map[key];
    if (!entry) return null;
    const hours = Math.max(0, Number(state.settings.cacheHours) || 0);
    if (hours === 0 || Date.now() - entry.at > hours * 3600000) {
      delete map[key];
      return null;
    }
    return entry.results;
  }
  function knowledgeSet(key, results) {
    const map = loadKnowledgeCache();
    map[key] = { at: Date.now(), results };
    const keys = Object.keys(map);
    if (keys.length > 500) {
      keys.sort((a, b) => map[a].at - map[b].at);
      for (const old of keys.slice(0, keys.length - 500)) delete map[old];
    }
    try {
      mkdirSync(storeDir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(map), 'utf8');
    } catch { /* cache is best-effort */ }
  }


  async function proSearch(query, sourceName, limit, signal) {
    const text = String(query || '').trim();
    if (!text) throw new Error('query 不能为空');
    const region = regionOf(text).key;
    const size = Math.min(Math.max(Number(limit) || 5, 1), 10);
    const cacheKey = `${region}|${sourceName || 'all'}|${size}|${text.toLowerCase()}`;
    const cached = knowledgeGet(cacheKey);
    if (cached) {
      cached.cached = true;
      return cached;
    }
    const allEnabled = (state.settings.proSources || [])
      .filter((source) => source.enabled !== false)
      .sort((a, b) => b.priority - a.priority);
    const sources = sourceName
      ? allEnabled.filter((source) => source.name === sourceName || source.kind === sourceName)
      : allEnabled.filter((source) => source.regions.includes('GLOBAL') || source.regions.includes(region));
    const results = [];
    for (const source of sources) {
      const remaining = size - results.length;
      if (remaining <= 0) break;
      try {
        const found = await searchProSource(text, source, remaining, signal);
        for (const item of found) results.push(decorateProResult(item, source));
      } catch (error) {
        results.push({
          title: `${source.name} 检索失败`,
          description: String((error && error.message) || error),
          url: '',
          source: source.name,
          error: true,
          trust: source.trust || 'medium',
          stale: false,
          citation: '',
        });
      }
    }
    const finalResults = results.slice(0, size);
    finalResults.cached = false;
    knowledgeSet(cacheKey, finalResults);
    return finalResults;
  }

  function commandExists(command) {
    const name = String(command || '').trim();
    if (!name) return false;
    const extensions = process.platform === 'win32'
      ? ['.exe', '.cmd', '.bat', '.ps1', '']
      : [''];
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      for (const extension of extensions) {
        try {
          if (existsSync(path.join(dir, name + extension))) return true;
        } catch { /* ignore unreadable PATH entry */ }
      }
    }
    return false;
  }

  function parseRequires(content) {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(content || ''));
    if (!frontmatter) return [];
    const match = /(?:^|\n)requires:\s*([^\n]+)/i.exec(frontmatter[1]);
    if (!match) return [];
    return match[1].split(/[,\s]+/).map((token) => token.trim().replace(/^\[|\]$/g, '')).filter(Boolean).slice(0, 10);
  }

  function parseRequiresEnv(content) {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(content || ''));
    if (!frontmatter) return [];
    const match = /(?:^|\n)requires_env:\s*([^\n]+)/i.exec(frontmatter[1]);
    if (!match) return [];
    return match[1].split(/[,\s]+/)
      .map((token) => token.trim().replace(/^['"[\]]+|['"[\]]+$/g, ''))
      .filter((token) => /^[A-Z][A-Z0-9_]+$/.test(token))
      .slice(0, 10);
  }

  const INSTALL_HINTS = {
    'lark-cli': 'npm i -g @larksuiteoapi/lark-cli',
    'hithink-finance': 'pip install hithink-finance',
    ffmpeg: 'winget install ffmpeg',
    soffice: '安装 LibreOffice',
    python: '安装 Python 并加入 PATH',
    node: '安装 Node.js',
    git: '安装 Git',
    npx: '安装 Node.js（自带 npx）',
  };

  async function diagnoseSkills(agent, options, signal) {
    const lookup = await lookupOptions(agent, signal);
    const index = await buildDocs(agent, signal);
    const limit = Math.min(Math.max(Number(options && options.limit) || 40, 1), 120);
    const onlyName = options && options.name ? String(options.name) : '';
    const docs = onlyName ? index.docs.filter((doc) => doc.name === onlyName) : index.docs.filter((doc) => doc.enabled).slice(0, limit);
    const results = [];
    for (const doc of docs) {
      const item = { name: doc.name, source: doc.source, status: 'ok', problems: [] };
      let skill;
      try {
        skill = await ctx.skills.get(doc.name, { cwd: lookup.cwd, scope: agent, signal });
      } catch { skill = undefined; }
      if (!skill) {
        item.status = 'unreadable';
        item.problems.push('无法读取技能正文（文件缺失或权限问题）');
      } else {
        let raw = String(skill.content || '');
        // frontmatter（requires 等）通常在技能目录的 SKILL.md 里，正文可能已剥离 frontmatter。
        if (skill.resourceBase && skill.resourceBase.kind === 'directory' && typeof skill.resourceBase.path === 'string') {
          try {
            const fileContent = readFileSync(path.join(skill.resourceBase.path, 'SKILL.md'), 'utf8');
            if (fileContent) raw = fileContent;
          } catch { /* fall back to body */ }
        }
        if (!String(skill.content || '').trim()) {
          item.status = 'unreadable';
          item.problems.push('技能正文为空');
        }
        for (const command of parseRequires(raw)) {
          if (!commandExists(command)) {
            const hint = INSTALL_HINTS[command] ? `（安装建议：${INSTALL_HINTS[command]}）` : '';
            item.problems.push(`缺少命令：${command}${hint}`);
          }
        }
        for (const key of parseRequiresEnv(raw)) {
          if (!process.env[key]) item.problems.push(`缺少环境变量：${key}`);
        }
        if (skill.resourceBase && skill.resourceBase.kind === 'directory'
          && typeof skill.resourceBase.path === 'string' && !existsSync(skill.resourceBase.path)) {
          item.problems.push('资源目录不存在');
        }
        if (item.problems.length && item.status === 'ok') item.status = 'degraded';
      }
      if (item.problems.length) item.fix = item.problems.join('；');
      results.push(item);
    }
    const issues = results.filter((item) => item.problems.length);
    if (state.settings.autoDisableBroken === true && state.settings.autonomy === 'full') {
      for (const issue of issues) {
        const meta = skillMeta(issue.name);
        if (meta.enabled !== false && meta.pin !== true) {
          meta.enabled = false;
          issue.autoDisabled = true;
          recordEvent('toggle', issue.name, { scope: 'skill', op: 'diagnose_disable', enabled: false });
          pushAction({ kind: 'toggle', name: issue.name, before: true, after: false, via: 'diagnose' });
          recordAudit({ actor: 'diagnose', action: 'disable_broken', target: issue.name, detail: issue.fix });
        }
      }
      invalidate();
      persist();
    }
    const report = {
      at: Date.now(),
      checked: results.length,
      issues: issues.length,
      results,
      autoDisabled: issues.filter((item) => item.autoDisabled).map((item) => item.name),
    };
    state.health = { at: report.at, checked: report.checked, issues: report.issues, top: issues.slice(0, 10), autoDisabled: report.autoDisabled };
    persist();
    recordAudit({ actor: 'ui', action: 'diagnose', detail: `${report.checked} checked, ${report.issues} issues` });
    return report;
  }

  // ---- 技能编排：frontmatter depends_on / composes_with ------------------
  async function readRawSkill(agent, name, signal) {
    const lookup = await lookupOptions(agent, signal);
    const skill = await ctx.skills.get(name, { cwd: lookup.cwd, scope: agent, signal });
    let raw = String(skill && skill.content || '');
    if (skill && skill.resourceBase && skill.resourceBase.kind === 'directory' && typeof skill.resourceBase.path === 'string') {
      try {
        const fileContent = readFileSync(path.join(skill.resourceBase.path, 'SKILL.md'), 'utf8');
        if (fileContent) raw = fileContent;
      } catch { /* fall back to body */ }
    }
    return raw;
  }

  function relationList(content, key) {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(content || ''));
    if (!frontmatter) return [];
    const match = new RegExp(`(?:^|\\n)${key}:\\s*([^\\n]+)`, 'i').exec(frontmatter[1]);
    if (!match) return [];
    return match[1].split(/[,\s]+/)
      .map((token) => token.trim().replace(/^['"]|['"]$/g, ''))
      .filter((token) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(token))
      .slice(0, 10);
  }

  async function skillChain(agent, task, limit, signal) {
    const index = await buildDocs(agent, signal);
    const queryTokens = queryTokensOf(task);
    let scored = scoreDocs(index, queryTokens, agent && agent.id, false, task, queryFamilies(task));
    scored = await rerankWithEmbedding(index, task, scored);
    const candidates = scored.filter((item) => item.score > 0.02)
      .slice(0, Math.min(Math.max(Number(limit) || 5, 1), 10));
    if (!candidates.length) return { chain: [], candidates: [], composes: [], near: [] };
    const byName = new Map(index.docs.map((doc) => [doc.name, doc]));
    const top = candidates[0].doc;
    const chain = [];
    const seen = new Set();
    const visit = async (name, depth) => {
      if (!name || seen.has(name) || depth > 5 || !byName.has(name)) return;
      seen.add(name);
      const raw = await readRawSkill(agent, name, signal).catch(() => '');
      for (const dep of relationList(raw, 'depends_on')) await visit(dep, depth + 1);
      chain.push(name);
    };
    await visit(top.name, 0);
    const topRaw = await readRawSkill(agent, top.name, signal).catch(() => '');
    const composes = relationList(topRaw, 'composes_with').filter((name) => byName.has(name));
    const near = candidates.slice(1)
      .filter((item) => item.score >= candidates[0].score * 0.8)
      .map((item) => item.doc.name);
    return { chain, candidates: candidates.map((item) => item.doc.name), composes, near };
  }

  // ---- 工具 --------------------------------------------------------------

  registerLiteTool({
    name: 'skill_scout',
    description:
      'Skill radar: rank the skills that fit a task before acting, and re-scan on domain change or after failures. '
      + 'Returns candidates with short reasons; does not load instructions - load chosen skills with the session skill tool.',
    ...(state.settings.deferScout === true ? { deferLoading: true } : {}),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'The task or sub-goal in natural language, including concrete nouns (file type, platform, API).' },
        context: { type: 'string', description: 'Optional extra context: current sub-step, error text, or constraint.' },
        limit: { type: 'number', description: 'Max candidates to return, 3-20; default 8.' },
        deep: { type: 'boolean', description: 'Load candidate bodies to match section headings. Default true; false for a fast pass.' },
        online: { type: 'boolean', description: 'Also search GitHub for uninstalled skills (network call, untrusted results, never auto-installed).' },
        online_limit: { type: 'number', description: 'Max online results, 1-10; default 5.' },
        include_disabled: { type: 'boolean', description: 'Include skills disabled by skill_manage, for administration.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'number' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text || '' }],
    },
    async execute(args, exec) {
      const agent = exec && exec.agent;
      const signal = exec && exec.signal;
      const query = String((args && args.query) || '').trim();
      if (!query) return { ok: false, count: 0, text: 'skill_scout needs a query: describe the task or sub-goal.' };
      const limit = Math.min(Math.max(Number(args.limit) || topLimit, 3), 20);
      const includeDisabled = args.include_disabled === true;
      try {
        const index = await buildDocs(agent, signal);
        const queryText = `${query} ${args.context || ''}`.trim();
        const queryTokens = queryTokensOf(queryText);
        let scored = scoreDocs(index, queryTokens, agent && agent.id, includeDisabled, queryText, queryFamilies(queryText));
        if (args.deep !== false) {
          const options = await lookupOptions(agent, signal);
          scored = await deepen(index, scored, options, signal);
          scored.sort((a, b2) => b2.score - a.score);
        }
        if (debug) {
          console.error('[skill-pilot] query tokens', [...queryTokens.keys()].slice(0, 12),
            'top scores', scored.slice(0, 5).map((item) => `${item.doc.name}:${item.score.toFixed(3)}`));
        }
        scored = await rerankWithEmbedding(index, queryText, scored);
        scored = applyRoutingBoost(scored, queryText);
        const picked = scored.filter((item) => item.score > 0.02).slice(0, limit);
        if (picked.length) {
          recordDecision({
            kind: 'scout',
            query: normalizeRouteKey(query),
            top: picked.map((item) => item.doc.name),
          });
        }
        const totalEnabled = index.docs.filter((doc) => doc.enabled).length;
        let onlineSection = '';
        if (args.online === true) {
          try {
            const online = await searchOnlineSkills(query, args.online_limit, signal);
            onlineSection = online.length
              ? '\n\n在线技能（未安装；结果不可信，安装前先审阅）：\n'
                + online.map((item, index) => `${index + 1}. [${item.source}] ${item.name} · ★${item.stars} · ${clip(item.description, 70)}\n   ↳ ${item.url || item.description}${item.install ? ` · 安装建议：${item.install}` : ''}`).join('\n')
              : '\n\n在线技能：没有找到相关结果。';
          } catch (error) {
            onlineSection = `\n\n在线技能搜索失败：${String((error && error.message) || error)}`;
          }
        }
        const strong = picked.filter((item) => item.score >= state.settings.radarMinScore
          && item.coverage >= state.settings.radarMinCoverage
          && (item.matchedTerms.length >= 2 || query.toLowerCase().includes(item.doc.name)));
        const intent = classifyIntent(query);
        const decisionInfo = decideScoutAction(strong, intent);
        if (!strong.length) {
          try {
            const disabledCandidates = scoreDocs(index, queryTokens, agent && agent.id, true, queryText, queryFamilies(queryText))
              .filter((item) => item.doc.enabled === false
                && item.score >= state.settings.radarMinScore
                && item.coverage >= state.settings.radarMinCoverage
                && (item.matchedTerms.length >= 2 || query.toLowerCase().includes(item.doc.name)))
              .slice(0, 3);
            if (disabledCandidates.length) {
              const names = disabledCandidates.map((item) => item.doc.name);
              let autoText = '';
              if (state.settings.autoEnable === true && state.settings.autonomy !== 'manual') {
                for (const name of names) {
                  const meta = skillMeta(name);
                  if (meta.enabled === false) {
                    meta.enabled = true;
                    recordEvent('toggle', name, { scope: 'skill', op: 'idle_enable', enabled: true });
                    pushAction({ kind: 'toggle', name, before: false, after: true, via: 'scout' });
                    recordAudit({ actor: 'tool', action: 'auto_enable', target: name, detail: 'scout fallback' });
                  }
                }
                invalidate();
                persist();
                autoText = '；已按 autoEnable 自动启用';
              }
              return {
                ok: true,
                count: names.length,
                text: `技能雷达 · 启用技能无匹配；已禁用/闲置技能中命中：${names.map((name) => `\`${name}\``).join(', ')}${autoText}。\n确认后再加载；不需要就忽略。`
                  + onlineSection,
              };
            }
          } catch { /* fallback optional */ }
          return {
            ok: true,
            count: 0,
            text: `技能雷达 · “${clip(query, 60)}” · ${totalEnabled} 个可用技能里没有明显匹配。\n`
              + `决策：none · 置信度 0.00 · 意图 ${intent.intent} · ${decisionInfo.reason}\n`
              + '直接继续任务；不要把不相关的技能硬套上来。若确认缺能力，可先用 skill_manage op="list" 看全量清单。'
              + onlineSection,
          };
        }
        const lines = [`技能雷达 · “${clip(query, 60)}” · ${totalEnabled} 个可用技能中命中 ${picked.length} 个`];
        picked.forEach((item, i) => {
          const doc = item.doc;
          const marks = [
            doc.enabled ? null : '已关闭',
            doc.pin ? '置顶' : null,
            (loaded.get(agent && agent.id) || new Set()).has(doc.name) ? '本会话已加载' : null,
          ].filter(Boolean).join(' · ');
          lines.push(
            `${i + 1}. \`${doc.name}\` · ${item.score.toFixed(1)} 分 · ${clip(doc.whenToUse || doc.description, 84)}`,
          );
          lines.push(`   ↳ ${explain(item, query)}${marks ? ` ｜ ${marks}` : ''} · 来源 ${doc.source}`);
        });
        lines.push(`决策：${decisionInfo.action} · 置信度 ${decisionInfo.confidence.toFixed(2)} · 意图 ${intent.intent} · ${decisionInfo.reason}`);
        lines.push(`下一步：确认契合后再用 \`${toolName()}\` 工具加载（一次 1–3 个），然后按技能正文执行；不契合就忽略本次结果。`);
        return { ok: true, count: picked.length, text: lines.join('\n') + onlineSection };
      } catch (error) {
        return { ok: false, count: 0, text: `技能雷达出错：${String((error && error.message) || error)}` };
      }
    },
  });

  registerLiteTool({
    name: 'skill_feedback',
    description: 'Record whether a skill actually worked for a task (success/failure). Lightweight feedback that adjusts future retrieval ranking; use after a task succeeds or fails with a skill.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['skill', 'success'],
      properties: {
        skill: { type: 'string', description: 'Exact skill name.' },
        success: { type: 'boolean', description: 'true if the skill helped complete the task, false if it did not.' },
        query: { type: 'string', description: 'Optional original task/query.' },
        note: { type: 'string', description: 'Optional short reason.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text || '' }],
    },
    async execute(args) {
      const result = recordFeedback({ query: args && args.query, skill: args && args.skill, success: args && args.success === true, note: args && args.note });
      return {
        ok: result.ok === true,
        text: result.ok ? `已记录反馈：${result.skill} 成功 ${result.okCount} / 失败 ${result.failCount}` : `反馈记录失败：${result.error}`,
      };
    },
  });

  registerLiteTool({
    name: 'skill_manage',
    description:
      'Skill/plugin switchboard: list, enable, disable, pin, unpin, stats, reset_stats, mode, plugins, plugin_enable, plugin_disable. '
      + 'Writes follow the autonomy mode (mode reports it): manual/suggest read-only, standard may pin, full may enable/disable; plugin switches need full + allowPluginControl.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['op'],
      properties: {
        op: {
          type: 'string',
          enum: ['list', 'enable', 'disable', 'pin', 'unpin', 'stats', 'reset_stats', 'mode', 'plugins', 'plugin_enable', 'plugin_disable'],
        },
        name: { type: 'string', description: 'Skill name, or bundle/plugin name for plugin_* ops.' },
        limit: { type: 'number', description: 'Max rows to print; default 30.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text || '' }],
    },
    async execute(args, exec) {
      const op = String((args && args.op) || 'list');
      const target = args && args.name ? String(args.name) : '';
      const limit = Math.min(Math.max(Number(args.limit) || 30, 5), 100);
      const autonomy = state.settings.autonomy;
      const blocked = (reason) => ({ ok: false, text: reason });
      try {
        if (op === 'mode') {
          const label = { manual: '人工', suggest: 'AI 建议', standard: 'AI 自主', full: '完全自主' }[autonomy] || autonomy;
          return {
            ok: true,
            text: `决策模式：${autonomy}（${label}）\n`
              + `允许 AI 管理插件：${state.settings.allowPluginControl ? '是' : '否'}\n`
              + `自动加载：${state.settings.autoLoadMax} 个/轮（阈值 ${state.settings.autoLoadScore} 分）· 会话注入预算 ${state.settings.sessionBudgetTokens} token\n`
              + '模式只能由人在 设置 → 技能领航员 中切换。',
          };
        }
        if ((op === 'enable' || op === 'disable') && autonomy !== 'full'
          && !(op === 'enable' && state.settings.autoEnable === true && autonomy !== 'manual')) {
          return blocked(`当前模式是 ${autonomy}，AI 不能改技能开关；请人在 设置 → 技能领航员 里切换为「完全自主」、开启「允许 AI 启用技能」授权，或直接操作开关。`);
        }
        if ((op === 'pin' || op === 'unpin') && autonomy !== 'standard' && autonomy !== 'full') {
          return blocked(`当前模式是 ${autonomy}，AI 不能调整置顶；请人在 设置 → 技能领航员 里操作。`);
        }
        if ((op === 'plugin_enable' || op === 'plugin_disable') && (autonomy !== 'full' || !state.settings.allowPluginControl)) {
          return blocked('插件开关需要「完全自主」模式且已允许 AI 管理插件；请人在 设置 → 技能领航员 里操作。');
        }
        if (op === 'list') {
          const index = await buildDocs(exec && exec.agent, exec && exec.signal);
          const docs = [...index.docs].sort((a, b2) => Number(a.enabled) - Number(b2.enabled)
            || Number(b2.pin) - Number(a.pin)
            || b2.count - a.count
            || a.name.localeCompare(b2.name));
          const lines = [`技能清单 · 共 ${docs.length} 个（${index.docs.filter((d) => !d.enabled).length} 个已关闭）`];
          for (const doc of docs.slice(0, limit)) {
            const marks = [doc.enabled ? 'on' : 'off', doc.pin ? 'pin' : null].filter(Boolean).join('/');
            lines.push(`- \`${doc.name}\` [${marks}] 用过 ${doc.count} 次 · ${whenLabel(doc.last)} · ${clip(doc.whenToUse || doc.description, 56)}`);
          }
          if (docs.length > limit) lines.push(`（只显示前 ${limit} 个，可用 limit 调整）`);
          return { ok: true, text: lines.join('\n') };
        }
        if (op === 'stats') {
          const rows = Object.entries(state.stats)
            .map(([skillName, stat]) => ({ name: skillName, count: Number(stat.count) || 0, last: Number(stat.last) || 0 }))
            .sort((a, b2) => b2.count - a.count)
            .slice(0, limit);
          if (!rows.length) return { ok: true, text: '还没有任何技能加载记录。' };
          return {
            ok: true,
            text: ['技能使用统计（加载次数 / 最近一次）', ...rows.map((row, i) => `${i + 1}. \`${row.name}\` · ${row.count} 次 · ${whenLabel(row.last)}`)].join('\n'),
          };
        }
        if (op === 'reset_stats') {
          state.stats = {};
          usageEvents.length = 0;
          try {
            mkdirSync(storeDir, { recursive: true });
            writeFileSync(eventsFile, '', 'utf8');
          } catch { /* ignore */ }
          persist();
          return { ok: true, text: '已清空技能使用统计。' };
        }
        if (op === 'enable' || op === 'disable' || op === 'pin' || op === 'unpin') {
          if (!target) return { ok: false, text: `${op} 需要 name 参数。` };
          const meta = skillMeta(target);
          if (op === 'disable' && meta.pin === true) {
            return blocked(`技能 ${target} 已置顶，不能禁用；请先取消置顶。`);
          }
          const before = { enabled: meta.enabled !== false, pin: meta.pin === true };
          if (op === 'enable') meta.enabled = true;
          if (op === 'disable') meta.enabled = false;
          if (op === 'pin') meta.pin = true;
          if (op === 'unpin') meta.pin = false;
          recordEvent('toggle', target, { scope: 'skill', op, enabled: meta.enabled !== false });
          pushAction({ kind: 'toggle', name: target, before: before.enabled, after: meta.enabled !== false, via: 'tool' });
          recordAudit({
            actor: 'tool', action: 'skill_update', target, op,
            before, after: { enabled: meta.enabled !== false, pin: meta.pin === true },
          });
          persist();
          invalidate();
          const label = { enable: '已启用', disable: '已关闭', pin: '已置顶', unpin: '已取消置顶' }[op];
          return { ok: true, text: `${label}技能 \`${target}\`。` };
        }
        if (op === 'plugins' || op === 'plugin_enable' || op === 'plugin_disable') {
          const pm = typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined;
          if (!pm) return { ok: false, text: '当前进程没有 pluginManager 服务（可能不是 profile 启动），插件开关不可用。' };
          if (op === 'plugins') {
            const bundles = typeof pm.listBundles === 'function' ? await pm.listBundles() : [];
            const plugins = typeof pm.listPlugins === 'function' ? await pm.listPlugins() : [];
            const describe = (entry) => {
              if (typeof entry === 'string') return { label: entry, title: '', enabled: undefined };
              const label = entry.name || entry.entryId || entry.id || '';
              const title = (entry.meta && entry.meta.title && (entry.meta.title.zh || entry.meta.title.en)) || '';
              return { label, title, enabled: typeof entry.enabled === 'boolean' ? entry.enabled : undefined };
            };
            const lines = [
              `插件清单 · ${Array.isArray(bundles) ? bundles.length : 0} 个 bundle · ${Array.isArray(plugins) ? plugins.length : 0} 个插件（只列前 ${limit} 个）`,
            ];
            if (Array.isArray(bundles)) {
              for (const bundle of bundles.slice(0, limit)) {
                const info = describe(bundle);
                lines.push(`- bundle ${info.label}${info.enabled === undefined ? '' : info.enabled ? ' [on]' : ' [off]'}`);
              }
            }
            if (Array.isArray(plugins)) {
              for (const plugin of plugins.slice(0, limit)) {
                const info = describe(plugin);
                const title = info.title && info.title !== info.label ? `（${info.title}）` : '';
                lines.push(`- plugin \`${info.label}\`${title}${info.enabled === undefined ? '' : info.enabled ? ' [on]' : ' [off]'}`);
              }
            }
            lines.push('开关示例：skill_manage op="plugin_disable" name="<bundle 或 entryId>"；插件开关会写入当前 profile，影响所有会话。');
            return { ok: true, text: lines.join('\n') };
          }
          if (!target) return { ok: false, text: `${op} 需要 name 参数（bundle 或插件名）。` };
          const enabled = op === 'plugin_enable';
          let result;
          if (typeof pm.setBundleEnabled === 'function') {
            try {
              result = await pm.setBundleEnabled(target, enabled);
            } catch { /* maybe it is a plugin id, not a bundle */ }
          }
          if (!result && typeof pm.setPluginEnabled === 'function') {
            result = await pm.setPluginEnabled(target, enabled);
          }
          if (!result) return { ok: false, text: `没有找到可切换的插件或 bundle：${target}` };
          const applied = result && result.application ? ` · ${result.application}` : '';
          return { ok: true, text: `${enabled ? '已启用' : '已关闭'} ${target}${applied}。` };
        }
        return { ok: false, text: `未知 op：${op}` };
      } catch (error) {
        return { ok: false, text: `skill_manage 出错：${String((error && error.message) || error)}` };
      }
    },
  });

  registerLiteTool({
    name: 'capability_check',
    description:
      'Check whether this agent already has a skill capability for a task before searching online or claiming a gap. '
      + 'Returns owned / partial / missing plus the closest skills.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string', description: 'Task or capability description.' },
        limit: { type: 'number', description: 'Max matches, 1-8; default 5.' },
      },
      required: ['task'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          level: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text || '' }],
    },
    async execute(args, exec) {
      try {
        const task = String((args && args.task) || '').trim();
        if (!task) return { ok: false, text: 'capability_check needs task.' };
        const report = await capabilityReport(exec && exec.agent, task, args && args.limit);
        const label = { owned: '具备', partial: '部分具备', missing: '缺失' }[report.level];
        const lines = [`能力检查 · “${clip(task, 60)}” · ${label}`];
        report.top.forEach((item, index) => {
          lines.push(`${index + 1}. \`${item.doc.name}\` · ${item.score.toFixed(1)} 分 · ${item.doc.enabled ? '可用' : '已关闭'} · ${clip(item.doc.whenToUse || item.doc.description, 70)}`);
        });
        if (report.level === 'missing') lines.push('缺口：可以先用 skill_scout 确认，再用 acquire_skill 在线找候选。');
        return { ok: true, level: report.level, text: lines.join('\n') };
      } catch (error) {
        return { ok: false, text: `capability_check 出错：${String((error && error.message) || error)}` };
      }
    },
  });

  registerLiteTool({
    name: 'acquire_skill',
    description:
      'Find a missing skill online and install it after a security scan only when autonomy=full AND autoAcquire is on AND risk is low; '
      + 'otherwise return a proposal with risk and next step. Never auto-installs medium/high risk.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string', description: 'Missing capability to acquire.' },
        repo: { type: 'string', description: 'Optional GitHub repo owner/name to skip online search.' },
        path: { type: 'string', description: 'Optional SKILL.md path inside the repo.' },
      },
      required: ['task'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          installed: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text || '' }],
    },
    async execute(args, exec) {
      try {
        const task = String((args && args.task) || '').trim();
        if (!task) return { ok: false, text: 'acquire_skill needs task.' };
        let repo = String((args && args.repo) || '').trim();
        let skillPath = String((args && args.path) || '').trim();
        if (!repo) {
          const candidates = await searchOnlineSkills(task, 3, exec && exec.signal);
          const candidate = candidates.find((item) => item.repo);
          if (!candidate) return { ok: false, text: `没有找到可安装的技能（任务：${clip(task, 60)}）。` };
          repo = candidate.repo;
          skillPath = candidate.path || skillPath;
        }
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { ok: false, text: `repo 不合法：${repo}` };
        if (state.settings.dryRun === true) {
          recordDecision({ kind: 'acquire', query: normalizeRouteKey(task), repo, path: skillPath, outcome: 'dry-run' });
          return { ok: true, installed: false, text: `dry-run：计划从 ${repo}${skillPath ? ` · ${skillPath}` : ''} 安装；未做任何修改。` };
        }
        const mode = state.settings.autonomy;
        const autoCandidate = mode === 'full' && state.settings.autoAcquire === true;
        const sessionKey = (exec && exec.agent && exec.agent.id) || 'unknown';
        const used = autoActionCounts.get(sessionKey) || 0;
        const budget = Number(state.settings.actionBudget ?? 3);
        if (autoCandidate && used >= budget) {
          recordDecision({ kind: 'acquire', query: normalizeRouteKey(task), repo, path: skillPath, outcome: 'budget-blocked' });
          return {
            ok: true,
            installed: false,
            text: `找到候选 ${repo}${skillPath ? ` · ${skillPath}` : ''}。本会话自动动作预算已用完（${used}/${budget}），只提议。`,
          };
        }
        const scan = await scanRepo(repo, skillPath, exec && exec.signal);
        const owner = repo.split('/')[0].toLowerCase();
        const trustedOwner = (state.settings.trustedOwners || []).includes(owner);
        const trusted = (scan.metadata && scan.metadata.stars >= 50) || trustedOwner;
        const riskOk = scan.risk === 'low' || (scan.risk === 'medium' && trustedOwner);
        const canAuto = autoCandidate && riskOk && trusted && scan.risk !== 'high';
        if (!canAuto) {
          recordDecision({ kind: 'acquire', query: normalizeRouteKey(task), repo, path: skillPath, risk: scan.risk, outcome: 'proposed' });
          const reasons = [];
          if (mode !== 'full') reasons.push(`当前模式 ${mode}`);
          if (state.settings.autoAcquire !== true) reasons.push('自动安装未开启');
          if (!riskOk) reasons.push(`预检风险 ${scan.risk}`);
          if (!trusted) reasons.push(`仓库不在白名单且 stars ${scan.metadata ? scan.metadata.stars : 0} < 50`);
          return {
            ok: true,
            installed: false,
            text: `找到候选 ${repo}${skillPath ? ` · ${skillPath}` : ''}（预检 ${scan.risk} / ${scan.score} 分，stars ${scan.metadata ? scan.metadata.stars : 0}）。`
              + `${reasons.join('；')}，因此只提议；确认后可通过面板安装或 /install。`,
          };
        }
        const result = await installSkill(repo, skillPath, { confirm: scan.risk === 'medium', force: false }, exec && exec.signal);
        if (!result.ok) {
          recordDecision({ kind: 'acquire', query: normalizeRouteKey(task), repo, path: skillPath, risk: scan.risk, outcome: 'blocked', blocked: result.blocked });
          return { ok: false, text: `安装被阻止：${result.blocked || result.error || 'unknown'}` };
        }
        autoActionCounts.set(sessionKey, used + 1);
        pushAction({ kind: 'install', name: result.name, dir: result.dir, via: 'acquire', risk: scan.risk });
        recordDecision({ kind: 'acquire', query: normalizeRouteKey(task), repo, path: skillPath, risk: scan.risk, outcome: 'installed', skill: result.name });
        return { ok: true, installed: true, text: `已自动安装 ${result.name}（预检 ${scan.risk}；本会话自动动作 ${used + 1}/${budget}）。` };
      } catch (error) {
        return { ok: false, text: `acquire_skill 出错：${String((error && error.message) || error)}` };
      }
    },
  });

  registerLiteTool({
    name: 'open_skill_pilot',
    description:
      'Show the user a clickable button/link that opens the Skill Pilot management panel. '
      + 'Call this when the user asks how to open, manage, enable/disable, or configure skills or plugins.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text || '' }],
    },
    execute() {
      return {
        ok: true,
        text: '已生成「打开技能领航员」按钮；点击即可打开管理面板（等价于打开 #skill-pilot）。',
      };
    },
  });

  // ---- Web 管理界面 API（Settings → 技能领航员）------------------------
  const sendJson = (res, status, body) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (error) {
        reject(new Error(`invalid JSON body: ${String((error && error.message) || error)}`));
      }
    });
    req.on('error', reject);
  });

  async function pickAgentContext() {
    const agentService = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    const agents = agentService && typeof agentService.list === 'function' ? agentService.list() : [];
    let picked = null;
    for (const agent of agents.slice(0, 10)) {
      try {
        const cwd = await ctx.workingDirectory.ensure(agent);
        const list = await ctx.skills.list({ cwd, scope: agent });
        if (!picked || list.length > picked.list.length) picked = { agent, cwd, list };
      } catch { /* an agent without a usable scope is skipped */ }
    }
    if (!picked) {
      const cwd = process.cwd();
      picked = { agent: undefined, cwd, list: await ctx.skills.list({ cwd }) };
    }
    return picked;
  }

  async function uiSkills() {
    const picked = await pickAgentContext();
    return picked.list.map((skill) => {
      const meta = state.skills[skill.name] || {};
      const stat = state.stats[skill.name] || {};
      return {
        name: skill.name,
        description: skill.description || '',
        whenToUse: skill.whenToUse || '',
        source: skill.source || '',
        provider: skill.provider || '',
        enabled: meta.enabled !== false,
        pin: meta.pin === true,
        count: Number(stat.count) || 0,
        last: Number(stat.last) || 0,
      };
    }).sort((a, b2) => Number(b2.enabled) - Number(a.enabled)
      || Number(b2.pin) - Number(a.pin)
      || b2.count - a.count
      || a.name.localeCompare(b2.name));
  }

  function normalizePluginList(entries) {
    if (!Array.isArray(entries)) return [];
    return entries.map((entry) => {
      if (typeof entry === 'string') return { name: entry, title: '', enabled: true };
      return {
        name: entry.name || entry.entryId || entry.id || '',
        title: (entry.meta && entry.meta.title && (entry.meta.title.zh || entry.meta.title.en)) || '',
        enabled: typeof entry.enabled === 'boolean' ? entry.enabled : true,
        readOnlyReason: entry.readOnlyReason || '',
      };
    }).filter((entry) => entry.name);
  }

  // ---- 技能分类：默认本地语义规则，可被自定义分类覆盖 -------------------
  const CATEGORY_RULES = [
    { key: 'lark', label: '飞书 / Lark', test: /lark|飞书|feishu/i },
    { key: 'finance', label: '金融数据', test: /finance|hithink|mx-|lingxi|股票|行情|研报|财报|估值|基金|选股|自选/i },
    { key: 'office', label: '办公文档', test: /office|docx|xlsx|pptx|pdf|文档|表格|演示|幻灯片/i },
    { key: 'dev', label: '开发工程', test: /code|git|react|frontend|backend|debug|refactor|programm|编程|代码|架构|测试/i },
    { key: 'design', label: '设计 / 媒体', test: /design|canvas|image|video|audio|figma|poster|海报|视频|图片|设计|动画/i },
    { key: 'research', label: '研究 / 写作', test: /research|arxiv|paper|write|summar|论文|写作|综述|研究|文档/i },
    { key: 'system', label: '系统 / 运维', test: /windows|sandbox|diagnos|system|terminal|运维|诊断|索引|acl/i },
    { key: 'meta', label: '技能管理', test: /skill|plugin|memory|agent|harness|craft|插件|技能|记忆|智能体/i },
    { key: 'other', label: '其他', test: null },
  ];

  function categoryOf(skill) {
    const name = skill && skill.name ? String(skill.name) : '';
    const custom = state.categories && state.categories[name];
    if (custom && String(custom).trim()) return String(custom).trim();
    const text = `${name} ${(skill && skill.description) || ''} ${(skill && skill.whenToUse) || ''}`;
    const rule = CATEGORY_RULES.find((item) => item.test && item.test.test(text));
    return rule ? rule.key : 'other';
  }

  function categoryGroups(skills) {
    const groups = new Map();
    for (const skill of skills) {
      const key = categoryOf(skill);
      if (!groups.has(key)) {
        const rule = CATEGORY_RULES.find((item) => item.key === key);
        groups.set(key, {
          key,
          label: rule ? rule.label : key,
          custom: Object.values(state.categories || {}).includes(key),
          skills: [],
        });
      }
      groups.get(key).skills.push(skill.name);
    }
    return [...groups.values()].sort((a, b) => b.skills.length - a.skills.length);
  }

  function defaultSkillDirs() {
    const fallback = installRoot();
    try { mkdirSync(fallback, { recursive: true }); } catch { /* keep going */ }
    const roots = interopRoots();
    if (!roots.length) roots.push({ path: fallback, platform: 'dsh-agents', format: 'skill-md' });
    const disabled = new Set(Array.isArray(state.settings.disabledSkillDirs) ? state.settings.disabledSkillDirs : []);
    const visible = roots.filter((root) => !disabled.has(root.path));
    const chosen = visible.length ? visible : roots;
    const primary = String(state.settings.primarySkillDir || '');
    return chosen.map((root, index) => ({
      path: root.path,
      platform: root.platform,
      format: root.format,
      primary: primary ? root.path === primary : index === 0,
      exists: existsSync(root.path),
    }));
  }

  function pluginRoots() {
    const home = os.homedir();
    const dshHome = process.env.DSH_HOME || path.join(home, '.dsh');
    const profileDir = process.env.DSH_PROFILE_DIR || path.join(dshHome, 'profiles', 'desktop');
    return [
      { path: path.join(dshHome, 'plugins'), platform: 'dsh', kind: 'plugin' },
      { path: path.join(profileDir, 'plugins'), platform: 'dsh', kind: 'plugin' },
      { path: path.join(home, '.claude', 'plugins'), platform: 'claude', kind: 'plugin' },
      { path: path.join(home, '.codex', 'plugins'), platform: 'codex', kind: 'plugin' },
    ].filter((entry) => existsSync(entry.path));
  }

  function countSkillsIn(dir) {
    const out = [];
    try {
      if (existsSync(path.join(dir, 'SKILL.md'))) out.push({ path: path.join(dir, 'SKILL.md') });
      walkSkillDirs(dir, 'custom', 'custom', out, 0);
    } catch { /* unreadable */ }
    return out.length;
  }

  function discoverDirsIn(root, depth = 0, found = []) {
    if (!root || depth > 4 || found.length >= 80) return found;
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { return found; }
    const hasSkill = existsSync(path.join(root, 'SKILL.md'));
    if (hasSkill) {
      found.push({ path: root, kind: 'skill-dir', skills: countSkillsIn(root), platform: 'discovered' });
      return found;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const dir = path.join(root, entry.name);
      const isPlugin = existsSync(path.join(dir, 'package.json'))
        && (existsSync(path.join(dir, 'server.mjs')) || existsSync(path.join(dir, 'mcp.json')) || existsSync(path.join(dir, 'SKILL.md')));
      if (isPlugin) {
        found.push({ path: dir, kind: 'plugin-dir', skills: countSkillsIn(dir), platform: 'discovered' });
      }
      discoverDirsIn(dir, depth + 1, found);
      if (found.length >= 80) break;
    }
    return found;
  }

  function discoverKnownDirs() {
    const candidates = [];
    for (const dir of defaultSkillDirs()) {
      if (!dir.exists) continue;
      candidates.push({ path: dir.path, kind: 'skill-root', platform: dir.platform, skills: countSkillsIn(dir.path), primary: dir.primary });
    }
    for (const dir of pluginRoots()) {
      candidates.push({ path: dir.path, kind: 'plugin-root', platform: dir.platform, skills: countSkillsIn(dir.path) });
    }
    const seen = new Set();
    return candidates.filter((item) => {
      if (seen.has(item.path)) return false;
      seen.add(item.path);
      return true;
    });
  }

  async function uiSnapshot() {
    const skills = await uiSkills();
    const loads = Object.values(state.stats).reduce((sum, stat) => sum + (Number(stat && stat.count) || 0), 0);
    const mode = state.settings.catalogMode;
    const entries = skills.map((skill) => ({ name: skill.name, description: skill.description }));
    const fullText = entries.map((entry) => `- \`${entry.name}\`: ${entry.description}`).join('\n');
    const compactText = compactCatalogText(entries, 'compact');
    const namesText = compactCatalogText(entries, 'names');
    const catalog = {
      mode,
      fullTokens: estimateTokens(fullText),
      compactTokens: estimateTokens(compactText),
      namesTokens: estimateTokens(namesText),
      currentTokens: estimateTokens(mode === 'full' ? fullText : mode === 'names' ? namesText : compactText),
    };
    const pm = typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined;
    let bundles = [];
    let plugins = [];
    if (pm) {
      try {
        bundles = normalizePluginList(typeof pm.listBundles === 'function' ? await pm.listBundles() : []);
      } catch { /* plugin manager may be reloading */ }
      try {
        plugins = normalizePluginList(typeof pm.listPlugins === 'function' ? await pm.listPlugins() : []);
      } catch { /* plugin manager may be reloading */ }
    }
    return {
      ok: true,
      updatedAt: Date.now(),
      storeDir,
      writeToken: ensureWebToken(),
      recovery: state.recovery || null,
      settings: { ...state.settings },
      embedding: {
        enabled: state.settings.embeddingEnabled,
        ready: embeddingState.ready,
        model: embeddingState.model,
        vectorCount: embeddingState.vectorCount,
        error: embeddingState.error,
      },
      takeover: {
        on: takeover.on,
        error: takeover.error,
        available: typeof ctx.tools.restrict === 'function',
      },
      counts: {
        total: skills.length,
        enabled: skills.filter((skill) => skill.enabled).length,
        pinned: skills.filter((skill) => skill.pin).length,
        loads,
      },
      skills,
      categories: categoryGroups(skills),
      skillCategory: Object.fromEntries(skills.map((skill) => [skill.name, categoryOf(skill)])),
      catalog,
      groups: Object.entries(state.groups || {}).map(([name, group]) => ({
        name,
        members: Array.isArray(group.members) ? group.members : [],
        enabled: group.enabled !== false,
      })),
      audit: (state.audit || []).slice(-30).reverse(),
      onlineRegistry: Array.isArray(state.onlineRegistry) ? state.onlineRegistry.length : 0,
      installs: Array.isArray(state.installHistory) ? state.installHistory.slice(-10).reverse() : [],
      installRoot: installRoot(),
      defaultDirs: defaultSkillDirs(),
      decisions: Array.isArray(state.decisions) ? state.decisions.slice(-10).reverse() : [],
      routingCount: Object.keys(state.routing || {}).length,
      health: state.health || null,
      cacheCount: Object.keys(loadKnowledgeCache()).length,
      interop: state.interop ? {
        count: state.interop.count,
        mcpCount: state.interop.mcpCount,
        scannedAt: state.interop.scannedAt,
        roots: state.interop.roots,
        skills: state.interop.skills.slice(0, 200),
        mcpServers: state.interop.mcpServers,
        duplicates: state.interop.duplicates,
      } : null,
      pluginHistory: Array.isArray(state.pluginHistory) ? state.pluginHistory.length : 0,
      bundles,
      plugins: plugins.slice(0, 120),
    };
  }

  function runCommandAsync(command, args, timeoutMs) {
    return new Promise((resolve) => {
      const child = spawn(command, args, { windowsHide: true });
      const stdout = [];
      const stderr = [];
      let settled = false;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(payload);
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        finish({ error: new Error('原生对话框超时'), stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      }, timeoutMs);
      child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
      child.on('error', (error) => finish({ error, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
      child.on('close', (code) => finish({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
    });
  }

  const webTokenFile = path.join(storeDir, 'web-token');
  let webToken = '';
  const ensureWebToken = () => {
    if (webToken) return webToken;
    try {
      if (existsSync(webTokenFile)) webToken = readFileSync(webTokenFile, 'utf8').trim();
      if (!webToken) {
        webToken = randomBytes(32).toString('hex');
        writeFileSync(webTokenFile, webToken, { encoding: 'utf8', mode: 0o600 });
      }
    } catch {
      webToken = randomBytes(32).toString('hex');
    }
    return webToken;
  };

  if (typeof ctx.inject === 'function') ctx.inject(['webServer'], (webCtx) => {
    const web = webCtx.webServer;
    if (!web || typeof web.register !== 'function') return;

    // ---- P0 本机写入口保护：loopback + 同源 Origin + SameSite Cookie ----
    const isLoopback = (address) => {
      const value = String(address || '');
      return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
    };
    const cookieToken = (req) => {
      const raw = String(req.headers.cookie || '');
      const match = /(?:^|;\s*)sp_write=([^;]+)/.exec(raw);
      return match ? match[1] : '';
    };
    const guardRequest = (req, res) => {
      const method = String(req.method || 'GET').toUpperCase();
      if (method === 'GET' || method === 'HEAD') {
        try { res.setHeader('Set-Cookie', `sp_write=${ensureWebToken()}; Path=/; HttpOnly; SameSite=Strict`); } catch { /* optional */ }
        return true;
      }
      if (!isLoopback(req.socket && req.socket.remoteAddress)) {
        sendJson(res, 403, { ok: false, error: 'forbidden: loopback only' });
        return false;
      }
      const origin = req.headers.origin;
      const fetchSite = String(req.headers['sec-fetch-site'] || '');
      if (fetchSite === 'cross-site') {
        sendJson(res, 403, { ok: false, error: 'forbidden: cross-site' });
        return false;
      }
      let sameOrigin = false;
      if (origin) {
        try {
          const parsed = new URL(origin);
          sameOrigin = parsed.host === String(req.headers.host || '') && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
        } catch { sameOrigin = false; }
        if (!sameOrigin) {
          sendJson(res, 403, { ok: false, error: 'forbidden: origin mismatch' });
          return false;
        }
      }
      const headerToken = String(req.headers['x-skill-pilot-token'] || '');
      if (headerToken !== ensureWebToken() && cookieToken(req) !== ensureWebToken()) {
        sendJson(res, 403, { ok: false, error: 'forbidden: missing write token' });
        return false;
      }
      return true;
    };

    ctx.effect(() => {
      const disposers = [];
      const LITE_ROUTES = ['/skill-pilot/data', '/skill-pilot/settings', '/skill-pilot/secrets', '/skill-pilot/scout', '/skill-pilot/capabilities', '/skill-pilot/acquire', '/skill-pilot/install', '/skill-pilot/security/scan', '/skill-pilot/feedback', '/skill-pilot/skill', '/skill-pilot/bulk', '/skill-pilot/skills/discover', '/skill-pilot/fs', '/skill-pilot/usage', '/skill-pilot/online'];
      const register = (route) => {
        if (LITE && !LITE_ROUTES.some((prefix) => route.path === prefix || route.path.startsWith(prefix + '/'))) return;
        try {
          disposers.push(web.register({
            ...route,
            handler: async (req, res) => {
              if (!guardRequest(req, res)) return;
              return route.handler(req, res);
            },
          }));
        } catch (error) {
          if (debug) console.error('dsh-skill-pilot: route skipped', String((error && error.message) || error));
        }
      };

      register({
        kind: 'exact',
        path: '/skill-pilot/data',
        handler: async (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            return sendJson(res, 200, await uiSnapshot());
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/skill',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const body = await readBody(req);
            const target = String(body.name || '').trim();
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target)) return sendJson(res, 400, { ok: false, error: 'invalid skill name' });
            const meta = skillMeta(target);
            const beforeState = { enabled: meta.enabled !== false, pin: meta.pin === true };
            if (typeof body.enabled === 'boolean') meta.enabled = body.enabled;
            if (typeof body.pin === 'boolean') meta.pin = body.pin;
            recordEvent('toggle', target, { scope: 'skill', source: 'ui', enabled: meta.enabled !== false, pin: meta.pin === true });
            recordAudit({
              actor: 'ui', action: 'skill_update', target,
              before: beforeState, after: { enabled: meta.enabled !== false, pin: meta.pin === true },
            });
            persist();
            invalidate();
            return sendJson(res, 200, await uiSnapshot());
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/skills/discover',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const body = await readBody(req);
            const root = String(body.root || '').trim();
            const candidates = root ? discoverDirsIn(path.resolve(root), 0, []) : discoverKnownDirs();
            return sendJson(res, 200, { ok: true, root: root || 'known-platform', candidates });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/skills/discover/add',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const body = await readBody(req);
            const dirs = (Array.isArray(body.dirs) ? body.dirs : []).map(String).filter(Boolean);
            const list = Array.isArray(state.settings.extraSkillDirs) ? [...state.settings.extraSkillDirs] : [];
            const lower = new Set(list.map((item) => path.resolve(item).toLowerCase()));
            const added = [];
            const skipped = [];
            for (const dir of dirs) {
              let real = dir;
              try { real = realpathSync(dir); } catch { /* keep raw */ }
              if (!existsSync(real) || !statSync(real).isDirectory()) { skipped.push(dir); continue; }
              const key = path.resolve(real).toLowerCase();
              if (lower.has(key)) { skipped.push(real); continue; }
              lower.add(key);
              list.push(real);
              added.push(real);
            }
            state.settings.extraSkillDirs = list.slice(-20);
            const scanned = scanInterop();
            persist();
            recordAudit({ actor: 'ui', action: 'skills_discover_add', detail: `${added.length} dirs` });
            return sendJson(res, 200, {
              ok: true, added, skipped, totalDirs: state.settings.extraSkillDirs.length,
              aiSkills: scanned.count,
            });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/fs/pick-dir',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            let command = '';
            let args = [];
            if (process.platform === 'win32') {
              command = 'powershell.exe';
              args = ['-STA', '-NoProfile', '-Command',
                "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $owner = New-Object System.Windows.Forms.Form; $owner.StartPosition = 'CenterScreen'; $owner.FormBorderStyle = 'None'; $owner.ShowInTaskbar = $false; $owner.Opacity = 0; $owner.Size = New-Object System.Drawing.Size(1,1); $owner.Show(); $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择技能目录'; $d.ShowNewFolderButton = $true; if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }; $owner.Close()"];
            } else if (process.platform === 'darwin') {
              command = 'osascript';
              args = ['-e', 'POSIX path of (choose folder with prompt "选择技能目录")'];
            } else {
              command = 'zenity';
              args = ['--file-selection', '--directory', '--title=选择技能目录'];
            }
            const result = await runCommandAsync(command, args, 120000);
            const decode = (buffer) => {
              if (!buffer || !buffer.length) return '';
              const utf8 = Buffer.from(buffer).toString('utf8');
              if (!utf8.includes('\uFFFD')) return utf8;
              try { return new TextDecoder('gbk').decode(buffer); } catch { return utf8; }
            };
            const rawOut = decode(result.stdout);
            const picked = String(rawOut || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
            if (result.error) {
              return sendJson(res, 200, { ok: false, canceled: true, error: `原生对话框不可用：${result.error.message}` });
            }
            if (!picked) return sendJson(res, 200, { ok: true, canceled: true, path: '' });
            return sendJson(res, 200, { ok: true, canceled: false, path: picked });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/fs/dirs',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const body = await readBody(req);
            const home = os.homedir();
            const requested = String(body.path || '').trim();
            let current = requested ? path.resolve(requested) : home;
            if (!existsSync(current) || !statSync(current).isDirectory()) current = home;
            const dirs = [];
            try {
              for (const entry of readdirSync(current, { withFileTypes: true })) {
                if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
                dirs.push({ name: entry.name, path: path.join(current, entry.name) });
                if (dirs.length >= 300) break;
              }
            } catch { /* unreadable directory */ }
            dirs.sort((a, b) => a.name.localeCompare(b.name));
            const parent = path.dirname(current);
            const roots = [];
            if (process.platform === 'win32') {
              for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')) {
                if (existsSync(`${letter}:\\`)) roots.push(`${letter}:\\`);
              }
            } else {
              roots.push('/');
            }
            return sendJson(res, 200, {
              ok: true, path: current, parent: parent !== current ? parent : '',
              home, roots, dirs,
            });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/feedback',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const body = await readBody(req);
            const result = recordFeedback(body);
            return sendJson(res, result.ok ? 200 : 400, result);
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/settings',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const body = await readBody(req);
            if (body.autonomy !== undefined && !AUTONOMY_LEVELS.includes(String(body.autonomy))) {
              return sendJson(res, 400, { ok: false, error: `unknown autonomy: ${String(body.autonomy)}` });
            }
            if (body.catalogMode !== undefined && !['full', 'compact', 'names'].includes(String(body.catalogMode))) {
              return sendJson(res, 400, { ok: false, error: `unknown catalogMode: ${String(body.catalogMode)}` });
            }
            const next = { ...state.settings };
            const teamEnforced = (state.teamPolicy && state.teamPolicy.enforced) || {};
            const blockedByTeam = [];
            for (const key of Object.keys(teamEnforced)) {
              if (key === 'disabledSkills' || key === 'trustedOwners') continue;
              if (body[key] !== undefined) {
                blockedByTeam.push(key);
                delete body[key];
              }
            }
            if (body.autonomy !== undefined) next.autonomy = String(body.autonomy);
            if (body.catalogMode !== undefined) next.catalogMode = String(body.catalogMode);
            if (typeof body.allowPluginControl === 'boolean') next.allowPluginControl = body.allowPluginControl;
            if (typeof body.embeddingEnabled === 'boolean') next.embeddingEnabled = body.embeddingEnabled;
            if (typeof body.embeddingBaseUrl === 'string') next.embeddingBaseUrl = body.embeddingBaseUrl;
            if (typeof body.embeddingModel === 'string') next.embeddingModel = body.embeddingModel;
            if (typeof body.embeddingApiKeyEnv === 'string') next.embeddingApiKeyEnv = body.embeddingApiKeyEnv;
            if (typeof body.takeoverSkill === 'boolean') next.takeoverSkill = body.takeoverSkill;
            if (typeof body.deferScout === 'boolean') next.deferScout = body.deferScout;
            if (Array.isArray(body.onlineSources)) next.onlineSources = body.onlineSources;
            if (Array.isArray(body.proSources)) next.proSources = body.proSources;
            if (typeof body.securityScanDefault === 'boolean') next.securityScanDefault = body.securityScanDefault;
            if (typeof body.requireSignature === 'boolean') next.requireSignature = body.requireSignature;
            if (typeof body.installDir === 'string') next.installDir = body.installDir.slice(0, 500);
            if (typeof body.autoAcquire === 'boolean') next.autoAcquire = body.autoAcquire;
            if (typeof body.autoDisableBroken === 'boolean') next.autoDisableBroken = body.autoDisableBroken;
            if (typeof body.autoSearch === 'boolean') next.autoSearch = body.autoSearch;
            if (typeof body.autoEnable === 'boolean') next.autoEnable = body.autoEnable;
            if (typeof body.dryRun === 'boolean') next.dryRun = body.dryRun;
            if (Array.isArray(body.trustedOwners)) next.trustedOwners = body.trustedOwners;
            if (typeof body.nudges === 'boolean') next.nudges = body.nudges;
            if (body.actionBudget !== undefined) {
              const value = Number(body.actionBudget);
              if (!Number.isFinite(value)) return sendJson(res, 400, { ok: false, error: 'invalid actionBudget' });
              next.actionBudget = value;
            }
            if (body.healthCheckHours !== undefined) {
              const value = Number(body.healthCheckHours);
              if (!Number.isFinite(value)) return sendJson(res, 400, { ok: false, error: 'invalid healthCheckHours' });
              next.healthCheckHours = value;
            }
            if (body.registryRefreshHours !== undefined) {
              const value = Number(body.registryRefreshHours);
              if (!Number.isFinite(value)) return sendJson(res, 400, { ok: false, error: 'invalid registryRefreshHours' });
              next.registryRefreshHours = value;
            }
            if (typeof body.useSkillsSh === 'boolean') next.useSkillsSh = body.useSkillsSh;
            if (body.idleDisableDays !== undefined) {
              const value = Number(body.idleDisableDays);
              if (!Number.isFinite(value)) return sendJson(res, 400, { ok: false, error: 'invalid idleDisableDays' });
              next.idleDisableDays = value;
            }
            if (typeof body.paused === 'boolean') next.paused = body.paused;
            if (typeof body.marketEnabled === 'boolean') next.marketEnabled = body.marketEnabled;
            if (typeof body.marketIndexUrl === 'string') next.marketIndexUrl = body.marketIndexUrl;
            if (Array.isArray(body.extraSkillDirs)) next.extraSkillDirs = body.extraSkillDirs.map(String).filter(Boolean).slice(0, 10);
            if (typeof body.primarySkillDir === 'string') next.primarySkillDir = body.primarySkillDir;
            if (Array.isArray(body.disabledSkillDirs)) next.disabledSkillDirs = body.disabledSkillDirs.map(String).filter(Boolean).slice(0, 30);
            if (body.cacheHours !== undefined) {
              const value = Number(body.cacheHours);
              if (!Number.isFinite(value)) return sendJson(res, 400, { ok: false, error: 'invalid cacheHours' });
              next.cacheHours = value;
            }
            if (body.embeddingTopN !== undefined) {
              const value = Number(body.embeddingTopN);
              if (!Number.isFinite(value)) return sendJson(res, 400, { ok: false, error: 'invalid embeddingTopN' });
              next.embeddingTopN = value;
            }
            for (const key of ['radarMinScore', 'radarMinCoverage', 'autoLoadScore', 'autoLoadCoverage', 'priorBaseBoost', 'priorCategoryBoost', 'qualityGateMinCoverage', 'qualityGateMinDistinct', 'qualityGateMinMargin']) {
              if (body[key] === undefined) continue;
              const value = Number(body[key]);
              if (!Number.isFinite(value)) return sendJson(res, 400, { ok: false, error: `invalid ${key}` });
              next[key] = value;
            }
            if (typeof body.qualityGateEnabled === 'boolean') next.qualityGateEnabled = body.qualityGateEnabled;
            const primaryToKeep = String(next.primarySkillDir || '');
            if (primaryToKeep) {
              const defaultPaths = defaultSkillDirs().map((dir) => dir.path);
              const isDefault = defaultPaths.includes(primaryToKeep);
              const disabledNext = Array.isArray(next.disabledSkillDirs) ? next.disabledSkillDirs : [];
              const extrasNext = Array.isArray(next.extraSkillDirs) ? next.extraSkillDirs : [];
              if ((isDefault && disabledNext.includes(primaryToKeep))
                || (!isDefault && !extrasNext.includes(primaryToKeep))) {
                return sendJson(res, 400, { ok: false, error: '主默认目录不可移除，请先切换主默认' });
              }
            }
            state.settings = normalizeSettings(next);
            applyTakeover(state.settings.takeoverSkill);
            recordAudit({ actor: 'ui', action: 'settings', detail: Object.keys(body).join(',') });
            persist();
            return sendJson(res, 200, { ...(await uiSnapshot()), blockedByTeam });
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/capabilities',
        handler: async (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const url = new URL(req.url || '/', 'http://local');
            const query = String(url.searchParams.get('q') || '').trim();
            if (!query) return sendJson(res, 400, { ok: false, error: 'q is required' });
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 5, 1), 8);
            const picked = await pickAgentContext();
            const report = await capabilityReport(picked.agent, query, limit);
            return sendJson(res, 200, {
              ok: true,
              level: report.level,
              top: report.top.map((item) => ({
                name: item.doc.name,
                score: Number(item.score.toFixed(3)),
                coverage: Number(item.coverage.toFixed(3)),
                enabled: item.doc.enabled !== false,
                source: item.doc.source,
                description: item.doc.whenToUse || item.doc.description,
              })),
            });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/scout',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const body = await readBody(req);
            const query = String(body.query || '').trim();
            if (!query) return sendJson(res, 400, { ok: false, error: 'query required' });
            const limit = Math.min(Math.max(Number(body.limit) || 5, 1), 10);
            const intent = classifyIntent(query);
            if (!intent.needsSkills) {
              return sendJson(res, 200, {
                ok: true, query, intent, action: 'none', confidence: 0, reason: intent.reason,
                totalEnabled: 0, candidates: [], disabledCandidates: [],
              });
            }
            let scope = lastAgentScope;
            if (!scope) {
              try {
                const agents = ctx.get('agents');
                const live = agents && typeof agents.list === 'function' ? agents.list() : [];
                scope = live[0];
              } catch { /* optional */ }
            }
            const retrieved = await retrieveCandidates(query, scope || undefined, undefined, limit);
            const decision = decideScoutAction(retrieved.strong, intent);
            recordSample({
              query, action: decision.action, confidence: Number(decision.confidence.toFixed(3)),
              candidates: retrieved.picked.slice(0, 5).map((item) => item.doc.name),
              chosen: retrieved.strong[0] ? retrieved.strong[0].doc.name : null,
              score: retrieved.picked[0] ? Number(retrieved.picked[0].score.toFixed(3)) : 0,
              coverage: retrieved.picked[0] ? Number(retrieved.picked[0].coverage.toFixed(3)) : 0,
            });
            return sendJson(res, 200, {
              ok: true,
              query,
              intent,
              action: decision.action,
              confidence: Number(decision.confidence.toFixed(3)),
              reason: decision.reason,
              totalEnabled: retrieved.totalEnabled,
              candidates: retrieved.picked.map((item) => ({
                name: item.doc.name,
                score: Number(item.score.toFixed(3)),
                coverage: Number(item.coverage.toFixed(3)),
                matched: item.matchedTerms,
                enabled: item.doc.enabled !== false,
                source: item.doc.source,
              })),
              disabledCandidates: retrieved.disabled.map((item) => item.doc.name),
            });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/online',
        handler: async (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const url = new URL(req.url || '/', 'http://local');
            const query = String(url.searchParams.get('q') || '').trim();
            if (!query) return sendJson(res, 400, { ok: false, error: 'q is required' });
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 6, 1), 10);
            const results = await searchOnlineSkills(query, limit);
            return sendJson(res, 200, { ok: true, query, results });
          } catch (error) {
            return sendJson(res, 502, { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/acquire',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const body = await readBody(req);
            const task = String(body.task || '').trim();
            if (!task) return sendJson(res, 400, { ok: false, error: 'task required' });
            if (state.settings.paused === true) {
              return sendJson(res, 200, { ok: true, task, action: 'paused', installed: false, reason: '全局暂停中（可通过 /pause 恢复）' });
            }
            const intent = classifyIntent(task);
            let repo = String(body.repo || '').trim();
            let skillPath = String(body.path || '').trim();
            const explicitRepo = Boolean(repo);
            let scope = lastAgentScope;
            if (!scope) {
              try {
                const agents = ctx.get('agents');
                const live = agents && typeof agents.list === 'function' ? agents.list() : [];
                scope = live[0];
              } catch { /* optional */ }
            }
            if (!explicitRepo) {
              const retrieved = await retrieveCandidates(task, scope, undefined, 3);
              const decision = decideScoutAction(retrieved.strong, intent);
              if (decision.action === 'use') {
                return sendJson(res, 200, {
                  ok: true, task, action: 'already-covered', confidence: Number(decision.confidence.toFixed(3)),
                  candidate: retrieved.strong[0].doc.name, installed: false,
                });
              }
            }
            const rejected = [];
            if (!repo) {
              let online = [];
              try { online = await searchOnlineSkills(task, 5, undefined); } catch (error) {
                rejected.push({ repo: '', error: String((error && error.message) || error) });
              }
              const pick = online.find((item) => item.repo);
              if (!pick) return sendJson(res, 200, { ok: true, task, action: 'not-found', installed: false, rejected });
              repo = pick.repo;
              skillPath = pick.path || '';
            }
            if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return sendJson(res, 400, { ok: false, error: `invalid repo ${repo}` });
            let scan;
            try {
              scan = await scanRepo(repo, skillPath, undefined);
            } catch (error) {
              const reason = String((error && error.message) || error);
              recordDecision({ kind: 'acquire', query: normalizeRouteKey(task), repo, path: skillPath, outcome: 'preflight-unavailable' });
              return sendJson(res, 200, {
                ok: true, task, action: 'blocked', installed: false,
                candidate: { repo, path: skillPath, risk: 'unknown', error: reason },
                reasons: [`预检不可用：${reason}`],
              });
            }
            const owner = repo.split('/')[0].toLowerCase();
            const trustedOwner = (state.settings.trustedOwners || []).includes(owner);
            const trusted = (scan.metadata && scan.metadata.stars >= 50) || trustedOwner;
            const riskOk = scan.risk === 'low' || (scan.risk === 'medium' && trustedOwner);
            const candidate = {
              repo, path: skillPath, risk: scan.risk, score: scan.score,
              stars: scan.metadata ? scan.metadata.stars : 0, license: scan.metadata ? scan.metadata.license : null,
            };
            if (!riskOk || scan.risk === 'high') {
              recordDecision({ kind: 'acquire', query: normalizeRouteKey(task), repo, path: skillPath, risk: scan.risk, outcome: 'blocked' });
              return sendJson(res, 200, {
                ok: true, task, action: 'blocked', installed: false, candidate,
                reasons: [`预检风险 ${scan.risk}`, ...(trusted ? [] : [`stars ${candidate.stars} < 50 且不在白名单`])],
              });
            }
            const wantsInstall = body.install === true;
            const autoAllowed = state.settings.autonomy === 'full' && state.settings.autoAcquire === true;
            if (wantsInstall && autoAllowed) {
              const today = new Date().toISOString().slice(0, 10);
              if (!state.autoActions || state.autoActions.day !== today) state.autoActions = { day: today, count: 0 };
              const budget = Math.max(0, Number(state.settings.actionBudget ?? 3));
              if (state.autoActions.count >= budget) {
                recordDecision({ kind: 'acquire', query: normalizeRouteKey(task), repo, path: skillPath, outcome: 'budget-blocked' });
                return sendJson(res, 200, {
                  ok: true, task, action: 'budget-blocked', installed: false, candidate,
                  reason: `今日自动动作预算已用完（${state.autoActions.count}/${budget}）`,
                });
              }
            }
            if (!wantsInstall || !autoAllowed) {
              recordDecision({ kind: 'acquire', query: normalizeRouteKey(task), repo, path: skillPath, risk: scan.risk, outcome: 'proposed' });
              return sendJson(res, 200, {
                ok: true, task, action: 'proposed', installed: false, candidate,
                reasons: [
                  ...(wantsInstall ? [] : ['未请求安装']),
                  ...(autoAllowed ? [] : [`自动安装需要 autonomy=full + autoAcquire（当前 ${state.settings.autonomy}/${state.settings.autoAcquire === true}）`]),
                ],
              });
            }
            const install = await installSkill(repo, skillPath, { confirm: scan.risk === 'medium', force: false }, undefined);
            if (!install.ok) {
              recordDecision({ kind: 'acquire', query: normalizeRouteKey(task), repo, path: skillPath, risk: scan.risk, outcome: 'install-blocked', blocked: install.blocked });
              return sendJson(res, 200, { ok: true, task, action: 'install-blocked', installed: false, candidate, blocked: install.blocked || install.error || 'unknown' });
            }
            let verified = false;
            let verifyError = '';
            try {
              const target = path.join(install.dir, 'SKILL.md');
              if (!existsSync(target)) throw new Error('installed SKILL.md missing');
              const parsed = parseSkillDoc(readFileSync(target, 'utf8'), target);
              verified = Boolean(parsed && parsed.name);
            } catch (error) {
              verifyError = String((error && error.message) || error);
            }
            if (!verified) {
              try { await rollbackInstall(install.name); } catch { /* ignore */ }
              recordDecision({ kind: 'acquire', query: normalizeRouteKey(task), repo, path: skillPath, risk: scan.risk, outcome: 'verify-failed', skill: install.name });
              return sendJson(res, 200, {
                ok: true, task, action: 'verify-failed', installed: false, candidate, verifyError, rolledBack: true,
              });
            }
            pushAction({ kind: 'install', name: install.name, dir: install.dir, via: 'acquire-endpoint', risk: scan.risk });
            const today = new Date().toISOString().slice(0, 10);
            if (!state.autoActions || state.autoActions.day !== today) state.autoActions = { day: today, count: 0 };
            state.autoActions.count += 1;
            recordDecision({ kind: 'acquire', query: normalizeRouteKey(task), repo, path: skillPath, risk: scan.risk, outcome: 'installed', skill: install.name });
            return sendJson(res, 200, {
              ok: true, task, action: 'installed', installed: true, candidate,
              skill: install.name, dir: install.dir, verified,
            });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/secrets',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              const map = readSecrets();
              const entries = Object.entries(map).map(([name, entry]) => ({
                name,
                hint: String(entry.value || '').slice(-4),
                updatedAt: entry.updatedAt || 0,
              }));
              return sendJson(res, 200, { ok: true, entries });
            }
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
            const body = await readBody(req);
            const name = String(body.name || '').trim().toLowerCase();
            if (!/^[a-z0-9:_-]{1,40}$/.test(name)) return sendJson(res, 400, { ok: false, error: 'invalid secret name' });
            const value = typeof body.value === 'string' ? body.value.trim() : '';
            putSecret(name, value);
            recordAudit({ actor: 'ui', action: value ? 'secret_set' : 'secret_clear', target: name });
            return sendJson(res, 200, { ok: true, name, saved: Boolean(value) });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/secrets/reveal',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const body = await readBody(req);
            const name = String(body.name || '').trim().toLowerCase();
            if (!/^[a-z0-9:_-]{1,40}$/.test(name)) return sendJson(res, 400, { ok: false, error: 'invalid secret name' });
            const value = getSecret(name);
            if (!value) return sendJson(res, 404, { ok: false, error: 'secret not found' });
            return sendJson(res, 200, { ok: true, name, value });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/secrets/test',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const body = await readBody(req);
            const name = String(body.name || 'github').trim().toLowerCase();
            const token = getSecret(name);
            if (!token) return sendJson(res, 404, { ok: false, error: 'token 未配置' });
            if (name === 'github') {
              const response = await fetch('https://api.github.com/user', {
                headers: { authorization: `Bearer ${token}`, 'user-agent': 'skill-pilot/1.0', accept: 'application/vnd.github+json' },
                signal: AbortSignal.timeout(15000),
              });
              if (!response.ok) return sendJson(res, 200, { ok: false, error: `GitHub HTTP ${response.status}` });
              const user = await response.json();
              return sendJson(res, 200, { ok: true, login: user.login || '', scopes: response.headers.get('x-oauth-scopes') || '' });
            }
            return sendJson(res, 200, { ok: true, note: 'no test adapter for this secret' });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/security/scan',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const body = await readBody(req);
            const repo = String(body.repo || '').trim();
            if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return sendJson(res, 400, { ok: false, error: 'repo must be owner/name' });
            const pathHint = body.path ? String(body.path).slice(0, 300) : '';
            const result = await scanRepo(repo, pathHint, undefined);
            recordAudit({ actor: 'ui', action: 'security_scan', target: repo, detail: result.risk });
            return sendJson(res, 200, { ok: true, result });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/install',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              return sendJson(res, 200, {
                ok: true,
                root: installRoot(),
                history: (Array.isArray(state.installHistory) ? state.installHistory : []).slice(-20).reverse(),
              });
            }
            if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
            const body = await readBody(req);
            const repo = String(body.repo || '').trim();
            if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return sendJson(res, 400, { ok: false, error: 'repo must be owner/name' });
            const manual = body.confirm === true;
            const autonomous = state.settings.autonomy === 'full' && state.settings.autoAcquire === true;
            if (!manual && !autonomous) {
              return sendJson(res, 403, { ok: false, error: '安装需要人工确认，或 full 模式 + autoAcquire 授权' });
            }
            if (state.settings.requireSignature === true) {
              const owner = repo.split('/')[0].toLowerCase();
              const trusted = Array.isArray(state.settings.trustedOwners) ? state.settings.trustedOwners.map((item) => String(item).toLowerCase()) : [];
              if (trusted.length && !trusted.includes(owner)) {
                return sendJson(res, 403, { ok: false, error: `发布者 ${owner} 不在信任白名单` });
              }
            }
            const result = await installSkill(repo, body.path ? String(body.path) : '', {
              confirm: body.confirm === true,
              force: body.force === true,
              overwrite: body.overwrite === true,
            });
            if (result && result.ok) {
              const verified = verifyInstall(result.name);
              if (!verified.verified) {
                try { await rollbackInstall(result.name); } catch { /* best effort */ }
                return sendJson(res, 409, { ok: false, error: '安装后校验失败，已回滚', verify: verified });
              }
            }
            return sendJson(res, result.ok ? 200 : 409, result);
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/install/prune',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const before = Array.isArray(state.installHistory) ? state.installHistory.length : 0;
            state.installHistory = (Array.isArray(state.installHistory) ? state.installHistory : []).filter((entry) => existsSync(entry.dir));
            const removed = before - state.installHistory.length;
            persist();
            return sendJson(res, 200, { ok: true, removed, remaining: state.installHistory.length });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/install/history',
        handler: async (req, res) => {
          try {
            const history = (Array.isArray(state.installHistory) ? state.installHistory : []).map((entry) => ({
              name: entry.name, repo: entry.repo, path: entry.path, risk: entry.risk,
              commit: entry.commit || '', version: entry.version || '', fileCount: entry.fileCount || 1,
              integrity: entry.integrity || '', at: entry.at, backup: Boolean(entry.backup),
            }));
            return sendJson(res, 200, { ok: true, count: history.length, history });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/install/verify',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const body = await readBody(req);
            return sendJson(res, 200, { ok: true, ...verifyInstall(String(body.name || '').trim()) });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/install/updates',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const history = Array.isArray(state.installHistory) ? state.installHistory : [];
            const updates = [];
            for (const entry of history) {
              try {
                const commits = await githubJson(`https://api.github.com/repos/${entry.repo}/commits?per_page=1`);
                const latest = commits && commits[0] ? String(commits[0].sha || '') : '';
                updates.push({
                  name: entry.name, repo: entry.repo,
                  installedCommit: entry.commit || '', latestCommit: latest,
                  updateAvailable: Boolean(latest && entry.commit && latest !== entry.commit),
                });
              } catch (error) {
                updates.push({ name: entry.name, repo: entry.repo, error: String((error && error.message) || error) });
              }
            }
            return sendJson(res, 200, { ok: true, count: updates.length, updates });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/install/update',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const body = await readBody(req);
            const name = String(body.name || '').trim();
            const entry = [...(Array.isArray(state.installHistory) ? state.installHistory : [])].reverse()
              .find((item) => item.name === name);
            if (!entry) return sendJson(res, 404, { ok: false, error: '没有安装记录' });
            const commits = await githubJson(`https://api.github.com/repos/${entry.repo}/commits?per_page=1`);
            const latest = commits && commits[0] ? String(commits[0].sha || '') : '';
            if (!body.force && latest && entry.commit && latest === entry.commit) {
              return sendJson(res, 200, { ok: true, name, upToDate: true, commit: entry.commit });
            }
            const reinstall = await installSkill(entry.repo, entry.path, { overwrite: true, confirm: true, force: false });
            if (!reinstall.ok) return sendJson(res, 200, { ok: false, name, blocked: reinstall.blocked || reinstall.error });
            const verifyResult = verifyInstall(name);
            if (!verifyResult.verified) {
              try { await rollbackInstall(name); } catch { /* best effort */ }
              recordAudit({ actor: 'ui', action: 'install_update_rollback', target: name, detail: verifyResult.mismatches.map((item) => item.path).join(',') });
              return sendJson(res, 200, { ok: false, name, updated: false, verified: false, rolledBack: true, mismatches: verifyResult.mismatches });
            }
            recordAudit({ actor: 'ui', action: 'install_update', target: name, detail: `${entry.commit || '?'}→${latest || '?'}` });
            return sendJson(res, 200, { ok: true, name, updated: true, from: entry.commit || '', to: latest, verified: true, signatureValid: verifyResult.signatureValid });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/install/rollback',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const body = await readBody(req);
            const name = String(body.name || '').trim();
            if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return sendJson(res, 400, { ok: false, error: 'invalid skill name' });
            return sendJson(res, 200, { ok: true, ...(await rollbackInstall(name)) });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/usage',
        handler: async (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const url = new URL(req.url || '/', 'http://local');
            const range = String(url.searchParams.get('range') || '7d');
            const days = range === '1d' ? 1 : range === '30d' ? 30 : 7;
            return sendJson(res, 200, { ok: true, ...usageReport(days) });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/bulk',
        handler: async (req, res) => {
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const body = await readBody(req);
            const names = Array.isArray(body.names)
              ? body.names.filter((name) => typeof name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)).slice(0, 200)
              : [];
            if (!names.length) return sendJson(res, 400, { ok: false, error: 'names is required' });
            for (const name of names) {
              const meta = skillMeta(name);
              if (typeof body.enabled === 'boolean') meta.enabled = body.enabled;
              if (typeof body.pin === 'boolean') meta.pin = body.pin;
              recordEvent('toggle', name, {
                scope: 'skill', source: 'bulk', enabled: meta.enabled !== false, pin: meta.pin === true,
              });
            }
            persist();
            invalidate();
            recordAudit({ actor: 'ui', action: 'bulk', target: names.slice(0, 8).join(','), detail: `${names.length} skills` });
            return sendJson(res, 200, await uiSnapshot());
          } catch (error) {
            return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      register({
        kind: 'exact',
        path: '/skill-pilot/skill/detail',
        handler: async (req, res) => {
          if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
          try {
            const url = new URL(req.url || '/', 'http://local');
            const name = String(url.searchParams.get('name') || '').trim();
            if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return sendJson(res, 400, { ok: false, error: 'invalid skill name' });
            const picked = await pickAgentContext();
            const skill = await ctx.skills.get(name, { cwd: picked.cwd, scope: picked.agent });
            if (!skill) return sendJson(res, 404, { ok: false, error: `skill not found: ${name}` });
            const meta = state.skills[name] || {};
            const stat = state.stats[name] || {};
            return sendJson(res, 200, {
              ok: true,
              name: skill.name,
              description: skill.description || '',
              whenToUse: skill.whenToUse || '',
              source: skill.source || '',
              provider: skill.provider || '',
              resourceBase: skill.resourceBase || null,
              content: skill.content || '',
              enabled: meta.enabled !== false,
              pin: meta.pin === true,
              count: Number(stat.count) || 0,
              last: Number(stat.last) || 0,
            });
          } catch (error) {
            return sendJson(res, errorStatus(error), { ok: false, error: String((error && error.message) || error) });
          }
        },
      });

      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch { /* ignore */ }
        }
      };
    });
  });

  function skillLoadDefinition() {
    return {
      name: 'skill_load',
      description: 'Load a skill by its exact kebab-case name and return its full instructions. This is the active skill loader while Skill Pilot runs in takeover mode (the built-in `skill` tool is hidden).',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Exact kebab-case skill name from the catalog.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            provider: { type: 'string' },
            text: { type: 'string' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text || '' }],
      },
      async execute(args, exec) {
        const target = String((args && args.name) || '').trim();
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target)) {
          return { name: target, provider: '', text: `Error: invalid skill name "${target}"` };
        }
        if (isEnabled(target) === false) {
          return { name: target, provider: '', text: `Error: skill "${target}" is disabled by Skill Pilot` };
        }
        try {
          const options = await lookupOptions(exec && exec.agent, exec && exec.signal);
          const skill = await ctx.skills.get(target, { cwd: options.cwd, scope: exec && exec.agent, signal: exec && exec.signal });
          if (!skill) return { name: target, provider: '', text: `Error: skill "${target}" is unknown or no longer available` };
          const stat = state.stats[target] || (state.stats[target] = { count: 0, last: 0 });
          stat.count += 1;
          stat.last = Date.now();
          recordEvent('load', target, { source: 'skill_load' });
          persist();
          const agentId = exec && exec.agent && exec.agent.id;
          if (agentId) {
            if (!loaded.has(agentId)) loaded.set(agentId, new Set());
            loaded.get(agentId).add(target);
          }
          return { name: skill.name, provider: skill.provider || '', text: renderSkillContent(skill) };
        } catch (error) {
          return { name: target, provider: '', text: `Error: ${String((error && error.message) || error)}` };
        }
      },
    };
  }

  const takeoverAgents = new Map();
  function applyTakeoverToAgent(agent) {
    if (!agent || !agent.id || !agent.ctx) return;
    if (takeoverAgents.has(agent.id)) return;
    const disposers = [];
    try {
      disposers.push(agent.ctx.tools.register(skillLoadDefinition()));
      disposers.push(agent.ctx.tools.restrict({ deny: ['skill'] }));
      takeoverAgents.set(agent.id, disposers);
    } catch (error) {
      takeover.error = String((error && error.message) || error);
      for (const dispose of disposers) {
        try {
          dispose();
        } catch { /* ignore */ }
      }
    }
  }

  function clearTakeoverAgents() {
    for (const disposers of takeoverAgents.values()) {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch { /* ignore */ }
      }
    }
    takeoverAgents.clear();
  }

  function applyTakeover(on) {
    if (Boolean(on) === takeover.on) return;
    takeover.on = Boolean(on);
    takeover.error = '';
    clearTakeoverAgents();
    if (!takeover.on) return;
    const agentService = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    const agents = agentService && typeof agentService.list === 'function' ? agentService.list() : [];
    for (const agent of agents) applyTakeoverToAgent(agent);
  }

  ctx.on('agent/created', ({ agent } = {}) => {
    if (takeover.on) applyTakeoverToAgent(agent);
  });

  // ---- 约束：关闭的技能不能加载 -----------------------------------------
  ctx.tools.guard((exec) => {
    if (!exec || (exec.name !== 'skill' && exec.name !== 'skill_load')) return undefined;
    const target = exec.arguments && exec.arguments.name;
    if (target && isEnabled(target) === false) {
      return `skill "${target}" 已被 skill-pilot 关闭；如确需使用，先调用 skill_manage op="enable" name="${target}"。`;
    }
    return undefined;
  });

  // ---- 统计：记录真实加载 ------------------------------------------------
  ctx.on('tools/result', (exec) => {
    try {
      if (!exec || (exec.name !== 'skill' && exec.name !== 'skill_load')) return;
      const target = exec.arguments && exec.arguments.name;
      if (!target || typeof target !== 'string') return;
      const stat = state.stats[target] || (state.stats[target] = { count: 0, last: 0 });
      stat.count += 1;
      stat.last = Date.now();
      recordEvent('load', target, { source: 'tool' });
      try {
        const cutoff = Date.now() - 10 * 60000;
        const lastScout = [...(state.decisions || [])].reverse()
          .find((entry) => entry && entry.kind === 'scout' && entry.t >= cutoff && entry.query);
        if (lastScout) learnRoute(lastScout.query, target);
      } catch { /* learning must never break a load */ }
      persist();
      const sessionId = exec.agent && exec.agent.id;
      if (sessionId) {
        if (!loaded.has(sessionId)) loaded.set(sessionId, new Set());
        loaded.get(sessionId).add(target);
      }
    } catch (error) {
      if (debug) console.error('dsh-skill-pilot: record failed', error);
    }
  });

  // ---- 自动雷达：按自主度在每轮开始时主动检索 / 注入 --------------------
  function lastUserText(messages) {
    let text = '';
    for (const message of messages || []) {
      if (!message || message.role !== 'user') continue;
      const source = message.source;
      if (source && typeof source.kind === 'string' && source.kind.startsWith('skill')) continue;
      const blocks = Array.isArray(message.content) ? message.content : [];
      const joined = blocks.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text).join('\n').trim();
      if (joined) text = joined;
    }
    return text;
  }

  function digestOf(text) {
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) | 0;
    }
    return `${text.length}:${hash}`;
  }

  // 接管 skill 工具（可选）：隐藏内置目录发布，改用 skill_load + 自注入紧凑目录
  async function maybeNudge(payload, decision) {
    if (state.settings.nudges === false) return decision;
    if (state.settings.autonomy === 'manual') return decision;
    const agent = payload && payload.agent;
    if (!agent || !agent.id) return decision;
    const text = lastUserText(payload && payload.messages) || lastUserText(decision.messages);
    if (!text) return decision;
    let pattern = NUDGE_PATTERNS.find((item) => item.re.test(text));
    let fileHint = '';
    if (!pattern) {
      try {
        const options = await lookupOptions(agent, payload.signal);
        const recent = recentWorkspaceFiles(options.cwd);
        if (recent.length) {
          const extension = path.extname(recent[0]).toLowerCase().slice(1);
          pattern = NUDGE_PATTERNS.find((item) => Array.isArray(item.exts) && item.exts.includes(extension));
          fileHint = recent[0];
        }
      } catch { /* workspace scan is optional */ }
    }
    if (!pattern) return decision;
    const seen = nudgeSeen.get(agent.id) || new Set();
    const nudgeKey = fileHint ? `${pattern.key}:${fileHint}` : pattern.key;
    if (seen.has(nudgeKey) || seen.size >= 2) return decision;
    let index;
    try {
      index = await buildDocs(agent, payload.signal);
    } catch {
      return decision;
    }
    const scored = scoreDocs(index, queryTokensOf(text), agent.id, false, text, queryFamilies(text))
      .filter((item) => item.score > 0.02)
      .slice(0, 3);
    const loadedSet = loaded.get(agent.id) || new Set();
    const fresh = scored.filter((item) => !loadedSet.has(item.doc.name));
    if (!fresh.length) return decision;
    seen.add(nudgeKey);
    nudgeSeen.set(agent.id, seen);
    const names = fresh.map((item) => `\`${item.doc.name}\``).join(', ');
    const fileNote = fileHint ? ` Workspace file: ${fileHint}.` : '';
    const routeHint = ['finance', 'news', 'external'].includes(pattern.key)
      ? ' For external facts, call research_route first, then pro_search or web_search.'
      : '';
    recordDecision({ kind: 'nudge', query: normalizeRouteKey(text), skills: fresh.map((item) => item.doc.name), file: fileHint || undefined });
    return {
      ...decision,
      messages: [...decision.messages, {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: `<system-reminder>\nProactive hint (${pattern.label}): available skills: ${names}.${fileNote}${routeHint} Load one only if it fits the task.\n</system-reminder>` }],
        source: { kind: 'skill-nudge', form: 'hint' },
      }],
    };
  }

  // 会话内提到“技能领航员/技能管理”时，提示悬浮入口（解决某些平台无设置入口）。
  const pilotHintSeen = new Map();
  async function maybePilotHint(payload, decision) {
    const text = lastUserText(payload && payload.messages) || lastUserText(decision.messages);
    const agent = payload && payload.agent;
    if (!text || !agent || !agent.id) return decision;
    if (!/(技能领航员|技能管理|管理技能|技能开关|插件开关)/.test(text)) return decision;
    if (pilotHintSeen.get(agent.id)) return decision;
    pilotHintSeen.set(agent.id, true);
    return {
      ...decision,
      messages: [...decision.messages, {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: '<system-reminder>\n技能领航员入口：调用 `open_skill_pilot` 工具给用户一个可点击的「打开技能领航员」按钮；也可点击 [打开技能领航员](#skill-pilot)。\n</system-reminder>' }],
        source: { kind: 'skill-pilot-hint', form: 'hint' },
      }],
    };
  }

  async function maybeInjectTakeoverCatalog(payload, decision) {
    if (!takeover.on) return decision;
    const agent = payload && payload.agent;
    if (!agent) return decision;
    let messages = decision.messages.filter((message) => !(message && message.source && message.source.kind === 'skill-catalog'));
    try {
      const index = await buildDocs(agent, payload.signal);
      const docs = index.docs.filter((doc) => doc.enabled);
      const entries = docs.map((doc) => ({ name: doc.name, description: doc.description }));
      const digest = `${state.settings.catalogMode}:${entries.length}:${digestOf(entries.map((entry) => `${entry.name}:${entry.description}`).join('|'))}`;
      if (takeoverCatalog.get(agent.id) === digest) {
        return { ...decision, messages };
      }
      takeoverCatalog.set(agent.id, digest);
      const text = compactCatalogText(entries, state.settings.catalogMode === 'full' ? 'compact' : state.settings.catalogMode, 'skill_load');
      messages = [...messages, {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'skill-index', form: 'catalog' },
      }];
      return { ...decision, messages };
    } catch {
      return decision;
    }
  }

  // ---- 自主检索：意图判断 / 置信度 / 动作决策 --------------------------
  function classifyIntent(text) {
    const q = String(text || '').trim();
    if (!q) return { intent: 'empty', needsSkills: false, reason: '空查询' };
    if (/^(你好|嗨|谢谢|好的|收到|在吗|hi|hello|thanks?)[!！。. ]*$/i.test(q)) {
      return { intent: 'chitchat', needsSkills: false, reason: '寒暄，不需要技能' };
    }
    if (/技能领航员|技能管理|管理技能|技能开关|插件开关|skill pilot/i.test(q)) {
      return { intent: 'manage', needsSkills: false, reason: '技能/插件管理请求' };
    }
    if (/(技能|插件|skill|plugin)[^。！？\n]{0,24}(管理|开关|列表|打开|安装|启用|禁用|设置|入口)/i.test(q)) {
      return { intent: 'manage', needsSkills: false, reason: '技能/插件管理请求' };
    }
    if (q.length < 4) return { intent: 'short', needsSkills: false, reason: '查询过短' };
    if (/(帮|请|做|写|生成|分析|修复|实现|设计|总结|翻译|查找|搜索|计算|导出|创建|优化|检查|评审|对比|调研|build|write|fix|analy|design|create|summar|translat|search|find|compute|export|refactor|review|debug)/i.test(q)) {
      return { intent: 'task', needsSkills: true, reason: '任务型描述' };
    }
    return { intent: 'unknown', needsSkills: true, reason: '未分类，保守检索' };
  }

  function confidenceOf(item) {
    if (!item) return 0;
    const scorePart = Math.min(1, item.score / Math.max(1, state.settings.autoLoadScore * 2));
    const coveragePart = Math.min(1, item.coverage / Math.max(0.01, state.settings.autoLoadCoverage));
    const matchPart = Math.min(1, item.matchedTerms.length / 3);
    return Math.max(0, Math.min(1, scorePart * 0.55 + coveragePart * 0.3 + matchPart * 0.15));
  }

  async function retrieveCandidates(query, agent, signal, limit) {
    const text = String(query || '').trim();
    const index = await buildDocsWithExternal(agent, signal);
    const tokens = queryTokensOf(text);
    let scored = scoreDocs(index, tokens, agent && agent.id, false, text, queryFamilies(text));
    scored = await rerankWithEmbedding(index, text, scored);
    scored = applyRoutingBoost(scored, text);
    const gateParams = {
      minCoverage: state.settings.qualityGateMinCoverage,
      minDistinct: state.settings.qualityGateMinDistinct,
      minMargin: state.settings.qualityGateMinMargin,
    };
    const gate = gateTop(scored, gateParams);
    if (state.settings.qualityGateEnabled === true && !gate.accepted) {
      return { index, picked: [], strong: [], disabled: [], totalEnabled: index.docs.filter((doc) => doc.enabled).length, gate };
    }
    const picked = scored.filter((item) => item.score > 0.02).slice(0, limit);
    const strong = picked.filter((item) => item.score >= state.settings.radarMinScore
      && item.coverage >= state.settings.radarMinCoverage
      && (item.matchedTerms.length >= 2 || text.toLowerCase().includes(item.doc.name)));
    const disabled = scoreDocs(index, tokens, agent && agent.id, true, text, queryFamilies(text))
      .filter((item) => item.doc.enabled === false
        && item.score >= state.settings.radarMinScore
        && item.coverage >= state.settings.radarMinCoverage
        && (item.matchedTerms.length >= 2 || text.toLowerCase().includes(item.doc.name)))
      .slice(0, 3);
    return { index, picked, strong, disabled, totalEnabled: index.docs.filter((doc) => doc.enabled).length };
  }

  function decideScoutAction(strong, intent) {
    if (!strong.length) return { action: 'none', confidence: 0, reason: '没有达到阈值的技能' };
    const top = strong[0];
    const confidence = confidenceOf(top);
    const eligible = top.score >= state.settings.autoLoadScore
      && top.coverage >= state.settings.autoLoadCoverage
      && intent.needsSkills;
    return {
      action: eligible && confidence >= 0.5 ? 'use' : 'suggest',
      confidence,
      reason: eligible && confidence >= 0.5 ? '高置信度，可直接加载' : '有匹配但建议人工确认',
    };
  }

  async function maybeAutoScout(payload, decision) {
    const settings = state.settings;
    if (settings.autonomy === 'manual' || settings.paused === true) return decision;
    const agent = payload && payload.agent;
    if (!agent || !agent.id) return decision;
    const turn = payload.turn;
    if (injectedTurns.get(agent.id) === turn) return decision;
    injectedTurns.set(agent.id, turn);
    const query = lastUserText(payload.messages);
    if (!query || query.length < 4) return decision;
    const intent = classifyIntent(query);
    if (!intent.needsSkills) return decision;
    const usage = autoUsage.get(agent.id) || { tokens: 0, count: 0 };
    autoUsage.set(agent.id, usage);
    if (settings.sessionBudgetTokens <= 0 || usage.tokens >= settings.sessionBudgetTokens) return decision;
    const signal = payload.signal;
    const retrieved = await retrieveCandidates(query, agent, signal, 3);
    const picked = retrieved.strong;
    if (debug) {
      console.error('[skill-pilot] auto scout', JSON.stringify({
        mode: settings.autonomy,
        intent: intent.intent,
        top: retrieved.picked.slice(0, 3).map((item) => ({
          name: item.doc.name,
          score: Number(item.score.toFixed(2)),
          coverage: Number(item.coverage.toFixed(2)),
          matched: item.matchedTerms,
        })),
        picked: picked.length,
      }));
    }
    if (!picked.length) return decision;
    const loadedNames = loaded.get(agent.id) || new Set();
    let text = '';
    let form = 'radar';
    let autoName = '';
    if (settings.autonomy !== 'suggest' && settings.autoLoadMax > 0) {
      const decisionInfo = decideScoutAction(picked, classifyIntent(query));
      const candidates = decisionInfo.action === 'use'
        ? picked.filter((item) => item.score >= settings.autoLoadScore
          && item.coverage >= settings.autoLoadCoverage
          && !loadedNames.has(item.doc.name)).slice(0, 2)
        : [];
      for (const candidate of candidates) {
        try {
          const options = await lookupOptions(agent, signal);
          const definition = await ctx.skills.get(candidate.doc.name, { cwd: options.cwd, scope: agent, signal });
          const body = definition && definition.content ? String(definition.content) : '';
          if (!body || body.length > settings.maxBodyChars) continue;
          const rendered = `<system-reminder>\nSkill Pilot auto-loaded the best match for this request (score ${candidate.score.toFixed(1)}):\n${renderSkillContent(definition)}\n</system-reminder>`;
          if (usage.tokens + estimateTokens(rendered) > settings.sessionBudgetTokens) continue;
          text = rendered;
          form = 'auto-load';
          autoName = definition.name;
          loadedNames.add(definition.name);
          loaded.set(agent.id, loadedNames);
          const stat = state.stats[definition.name] || (state.stats[definition.name] = { count: 0, last: 0 });
          stat.count += 1;
          stat.last = Date.now();
          recordEvent('auto', definition.name, { score: Number(candidate.score.toFixed(2)), coverage: Number(candidate.coverage.toFixed(2)) });
          persist();
          break;
        } catch { /* try the next strong candidate */ }
      }
    }
    if (!text) {
      const lines = picked.map((item) => `- \`${item.doc.name}\`: ${clip(item.doc.whenToUse || item.doc.description, 72)}`);
      text = `<system-reminder>\nSkill radar for this request (${picked.length} likely matches):\n${lines.join('\n')}\nLoad only what you will actually use with the \`skill\` tool.\n</system-reminder>`;
    }
    usage.tokens += estimateTokens(text);
    usage.count += 1;
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'skill-radar', form, ...(autoName ? { name: autoName } : {}) },
    };
    return { ...decision, messages: [...decision.messages, message] };
  }

  // ---- 目录压缩：把全量目录消息改写成紧凑索引 --------------------------
  function compactCatalogText(entries, mode, toolName = 'skill') {
    const list = Array.isArray(entries) ? entries : [];
    const lines = list.map((entry) => (mode === 'names'
      ? `- \`${entry.name}\``
      : `- \`${entry.name}\`: ${clip(entry.description, 64)}`));
    const header = mode === 'names'
      ? `Available skills (names only; call \`skill_scout\` for a one-line purpose, then load with \`${toolName}\`):`
      : `Available skills (compact index; call \`skill_scout\` for details, then load with \`${toolName}\`):`;
    return [
      '<system-reminder>',
      header,
      '',
      '<available_skills>',
      ...lines,
      '</available_skills>',
      '',
      `If the task clearly matches a skill, load it with the \`${toolName}\` tool. Use \`skill_scout\` when the match is unclear.`,
      '</system-reminder>',
    ].join('\n');
  }

  function filterFullCatalogText(message, disabled) {
    return message.content.map((block) => {
      if (!block || block.type !== 'text' || typeof block.text !== 'string') return block;
      const lines = block.text.split('\n').filter((line) => {
        const match = CATALOG_LINE.exec(line);
        return !match || !disabled.has(match[1]);
      });
      return { ...block, text: lines.join('\n') };
    });
  }

  // ---- 注册表定时爬取：随宿主运行 --------------------------------------
  const registryRefreshMs = Number(config.registryCrawlMs) > 0
    ? Math.max(200, Number(config.registryCrawlMs))
    : Math.max(0, Number(state.settings.registryRefreshHours || 0)) * 3600000;
  if (registryRefreshMs > 0 && typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const timer = setInterval(() => {
        crawlRegistry({ limitRepos: 3 }).catch(() => {});
      }, registryRefreshMs);
      if (typeof timer.unref === 'function') timer.unref();
      return () => clearInterval(timer);
    });
  }

  const skillsShRefreshMs = Number(config.skillsShCrawlMs) > 0
    ? Math.max(200, Number(config.skillsShCrawlMs))
    : Math.max(0, Number(state.settings.skillsShRefreshHours || 0)) * 3600000;
  if (skillsShRefreshMs > 0 && typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const timer = setInterval(() => {
        if (state.settings.useSkillsSh === false) {
          crawlRegistry({ limitRepos: 3 }).catch(() => {});
        } else {
          crawlSkillsSh(Number(state.settings.skillsShLimit) || 2000).catch(() => {});
        }
      }, skillsShRefreshMs);
      if (typeof timer.unref === 'function') timer.unref();
      return () => clearInterval(timer);
    });
  }

  const idleDisableDays = Math.max(0, Number(state.settings.idleDisableDays) || 0);
  if (idleDisableDays > 0 && typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          const cutoff = Date.now() - idleDisableDays * 86400000;
          let changed = false;
          for (const [name, meta] of Object.entries(state.skills || {})) {
            if (!meta || meta.enabled === false || meta.pin === true) continue;
            const last = Number((state.stats[name] || {}).last) || 0;
            if (last > 0 && last < cutoff) {
              meta.enabled = false;
              recordEvent('toggle', name, { scope: 'skill', op: 'idle_disable', enabled: false });
              pushAction({ kind: 'toggle', name, before: true, after: false, via: 'idle' });
              recordAudit({ actor: 'idle', action: 'disable_idle', target: name });
              changed = true;
            }
          }
          if (changed) {
            invalidate();
            persist();
          }
        } catch { /* idle policy must never crash the host */ }
      }, 24 * 3600000);
      if (typeof timer.unref === 'function') timer.unref();
      return () => clearInterval(timer);
    });
  }

  // ---- 内置体检：随宿主运行，无需外部定时任务 --------------------------
  const healthCheckMs = Number(config.healthCheckMs) > 0
    ? Math.max(50, Number(config.healthCheckMs))
    : Math.max(0, Number(state.settings.healthCheckHours || 0)) * 3600000;
  if (healthCheckMs > 0 && typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const timer = setInterval(async () => {
        try {
          const report = await diagnoseSkills(undefined, { limit: 40 });
          try {
            appendFileSync(path.join(storeDir, 'health-history.ndjson'), `${JSON.stringify({ at: report.at, checked: report.checked, issues: report.issues })}\n`, 'utf8');
          } catch { /* history optional */ }
        } catch { /* health check must never crash the host */ }
      }, healthCheckMs);
      if (typeof timer.unref === 'function') timer.unref();
      return () => clearInterval(timer);
    });
  }

  // ---- 策略段落：自主度 + 动态「被关闭技能」清单 ------------------------
  applyTakeover(state.settings.takeoverSkill);
  try {
    const order = typeof ctx.systemPrompt.getSectionOrder === 'function'
      ? ctx.systemPrompt.getSectionOrder('TOOL_GOAL') + 1
      : 2401;
    const text = () => {
      const base = composePolicy(state.settings, [...disabledNames()], toolName());
      const health = state.health;
      return health && health.issues
        ? `${base}\n自诊断：${health.issues} 个技能有问题（用 skill_health 查看）。`
        : base;
    };
    ctx.systemPrompt.section({ name: 'skill-pilot:policy', order, text });
  } catch (error) {
    if (debug) console.error('dsh-skill-pilot: policy section failed', error);
  }

  // ---- 每步：自动雷达注入 + 关闭技能的目录过滤 -------------------------
  let lastAgentScope = null;
  ctx.on('agent/pre-step', async (payload, next) => {
    if (payload && payload.agent) lastAgentScope = payload.agent;
    let decision = await next();
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
    try {
      decision = await maybeAutoScout(payload, decision);
    } catch (error) {
      if (debug) console.error('dsh-skill-pilot: auto scout failed', error);
    }
    try {
      decision = await maybeNudge(payload, decision);
    } catch (error) {
      if (debug) console.error('dsh-skill-pilot: nudge failed', error);
    }
    try {
      decision = await maybePilotHint(payload, decision);
    } catch (error) {
      if (debug) console.error('dsh-skill-pilot: pilot hint failed', error);
    }
    try {
      decision = await maybeAlerts(payload, decision);
    } catch (error) {
      if (debug) console.error('dsh-skill-pilot: alerts failed', error);
    }
    try {
      decision = await maybeInjectTakeoverCatalog(payload, decision);
    } catch (error) {
      if (debug) console.error('dsh-skill-pilot: takeover catalog failed', error);
    }
    if (!catalogFilter) return decision;
    const disabled = disabledNames();
    const catalogMode = state.settings.catalogMode;
    if (catalogMode === 'full' && !disabled.size) return decision;
    try {
      const messages = [];
      let changed = false;
      for (const message of decision.messages) {
        const source = message && message.source;
        if (source && source.kind === 'skill-invocation' && disabled.has(source.name)) {
          changed = true;
          continue;
        }
        if (source && source.kind === 'skill-catalog' && Array.isArray(message.content)) {
          const entries = Array.isArray(source.entries)
            ? source.entries.filter((entry) => !disabled.has(entry.name))
            : null;
          const blocks = catalogMode === 'full'
            ? filterFullCatalogText(message, disabled)
            : [{ type: 'text', text: compactCatalogText(entries, catalogMode) }];
          messages.push({ ...message, content: blocks });
          changed = true;
          continue;
        }
        messages.push(message);
      }
      return changed ? { ...decision, messages } : decision;
    } catch (error) {
      if (debug) console.error('dsh-skill-pilot: catalog filter failed', error);
      return decision;
    }
  });
}



