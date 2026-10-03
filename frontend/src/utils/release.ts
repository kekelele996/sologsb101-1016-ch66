/**
 * 走水放行对账规则（调度室 × 化验室交接面）
 * - 放行（进入「走水中」）前必须与化验室「当下有效」的结论对账：
 *   只有该池最新一条分析单的有效判定为「达标」才放行；
 * - 池水位低于安全线时，样品再达标也不得放行；
 * - 化验室事后改判 / 撤单 / 用更新的结论顶替时，已放行的编排退回「待复核」。
 * 本文件只放纯计算，不读数据库，便于在 DB 层与 UI 层复用同一套口径。
 */
import type { Assay } from '../types/assay';
import type { Observation } from '../types/observation';
import type { Schedule } from '../types/schedule';
import { effectiveVerdict } from './brine';

/** 水位安全线（cm）：低于该线禁止放行走水（与蒸发量折减口径一致） */
export const SAFE_LEVEL_CM = 10;

/** 放行依据对账状态 */
export type BasisStatus =
  | 'ok' // 依据仍然有效：放行所依据的分析单仍是该池最新且达标
  | 'missing-basis' // 编排没有放行依据（历史旧编排补不到归属，或从未放行）
  | 'revoked' // 依据分析单已被化验室撤销
  | 'changed-to-fail' // 依据分析单被改回「未达标」（或「接近」）
  | 'superseded-fail' // 有更新的分析单，且最新有效判定不是达标
  | 'superseded-pass'; // 有更新的分析单顶替，但最新有效判定仍达标

/** 各对账状态对应的可读退回原因 */
export const BASIS_ROLLBACK_REASON: Record<Exclude<BasisStatus, 'ok' | 'missing-basis'>, string> = {
  revoked: '放行依据的水样分析单已被化验室撤销',
  'changed-to-fail': '放行依据已被化验室改回未达标',
  'superseded-fail': '化验室最新有效结论已不是达标',
  'superseded-pass': '化验室出具了更新的达标结论，原放行依据已过期',
};

export interface BasisEvaluation {
  status: BasisStatus;
  /** 该池最新一条分析单（当下有效结论的载体），可能为 null */
  latestAssay: Assay | null;
  /** 放行依据对应的分析单（已撤单时为 null） */
  basisAssay: Assay | null;
}

/** 取池内最新一条分析单（按取样日期，同日以更新时间靠后的为准） */
export function latestAssayOf(list: Assay[]): Assay | null {
  if (list.length === 0) return null;
  return [...list].sort((a, b) => a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt))[list.length - 1];
}

/**
 * 评估一条编排的放行依据当下是否仍然有效。
 * @param schedule  走水编排
 * @param pondAssays 该池当前全部分析单（撤单即从集合中消失）
 */
export function evaluateBasis(schedule: Pick<Schedule, 'basisAssayId'>, pondAssays: Assay[]): BasisEvaluation {
  const latestAssay = latestAssayOf(pondAssays);
  const basisAssay = schedule.basisAssayId === null ? null : pondAssays.find((item) => item.id === schedule.basisAssayId) ?? null;
  if (schedule.basisAssayId === null) {
    return { status: 'missing-basis', latestAssay, basisAssay: null };
  }
  if (basisAssay === null) {
    return { status: 'revoked', latestAssay, basisAssay: null };
  }
  if (effectiveVerdict(basisAssay) !== '达标') {
    return { status: 'changed-to-fail', latestAssay, basisAssay };
  }
  if (latestAssay !== null && latestAssay.id !== basisAssay.id) {
    return {
      status: effectiveVerdict(latestAssay) === '达标' ? 'superseded-pass' : 'superseded-fail',
      latestAssay,
      basisAssay,
    };
  }
  return { status: 'ok', latestAssay, basisAssay };
}

/** 依据失效是否需要把编排退回「待复核」（更新结论即使仍达标也要调度员重新对账） */
export function shouldRollback(status: BasisStatus): boolean {
  return status === 'revoked' || status === 'changed-to-fail' || status === 'superseded-fail' || status === 'superseded-pass';
}

