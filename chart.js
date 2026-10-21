/**
 * chart.js — 零依赖原生 Canvas 图表工具（涨停数据看板）。
 *
 * 提供两类图表：
 *   - LimitUpChart.vertical(canvas, items, opts)   竖向柱状图（图A 时间序列 / 图C 个股）
 *   - LimitUpChart.horizontal(canvas, items, opts) 横向柱状图（图B 行业），支持点击
 *
 * 特性：devicePixelRatio 高清渲染、悬浮 tooltip、可点击（horizontal）、
 *       窗口缩放自动重绘、缺值优雅降级（value 非有限则跳过）。
 *
 * @author software-engineer
 */
(function (global) {
  'use strict';

  const COLORS = {
    up: '#ff4d4f',
    down: '#16c784',
    warn: '#f0883e',
    accent: '#58a6ff',
    grid: '#2a2f3a',
    axis: '#3a4150',
    text: '#e6edf3',
    sub: '#8b949e',
    barAlt: '#f0883e',
    barAlt2: '#ff7a45',
  };

  // 重绘注册表：窗口缩放时按注册顺序重绘
  const registry = [];

  /** 创建/复用全局 tooltip 元素 */
  function ensureTooltip() {
    let el = document.getElementById('__chart_tip');
    if (!el) {
      el = document.createElement('div');
      el.id = '__chart_tip';
      el.style.cssText =
        'position:fixed;z-index:9999;pointer-events:none;background:rgba(13,17,23,0.95);' +
        'border:1px solid #2a2f3a;color:#e6edf3;padding:6px 9px;border-radius:6px;' +
        'font-size:12px;line-height:1.4;box-shadow:0 2px 8px rgba(0,0,0,0.5);display:none;white-space:nowrap;';
      document.body.appendChild(el);
    }
    return el;
  }

  /**
   * 高清画布初始化。返回 {ctx, w, h}（均为 CSS 像素逻辑尺寸）。
   * @param {HTMLCanvasElement} canvas
   */
  function setupHiDPI(canvas) {
    const dpr = global.devicePixelRatio || 1;
    let cssW = canvas.clientWidth;
    let cssH = canvas.clientHeight;
    if (!cssW || !cssH) {
      // 兜底：用父容器宽度
      const parent = canvas.parentElement;
      cssW = (parent && parent.clientWidth) || 600;
      cssH = parseInt(canvas.style.height, 10) || 260;
    }
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    return { ctx, w: cssW, h: cssH };
  }

  /** 计算坐标轴“漂亮”的上界 */
  function niceMax(v) {
    if (v <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / pow;
    let step;
    if (n <= 1) step = 1;
    else if (n <= 2) step = 2;
    else if (n <= 5) step = 5;
    else step = 10;
    return step * pow;
  }

  /** 精简数字格式（大数用 k/w 不合适，这里统一保留合适小数） */
  function fmtAxis(v) {
    if (v >= 10000) return (v / 10000).toFixed(v % 10000 === 0 ? 0 : 1) + '万';
    if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
    return String(Math.round(v * 100) / 100);
  }

  /**
   * 竖向柱状图。
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{label:string, value:number, color?:string, key?:string}>} items
   * @param {Object} [opts] { title, valueFmt(v), highlightKey, onHover(item) }
   */
  function vertical(canvas, items, opts) {
    opts = opts || {};
    const { ctx, w, h } = setupHiDPI(canvas);
    const padL = 46, padR = 14, padT = 18, padB = 46;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const valid = items.filter((it) => Number.isFinite(it.value));
    const maxV = niceMax(valid.length ? Math.max(...valid.map((it) => it.value)) : 1);

    // 网格 + Y 轴刻度
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'middle';
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const y = padT + (plotH * i) / ticks;
      const val = maxV * (1 - i / ticks);
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = COLORS.sub;
      ctx.textAlign = 'right';
      ctx.fillText(fmtAxis(val), padL - 6, y);
    }

    const n = items.length;
    const slot = plotW / Math.max(n, 1);
    const barW = Math.min(slot * 0.62, 46);
    const bars = [];
    let highlightedDrawn = false;

    items.forEach((it, i) => {
      const cx = padL + slot * i + slot / 2;
      const x = cx - barW / 2;
      const isHi = opts.highlightKey && it.key === opts.highlightKey;
      let yTop, barH;
      if (Number.isFinite(it.value)) {
        barH = (it.value / maxV) * plotH;
        yTop = padT + plotH - barH;
        const color = it.color || (isHi ? COLORS.warn : COLORS.up);
        ctx.fillStyle = color;
        if (isHi) {
          ctx.shadowColor = color;
          ctx.shadowBlur = 10;
        }
        ctx.fillRect(x, yTop, barW, barH);
        ctx.shadowBlur = 0;
        // 顶部数值
        ctx.fillStyle = COLORS.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const vtxt = opts.valueFmt ? opts.valueFmt(it.value) : fmtAxis(it.value);
        if (barH > 12) ctx.fillText(vtxt, cx, yTop - 2);
        ctx.textBaseline = 'middle';
      } else {
        yTop = padT + plotH;
        barH = 0;
      }
      bars.push({ x, y: yTop, w: barW, h: Math.max(barH, 0), item: it, cx });

      // X 轴标签（多则旋转）
      ctx.fillStyle = isHi ? COLORS.warn : COLORS.sub;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const label = it.label || '';
      if (n > 9) {
        ctx.save();
        ctx.translate(cx, padT + plotH + 6);
        ctx.rotate(-Math.PI / 4);
        ctx.textAlign = 'right';
        ctx.fillText(label, 0, 0);
        ctx.restore();
      } else {
        ctx.fillText(label.length > 6 ? label.slice(0, 6) : label, cx, padT + plotH + 6);
      }
      if (isHi) highlightedDrawn = true;
    });

    canvas._bars = bars;
    canvas._tipType = 'vertical';
    register(canvas, 'vertical', { items, opts });
    return bars;
  }

  /**
   * 横向柱状图（图B 行业）。支持点击回调。
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{label:string, value:number, color?:string, key?:string, active?:boolean}>} items
   * @param {Object} [opts] { valueFmt(v), onClick(item) }
   */
  function horizontal(canvas, items, opts) {
    opts = opts || {};
    const { ctx, w, h } = setupHiDPI(canvas);
    const padL = 96, padR = 60, padT = 12, padB = 8;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const valid = items.filter((it) => Number.isFinite(it.value));
    const maxV = niceMax(valid.length ? Math.max(...valid.map((it) => it.value)) : 1);

    const n = items.length;
    const slot = plotH / Math.max(n, 1);
    const barH = Math.min(slot * 0.7, 26);
    const bars = [];

    items.forEach((it, i) => {
      const cy = padT + slot * i + slot / 2;
      const y = cy - barH / 2;
      const val = Number.isFinite(it.value) ? it.value : 0;
      const bw = (val / maxV) * plotW;
      const color = it.active ? COLORS.accent : it.color || COLORS.up;
      // 条
      ctx.fillStyle = color;
      if (it.active) { ctx.shadowColor = color; ctx.shadowBlur = 8; }
      ctx.fillRect(padL, y, bw, barH);
      ctx.shadowBlur = 0;
      // 行业名（右侧对齐于 padL 左侧）
      ctx.fillStyle = it.active ? COLORS.accent : COLORS.text;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.font = '12px sans-serif';
      ctx.fillText(it.label || '', padL - 8, cy);
      // 数值（条末）
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'left';
      const vtxt = opts.valueFmt ? opts.valueFmt(val) : fmtAxis(val);
      ctx.fillText(vtxt, padL + bw + 6, cy);
      bars.push({ x: padL, y, w: plotW, h: barH, item: it, cy });
    });

    canvas._bars = bars;
    canvas._tipType = 'horizontal';
    register(canvas, 'horizontal', { items, opts });
    return bars;
  }

  // ----------------------------------------------------------------------
  // 悬浮 tooltip 与点击（事件只绑定一次）
  // ----------------------------------------------------------------------
  function findBar(canvas, type, px, py) {
    const bars = canvas._bars || [];
    if (type === 'vertical') {
      for (const b of bars) {
        if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b;
      }
      return null;
    } else {
      // horizontal：按行命中（整行可点）
      for (const b of bars) {
        if (py >= b.y && py <= b.y + b.h) return b;
      }
      return null;
    }
  }

  function bindEvents() {
    if (bindEvents._done) return;
    bindEvents._done = true;
    const tip = ensureTooltip();
    let hoverCanvas = null;

    document.addEventListener('mousemove', (e) => {
      const canvas = e.target;
      if (!(canvas && canvas.tagName === 'CANVAS')) {
        if (hoverCanvas) { tip.style.display = 'none'; hoverCanvas = null; }
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const b = findBar(canvas, canvas._tipType, px, py);
      if (b && Number.isFinite(b.item.value)) {
        hoverCanvas = canvas;
        tip.style.display = 'block';
        tip.style.left = e.clientX + 12 + 'px';
        tip.style.top = e.clientY + 12 + 'px';
        const it = b.item;
        const reg = registry.find((r) => r.canvas === canvas);
        const vf = reg && reg.opts && reg.opts.valueFmt;
        const unit = (reg && reg.opts && reg.opts.unit) || '';
        const valTxt = vf ? vf(it.value) : fmtAxis(it.value);
        tip.innerHTML = `<b>${it.label || it.key || ''}</b><br>${valTxt}${unit ? ' ' + unit : ''}`;
        canvas.style.cursor = canvas._tipType === 'horizontal' ? 'pointer' : 'default';
      } else {
        tip.style.display = 'none';
        canvas.style.cursor = 'default';
        if (hoverCanvas === canvas) hoverCanvas = null;
      }
    });

    document.addEventListener('mouseout', (e) => {
      if (e.target && e.target.tagName === 'CANVAS') {
        tip.style.display = 'none';
      }
    });

    document.addEventListener('click', (e) => {
      const canvas = e.target;
      if (!(canvas && canvas.tagName === 'CANVAS')) return;
      if (canvas._tipType !== 'horizontal') return;
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const b = findBar(canvas, 'horizontal', px, py);
      if (b) {
        const reg = registry.find((r) => r.canvas === canvas);
        if (reg && reg.opts && reg.opts.onClick) reg.opts.onClick(b.item);
      }
    });

    let rt = null;
    global.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(redrawAll, 120);
    });
  }

  /** 注册以便窗口缩放重绘 */
  function register(canvas, type, payload) {
    bindEvents();
    const existing = registry.find((r) => r.canvas === canvas);
    if (existing) {
      existing.type = type;
      existing.items = payload.items;
      existing.opts = payload.opts;
    } else {
      registry.push({ canvas, type, items: payload.items, opts: payload.opts });
    }
  }

  /** 全部重绘（resize 时） */
  function redrawAll() {
    for (const r of registry) {
      if (r.type === 'vertical') vertical(r.canvas, r.items, r.opts);
      else if (r.type === 'horizontal') horizontal(r.canvas, r.items, r.opts);
    }
  }

  global.LimitUpChart = { vertical, horizontal, redrawAll, COLORS };
})(window);
