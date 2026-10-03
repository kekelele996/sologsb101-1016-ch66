/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbbrinepond
 * - v1：建立全部表与 pondId+date 复合索引
 * - v2：新增 evapMm 字段并写入升级迁移逻辑，旧记录自动补齐默认值
 * - v3：走水编排接入化验室对账：新增放行依据（basisAssayId 等），
 *   历史编排按池补归属；化验改判 / 撤单 / 新结论顶替自动退回「待复核」。
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie';
import type { Pond } from '../types/pond';
import type { Gate } from '../types/gate';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule, ScheduleState } from '../types/schedule';
import { estimateEvapMm, effectiveVerdict } from './brine';
import {
  attachLegacyBasis,
  checkReleaseGate,
  evaluateBasis,
  rollbackReasonFor,
  shouldRollback,
  type GateBlock,
} from './release';
import { nowIso } from './id';
import { seedDatabase } from './seed';

/** 数据库名 */
export const DB_NAME = 'gbbrinepond';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3;

/** 数据行结构修订号 */
export const ROW_REVISION = 3;

class BrinePondDatabase extends Dexie {
  ponds!: Table<Pond, string>;
  gates!: Table<Gate, string>;
  observations!: Table<Observation, string>;
  assays!: Table<Assay, string>;
  schedules!: Table<Schedule, string>;

  constructor() {
    super(DB_NAME);

    // ---------- v1：建立全部表与 pondId+date 复合索引 ----------
    this.version(1).stores({
      ponds: 'id, code, seriesName, stage, status, createdAt',
      gates: 'id, fromPondId, toPondId, state',
      observations: 'id, pondId, date, [pondId+date], densityGcm3',
      assays: 'id, pondId, date, [pondId+date], verdict',
      schedules: 'id, pondId, planDate, state, orderIndex',
    });

    // ---------- v2：新增 evapMm 字段，并为旧记录补齐默认值 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('ponds'),
          tx.table('gates'),
          tx.table('observations'),
          tx.table('assays'),
          tx.table('schedules'),
        ];
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION;
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso();
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt;
          });
        }
        // 迁移 2：卤水观测新增 evapMm，旧记录按密度/温度/水位/风力经验公式补齐
        await tx.table('observations').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.evapMm === 'number' && Number.isFinite(row.evapMm)) return;
          row.evapMm = estimateEvapMm(
            typeof row.densityGcm3 === 'number' ? row.densityGcm3 : 1.02,
            typeof row.tempC === 'number' ? row.tempC : 25,
            typeof row.levelCm === 'number' ? row.levelCm : 40,
            typeof row.windLevel === 'number' ? row.windLevel : 2,
          );
        });
        // 迁移 3：化验记录补齐人工覆盖标记
        await tx.table('assays').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.verdictManual !== 'boolean') row.verdictManual = false;
        });
        // 迁移 4：走水编排补齐排序序号（按计划日期兜底生成）
        await tx.table('schedules').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.orderIndex !== 'number') {
            const date = typeof row.planDate === 'string' ? row.planDate : '2026-01-01';
            row.orderIndex = Number(date.replace(/-/g, '')) || 1;
          }
        });
      });

    // ---------- v3：走水放行接入化验室对账 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        ponds: 'id, code, seriesName, stage, status, createdAt, updatedAt',
        gates: 'id, fromPondId, toPondId, state, openingPct',
        observations: 'id, pondId, date, [pondId+date], densityGcm3, evapMm',
        assays: 'id, pondId, date, [pondId+date], verdict, verdictManual',
        schedules: 'id, pondId, planDate, state, orderIndex, basisAssayId, resumeState',
      })
      .upgrade(async (tx) => {
        // 历史走水编排没有放行依据：按池补归属最新一条达标分析单；
        // 历史顺序（orderIndex）与状态（state）原样保留，补不到依据也不强行造单。
        const allAssays = await tx.table<Assay, string>('assays').toArray();
        const assaysByPond = new Map<string, Assay[]>();
        allAssays.forEach((item) => {
          const list = assaysByPond.get(item.pondId) ?? [];
          list.push(item);
          assaysByPond.set(item.pondId, list);
        });
        await tx.table('schedules').toCollection().modify((row: Schedule) => {
          // 只对没有放行依据的历史行补归属；已有依据（重复升级）保持不动。
          if (row.basisAssayId === undefined || row.basisAssayId === null) {
            const patch = attachLegacyBasis(row, assaysByPond.get(row.pondId) ?? []);
            if (patch !== null) Object.assign(row, patch);
          }
          // IndexedDB 不存 undefined：补不到依据也要显式落 null，保证读回类型稳定。
          if (row.basisAssayId === undefined) row.basisAssayId = null;
          if (row.basisAssayDate === undefined) row.basisAssayDate = null;
          if (row.basisVerdict === undefined) row.basisVerdict = null;
          if (row.releasedAt === undefined) row.releasedAt = null;
          if (row.resumeState === undefined) row.resumeState = null;
          if (row.rollbackReason === undefined) row.rollbackReason = null;
          row.updatedAt = nowIso();
        });
      });
  }
}

