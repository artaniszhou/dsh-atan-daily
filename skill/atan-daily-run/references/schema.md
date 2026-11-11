# 数据契约写法（report-contract/v2）

> 状态：v2 已启用。**v1（字段驱动、`x-present`）不再支持**：没有 `x-blocks` 的契约会被判无效，按本文重建，并把 `x-revision` +1。

契约是「这份报告要哪些数据、按什么版面呈现」的合同，放在任务目录：

```text
<任务目录>/.share/
├── task-schema.json    当前契约（随任务上传）
├── task-detail.md      任务细节
└── charts/             自定义图形脚本（随任务上传）
```

契约由首轮会话生成。之后每次运行先比较 `.share/task-detail.md` 的 hash 与契约里的 `x-detail-hash`：一致就按契约取数；不一致按 `SKILL.md` §5.2 的三级判断处理。一个任务只有一份当前契约，插件不做契约快照，也不保留历史版本。

## 两层结构

一份契约 = **数据定义**（JSON Schema 子集）+ **版面**（`x-blocks` 块树）。数据定义说「有什么字段、什么类型」，块树说「先放什么、后放什么、每个块用哪个字段」。

```json
{
  "x-revision": 1,
  "type": "object",
  "required": ["asOf", "banks"],
  "properties": {
    "asOf":  { "type": "string", "format": "date", "x-label": "数据截止" },
    "banks": { "type": "array", "items": { "…": "…" } }
  },
  "x-blocks": [
    { "component": "kv", "fields": ["asOf"] },
    { "component": "heading", "level": 2, "text": "明细" },
    { "component": "table", "source": "banks", "columns": ["name", "yield"], "sort": "-yield" }
  ]
}
```

**块只引用字段，不复制数据**：`source` 写字段名，`fields` 写字段名数组。数据本体仍然在 `report.json` 的 `data` 里，由插件按契约校验。

## 硬性要求

| 项 | 要求 |
|---|---|
| 根节点 | 必须是 `"type": "object"` |
| 版本 | 必须有 `x-revision`，整数，从 1 开始 |
| 字段 | `properties` 至少一个字段 |
| 必填 | `required` 里的每一项都必须在 `properties` 里声明 |
| 数组 | 必须有 `items`，否则渲染器推不出表格列 |
| 版面 | 必须有 `x-blocks`，至少一个块 |
| 绑定 | 每个数据块的 `source` / `fields` 必须指向已声明的字段 |
| 表格 | `table` 必须显式给 `columns`，列名必须在 `items.properties` 里 |
| 图表 | `chart` 的每个 `series.y` 必须在 `items.properties` 里 |

不满足任何一条，插件判契约无效，并回退成「原始数据」报告——报告照出，但会带一条失败原因。

## 块目录

| 组件 | 作用 | 必填 | 可选 |
|---|---|---|---|
| `heading` | 分区标题 | `text` | `level` 1–3 |
| `paragraph` | 段落 | `text` | — |
| `list` | 列表 | `items` 或 `source` | `ordered` |
| `quote` | 引用/结论 | `text` | `cite` |
| `note` | 提示框 | `text` | `tone` |
| `divider` | 分隔线 | — | — |
| `kv` | 键值行 | `fields` | — |
| `metrics` | 指标卡 | `source` | — |
| `table` | 表格 | `source`、`columns` | `title`、`sort`、`foldAbove`、`limit` |
| `timeline` | 时间线 | `source` | — |
| `chart` | 图表 | `source`、`series` | `x`、`title`、`height`、`legend`、`unit`、`yAxes` |
| `columns` | 分栏容器 | `ratio`、`children` | — |
| `card` | 卡片容器 | `children` | `title` |

### 标题切分区

`heading` 的 `level` 1–2 会开一个新分区并自动编号（01、02…）；`level: 3` 是分区内的小节标题，不占编号。第一个标题之前的内容属于无标题的主体区。

```json
{ "component": "heading", "level": 2, "text": "关键指标" }
```

标题只写名词短语，不要写成一句话，也不要靠标题表达结论（结论放 `summary.lead` 或 `quote`）。

### 数据块怎么绑字段

```json
{ "component": "kv",      "fields": ["asOf", "updatedAt"] }
{ "component": "metrics", "source": "summaryMetrics" }
{ "component": "table",   "source": "banks", "columns": ["name", "yield"] }
{ "component": "timeline","source": "events" }
{ "component": "chart",   "source": "trend", "x": "period", "series": [{ "type": "line", "y": "median" }] }
```