/** 放行 / 重新确认前的阻挡原因，样品与水位分开报，便于调度员分辨 */
export interface GateBlock {
  /** 样品（化验结论）是否挡住放行 */
  sampleBlocked: boolean;
  /** 水位是否挡住放行 */
  levelBlocked: boolean;
  /** 样品侧说明 */
  sampleReason: string;
  /** 水位侧说明 */
  levelReason: string;
  /** 对账通过时锁定的放行依据分析单 */
  basisAssay: Assay | null;
}

/**
 * 放行闸口检查：样品达标与水位安全必须同时满足。
 * @param latestAssay 该池最新分析单（可为 null）
 * @param latestObservation 该池最新观测（取水位，可为 null）
 */
export function checkReleaseGate(
  latestAssay: Assay | null,
  latestObservation: Pick<Observation, 'levelCm'> | null,
): GateBlock {
  const verdict = latestAssay === null ? null : effectiveVerdict(latestAssay);
  const sampleBlocked = verdict !== '达标';
  const levelCm = latestObservation === null ? null : latestObservation.levelCm;
  const levelBlocked = levelCm === null || levelCm < SAFE_LEVEL_CM;
  const sampleReason =
    latestAssay === null
      ? '该池还没有水样分析单，化验室未给出达标结论'
      : verdict === '达标'
        ? `化验室最新结论达标（${latestAssay.date}）`
        : `化验室最新有效结论为「${verdict}」（${latestAssay.date}），未达标不得放行`;
  const levelReason =
    levelCm === null
      ? '该池还没有水位观测记录，无法确认水位高于安全线'
      : levelBlocked
        ? `当前水位 ${levelCm} cm，低于安全线 ${SAFE_LEVEL_CM} cm`
        : `当前水位 ${levelCm} cm，高于安全线 ${SAFE_LEVEL_CM} cm`;
  return {
    sampleBlocked,
    levelBlocked,
    sampleReason,
    levelReason,
    basisAssay: sampleBlocked ? null : latestAssay,
  };
}

/** 放行业务说明（UI 复用，保证各处口径一致） */
export function gateBlockSummary(block: GateBlock): string {
  if (!block.sampleBlocked && !block.levelBlocked) return '放行对账通过：样品达标且水位高于安全线';
  const parts: string[] = [];
  if (block.sampleBlocked) parts.push(`样品挡住：${block.sampleReason}`);
  if (block.levelBlocked) parts.push(`水位挡住：${block.levelReason}`);
  return parts.join('；');
}

/** v3 升级时退回原因落库（与 BASIS_ROLLBACK_REASON 同源，接受更宽的状态集合） */
export function rollbackReasonFor(status: BasisStatus): string {
  switch (status) {
    case 'revoked':
      return BASIS_ROLLBACK_REASON.revoked;
    case 'changed-to-fail':
      return BASIS_ROLLBACK_REASON['changed-to-fail'];
    case 'superseded-fail':
      return BASIS_ROLLBACK_REASON['superseded-fail'];
    case 'superseded-pass':
      return BASIS_ROLLBACK_REASON['superseded-pass'];
    default:
      return '放行依据已失效，需调度员重新对账';
  }
}

/**
 * v3 升级：为没有放行依据的历史编排按池补归属。
 * 只回填最新一条有效判定为「达标」的分析单；不改动历史状态与 orderIndex。
 */
export function attachLegacyBasis(schedule: Schedule, pondAssays: Assay[]): Partial<Schedule> | null {
  if (schedule.basisAssayId !== null && schedule.basisAssayId !== undefined) return null;
  const latest = latestAssayOf(pondAssays);
  if (latest === null || effectiveVerdict(latest) !== '达标') return null;
  return {
    basisAssayId: latest.id,
    basisAssayDate: latest.date,
    basisVerdict: '达标',
  };
}
