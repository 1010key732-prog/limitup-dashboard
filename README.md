# 涨停数据看板（A股 · 零依赖静态版）

一个**零依赖、零构建**的 A 股涨停数据看板：纯静态 `HTML/CSS/JS`（原生 Canvas 画图，不依赖任何 CDN / 框架 / npm），配套一个**零依赖 Node 抓取脚本**（仅用内置 `fetch`）生成数据快照。可直接部署到 GitHub Pages 或任意静态服务器。

## ✨ 功能

- **KPI 概览**：涨停数、连板最高、总成交额（亿）、炸板数（回落开板）。
- **图A 历日涨停数走势**：所有已归档交易日的涨停数时间序列（来自 `data/index.json`）。
- **图B 行业分布 Top10**：横向柱状图，可一键切换「按涨停数 / 按成交额亿」；**点击行业横条可筛选下方表格**。
- **图C 个股成交额 Top15**：竖向柱状图。
- **连板梯队**：1板（首板）/ 2板 / 3板 / 4板及以上 的数量分布。
- **明细表格**：代码 / 名称 / 行业 / 连板 / 封单比% / 封单额万 / 成交额亿 / 换手% / 首次封板；表头可点击排序（默认按连板降序）；涨停以红字红边高亮；缺失数值显示 `--`。
- **容错**：数据加载失败时仅顶部细条提示（不弹窗），所有数值均经 `Number.isFinite` 校验。

## 🚀 本地预览

任意静态服务器即可（注意：直接 `file://` 打开会因浏览器同源策略无法 `fetch` 本地 JSON，请用本地服务器）：

```bash
# 任选其一，在项目根目录执行：
python3 -m http.server 8080
# 或
npx serve .
```

然后访问 `http://localhost:8080/`。

## 📥 抓取数据

```bash
node fetch/limitup.mjs            # 抓取“今天”（自动回退到最近一个有数据的交易日）
node fetch/limitup.mjs 2026-10-21 # 抓取指定日期
```

脚本会：

1. 清除代理环境变量后直连东方财富 `push2ex` 涨停池（参数 `date=YYYYMMDD` + `dpt=wz.ztzt`）；东财不可用时自动切换新浪涨停池兜底。
2. 归一化字段并写出 `data/<YYYY-MM-DD>.json`（当日完整快照）。
3. 扫描 `data/` 下所有日期文件，**升序**重建 `data/index.json`（供时间序列与时间轴使用）。

### 输出字段说明（`data/<日期>.json` 中每条 `zt`）

| 字段 | 含义 | 单位 |
| --- | --- | --- |
| `code` / `name` | 代码 / 名称 | — |
| `price` | 现价 | 元 |
| `pct` | 涨幅 | % |
| `amountYi` | 成交额 | 亿元 |
| `fcap` / `fcapYi` | 流通市值 | 元 / 亿元 |
| `turn` | 换手率 | % |
| `boards` | 连板数（首板为 1） | — |
| `days` | 连续涨停天数 | — |
| `firstTime` / `lastTime` | 首次 / 最后封板时间 | `HH:MM:SS` |
| `fund` / `fundWan` | 封单额 | 元 / 万元 |
| `fundRatio` | 封单比 = 封单额 / 流通市值 | [0,1] |
| `zbc` | 炸板数（0 表示未炸板） | — |
| `industry` | 行业板块 | — |

## 🗂 目录结构

```
limitup-dashboard/
├── index.html          # 页面结构
├── style.css           # 深色 A股主题样式（涨红跌绿）
├── chart.js            # 零依赖原生 Canvas 图表（高清 + tooltip + 可点击）
├── app.js              # 数据加载 / 渲染 / 交互
├── fetch/
│   └── limitup.mjs     # 零依赖 Node 抓取脚本
├── data/               # 数据快照（脚本生成，建议提交到仓库）
│   ├── index.json      # 升序聚合索引
│   └── YYYY-MM-DD.json # 每日完整快照
├── .github/workflows/daily.yml  # 每日北京 16:00 自动抓取并提交
└── README.md
```

## 🤖 自动更新（GitHub Actions）

`.github/workflows/daily.yml` 在每个交易日**北京 16:00** 运行抓取脚本，并将新的 `data/` 文件提交回仓库（best-effort，网络/接口异常时跳过）。这样 GitHub Pages 站点每天自动更新。也可手动触发 `workflow_dispatch`。

## ⚠️ 免责声明

数据来自东方财富 / 新浪公开行情接口，仅供研究与学习，**不构成任何投资建议**。涨停定义以接口返回为准；盘中数据为快照，可能与收盘略有差异。