- `kv` 的 `fields` 是按行序排列的字段名；对象字段会展开成多行。
- 其余数据块的 `source` 都是**数组字段**，一行一条记录。
- 同一个字段可以被多个块引用（例如同一份数据既出图又出小表），这不算重复。

### 表格

```json
{
  "component": "table",
  "source": "banks",
  "title": "股息率前五",
  "columns": ["name", "yield", "payout"],
  "sort": "-yield",
  "foldAbove": 20,
  "limit": 50
}
```

- `columns` 是白名单，不是提示：只渲染写出来的字段，顺序就是列顺序。
- `sort`：`-field` 降序、`+field` 或 `field` 升序；缺失值永远排最后。
- `foldAbove`：超过多少行时折叠；长表一定要设（PNG 有高度上限）。
- `title`：表上方的小标题；同一分区里有两张表时务必各给一个。

### 图表

一个 `chart` 块是一组 `series`：每个系列自带类型与纵轴字段，多个系列即组合图。

```json
{
  "component": "chart",
  "source": "monthly",
  "x": "month",
  "title": "分红金额与收益率",
  "height": 260,
  "yAxes": [{ "unit": "亿元" }, { "unit": "%", "position": "right" }],
  "series": [
    { "type": "bar",  "y": "amount", "yAxisIndex": 0 },
    { "type": "line", "y": "rate",   "yAxisIndex": 1, "tone": "warn" }
  ]
}
```

| 系列键 | 说明 |
|---|---|
| `type` | `line` / `bar` / `area` / `pie` / `funnel` / `scatter` / `effectScatter` / `sparkline` / `candlestick` / `boxplot` / `heatmap` / `gauge` |
| `y` | 单值系列的纵轴字段名，必须在 `items.properties` 里 |
| `fields` | 多字段系列：`candlestick` 要 4 个（open/close/low/high）、`boxplot` 要 5 个（min/q1/median/q3/max）、`radar` 要 3–8 个数值维度 |
| `value` | `heatmap` 的数值字段名 |
| `name` | 图例名，缺省用字段的 `x-label` |
| `yAxisIndex` | 用第几根纵轴，0 起；双轴时配合 `yAxes` |
| `stack` | 堆叠 |
| `smooth` | 平滑曲线 |
| `tone` | `info` / `ok` / `warn` / `err`，用语义色代替色板顺序 |
| `min` / `max` | `gauge` 的量程，默认 0–100 |

各类型的数据形状：

| 类型 | 怎么绑定 | 说明 |
|---|---|---|
| `line` / `bar` / `area` | `y` + 块级 `x` | 可多系列、可堆叠、可双轴 |
| `pie` / `funnel` | `y` + 块级 `x`（名称） | 值必须 > 0；切片别超过 8 个 |
| `treemap` / `sunburst` | `y` + 块级 `x`（名称）；或树形数据（见下） | 单层：面积/环扇 = 数值；多层需要 `x-shape: tree` |
| `tree` | 树形数据（`x-shape: tree`） | 节点层级，带 name / value / children |
| `pictorialBar` | `y` + 块级 `x` | 象形柱，装饰性强于信息量 |
| `themeRiver` | `fields: [类别, 数值]` + 块级 `x`（日期） | 长表：一行一个「日期 × 类别 × 数值」 |
| `parallel` | `fields`（≥ 2 个数值维度）+ 块级 `x` | 一行一条折线 |
| `sankey` / `chord` | `fields: [来源, 去向, 数值]` | 边列表；节点由边自动推导 |
| `graph` | `source` 是节点，块级 `links` 是边字段；`series.layout` 取 `circular` / `none` | `none` 时节点要带 `fields: [x, y]`；`force` 已禁用 |
| `scatter` / `effectScatter` | `y` + 块级 `x`（**数值**） | x 写成期次这类字符串会让点全部丢失 |
| `sparkline` | `y` | 无坐标轴，高 64px，按数据范围缩放 |
| `candlestick` | `fields: [open, close, low, high]` | 可与均线（`line` 系列）叠在同一张图 |
| `boxplot` | `fields: [min, q1, median, q3, max]` | 五个数都缺失时不画 |
| `heatmap` | `y`（纵轴类别）+ `value`（数值），块级 `x` 为横轴类别 | 颜色只做趋势提示，数值直接写在格子上 |
| `gauge` | `y`，配合 `min` / `max` | 取第一行的值，适合单个达成率 |
| `radar` | `fields`（≥ 3 个数值维度）+ 块级 `x`（实体名） | 一行一个实体，多行即多边形的对比 |

