/**
 * 岗位角色状态（Solid 原生能力）
 * 调度室与化验室共用一个本地应用，但写权限严格分开：
 * - 调度员：走水编排（建 / 改 / 排序 / 放行 / 复核），水样分析单只读；
 * - 化验员：水样分析单登记与达标结论，走水编排只读（系统自动退回「待复核」不算人工改动）。
 * 纯前端应用没有登录体系，角色仅作界面操作授权，保存在 localStorage。
 */
import { createRoot, createSignal } from 'solid-js';

export type WorkRole = 'dispatch' | 'lab';

export const ROLE_LABEL: Record<WorkRole, string> = {
  dispatch: '调度室 · 调度员',
  lab: '化验室 · 化验员',
};

const ROLE_KEY = 'gbbrinepond:workRole';

function readRole(): WorkRole {
  try {
    const raw = window.localStorage.getItem(ROLE_KEY);
    return raw === 'lab' ? 'lab' : 'dispatch';
  } catch {
    return 'dispatch';
  }
}

function createRoleStore() {
  const [role, setRoleSignal] = createSignal<WorkRole>(readRole());

  function setRole(next: WorkRole): void {
    setRoleSignal(next);
    try {
      window.localStorage.setItem(ROLE_KEY, next);
    } catch {
      /* 隐私模式下降级为仅当前会话生效 */
    }
  }

  /** 调度室：可操作走水编排，化验页只读 */
  const canEditSchedule = (): boolean => role() === 'dispatch';
  /** 化验室：可登记 / 修改分析单，走水页只读、不能调整顺序 */
  const canEditAssay = (): boolean => role() === 'lab';

  return { role, setRole, canEditSchedule, canEditAssay };
}

const store = createRoot(createRoleStore);

export function useRoleStore() {
  return store;
}
