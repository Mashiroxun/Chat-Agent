// 草稿级写入互斥（2026-10-28 审计修）。
//
// 为什么需要它：前端有 forgeBusy / upgradeBusy 两道界面守卫，但那只是**界面层** ——
// 刷新页面、开两个窗口、直接打接口都能绕过去。草稿是磁盘上的一堆文件，两个请求
// 同时往里写就是"谁后落盘谁说了算"，结果是文件清单与闸门结论对不上，而闸门结论
// 正是用户点「安装」的依据。
//
// 设计取舍：
//   · **进程内**锁，不落磁盘 —— 进程重启即清空，不存在"上次崩溃留下的死锁"；
//   · 只锁会改草稿/会落地的动作，读、查、预览一律不锁（否则界面会被无故卡住）；
//   · 没有 draftId（新建草稿）时直接放行 —— 新 id 不可能与任何在跑的请求冲突；
//   · 释放由调用方挂在响应结束上（见 routes.js 的 lockForgeDraft），
//     这样 handler 里任何 return 路径都能解开，不依赖 finally 包裹整个函数体。
//
// 单独成文件而不是塞进 routes.js：这段逻辑没有网络副作用，可以在单测里直接
// 验证"二次获取被拒 / 释放后可再取 / 不同草稿互不影响"，不用起 HTTP。

const BUSY = new Map();   // draftId -> { kind, since }

/**
 * 尝试获取草稿写锁。
 * @param {string} draftId
 * @param {string} kind 动作名（用于提示"正在被什么占用"）
 * @returns {{release: () => void} | {busy: {kind: string, since: number}}}
 */
export function acquireForgeDraftLock(draftId, kind) {
  const key = String(draftId || '').trim();
  if (!key) return { release: () => {} };
  const cur = BUSY.get(key);
  if (cur) return { busy: cur };
  BUSY.set(key, { kind, since: Date.now() });
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      const held = BUSY.get(key);
      // 只释放自己持有的那份：防御性判断，正常不会被顶替
      if (held && held.kind === kind) BUSY.delete(key);
    }
  };
}

/** 当前持有者（没有则 null）。给日志/测试用。 */
export function forgeDraftLockHolder(draftId) {
  const key = String(draftId || '').trim();
  return key ? (BUSY.get(key) || null) : null;
}

/** 仅测试用：清空全部锁，避免用例之间互相影响。 */
export function __resetForgeDraftLocks() {
  BUSY.clear();
}