多用一段：**层级数据**要在字段上标 `"x-shape": "tree"`，元素形状为 `{ name, value?, children? }`，`children` 递归：

```json
"org": {
  "type": "array",
  "x-shape": "tree",
  "items": {
    "type": "object",
    "required": ["name"],
    "properties": {
      "name": { "type": "string", "x-label": "部门" },
      "value": { "type": ["number", "null"], "x-label": "人数", "x-format": "count" },
      "children": { "type": "array", "items": { "$ref": "#/$defs/orgNode" } }
    }
  }
}
```

`tree` 的 `series` 不写 `y`；`treemap` / `sunburst` 在有 `x-shape: tree` 时也不写 `y`（值来自节点的 `value`）。

常用子选项（写在 `series` 上）：

| 键 | 用于 | 取值 |
|---|---|---|
| `donut` | pie | `false` 为实心（默认环形） |
| `rose` | pie | `radius` / `area` |
| `labelPosition` | pie | `inside` / `outside` / `none` |
| `showValue` | bar / line / heatmap | `true` 在图形上标数值 |
| `step` | line | `true` 阶梯线 |
| `size` | scatter | 用哪个字段决定点大小（气泡） |
| `filled` | radar | `false` 仅线不填充 |
| `sort` / `gap` | funnel | 排序方向 / 块间距 |

> `effectScatter` 的涟漪是动画，静态 PDF/PNG 里不会动，视觉上等同散点；一般直接用 `scatter`。

`pie`、`funnel`、`scatter`、`effectScatter`、`sparkline`、`heatmap`、`gauge`、`radar` 只支持单系列：多写的系列会被忽略。

### 怎么选图

先问「读者要回答什么问题」，再选类型；同一任务的图型一旦定下就**不要再改**，跨期可比比单期好看更重要。

| 读者要回答 | 用什么 | 不要用 |
|---|---|---|
| 随时间怎么变 | `line`；只看形态、不读数值时用 `sparkline`；累计/体积用 `area` | `pie` |
| 谁多谁少（≤ 8 类） | `bar`；类别 > 8 或名字长 → 表格 | `line`、`pie` |
| 构成占比 | `pie` / `funnel`（切片 ≤ 8、值 > 0） | `line`、`bar` |
| 分布形态 | `boxplot`；二维密度用 `heatmap` | `pie` |
| 两个量的关系 | `scatter`（x 必须是数值） | `line` |
| 行情开高低收 | `candlestick`（+ 均线 `line`） | `bar` |
| 单点完成度 | `gauge` 或 `metrics` | `pie` |
| 多维度对比 | `radar`（维度 3–8 个） | `bar` 堆一屏 |
| 流程 / 流向 | `sankey`（边列表） | `pie` |
| 双向关系强度 | `chord`（边列表） | `graph` |
| 少量节点的关系 | `graph`，`layout: circular` 或 `none` | `layout: force`（已禁用） |

### 目前不支持的图表类型

ECharts 还有 10 个系列没接，原因不是渲染不了，而是**数据形状不是一个平表**：

| 类型 | 为什么没接 |
|---|---|
| `sankey` / `graph` / `tree` | 需要「节点 + 边」或层级结构，契约目前只描述平表数组 |
| `treemap` / `sunburst` | 需要嵌套 `children`；单层版本等价于饼图 |
| `themeRiver` | 需要 `[日期, 数值, 名称]` 长表，字段语义与平表不同 |
| `parallel` | 需要「维度定义 + 每行一个数组」，类似雷达但要独立轴配置 |
| `map` / `lines` | 需要注册 GeoJSON 地图数据（ECharts 5 不再内置，包体会涨几 MB） |
| `pictorialBar` | 属于装饰型柱，静态报告里收益低 |
| `custom` | 需要 JS 回调，JSON 契约无法安全表达 |

需要上面任何一个时，先按「节点-边 / 层级」另立一版数据模型，再谈渲染。

三条渲染规则：

- 图表**随页面缩放**：SVG 只有 `viewBox`，宽度交给容器；精确数值始终在图下的「数据表」里。
- `null` 画成断点（折线断开、柱子缺失），不插值、不补零。
- 一整列全是 `null` 时不出图，改出一句「本期没有可用于绘图的数据」。

### 容器

`card` 给一组块套标题与边框：

