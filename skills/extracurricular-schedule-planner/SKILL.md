---
name: extracurricular-schedule-planner
description: 为北美 9–12 年级学生生成和调整课外活动排期。读取家庭档案和候选活动，调用平台工具检查冲突、工时和截止日，输出按季度的计划和提醒。用于「帮我排一下暑假/这一年的活动」「这几个活动会不会冲突」「录取结果出来了要调整计划」。
---

# 课外活动排期

## 需要的输入（缺了先问，一次最多问 3 个）
1. 孩子：当前年级、目标方向（可多个或"未定"）、所在城市、身份（公民/PR/国际生）
2. 时间：学校日历（考试周、假期）、已有固定安排及每周小时
3. 预算：本年度课外活动预算上限（含差旅住宿）
4. 偏好：线上/线下、能否离家住宿、最远出行距离
5. 候选活动：活动 id 列表（来自 search_activities 或收藏）

## 工具（日期、工时、费用一律以工具结果为准）
- search_activities(filters)：找活动和替代活动（免费）
- get_activity(id)：日期、工时、费用、资助、资格、last_verified（免费）
- explain_signals(id)：主办方说明与费用/选拔性/产出信号（免费）
- check_conflicts(items, exams)：日期重叠、周工时、出行缓冲、考试周冲突（付费）
- get_deadlines(items)：提醒时间表 + .ics（付费）
没有付费工具时：照下面的规则逐条手工检查，并明确告诉家长哪些检查没做。

## 硬约束（违反就不进计划）
- H1 资格：年级、年龄、身份不符 → 排除并说明原因
- H2 重叠：住宿型活动与其他线下活动日期重叠 → 只留一个；住宿型活动前后各留 1 天出行。两个非住宿线下活动同期 → 提醒家长核对上课时间
- H3 已过截止：申请截止早于今天 → 移到下一年度同期
- H4 预算：总费用（扣除已确认资助）超上限 → 标红，给降本方案
- H5 未核实：last_verified 超过 12 个月或日期为 unknown → 可以进计划，但标「待核实」，不生成确定提醒

## 软约束（默认值，家长可改）
- S1 周工时：学期中课外合计 ≤ 10 小时/周；暑假（06-25 至 08-31）≤ 40 小时/周
- S2 考试：考试周及前 2 周不安排新活动开始
- S3 深度：至少 1 条同主题、持续 ≥ 2 年的主线活动
- S4 年级节奏：
  - 9–10 年级：探索，低成本、开放参与，试 2–3 个方向
  - 11 年级：收窄到 1–2 个方向，申请择优项目，争取产出
  - 11 升 12 的暑假：择优项目最重要的窗口
  - 12 年级 9–12 月：大学申请季，不新增重投入活动
- S5 信号优先：免费+择优 > 付费+择优 > 免费+开放 > 付费+开放
- S6 准备提前量：需要推荐信的提前 ≥ 3 周请老师；需要文书的提前 ≥ 4 周开始写

## 步骤
1. 收集输入；缺关键项先问
2. 对每个候选调 get_activity，按 H1、H3、H5 过滤和标记
3. 按「年级 × Fall/Winter/Spring/Summer」分槽
4. 择优项目有录取不确定性：放主选 + 备选（role=backup），备选的申请截止要晚于主选放榜，或备选是无需申请的开放项目
5. 调 check_conflicts；有冲突按 S5 和家长偏好给 2 个解决方案，不替家长选
6. 调 get_deadlines 生成提醒：申请开放、准备开始（S6）、截止前 30/7/1 天、放榜、缴费/押金截止
7. 输出 JSON + 人读摘要
8. 录取/拒信更新后：从第 4 步重跑，只动受影响的学期

## 输出
{
  "plan": [{"term": "G11-Summer", "items": [{"activity_id": "", "role": "primary|backup", "status": "candidate|applied|accepted|declined", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "hours_per_week": 0, "cost": 0}], "load_hours_per_week": 0}],
  "conflicts": [{"type": "overlap|overload|travel|exam|deadline_passed|missing_data", "items": [], "options": []}],
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
