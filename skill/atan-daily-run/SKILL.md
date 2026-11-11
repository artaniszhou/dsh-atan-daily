---
name: atan-daily-run
description: 阿碳日报任务的共用执行规则：调用 atan_daily_* 工具，按 .share/task-detail.md 与 .meta/task-pipeline.json 取数并产出 report.json。
---

# 阿碳日报任务执行规则

这是所有阿碳日报任务共用的执行规则。每次执行先调用 `atan_daily_task_context`，再按需读两份任务文档：

- `.share/task-detail.md`：用户写的目标、数据源、口径、边界与输出要求。
- `.meta/task-pipeline.json`：任务的执行清单（`pipeline` 命令、`scripts` 脚本清单、`cache` 缓存清单）。

`.share/task-detail.md` 是任务内容的唯一来源；`.meta/task-pipeline.json` 只登记「怎么跑」与文件清单，不重复任务目标。两者冲突时以 `.share/task-detail.md` 为准。执行时间、时区、开关、保留天数属于 `.task/task-list.jsonl`，不写进任何一份任务文档。

**优先用工具，不要手动拼命令、算 hash、写校验脚本**：

| 工具 | 用途 |
|---|---|
| `atan_daily_task_context` | 明细 hash、契约、清单、最近运行、上期摘要 |
| `atan_daily_task_manifest` | 读/更新 `task-pipeline.json`（bootstrap、upsert 脚本/缓存、set_pipeline） |
| `atan_daily_collect` | 按清单执行取数 |
| `atan_daily_build_report` | 按清单组装 report.json 并校验 |
| `atan_daily_render` | 手动重渲染最终 PNG/PDF；执行轮次默认不调用（见 §4） |
| `atan_daily_script` | 运行 `.meta/script/` 下的单个脚本（一次性探测） |
| `atan_daily_report_tune` | 聊天里改展示/图型（草稿 → 预览 → commit） |

工具不可用时，才回退到本文的「手动路径」，并保持同样的结构与校验。

## 任务目录骨架

```text
<workDir>/
├── .task/
│   └── task-list.jsonl
└── <任务名>/
    ├── .share/                    随任务上传
    │   ├── task-detail.md         任务细节
    │   ├── task-schema.json       数据契约
    │   ├── task-display.json      外观覆盖（可选，插件与用户维护）
    │   └── charts/                自定义图形脚本（随任务上传）
    ├── .meta/                     本地运行资料，不上传
    │   ├── task-pipeline.json     执行清单：pipeline / scripts / cache（取代 index.md）
    │   ├── cache/
    │   ├── script/
    │   ├── display/               展示覆盖草稿（插件维护）
    │   ├── runs/
    │   └── build/
    │       └── <runId>/           本轮中间件；每轮结束只保留最新一轮
    │           ├── report.json    本轮数据（权威）
    │           └── report.html    插件渲染的中间件
    ├── history/
    └── <任务名>-2026-10-31_21-30-00.pdf/.png  最新最终文档
```

| 路径 | 作用 | 谁维护 |
|---|---|---|
| `.task/task-list.jsonl` | 任务元数据唯一权威；不重复名称、执行时间、时区、开关、保留天数 | 插件 |
| `.share/task-detail.md` | 任务目标与细节：数据源、口径、范围、边界；随任务上传 | 用户 / 执行中的 agent |
| `.share/task-schema.json` | 数据契约：这轮要哪些数据、什么类型、怎么呈现；随任务上传 | 首轮由 agent 建立；之后按 §5.2 分级修订 |
| `.share/task-display.json` | 外观覆盖：字号、颜色、间距、图表高度、点径、数据表显隐；稀疏补丁，可选；随任务上传 | 用户与插件；agent 不读不写 |
| `.meta/task-pipeline.json` | 执行清单：`pipeline` 命令、`scripts` 脚本清单、`cache` 缓存清单；取代旧 `index.md` | 插件生成/迁移；agent 用 `atan_daily_task_manifest` 更新 |
| `.meta/display/draft.json` | 当前改动草稿（存在即表示有未完成修改）；commit/discard 后删除 | 插件 + 用户 |
| `.share/charts/` | 自定义图形脚本，随任务上传；单文件 `.mjs`，运行时在受限子进程执行 | 用户 / 执行中的 agent |
| `.meta/cache/` | 稳定数据 | 执行中的 agent / 脚本 |
| `.meta/script/` | 脚本，优先 Python | 执行中的 agent |
| `.meta/runs/` | 每次运行一个 JSON，由插件写入 | 插件 |
| `.meta/build/<runId>/` | 本轮中间件：`report.json`、`report.html`；每轮结束只保留最新一轮 | 本次运行 + 插件 |
| `history/` | 历次最终文档；每轮开始前由插件把上一轮移进来 | 插件 |
| 任务根 `<任务名>-<时间>.pdf/.png` | 最新最终文档 | 插件 |

