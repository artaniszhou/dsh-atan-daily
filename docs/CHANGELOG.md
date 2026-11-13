# 更新日志

> 版本号与 `package.json` 一致；安装方法见 [README](../README.md#安装)，产品设计见 [产品设计](PRODUCT.md)。
>
> 分类沿用「新增 / 变更 / 修复 / 兼容 / 移除」；发版时把条目归入对应版本号。
>
> 只在 npm 发布过的版本才单独成节。1.1.0 之后的开发期用过 1.3.0 / 1.4.0 / 2.x 等内部编号，均未发布，已并入 1.2.0。

## 1.2.2（2026-11-13）

**安全**

- **`atan_daily_script` 不再经 shell 执行**：参数由字符串改为字符串数组，按 argv 逐个传给 `python` / `node`（`shell: false`），不再拼进命令行。此前 `args` 原样拼进 `shell: true` 的命令串，一个参数就能被解释成另一条命令。
- **移除 `allowUnregistered`**：工具现在只执行 `.meta/task-pipeline.json` 里已登记的脚本；未登记时返回 `script_not_registered`，需先 `upsert_script`。此前该开关可跳过登记检查，等于任意脚本都能跑。

**变更**

- `atan_daily_script` 的 `args` 参数类型从字符串改为字符串数组；旧写法（字符串）会返回 `invalid_input`，请改成 `["--x=1", "a b"]` 这样的数组。
- README 增补「安全与权限」一节，说明脚本参数不经过 shell、pipeline 命令的执行方式，以及本地接口的准入判定。

## 1.2.1（2026-11-12）

**安全**

- **本地接口补上准入判定**：`/atan-daily/*`、`/atan-daily/settings*`、`/atan-daily/workspaces`、`/atan-daily/task-hub`、`/atan-daily/announcement`、`/api/atan-daily/im` 这些路由现在先问宿主的 `connection.requestRejection(request)`；返回 401 / 403 直接拒绝，拿不到该服务或判定抛错也按 403 处理。此前这些接口对任意网页发起的跨站请求都放行，可被用来建任务、改设置或上传任务包。
- 判定只看宿主记的 Host / Origin / Sec-Fetch-Site 与部署的 `trustedHosts`，本机页面（以及用 `--trusted-host` 声明过的地址）照常使用，不需要改任何配置。

**兼容**

- 需要宿主提供 `connection` 服务（DSH 0.2.x 自带）。宿主没有这个服务时，上述路由不会被注册；定时执行、报告渲染、飞书推送不经过这些路由，仍然照常工作。

## 1.2.0（2026-11-11）

**新增**

- **任务编辑器改为右侧抽屉**：与运行历史、推送管理等抽屉一致，不再遮住整页；新增「每次执行打开新会话」「权限级别」（工作区内修改 / 完全权限）、「文档格式」（PNG / PDF），以及任务细节（`task-detail.md`）的编辑。
- **任务身份与目录解耦**：`.task/task-list.jsonl` 的行升到 `v: 3`，`id` 与 `remoteTaskId` 合并为 `taskId`（UUID，兼上传身份，改名不变），新增 `folder`（目录名，可变）。编辑抽屉顶部可改任务名，改名同步改任务目录；任务执行中或目标目录已存在时拒绝改名。
- **任务仓库**：上传任务、从仓库加载任务。上传包为 v2 文件数组，每份文件只有 `path` 与 `content`，路径限定在 `.share/`（三份文档 + `charts/*.mjs`）。
- **上传前确定性检查**：路径穿越 / 绝对路径 / 大小写重名、控制字符与双向控制符、体积与扩展名、图形脚本危险 API；`block` 直接拒绝，`warn` / `info` 随预览展示。配套 `atan_daily_package` 工具：`list` 看文件清单、`scan` 做静态检查、`preview` 看完整包，不发起上传。
- **自定义图形**：任务可在 `.share/charts/*.mjs` 里写 `export default function render(payload)` 返回 SVG，随任务上传，下载方拿到同一张图。脚本在受限子进程执行（`--permission`、禁 `eval`、清空环境变量、临时工作目录），带超时、输出体积上限与 SVG 消毒。
- **契约 v2（`x-blocks` 块树）**：把「显示组件 → 数据」写进契约，13 个组件（标题、段落、列表、引用、提示、分隔线、键值、指标卡、表格、时间线、图表、分栏、卡片），每个数据块用 `source` / `fields` 引用字段，数据与版面分离。
- **报告主题系统**：默认主题整理成完整设计令牌（字号阶、间距阶、圆角、8 色图表色板），新增 `compact` 紧凑主题；契约可用 `x-theme` 指定，`report.json` 的 `theme` 可覆盖。
- **图表引擎 ECharts 6.1**：图型扩到 21 种（新增 `treemap`、`sunburst`、`pictorialBar`、`themeRiver`、`parallel`、`sankey`、`chord`、`graph`、`tree`、`map`、`custom`），支持三种数据形状（`flat` / `tree` / 边列表）；`graph` 的边来自块级 `links`，`map` 用随插件分发的底图；子选项覆盖环形 / 玫瑰、标数、阶梯线、气泡大小、雷达填充、漏斗排序。SSR 输出仍逐字节可复现。
- **展示覆盖（`task-display.json`）**：字号、颜色、间距、版心、图表高度、图内字号、点径、柱宽、线宽、图例、表格列宽与显隐都可调。文件写在 `.share/task-display.json`，可选、稀疏、只写与默认不同的项，删空即回默认；改图型走契约修订（提案 → 校验数据 → 前后对比 → 写回并 `x-revision + 1`）。
- **展示修改聊天化**：删除「微调展示」面板，改为 `atan_daily_report_tune`——`patch` 生成唯一草稿并返回改动后 HTML 预览（在右侧文档预览里打开），确认后 `commit` 写 `.share/task-display.json` 与 `.share/task-schema.json` 并重渲染，`discard` 放弃。
- **失败也有文档**：契约不可用或数据不合规时渲染一份「原始数据」回退报告（含失败原因），不再整轮不出文档。
- **`.meta/task-pipeline.json` 取代 `index.md`**：一个文件放 `pipeline`（fetch / build 命令）、`scripts`、`cache`，支持 bootstrap、upsert / remove、set_pipeline。
- **插件内粗粒度工具**：`atan_daily_task_context` / `_task_manifest` / `_collect` / `_build_report` / `_render` / `_script` / `_report_tune`，命令、校验、渲染与草稿都在同进程完成，不再让模型手算 hash 或现写校验脚本。
- **任务仓库地址可在页面配置**：设置区「工作目录」下方新增一行，保存进 `settings.json` 并覆盖 `cordis.patch.yml` 的 `serverBaseUrl`，立即生效、无需重启；留空回默认。
- **页面公告**：标题下方的固定说明改为公告位（默认一行标题、可展开正文），接口关闭或失败时整块不渲染；Host 新增 `GET atan-daily/announcement` 代理，`atan-admin-web` 新增公告管理页，`atan-admin-server` 新增公告接口与 `atan_announcement` 集合。
- **「选择工作区」弹窗**：从已注册的 DSH 工作区里选，搜索框匹配标题与路径，`↑↓` / `Enter` 可用；列表默认只显示 atan-daily 用过的工作区（目录下有 `.task/`），当前工作区始终显示，可勾选「显示全部工作区」。
- **用目录地址新建工作区**：同一个弹窗里输入绝对路径，Host 按**宿主平台**（Windows / macOS / Linux）校验并给出稳定错误码；目录不存在时创建，然后注册为工作区。注册失败即切换失败，不再出现「已保存但注册失败」。
- **默认工作区**：建议值改为 `DSH 默认工作区父目录/atan-daily`（如 `<Documents>/deepseek-harness/atan-daily`）；优先从注册表里的 `default-workspace` 推导（尊重 `documentsDirectory`），其次探测系统 Documents，最后回退 `~/DSH/atan-daily`。仍然要点「使用建议工作区」才创建。
- **「工作区已失效」态**：保存的目录不再是已注册工作区时，页面提示并可「重新注册」；重新注册前 Host 拒绝新建任务与运行（读任务列表仍可用）。
- **纯函数路径校验**：`src/host/settings/paths.ts`，按平台检查完全限定、设备路径、非法字符、保留名、结尾空格/点、分段与总长度、设置目录保护。

**变更**

- **任务目录**：`.task/task-list.jsonl` 存任务元数据；`.meta/` 只放本地运行资料（`cache/`、`script/`、`build/<runId>/`、`runs/`、`display/`）；`.share/` 放随任务上传的内容（`task-detail.md`、`task-schema.json`、`task-display.json`、`charts/`）；报告写在任务根目录，上一份在开跑前移入 `history/`。
- **最终文档二选一**：PNG（默认）或 PDF；JSON / HTML 只是 `.meta/build/<runId>/` 下的中间件。PDF 改用 `puppeteer-core` 打印，等中文字体就绪再分页，页脚带「报告标题 + 第 X 页 / 共 Y 页」。
- **报告命名**：`<任务名>-YYYY-MM-DD_HH-mm-ss.pdf` / `.png`，时间取本轮开始时间，同一秒重跑加 `-2`、`-3`；「最新报告」「历史计数」「整组归档」都按基名算。
- **清单改名**：`.meta/task.json` → `.meta/task-pipeline.json`，内容不变；新建任务不再写 `.meta/index.md`，也不再渲染 `rule.md` 模板——公共段落（目录骨架、执行要求、输出约定）由 `atan-daily-run` skill 统一提供。
- **`.meta/build/` 只保留最新一轮**：每轮结束后删掉其它 run 目录，中间件不再随运行次数累积；`.meta/runs/` 的运行记录不受影响，仍按保留天数清理。
- **默认任务仓库地址改为 `https://atandaily.cn`**：站点已备案并全量 https，80 端口只剩 301 跳转。带 body 的 POST 跟 301 会降级成 GET，继续用 http 会让上传任务与任务仓库直接失败。
- **`serverBaseUrl` 可单独提交**：`PATCH /settings` 接受只提交它（与 `workDir` 可同时提交），只收 http / https；内置域名的 `http://` 地址在读取时自动升级为 https，自建地址按填写值使用。
- **执行指令压成一行**：只带 `taskId`、`runId` 与本轮报告文件名，其余规则由 `atan-daily-run` skill 维护；结束语固定为「新增文件表 + 报告行」，不再输出结论、条数、口径与工具调用说明。
- **上传向导改为三步**：文件 / 任务信息 / 预览并提交，文件清单直接来自 Host 打包结果。
- **图表观感**：去掉图表外框与卡片底色，网格线改虚线，图例固定右上角并按有无图例自动留白，饼图默认不出图例，玫瑰图默认实心；`sort` 改为渲染期排序（`-field` 降序、`+field` 升序，缺失值排最后）；元 schema 不再枚举 `series.type`，允许值由 lint 按 `src/report/series.ts` 校验，类型清单只维护一处。
- **展示修改一律先预览后落盘**：改展示只能走 `atan_daily_report_tune`，Host 侧不再有绕过草稿直接写 `.share` 的接口。
- **工作目录不再有默认值**：`settings.json` 没有 `workDir` 时进入未配置态——页面显示「未选择」，提供「使用建议目录」（Windows `文档\DSH\atan-daily`，macOS `~/DSH/atan-daily`）与「选择目录」；只有点了才创建目录、注册 Workspace、写 `settings.json`。未配置期间任务列表为空、新建任务与任务仓库按钮禁用、`atan_daily_*` 工具返回「先选择工作目录」。老用户由一次性迁移兜住：没有 `workDir` 但历史默认目录里有任务时自动沿用并写回。yaml 的 `dataDir` 降级为「建议目录」，不再作为自动生效的默认值；工作目录必须是绝对路径。
- **设置层拆分**：`SettingsStore` 拆成 `SettingsFile`（只读写 `settings.json`）与 `WorkspaceHub`（当前工作区状态机）。工作区以不可变快照 `{ root, store }` 交给消费方，任务、会话、运行记录、路由与调度都只依赖 `current()/require()`，不再成对传 `store` + `workDir`；目录切换的副作用（建目录、注册 Workspace、落盘、通知）统一在 `switchTo` 内完成，调度器订阅变更自行刷新。
- **「联系作者」改跳官网**：按钮从打开仓库里的 `docs/CONTACT.md` 改为打开 [官网主页](https://atandaily.cn/)（QQ 群在「如何联系」一节，群号不变）；GitHub 上的 `CONTACT.md` 保留，供直接看仓库的人使用。
- **术语**：工作目录 → **工作区**；选择目录 → **选择工作区**；使用建议目录 → **使用建议工作区**；创建工作目录 → **创建工作区**。页面、工具报错与文档同步。
- **工作区 = DSH 工作区**：插件不再调用宿主目录选择器（`pickDirectory`），从根上避免 native / browse 组合差异；42 这类远程宿主与本地宿主走同一套弹窗。
- **设置行只显示工作区标题**：路径不再内联；悬停标题看完整路径，点击标题复制路径并短暂提示「已复制」。
- **注册语义收紧**：`switchTo` 在注册工作区失败时直接失败，`settings.json` 与当前工作区保持不变。
- **canonical 路径**：保存与注册都用 `realpath` 后的路径，避免符号链接被重复注册成两个工作区。
- **设置视图新增字段**：`hostPlatform`、`pathSeparator`、`defaultWorkspaceParent`、`suggestedWorkDirSource`、`workspaceState`；新增 `GET atan-daily/workspaces` 与 `POST atan-daily/settings/check`。

**修复**

- 信封里的 `notes` / `sources` / `actions` / `missing` 被写成字符串数组等情况时，渲染器在 `esc(undefined)` 上抛错，整轮没有生成 PNG / PDF；现在先做形状归一，渲染异常还会回退成「原始数据」报告。
- 迷你线（sparkline）纵轴从 0 起算，价格在 3000 附近时整条线只有 1–2px 起伏；改为按数据范围缩放。
- 多序列图表的图例压在横轴标签上；图例移到右上角并预留空间。
- 契约结构缺 `x-revision` 这类必填字段时，提示语误用了「写 null 并登记 missing[]」；改为结构性的补全提示。
- 桑基图最右一列节点标签被裁掉；右侧留出标签宽度。
- 关系图被「列里没有数值」的判空误伤；固定坐标与环形布局都能正常渲染。
- 地图点位过多时标签重叠；改为自动隐藏重叠标签。
- 选「工作区内修改」后，新会话的权限一度显示为「自定义」；现在保留预设原样，并用插件级审批闸门在运行期间直接拒绝越界审批。
- 结束语里的文件改成可点链接（`[文件名](<绝对路径>)`）：表格「文件」列与最后一行报告都带链接，点击在右侧文档预览里打开；原来只写相对路径纯文本，点了没反应。

**兼容**

- 注册表行必须带 `newSession`、`permissionLevel`、`pushBotIds`，缺字段的行会被跳过并记一条日志；机器人记录必须有 `name`（不再读 1.0 的 `alias`）。`v: 2` 行不再读取，`ensure()` 会从带 `task-detail.md` 的目录重建，重建出的任务为「仅手动」且默认停用。
- 只接受任务包 v2：旧 v1 包直接拒绝；旧任务目录里的 `.meta/charts/` 不再读取，需要时手工移到 `.share/charts/`。
- `.meta/task.json` 与 `.meta/index.md` 不再读取；已有任务需要手工改成 `.meta/task-pipeline.json`（内容不变）。
- 不兼容 v1 契约：没有 `x-blocks` 的契约判无效并提示重建；存量任务下一轮按 skill 的建契约定式重建，`x-revision + 1`。
- `settings.json` 结构不变（仍存 `workDir`），已有用户的路径与数据不迁移、不改动。
- `SettingsView.workspaceError` 保留给旧 Client；新路径不再产生它。

**移除**

- 契约快照 `.meta/schema/task-schema.vN.json`、展示覆盖历史 `.meta/display/revisions/`、每轮快照 `.meta/build/<runId>/snapshots/`、`render-manifest.json` 与 `atan_daily_report_regenerate` 工具：不再支持用某一轮快照重生成历史报告，历史报告仍在 `history/` 里可查看。
- 「微调展示」面板与 `/atan-daily/tasks/:id/display` 路由，以及 Host 的 display HTTP 接口；`atan-admin-web` 同步删除 `/contact` 页面与静态路由。
- 旧 `rule.md` 方案与 v1 目录布局（`tasks/`、根目录 `cache/`、`script/`、`历史报告/`、`cache.md`、`script.md`）、旧注册表（`task-list.md`、v1 `task-list.jsonl`）的迁移；运行记录不再读 `meta/runs/YYYY-MM/` 月目录。

## 1.1.0（2026-10-23）

**新增**

- 机器人管理：标题行「机器人管理」→ 扫码接入飞书 / Lark 机器人；手机扫码即可创建，接入后会给扫码人发一条欢迎消息验证发送链路。
- 报告推送：任务卡片右下角「推送管理」按任务选择目标机器人，可多选；抽屉顶部的总开关只暂停发送，选择保留。
- 报告归档：每次运行开始前，上一份报告移入任务目录的 `history/`，任务根目录只留最新一份。
- 列表体验：统计条、搜索、分页，以及统一的运行历史抽屉与编辑弹窗。

**修复**

- 弹层焦点不再逃到背景：Tab / Shift+Tab 在弹层内循环，Esc 改为文档层处理，焦点被点到背景后也能关闭。
- 时区选择器只把合法 IANA 时区列为选项，输入半截词不会再被当成可选项；新建与编辑在提交前先做本地校验。
- 运行历史抽屉的保留期说明跟随任务设置：按天数或「永久保留」，不再固定写 7 天。
- 「无法连接 Host」不再拼接浏览器原文（`Failed to fetch`），提示保持中文可读。
- 编辑弹窗切到「仅手动」时说明该任务会置为未启用，避免误以为任务被停掉。
- 新建任务时名称为空会给出提示，不再静默无反应。

## 1.0.0（2026-10-20）

首个公开版本：定时执行、口语与 cron 两种时间表达、一任务一目录、每期一份带时间戳的报告、独立会话与运行历史。
