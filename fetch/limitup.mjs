/**
 * limitup.mjs — 涨停数据看板抓取脚本（零依赖，仅用 Node 内置 fetch）。
 *
 * 数据源：东方财富 push2ex 涨停池（getTopicZTPool）。
 *   - 本机环境已验证：push2ex.eastmoney.com 可用，参数必须用 date=YYYYMMDD 且不带横线，
 *     并携带 dpt=wz.ztzt，否则返回 rc:102 / data:null。
 *   - 若东财失败，自动切换到新浪涨停池（CN_BillBoard.GetListZTPool）兜底。
 *
 * 输出：
 *   - data/<YYYY-MM-DD>.json  当日完整快照
 *   - data/index.json         升序聚合所有日期的概要（供时间序列与时间轴使用）
 *
 * 用法：
 *   node fetch/limitup.mjs                 # 抓取“今天”（自动回退到最近一个有数据的交易日）
 *   node fetch/limitup.mjs 2026-10-21     # 抓取指定日期
 *
 * @author software-engineer
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 0. 清理代理环境变量（本机直连东财，走代理会被 TCP reset）
// ---------------------------------------------------------------------------
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[key];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');

// ---------------------------------------------------------------------------
// 1. 常量与工具函数
// ---------------------------------------------------------------------------
const EM_EX = 'https://push2ex.eastmoney.com';
const EM_UT = '7eea3edcaed734bea9cbfc24409ed989';
const EM_REF = 'https://quote.eastmoney.com/';

const SINA_POOL = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_BillBoard.GetListZTPool';

const REQUEST_TIMEOUT = 15000;
const MAX_RETRY = 3;

/**
 * 把 Date 格式化为 YYYYMMDD（东财涨停池需要的格式）。
 * @param {Date} d
 * @returns {string}
 */
