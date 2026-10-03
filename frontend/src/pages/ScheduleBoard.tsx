/**
 * /schedules 走水与出卤编排
 * 调度室在此放行（待排/待复核 → 已排）：与化验室当下有效的达标结论对账，
 * 且池水位不低于安全线；样品、水位两道闸分别提示。化验室改判/撤单后已放行
 * 计划自动退回「待复核」。化验室角色下本页只读，不能放行、编辑或排序。
 * 消费模型：Schedule、Assay、Observation；复用组件：<FilterBar>、<EmptyPanel>、<StatBadge>
 */
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import AppDialog from '../components/common/AppDialog';
import EmptyPanel from '../components/common/EmptyPanel';
import FilterBar from '../components/common/FilterBar';
import StatBadge from '../components/common/StatBadge';
import StageTag from '../components/common/StageTag';
import { usePondStore } from '../stores/pondStore';
import { useRoleStore } from '../stores/roleStore';
import { useScheduleStore } from '../stores/scheduleStore';
import { SCHEDULE_STATE_OPTIONS, type Schedule, type ScheduleDraft, type ScheduleState } from '../types/schedule';
import { effectiveVerdict } from '../utils/brine';
import {
  RECHECK_REASON_HINTS,
  SAFE_LEVEL_CM,
  describeReleaseBlocks,
  evaluateReleaseGate,
  sortAssaysByDate,
} from '../utils/reconcile';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-1.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const STATE_STYLE: Record<ScheduleState, string> = {
  待排: 'border-slate-300 bg-slate-100 text-slate-600',
  待复核: 'border-rose-300 bg-rose-50 text-rose-700',
  已排: 'border-sky-300 bg-sky-50 text-sky-700',
  走水中: 'border-amber-300 bg-amber-50 text-amber-700',
  已出卤: 'border-emerald-300 bg-emerald-50 text-emerald-700',
};

function emptyDraft(pondId: string, orderIndex: number): ScheduleDraft {
  return {
    pondId,
    planDate: today(),
    targetDensity: 1.15,
    volumeM3: 800,
    operator: '',
    orderIndex,
  };
}

