<p align="center">
  <img src="icon.svg" alt="阿碳日报" width="96" height="96">
</p>

<div align="center">

# 阿碳日报

**把选题变成按计划自动执行的日报，每期一份带时间戳的报告**

[![许可证：MIT](https://img.shields.io/badge/%E8%AE%B8%E5%8F%AF%E8%AF%81-MIT-green.svg)](LICENSE)
[![npm package](https://img.shields.io/npm/v/dsh-atan-daily.svg?label=npm%20package)](https://www.npmjs.com/package/dsh-atan-daily)
[![npm 下载量](https://img.shields.io/npm/dt/dsh-atan-daily.svg?label=npm%20%E4%B8%8B%E8%BD%BD%E9%87%8F)](https://www.npmjs.com/package/dsh-atan-daily)
[![DSH Web Plugin](https://img.shields.io/badge/DSH%20Web-Plugin-0f766e.svg)](https://github.com/artaniszhou/dsh-atan-daily)
[![DSH 支持至 0.2.x](https://img.shields.io/badge/DSH-0.2.x-2563eb.svg)](#安装)

</div>

> 阿碳日报是社区维护的 DeepSeek Harness（DSH）插件，并非 DeepSeek AI 官方产品。

当前版本 **1.2.1**。本页只讲功能概览与安装；其余内容见：

| 文档 | 内容 |
| --- | --- |
| [产品设计](https://github.com/artaniszhou/dsh-atan-daily/blob/main/docs/PRODUCT.md) | 功能设计、使用方式、任务目录结构、飞书机器人、运行机制 |
| [更新日志](https://github.com/artaniszhou/dsh-atan-daily/blob/main/docs/CHANGELOG.md) | 各版本的新增、变更、修复与兼容说明 |
| [联系作者](https://atandaily.cn/) | 官网主页：QQ 交流群（群号 913085733）、安装说明、提问须知与隐私约定 |

## 大致功能

给每个选题一个目录、一份任务细节和一份文件索引，剩下的事按计划自动发生。

- **定时执行**：执行时间可以说「每天 9 点」「每周一和周四 8 点」，也可以写五段 cron，或者只手动执行；每个任务单独设置 IANA 时区。
- **首次使用先选工作区**：插件不再自带默认目录。打开页面点「使用建议工作区」（DSH 默认工作区父目录下的 `atan-daily`），或点「选择工作区…」从已注册工作区里选、或输入目录地址新建；选了才创建目录并注册为 DSH 工作区。没选之前任务列表为空、不能新建任务。
- **一任务一目录**：每个选题一个文件夹，用户只写 `task-detail.md`，执行清单（命令、脚本、缓存）登记在 `.meta/task-pipeline.json`，改任务内容不用改代码。
- **数据契约 + 模板渲染**：首轮生成 `.share/task-schema.json` 说清「要哪些数据、什么类型、怎么呈现」，之后每轮先核对明细再渲染成 PDF 或 PNG；报告是零脚本单文件，图表随窗口缩放。
- **展示可微调**：在任务会话里直接说“地图点小一点、坐标表去掉、第三张图改柱状图”，`atan_daily_*` 工具会把要求编译成草稿并在聊天里给出改动后预览；用户确认后才写入 `.share/task-display.json` / `.share/task-schema.json`。全程不用改脚本，也不用重跑采集。
- **报告推到飞书**：标题行「机器人管理」手机扫码即可创建机器人，每个任务卡片上「推送管理」选一个或多个接收方；PNG 直接显示，PDF 走文件消息。
- **运行历史与并行**：状态、耗时、报告、会话与错误都有记录，保留天数可设；不同任务同时开跑，同一任务互斥（重叠记为跳过）。
- **会话与权限按任务设置**：可以每轮新建会话，也可以复用上一轮会话延续上下文；权限二选一「工作区内修改」（默认）或「完全权限」。
- **任务仓库**：可把任务上传到任务仓库、从仓库加载任务（需要部署 `atan-admin-server` 与 `atan-admin-web`）。

细节见[产品设计](https://github.com/artaniszhou/dsh-atan-daily/blob/main/docs/PRODUCT.md)。

## 安装

需要已安装并能正常运行 DeepSeek Harness，版本 **0.2.1 及以上**（插件要求 `dsh >=0.2.1-0 <0.3.0`）。

### 让 Agent 帮你安装

把这段话发给能够操作本机终端的 Agent：

```text
请把 dsh-atan-daily 最新版安装到我的 DSH web profile，使用官方 npm 源，安装后重启宿主并确认侧栏「自动化任务」下方出现「阿碳日报」。
```

### 手动安装

```bash
dsh plugin --profile web add dsh-atan-daily
```

也可以打开 Web UI：「设置 → 插件 → 添加插件」，输入包名 `dsh-atan-daily` 安装。

安装或升级后重启宿主并刷新页面，侧栏「自动化任务」下方即出现「阿碳日报」。

npm 官方源较慢时可指定镜像：

```bash
dsh plugin --profile web add dsh-atan-daily --registry=https://registry.npmmirror.com/
```

从源码或本地目录试用：

```bash
git clone https://github.com/artaniszhou/dsh-atan-daily.git
cd dsh-atan-daily
npm install
npm run build
dsh plugin --profile web add .
```

以 `link:` 方式安装时：Client 改动重新构建后刷新页面即生效；Host 改动需要重启宿主。

> 仓库不包含构建产物 `lib/`，克隆后必须先执行 `npm run build`。因此本插件不支持直接用 Git 地址安装，请使用 npm 包，或构建后按上面的本地目录方式安装。

> 若你之前用本地 `link:` 装过旧包名 `@artanis/atan-daily`，请先用 `dsh plugin --profile web remove @artanis/atan-daily` 移除，避免同一个插件 id 出现两次。

## 反馈与贡献

遇到问题或有建议，欢迎[提交 Issue](https://github.com/artaniszhou/dsh-atan-daily/issues)，也可以先看[官网](https://atandaily.cn/)或[联系作者](https://github.com/artaniszhou/dsh-atan-daily/blob/main/docs/CONTACT.md)。请附上 DSH 与插件版本、复现步骤，以及相关截图或日志；涉及选题规则时可先删去敏感内容。

源码位于 `src`，使用严格 TypeScript，Host 与 Client 分开构建。改动后请执行：

```bash
npm run typecheck  # Host / Client 类型检查
npm run build      # 类型检查 + 构建 lib/
npm run check      # 等同于 build，提交前跑一遍
```

界面文案同时维护 `locale/zh.json` 与 `locale/en.json`，两边键集合需一致；颜色只用 `--dsw-*` 语义令牌，不要引入独立调色板。欢迎提交改进。

## 许可证

[MIT](LICENSE) © 2026 Artanis Zhou