function fmtCompact(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * 把 Date 格式化为 YYYY-MM-DD（输出文件命名）。
 * @param {Date} d
 * @returns {string}
 */
function fmtDash(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 安全数值转换，无法解析返回 0。
 * @param {*} v
 * @returns {number}
 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 把东财的 HHMMSS 整数时间转成 "HH:MM:SS"；0 / 空 / 非法返回空串。
 * @param {number|string|null|undefined} v
 * @returns {string}
 */
function fmtTime(v) {
  if (v === undefined || v === null || v === '' || v === 0) return '';
  const s = String(v).padStart(6, '0');
  if (s.length !== 6) return '';
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

/**
 * 保留 n 位小数的四舍五入（避免浮点误差）。
 * @param {number} v
 * @param {number} n
 * @returns {number}
 */
function round(v, n) {
  const f = Math.pow(10, n);
  return Math.round((num(v) + Number.EPSILON) * f) / f;
}

// ---------------------------------------------------------------------------
// 2. HTTP 封装：超时 + 重试
// ---------------------------------------------------------------------------
/**
 * 带超时与重试的 fetch（返回解析后的 JSON）。
 * @param {string} url
 * @param {Object} [headers]
 * @returns {Promise<any>}
 */
async function fetchJSON(url, headers = {}) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      // 短暂退避后重试
      await new Promise((r) => setTimeout(r, 400 * attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('fetchJSON failed');
}

// ---------------------------------------------------------------------------
// 3. 数据源：东财涨停池
// ---------------------------------------------------------------------------
/**
 * 拉取东财涨停池原始数据（支持分页，单页上限 2000）。
 * @param {string} compactDate YYYYMMDD
 * @returns {Promise<{date:string, tc:number, pool:Array<Object>}>}
 */
async function fetchEastmoney(compactDate) {
  const all = [];
  let tc = 0;
  let page = 0;
  // 最多翻 10 页（每页 2000，理论上限 20000，足够覆盖极端行情）
  for (let p = 0; p < 10; p++) {
    const url =
      `${EM_EX}/getTopicZTPool?ut=${EM_UT}&dpt=wz.ztzt&Pageindex=${p}` +
      `&pagesize=2000&sort=fbt%3Aasc&date=${compactDate}`;
    const j = await fetchJSON(url, { Referer: EM_REF });
    if (!j || j.rc !== 0 || !j.data) {
      if (p === 0) throw new Error(`东财返回异常 rc=${j?.rc}`);
      break;
    }
    const pool = Array.isArray(j.data.pool) ? j.data.pool : [];
    tc = num(j.data.tc) || pool.length;
    all.push(...pool);
    if (pool.length < 2000) break; // 末页
  }
  return { date: compactDate, tc, pool: all };
}

// ---------------------------------------------------------------------------
// 4. 数据源：新浪涨停池（兜底）
// ---------------------------------------------------------------------------
/**
 * 拉取新浪涨停池原始数据（字段结构与东财不同，需归一化）。
 * @param {string} compactDate YYYYMMDD
 * @returns {Promise<{date:string, tc:number, pool:Array<Object>}>}
 */
async function fetchSina(compactDate) {
  const url = `${SINA_POOL}?num=3000&page=1&sort=symbol&asc=0&symbol=&_s_r_a=page`;
  const j = await fetchJSON(url, { Referer: 'https://vip.stock.finance.sina.com.cn/' });
  const rows = Array.isArray(j) ? j : (j?.result || j?.data || []);
  if (!Array.isArray(rows)) throw new Error('新浪返回非数组');
  // 新浪字段：symbol / name / trade / changepercent / amount / ... 不保证有连板/封单等明细，
  // 仅作兜底，缺失字段置 0 / 空。
  const pool = rows
    .filter((r) => String(r.symbol || '').length >= 6)
    .map((r) => {
      const code = String(r.symbol).replace(/^\w+/, '').padStart(6, '0');
      return {
        c: code,
        n: r.name || '',
        p: num(r.trade) * 1000, // 新浪 trade 是元，东财 p 是毫（元*1000）
        zdp: num(r.changepercent),
        amount: num(r.amount) * 1000, // 新浪 amount 是千元，东财 amount 是元
        ltsz: num(r.mktcap) * 10000, // 新浪 mktcap 是亿元 -> 元（近似流通）
        hs: num(r.turnoverratio),
        lbc: num(r.lbc) || 1,
        fbt: num(r.ftime) || 0,
        lbt: num(r.ltime) || 0,
        fund: 0,
        zbc: num(r.zbc) || 0,
        hybk: r.industry || '',
        zttj: { days: num(r.lbc) || 1, ct: num(r.lbc) || 1 },
      };
    });
  return { date: compactDate, tc: pool.length, pool };
}

// ---------------------------------------------------------------------------
// 5. 交易日探测：从 target 往前找最近一个有数据的交易日（跳过周末，最多回溯 12 天）
// ---------------------------------------------------------------------------
/**
 * @param {string} [explicitDate] 显式 YYYY-MM-DD，优先使用
 * @returns {Promise<{compact:string, dash:string, source:string, raw:Object}>}
 */
async function resolveTradeDay(explicitDate) {
  const base = explicitDate ? new Date(explicitDate + 'T00:00:00+08:00') : new Date();
  const candidates = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(base.getTime() - i * 86400000);
    const wd = d.getDay();
    if (wd === 0 || wd === 6) continue; // 跳过周末
    candidates.push(d);
  }
  for (const d of candidates) {
    const compact = fmtCompact(d);
    try {
      const data = await fetchEastmoney(compact);
      if (Array.isArray(data.pool) && data.pool.length > 0) {
        return { compact, dash: fmtDash(d), source: 'eastmoney', raw: data };
      }
    } catch (e) {
      // 东财失败 -> 试试新浪
      try {
        const sina = await fetchSina(compact);
        if (Array.isArray(sina.pool) && sina.pool.length > 0) {
          return { compact, dash: fmtDash(d), source: 'sina', raw: sina };
        }
      } catch (_) {
        /* 继续往前找 */
      }
    }
  }
  // 兜底：用今天（即使为空，也产出文件，便于前端展示“暂无数据”）
  const d0 = candidates[0] || base;
  let raw;
  let source = 'eastmoney';
  try {
    raw = await fetchEastmoney(fmtCompact(d0));
  } catch (e) {
    try {
      raw = await fetchSina(fmtCompact(d0));
      source = 'sina';
    } catch (_) {
      raw = { date: fmtCompact(d0), tc: 0, pool: [] };
    }
  }
  return { compact: fmtCompact(d0), dash: fmtDash(d0), source, raw };
}

// ---------------------------------------------------------------------------
// 6. 字段归一化
// ---------------------------------------------------------------------------
/**
 * 把单条原始记录归一化为看板标准结构。
 * @param {Object} it
 * @returns {Object}
 */
function normalize(it) {
  const code = String(it.c || '');
  const price = round(num(it.p) / 1000, 3); // 毫 -> 元
  const ltsz = num(it.ltsz); // 流通市值（元）
  const fund = num(it.fund); // 封单额（元）
  const amount = num(it.amount); // 成交额（元）
  const fundRatio = ltsz > 0 ? round(fund / ltsz, 4) : 0;
  const boards = num(it.lbc) || 1; // 连板数（首板至少 1）
  const days = num(it.zttj?.days) || num(it.days) || boards;
  return {
    code,
    name: it.n || '',
    price, // 元
    pct: round(num(it.zdp), 2), // 涨幅 %
    amountYi: round(amount / 1e8, 4), // 成交额（亿）
    fcap: ltsz, // 流通市值（元）
    fcapYi: round(ltsz / 1e8, 4), // 流通市值（亿）
    turn: round(num(it.hs), 4), // 换手 %
    boards, // 连板数
    days, // 连续涨停天数
    firstTime: fmtTime(it.fbt), // 首次封板 "HH:MM:SS"
    lastTime: fmtTime(it.lbt), // 最后封板 "HH:MM:SS"
    fund, // 封单额（元）
    fundWan: round(fund / 1e4, 2), // 封单额（万）
    fundRatio, // 封单比 = 封单额 / 流通市值
    zbc: num(it.zbc), // 炸板数（0 表示未炸板）
    industry: it.hybk || '', // 行业板块
  };
}

// ---------------------------------------------------------------------------
// 7. 写入当日文件 + 重建 index.json
// ---------------------------------------------------------------------------
/**
 * @param {string} dash YYYY-MM-DD
 * @param {string} source
 * @param {Object} raw
 * @returns {Object} 当日完整对象
 */
function buildDayFile(dash, source, raw) {
  const list = (raw.pool || []).map(normalize);
  // 摘要（前端也会从 list 重算，这里冗余存储便于只读场景）
  const maxBoards = list.reduce((m, x) => Math.max(m, x.boards), 0);
  const amountYi = round(list.reduce((s, x) => s + x.amountYi, 0), 4);
  const zbcSum = list.reduce((s, x) => s + x.zbc, 0);
  return {
    date: dash,
    source,
    fetchTime: new Date().toISOString(),
    total: raw.tc || list.length,
    summary: {
      total: raw.tc || list.length,
      maxBoards,
      amountYi,
      zbcSum,
      maxFundRatio: list.reduce((m, x) => Math.max(m, x.fundRatio), 0),
    },
    zt: list,
  };
}

/**
 * 重新扫描 data/ 下所有日期文件，升序聚合为 index.json。
 * @returns {Object}
 */
function rebuildIndex() {
  if (!existsSync(DATA_DIR)) return { dates: [], series: [] };
  const files = readdirSync(DATA_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort(); // 升序
  const series = [];
  for (const f of files) {
    try {
      const obj = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'));
      const s = obj.summary || {};
      series.push({
        date: obj.date || f.replace(/\.json$/, ''),
        total: s.total || (obj.zt ? obj.zt.length : 0),
        maxBoards: s.maxBoards || 0,
        amountYi: s.amountYi || 0,
        zbcSum: s.zbcSum || 0,
      });
    } catch (e) {
      console.warn(`[warn] 跳过无法解析的文件: ${f} (${e.message})`);
    }
  }
  return { dates: series.map((x) => x.date), series };
}

/**
 * 生成 data/bundle.js：把 index + 所有交易日打包成 window.LIMITUP_DATA。
 * 目的：用户直接双击 index.html（file:// 协议）时，浏览器会以“不透明来源”
 * 拦截 fetch('data/*.json')，导致 Failed to fetch；而 <script> 标签不受此限制。
 * 因此额外产出本文件，让本地双击与 GitHub Pages 两种打开方式都能用。
 * @param {Object} indexObj
 * @returns {string} bundle.js 的绝对路径
 */
function rebuildBundle(indexObj) {
  const days = {};
  if (existsSync(DATA_DIR)) {
    const files = readdirSync(DATA_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
    for (const f of files) {
      try {
        const obj = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'));
        days[obj.date || f.replace(/\.json$/, '')] = obj;
      } catch (e) {
        console.warn(`[warn] bundle 跳过无法解析的文件: ${f}`);
      }
    }
  }
  const payload = { index: indexObj, days: days };
  const js =
    '/* 自动生成，请勿手改。作用：file:// 直接双击打开时绕过 fetch 的 CORS 限制。 */\n' +
    'window.LIMITUP_DATA = ' +
    JSON.stringify(payload) +
    ';\n';
  const p = join(DATA_DIR, 'bundle.js');
  writeFileSync(p, js, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// 8. 主流程
// ---------------------------------------------------------------------------
async function main() {
  const arg = process.argv[2];
  console.log('[info] 解析交易日...');
  const day = await resolveTradeDay(arg);
  console.log(`[info] 目标交易日: ${day.dash}  数据源: ${day.source}  原始条数: ${day.raw.pool?.length || 0}`);

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const dayObj = buildDayFile(day.dash, day.source, day.raw);
  const dayPath = join(DATA_DIR, `${day.dash}.json`);
  writeFileSync(dayPath, JSON.stringify(dayObj, null, 2), 'utf8');
  console.log(`[ok] 已写入当日快照: ${dayPath} (涨停 ${dayObj.total} 只)`);

  const indexObj = rebuildIndex();
  const indexPath = join(DATA_DIR, 'index.json');
  writeFileSync(indexPath, JSON.stringify(indexObj, null, 2), 'utf8');
  console.log(`[ok] 已重建索引: ${indexPath} (共 ${indexObj.series.length} 个交易日)`);

  const bundlePath = rebuildBundle(indexObj);
  console.log(`[ok] 已生成 file:// 通道: ${bundlePath}`);

  // 打印一个样本，便于自检
  if (dayObj.zt.length) {
    console.log('[sample]', JSON.stringify(dayObj.zt[0]));
  }
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
