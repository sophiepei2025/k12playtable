# Extracurricular Finder (`edmoat-extracurriculars`)

北美课外活动决策平台：给家长 / counselor 的免费查询网页 + 给他们 AI 助手用的 MCP。按 Meridian（`edmoat-seo-geo-mcp` 同款）网关模式部署到 Vercel。

- **网页**：`public/`，英文界面，搜索 + 筛选 + 「Is it worth it?」信号解读 + 收藏 + 最多 3 个并排对比 + 截止日 `.ics` 导出 + 一句话搜索（Qwen）。
- **MCP**：`/mcp`（无状态 Streamable HTTP）和本地 stdio。6 个免费只读 tool + 2 个付费 tool + 2 个 prompt。
- **公开 API**：`/api/activities`、`/api/parse-query`，以及 `/llms.txt`、`/openapi.json`。
- **数据管线**：Qwen 从官网抽取字段 → 逐字引用校验 → 人工审核 → 上线。

网页、API、MCP 共用 `src/core/`（网页通过 esbuild 打包同一份代码），没有第二套实现。

## 快速开始

```bash
npm install
cp .env.example .env          # 填 DASHSCOPE_API_KEY（弗吉尼亚 key）
npm test                      # 27 个测试
npm run serve                 # http://localhost:3000 网页 + /mcp + /api
```

## MCP

| Tool | 层级 | 用途 |
| --- | --- | --- |
| `search_activities` | 免费 | 按年级、学科、形式、主办方、国家、费用、截止月份等筛选；默认「免费 + 择优」优先 |
| `get_activity` | 免费 | 单个活动全部字段 + 来源 + 核实日期 |
| `compare_activities` | 免费 | 2–3 个活动并排对比 |
| `explain_signals` | 免费 | 主办方类型说明、费用/选拔性/产出信号、风险提示（不打主观分） |
| `report_issue` | 免费 | 生成预填好的纠错链接（不存储） |
| `get_planning_rules` | 免费 | 排期 Skill 全文 + 默认参数 |
| `check_conflicts` | 付费 | 日期重叠、住宿出行缓冲、学期/暑假周工时上限、考试周、已过截止 |
| `get_deadlines` | 付费 | 申请开放、准备开始、30/7/1 天提醒、截止、放榜、押金 + `.ics` |

Prompts：`plan-my-year`、`compare-programs`。

付费 tool 现在用 `PAID_ACCESS_TOKENS`（Bearer token）解锁，是 OAuth 2.1 上线前的过渡方案。

**本地挂到 Claude Code：**

```bash
npm run build
claude mcp add extracurriculars -- node /Users/chengyinpei/code/课外活动/dist/src/mcp/stdio.js
```

**远程（部署后）：** `https://<your-domain>/mcp`

## 模型（默认千问）

`src/core/llm.ts` 是统一的 OpenAI 兼容客户端（从 `volcengine-ark-kit` 的 `ArkClient` 移植），按任务分模型：

| 任务 | 默认模型（qwen-us） |
| --- | --- |
| 一句话搜索 `nl_search` | qwen3.7-flash |
| 官网字段抽取 `extract` | qwen-flash |
| 排期解释 `plan`（V2） | qwen3.7-plus |

- 默认 `LLM_PROVIDER=qwen-us`，请求发到 `dashscope-us.aliyuncs.com`（美国部署范围）。不要用弗吉尼亚区域的 Global 范围：它可能把请求路由到中国大陆。
- 含家庭信息的调用如果配到非 `qwen-us` 的 provider，代码会直接拒绝。
- 可切换 `qwen-intl`、`ark`（火山）、`deepseek`，只限公开数据。
- 每个任务的模型可以用 `LLM_MODEL_<TASK>` 覆盖。

## 数据

```
data/raw/extracurriculars.json   原始 333 条（不手改）
data/overrides/verified.json     人工核实的字段补丁（按 id）
data/overrides/added.json        人工审核通过的新活动
data/activities.json             构建产物（npm run build:data）
data/review/                     待审核的抽取结果
data/seed/candidates.csv         新活动候选（加拿大优先）
```

**补数据流程：**

```bash
npm run extract -- --limit 50          # 先 dry run：列出页面 + 预估费用
npm run extract -- --limit 50 --yes    # 真正调用 Qwen
npm run review -- list
npm run review -- show <id>
npm run review -- approve <id> [--fields cost,dates.app_deadline]
npm run review -- reject <id>
npm run extract -- --candidates --yes  # 抽取 candidates.csv 里的新活动
```

抽取出的值必须附带官网页面上的原文引用，引用对不上就丢弃；任何字段不经人工 approve 都不会上线。`null` 一律显示为「Unverified」。

## 部署（Vercel）

`vercel.json` 已配好：构建命令 `npm run build`，静态目录 `public/`，`api/*.ts` 是函数，`/mcp`、`/health` 重写到 `/api/mcp`。需要配置的环境变量：

- `DASHSCOPE_API_KEY`
- `PAID_ACCESS_TOKENS`
- `ISSUES_REPO` 或 `FEEDBACK_EMAIL`

另外要在 `public/index.html` 的 `issues-repo` / `feedback-email` meta 里填上同样的纠错渠道。