`.share/` 是随任务上传的部分（任务细节 + 数据契约 + 外观覆盖 + 自定义图形）；`.meta/` 是本地资料区：`cache/`、`script/` 由任务执行维护，`runs/` 由插件写运行记录，`build/` 放每轮中间件（每轮结束只保留最新一轮，更早的直接删掉）。`history/` 也由插件维护，只在需要回看旧报告时读它，不要往里写文件。

## 执行要求

### 1. 目标最小化

1. 默认只做「完成用户目标所需的最小集合」：不自行增加数据源、分析维度、图表、建议或额外交付物。
2. 只有「任务细节」里明确写出的额外目标才做；追加目标不能顺手改变原有口径、范围或输出格式。
3. 报告结构（结论 → 关键事实 → 数据来源 → 建议动作）是输出格式，不算新增目标；没有建议就写「没有」或不写，不能为了填满而编造。

### 2. 数据与缓存

1. 行情、汇率、新闻、排名、库存、状态等每次可能变化的数据，不放入 `.meta/cache/`，也不登记为可复用缓存；每轮重新获取。脚本需要时用本次运行的临时数据，运行结束不保留。
2. 已确认或大概率不会变化的数据（标的清单、代码映射、历史分红、口径定义、接口字段说明）放入 `.meta/cache/`。以「功能 / 领域」为单位一个文件，例如 `bank-list.json`、`dividend-history.csv`，不要把所有数据塞进一个文件。
3. 缓存用 JSON / CSV 等机器可读格式；字段、单位、口径、as-of（数据截止日期）、来源固定；不存网页正文或散文。脚本应能直接读取，不用模型再解析。
4. 新增、更新或删除稳定数据时，调 `atan_daily_task_manifest({ action: "upsert_cache" / "remove_cache" })` 更新 `.meta/task-pipeline.json` 的 `cache`：路径、存储内容（含口径和 as-of）、可用场景。拿不准是否稳定时，按实时数据处理，不缓存。

### 3. 执行前的数据规划

每次执行开始，先列出本轮需要的数据项，再动手取数：

1. 已缓存且仍有效 → 直接读；
2. 已缓存但可能过期 → 做轻量校验（as-of / 版本 / 关键字段），必要时刷新；
3. 未缓存、接口稳定 → 用固定脚本获取；
4. 未缓存、需要联网确认 → 先确认来源、时间和口径，再取；
5. 无法获取 → 标记缺失，按规则回退或停下；不编造、不猜。

凡是接口稳定、参数可枚举的数据获取、校验、转换，都写成 `.meta/script/` 下的脚本；重试、字段映射、单位换算、去重和基本校验固定在脚本里，不要每轮让模型重新拼请求或解析页面。模型只做需求理解、数据分类、异常判断和必要的定性分析，不做逐条数据搬运。

### 4. 报告生成

报告不是一篇文档，而是**一份数据 + 一遍渲染**。你只负责数据，版式由插件按契约渲染。

**标准路径（优先）**：

1. `atan_daily_task_context`：拿到明细 hash、契约、清单与最近运行；
2. 若 `needsBootstrap`：按 §6 建脚本/缓存 → `atan_daily_task_manifest({action:"bootstrap"})`；
3. `atan_daily_collect` → `atan_daily_build_report`；
4. **本轮不要调用 `atan_daily_render`**：最终文档由插件在本轮会话结束后按任务的 `outputFormat` 渲染，调用它只会多渲染一次；
5. 只有工具不可用时，才按下面的手动路径执行。

手动路径（回退）：

