// 渲染策略判定（纯函数，**不 import electron**）。
//
// 为什么单独一个文件：这几行决定了「分发给别人的 zip 在别人机器上桌宠能不能显示」，
// 是全项目最该被单测盯住的地方 —— 而 electron/main.js 一旦被 import 就会拉起
// Electron 运行时，根本没法在 node 里测。所以判定逻辑放这里，main.js 只负责
// 读环境变量、落盘、appendSwitch。
//
// 背景一句话：`--disable-gpu` / disableHardwareAcceleration 造成的强制软件合成下，
// 透明窗口（桌宠）拿不到呈现面 + Live2D 拿不到 WebGL；唯一能同时"上屏 + 有 GL"
// 的组合是「关渲染沙箱 + SwiftShader」。详见 main.js 顶部 renderGpuOff 那段实测记录。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 桌宠当前是否处于「用户要它显示」的状态。
 *
 * 保守取向：任何读不出来的情况都返回 true（=当作要显示）。
 * 理由是失败代价不对称 —— 误判成 false 会让收包人桌宠莫名消失且毫无提示；
 * 误判成 true 只是多重启一次兼容模式（多关一层渲染沙箱），用户可感知、可回退。
 *
 * @param {string} dataDir 运行时 data 目录（main.js 的 RENDER_DATA_DIR）
 * @returns {boolean}
 */
export function readPetVisible(dataDir) {
  try {
    if (!dataDir) return true;
    const file = path.join(dataDir, 'desktop-pet', 'state.json');
    if (!fs.existsSync(file)) return true;              // 首启没有 state.json：对齐 DEFAULT_SETTINGS.visible = true
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 只有**显式 false** 才算用户关了桌宠；字段缺失/类型不对一律按"开"处理。
    return state?.settings?.visible !== false;
  } catch { return true; }
}

/**
 * 是否应该为了桌宠自动切兼容模式（关渲染沙箱，本次启动即生效）。
 *
 * 四个条件缺一不可：
 *   · renderGpuOff        当前是软件渲染（显卡加速不可用）；GPU 正常时不必牺牲沙箱
 *   · !sandboxOffByConfig 配置里还没关沙箱；已经关了就不重复写盘
 *   · !keepSandbox        用户/排障没有用 QQ_AGENT_KEEP_SANDBOX=1 明确拒绝
 *   · petVisible          桌宠是开着的；用户关掉桌宠就没有理由降级安全纵深
 *
 * @param {{renderGpuOff?: boolean, sandboxOffByConfig?: boolean, keepSandbox?: boolean, petVisible?: boolean}} input
 * @returns {boolean}
 */
export function shouldAutoCompatibleForPet({ renderGpuOff, sandboxOffByConfig, keepSandbox, petVisible } = {}) {
  if (!renderGpuOff) return false;
  if (sandboxOffByConfig) return false;
  if (keepSandbox) return false;
  return petVisible !== false;
}

/** 应用自己写进配置的自动兼容标记。只有带这个标记的才允许被自动撤销。 */
export const AUTO_COMPAT_MARK = 'auto-pet';

/**
 * 是否应该撤销「为桌宠自动关沙箱」这个决定。
 *
 * 这段存在的唯一原因：`sandbox:false` 写进配置是**持久**的，而
 * shouldAutoCompatibleForPet 的前置条件里带着 `!sandboxOffByConfig` ——
 * 用户后来把桌宠关掉时，若没有这条反向撤销，那次降级会永远留在配置里，
 * 用户明明不要桌宠，却一直跑在关闭渲染沙箱的状态下。
 *
 * 三条边界：
 *   · 只认 AUTO_COMPAT_MARK：用户手动点「开启兼容模式」写的配置不能被悄悄改回；
 *   · keepSandbox 时不动（排障态由人决定）；
 *   · 只有**明确** petVisible === false 才撤销 —— 读不出来（undefined）时保守不动，
 *     免得因为一次读盘失败就把用户的桌宠搞没了。
 *
 * @param {{sandboxOffBy?: string, keepSandbox?: boolean, petVisible?: boolean}} input
 * @returns {boolean}
 */
export function shouldRevokeAutoCompat({ sandboxOffBy, keepSandbox, petVisible } = {}) {
  if (keepSandbox) return false;
  if (sandboxOffBy !== AUTO_COMPAT_MARK) return false;
  return petVisible === false;
}

