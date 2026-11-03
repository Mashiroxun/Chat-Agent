// SnowLuma 控制台（WebUI）HTTP 客户端 —— 只读 + 用户级操作，不碰它的文件。
//
// ── 为什么需要这个模块（2026-10-27，R126）────────────────────────────────
// 「注入」= 把 SnowLuma 的原生组件挂进 QQ 进程，让它接管消息收发。这一步原本只能
// 用户在 SnowLuma 的 WebUI 里点：登录 → 看进程表 → 挑那个号 → 点「注入」。
// 对第一次用的人来说，卡点有三处：密码在哪、该点哪个号、注入完还要干什么。
//
// 本模块把这三步变成 QQ Agent 里的几次点击，但**严格守住 EULA 的边界**（见下）。
//
// ── EULA 边界（SnowLuma EULA v1.1 第 5.4 条，中文为准）────────────────────
// 原文：不得复制、修改、单独再分发或再许可该组件；**将其并入第三方安装包或 Docker
// 镜像、通过自动化脚本部署，或者将其用于任何商业用途，均须事先取得书面授权**。
//
// 据此划出的红线（改动本文件前先读一遍）：
//   ✅ 允许：以发行包原样运行（用户自己下载、自己解压、自己点启动）
//   ✅ 允许：调用它自己的 WebUI API 完成"用户在界面上本来就能点"的动作
//          （登录 / 看进程表 / 注入 / 卸载）—— 这是使用软件功能，不是部署软件
//   ❌ 禁止：复制、修改、单独再分发它的任何文件（含 native/*.node、*.dll）
//   ❌ 禁止：把它打进安装包 / Docker 镜像
//   ❌ 禁止：用脚本替用户安装、配置它（"自动化脚本部署"）
//   ❌ 禁止：代用户同意协议 —— /api/agreements/record-consent **永不调用**
//   ❌ 禁止：代用户改密码 —— /api/auth/change-password **永不调用**
//
// 也就是说：本模块只做"用户点得出来的那几下"，任何需要用户本人表态的步骤
// （同意条款、改密码、开/关两步验证）一律停在原地，由界面引导用户自己去点。
//
// ── 接口依据（SnowLuma 2.1.1 实测/源码核对）──────────────────────────────
//   POST /api/login                {password}            → {success, token, mustChangePassword}
//                                                        401 密码错误 / 429 锁定 / needsTotp
//   GET  /api/auth/state           Bearer                → {mustChangePassword}
//   GET  /api/processes            Bearer                → {list:[{pid,injected,loggedIn,status,account}]}
//   POST /api/processes/:pid/load  Bearer                → {success, process}
//   POST /api/processes/:pid/unload Bearer               → {success, process}
//   未同意协议时，除 CONSENT_ALLOWLIST 外的接口返回 403 + {consentRequired:true}
//   必须改密码时，除 MUST_CHANGE_ALLOWLIST 外的接口返回 403 + {mustChangePassword:true}

/** 登录失败的分类：调用方据此决定"重试 / 等 / 让用户填密码 / 让用户去控制台"。 */
export const LOGIN_KIND = {
  OK: 'ok',
  REJECTED: 'rejected',       // 密码错（401）
  LOCKED: 'locked',           // 试太多次被临时锁（429）
  NEEDS_TOTP: 'needs-totp',   // 开了两步验证，必须用户给动态码
  CONSENT: 'consent',         // 还没同意协议
  MUST_CHANGE: 'must-change', // 还没改初始密码
  UNREACHABLE: 'unreachable'  // 连不上 / 超时（不是密码问题，别误导用户）
};

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  return `${b}${path}`;
}

/**
 * @param {object} deps
 * @param {string} [deps.baseUrl]      默认 http://127.0.0.1:5099
 * @param {Function} [deps.fetchImpl]  注入 fetch（单测用）
 * @param {number} [deps.timeoutMs]
 */
