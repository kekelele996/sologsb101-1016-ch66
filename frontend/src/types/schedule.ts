/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 * 放行（待排/待复核 → 已排）必须与化验室当下有效的达标结论对账，并满足水位安全线；
 * 化验室事后改判或撤单时，已放行的计划退回「待复核」，等调度员重新确认。
 */

/** 走水状态：待排 / 待复核 / 已排 / 走水中 / 已出卤 */
export type ScheduleState = '待排' | '待复核' | '已排' | '走水中' | '已出卤'

/** 筛选用全部状态（「待复核」不在线性流中，由化验对账触发） */
export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '待复核', '已排', '走水中', '已出卤']

/** 线性状态推进顺序（不含「待复核」：待复核由化验室改单触发，重新确认后回到「已排」） */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

/** 退回待复核的原因：放行依据被改判 / 放行依据分析单被撤销 / 更新的分析单结论未达标 */
export type RecheckReason = '改判' | '撤单' | '新单未达标'

export const RECHECK_REASON_OPTIONS: RecheckReason[] = ['改判', '撤单', '新单未达标']

/** 放行依据：放行那一刻对账到的化验室达标分析单快照 */
export interface ReleaseBasis {
  /** 放行所依据的水样分析单 id */
  assayId: string
  /** 分析单取样日期（冗余快照，分析单被删后仍可追溯） */
  assayDate: string
  /** 放行时的结论快照，恒为「达标」 */
  verdictSnapshot: '达标'
  /** 放行/重新确认时间 ISO */
  releasedAt: string
}

export interface Schedule {
  id: string
  /** 所属蒸发池 */
  pondId: string
  /** 计划走水日期 YYYY-MM-DD */
  planDate: string
  /** 目标密度（g/cm³） */
  targetDensity: number
  /** 计划量（m³） */
  volumeM3: number
  /** 调度员 */
  operator: string
  /** 走水状态 */
  state: ScheduleState
  /** 手工拖拽后的排序序号，越小越先走水 */
  orderIndex: number
  /** 放行依据快照；待排/待复核及无依据的历史记录为 null */
  releaseBasis: ReleaseBasis | null
  /** 退回「待复核」的原因；非待复核状态为 null */
  recheckReason: RecheckReason | null
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿（状态只能通过放行/推进动作改变，不在表单里直接选） */
export interface ScheduleDraft {
  pondId: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  orderIndex: number
}
