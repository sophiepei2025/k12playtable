import { PLANNING_DEFAULTS as D } from "./planner.js";
import { LOGISTICS_DEFAULTS as L } from "./logistics.js";

/**
 * Single source of truth for the scheduling skill.
 * - served by the MCP tool `get_planning_rules`
 * - written to skills/extracurricular-schedule-planner/SKILL.md by `npm run build:data`
 * Numbers come from PLANNING_DEFAULTS so code and text never drift.
 */
export const PLANNING_SKILL_MD = `---
name: extracurricular-schedule-planner
description: 为北美 9–12 年级学生生成和调整课外活动排期。读取家庭档案和候选活动，调用平台工具检查冲突、工时和截止日，输出按季度的计划和提醒。用于「帮我排一下暑假/这一年的活动」「这几个活动会不会冲突」「录取结果出来了要调整计划」。
---

# 课外活动排期

## 需要的输入（缺了先问，一次最多问 3 个）
1. 孩子：当前年级、目标方向（可多个或"未定"）、所在城市、身份（公民/PR/国际生）
2. 时间：学校日历（考试周、假期）、已有固定安排及每周小时
   - 接送：家住哪个城市/区；谁负责交通（家长开车 / 公共交通 / 孩子自己去）；家长每周最多能花多少小时接送
3. 预算：本年度课外活动预算上限（含差旅住宿）
4. 偏好：线上/线下、能否离家住宿、最远出行距离
5. 候选活动：活动 id 列表（来自 search_activities 或收藏）

## 工具（日期、工时、费用一律以工具结果为准）
- search_activities(filters)：找活动和替代活动（免费）；传 home_city 可得通勤估算，sort=convenience 按接送成本排序
- get_activity(id)：日期、工时、费用、资助、资格、last_verified（免费）
- explain_signals(id)：主办方说明与费用/选拔性/产出信号（免费）
- check_conflicts(items, exams)：日期重叠、周工时、出行缓冲、考试周冲突（付费）
- get_deadlines(items)：提醒时间表 + .ics（付费）
没有付费工具时：照下面的规则逐条手工检查，并明确告诉家长哪些检查没做。

## 硬约束（违反就不进计划）
- H1 资格：年级、年龄、身份不符 → 排除并说明原因
- H2 重叠：住宿型活动与其他线下活动日期重叠 → 只留一个；住宿型活动前后各留 ${D.residential_travel_days} 天出行。两个非住宿线下活动同期 → 提醒家长核对上课时间
- H3 已过截止：申请截止早于今天 → 移到下一年度同期
- H4 预算：总费用（扣除已确认资助）超上限 → 标红，给降本方案
- H5 未核实：last_verified 超过 ${Math.round(D.stale_after_days / 30)} 个月或日期为 unknown → 可以进计划，但标「待核实」，不生成确定提醒

## 软约束（默认值，家长可改）
- S1 周工时：学期中课外合计 ≤ ${D.school_term_max_hours} 小时/周；暑假（${D.summer_start} 至 ${D.summer_end}）≤ ${D.summer_max_hours} 小时/周。**孩子的通勤时间计入工时**
- S2 考试：考试周及前 ${D.exam_buffer_days / 7} 周不安排新活动开始
- S3 深度：至少 1 条同主题、持续 ≥ 2 年的主线活动
- S4 年级节奏：
  - 9–10 年级：探索，低成本、开放参与，试 2–3 个方向
  - 11 年级：收窄到 1–2 个方向，申请择优项目，争取产出
  - 11 升 12 的暑假：择优项目最重要的窗口
  - 12 年级 9–12 月：大学申请季，不新增重投入活动
- S5 排序（家长二选一，默认「信号优先」）：
  - 信号档：免费+择优 > 付费+择优 > 免费+开放 > 付费+开放
  - 接送成本档：线上（无通勤）< 离家近（单程 ≤ ${L.low_commute_minutes} 分钟）< 中等（≤ S7 上限）< 地点未核实 < 远（超 S7）< 需出远门/住宿（> ${L.travel_km} km 或住宿型）
  - 信号优先：先比信号档，同档内接送成本低的在前
  - 省心优先：先比接送成本档，同档内信号档高的在前
  - 排序模式本身不排除任何活动；只有家长明确设定了通勤上限（max_commute_minutes）才过滤，且住宿型项目不受影响。超出 S7/S8 的活动要标出来，并给替代方案（线上同类、更近的同类、拼车/公交）
  - 线上 vs 线下要讲清取舍：线上省接送、跨地区选择多；线下有实操、人脉和面对面推荐人，选拔型线下项目的信号通常更强
- S7 通勤：每周多次的线下活动，单程 ≤ ${L.max_commute_minutes} 分钟；混合制按线下次数算
- S8 家长接送时间：≤ ${L.parent_max_hours_per_week} 小时/周（仅家长开车接送时计）。每次接送按「送完回家再来接（4 个单程）」和「送到后原地等（2 个单程 + 活动时长）」两者取短
- S6 准备提前量：需要推荐信的提前 ≥ ${D.rec_letter_lead_days / 7} 周请老师；需要文书的提前 ≥ ${D.essay_lead_days / 7} 周开始写

## 步骤
1. 收集输入；缺关键项先问
2. 对每个候选调 get_activity，按 H1、H3、H5 过滤和标记
3. 按「年级 × Fall/Winter/Spring/Summer」分槽
4. 择优项目有录取不确定性：放主选 + 备选（role=backup），备选的申请截止要晚于主选放榜，或备选是无需申请的开放项目
5. 调 check_conflicts（每个线下活动带上 commute_minutes_one_way 和 sessions_per_week，family 里带 transport 和上限）；有冲突按 S5 和家长偏好给 2 个解决方案，不替家长选
6. 调 get_deadlines 生成提醒：申请开放、准备开始（S6）、截止前 ${D.reminder_days.join("/")} 天、放榜、缴费/押金截止
7. 输出 JSON + 人读摘要
8. 录取/拒信更新后：从第 4 步重跑，只动受影响的学期

## 输出
{
  "plan": [{"term": "G11-Summer", "items": [{"activity_id": "", "role": "primary|backup", "status": "candidate|applied|accepted|declined", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "hours_per_week": 0, "cost": 0}], "load_hours_per_week": 0}],
  "conflicts": [{"type": "overlap|overload|travel|exam|deadline_passed|missing_data|commute|parent_time", "items": [], "options": []}],
  "logistics": {"parent_hours_per_week_max": 0, "student_commute_hours_per_week_max": 0},
  "deadlines": [{"activity_id": "", "type": "app_open|prep_start|app_deadline|decision|deposit", "date": "YYYY-MM-DD"}],
  "budget": {"total": 0, "aid_confirmed": 0, "cap": 0, "currency": "CAD"},
  "unverified": [],
  "assumptions": []
}
摘要 3–5 句：先说计划能不能执行、最大风险是什么，再列需要家长决定的事。

## 禁止
- 不编造日期、费用、录取率；工具返回 null/unknown 就写 unknown
- 不自己做日期加减或工时求和，以 check_conflicts 为准
- 不承诺录取结果
- 不替学生提交申请或写文书
- 不把孩子的个人信息写进对外分享的清单

## 示例
输入：10 年级，对 CS 感兴趣，多伦多，学期中已有游泳 6 小时/周，预算 CAD 3,000；候选：CEMC 数学竞赛（waterloo-cemc-contests）、Shad（shad-canada）、某付费编程夏校（7 月）。
输出要点：
- CEMC：放在 G10 学期内，低成本、有择优信号，周工时仍在 S1 上限内
- Shad：面向 10–11 年级，2027 年申请截止 2027-01-06，7 月 4–30 日；费用未核实 → H5 标「待核实」，提示可申请费用资助
- 付费编程夏校与 Shad 同在 7 月 → H2 冲突；方案 A：Shad 主选、夏校作备选（等 Shad 放榜后再交费）；方案 B：只报夏校、省下预算
- 学期中加一个每周 2 次、每次 1.5 小时、单程 40 分钟的机器人俱乐部 → 家长接送约 5.3 小时/周（每次取「4 个单程 160 分钟」与「2 个单程 + 等 90 分钟 = 170 分钟」中的短者），超 S8；孩子通勤 2.7 小时/周计入 S1；方案：拼车，或换线上/离家更近的同类
`;

export function planningRules() {
  return {
    defaults: D,
    logistics_defaults: L,
    confirmed_by_owner: ["school_term_max_hours", "summer_max_hours", "exam_buffer_days"],
    pending_owner_review: ["max_commute_minutes", "parent_max_hours_per_week", "rec_letter_lead_days", "essay_lead_days", "stale_after_days"],
    skill_md: PLANNING_SKILL_MD,
  };
}