export const db = new BrinePondDatabase();

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null;

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open();
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.ponds.count()) === 0) {
        await seedDatabase();
      }
    })();
  }
  return initPromise;
}

/* -------------------------------- 蒸发池 -------------------------------- */

export async function listPonds(): Promise<Pond[]> {
  const rows = await db.ponds.toArray();
  return rows.sort((a, b) => a.seriesName.localeCompare(b.seriesName, 'zh-Hans-CN') || a.code.localeCompare(b.code));
}

export async function putPond(row: Pond): Promise<void> {
  await db.ponds.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 删除蒸发池，并级联清理相关闸门、观测、化验与走水计划 */
export async function removePond(id: string): Promise<void> {
  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    const gates = await db.gates.toArray();
    const related = gates.filter((gate) => gate.fromPondId === id || gate.toPondId === id).map((gate) => gate.id);
    if (related.length > 0) await db.gates.bulkDelete(related);
    await db.observations.where('pondId').equals(id).delete();
    await db.assays.where('pondId').equals(id).delete();
    await db.schedules.where('pondId').equals(id).delete();
    await db.ponds.delete(id);
  });
}

/* -------------------------------- 闸门 -------------------------------- */

export async function listGates(): Promise<Gate[]> {
  return db.gates.toArray();
}

export async function putGate(row: Gate): Promise<void> {
  await db.gates.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

/** 就地调整开度：同步推导闸门状态 */
export async function updateGateOpening(id: string, openingPct: number, state: Gate['state']): Promise<void> {
  await db.gates.update(id, { openingPct, state, updatedAt: nowIso() });
}

export async function removeGate(id: string): Promise<void> {
  await db.gates.delete(id);
}

/* ------------------------------ 卤水日观测 ------------------------------ */

export async function listObservations(): Promise<Observation[]> {
  const rows = await db.observations.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listObservationsByPond(pondId: string): Promise<Observation[]> {
  const rows = await db.observations.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 写入卤水日观测：同池同日仅保留一条（存在即覆盖原记录）。
 * evapMm 若未显式给出，则按经验公式自动估算。
 */
export async function upsertObservation(row: Observation): Promise<Observation> {
  const evapMm =
    Number.isFinite(row.evapMm) && row.evapMm > 0
      ? row.evapMm
      : estimateEvapMm(row.densityGcm3, row.tempC, row.levelCm, row.windLevel);
  const existing = await db.observations.where('[pondId+date]').equals([row.pondId, row.date]).first();
  const next: Observation = {
    ...row,
    id: existing === undefined ? row.id : existing.id,
    evapMm,
    createdAt: existing === undefined ? row.createdAt : existing.createdAt,
    updatedAt: nowIso(),
    revision: ROW_REVISION,
  };
  await db.observations.put(next);
  return next;
}

export async function removeObservation(id: string): Promise<void> {
  await db.observations.delete(id);
}

/* ------------------------------ 离子组分分析 ------------------------------ */

export async function listAssays(): Promise<Assay[]> {
  const rows = await db.assays.toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function listAssaysByPond(pondId: string): Promise<Assay[]> {
  const rows = await db.assays.where('pondId').equals(pondId).toArray();
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export async function putAssay(row: Assay): Promise<void> {
  await db.transaction('rw', db.assays, db.schedules, async () => {
    await db.assays.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
    await reconcilePondSchedules(row.pondId);
  });
}

export async function removeAssay(id: string): Promise<void> {
  await db.transaction('rw', db.assays, db.schedules, async () => {
    const assay = await db.assays.get(id);
    await db.assays.delete(id);
    // 撤单后再对账：依据消失（revoked）或最新结论变化都会退回「待复核」
    if (assay !== undefined) await reconcilePondSchedules(assay.pondId);
  });
}

/* ------------------------------ 走水放行对账 ------------------------------ */

/**
 * 化验室结论变更后对账同一池的在途走水编排：
 * 放行依据被撤销 / 改回未达标 / 被更新的结论顶替时，退回「待复核」，
 * 记住退回前状态（resumeState），不动 orderIndex；「已出卤」为历史事实，不退回。
 * 返回被退回的编排条数。
 */
async function reconcilePondSchedules(pondId: string): Promise<number> {
  const [assays, schedules] = await Promise.all([
    db.assays.where('pondId').equals(pondId).toArray(),
    db.schedules.where('pondId').equals(pondId).toArray(),
  ]);
  let rolled = 0;
  const stamp = nowIso();
  for (const schedule of schedules) {
    if (schedule.state === '已出卤' || schedule.state === '待复核') continue;
    const evaluation = evaluateBasis(schedule, assays);
    if (!shouldRollback(evaluation.status)) continue;
    await db.schedules.update(schedule.id, {
      state: '待复核' as ScheduleState,
      resumeState: schedule.state,
      rollbackReason: rollbackReasonFor(evaluation.status),
      updatedAt: stamp,
    });
    rolled += 1;
  }
  return rolled;
}

/** 化验室写入 / 撤单后，返回该池被退回「待复核」的编排条数（供页面提示） */
export async function reconcileResult(pondId: string): Promise<number> {
  return db.schedules.where('pondId').equals(pondId).and((row) => row.state === '待复核').count();
}

/** 取该池最新一条观测（水位 / 密度） */
async function latestObservationOf(pondId: string): Promise<Observation | null> {
  const list = await db.observations.where('pondId').equals(pondId).toArray();
  if (list.length === 0) return null;
  return list.reduce((acc, item) => (item.date > acc.date ? item : acc));
}

/** 放行 / 重新确认的结果：ok=false 时 block 说明是样品还是水位挡住 */
export interface ReleaseOutcome {
  ok: boolean;
  block: GateBlock | null;
  /** ok=true 时进入的状态（放行＝走水中，重新确认＝退回前状态） */
  nextState: ScheduleState | null;
}

function fail(block: GateBlock): ReleaseOutcome {
  return { ok: false, block, nextState: null };
}

/**
 * 放行（已排 → 走水中）：必须与化验室当下有效结论对账，且水位高于安全线。
 * 通过则锁定放行依据快照；不通过原样返回阻挡原因，不写任何状态。
 */
export async function releaseSchedule(scheduleId: string): Promise<ReleaseOutcome> {
  const schedule = await db.schedules.get(scheduleId);
  if (schedule === undefined || schedule.state !== '已排') {
    return { ok: false, block: null, nextState: null };
  }
  const assays = await db.assays.where('pondId').equals(schedule.pondId).toArray();
  const latest = assays.length === 0 ? null : [...assays].sort((a, b) => a.date.localeCompare(b.date))[assays.length - 1];
  const obs = await latestObservationOf(schedule.pondId);
  const block = checkReleaseGate(latest, obs);
  if (block.sampleBlocked || block.levelBlocked || block.basisAssay === null) return fail(block);
  await db.schedules.update(scheduleId, {
    state: '走水中',
    basisAssayId: block.basisAssay.id,
    basisAssayDate: block.basisAssay.date,
    basisVerdict: '达标',
    releasedAt: nowIso(),
    resumeState: null,
    rollbackReason: null,
    updatedAt: nowIso(),
  });
  return { ok: true, block, nextState: '走水中' };
}

/**
 * 待复核 → 重新确认：调度员按化验室当下结论再对一次账（样品 + 水位），
 * 通过则回到退回前状态并刷新放行依据快照；不通过返回阻挡原因。
 */
export async function reconfirmSchedule(scheduleId: string): Promise<ReleaseOutcome> {
  const schedule = await db.schedules.get(scheduleId);
  if (schedule === undefined || schedule.state !== '待复核' || schedule.resumeState === null) {
    return { ok: false, block: null, nextState: null };
  }
  const assays = await db.assays.where('pondId').equals(schedule.pondId).toArray();
  const latest = assays.length === 0 ? null : [...assays].sort((a, b) => a.date.localeCompare(b.date))[assays.length - 1];
  const obs = await latestObservationOf(schedule.pondId);
  const block = checkReleaseGate(latest, obs);
  if (block.sampleBlocked || block.levelBlocked || block.basisAssay === null) return fail(block);
  await db.schedules.update(scheduleId, {
    state: schedule.resumeState,
    basisAssayId: block.basisAssay.id,
    basisAssayDate: block.basisAssay.date,
    basisVerdict: '达标',
    releasedAt: nowIso(),
    resumeState: null,
    rollbackReason: null,
    updatedAt: nowIso(),
  });
  return { ok: true, block, nextState: schedule.resumeState };
}

/** 完成出卤（走水中 → 已出卤）的结果：样品依据事后失效同样拦住，不能带着旧结论出卤 */
export interface DischargeOutcome extends ReleaseOutcome {
  actualDensity: number;
}

/**
 * 完成出卤：再次对账放行依据（化验室可能在走水期间撤单 / 改判）。
 * 水位安全线针对的是「放行」动作，走水已在途，出卤不重复卡水位。
 */
export async function dischargeSchedule(scheduleId: string, fallbackDensity: number): Promise<DischargeOutcome> {
  const schedule = await db.schedules.get(scheduleId);
  if (schedule === undefined || schedule.state !== '走水中') {
    return { ok: false, block: null, nextState: null, actualDensity: fallbackDensity };
  }
  const assays = await db.assays.where('pondId').equals(schedule.pondId).toArray();
  const evaluation = evaluateBasis(schedule, assays);
  if (evaluation.status !== 'ok' && evaluation.status !== 'superseded-pass') {
    // 出卤只卡样品依据（撤单 / 改回未达标 / 最新结论未达标）；水位是放行时的关口，在途不重复卡。
    const latest = evaluation.latestAssay;
    return {
      ok: false,
      block: {
        sampleBlocked: true,
        levelBlocked: false,
        sampleReason:
          latest === null
            ? '该池水样分析单已被撤销，且没有新的化验结论'
            : `化验室最新有效结论为「${effectiveVerdict(latest)}」（${latest.date}），放行依据已失效，编排需退回复核`,
        levelReason: '走水在途，水位仅在放行时校验',
        basisAssay: null,
      },
      nextState: null,
      actualDensity: fallbackDensity,
    };
  }
  const obs = await latestObservationOf(schedule.pondId);
  const actualDensity = obs !== null && obs.densityGcm3 > 0 ? obs.densityGcm3 : fallbackDensity;
  await applyDischarge(scheduleId, actualDensity);
  return { ok: true, block: null, nextState: '已出卤', actualDensity };
}

/** 无对账的简单状态推进（待排 → 已排） */
export async function markScheduleState(scheduleId: string, next: ScheduleState): Promise<void> {
  await db.schedules.update(scheduleId, { state: next, updatedAt: nowIso() });
}

/* ------------------------------ 走水编排 ------------------------------ */

export async function listSchedules(): Promise<Schedule[]> {
  const rows = await db.schedules.toArray();
  return rows.sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate));
}

export async function putSchedule(row: Schedule): Promise<void> {
  await db.schedules.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION });
}

export async function removeSchedule(id: string): Promise<void> {
  await db.schedules.delete(id);
}

/** 按给定 id 顺序重写排序序号（拖拽排序后调用） */
export async function reorderSchedules(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.schedules, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.schedules.update(orderedIds[index], { orderIndex: index + 1, updatedAt: nowIso() });
    }
  });
}

