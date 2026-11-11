# 契约示例

两份可直接照着改的完整契约。字段按任务改，**版面顺序**（结论 → 关键指标 → 明细 → 走势 → 口径）通常不用大改。

---

## 示例 A：数据驱动的日报（表格 + 指标 + 双轴图 + 分栏）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "A股银行股息率 · 日报",
  "x-revision": 1,
  "x-summary": "跟踪 A 股银行股息率与分红进度，按股息率降序输出明细、走势与结论",
  "x-tags": ["日报", "银行", "股息率"],
  "x-detail-hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "type": "object",
  "required": ["asOf", "summaryMetrics", "banks", "yieldTrend"],
  "properties": {
    "asOf": { "type": "string", "format": "date", "x-label": "数据截止" },
    "summaryMetrics": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["label", "value"],
        "properties": {
          "label": { "type": "string" },
          "value": { "type": "number" },
          "unit": { "type": "string" },
          "format": { "type": "string" },
          "delta": { "type": "string" },
          "tone": { "type": "string" }
        }
      }
    },
    "banks": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "name": { "type": "string", "x-label": "银行" },
          "yield": { "type": ["number", "null"], "x-label": "股息率", "x-unit": "%", "x-format": "percent" },
          "payout": { "type": ["number", "null"], "x-label": "分红率", "x-unit": "%", "x-format": "percent" }
        }
      }
    },
    "yieldTrend": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "period": { "type": "string", "x-label": "期次" },
          "median": { "type": ["number", "null"], "x-label": "中位数", "x-unit": "%", "x-format": "percent" },
          "top5": { "type": ["number", "null"], "x-label": "前五均值", "x-unit": "%", "x-format": "percent" }
        }
      }
    }
  },
  "x-blocks": [
    { "component": "kv", "fields": ["asOf"] },
    { "component": "paragraph", "text": "样本与口径与上期一致；股息率按税前分红计算。" },
    { "component": "heading", "level": 2, "text": "关键指标" },
    { "component": "metrics", "source": "summaryMetrics" },
    { "component": "heading", "level": 2, "text": "明细" },
    {
      "component": "table",
      "source": "banks",
      "columns": ["name", "yield", "payout"],
      "sort": "-yield",
      "foldAbove": 20
    },
    { "component": "heading", "level": 2, "text": "走势" },
    {
      "component": "chart",
      "source": "yieldTrend",
      "x": "period",
      "unit": "%",
      "series": [
        { "type": "line", "y": "median" },
        { "type": "line", "y": "top5" }
      ]
    },
    { "component": "note", "tone": "info", "text": "图中断点表示该期缺失；精确数值见下表。" }
  ]
}
```

要点：

- `table.columns` 是白名单，`sort: "-yield"` 降序，缺失值自动排最后；
- 图表的每个 `series.y` 都必须是 `items.properties` 里的字段；
- 文字块只写口径与判断，不重复表里的数字。

---

## 示例 B：文字驱动的简报（时间线 + 列表 + 引用）

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "新闻联播 · 每日要点",
  "x-revision": 1,
  "x-summary": "跟踪新闻联播要点，按播出顺序整理头条与快讯并给出观察",
  "x-tags": ["日报", "新闻"],
  "x-detail-hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "type": "object",
  "required": ["date", "items", "flash"],
  "properties": {
    "date": { "type": "string", "format": "date", "x-label": "播出日期" },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "at": { "type": "string", "x-label": "时间" },
          "title": { "type": "string", "x-label": "条目" },
          "detail": { "type": "string", "x-label": "摘要" }
        }
      }
    },
    "flash": {
      "type": "array",
      "items": { "type": "object", "properties": { "text": { "type": "string" } } }
    }
  },
  "x-blocks": [
    { "component": "kv", "fields": ["date"] },
    { "component": "quote", "text": "本期头条集中在制造业与秋收，国际部分篇幅缩短。", "cite": "观察" },
    { "component": "heading", "level": 2, "text": "头条" },
    { "component": "timeline", "source": "items" },
    { "component": "heading", "level": 2, "text": "联播快讯" },
    { "component": "list", "source": "flash" },
    { "component": "divider" },
    { "component": "list", "ordered": true, "items": ["口径：按播出顺序", "未播出条目不补"] }
  ]
}
```

要点：

- `timeline` 读 `at` / `title` / `detail` 三个字段，缺一个就显示占位；
- `list` 既可以绑定数组字段（`source`），也可以写静态条目（`items`）；
- `quote` 的正文是模型写的判断，不是数据搬运。
