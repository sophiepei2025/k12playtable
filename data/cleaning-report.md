# 数据清洗与抽取校验报告（`chore/data-cleaning`）

> 生成时间：2026-11-23 | 执行分支：`chore/data-cleaning` | `data/raw/*` 保持只读未改动

---

## 1. 清洗前后统计对比

| 指标 | 清洗前（基线） | 清洗后（当前） | 说明 |
| --- | --- | --- | --- |
| 原始记录数（`data/raw/extracurriculars.json`） | 333 | 333 | 严格只读，未改动一个字节 |
| 构建产物数（`data/activities.json`） | 355 | **354** | 含 `added.json` 22 条，合并去重 1 条 |
| 重复名称 / 重复链接组数（构建产物） | 1 / 1 | **0 / 0** | 已合并 `us_national_chemistry_olympiad` → `us_national_chem_olympiad` |
| `category` 拼写错误 `Comnpetition` | raw: 1 / built: 0 | **built: 0** | `build-data.ts` `normalizeRaw` 已自动修正 |
| `location` 格式异常（`Global Worldwide` / `Mid West(USA)`） | raw: 1 + 7 / built: 0 | **built: 0** | `build-data.ts` `normalizeRaw` 已自动规范化 |
| `http://` 链接数（构建产物） | 3 | **2** | `usaco_olympiad` 升级为 `https://www.usaco.org/`；其余 2 条 HTTPS 不可达保留原样 |
| `cost === null` 计数 | 355 / 355 | **354 / 354** | 原始 `None` 均保持 `null`，未误填 `0` |
| `fee_type === null` / `free` | 353 / 2 | **352 / 2** | 仅 `added.json` 中明确声明免费的 2 条为 `free`，原始记录未误推断 |
| 单测通过数（`npm test`） | 34 / 34 | **35 / 35** | 新增 Shad 弱引用反例与 `year_inferred` 单测 |

---

## 2. 本次修改及理由

### 2.1 结构性清洗（`scripts/build-data.ts`）
1. **重复合并**：在 `MERGED_RAW_IDS` 中跳过 `us_national_chemistry_olympiad`，保留信息更完整的 `us_national_chem_olympiad`（后者包含 9–12 年级与美国公民/永居资格说明）。
2. **HTTPS 升级**：在 `HTTPS_UPGRADES` 中将 `http://www.usaco.org/` 升级为 `https://www.usaco.org/`（实测 `200 OK`）。其余 2 条（`http://physicsu.org/premier`、`http://bridgecontest.phys.iit.edu/`）实测 HTTPS 连接失败（`000`），未强行改写。
3. **质量画像脚本**：新增 `scripts/profile-data.ts` 与 `scripts/check-links.ts`（结果缓存至 `data/cache/link-check.json`）。

### 2.2 抽取校验收紧（`scripts/extract-fields.ts` & `scripts/review.ts`）
针对 `shad-canada` 此前通过宽松引文校验的弱字段，在 `verifyQuotes` 中新增 6 条强校验规则，并将被拒字段写入独立的 `dropped_weak_evidence`（附带具体原因），与 `dropped_unquoted` 分开：
1. **长度与纯数字限制**：引文压缩空白后长度必须 `≥ 20` 字符，且不能是纯数字（拦截 `"5"`、`"Shad 2027"`）。
2. **数值字段单位与数字一致性**（`hours_per_week`、`total_weeks`、`sessions_per_week`、`acceptance_rate`、`cost`）：引文必须同时包含抽取数值（兼容千分位逗号如 `$7,500`）与对应单位关键词（`week`/`hour`/`session`/`%`/`$` 等）。
3. **资格字段限制**（`citizenship`、`international_ok`）：引文必须包含资格关键词（`citizen`/`resident`/`permanent`/`eligible`/`international`/`visa` 等），拦截宣传语（如 `"Canada’s launchpad for future innovators"`）。
4. **资助字段限制**（`aid`）：`full_for_low_income` 要求引文含 `full` / `100%` / `no cost` / `tuition-free` 等词；仅提及 `"financial support"` 的被拦截。
5. **年份推断标记**：日期字段（`app_open`、`app_deadline`、`start`、`end`）若引文中未出现 4 位年份，在 `evidence[field]` 写入 `year_inferred: true`，并在 `npm run review -- show` 中黄色高亮 `[YEAR_INFERRED]`。
6. **异常容错**：放宽 `Extracted.cost.currency` 默认值与可空字段，避免模型漏填子字段导致整页抽取失败。

---

## 3. 需要你决定的清单（人工决策）

### 3.1 死链检查结果（共 354 条活跃链接，并发 5、超时 10s）
汇总：`ok`: **180** | `redirect`: **67** | `blocked (401/403)`: **38** | `404`: **49** | `error`: **19** | `timeout`: **2**（注：总计 355 含去重前一次检查）。

#### A. 返回 404 的 49 条（建议逐批核实官网新 URL 或标为 `discontinued`）
- **疑似已停办 / 项目已结束（重点关注）**：
  - `cyberstart` (`https://www.cyberstartamerica.org/`) — CyberStart America 已于 2024 年停办
  - `national_cyber_scholarship_competition` (`https://www.nationalcyberscholarship.org/`) — 关联项目同样停办/迁移
  - `google-code-next` (`https://codenext.withgoogle.com/`) / `google-cs-first` (`https://csfirst.withgoogle.com/`) — Google 教育站点改版或下线
  - `beaverworks` (`https://chsmstmagnet.com/wp-content/uploads/2021/12/bwsi2022.jpg`) — 原始数据链接为 2022 年图片，建议改为 `https://beaverworks.ll.mit.edu/CMS/bw/BWSI`