export function createWebuiClient({ baseUrl = 'http://127.0.0.1:5099', fetchImpl = null, timeoutMs = 8000 } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;

  async function request(path, { method = 'GET', token = '', body = null, timeout = timeoutMs } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== null) headers['content-type'] = 'application/json';
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
    if (timer) timer.unref?.();
    try {
      const res = await doFetch(joinUrl(baseUrl, path), {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
        signal: ctrl?.signal
      });
      let json = null;
      try { json = await res.json(); } catch { /* 非 JSON（比如反代返回的 HTML） */ }
      return { status: res.status, ok: res.ok, json };
    } catch (error) {
      const aborted = error?.name === 'AbortError';
      return { status: 0, ok: false, json: null, error: aborted ? '请求超时（控制台没响应）' : String(error?.message ?? error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 控制台在不在（只看有没有 HTTP 响应，不判断鉴权）。 */
  async function ping({ timeout = 2500 } = {}) {
    // /api/status 需要 token，但"401"本身已经证明服务活着 —— 有响应就算在
    const r = await request('/api/status', { timeout });
    if (r.status === 0) return { reachable: false, error: r.error };
    return { reachable: true, status: r.status };
  }

  /**
   * 登录。
   * @param {string} password 用户自己的控制台密码（由用户在 QQ Agent 里填一次）
   * @param {{totp?: string}} [opt]
   * @returns {Promise<{ok:boolean, kind:string, token?:string, mustChangePassword?:boolean, message?:string}>}
   */
  async function login(password, opt = {}) {
    const body = { password: String(password ?? '') };
    if (opt.totp) body.totp = String(opt.totp);
    const r = await request('/api/login', { method: 'POST', body, timeout: 10000 });

    if (r.status === 0) return { ok: false, kind: LOGIN_KIND.UNREACHABLE, message: r.error };

    const j = r.json || {};
    if (r.status === 200 && j.success && j.token) {
      return { ok: true, kind: LOGIN_KIND.OK, token: j.token, mustChangePassword: Boolean(j.mustChangePassword) };
    }
    if (j.needsTotp) return { ok: false, kind: LOGIN_KIND.NEEDS_TOTP, message: '控制台开了两步验证' };
    if (r.status === 429 || /过多|锁定|too many|locked/i.test(String(j.message || ''))) {
      return { ok: false, kind: LOGIN_KIND.LOCKED, message: j.message || '尝试过多，被临时锁定' };
    }
    if (j.consentRequired) return { ok: false, kind: LOGIN_KIND.CONSENT, message: j.message || '需要先同意用户协议' };
    if (r.status === 401) return { ok: false, kind: LOGIN_KIND.REJECTED, message: j.message || '密码错误' };
    return { ok: false, kind: LOGIN_KIND.REJECTED, message: j.message || `HTTP ${r.status}` };
  }

  /** 列出 QQ 进程（含是否已注入、账号 uin/昵称）。 */
  async function processes(token) {
    const r = await request('/api/processes', { token });
    if (r.status === 401) return { ok: false, kind: 'unauthorized' };
    if (r.json?.consentRequired) return { ok: false, kind: LOGIN_KIND.CONSENT, message: r.json.message };
    if (r.json?.mustChangePassword) return { ok: false, kind: LOGIN_KIND.MUST_CHANGE, message: r.json.message };
    if (!r.ok) return { ok: false, kind: 'http', message: r.json?.message || `HTTP ${r.status}` };
    const list = Array.isArray(r.json?.list) ? r.json.list : [];
    return { ok: true, list: list.map(normalizeProcess) };
  }

  async function load(token, pid) {
    const r = await request(`/api/processes/${Number(pid)}/load`, { method: 'POST', token, body: {}, timeout: 20000 });
    return actionResult(r);
  }

  async function unload(token, pid) {
    const r = await request(`/api/processes/${Number(pid)}/unload`, { method: 'POST', token, body: {}, timeout: 20000 });
    return actionResult(r);
  }

  function actionResult(r) {
    if (r.status === 401) return { ok: false, kind: 'unauthorized' };
    if (r.json?.consentRequired) return { ok: false, kind: LOGIN_KIND.CONSENT, message: r.json.message };
    if (r.json?.mustChangePassword) return { ok: false, kind: LOGIN_KIND.MUST_CHANGE, message: r.json.message };
    const ok = Boolean(r.json?.success);
    return {
      ok,
      process: r.json?.process ? normalizeProcess(r.json.process) : null,
      message: r.json?.message || (ok ? '' : `HTTP ${r.status}`)
    };
  }

  return { baseUrl, ping, login, processes, load, unload };
}

/**
 * 把 SnowLuma 的进程条目削成 UI 要的形状。
 * 字段来源：hookManager.listProcesses() → { ...session.toInfo(), account: {uin,nickname}|null }
 * account 为空 = 还没登录（或读不到），此时只能靠 pid 区分。
 */
export function normalizeProcess(p) {
  const acc = p?.account || null;
  return {
    pid: Number(p?.pid) || 0,
    uin: String(acc?.uin || p?.uin || ''),
    nickname: String(acc?.nickname || p?.nickname || ''),
    injected: Boolean(p?.injected),
    loggedIn: Boolean(p?.loggedIn ?? acc),
    status: String(p?.status || ''),
    error: String(p?.error || '')
  };
}

/**
 * 从 SnowLuma 的启动日志里捞"初始登录凭据"。
 *
 * 为什么可行：它首次启动（还没有 config/webui.json 或跳过了改密）时会把
 * `initial credentials: user=admin password=<16位hex>` 打到 stdout —— 那是它
 * **主动展示给用户**的东西，我们只是替用户把眼睛挪过去。
 * 用户改过密码之后日志里就没有了，此时只能请他自己填（本模块不读 webui.json：
 * 里面只有 passwordHash + salt，读了也登不进去，还会让人误以为"我们能破解"）。
 *
 * @param {Array<{text:string}>|string[]} lines 日志行
 * @returns {{user:string, password:string}|null}
 */
export function extractInitialCredentials(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const text = typeof arr[i] === 'string' ? arr[i] : String(arr[i]?.text || '');
    const m = /initial credentials:\s*user=(\S+)\s+password=(\S+)/i.exec(text);
    if (m) return { user: m[1], password: m[2] };
  }
  return null;
}
