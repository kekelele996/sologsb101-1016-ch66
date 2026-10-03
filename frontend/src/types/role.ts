/**
 * 工作台角色
 * 调度室：操作走水编排（放行、推进、排序），不能改水样分析单；
 * 化验室：登记水样分析单并给出达标结论，不能动走水编排的先后顺序与状态。
 */
export type AppRole = '调度室' | '化验室'

export const APP_ROLE_OPTIONS: AppRole[] = ['调度室', '化验室']