/**
 * 出卤完成回写：把蒸发池推进到下一阶段，并把最新一次观测的密度对齐到实际密度。
 */
export async function applyDischarge(scheduleId: string, actualDensity: number): Promise<void> {
  await db.transaction('rw', db.ponds, db.schedules, db.observations, async () => {
    const schedule = await db.schedules.get(scheduleId);
    if (!schedule) return;
    await db.schedules.update(scheduleId, { state: '已出卤', updatedAt: nowIso() });
    const pond = await db.ponds.get(schedule.pondId);
    if (!pond) return;
    const nextStage: Pond['stage'] = pond.stage === '钠盐' ? '钾盐' : pond.stage === '钾盐' ? '锂盐' : '锂盐';
    await db.ponds.update(pond.id, { stage: nextStage, updatedAt: nowIso() });
    const list = await db.observations.where('pondId').equals(pond.id).toArray();
    if (list.length === 0) return;
    const latest = list.reduce((acc, item) => (item.date > acc.date ? item : acc));
    const density = actualDensity > 0 ? actualDensity : latest.densityGcm3;
    await db.observations.update(latest.id, {
      densityGcm3: density,
      evapMm: estimateEvapMm(density, latest.tempC, latest.levelCm, latest.windLevel),
      updatedAt: nowIso(),
    });
  });
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  ponds: Pond[];
  gates: Gate[];
  observations: Observation[];
  assays: Assay[];
  schedules: Schedule[];
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [ponds, gates, observations, assays, schedules] = await Promise.all([
    db.ponds.toArray(),
    db.gates.toArray(),
    db.observations.toArray(),
    db.assays.toArray(),
    db.schedules.toArray(),
  ]);
  return { name: DB_NAME, schemaVersion: DB_SCHEMA_VERSION, exportedAt: nowIso(), ponds, gates, observations, assays, schedules };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    await Promise.all([
      db.ponds.clear(),
      db.gates.clear(),
      db.observations.clear(),
      db.assays.clear(),
      db.schedules.clear(),
    ]);
    await db.ponds.bulkPut(snapshot.ponds.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.gates.bulkPut(snapshot.gates.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.observations.bulkPut(snapshot.observations.map((row) => ({ ...row, revision: ROW_REVISION })));
    await db.assays.bulkPut(snapshot.assays.map((row) => ({ ...row, revision: ROW_REVISION })));
    // 老存档（v2 及以前）的走水编排没有放行依据，导入时按池补归属，历史状态 / 顺序不动。
    const schedules = snapshot.schedules.map((row) => normalizeSchedule(row, snapshot.assays));
    await db.schedules.bulkPut(schedules.map((row) => ({ ...row, revision: ROW_REVISION })));
  });
}

