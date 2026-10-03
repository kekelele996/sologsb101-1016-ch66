/**
 * 走水编排状态管理（Solid 原生能力）
 * 用 createStore 维护走水顺序与状态推进；放行 / 重新确认 / 完成出卤都要与
 * 化验室当下有效的达标结论对账（utils/db 的 release / discharge 系列）。
 * 化验室事后改判 / 撤单由 db 层自动把编排退回「待复核」，本 store 只读结果。
 */
import { createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { Schedule, ScheduleDraft, ScheduleState } from '../types/schedule';
import {
  db,
  dischargeSchedule,
  initDatabase,
  markScheduleState,
  putSchedule,
  reconfirmSchedule,
  releaseSchedule,
  removeSchedule,
  reorderSchedules,
  type DischargeOutcome,
  type ReleaseOutcome,
} from '../utils/db';
import { nowIso, uuid } from '../utils/id';
import { usePondStore } from './pondStore';
import { useRoleStore } from './roleStore';

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

function createScheduleStore() {
  const [state, setState] = createStore<ScheduleState_>({
    rows: [],
    loading: true,
    error: '',
    lastMessage: '',
  });
  const [filters, setFilters] = createSignal<ScheduleFilters>({ ...EMPTY_FILTERS });
  const [draggingId, setDraggingId] = createSignal<string | null>(null);

  // 建库必须放在 querier 外，否则 liveQuery 采集不到可观测性集合，
  // 数据库变更（含化验室触发的自动退回）后不会原地刷新。
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

  function requireDispatch(): boolean {
    return useRoleStore().canEditSchedule();
  }

  async function createSchedule(draft: ScheduleDraft): Promise<Schedule> {
    const stamp = nowIso();
    const row: Schedule = {
      id: uuid('schedule'),
      pondId: draft.pondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: draft.state,
      orderIndex: draft.orderIndex,
      basisAssayId: null,
      basisAssayDate: null,
      basisVerdict: null,
      releasedAt: null,
      resumeState: null,
      rollbackReason: null,
      createdAt: stamp,
      updatedAt: stamp,
      revision: 3,
    };
    await putSchedule(row);
    setState('lastMessage', `已新建走水计划：${row.planDate}`);
    return row;
  }

  async function updateSchedule(scheduleId: string, draft: ScheduleDraft): Promise<void> {
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return;
    // 改派蒸发池：原放行依据属于另一口池，必须清空；
    // 手工把状态改离「待复核」：退回痕迹作废，两条都要求重新对账放行。
    const pondChanged = existing.pondId !== draft.pondId;
    const leftReview = existing.state === '待复核' && draft.state !== '待复核';
    const basisReset =
      pondChanged || leftReview
        ? { basisAssayId: null, basisAssayDate: null, basisVerdict: null, releasedAt: null, resumeState: null, rollbackReason: null }
        : {};
    await putSchedule({
      ...existing,
      pondId: draft.pondId,
      planDate: draft.planDate,
      targetDensity: draft.targetDensity,
      volumeM3: draft.volumeM3,
      operator: draft.operator.trim(),
      state: draft.state,
      orderIndex: draft.orderIndex,
      ...basisReset,
    });
    if (pondChanged) {
      setState('lastMessage', '走水计划已更新：改派蒸发池，原放行依据已清空，需重新对账放行');
    } else if (leftReview) {
      setState('lastMessage', '走水计划已更新：已离开待复核，原退回记录作废，放行需重新与化验室对账');
    } else {
      setState('lastMessage', '走水计划已更新');
    }
  }

  async function deleteSchedule(scheduleId: string): Promise<void> {
    await removeSchedule(scheduleId);
    setState('lastMessage', '走水计划已删除');
  }

  /** 待排 → 已排：排程动作本身不需要化验依据，放行才对账 */
  async function markScheduled(scheduleId: string): Promise<boolean> {
    if (!requireDispatch()) return false;
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined || existing.state !== '待排') return false;
    await markScheduleState(scheduleId, '已排');
    setState('lastMessage', '已排入走水顺序，放行时将与化验室最新达标结论对账');
    return true;
  }

  /** 已排 → 走水中（放行）：样品达标 + 水位安全同时满足 */
  async function release(scheduleId: string): Promise<ReleaseOutcome> {
    if (!requireDispatch()) return { ok: false, block: null, nextState: null };
    const result = await releaseSchedule(scheduleId);
    if (result.ok) {
      setState('lastMessage', `放行对账通过，已开始走水（依据化验单 ${result.block?.basisAssay?.date ?? ''}）`);
    } else if (result.block !== null) {
      setState('lastMessage', describeBlock(result));
    }
    return result;
  }

  /** 待复核 → 重新确认：按化验室当下结论重新对账 */
  async function reconfirm(scheduleId: string): Promise<ReleaseOutcome> {
    if (!requireDispatch()) return { ok: false, block: null, nextState: null };
    const result = await reconfirmSchedule(scheduleId);
    if (result.ok) {
      setState('lastMessage', `已重新确认放行（依据化验单 ${result.block?.basisAssay?.date ?? ''}），编排回到「${result.nextState ?? ''}」`);
    } else if (result.block !== null) {
      setState('lastMessage', describeBlock(result));
    }
    return result;
  }

  /** 走水中 → 已出卤：再次对账，化验室走水期间撤单 / 改判同样拦住 */
  async function discharge(scheduleId: string): Promise<DischargeOutcome> {
    if (!requireDispatch()) {
      return { ok: false, block: null, nextState: null, actualDensity: 0 };
    }
    const existing = state.rows.find((row) => row.id === scheduleId);
    if (existing === undefined) return { ok: false, block: null, nextState: null, actualDensity: 0 };
    const pondStore = usePondStore();
    const stat = pondStore.statOf(existing.pondId);
    const fallback = stat.currentDensity > 0 ? stat.currentDensity : existing.targetDensity;
    const result = await dischargeSchedule(scheduleId, fallback);
    if (result.ok) {
      await pondStore.refreshCounts();
      setState('lastMessage', `已出卤：池阶段已推进，实际密度回写为 ${result.actualDensity} g/cm³`);
    } else if (result.block !== null) {
      setState('lastMessage', describeBlock(result));
    }
    return result;
  }

  /** 拖拽排序：把 fromId 移动到 toId 之前（化验室角色禁止） */
  async function moveBefore(fromId: string, toId: string): Promise<void> {
    if (!requireDispatch()) {
      setState('lastMessage', '化验室不能调整走水编排的先后顺序');
      return;
    }
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
    if (!requireDispatch()) return;
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
    markScheduled,
    release,
    reconfirm,
    discharge,
    moveBefore,
    moveToIndex,
  };
}

/** 把阻挡结果组织成「样品 / 水位」分明的提示 */
function describeBlock(result: ReleaseOutcome): string {
  const block = result.block;
  if (block === null) return '当前状态不允许该操作';
  const parts: string[] = [];
  if (block.sampleBlocked) parts.push(`样品挡住：${block.sampleReason}`);
  if (block.levelBlocked) parts.push(`水位挡住：${block.levelReason}`);
  if (parts.length === 0) return '放行对账未通过';
  return `无法放行：${parts.join('；')}`;
}

const store = createRoot(createScheduleStore);

export function useScheduleStore() {
  return store;
}