export default function ScheduleBoard() {
  const pondStore = usePondStore();
  const scheduleStore = useScheduleStore();
  const roleStore = useRoleStore();

  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal<Schedule | null>(null);
  const [dragOverId, setDragOverId] = createSignal<string | null>(null);
  const [draft, setDraft] = createStore<ScheduleDraft>(emptyDraft('', 1));

  const canEdit = (): boolean => roleStore.role() === '调度室';

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  const ordered = createMemo<Schedule[]>(() =>
    [...scheduleStore.state.rows].sort((a, b) => a.orderIndex - b.orderIndex || a.planDate.localeCompare(b.planDate)),
  );

  const filtered = createMemo<Schedule[]>(() => {
    const current = scheduleStore.filters();
    const series = pondStore.state.currentSeries;
    const keyword = current.keyword.trim().toLowerCase();
    return ordered().filter((row) => {
      const pond = pondOf(row.pondId);
      if (series !== null && pond?.seriesName !== series) return false;
      if (current.state !== 'all' && row.state !== current.state) return false;
      if (keyword === '') return true;
      return (
        pondLabel(row.pondId).toLowerCase().includes(keyword) ||
        row.operator.toLowerCase().includes(keyword) ||
        row.planDate.includes(keyword)
      );
    });
  });

  const stats = createMemo(() => {
    const list = ordered();
    return {
      total: list.length,
      pending: list.filter((row) => row.state === '待排').length,
      recheck: list.filter((row) => row.state === '待复核').length,
      running: list.filter((row) => row.state === '走水中').length,
      done: list.filter((row) => row.state === '已出卤').length,
      volume: Math.round(list.reduce((acc, row) => acc + row.volumeM3, 0) * 10) / 10,
      donePct: list.length === 0 ? 0 : Math.round((list.filter((row) => row.state === '已出卤').length / list.length) * 1000) / 10,
    };
  });

  /** 该池按日期排序后的全部分析单（最后一条即当下有效） */
  const assaysOfPond = (pondId: string) => sortAssaysByDate(pondStore.state.assays.filter((item) => item.pondId === pondId));
  const latestAssay = (pondId: string) => {
    const list = assaysOfPond(pondId);
    return list.length > 0 ? list[list.length - 1] : null;
  };

  /** 放行闸现场：样品结论与水位分别判定，用于按钮禁用与行内提示 */
  const gateOf = (row: Schedule) =>
    evaluateReleaseGate(row.pondId, pondStore.state.assays, pondStore.state.observations);

  const openCreate = (): void => {
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    setDraft(emptyDraft(pondId, ordered().length + 1));
    setDialogOpen(true);
  };

  const openEdit = (row: Schedule): void => {
    setEditingId(row.id);
    setDraft({
      pondId: row.pondId,
      planDate: row.planDate,
      targetDensity: row.targetDensity,
      volumeM3: row.volumeM3,
      operator: row.operator,
      orderIndex: row.orderIndex,
    });
    setDialogOpen(true);
  };

  const submit = async (): Promise<void> => {
    if (draft.pondId === '') {
      scheduleStore.setMessage('请选择蒸发池');
      return;
    }
    if (editingId() === null) {
      const row = await scheduleStore.createSchedule({ ...draft });
      scheduleStore.setMessage(`已新建走水计划：${row.planDate}，目标密度 ${row.targetDensity} g/cm³（待排，等化验达标后放行）`);
    } else {
      await scheduleStore.updateSchedule(editingId() as string, { ...draft });
    }
    setDialogOpen(false);
  };

  const confirmDelete = async (): Promise<void> => {
    const row = deleting();
    if (row === null) return;
    await scheduleStore.deleteSchedule(row.id);
    setDeleting(null);
  };

  const handleDrop = async (targetId: string): Promise<void> => {
    const fromId = scheduleStore.draggingId();
    setDragOverId(null);
    scheduleStore.setDraggingId(null);
    if (fromId === null || fromId === targetId) return;
    await scheduleStore.moveBefore(fromId, targetId);
  };

  /** 动作按钮文案 */
  const nextStateLabel = (state: ScheduleState): string => {
    if (state === '待排') return '放行';
    if (state === '待复核') return '重新确认';
    if (state === '已排') return '开始走水';
    if (state === '走水中') return '完成出卤';
    return '已出卤';
  };

  /** 放行 / 推进：失败时把样品/水位拦截原因写到顶部消息，行内也同步展示 */
  const handleAdvance = async (row: Schedule): Promise<void> => {
    const result = await scheduleStore.advance(row.id);
    if (!result.ok && result.message !== '') scheduleStore.setMessage(result.message);
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="走水计划" value={stats().total} suffix="条" tone="primary" />
        <StatBadge label="待排" value={stats().pending} suffix="条" tone="default" />
        <StatBadge
          label="待复核"
          value={stats().recheck}
          suffix="条"
          tone="danger"
          hint="化验室改判或撤单后退回，需调度员重新确认"
        />
        <StatBadge label="走水中" value={stats().running} suffix="条" tone="warning" />
        <StatBadge label="已出卤" value={stats().done} suffix="条" tone="success" />
        <StatBadge label="计划总量" value={stats().volume} suffix="m³" tone="info" />
        <StatBadge label="出卤完成率" value={`${stats().donePct}%`} percent={stats().donePct} tone="success" />
      </div>

      <Show when={!canEdit()}>
        <div class="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2 text-sm text-amber-800">
          当前为「化验室」角色：走水编排只读，不能放行、推进、编辑或调整先后顺序；请到「离子组分」页登记水样分析单。
        </div>
      </Show>

      <Show when={scheduleStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {scheduleStore.state.lastMessage}
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-[15px] font-semibold text-slate-800">走水与出卤编排</h2>
            <p class="mt-0.5 text-xs text-slate-500">
              放行须对账化验室当下有效的达标结论，且最近水位 ≥ 安全线 {SAFE_LEVEL_CM} cm；任一不满足都会拦下并分别提示。
            </p>
          </div>
          <Show when={canEdit()}>
            <button type="button" class={BTN_PRIMARY} onClick={openCreate} disabled={pondStore.state.ponds.length === 0}>
              + 新建走水计划
            </button>
          </Show>
        </header>

        <FilterBar
          keyword={scheduleStore.filters().keyword}
          onKeyword={(value) => scheduleStore.patchFilters({ keyword: value })}
          fields={[
            { key: 'series', label: '池系', options: pondStore.seriesOptions() },
            { key: 'state', label: '状态', options: [...SCHEDULE_STATE_OPTIONS] },
          ]}
          values={{ series: pondStore.state.currentSeries ?? 'all', state: scheduleStore.filters().state }}
          onChange={(key, value) => {
            if (key === 'series') pondStore.setCurrentSeries(value === 'all' ? null : value);
            if (key === 'state') scheduleStore.patchFilters({ state: value as ScheduleState | 'all' });
          }}
          onReset={() => {
            scheduleStore.resetFilters();
            pondStore.setCurrentSeries(pondStore.seriesOptions()[0] ?? null);
          }}
          resultText={`命中 ${filtered().length} / ${ordered().length} 条`}
        />

        <Show when={ordered().length === 0}>
          <EmptyPanel
            title="还没有走水编排"
            description="为蒸发池编排走水日期、目标密度与计划量；放行时与化验室当下有效的达标结论对账并检查水位安全线，拖拽列表可调整先后顺序。"
            actionText={canEdit() ? '新建第一条走水计划' : ''}
            onAction={canEdit() ? openCreate : undefined}
          />
        </Show>

        <Show when={ordered().length > 0}>
          <ul class="space-y-2">
            <For each={filtered()}>
              {(row, index) => {
                const gate = (): ReturnType<typeof gateOf> => gateOf(row);
                const assayNow = (): ReturnType<typeof latestAssay> => latestAssay(row.pondId);
                const verdictNow = (): string => {
                  const current = assayNow();
                  return current === null ? '未化验' : effectiveVerdict(current);
                };
                const isReleaseStep = (): boolean => row.state === '待排' || row.state === '待复核';
                const releaseBlocked = (): boolean => isReleaseStep() && !gate().passable;
                return (
                  <li
                    draggable={canEdit()}
                    class={`flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3.5 py-3 transition ${
                      dragOverId() === row.id ? 'border-brine-500 ring-1 ring-brine-400' : 'border-slate-200'
                    } ${row.state === '待复核' ? 'bg-rose-50/40' : ''} ${canEdit() ? '' : 'cursor-default'}`}
                    onDragStart={() => canEdit() && scheduleStore.setDraggingId(row.id)}
                    onDragOver={(event) => {
                      if (!canEdit()) return;
                      event.preventDefault();
                      setDragOverId(row.id);
                    }}
                    onDragLeave={() => setDragOverId(null)}
                    onDrop={(event) => {
                      if (!canEdit()) return;
                      event.preventDefault();
                      void handleDrop(row.id);
                    }}
                  >
                    <span class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">
                      {index() + 1}
                    </span>
                    <Show when={canEdit()}>
                      <span class="cursor-grab text-slate-300" title="按住拖拽调整顺序">
                        ⠿
                      </span>
                    </Show>
                    <div class="min-w-[180px] flex-1">
                      <p class="text-sm font-medium text-slate-800">{pondLabel(row.pondId)}</p>
                      <p class="text-xs text-slate-500">
                        计划日期 {row.planDate} · 调度员 {row.operator === '' ? '未填写' : row.operator}
                      </p>
                      <Show when={row.state === '待复核'}>
                        <p class="mt-0.5 text-xs font-medium text-rose-700">
                          待复核（{row.recheckReason ?? '改判'}）：{RECHECK_REASON_HINTS[row.recheckReason ?? '改判']}
                          <Show when={row.releaseBasis !== null}>
                            ，原依据 {row.releaseBasis?.assayDate} 达标单
                          </Show>
                        </p>
                      </Show>
                      <Show when={row.releaseBasis !== null && row.state !== '待复核'}>
                        <p class="mt-0.5 text-[11px] text-slate-400">
                          放行依据：{row.releaseBasis?.assayDate} 分析单 · 结论快照「{row.releaseBasis?.verdictSnapshot}」
                        </p>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2">
                      <StageTag stage={pondOf(row.pondId)?.stage ?? null} size="sm" />
                    </div>
                    <div class="text-xs text-slate-600">
                      <p>
                        目标密度 <span class="tabular-nums font-medium text-slate-800">{row.targetDensity}</span> g/cm³
                      </p>
                      <p>
                        当前密度{' '}
                        <span class="tabular-nums font-medium text-brine-700">
                          {pondStore.statOf(row.pondId).currentDensity || '—'}
                        </span>
                      </p>
                    </div>
                    <div class="text-xs text-slate-600">
                      <p>
                        计划量 <span class="tabular-nums font-medium text-slate-800">{row.volumeM3}</span> m³
                      </p>
                      <p>
                        最近水位{' '}
                        <span
                          class={`tabular-nums font-medium ${
                            pondStore.statOf(row.pondId).latestLevelCm < SAFE_LEVEL_CM ? 'text-rose-600' : 'text-emerald-700'
                          }`}
                        >
                          {pondStore.statOf(row.pondId).lastObservationDate === ''
                            ? '无观测'
                            : `${pondStore.statOf(row.pondId).latestLevelCm} cm`}
                        </span>
                        <span class="text-slate-400">（安全线 {SAFE_LEVEL_CM} cm）</span>
                      </p>
                    </div>
                    <div class="text-xs text-slate-600">
                      <p>
                        当下有效结论{' '}
                        <span
                          class={`font-medium ${
                            verdictNow() === '达标' ? 'text-emerald-700' : verdictNow() === '未化验' ? 'text-slate-500' : 'text-rose-600'
                          }`}
                        >
                          {verdictNow()}
                        </span>
                        <Show when={assayNow() !== null}>
                          <span class="text-slate-400">（{assayNow()?.date}）</span>
                        </Show>
                      </p>
                      <Show when={isReleaseStep() && !gate().passable}>
                        <p class="mt-0.5 max-w-[240px] leading-snug text-rose-600">{describeReleaseBlocks(gate().blocks)}</p>
                      </Show>
                    </div>
                    <span class={`rounded border px-2 py-0.5 text-[11px] ${STATE_STYLE[row.state]}`}>{row.state}</span>
                    <div class="flex flex-wrap items-center gap-2">
                      <Show when={canEdit()}>
                        <button
                          class="rounded-md border border-brine-300 bg-brine-50 px-2.5 py-1 text-xs text-brine-700 transition hover:bg-brine-100 disabled:cursor-not-allowed disabled:opacity-50"
                          disabled={row.state === '已出卤' || releaseBlocked()}
                          title={releaseBlocked() ? describeReleaseBlocks(gate().blocks) : undefined}
                          onClick={() => void handleAdvance(row)}
                        >
                          {nextStateLabel(row.state)}
                        </button>
                        <button class="text-xs text-brine-700 hover:underline" onClick={() => openEdit(row)}>
                          编辑
                        </button>
                        <button class="text-xs text-rose-600 hover:underline" onClick={() => setDeleting(row)}>
                          删除
                        </button>
                      </Show>
                    </div>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>

        <Show when={ordered().length > 0 && filtered().length === 0}>
          <EmptyPanel
            title="没有符合筛选条件的走水计划"
            description="可以切换池系或状态筛选条件，或直接重置筛选。"
            actionText="重置筛选"
            onAction={() => scheduleStore.resetFilters()}
          />
        </Show>
      </section>

      <AppDialog
        open={dialogOpen()}
        title={editingId() === null ? '新建走水计划' : '编辑走水计划'}
        onClose={() => setDialogOpen(false)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDialogOpen(false)}>
              取消
            </button>
            <button class={BTN_PRIMARY} onClick={() => void submit()}>
              保存
            </button>
          </>
        }
      >
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>蒸发池</span>
            <select class={INPUT} value={draft.pondId} onChange={(event) => setDraft('pondId', event.currentTarget.value)}>
              <option value="">请选择</option>
              <For each={pondStore.state.ponds}>
                {(pond) => (
                  <option value={pond.id}>
                    {pond.code} · {pond.seriesName} · {pond.stage}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划走水日期</span>
            <input type="date" class={INPUT} value={draft.planDate} onInput={(event) => setDraft('planDate', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>目标密度（g/cm³）</span>
            <input
              type="number"
              step="0.001"
              class={INPUT}
              value={draft.targetDensity}
              onInput={(event) => setDraft('targetDensity', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>计划量（m³）</span>
            <input
              type="number"
              step="10"
              class={INPUT}
              value={draft.volumeM3}
              onInput={(event) => setDraft('volumeM3', Number(event.currentTarget.value))}
            />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>调度员</span>
            <input class={INPUT} value={draft.operator} onInput={(event) => setDraft('operator', event.currentTarget.value)} />
          </label>
          <label class="flex flex-col gap-1 text-[13px] text-slate-600">
            <span>排序序号（越小越先走水）</span>
            <input
              type="number"
              min="1"
              step="1"
              class={INPUT}
              value={draft.orderIndex}
              onInput={(event) => setDraft('orderIndex', Number(event.currentTarget.value))}
            />
          </label>
        </div>
        <p class="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-500">
          新建计划一律为「待排」，状态只能通过放行/推进动作改变。放行时须与化验室当下有效的达标结论对账、且水位不低于安全线 {SAFE_LEVEL_CM} cm；化验室事后改判或撤单，已放行计划会退回「待复核」。推进到「已出卤」时会把该池推进到下一蒸发阶段，并把最新观测密度回写为实际密度。
        </p>
      </AppDialog>

      <AppDialog
        open={deleting() !== null}
        title="确认删除走水计划？"
        width="max-w-lg"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button class={BTN_GHOST} onClick={() => setDeleting(null)}>
              取消
            </button>
            <button class={BTN_DANGER} onClick={() => void confirmDelete()}>
              确认删除
            </button>
          </>
        }
      >
        <p class="text-sm leading-relaxed text-slate-600">
          将删除「{pondLabel(deleting()?.pondId ?? '')}」在 {deleting()?.planDate} 的走水计划。
        </p>
      </AppDialog>
    </div>
  );
}