/** 补齐历史走水编排缺失的对账字段（升级迁移与存档导入共用口径） */
function normalizeSchedule(row: Schedule, allAssays: Assay[]): Schedule {
  const base: Schedule = {
    ...row,
    basisAssayId: row.basisAssayId ?? null,
    basisAssayDate: row.basisAssayDate ?? null,
    basisVerdict: row.basisVerdict ?? null,
    releasedAt: row.releasedAt ?? null,
    resumeState: row.resumeState ?? null,
    rollbackReason: row.rollbackReason ?? null,
  };
  if (base.basisAssayId !== null) return base;
  const patch = attachLegacyBasis(base, allAssays.filter((item) => item.pondId === base.pondId));
  return patch === null ? base : { ...base, ...patch };
}

export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', db.ponds, db.gates, db.observations, db.assays, db.schedules, async () => {
    await Promise.all([
      db.ponds.clear(),
      db.gates.clear(),
      db.observations.clear(),
      db.assays.clear(),
      db.schedules.clear(),
    ]);
  });
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [ponds, gates, observations, assays, schedules] = await Promise.all([
    db.ponds.count(),
    db.gates.count(),
    db.observations.count(),
    db.assays.count(),
    db.schedules.count(),
  ]);
  return { ponds, gates, observations, assays, schedules };
}
