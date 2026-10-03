/**
 * /schedules 走水与出卤编排
 * 按日期排序、拖拽调整走水先后顺序、逐条推进状态。
 * 放行（已排 → 走水中）必须与化验室当下有效达标结论对账，且水位高于安全线；
 * 化验室事后改判 / 撤单 / 新结论顶替，编排自动退回「待复核」，由调度员重新确认。
 * 化验室角色本页只读（不能新建 / 编辑 / 排序）。
 * 消费模型：Schedule、Gate、Assay、Observation；复用组件：<FilterBar>、<EmptyPanel>、<StatBadge>
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
import type { Assay } from '../types/assay';
import { SCHEDULE_STATE_OPTIONS, type Schedule, type ScheduleDraft, type ScheduleState } from '../types/schedule';
import { checkReleaseGate, evaluateBasis, gateBlockSummary, SAFE_LEVEL_CM } from '../utils/release';
import { effectiveVerdict } from '../utils/brine';
import { today } from '../utils/id';

const INPUT =
  'w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-brine-500 focus:ring-1 focus:ring-brine-400';
const BTN_PRIMARY =
  'rounded-md bg-brine-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-brine-700 disabled:opacity-50';
const BTN_GHOST =
  'rounded-md border border-slate-300 bg-white px-3.5 py-1.5 text-sm text-slate-700 transition hover:bg-slate-100';
const BTN_DANGER = 'rounded-md bg-rose-600 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-rose-700';

const STATE_STYLE: Record<ScheduleState, string> = {
  待排: 'border-slate-300 bg-slate-100 text-slate-600',
  已排: 'border-sky-300 bg-sky-50 text-sky-700',
  走水中: 'border-amber-300 bg-amber-50 text-amber-700',
  已出卤: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  待复核: 'border-rose-300 bg-rose-50 text-rose-700',
};

function emptyDraft(pondId: string, orderIndex: number): ScheduleDraft {
  return {
    pondId,
    planDate: today(),
    targetDensity: 1.15,
    volumeM3: 800,
    operator: '',
    state: '待排',
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

  onMount(() => {
    void pondStore.loadAll();
  });

  const pondOf = (pondId: string) => pondStore.state.ponds.find((pond) => pond.id === pondId) ?? null;
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === null ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  const pondAssays = (pondId: string): Assay[] =>
    pondStore.state.assays
      .filter((item) => item.pondId === pondId)
      .sort((a, b) => a.date.localeCompare(b.date) || a.updatedAt.localeCompare(b.updatedAt));

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
      running: list.filter((row) => row.state === '走水中').length,
      review: list.filter((row) => row.state === '待复核').length,
      done: list.filter((row) => row.state === '已出卤').length,
      volume: Math.round(list.reduce((acc, row) => acc + row.volumeM3, 0) * 10) / 10,
      donePct: list.length === 0 ? 0 : Math.round((list.filter((row) => row.state === '已出卤').length / list.length) * 1000) / 10,
    };
  });

  const openCreate = (): void => {
    if (!roleStore.canEditSchedule()) return;
    const pondId = pondStore.pondsOfSeries(pondStore.state.currentSeries)[0]?.id ?? pondStore.state.ponds[0]?.id ?? '';
    setEditingId(null);
    setDraft(emptyDraft(pondId, ordered().length + 1));
    setDialogOpen(true);
  };

  const openEdit = (row: Schedule): void => {
    if (!roleStore.canEditSchedule()) return;
    setEditingId(row.id);
    setDraft({
      pondId: row.pondId,
      planDate: row.planDate,
      targetDensity: row.targetDensity,
      volumeM3: row.volumeM3,
      operator: row.operator,
      state: row.state,
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
      scheduleStore.setMessage(`已新建走水计划：${row.planDate}，目标密度 ${row.targetDensity} g/cm³`);
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

  /** 该池最新观测（水位 / 密度） */
  const latestObservationOf = (pondId: string) => {
    const list = pondStore.state.observations
      .filter((item) => item.pondId === pondId)
      .sort((a, b) => a.date.localeCompare(b.date));
    return list.length === 0 ? null : list[list.length - 1];
  };

  /** 每条编排的放行对账视图：放行依据状态 + 闸口（样品 / 水位）预检 */
  const rowView = (row: Schedule) => {
    const assays = pondAssays(row.pondId);
    const evaluation = evaluateBasis(row, assays);
    const latestAssay = evaluation.latestAssay;
    const obs = latestObservationOf(row.pondId);
    const gate = checkReleaseGate(latestAssay, obs);
    return {
      evaluation,
      gate,
      latestAssay,
      levelCm: obs === null ? null : obs.levelCm,
    };
  };

  const handlePrimary = async (row: Schedule): Promise<void> => {
    if (row.state === '待排') {
      const ok = await scheduleStore.markScheduled(row.id);
      if (!ok) scheduleStore.setMessage('只有调度室可以排程，或该计划当前不是「待排」状态');
    } else if (row.state === '已排') {
      await scheduleStore.release(row.id);
    } else if (row.state === '待复核') {
      await scheduleStore.reconfirm(row.id);
    } else if (row.state === '走水中') {
      await scheduleStore.discharge(row.id);
    }
  };

  const primaryLabel = (state: ScheduleState): string => {
    if (state === '待排') return '标记已排';
    if (state === '已排') return '放行走水';
    if (state === '待复核') return '重新确认';
    if (state === '走水中') return '完成出卤';
    return '已出卤';
  };

  return (
    <div class="space-y-3.5">
      <div class="flex flex-wrap gap-3">
        <StatBadge label="走水计划" value={stats().total} suffix="条" tone="primary" />
        <StatBadge label="待排" value={stats().pending} suffix="条" tone="default" />
        <StatBadge label="走水中" value={stats().running} suffix="条" tone="warning" />
        <StatBadge
          label="待复核"
          value={stats().review}
          suffix="条"
          tone={stats().review > 0 ? 'danger' : 'default'}
          hint="化验室改判 / 撤单 / 新结论顶替后退回，需调度员重新确认"
        />
        <StatBadge label="已出卤" value={stats().done} suffix="条" tone="success" />
        <StatBadge label="计划总量" value={stats().volume} suffix="m³" tone="info" />
        <StatBadge label="出卤完成率" value={`${stats().donePct}%`} percent={stats().donePct} tone="success" />
      </div>

      <Show when={scheduleStore.state.lastMessage !== ''}>
        <div class="rounded-lg border border-brine-200 bg-brine-50 px-3.5 py-2 text-sm text-brine-800">
          {scheduleStore.state.lastMessage}
        </div>
      </Show>

      <Show when={!roleStore.canEditSchedule()}>
        <div class="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2 text-sm text-amber-800">
          当前为「化验室」视角：走水编排的先后顺序与放行由调度室负责，本页只读。登记 / 修改 / 撤销分析单后，相关在途编排会自动退回「待复核」。
        </div>
      </Show>

      <section class="rounded-xl border border-slate-200 bg-white p-4">
        <header class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-[15px] font-semibold text-slate-800">走水与出卤编排</h2>
            <p class="mt-0.5 text-xs text-slate-500">
              放行需同时满足：化验室最新有效结论「达标」且水位 ≥ {SAFE_LEVEL_CM} cm；依据事后失效自动退回「待复核」。
            </p>
          </div>
          <button
            type="button"
            class={BTN_PRIMARY}
            onClick={openCreate}
            disabled={pondStore.state.ponds.length === 0 || !roleStore.canEditSchedule()}
          >
            + 新建走水计划
          </button>
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
            description="为蒸发池编排走水日期、目标密度与计划量；放行时与化验室最新达标结论对账并检查水位安全线，拖拽列表可调整走水先后顺序。"
            actionText="新建第一条走水计划"
            onAction={openCreate}
          />
        </Show>

        <Show when={ordered().length > 0}>
          <ul class="space-y-2">
            <For each={filtered()}>
              {(row, index) => {
                const view = (): ReturnType<typeof rowView> => rowView(row);
                const canEdit = (): boolean => roleStore.canEditSchedule();
                const actionable = (): boolean => row.state !== '已出卤' && canEdit();
                return (
                  <li
                    draggable={canEdit()}
                    class={`flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3.5 py-3 transition ${
                      dragOverId() === row.id ? 'border-brine-500 ring-1 ring-brine-400' : 'border-slate-200'
                    } ${row.state === '待复核' ? 'border-rose-200 bg-rose-50/40' : ''} ${canEdit() ? 'cursor-grab' : 'opacity-95'}`}
                    onDragStart={() => canEdit() && scheduleStore.setDraggingId(row.id)}
                    onDragOver={(event) => {
                      if (!canEdit()) return;
                      event.preventDefault();
                      setDragOverId(row.id);
                    }}
                    onDragLeave={() => setDragOverId(null)}
                    onDrop={(event) => {
                      event.preventDefault();
                      void handleDrop(row.id);
                    }}
                  >
                    <span class="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">
                      {index() + 1}
                    </span>
                    <Show when={canEdit()}>
                      <span class="text-slate-300" title="按住拖拽调整顺序">
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
                          退回复核：{row.rollbackReason ?? '放行依据已失效'}（原状态 {row.resumeState ?? '—'}）
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
                    {/* 放行对账：样品与水位分开报，让调度员一眼分清是谁挡住 */}
                    <div class="min-w-[190px] text-xs leading-relaxed">
                      {(() => {
                        const v = view();
                        const assay = v.latestAssay;
                        const levelLow = v.levelCm === null || v.levelCm < SAFE_LEVEL_CM;
                        return (
                          <>
                            <p class={v.gate.sampleBlocked ? 'font-medium text-rose-700' : 'font-medium text-emerald-700'}>
                              样品：{assay === null ? '未化验' : `${effectiveVerdict(assay)}（${assay.date}）`}
                            </p>
                            <p class={levelLow ? 'font-medium text-rose-700' : 'font-medium text-emerald-700'}>
                              水位：{v.levelCm === null ? '无观测' : `${v.levelCm} cm`}
                              <span class="font-normal text-slate-400">（安全线 {SAFE_LEVEL_CM} cm）</span>
                            </p>
                          </>
                        );
                      })()}
                    </div>
                    <div class="min-w-[150px] text-xs text-slate-600">
                      <p class="font-medium text-slate-700">放行依据</p>
                      <Show
                        when={row.basisAssayId !== null}
                        fallback={<span class="text-slate-400">{row.state === '已出卤' ? '历史编排（升级前放行）' : '尚未放行'}</span>}
                      >
                        <p>
                          化验单 {row.basisAssayDate ?? '—'} · {row.basisVerdict ?? '达标'}
                        </p>
                        <p class="text-slate-400">{row.releasedAt === null ? '' : `放行 ${row.releasedAt.slice(0, 10)}`}</p>
                      </Show>
                    </div>
                    <span class={`rounded border px-2 py-0.5 text-[11px] ${STATE_STYLE[row.state]}`}>{row.state}</span>
                    <div class="flex flex-wrap items-center gap-2">
                      <button
                        class="rounded-md border border-brine-300 bg-brine-50 px-2.5 py-1 text-xs text-brine-700 transition hover:bg-brine-100 disabled:opacity-50"
                        disabled={!actionable()}
                        title={canEdit() ? gateBlockSummary(view().gate) : '化验室只读，放行由调度室操作'}
                        onClick={() => void handlePrimary(row)}
                      >
                        {primaryLabel(row.state)}
                      </button>
                      <Show when={canEdit()}>
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
            <span>走水状态</span>
            <select class={INPUT} value={draft.state} onChange={(event) => setDraft('state', event.currentTarget.value as ScheduleState)}>
              <For each={SCHEDULE_STATE_OPTIONS.filter((item) => item !== '待复核')}>
                {(state) => <option value={state}>{state}</option>}
              </For>
            </select>
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
          放行依据不在本表单维护：点「放行走水」时按化验室最新有效达标结论与池水位自动对账锁定。化验室事后改判或撤单，计划自动退回「待复核」；改派蒸发池会清空原放行依据。
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
          将删除「{pondLabel(deleting()?.pondId ?? '')}」在 {deleting()?.planDate} 的走水计划。化验室的水样分析单不受影响。
        </p>
      </AppDialog>
    </div>
  );
}