1. 产物是**一个 JSON 文件**，路径由执行指令给出（形如 `<任务目录>/.meta/build/<runId>/report.json`）。不要写 `.md`、`.html`、`.pdf`、`.png`。
2. 文件由 `.meta/script/` 下的固定脚本产出；同一任务用同一个脚本，字段、排序、单位都写在脚本里。
3. 结构分两层：
   - `data`：必须符合 `.share/task-schema.json`，这一层决定表格与图表；
   - 信封：`title`、`subtitle`、`generatedAt`、`dataAsOf`、`summary.lead`、`notes`、`sources`、`actions`、`missing`、`meta`。
4. 模型每轮只写三样东西：`data` 的值、`summary.lead`（一句结论）、`notes` / `actions`（判断与建议）。其余由契约与模板决定。
5. 信封字段的形状是固定的：`notes` 是**对象数组**（每项 `{ text, tone? }`，不要写成字符串数组），`actions` 是字符串数组或 `{ text }` 数组，`sources` 每项含 `label` / `value`，`missing` 每项含 `path` / `reason`。渲染器会容忍偏差，但不要在明知规范时写错。
5. 缺失写 `null`，并在 `missing[]` 登记 `{ "path": "$.data.…", "reason": "…" }`；不要省略字段、不要补零。
6. 最终文档由插件按任务的 `outputFormat` 生成 PDF 或 PNG；模型不写版式，也不要尝试补 PDF/PNG。
7. 需要改报告结构时，走「改契约」流程（见下），不要每轮临时改脚本绕过。

### 5. 首轮：建立数据契约

任务第一次运行时 `.share/task-schema.json` 还不存在。首轮建契约只做一次；之后每次运行先判断明细是否变化，再决定只更新 hash、增量修订，还是重建。

契约是 v2：**数据定义 + `x-blocks` 块树**。没有 `x-blocks` 的旧契约（v1，字段驱动）一律判无效，按 §5.1 重建并把 `x-revision` +1——不要试图在旧结构上补丁。

#### 5.1 首轮建立

1. 读 `.share/task-detail.md`，列出读者要回答的问题，再定字段。
2. 选组件前先读 `references/display.md`（「读者要回答什么 → 数据形状 → 组件」三步 + 速查表）；再按 `references/schema.md` 写契约：`properties` 写数据字段，`x-blocks` 写版面。
3. 从 `.share/task-detail.md` 提取 `"x-summary"`（8–60 字，概括跟踪什么、产出什么）和 `"x-tags"`（1–5 个，每个 2–12 字，去重、不带 `#`、不含逗号）。
4. 契约根节点写入 `"x-detail-hash"`，值为 `sha256:` + 64 位小写十六进制；按 §5.3 对当前 `.share/task-detail.md` 计算。
5. **契约是目标形态，不是今天拿到了什么**：拿不到的字段照样写进契约、保留 `required`，本轮填 `null` 并进 `missing[]`。反过来，契约里每个 `required` 字段都必须有明确取数路径。
6. 写完先自检：
   - `required` 与 `properties` 是否一致、数组有没有 `items`、数值有没有 `x-unit` 或 `x-format`；
   - 每个数据块的 `source` / `fields` 是否都指向已声明的字段；
   - `table.columns` 与 `chart.series[].y` 是否都在 `items.properties` 里；
   - `columns` 的 `ratio` 与 `children` 数量是否一致；
   - 块数是否在 12 个以内，长表是否设了 `foldAbove`；
   - `x-summary` / `x-tags` 是否合法。
7. 首轮报告照常产出；契约在用户确认前仍是草案，后续按 §5.2 继续修订。

#### 5.2 明细变更后的契约修订

每次运行前都要比较 `.share/task-detail.md` 的当前 hash 与契约里的 `x-detail-hash`：

- **一致**：契约不动，直接按它取数。
- **不一致**：先评估变动范围，按下面三级处理。不允许跳过评估直接改契约，也不允许明知不一致还按旧契约取数。
- **契约存在但没有 `x-detail-hash`**（老任务）：先按 §5.3 补写当前 hash；如果同时发现字段与明细不一致，按第 2 或第 3 级处理。不要仅因为缺 hash 就重建。

