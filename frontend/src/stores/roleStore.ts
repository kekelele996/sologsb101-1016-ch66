/**
 * 工作台角色管理（Solid 原生能力）
 * 纯前端单库应用没有后端鉴权，这里的角色只用于划分两块业务的写权限：
 * - 调度室只能操作走水编排，化验室录入页只读；
 * - 化验室只能登记/修改/撤销水样分析单，走水编排只读且不能排序。
 * 角色选择保存在 localStorage，刷新后保留。
 */
import { createRoot, createSignal } from 'solid-js';
import type { AppRole } from '../types/role';
import { APP_ROLE_OPTIONS } from '../types/role';

const ROLE_KEY = 'gbbrinepond:role';

function readRole(): AppRole {
  try {
    const raw = window.localStorage.getItem(ROLE_KEY);
    return raw === '调度室' || raw === '化验室' ? raw : '调度室';
  } catch {
    return '调度室';
  }
}

function createRoleStore() {
  const [role, setRoleSignal] = createSignal<AppRole>(readRole());

  function setRole(next: AppRole): void {
    setRoleSignal(next);
    try {
      window.localStorage.setItem(ROLE_KEY, next);
    } catch {
      /* 隐私模式下写入失败时静默降级 */
    }
  }

  return { role, setRole, options: APP_ROLE_OPTIONS };
}

const store = createRoot(createRoleStore);

export function useRoleStore() {
  return store;
}