```json
{ "component": "card", "title": "口径", "children": [
  { "component": "list", "ordered": true, "items": ["股息率 = 每股分红 ÷ 收盘价", "金额为税前"] }
] }
```

`columns` 分栏，`ratio` 与 `children` **一一对应，children 的每一项是一栏（一组块）**：

```json
{
  "component": "columns",
  "ratio": [2, 1],
  "children": [
    [{ "component": "table", "source": "banks", "columns": ["name", "yield"] }],
    [{ "component": "note", "tone": "info", "text": "样本仅含 A 股。" }]
  ]
}
```

容器最多两层（`columns` 里放 `card` 可以，再往下不要嵌套）；`ratio` 至少两栏。

## 数字与缺失

| 注解 | 作用 |
|---|---|
| `x-label` | 表头、指标名、键值行名、图例名 |
| `x-unit` | 单位，如 `%`、`亿元` |
| `x-format` | `percent` / `money` / `count` / `date` / `ratio` / `integer` |

`x-format` 的显示规则（选错了数字会变形）：

| 值 | 效果 | 用在哪 |
|---|---|---|
| `money` | `5,800.00 元` —— 固定两位小数 + 千分位 | 金额 |
| `percent` | `86.9%` —— 最多两位，不补零 | 比率、占比 |
| `ratio` | `5800.00` —— 固定两位，无千分位 | 需要两位但不要分隔符 |
| `count` / `integer` | `6 笔` —— 整数 | 笔数、家数 |
| `date` | 原样输出 | 日期字符串 |

中文单位会自动和数字之间留一个空格，`%` 这类符号单位不留。

拿不到的数据**留在契约里**，值写 `null`：

- 不许把字段删掉躲过去：下一期接口好了字段又回来，跨期就断了。
- 不许补零、不许写 `0` 冒充缺失。
- 每处 `null` 都要在报告的 `missing[]` 里登记原因，否则插件会给一条「未标注的缺失」提示。

## 契约怎么变

| 变更 | 处理 |
|---|---|
| 只更新 `x-detail-hash`（明细无实质变化） | 只改 hash，不动 `x-revision` |
| 新增可选字段 | 直接加，不用改 `x-revision` |
| 新增必填字段 | `x-revision` +1，`x-changelog` 写一行 |
| 删字段 / 改类型 / 改单位 | 同上，算破坏性变更 |
| 口径变化（字段不变） | 算破坏性变更，`x-revision` +1，`x-changelog` 写明口径 |
| 只改 `x-blocks`（排版、顺序、列、图表类型） | 直接改，不算契约变更，可随时重渲染 |
| 重建 | `x-revision` +1，`x-changelog` 写「重建」及原因 |

## 常见错误

| 现象 | 原因 | 改法 |
|---|---|---|
| `这是契约 v1 … 已不再支持` | 用了 `x-present` 或没有 `x-blocks` | 按本文重建契约，`x-revision` +1 |
| `source 指向的字段不存在` | 字段名拼错或没声明 | 按提示的可用字段改 |
| `table 需要 columns` | 只写了 `source` | 补列白名单 |
| `columns 引用了不存在的字段` | 列名拼错 | 按提示的可用字段改 |
| `系列字段 X 不在 … items.properties 里` | 图表 `y` 写错 | 改字段名 |
| `yAxisIndex 超出 yAxes 数量` | 双轴没声明 `yAxes` | 补 `yAxes` 或把索引改回 0 |
| `columns 的 ratio … 与 children … 数量必须一致` | 分栏数与比例数不同 | 对齐两者 |
| `字段 X 没有被任何块引用` | 契约里声明了但版面没用 | 补一个块，或从 `properties` 删掉 |
| `数组缺少 items` | 只写了 `type: "array"` | 补元素结构 |

## 写契约时的判断顺序

1. 先想清楚读者要回答什么问题，再决定字段——不要照着数据源的表结构抄。
2. 再想版面顺序：一句话结论 → 关键指标 → 明细 → 趋势 → 口径与出处。
3. 一个字段只承载一个含义；同一个含义不要出现两种写法。
4. 能算出来的不存（股息率 = 每股分红 / 股价），存原始值并让脚本算。
5. 时间字段统一 `type: "string", format: "date"`。
6. 顶层保持 3–8 个字段；块数控制在 12 个以内，长表用 `foldAbove` 折叠。
7. 文字块（`paragraph` / `quote`）只写判断与口径，不写数据搬运——数据都在表格与图表里。