| 级别 | 判断标准 | 处理 |
|---|---|---|
| **1. 无实质性影响** | 只改空格、换行、标点、错别字或语序，不改变字段、口径、范围、输出结构 | **只更新 `x-detail-hash` 的值**，不要重排或重写其他字段。`x-revision` 不变，不写 `x-changelog`。 |
| **2. 一定程度变动** | 需要增删或修改字段、单位、表格列、排序、版面块，但任务目标、数据源、报告整体结构仍成立 | **在现有契约上增量修订**：保留仍有效的字段与块，只改受影响的部分；同步检查 `x-summary`/`x-tags` 是否需要更新；按 §5.4 判断是否升 `x-revision`，需要时写 `x-changelog`。 |
| **3. 变动很大** | 任务目标、数据源或报告结构发生根本变化；或需要改动的字段超过一半；或增量修订后的契约比重新生成更难维护 | **重新生成一份契约**：按 §5.1 从当前明细重建，`x-revision` 取旧值 +1，`x-changelog` 写明「重建」及原因。 |

第 2/3 级改完契约后，还要检查 `.meta/script/` 下的脚本能否产出新增或修改后的字段；不能产出就补脚本，或按缺失处理并在报告 `missing[]` 登记。不要只改契约不改脚本。

判断不了时，**往高一级处理**：能归 2 就不要归 1，能归 3 就不要归 2。

例子：

- 第 1 级：把「每条控制在 80—120 字」改成「每条控制在 80–120 字」；修正不影响口径的错别字或语序。
- 第 2 级：明细新增「当年中期状态」一列；把「股息率」的分母从收盘价改成前复权价；新增一个「按银行类型分组」的表格。
- 第 3 级：任务从「A 股银行股息率」改成「全部 A 股股息率」；数据源从东方财富换成交易所公告；报告从一张表改成「概览 + 分组表 + 趋势图」的多段结构。

三级处理都必须以「把 `x-detail-hash` 更新为当前明细的 hash」收尾；schema 内容与 hash 必须在同一次写入里完成，不能只改一个。

#### 5.3 hash 算法

`x-detail-hash` 是明细的内容指纹，不是版本号，也不是文件时间：

1. 读 `.share/task-detail.md`（UTF-8，允许 BOM）。以文件原文为准，不要用页面或接口解析后的 `details` 字符串。
2. 规范化：去掉 BOM（如果存在），去掉首尾空白，统一换行为 `\n`，末尾补一个 `\n`。
3. 对规范化后的文本计算 SHA-256，写成 `sha256:` + 64 位小写十六进制。

`atan_daily_task_context` 会直接给出当前 hash 与契约里声明的 hash；优先用工具结果，不要自己算。工具不可用时，才按下面的命令计算：

```bash
python -c "import hashlib,pathlib,sys; t=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8-sig').strip()+'\n'; print('sha256:'+hashlib.sha256(t.encode('utf-8')).hexdigest())" "<任务目录>/task-detail.md"
```

不要用文件修改时间、文件大小或上一轮的 hash 代替重新计算。没有 Python 时，用任何等价的 SHA-256 工具，但规范化步骤必须与本节一致。

#### 5.4 修订号与变更记录

- 新增可选字段：可以直接加，`x-revision` 不变。
- **新增必填字段、删字段、改类型或单位**：`x-revision` +1，并在 `x-changelog` 写一行说明。
- **口径变化**（例如股息率的分母从收盘价改成前复权价）：即使字段不变，也算破坏性变更，`x-revision` +1，并在 `x-changelog` 写明口径变化。
- 只改 `x-blocks`（版面顺序、表格列、排序、图表类型、标题文案）、`x-label`，或只改 `description` 的措辞：不算破坏性变更，`x-revision` 不变；但如果 `description` 的变化来自口径变化，按上一条处理。
- 第 3 级重建：一律 `x-revision` +1，保留旧 `x-changelog` 并追加「重建」和原因。
- 第 1 级：不写 `x-changelog`。

#### 5.5 展示与图型改动走工具

用户对报告的展示（字号、颜色、间距、图高、点径、数据表显隐）或某个块的图型不满意时：

1. 调 `atan_daily_report_tune({ action: "patch", instruction, patch })`；`patch` 是 `{ display?, schemaEdits? }` 的 JSON；
2. 工具会写唯一草稿，渲染改动后的 HTML，并返回**预览链接 + 变更清单**（`previewHtmlLink` / `previewHtmlPath`）。把 `previewHtmlLink` 原样贴进回复——用户在右侧栏文档预览里点开就能看到真实效果；
3. **不要贴 PNG、不要 `read_image`、不要读报告/契约文件**：链接已经指向刚渲染好的 HTML，绕一圈只会多花 token；
4. 用户继续说，就继续 `patch`；新链接指向 `rev2.html`、`rev3.html`，每次打开都是累计效果；**不要每轮 commit**；
5. 用户确认“就这样”后，才 `atan_daily_report_tune({ action: "commit", confirm: true })`；
6. 不要直接编辑 `.share/task-display.json` 或 `.share/task-schema.json`；工具会处理稀疏写入与 `x-revision`。

