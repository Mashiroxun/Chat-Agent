// 启动组合生命周期（0.4.9.3 / 2026-11-04）
//
// 解决什么问题：G 盘现在能替换 22 个组件，但覆盖层的组件如果自己起了定时器、
// 订阅、文件句柄，stop() 里并不认识它们 —— 退出时这些资源没人回收，
// headless 或热重载场景下会残留（重复推送、端口占用、写坏数据文件）。
//
// 0.5 用 ctx.lifecycle.onStop(...) 让组件自己登记清理函数，关闭时逆序执行。
// 这里做同样的语义，接口保持兼容（signal / onStop / close / cancel）。
//
// 设计要点：
//   · 逆序释放（LIFO）：后申请的资源先清理，符合依赖顺序。
//   · onStop 返回注销函数：组件中途自己释放了资源，可以撤销登记。
//   · close() 幂等：stop() 可能被调多次，只执行一遍。
//   · 单个清理函数抛错不阻断其它清理，最后聚合成 AggregateError。
//   · close() 会 abort signal，组件可用它中断在途异步操作。

/** @typedef {{ signal: AbortSignal, onStop: (fn: Function) => () => void, close: () => Promise<void>, cancel: (reason?: any) => void }} CompositionLifecycle */

/**
 * 创建一份组合生命周期。每个 createApp 实例独享一份，互不干扰。
 * @returns {CompositionLifecycle}
 */
export function createCompositionLifecycle() {
  const controller = new AbortController();
  const effects = [];
  let closing = null;

  return Object.freeze({
    signal: controller.signal,

    /** 中断在途操作（不执行清理函数）。 */
    cancel(reason = new Error('组合实例已停止')) {
      if (!controller.signal.aborted) controller.abort(reason);
    },

    /**
     * 登记一个清理函数，返回注销函数。
     * @param {() => void | Promise<void>} dispose
     * @returns {() => void} 注销登记
     */
    onStop(dispose) {
      if (typeof dispose !== 'function') throw new TypeError('lifecycle.onStop 需要清理函数');
      if (controller.signal.aborted) throw new Error('组合实例已停止，不能注册资源');
      const effect = { dispose, active: true };
      effects.push(effect);
      return () => {
        effect.active = false;
        const i = effects.indexOf(effect);
        if (i !== -1) effects.splice(i, 1);
      };
    },

    /** 逆序执行全部清理，幂等。 */
    close() {
      if (closing) return closing;
      // 先把 promise 发布出去，避免 abort 监听或清理函数重入
      closing = Promise.resolve().then(async () => {
        const errors = [];
        while (effects.length) {
          const effect = effects.pop();
          if (!effect.active) continue;
          effect.active = false;
          try { await effect.dispose(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, '组合资源清理失败');
      });
      controller.abort(new Error('组合实例已停止'));
      return closing;
    },
  });
}
