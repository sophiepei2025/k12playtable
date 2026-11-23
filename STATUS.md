# STATUS.md — 课外活动 / edmoat-extracurriculars

## 最后更新
- **时间**：2026-11-23
- **分支**：`feat/mvp-core-mcp`
- **执行者**：Claude

## 已完成（MVP + 只读 MCP）
1. **数据**：原始 333 条迁到 `data/raw/`，新 schema v1（`src/core/schema.ts`）；`npm run build:data` 生成 `data/activities.json`。
   - 修正拼写 `Comnpetition` 和重复的地区标签。
   - Google Code-In 标为已停办（附来源）。
   - 本科/研究生条目保留，改用 `audience` 字段区分。
   - 新增加拿大地区标记。
   - 去掉 base64 logo，数据从 1 MB 降到 579 KB。
2. **核实数据**：Shad 2027 的截止日、日期、年级、费用资助已对照 shad.ca 官网核实（费用金额官网未列，保持未核实）。
3. **core**：`search`（默认「免费+择优」优先）、`signals`（主办方说明、风险提示）、`compare`、`planner`（冲突检查、截止时间线、`.ics`）、`planning-rules`（排期 Skill 唯一来源）、`issue`。
4. **LLM**：`llm.ts`，默认 qwen-us（dashscope-us），按任务路由模型，用量和成本可记录，非美国 provider 拒绝处理家庭数据。`nlquery.ts`：一句话转筛选条件；无 key 时走规则兜底。
5. **Qwen 抽取管线**：`scripts/extract-fields.ts`。
   - 默认 dry run，先估算费用。
   - 每个值都要有官网原文引用，对不上就丢弃。
   - 抽取结果进 `data/review/`，用 `scripts/review.ts` 人工审核后才上线。
6. **MCP**（Meridian 模式，已去掉 legacy SSE）：6 个免费只读 tool、2 个付费 tool（Bearer token）、2 个 prompt。
   - 本地 stdio 和 HTTP 都已验证。
7. **网页**：英文界面，共用 core 代码（esbuild 打包）。
   - 搜索、筛选、4 个决策字段卡片、「Is it worth it?」、收藏、对比、`.ics`、纠错 / 推荐。
   - 一句话搜索调用 `/api/parse-query`。
8. **公开 API**：`/api/activities`、`/api/parse-query`、`/llms.txt`、`/openapi.json`。
9. **测试**：27 个（schema、搜索、信号、排期、LLM mock、抽取引用校验、MCP 内存与 HTTP 协议）全部通过；headless Chrome 走通主要交互，控制台无报错。

## 待办 / 下一步
- [ ] 配置 `DASHSCOPE_API_KEY`（弗吉尼亚 key），跑 `npm run extract -- --limit 50 --yes`，再人工审核补齐高频 50 条的 5 个决策字段。
- [ ] 实测 qwen-us 下 qwen3.7-flash / qwen-flash / qwen3.7-plus 在「美国」部署范围是否可用，以及是否支持 `response_format`。
- [ ] 往 `data/seed/candidates.csv` 加 20+ 个加拿大本地项目，跑 `--candidates`。
- [ ] 确定纠错渠道：`ISSUES_REPO` 或 `FEEDBACK_EMAIL`，同时填进 `public/index.html` 的 meta。
- [ ] 部署 Vercel，确认 `/health`、`/mcp`、`/api/*` 和静态页面都正常。
- [ ] V2：付费 tool 改用 OAuth 2.1（按家庭）、Stripe、排期 UI、Supabase（加拿大区）。
- [ ] S4–S6 和 H5 的默认值待你确认（S1、S2 已确认）。