- **企业招聘/项目页改版导致 404（共 35 条，多为大厂校招 URL 迁移）**：
  - `ai4all-summer-programs`, `airbnb-connect-and-internships`, `bmo-student-internships`, `capital-one-early-internship`, `cloudflare-internships`, `darpa-innovation-fellowship`, `forbes-fellowship`, `general-dynamics-internships`, `girls-who-code-sip`, `github-internships`, `imc-trading-internships`, `intuit-student-internships`, `microsoft-research-intern`, `mila-quebec-ai-internships`, `morgan-stanley-summer-analyst`, `netflix-pathways-bootcamp`, `noaa-young-changemakers`, `northrop-grumman-hip`, `optiver-internships`, `oracle-student-internships`, `qualcomm-innovation-fellowship`, `rbc-summer-tech-labs`, `rivian-student-internships`, `roblox-student-internships`, `rtx-student-internships`, `scotiabank-student-programs`, `snap-academies`, `stanford-aimi-summer-research`, `twilio-internships`, `two-sigma-internships`, `visa-internships`
- **其余比赛/夏校 404（11 条）**：
  - `anson_clarke_scholars_program`, `bbc-young-writers-award`, `berkeley_entrepreneurship_program`, `berkely_academic_year_program`, `best_robotics_competition`, `bow-seat-ocean-awareness-contest`, `doodle_google_artcomp`, `kenyon-review-patricia-grodd-poetry-prize`, `national_greek_exam`, `npr-student-podcast-challenge`, `spj-jea-high-school-essay-contest`, `tecbridge_business_competition`, `world_historian_student_essay_comp`, `Yesf93eSiMmhXwRthAE4`

#### B. 超时 / 连接失败（21 条，部分为反爬或 TLS/DNS 问题）
- **Timeout (2)**：`rattle-young-poets-anthology`, `youth_citizen_entrepreneurship_challenge`
- **Error (19)**：`blue-origin-internships` (429), `interact_club` (429), `LkdulmiycySw8ShoBofE` (520), `meta-summer-academy` (400), `cold-spring-harbor-dnalc`, `conrad_challenge`, `fpsi_challenge`, `hcssim`, `junior_state_of_america_club`, `natgeo_student_photography_contest`, `national_academic_league`, `nrel-student-internships`, `odyssey_of_the_mind_competition`, `plant_the_moon_challenge`, `ron-brown-scholar-program`, `scripps-research-high-school`, `stone-soup-magazine`, `the_clean_tech_competition`, `vans_custom_culture`

### 3.2 小批量真实抽取 Review 批准建议（均未 approve）
本批共运行 `shad-canada`（`--force`）及 20 条活跃高中项目，**12 条成功、8 条因模型返回非标准枚举/字符串数字失败**（可作为后续收紧 prompt 的参考）：

| ID | 建议批准字段（`--fields`） | 建议忽略 / 暂缓字段及原因 |
| --- | --- | --- |
| `shad-canada` | `dates.app_open,dates.app_deadline,region.city` | `outputs`/`residential`/`selectivity` 引文为通用宣传语；`aid`/`start`/`end`/`acceptance_rate` 已被弱规则拦截 |
| `aspire_internship_program` | `fee_type,aid,hours_per_week,selectivity,acceptance_rate,eligibility.grades,residential,region.city` | `outputs`（引文未提及 certificate） |
| `burger-king-scholars` | `dates.app_open,dates.app_deadline,selectivity` | `grades`（误标为 9–12，实际仅 12 年级）；`dates.start` 含 `[year_inferred]`；`fee_type` 引文为截止时间 |
| `ciee-fellowship-intern` | `fee_type,total_weeks,residential` | `selectivity`（引文 `"2% of U.S. high school students"` 为全美出国比例，非项目录取率） |
| `brower_youth_awards` | `dates.start,dates.end,region.city` | `fee_type`/`aid`/`selectivity` 引文为泛泛介绍 |
| `adopt_a_physicist` | `selectivity` | `dates.start`/`dates.end` 为模型根据 `"Fall 2026"` 估算的起止日 |
| `waterloo-cemc-contests` | `eligibility.international_ok` | 无（仅 1 个字段且引文准确） |
| 其余 6 条 0 字段（`beaverworks`, `boeing-student-internships`, `bofa-student-leaders-foundation`, `brookhaven-high-school-research`, `built-by-girls-wave`, `first-canada-robotics`） | 无需批准 | 均未抽取出带有效引文的字段（建议 `reject` 或修复 URL 后重抽） |

---

## 4. LLM 实际花费

- `shad-canada` 重跑（含 1 次 schema 报错 + 1 次成功）：`$0.0003 + $0.0003 = $0.0006`
- 20 条高中活跃项目小批量抽取（124,306 tokens）：`$0.0050`
- **总计实际花费**：**`$0.0056`**（远低于 `$0.05` 上限）