外观调整不改变 `x-detail-hash`，也不触发契约修订；不要因为展示文件存在就重建契约。

### 6. 维护任务清单（`task-pipeline.json`）

1. 清单是 `.meta/task-pipeline.json`，包含 `pipeline`（命令）、`scripts`（脚本清单）、`cache`（缓存清单）；**不再维护 `index.md`**。
2. 首次运行或换数据源：`atan_daily_task_context` 返回 `needsBootstrap` → 先写脚本/缓存，再 `atan_daily_task_manifest({ action: "bootstrap", payload: <清单 JSON>, deleteIndex: true })`。
3. 新增/改名/删除脚本或缓存：用 `upsert_script` / `remove_script` / `upsert_cache` / `remove_cache`；不要手写 `task-pipeline.json`。
4. 换命令：`set_pipeline`，必须带 `reason`；工具会写 `history`，不要覆盖别人的命令。
5. `scripts` 与 `cache` 必须和 `.meta/script/`、`.meta/cache/` 里的文件一一对应；不允许「存在但未登记」。

## 输出约定

一次执行结束时应满足：

- `.meta/build/<runId>/report.json` 存在，`data` 能通过契约校验；
- `missing[]` 覆盖了 `data` 里所有 `null`；
- 新增或更新的缓存/脚本已通过 `atan_daily_task_manifest` 登记进 `.meta/task-pipeline.json`；
- 契约要么没改动；要么按 §5 完成三级处理：`x-detail-hash` 等于当前明细的 hash，破坏性变更已升 `x-revision`，`x-summary`/`x-tags` 与当前明细一致。

## 结束语

一轮执行结束后，回复**只有两块内容**，多了就是错：

**1. 新增文件表**——只列本轮新建或改动的文件，没改动的不列；本轮没有新增就整张表不出现：

| 类别 | 文件 | 作用 |
|---|---|---|
| 数据契约 | [task-schema.json](<C:/Users/me/notes/新闻联播简报/.share/task-schema.json>) | 定义本轮报告的字段与版面 |
| 脚本 | [fetch_xwlb.py](<C:/Users/me/notes/新闻联播简报/.meta/script/fetch_xwlb.py>) | 抓当日联播条目与正文 |
| 缓存 | [column-map.json](<C:/Users/me/notes/新闻联播简报/.meta/cache/column-map.json>) | 栏目与分类映射，跨轮复用 |
| 清单 | [task-pipeline.json](<C:/Users/me/notes/新闻联播简报/.meta/task-pipeline.json>) | 登记取数命令与脚本 |

- 类别只用这四种：数据契约 / 脚本 / 缓存 / 清单；
- 「文件」列必须是链接：`[文件名](<绝对路径>)`。点击后由阅读器在右侧文档预览里打开，纯文本做不到，所以不能只写文件名或相对路径。绝对路径 = `atan_daily_task_context` 返回的 `task.folder` + 任务目录内的相对路径（`.share/…`、`.meta/…`）；链接文字只写文件名，目标两侧用 `<>` 包住（路径含中文与空格）；
- 「作用」一句话、20 字以内，写这个文件干什么；不写校验结果、hash、条数、版本号。

**2. 报告行**——表格之后空一行，单独一行，永远在最后，同样是指向本次报告文件的链接：

```text
报告：[新闻联播简报-2026-11-10_21-40-27.png](<C:/Users/me/notes/新闻联播简报/新闻联播简报-2026-11-10_21-40-27.png>)
```

文件名照抄执行指令里的 `本轮报告`，路径用 `task.folder` 拼；不要改写、不要加时间戳、不要判断它是否已生成（插件在本轮结束后渲染它）。

不再输出：本轮结论、头条、数据条数、口径说明、「已按 skill 完成」这类开场白，以及调用或未调用过哪些工具的说明——这些属于报告正文与运行记录，不属于聊天回复。本轮没有新增文件时，只输出报告行。
