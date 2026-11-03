/**
 * 协议端「一键接入」单测（2026-10-27，R126）
 *
 * 这段逻辑最贵的错误是"注入了错误的号"：机器人会顶着用户的个人 QQ 在群里说话，
 * 而界面还显示一切正常。所以测的重点不是"能不能注入"，而是**判断链**：
 *   · 多个 QQ 在线时必须停下来让用户选，不能自己挑；
 *   · 已经注入了别的号时要认出来（wrong-target），不能当成 ready；
 *   · 切换目标前必须先 unload 旧的，否则两个 OneBot 实例抢 3001。
 *
 * 运行：node --test tests/protocol-onboard.test.mjs   （在 resources/app 目录下）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProtocolOnboard, STAGE } from '../src/protocol-onboard.js';
import { extractInitialCredentials, normalizeProcess, LOGIN_KIND } from '../src/protocol-webui.js';

const proc = (over = {}) => ({
  pid: 100, uin: '10001', nickname: '小号', injected: false, loggedIn: true, status: 'ok', error: '',
  ...over
});

function makeOnboard(over = {}) {
  const calls = { login: [], load: [], unload: [], save: [] };
  const client = {
    login: async (pw) => { calls.login.push(pw); return { ok: true, kind: LOGIN_KIND.OK, token: 'tk', mustChangePassword: false }; },
    processes: async () => ({ ok: true, list: [proc()] }),
    load: async (_t, pid) => { calls.load.push(pid); return { ok: true, process: proc({ pid, injected: true }) }; },
    unload: async (_t, pid) => { calls.unload.push(pid); return { ok: true }; },
    ...(over.client || {})
  };
  const saved = { ...(over.config || {}) };
  const onboard = createProtocolOnboard({
    getConfig: () => ({ protocol: { launcher: { dir: 'D:/sl' }, ...saved } }),
    updateConfig: (patch) => {
      const p = patch?.protocol || {};
      Object.assign(saved, p);
      calls.save.push(p);
      return saved;
    },
    launcher: { status: () => ({ running: true, pid: 999, dir: 'D:/sl' }), logs: () => over.logs || [] },
    client,
    isPortOpen: async () => true,
    emit: () => {},
    log: () => {},
    waitMs: 200,
    ...over.onboard
  });
  return { onboard, calls, saved };
}

// ── 纯函数部分 ─────────────────────────────────────────────────────────────

test('从启动日志里捞初始凭据（它自己打给用户看的）', () => {
  const lines = [
    { text: '08:00:00 INFO [App] SnowLuma starting' },
    { text: '08:00:01 INFO [WebUI] initial credentials: user=admin password=3f9a2c1b8e7d6a5f' },
    { text: '08:00:02 INFO [WebUI] listening http://127.0.0.1:5099' }
  ];
  assert.deepEqual(extractInitialCredentials(lines), { user: 'admin', password: '3f9a2c1b8e7d6a5f' });
  assert.equal(extractInitialCredentials([{ text: 'nothing here' }]), null);
});

test('进程条目归一：account 为 null 时不算已登录', () => {
  const p = normalizeProcess({ pid: 42, injected: true, account: null });
  assert.equal(p.pid, 42);
  assert.equal(p.injected, true);
  assert.equal(p.loggedIn, false);
  assert.equal(p.uin, '');
});

// ── 判断链（最贵的那部分）──────────────────────────────────────────────────

test('decideStage：没有 QQ 进程 → no-qq', () => {
  const { onboard } = makeOnboard();
  assert.equal(onboard.decideStage([], '').stage, STAGE.NO_QQ);
});

test('decideStage：只有一个 QQ → 可以直接注入', () => {
  const { onboard } = makeOnboard();
  const r = onboard.decideStage([proc()], '');
  assert.equal(r.stage, STAGE.CAN_INJECT);
  assert.equal(r.pid, 100);
});

test('decideStage：多个 QQ 且没配过机器人号 → 必须让用户选', () => {
  const { onboard } = makeOnboard();
  const r = onboard.decideStage([proc({ pid: 1, uin: '111' }), proc({ pid: 2, uin: '222' })], '');
  assert.equal(r.stage, STAGE.PICK);
  assert.equal(r.candidates.length, 2);
});

test('decideStage：注入的是别的号 → wrong-target（不能当成 ready）', () => {
  const { onboard } = makeOnboard();
  const r = onboard.decideStage([
    proc({ pid: 1, uin: '111', injected: true }),   // 个人号被注入了
    proc({ pid: 2, uin: '222', injected: false })   // 机器人号没注入
  ], '222');
  assert.equal(r.stage, STAGE.WRONG_TARGET);
  assert.deepEqual(r.injectedUins, ['111']);
});

test('decideStage：目标号已注入 → ready', () => {
  const { onboard } = makeOnboard();
  const r = onboard.decideStage([proc({ pid: 2, uin: '222', injected: true })], '222');
  assert.equal(r.stage, STAGE.READY);
  assert.equal(r.pid, 2);
});

test('decideStage：没配过号但已经注入了 → ready（并标记 unknown）', () => {
  const { onboard } = makeOnboard();
  const r = onboard.decideStage([proc({ injected: true })], '');
  assert.equal(r.stage, STAGE.READY);
  assert.equal(r.unknown, true);
});

// ── 登录与注入流程 ─────────────────────────────────────────────────────────

test('密码优先用日志里的初始凭据，成功后自动存下来', async () => {
  const { onboard, calls, saved } = makeOnboard({
    logs: [{ text: 'initial credentials: user=admin password=abcdef1234567890' }]
  });
  const r = await onboard.connect({});
  assert.equal(r.ok, true);
  assert.deepEqual(calls.login, ['abcdef1234567890']);
  assert.equal(saved.webui.password, 'abcdef1234567890', '下次启动不用再找密码');
});

test('用户输入的密码优先于日志里的初始凭据', async () => {
  const { onboard, calls } = makeOnboard({
    logs: [{ text: 'initial credentials: user=admin password=old-from-log' }]
  });
  await onboard.connect({ password: 'my-own-password' });
  assert.equal(calls.login[0], 'my-own-password');
});

test('密码错误 → need-password，且不注入任何东西', async () => {
  const { onboard, calls } = makeOnboard({
    client: { login: async () => ({ ok: false, kind: LOGIN_KIND.REJECTED, message: '密码错误' }) }
  });
  const r = await onboard.connect({ password: 'wrong' });
  assert.equal(r.ok, false);
  assert.equal(r.stage, STAGE.NEED_PASSWORD);
  assert.deepEqual(calls.load, []);
});

test('被锁（429）→ 停在 locked，不继续试密码', async () => {
  const attempts = [];
  const { onboard } = makeOnboard({
    client: {
      login: async (pw) => {
        attempts.push(pw);
        return { ok: false, kind: LOGIN_KIND.LOCKED, message: '登录尝试过多，请 900 秒后重试' };
      }
    }
  });
  const r = await onboard.connect({ password: 'x' });
  assert.equal(r.stage, STAGE.LOCKED);
  assert.equal(attempts.length, 1, '锁定后再换密码重试只会越锁越久');
  // 退避窗口内再查状态，也不应该再发登录请求
  await onboard.status();
  assert.equal(attempts.length, 1, 'status() 不能把退避窗口顶掉');
});

test('要求先改密码 → must-change（这一步必须用户自己去控制台）', async () => {
  const { onboard, calls } = makeOnboard({
    client: { login: async () => ({ ok: true, kind: LOGIN_KIND.OK, token: 'tk', mustChangePassword: true }) }
  });
  const r = await onboard.connect({ password: 'init' });
  assert.equal(r.stage, STAGE.MUST_CHANGE);
  assert.deepEqual(calls.load, [], '没改密码前不能继续注入');
});

test('切换目标：先把已注入的另一个号卸掉，再注入目标', async () => {
  const { onboard, calls } = makeOnboard({
    config: { webui: { password: 'pw' }, lastUin: '222' },
    client: {
      processes: async () => ({
        ok: true,
        list: [proc({ pid: 1, uin: '111', injected: true }), proc({ pid: 2, uin: '222' })]
      })
    }
  });
  const r = await onboard.connect({});
  assert.equal(r.ok, true);
  assert.deepEqual(calls.unload, [1]);
  assert.deepEqual(calls.load, [2]);
});

test('注入成功后记住这个号（下次用来判断"是不是机器人号"）', async () => {
  const { onboard, saved } = makeOnboard({
    config: { webui: { password: 'pw' } },
    client: {
      processes: async () => ({ ok: true, list: [proc({ pid: 7, uin: '777' })] })
    }
  });
  await onboard.connect({});
  assert.equal(saved.lastUin, '777');
});

test('指定 pid 时优先用它（用户在列表里选的）', async () => {
  const { onboard, calls } = makeOnboard({
    config: { webui: { password: 'pw' } },
    client: {
      processes: async () => ({ ok: true, list: [proc({ pid: 1, uin: '111' }), proc({ pid: 2, uin: '222' })] })
    }
  });
  await onboard.connect({ pid: 2 });
  assert.deepEqual(calls.load, [2]);
});

test('status：目录没配 → no-dir；进程没跑 → stopped', async () => {
  const a = makeOnboard({
    onboard: {
      getConfig: () => ({ protocol: { launcher: { dir: '' } } }),
      launcher: { status: () => ({ running: false, dir: '' }), logs: () => [] }
    }
  });
  assert.equal((await a.onboard.status()).stage, STAGE.NO_DIR);

  const b = makeOnboard({
    onboard: {
      getConfig: () => ({ protocol: { launcher: { dir: 'D:/sl' } } }),
      launcher: { status: () => ({ running: false, dir: 'D:/sl' }), logs: () => [] },
      isPortOpen: async () => false
    }
  });
  assert.equal((await b.onboard.status()).stage, STAGE.STOPPED);
});

test('status 走通一遍：单个 QQ → can-inject，且带上目标昵称', async () => {
  const { onboard } = makeOnboard({ config: { webui: { password: 'pw' } } });
  const s = await onboard.status();
  assert.equal(s.stage, STAGE.CAN_INJECT);
  assert.equal(s.target.nickname, '小号');
});