// ── 崩溃降级（sandbox:false by auto-crash）的自动撤销（2026-11-13）──────────
//
// 为什么还需要这一条：上面 shouldRevokeAutoCompat 只认 'auto-pet'，而
// noteRendererCrash 写的是 'auto-crash'、更早的版本写的是**空串** —— 于是
// 「渲染进程连崩 3 次 → 关沙箱 → 重启」这条降级一旦落盘就**永远出不来**。
// 本机 data 就是活证据：2026-11-05 留下 sandbox:false + sandboxOffBy:""，
// 之后稳定跑了 8 天，配置里那层安全纵深再也没有回来过。
//
// 反向通道需要一个跨启动的证据：连续 N 次「健康启动」（见 main.js 的 60 秒
// 健康哨兵）。误降级（安全软件临时抽风、驱动更新后恢复）的机器会自动爬回来；
// 真的不能开沙箱的机器每次启动都会在 60 秒内崩掉，计数回到 0，永远撤不了。

/** 应用自己写进配置的崩溃降级标记（noteRendererCrash）。 */
export const AUTO_CRASH_MARK = 'auto-crash';

/** 撤销崩溃降级所需的「连续健康启动」次数。 */
export const SANDBOX_REVOKE_MIN_HEALTHY_BOOTS = 3;

/**
 * 是否应该撤销「渲染进程连续崩溃」造成的关沙箱降级。
 *
 * 四条边界，缺一不可（每一条都对应一次真实误伤，别删）：
 *
 *  ① keepSandbox：用户/排障用 QQ_AGENT_KEEP_SANDBOX=1 明确要求保沙箱，
 *     那是人的决定，自动逻辑不许覆盖（与 shouldRevokeAutoCompat 同一口径：
 *     truthy 即视为"人要求保沙箱"）。
 *  ② sandboxOffBy 必须是 'auto-crash' 或 **严格等于空串 ''**（空串仅在沙箱确实关着时
 *     算降级残留，见函数内护栏——否则会与 shouldRevokeAutoCompat 互相触发）。
 *     ⚠️ 这是整个改动最容易改错的一处：空串是 2026-11-05 那版写下的形态，
 *     要认；而 `undefined` / `null` 表示**用户在「桌宠」页手动开启兼容模式** ——
 *     main.js 的 enableCompatMode 压根不写 sandboxOffBy 这个字段。那是用户意图，
 *     一旦被自动改回，用户下次启动会掉回「被安全软件拦杀」的状态且毫无提示。
 *     所以绝不能用 `!sandboxOffBy` 之类的"空值统一处理"：undefined 不是 ''。
 *  ③ consecutiveHealthyBoots 必须是**有限数字**。NaN / undefined / '3'（字符串）
 *     一律 false —— 不靠 `>=` 的隐式转换兜底，那种兜底会让 '3' >= 3 意外成立。
 *  ④ 计数达到阈值才算数。
 *
 * 未知来源串（比如将来新增的降级原因）也返回 false：保守优先。
 * 误撤销的代价是用户重新陷入「开箱即坏」，多跑几天关沙箱只是少一层纵深。
 *
 * @param {{sandboxOffBy?: string, keepSandbox?: boolean, consecutiveHealthyBoots?: number, threshold?: number}} [input]
 * @returns {boolean}
 */
export function shouldRevokeCrashCompat({ sandboxOffBy, keepSandbox, consecutiveHealthyBoots, threshold, sandbox } = {}) {
  if (keepSandbox) return false;
  if (sandboxOffBy !== AUTO_CRASH_MARK && sandboxOffBy !== '') return false;
  // 空串有两重含义，必须靠 sandbox 区分，否则会与 shouldRevokeAutoCompat 互相触发：
  //   · 'auto-crash' 之外，空串曾是 2026-11-05 老版本写的崩溃降级残留 → 沙箱确实关着（sandbox===false），应撤销；
  //   · 但 shouldRevokeAutoCompat 撤销 auto-pet 时也把 sandboxOffBy 写成空串（中性无标记态）→ 此时沙箱已开（sandbox!==false）。
  //   不区分的话，auto-pet 撤销后的空串会被本函数当成「老降级」反复撤销，与 auto-pet 块形成
  //   '' ↔ 'auto-pet' 每次启动横跳写盘、计数永远清零、状态永不收敛。所以空串仅在沙箱关着时才当降级残留。
  if (sandboxOffBy === '' && sandbox !== false) return false;
  if (!Number.isFinite(consecutiveHealthyBoots)) return false;
  const need = Number.isFinite(threshold) && threshold > 0 ? threshold : SANDBOX_REVOKE_MIN_HEALTHY_BOOTS;
  return consecutiveHealthyBoots >= need;
}
