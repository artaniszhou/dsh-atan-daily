/**
 * Client 端的运行期常量。
 *
 * 与 `protocol.ts` 的分工：凡是两端共享的值放 protocol，只有页面自己关心的
 * 展示/节奏参数放这里。
 */

/** 包名，同时是模块注册 id。 */
export const PACKAGE = 'dsh-atan-daily'

/** 侧栏入口与中央页面共用的面板 id。 */
export const PANEL_ID = 'atan-daily'

/** 紧跟「自动化任务」（order 10）之后。 */
export const PANEL_ORDER = 11

/** 列表里详情预览的最大字符数。 */
export const DETAIL_PREVIEW = 160

/** 每页任务行数。 */
export const PAGE_SIZE = 10

/** 一次 host 请求的总超时。 */
export const REQUEST_TIMEOUT_MS = 20_000

/** Host 不可达时的自动重试次数上限。 */
export const AUTO_RETRY_LIMIT = 8

/** 首次自动重试的间隔，之后指数退避。 */
export const AUTO_RETRY_BASE_MS = 2_000

/** 自动重试间隔的上限。 */
export const AUTO_RETRY_MAX_MS = 30_000

/** 有任务在跑时的轮询间隔。 */
export const POLL_INTERVAL_MS = 3_000

/** 诊断条只保留最近一次的显示时长。 */
export const FAILURE_STRIP_MS = 15_000
