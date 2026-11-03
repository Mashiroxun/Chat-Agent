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
