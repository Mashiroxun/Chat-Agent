// 协议端「接入向导」：把"登录控制台 → 挑 QQ → 注入"串成一次点击。
//
// ── 它解决的是什么（2026-10-27，R126）────────────────────────────────────
// 用户装好 SnowLuma 之后，真正要做的动作是：启动它 → 打开 5099 控制台 → 登录
// （密码在启动日志里，得自己翻）→ 在进程表里找到机器人那个 QQ → 点「注入」。
// 五步里有四步是"找东西"，任何一步找不到就卡住，而卡住时的表现都是
// "机器人不上线"，看不出差在哪。
//
// 本模块把这些步骤收成状态机：每一步都能说出"现在缺什么、下一步点哪"，
// 能自动判定的就自动判定（只有一个 QQ 时直接注入），需要人做主的才停下来问
// （多个 QQ 选哪个、密码是多少、要不要同意条款）。
//
// ── 边界（与 protocol-webui.js 顶部那份一致，别越线）─────────────────────
//   · 只调它自己的 WebUI API，等价于用户在它的界面上点；
//   · 不写它的任何文件（不碰 config/webui.json、不碰 onebot_*.json）；
//   · 不代签协议（record-consent 永不调用）、不代改密码（change-password 永不调用）；
//   · 密码只存在用户本地配置里，不进日志、不进 /api 响应（只回 hasPassword 布尔）。

import { LOGIN_KIND, extractInitialCredentials } from './protocol-webui.js';

/** 向导阶段。UI 只认这些字符串，加新阶段要同步 03-connection.js。 */
export const STAGE = {
  NO_DIR: 'no-dir',             // 还没指定 SnowLuma 目录
  STOPPED: 'stopped',           // 协议端没在跑
  BOOTING: 'booting',           // 刚启动，控制台端口还没开
  NEED_PASSWORD: 'need-password', // 需要控制台密码（首次 / 改过密码后）
  LOCKED: 'locked',             // 试太多次被临时锁
  NEED_TOTP: 'need-totp',       // 控制台开了两步验证
  CONSENT: 'consent',           // 需要用户本人在控制台同意协议
  MUST_CHANGE: 'must-change',   // 需要用户本人在控制台改初始密码
  NO_QQ: 'no-qq',               // 没有可注入的 QQ 进程
  PICK: 'pick',                 // 多个 QQ，需要选一个
  WRONG_TARGET: 'wrong-target', // 注入的是别的号
  CAN_INJECT: 'can-inject',     // 能确定目标，可以一键注入
  READY: 'ready',               // 目标已注入，OneBot 应该起来了
  ERROR: 'error'
};

const PW_MASK = '******';

