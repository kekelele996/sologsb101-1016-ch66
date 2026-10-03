/**
 * 走水编排（Schedule）
 * 按日期排序的走水与出卤计划，可通过拖拽调整先后顺序。
 * 放行（进入「走水中」）必须对账化验室当下有效的达标结论；放行依据事后失效
 * （改判 / 撤单 / 被更新的结论顶替）时，编排自动退回「待复核」等调度员重新确认。
 */

/** 走水状态：待排 / 已排 / 走水中 / 已出卤 / 待复核 */
export type ScheduleState = '待排' | '已排' | '走水中' | '已出卤' | '待复核'

export const SCHEDULE_STATE_OPTIONS: ScheduleState[] = ['待排', '已排', '走水中', '已出卤', '待复核']

/**
 * 正向状态推进顺序（不含「待复核」——待复核是放行依据失效后的退回态，
 * 只能由调度员在对账通过后「重新确认」回到退回前的状态）。
 */
export const SCHEDULE_STATE_FLOW: ScheduleState[] = ['待排', '已排', '走水中', '已出卤']

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
  /**
   * 放行依据：放行（进入走水中）时锁定的化验分析单 id；
   * null 表示尚未放行（v3 升级时对历史在途编排按池补归属，补不到也保持 null）。
   * 调度室不得手工修改，改派蒸发池时清空。
   */
  basisAssayId: string | null
  /** 放行时锁定的依据取样日期（便于对账留痕，冗余自分析单） */
  basisAssayDate: string | null
  /** 放行时锁定的依据达标结论快照 */
  basisVerdict: string | null
  /** 放行时间 ISO */
  releasedAt: string | null
  /** 退回「待复核」前的状态，重新确认后回到该状态 */
  resumeState: ScheduleState | null
  /** 最近一次退回「待复核」的原因 */
  rollbackReason: string | null
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑走水编排的表单草稿（放行依据由系统对账维护，不进表单） */
export interface ScheduleDraft {
  pondId: string
  planDate: string
  targetDensity: number
  volumeM3: number
  operator: string
  state: ScheduleState
  orderIndex: number
}
