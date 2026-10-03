/**
 * 走水编排状态管理（Solid 原生能力）
 * 用 createStore 维护走水顺序与状态推进；放行（待排/待复核 → 已排）必须与
 * 化验室当下有效的达标结论对账且水位不低于安全线；化验室改判/撤单后已放行
 * 计划自动退回「待复核」；出卤完成后回写池阶段与实际密度。
 */
import { createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { ReleaseBasis, Schedule, ScheduleDraft, ScheduleState } from '../types/schedule';
import {
  advanceScheduleState,
  db,
  initDatabase,
  putSchedule,
  releaseSchedule,
  removeSchedule,
  reorderSchedules,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';
import { effectiveVerdict } from '../utils/brine';
import {
  SAFE_LEVEL_CM,
  describeReleaseBlocks,
  evaluateReleaseGate,
  latestAssayOf,
  type ReleaseGateResult,
} from '../utils/reconcile';
import { usePondStore } from './pondStore';

/** 走水编排筛选条件 */
export interface ScheduleFilters {
  keyword: string;
  seriesName: string | 'all';
  state: ScheduleState | 'all';
}

const EMPTY_FILTERS: ScheduleFilters = { keyword: '', seriesName: 'all', state: 'all' };

interface ScheduleState_ {
  rows: Schedule[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

/** 放行 / 推进动作的结果，gate 携带样品闸 / 水位闸现场，供页面分清拦截来源 */
export interface AdvanceResult {
  ok: boolean;
  next: ScheduleState | null;
  message: string;
  gate?: ReleaseGateResult;
}

function createScheduleStore() {
  const [state, setState] = createStore<ScheduleState_>({
    rows: [],
    loading: true,
    error: '',
    lastMessage: '',
  });
  const [filters, setFilters] = createSignal<ScheduleFilters>({ ...EMPTY_FILTERS });
  const [draggingId, setDraggingId] = createSignal<string | null>(null);

  // 同 observationStore：建库必须放在 querier 外，否则 liveQuery 采集不到可观测性集合，
  // 数据库变更后不会重查 —— 走水计划条数与拖拽后的顺序都不会原地刷新。
  void initDatabase();

  liveQuery(async () => {
    return db.schedules.toArray();
  }).subscribe({
    next: (list) => {
      setState('rows', [...list].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)));
      setState('loading', false);
      setState('error', '');
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取走水编排失败' });
    },
  });

  function patchFilters(patch: Partial<ScheduleFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  async function createSchedule(draft: ScheduleDraft): Promise<Schedule> {
    const stamp = nowIso();
    // 新建只能落在「待排」，放行依据为空；状态推进只能走放行/推进动作
    const row: Schedule = {
      id: uuid('schedule'),
      pondId: draft.pondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: '待排',
      orderIndex: draft.orderIndex,
      releaseBasis: null,
      recheckReason: null,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putSchedule(row);
    setState('lastMessage', `已新建走水计划：${row.planDate}（待排，等化验达标后放行）`);
    return row;
  }

  async function updateSchedule(scheduleId: string, draft: ScheduleDraft): Promise<void> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return;
    // 调度室在表单里改不了状态/放行依据：保留既有 state、releaseBasis、recheckReason
    await putSchedule({
      ...existing,
      pondId: draft.pondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      orderIndex: draft.orderIndex,
    });
    setState('lastMessage', '走水计划已更新');
  }

  async function deleteSchedule(scheduleId: string): Promise<void> {
    await removeSchedule(scheduleId);
    setState('lastMessage', '走水计划已删除');
  }

  /**
   * 放行 / 推进：
   * - 待排 / 待复核 → 已排：放行双闸（当下化验结论达标 + 水位 ≥ 安全线），通过后写依据快照；
   * - 已排 → 走水中：再与当下结论对一次账（只防旧结论，水位不再挡）；
   * - 走水中 → 已出卤：回写池阶段与实际密度。
   */
  async function advance(scheduleId: string): Promise<AdvanceResult> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) {
      return { ok: false, next: null, message: '走水计划不存在' };
    }

    // 动作时直接从库里取最新化验/观测，避免用旧数据对账
    const [assays, observations] = await Promise.all([db.assays.toArray(), db.observations.toArray()]);
    const pondStore = usePondStore();

    if (existing.state === '待排' || existing.state === '待复核') {
      const gate = evaluateReleaseGate(existing.pondId, assays, observations);
      if (!gate.passable || gate.assay === null) {
        return { ok: false, next: existing.state, gate, message: describeReleaseBlocks(gate.blocks) };
      }
      const basis: ReleaseBasis = {
        assayId: gate.assay.id,
        assayDate: gate.assay.date,
        verdictSnapshot: '达标',
        releasedAt: nowIso(),
      };
      await releaseSchedule(existing.id, basis);
      const message =
        existing.state === '待复核'
          ? `已重新确认放行：对账化验室 ${gate.assay.date} 达标分析单，水位 ${gate.levelCm} cm ≥ 安全线 ${SAFE_LEVEL_CM} cm`
          : `已放行：对账化验室 ${gate.assay.date} 达标分析单，水位 ${gate.levelCm} cm ≥ 安全线 ${SAFE_LEVEL_CM} cm`;
      setState('lastMessage', message);
      return { ok: true, next: '已排', gate, message };
    }

    if (existing.state === '已排') {
      // 开始走水前再与化验室当下结论对一次账，不能带着已失效的旧结论走水
      const latest = latestAssayOf(existing.pondId, assays);
      const verdict = latest === null ? null : effectiveVerdict(latest);
      if (latest === null || verdict !== '达标') {
        const message =
          latest === null
            ? '不能开始走水：该池缺少化验室达标分析单'
            : `不能开始走水：化验室当下有效结论已为「${verdict}」（${latest.date} 分析单），请等待复核`;
        setState('lastMessage', message);
        return { ok: false, next: '已排', message };
      }
      const stat = pondStore.statOf(existing.pondId);
      const actualDensity = stat.currentDensity > 0 ? stat.currentDensity : existing.targetDensity;
      await advanceScheduleState(existing.id, '走水中', actualDensity);
      const message = '状态已推进为「走水中」（已与化验室当下达标结论对账）';
      setState('lastMessage', message);
      return { ok: true, next: '走水中', message };
    }

    if (existing.state === '走水中') {
      const stat = pondStore.statOf(existing.pondId);
      const actualDensity = stat.currentDensity > 0 ? stat.currentDensity : existing.targetDensity;
      await advanceScheduleState(existing.id, '已出卤', actualDensity);
      await pondStore.refreshCounts();
      const message = `已出卤：池阶段已推进，实际密度回写为 ${actualDensity} g/cm³`;
      setState('lastMessage', message);
      return { ok: true, next: '已出卤', message };
    }

    return { ok: false, next: existing.state, message: '该计划已处于「已出卤」状态' };
  }

  /** 拖拽排序：把 fromId 移动到 toId 之前 */
  async function moveBefore(fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return;
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const fromIndex = list.findIndex((row) => row.id === fromId);
    const toIndex = list.findIndex((row) => row.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;
    const [moved] = list.splice(fromIndex, 1);
    list.splice(toIndex, 0, moved);
    await reorderSchedules(list.map((row) => row.id));
    setState('lastMessage', `已调整走水顺序：${moved.planDate} 移动到第 ${toIndex + 1} 位`);
  }

  async function moveToIndex(id: string, targetIndex: number): Promise<void> {
    const list = [...state.rows].sort((a, b) => a.orderIndex - b.orderIndex);
    const fromIndex = list.findIndex((row) => row.id === id);
    if (fromIndex < 0) return;
    const [moved] = list.splice(fromIndex, 1);
    const index = Math.max(0, Math.min(list.length, targetIndex));
    list.splice(index, 0, moved);
    await reorderSchedules(list.map((row) => row.id));
    setState('lastMessage', `已把 ${moved.planDate} 调整到第 ${index + 1} 位`);
  }

  return {
    state,
    filters,
    patchFilters,
    resetFilters,
    draggingId,
    setDraggingId,
    setMessage,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    advance,
    moveBefore,
    moveToIndex,
  };
}

const store = createRoot(createScheduleStore);

export function useScheduleStore() {
  return store;
}
