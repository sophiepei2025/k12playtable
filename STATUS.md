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
9. **测试**：34 个（schema、搜索、信号、排期、LLM mock、抽取引用校验、MCP 内存与 HTTP 协议）全部通过；headless Chrome 走通主要交互，控制台无报错。

10. **接送成本（S5 扩展、S7、S8）**：`src/core/logistics.ts`。
    - 线上/线下、离家距离（城市坐标 + 两段速度模型估算）、家长接送时间。
    - 搜索支持 `home_city` 和 `sort=convenience`，结果带 logistics 档位和估算通勤时间。
    - 冲突检查计入孩子通勤，新增 commute 和 parent_time 冲突类型。
    - 网页新增家所在城市选择、「Easiest logistics first」排序，卡片显示「Getting there」。

11. **MVP 模型切到千问中国**：新增 provider `qwen-cn`（北京，默认），key 按地区拆成 `DASHSCOPE_API_KEY_CN`、`_US`、`_INTL`（旧的 `DASHSCOPE_API_KEY` 仍兼容）。家庭数据走中国节点需要明确设置 `LLM_ALLOW_FAMILY_DATA_ON=qwen-cn`；成本按各地区价格分别记录；`/health` 显示当前 provider。

## 待办 / 下一步
- [ ] 配置 `DASHSCOPE_API_KEY_CN`（北京 key，MVP 默认 qwen-cn），跑 `npm run extract -- --limit 50 --yes`，再人工审核补齐高频 50 条的 5 个决策字段。
- [ ] 实测 qwen-cn 下 `response_format=json_object` 和 `enable_thinking=false` 是否被三个模型接受。
- [ ] （预留）切美国：填 `DASHSCOPE_API_KEY_US` → `LLM_PROVIDER=qwen-us` → 删 `LLM_ALLOW_FAMILY_DATA_ON`；切之前实测三个模型在「美国」部署范围是否可用。
- [ ] 往 `data/seed/candidates.csv` 加 20+ 个加拿大本地项目，跑 `--candidates`。
- [ ] 确定纠错渠道：`ISSUES_REPO` 或 `FEEDBACK_EMAIL`，同时填进 `public/index.html` 的 meta。
- [ ] 部署 Vercel，确认 `/health`、`/mcp`、`/api/*` 和静态页面都正常。
- [ ] V2：付费 tool 改用 OAuth 2.1（按家庭）、Stripe、排期 UI、Supabase（加拿大区）。
- [ ] S4–S8 和 H5 的默认值待你确认（S1、S2 已确认）。S7 通勤 ≤ 45 分钟、S8 家长接送 ≤ 4 小时/周为暂定。
- [ ] 活动地点（city）大多未核实，接送成本多显示「Location not verified」；抽取管线已加 city 和 sessions_per_week 字段，跑一轮就能补上。