export function createProtocolOnboard({
  getConfig = () => ({}),
  updateConfig = (x) => x,
  launcher = null,
  client = null,
  isPortOpen = null,
  emit = () => {},
  log = () => {},
  waitMs = 2500
} = {}) {
  /** 最近一次登录拿到的 token（进程内缓存，不落盘） */
  let token = '';
  let tokenAt = 0;
  /** 最近一次失败原因，供 UI 显示 */
  let lastError = '';
  /** 上一次登录用的密码来源：config / log / input */
  let passwordSource = '';
  /**
   * 登录失败退避（2026-10-27）。
   *
   * 为什么必须有：SnowLuma 连续 5 次密码错误会锁 15 分钟。而 status() 是会被
   * UI 反复调用的（页面刷新、用户点"重新检测"），如果每次都拿存着的错密码去试，
   * 用户什么都没干就被锁死了 —— 表现是"刚才还能填，现在连密码框都说被锁"。
   * 所以失败后进入退避窗口，窗口内直接返回上次的结论，不再真的发登录请求。
   */
  let loginBlockedUntil = 0;
  let loginFailKind = '';
  let loginFailMessage = '';

  function cfg() {
    return (getConfig() || {}).protocol || {};
  }

  function savedPassword() {
    return String(cfg().webui?.password || '');
  }

  /** 记住密码（用户自己填的，存在本地配置里；不写日志）。 */
  function savePassword(pw) {
    const v = String(pw || '');
    updateConfig({ protocol: { webui: { password: v } } });
    return v;
  }

  async function controlPortOpen() {
    if (typeof isPortOpen !== 'function') return null;
    try { return await isPortOpen('127.0.0.1', 5099, 800); } catch { return null; }
  }

  /** 等控制台端口就绪（协议端刚启动时 5099 要几秒）。 */
  async function waitControlPort(timeoutMs = waitMs) {
    const deadline = Date.now() + Math.max(500, timeoutMs);
    while (Date.now() < deadline) {
      if (await controlPortOpen()) return true;
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }

  /** 登录：优先用刚输入的密码 → 配置里存的 → 启动日志里的初始凭据。 */
  async function ensureToken(inputPassword = '') {
    if (token && Date.now() - tokenAt < 10 * 60_000) return { ok: true, token };

    // 退避窗口内不再真的发登录请求（见 loginBlockedUntil 的注释）
    if (Date.now() < loginBlockedUntil) {
      return { ok: false, kind: loginFailKind, message: loginFailMessage, backoff: true };
    }

    const candidates = [];
    if (inputPassword) candidates.push({ pw: inputPassword, from: 'input' });
    if (savedPassword()) candidates.push({ pw: savedPassword(), from: 'config' });
    // 初始凭据只在该次启动的日志里出现，改过密码后就没有了
    const fromLog = extractInitialCredentials(launcher?.logs?.(400) || []);
    if (fromLog?.password) candidates.push({ pw: fromLog.password, from: 'log' });

    if (!candidates.length) return { ok: false, kind: STAGE.NEED_PASSWORD };

    const backoff = (kind, message) => {
      loginFailKind = kind;
      loginFailMessage = message || '';
      // 只有真的消耗了尝试次数的失败才退避；"要同意/要改密码/要动态码"不消耗
      if (kind === STAGE.NEED_PASSWORD) loginBlockedUntil = Date.now() + 30_000;
      else if (kind === STAGE.LOCKED) loginBlockedUntil = Date.now() + 15 * 60_000;
      else loginBlockedUntil = 0;
      return { ok: false, kind, message };
    };

    let last = { ok: false, kind: STAGE.NEED_PASSWORD };
    for (const c of candidates) {
      const r = await client.login(c.pw);
      if (r.ok) {
        token = r.token;
        tokenAt = Date.now();
        lastError = '';
        loginBlockedUntil = 0;
        passwordSource = c.from;
        // 用日志里的初始密码登进去了 → 说明用户还没改过，顺手存下来免得下次再找
        if (c.from === 'log' && !savedPassword()) savePassword(c.pw);
        if (c.from === 'input') savePassword(c.pw);
        if (r.mustChangePassword) return { ok: false, kind: STAGE.MUST_CHANGE };
        return { ok: true, token };
      }
      last = r;
      lastError = r.message || '';
      // 被锁 / 要动态码 / 要同意 —— 换密码重试没有意义，直接停
      if (r.kind === LOGIN_KIND.LOCKED || r.kind === LOGIN_KIND.NEEDS_TOTP || r.kind === LOGIN_KIND.CONSENT) break;
    }

    if (last.kind === LOGIN_KIND.LOCKED) return backoff(STAGE.LOCKED, last.message);
    if (last.kind === LOGIN_KIND.NEEDS_TOTP) return backoff(STAGE.NEED_TOTP, last.message);
    if (last.kind === LOGIN_KIND.CONSENT) return backoff(STAGE.CONSENT, last.message);
    if (last.kind === LOGIN_KIND.MUST_CHANGE) return backoff(STAGE.MUST_CHANGE, last.message);
    if (last.kind === LOGIN_KIND.UNREACHABLE) return { ok: false, kind: STAGE.BOOTING, message: last.message };
    return backoff(STAGE.NEED_PASSWORD, last.message || '控制台密码不对');
  }

  /** 目标 QQ：优先用上次协议端配置里那个号（config/onebot_<uin>.json 的 uin）。 */
  function preferredUin() {
    const u = String(cfg().lastUin || '').trim();
    return u;
  }

  /**
   * 纯函数：根据进程表决定下一步。
   * 抽出来是为了能单测 —— 这段判断决定了"会不会把个人号注入成机器人"。
   */
  function decideStage(processes, preferred) {
    const list = Array.isArray(processes) ? processes : [];
    if (!list.length) return { stage: STAGE.NO_QQ };
    const injected = list.filter((p) => p.injected);
    const pref = String(preferred || '');

    if (pref) {
      const target = list.find((p) => p.uin === pref);
      if (target?.injected) return { stage: STAGE.READY, pid: target.pid, uin: target.uin, nickname: target.nickname };
      if (injected.length) {
        // 注入了别的号（多半是个人号）—— 这是最容易出事的状态：机器人会用错号发言
        return {
          stage: STAGE.WRONG_TARGET,
          pid: target?.pid || 0,
          uin: pref,
          injectedUins: injected.map((p) => p.uin).filter(Boolean)
        };
      }
      if (target) return { stage: STAGE.CAN_INJECT, pid: target.pid, uin: target.uin, nickname: target.nickname };
    }

    if (injected.length) {
      return {
        stage: STAGE.READY,
        pid: injected[0].pid,
        uin: injected[0].uin,
        nickname: injected[0].nickname,
        unknown: !pref
      };
    }
    // 没配置过机器人号（新装）：只有一个 QQ 时可以直接注入，多个必须让用户选
    if (list.length === 1) {
      return { stage: STAGE.CAN_INJECT, pid: list[0].pid, uin: list[0].uin, nickname: list[0].nickname };
    }
    return { stage: STAGE.PICK, candidates: list };
  }

  /**
   * 轻量状态快照：不登录、不请求控制台，只用本地已知信息拼一个 status。
   *
   * 为什么需要：connect() 失败时如果回头再调一次 status()，会**重新走一遍登录**
   * —— 密码错的场景下等于每次失败多消耗一次尝试（SnowLuma 5 次就锁 15 分钟），
   * 而且 UI 拿到的还是同一句话。失败路径一律用这个。
   */
  function snapshot(stage, message = '') {
    const proc = launcher?.status?.() || { running: false, dir: '' };
    return {
      stage,
      running: Boolean(proc.running),
      pid: proc.pid || null,
      dir: String(proc.dir || proc.configuredDir || ''),
      hasPassword: Boolean(savedPassword()),
      passwordSource,
      message,
      processes: [],
      target: null,
      lastError: message
    };
  }

  /** 探测当前阶段（不产生副作用，可被 UI 每几秒轮询）。 */
  async function status() {
    const proc = launcher?.status?.() || { running: false, dir: '' };
    const dir = String(proc.dir || proc.configuredDir || '').trim();
    const hasPassword = Boolean(savedPassword());
    const base = {
      stage: STAGE.STOPPED,
      running: Boolean(proc.running),
      pid: proc.pid || null,
      dir,
      hasPassword,
      passwordSource,
      message: '',
      processes: [],
      target: null,
      lastError
    };

    if (!dir) return { ...base, stage: STAGE.NO_DIR };
    if (!proc.running && !(await controlPortOpen())) return { ...base, stage: STAGE.STOPPED };

    const reachable = await controlPortOpen();
    if (!reachable) return { ...base, stage: STAGE.BOOTING };

    const auth = await ensureToken('');
    if (!auth.ok) return { ...base, stage: auth.kind, message: auth.message || '' };

    const list = await client.processes(auth.token);
    if (!list.ok) {
      if (list.kind === 'unauthorized') {
        token = '';   // token 过期 → 下一轮重新登录
        return { ...base, stage: STAGE.NEED_PASSWORD, message: '登录状态过期，请重新填一次密码' };
      }
      return { ...base, stage: list.kind === LOGIN_KIND.CONSENT ? STAGE.CONSENT
        : list.kind === LOGIN_KIND.MUST_CHANGE ? STAGE.MUST_CHANGE
          : STAGE.ERROR, message: list.message || '' };
    }

    const decided = decideStage(list.list, preferredUin());
    return {
      ...base,
      ...decided,
      stage: decided.stage,
      processes: list.list,
      target: decided.pid ? list.list.find((p) => p.pid === decided.pid) || null : null,
      message: ''
    };
  }

  /**
   * 执行接入：注入目标（必要时先把错的号卸掉）。
   * @param {{password?:string, totp?:string, pid?:number}} opts
   */
  async function connect({ password = '', pid = 0 } = {}) {
    if (password) { savePassword(password); loginBlockedUntil = 0; }   // 用户重填了密码 → 解除退避
    const auth = await ensureToken(password);
    if (!auth.ok) {
      // 失败路径用 snapshot：再走一次 status() 会重复登录（见 snapshot 的注释）
      return { ok: false, stage: auth.kind, message: auth.message || '', status: snapshot(auth.kind, auth.message || '') };
    }

    const list = await client.processes(auth.token);
    if (!list.ok) {
      const stage = list.kind === 'unauthorized' ? STAGE.NEED_PASSWORD
        : list.kind === LOGIN_KIND.CONSENT ? STAGE.CONSENT
          : list.kind === LOGIN_KIND.MUST_CHANGE ? STAGE.MUST_CHANGE
            : STAGE.ERROR;
      return { ok: false, stage, message: list.message || '读不到 QQ 进程表', status: snapshot(stage, list.message || '读不到 QQ 进程表') };
    }

    const pref = preferredUin();
    const decided = decideStage(list.list, pref);
    const targetPid = Number(pid) || decided.pid || 0;

    if (!targetPid) {
      const msg = decided.stage === STAGE.PICK
        ? '有多个 QQ 在线，先在列表里选一个'
        : '还没有可注入的 QQ：先在这台电脑上登录机器人 QQ';
      return { ok: false, stage: decided.stage, message: msg, status: { ...snapshot(decided.stage, msg), processes: list.list } };
    }

    // 注入前先把"别的号"卸掉：同时注入两个号会让两个 OneBot 实例抢 3001，
    // 表现是"时好时坏"，比不注入更难查。
    for (const p of list.list) {
      if (p.injected && p.pid !== targetPid) {
        log(`[protocol] 先卸载另一个已注入的号（pid=${p.pid} uin=${p.uin || '?'}）`);
        await client.unload(auth.token, p.pid);
      }
    }

    const r = await client.load(auth.token, targetPid);
    if (!r.ok) {
      const s = await status();
      return { ok: false, stage: s.stage, message: r.message || '注入失败', status: s };
    }

    const target = list.list.find((p) => p.pid === targetPid);
    // 记住这个号：下次就能直接判定"注入的是不是机器人号"
    if (target?.uin) updateConfig({ protocol: { lastUin: target.uin } });
    log(`[protocol] 已注入 QQ ${target?.uin || '?'}（pid=${targetPid}）`);

    const s = await status();
    return { ok: true, stage: s.stage, status: s, target: target || null };
  }

  /** 清掉内存里的 token（用户点了"退出登录"或换了密码）。 */
  function forgetToken() {
    token = '';
    tokenAt = 0;
  }

  return {
    status, connect, forgetToken, savePassword, savedPassword: () => PW_MASK,
    hasPassword: () => Boolean(savedPassword()),
    decideStage
  };
}
