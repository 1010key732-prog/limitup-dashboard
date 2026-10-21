/**
 * app.js — 涨停数据看板主逻辑（零依赖）。
 *
 * 流程：
 *   1. 加载 data/index.json  -> 填充日期下拉 + 渲染图A（历日走势）
 *   2. 加载选中日期 data/<date>.json -> 渲染 KPI / 图B / 图C / 连板梯队 / 表格
 *   3. 交互：行业横条点击筛选、表格排序、图B 切换（涨停数/成交额）
 *
 * 容错：fetch 失败仅显示顶部细条（不弹窗），缺失数值显示 “--” 且经 Number.isFinite 校验。
 *
 * @author software-engineer
 */
(function () {
  'use strict';

  const state = {
    index: null,
    currentDate: null,
    day: null,
    sortKey: 'boards',
    sortDir: 'desc',
    industryFilter: null,
    bMode: 'count', // 'count' 按涨停数 | 'amount' 按成交额亿
  };

  // ----------------------------------------------------------------------
  // 工具函数
  // ----------------------------------------------------------------------

  /** 安全数字格式化：非有限值返回 '--'。 */
  function fmt(v, dec) {
    return Number.isFinite(v) ? Number(v).toFixed(dec) : '--';
  }

  /** 拉取 JSON，失败抛错（由调用方决定如何提示）。 */
  async function fetchJSON(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  }

  function showStatus(msg, ok) {
    const el = document.getElementById('statusBar');
    el.hidden = false;
    el.textContent = msg;
    el.classList.toggle('ok', !!ok);
  }
  function hideStatus() {
    document.getElementById('statusBar').hidden = true;
  }

  /** 当前展示用的行（受行业筛选影响）。 */
  function getRows() {
    const zt = (state.day && state.day.zt) || [];
    return state.industryFilter ? zt.filter((x) => x.industry === state.industryFilter) : zt;
  }

  // ----------------------------------------------------------------------
  // 初始化
  // ----------------------------------------------------------------------
  async function init() {
    bindStaticEvents();
    let index;
    try {
      index = await fetchJSON('data/index.json');
    } catch (e) {
      showStatus('无法加载 data/index.json：' + e.message + '（请先运行 fetch/limitup.mjs 生成数据）');
      renderEmpty();
      return;
    }
    state.index = index;
    const dates = (index && index.dates) || [];
    if (!dates.length) {
      showStatus('暂无已归档的交易日数据，请运行 fetch/limitup.mjs');
      renderEmpty();
      return;
    }
    const sel = document.getElementById('dateSelect');
    sel.innerHTML = '';
    dates.forEach((d) => {
      const o = document.createElement('option');
      o.value = d;
      o.textContent = d;
      sel.appendChild(o);
    });
    sel.value = dates[dates.length - 1]; // 默认最新交易日
    state.currentDate = sel.value;

    renderChartA();
    await loadDay();
  }

  async function loadDay() {
    hideStatus();
    const path = 'data/' + state.currentDate + '.json';
    let day;
    try {
      day = await fetchJSON(path);
    } catch (e) {
      showStatus('无法加载 ' + path + '：' + e.message);
      state.day = null;
      renderKPI(null);
      renderChartB(null);
      renderChartC(null);
      renderLadder(null);
      renderTable(null);
      return;
    }
    state.day = day;
    const meta = document.getElementById('metaInfo');
    meta.textContent =
      '来源: ' + (day.source || '?') +
      ' · 抓取: ' + (day.fetchTime ? day.fetchTime.replace('T', ' ').slice(0, 19) : '?');
    renderChartA(); // 高亮当前日期
    renderKPI(day);
    renderChartB(day);
    renderChartC(day);
    renderLadder(day);
    renderTable(day);
  }

  // ----------------------------------------------------------------------
  // KPI
  // ----------------------------------------------------------------------
  function renderKPI(day) {
    const totalEl = document.getElementById('kpiTotal');
    const maxEl = document.getElementById('kpiMaxBoards');
    const amtEl = document.getElementById('kpiAmount');
    const zbcEl = document.getElementById('kpiZbc');
    const rows = getRows();
    if (!day || !rows.length) {
      totalEl.textContent = '--';
      maxEl.textContent = '--';
      amtEl.textContent = '--';
      zbcEl.textContent = '--';
      return;
    }
    const total = rows.length;
    const maxBoards = Math.max(...rows.map((x) => x.boards || 0));
    const amountYi = rows.reduce((s, x) => s + (Number(x.amountYi) || 0), 0);
    const zbc = rows.reduce((s, x) => s + (Number(x.zbc) || 0), 0);
    totalEl.textContent = total;
    maxEl.textContent = maxBoards;
    amtEl.textContent = fmt(amountYi, 2);
    zbcEl.textContent = zbc;
  }

  // ----------------------------------------------------------------------
  // 图A：历日涨停数时间序列
  // ----------------------------------------------------------------------
  function renderChartA() {
    const series = (state.index && state.index.series) || [];
    if (!series.length) {
      LimitUpChart.vertical(document.getElementById('chartA'), [], {});
      return;
    }
    const items = series.map((s) => ({
      label: s.date ? s.date.slice(5) : '',
      value: Number(s.total) || 0,
      key: s.date,
    }));
    LimitUpChart.vertical(document.getElementById('chartA'), items, {
      highlightKey: state.currentDate,
      valueFmt: (v) => String(Math.round(v)),
      unit: '只',
    });
  }

  // ----------------------------------------------------------------------
  // 图B：行业分布 Top10（基于全量，不受筛选影响；高亮当前筛选行业）
  // ----------------------------------------------------------------------
  function renderChartB(day) {
    const canvas = document.getElementById('chartB');
    if (!day || !day.zt || !day.zt.length) {
      LimitUpChart.horizontal(canvas, [], { onClick: onIndustryClick });
      return;
    }
    const map = new Map();
    for (const x of day.zt) {
      const k = x.industry || '未知';
      if (!map.has(k)) map.set(k, { label: k, key: k, value: 0, count: 0 });
      const e = map.get(k);
      e.count += 1;
      e.value += state.bMode === 'amount' ? (Number(x.amountYi) || 0) : 1;
    }
    let arr = [...map.values()];
    arr.sort((a, b) => b.value - a.value);
    arr = arr.slice(0, 10).map((e) => ({
      label: e.label,
      key: e.key,
      value: state.bMode === 'amount' ? e.value : e.count,
      active: e.key === state.industryFilter,
    }));
    LimitUpChart.horizontal(canvas, arr, {
      valueFmt: (v) => (state.bMode === 'amount' ? fmt(v, 1) : String(Math.round(v))),
      unit: state.bMode === 'amount' ? '亿' : '只',
      onClick: onIndustryClick,
    });
  }

  function onIndustryClick(item) {
    state.industryFilter = state.industryFilter === item.key ? null : item.key;
    updateChip();
    renderKPI(state.day);
    renderTable(state.day);
    renderChartB(state.day);
  }

  function updateChip() {
    const chip = document.getElementById('filterChip');
    if (state.industryFilter) {
      chip.hidden = false;
      document.getElementById('filterChipText').textContent = '行业筛选：' + state.industryFilter;
    } else {
      chip.hidden = true;
    }
  }

  // ----------------------------------------------------------------------
  // 图C：个股成交额 Top15
  // ----------------------------------------------------------------------
  function renderChartC(day) {
    const canvas = document.getElementById('chartC');
    if (!day || !day.zt || !day.zt.length) {
      LimitUpChart.vertical(canvas, [], {});
      return;
    }
    const top = day.zt
      .slice()
      .sort((a, b) => (Number(b.amountYi) || 0) - (Number(a.amountYi) || 0))
      .slice(0, 15);
    const items = top.map((x) => ({
      label: x.name || x.code || '',
      value: Number(x.amountYi) || 0,
      key: x.code,
    }));
    LimitUpChart.vertical(canvas, items, {
      valueFmt: (v) => fmt(v, 1),
      unit: '亿',
    });
  }

  // ----------------------------------------------------------------------
  // 连板梯队
  // ----------------------------------------------------------------------
  function renderLadder(day) {
    const el = document.getElementById('ladder');
    if (!day || !day.zt || !day.zt.length) {
      el.innerHTML = '<div class="empty-row" style="grid-column:1/-1">— 暂无数据 —</div>';
      return;
    }
    const b1 = day.zt.filter((x) => (x.boards || 1) <= 1).length;
    const b2 = day.zt.filter((x) => x.boards === 2).length;
    const b3 = day.zt.filter((x) => x.boards === 3).length;
    const b4 = day.zt.filter((x) => (x.boards || 0) >= 4).length;
    const total = day.zt.length || 1;
    const items = [
      { n: '1板（首板）', c: b1 },
      { n: '2板', c: b2 },
      { n: '3板', c: b3 },
      { n: '4板及以上', c: b4 },
    ];
    el.innerHTML = items
      .map(
        (it) =>
          '<div class="ladder-item">' +
          '<div class="ladder-name">' + it.n + '</div>' +
          '<div class="ladder-count">' + it.c + '</div>' +
          '<div class="ladder-bar" style="width:' + Math.round((it.c / total) * 100) + '%"></div>' +
          '</div>'
      )
      .join('');
  }

  // ----------------------------------------------------------------------
  // 表格
  // ----------------------------------------------------------------------
  function renderTable(day) {
    const tbody = document.getElementById('tableBody');
    if (!day || !day.zt || !day.zt.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="9">暂无数据</td></tr>';
      return;
    }
    const rows = getRows().slice();
    const k = state.sortKey;
    const dir = state.sortDir === 'asc' ? 1 : -1;
    const isText = ['code', 'name', 'industry', 'firstTime'].includes(k);
    rows.sort((a, b) => {
      if (isText) {
        return String(a[k] || '').localeCompare(String(b[k] || ''), 'zh') * dir;
      }
      return ((Number(a[k]) || 0) - (Number(b[k]) || 0)) * dir;
    });

    tbody.innerHTML = rows
      .map((x) => {
        const frPct = Number.isFinite(x.fundRatio) ? (x.fundRatio * 100).toFixed(2) : '--';
        return (
          '<tr class="row-up">' +
          '<td>' + (x.code || '--') + '</td>' +
          '<td class="name-cell">' + (x.name || '--') + '</td>' +
          '<td><span class="tag-industry">' + (x.industry || '--') + '</span></td>' +
          '<td class="num">' + (Number.isFinite(x.boards) ? x.boards : '--') + '</td>' +
          '<td class="num">' + frPct + '</td>' +
          '<td class="num">' + fmt(x.fundWan, 2) + '</td>' +
          '<td class="num">' + fmt(x.amountYi, 2) + '</td>' +
          '<td class="num">' + fmt(x.turn, 2) + '</td>' +
          '<td>' + (x.firstTime || '--') + '</td>' +
          '</tr>'
        );
      })
      .join('');
    updateSortArrows();
  }

  function updateSortArrows() {
    document.querySelectorAll('#dataTable th.sortable').forEach((th) => {
      const old = th.querySelector('.arrow');
      if (old) old.remove();
      if (th.dataset.key === state.sortKey) {
        const s = document.createElement('span');
        s.className = 'arrow';
        s.textContent = state.sortDir === 'asc' ? '▲' : '▼';
        th.appendChild(s);
      }
    });
  }

  // ----------------------------------------------------------------------
  // 空状态
  // ----------------------------------------------------------------------
  function renderEmpty() {
    ['kpiTotal', 'kpiMaxBoards', 'kpiAmount', 'kpiZbc'].forEach((id) => {
      document.getElementById(id).textContent = '--';
    });
    document.getElementById('ladder').innerHTML =
      '<div class="empty-row" style="grid-column:1/-1">— 暂无数据 —</div>';
    document.getElementById('tableBody').innerHTML =
      '<tr class="empty-row"><td colspan="9">暂无数据</td></tr>';
    LimitUpChart.vertical(document.getElementById('chartA'), [], {});
    LimitUpChart.horizontal(document.getElementById('chartB'), [], { onClick: onIndustryClick });
    LimitUpChart.vertical(document.getElementById('chartC'), [], {});
  }

  // ----------------------------------------------------------------------
  // 静态事件绑定（仅一次）
  // ----------------------------------------------------------------------
  function bindStaticEvents() {
    const sel = document.getElementById('dateSelect');
    sel.addEventListener('change', () => {
      state.currentDate = sel.value;
      state.industryFilter = null;
      updateChip();
      loadDay();
    });

    // 表头排序
    document.querySelectorAll('#dataTable th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const k = th.dataset.key;
        if (state.sortKey === k) {
          state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortKey = k;
          state.sortDir = ['code', 'name', 'industry', 'firstTime'].includes(k) ? 'asc' : 'desc';
        }
        renderTable(state.day);
      });
    });

    // 图B 切换
    document.querySelectorAll('#bToggle .toggle-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#bToggle .toggle-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.bMode = btn.dataset.mode;
        renderChartB(state.day);
      });
    });

    // 清除筛选
    document.getElementById('filterChipClose').addEventListener('click', () => {
      state.industryFilter = null;
      updateChip();
      renderKPI(state.day);
      renderTable(state.day);
      renderChartB(state.day);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
