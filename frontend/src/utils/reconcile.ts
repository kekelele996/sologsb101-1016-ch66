/**
 * 走水放行对账（调度室 ⇄ 化验室）
 *
 * 放行闸（待排 / 待复核 → 已排）必须同时满足：
 *  1. 样品闸：该池当下有效的化验结论（最新一份分析单，人工覆盖优先）为「达标」；
 *  2. 水位闸：该池最近一次卤水日观测的水位不低于安全线。
 * 两道闸分别给出拦截原因，提示调度员分清是样品还是水位挡住了放行。
 *
 * 化验室事后把放行所依据的分析单改回未达标、撤掉分析单，
 * 或补登了更新的未达标分析单时，已放行（已排 / 走水中）的计划退回「待复核」。
 * 这些判断全部是纯函数，db 层在 Dexie 事务内调用，保证两边始终一致。
 */
import type { Assay } from '../types/assay';
import type { Observation } from '../types/observation';
import type { RecheckReason, ReleaseBasis, Schedule } from '../types/schedule';
import { effectiveVerdict } from './brine';

/** 池子水位安全线（cm）：低于此线，样品再达标也放行不了 */
export const SAFE_LEVEL_CM = 30;

/** 放行拦截类型：样品（化验结论） / 水位 */
export type ReleaseBlockKind = 'sample' | 'level';

export interface ReleaseBlock {
  kind: ReleaseBlockKind;
  message: string;
}

export interface ReleaseGateResult {
  /** 两道闸都通过才可放行 */
  passable: boolean;
  blocks: ReleaseBlock[];
  /** 当下有效的分析单（最新一份），无化验记录时为 null */
  assay: Assay | null;
  /** 当下有效结论；无化验记录时为 null */
  verdict: Assay['verdict'] | null;
  /** 最近一次观测水位（cm），无观测记录时为 0 */
  levelCm: number;
}

/** 退回待复核原因的现场提示 */
export const RECHECK_REASON_HINTS: Record<RecheckReason, string> = {
  改判: '化验室已把放行所依据的分析单结论改回未达标',
  撤单: '化验室已撤销放行所依据的水样分析单',
  新单未达标: '化验室补登了更新的分析单，当下有效结论为未达标',
};

/** 同池分析单按日期升序（同日以 updatedAt 新者在后），最后一项即当下有效的一份 */
export function sortAssaysByDate(list: Assay[]): Assay[] {
  return [...list].sort((a, b) => a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt));
}

/** 取某池当下有效的分析单（最新一份），没有返回 null */
export function latestAssayOf(pondId: string, assays: Assay[]): Assay | null {
  const list = sortAssaysByDate(assays.filter((item) => item.pondId === pondId));
  return list.length > 0 ? list[list.length - 1] : null;
}

/** 取某池最近一次观测水位（cm），没有观测记录返回 0 */
export function latestLevelOf(pondId: string, observations: Observation[]): number {
  const list = observations
    .filter((item) => item.pondId === pondId)
    .sort((a, b) => a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt));
  if (list.length === 0) return 0;
  return list[list.length - 1].levelCm;
}

/**
 * 放行闸：与化验室当下有效结论对账，并检查水位安全线。
 * 样品闸与水位闸独立判定，两道同时通过才放行。
 */
export function evaluateReleaseGate(pondId: string, assays: Assay[], observations: Observation[]): ReleaseGateResult {
  const blocks: ReleaseBlock[] = [];

  // 样品闸：只认当下有效的一份（最新分析单，人工覆盖优先）
  const assay = latestAssayOf(pondId, assays);
  const verdict = assay === null ? null : effectiveVerdict(assay);
  if (assay === null) {
    blocks.push({ kind: 'sample', message: '该池还没有化验室登记的水样分析单，样品结论缺失' });
  } else if (verdict !== '达标') {
    blocks.push({ kind: 'sample', message: `当下有效化验结论为「${verdict ?? '未达标'}」（${assay.date} 分析单），样品未达标` });
  }

  // 水位闸：与样品闸互不影响，缺观测也视为水位侧挡下
  const levelCm = latestLevelOf(pondId, observations);
  const hasObservation = observations.some((item) => item.pondId === pondId);
  if (!hasObservation) {
    blocks.push({ kind: 'level', message: '该池还没有卤水日观测记录，无法确认水位高于安全线' });
  } else if (levelCm < SAFE_LEVEL_CM) {
    blocks.push({ kind: 'level', message: `最近观测水位 ${levelCm} cm，低于安全线 ${SAFE_LEVEL_CM} cm` });
  }

  return { passable: blocks.length === 0, blocks, assay, verdict, levelCm };
}

/** 把拦截项拼成可直接展示的提示；样品、水位原因并列，方便分清是谁挡住了 */
export function describeReleaseBlocks(blocks: ReleaseBlock[]): string {
  return blocks.map((block) => (block.kind === 'sample' ? `样品挡住：${block.message}` : `水位挡住：${block.message}`)).join('；');
}

/**
 * 化验对账：判断一条已放行计划（已排 / 走水中）是否应退回待复核。
 * 返回 null 表示放行依据仍然有效；返回原因表示必须退回、等调度员重新确认。
 * - 放行依据分析单被删除            → 撤单
 * - 依据分析单结论被改回未达标        → 改判
 * - 补登了更新的分析单且其结论未达标  → 新单未达标
 * （补登更新的达标分析单不退回，依据快照保留；已出卤的历史编排不参与对账。）
 */
export function reconcileSchedule(
  row: Pick<Schedule, 'pondId' | 'state' | 'releaseBasis'>,
  assays: Assay[],
): RecheckReason | null {
  if (row.state !== '已排' && row.state !== '走水中') return null;
  const basis = row.releaseBasis;
  if (basis === null) return null;

  const basisAssay = assays.find((item) => item.id === basis.assayId);
  if (basisAssay === undefined) return '撤单';
  if (effectiveVerdict(basisAssay) !== '达标') return '改判';

  const latest = latestAssayOf(row.pondId, assays);
  if (latest !== null && latest.id !== basis.assayId && effectiveVerdict(latest) !== '达标') {
    return '新单未达标';
  }
  return null;
}

/**
 * 升级 / 导入补归属：旧版本走水编排没有放行依据，按池补一条达标分析单快照。
 * 只给「已排 / 走水中」补；补不到达标分析单的保持 null（状态原样保留，不退回）。
 * 待排 / 待复核 / 已出卤不补。历史顺序（orderIndex）与状态不动。
 */
export function backfillReleaseBasis(
  row: Schedule,
  assays: Assay[],
  releasedAt = row.updatedAt,
): Pick<Schedule, 'releaseBasis' | 'recheckReason'> {
  if (row.releaseBasis !== undefined && row.releaseBasis !== null) {
    return { releaseBasis: row.releaseBasis, recheckReason: row.recheckReason ?? null };
  }
  if (row.state !== '已排' && row.state !== '走水中') {
    return { releaseBasis: null, recheckReason: typeof row.recheckReason === 'string' ? row.recheckReason : null };
  }
  const latestPassing = [...assays]
    .filter((item) => item.pondId === row.pondId && effectiveVerdict(item) === '达标')
    .sort((a, b) => a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt))
    .pop();
  if (latestPassing === undefined) {
    return { releaseBasis: null, recheckReason: null };
  }
  const basis: ReleaseBasis = {
    assayId: latestPassing.id,
    assayDate: latestPassing.date,
    verdictSnapshot: '达标',
    releasedAt,
  };
  return { releaseBasis: basis, recheckReason: null };
}
