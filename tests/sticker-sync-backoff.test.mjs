// 表情收藏同步的「可诊断性 + 异常降频」契约（2026-11-11，反馈第 10 条）。
//
// 反馈原文：1015 行 `收藏同步：本次拿到 0 条（请求 500）`，被误读成 1015 次
// HTTP 500。真实含义是「每次问 500 条、拿到 0 条」。这条反馈里有两处与归属
// 无关、本来就该改的地方：
//   ① 日志只写条数，不写协议端返回的**形状** → 无法判断是收藏为空还是接口没实现
//   ② 固定 60 秒重试，异常时堆出上千行 → 要降频，且只在第一次与降频动作时提示
// 本文件锁死这两条，以及"恢复正常后必须撤销降频"。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-sticker-sync-'));
process.env.QQ_AGENT_DATA_DIR = TMP;
fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({ version: 1 }), 'utf8');

const { describeStickerPayload } = await import('../plugins/sticker/lib/stickers.js');
const { StickerManager } = await import('../plugins/sticker/lib/manager.js');

after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

/** 造一个只实现 StickerManager 需要的方法的 api 宿主。 */
function makeApi(handler) {
  const logs = [];
  let calls = 0;
  return {
    api: {
      config: () => ({ enabled: true, promptMaxStickers: 10 }),
      log: (s) => logs.push(String(s)),
      warn: () => {},
      qqCall: async (action, params) => {
        calls += 1;
        return handler(action, params, calls);
      }
    },
    logs,
    getCalls: () => calls
  };
}

/** 绕过 60 秒 TTL，但仍受降频窗口约束（force 会连降频一起绕过，这里不用）。 */
function syncFresh(mgr) {
  mgr.syncedAt = 0;
  return mgr.sync(false);
}

const ONE_STICKER = [{ emoji_id: 'abc123', name: '笑' }];

test('describeStickerPayload：四种关键形状能区分开', () => {
  assert.equal(describeStickerPayload([]), '数组(0)');
  assert.equal(describeStickerPayload(null), 'null');
  assert.equal(describeStickerPayload(undefined), 'undefined');
  assert.match(describeStickerPayload({ code: 0, data: [] }), /data=数组\(0\)/);
  assert.match(describeStickerPayload({ code: 0 }), /data=缺失/);
  assert.match(describeStickerPayload({ code: 0, data: null }), /data=null/);
  assert.match(describeStickerPayload({ data: { total: 0 } }), /data=对象\{total\}/);
  assert.match(describeStickerPayload({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }), /共 7 键/);
});

test('拿到 0 条：日志写明「0 条」和协议端返回形状，不再只有数字', async () => {
  const { api, logs } = makeApi(() => []);
  const mgr = new StickerManager(api);

  const r = await syncFresh(mgr);

  assert.equal(r.fromCache, false, '空数组仍算一次成功同步');
  const line = logs.find((l) => l.includes('拿到 0 条'));
  assert.ok(line, `应有一条 0 条诊断日志，实际：${JSON.stringify(logs)}`);
  assert.match(line, /数组\(0\)/, '必须带上协议端返回的形状');
  assert.match(line, /请求 500/, '保留请求条数，才能看出 500 是常量不是状态码');
  assert.match(line, /未实现 fetch_custom_face_detail|收藏为空/, '给一句可操作的判断方向');
});

test('连续 3 次空结果后降频：第 4 次不再打协议端', async () => {
  const { api, getCalls } = makeApi(() => []);
  const mgr = new StickerManager(api);

  for (let i = 0; i < 3; i++) await syncFresh(mgr);
  const beforeCalls = getCalls();
  assert.equal(beforeCalls, 3);
  assert.ok(mgr.backoffUntil > Date.now(), '第 3 次后应进入降频窗口');

  const r = await syncFresh(mgr);
  assert.equal(r.backoff, true, '降频窗口内应直接返回快照');
  assert.equal(getCalls(), beforeCalls, '降频窗口内不能再打协议端');
});

test('降频后 force=true 仍可立刻重试（查看器刷新 / 刚收藏）', async () => {
  const { api, getCalls } = makeApi(() => []);
  const mgr = new StickerManager(api);
  for (let i = 0; i < 3; i++) await syncFresh(mgr);
  const beforeCalls = getCalls();

  await mgr.sync(true);

  assert.equal(getCalls(), beforeCalls + 1, 'force 必须绕过降频');
});

test('拿到数据后降频撤销、状态归零', async () => {
  let payload = [];
  const { api, logs } = makeApi(() => payload);
  const mgr = new StickerManager(api);
  for (let i = 0; i < 3; i++) await syncFresh(mgr);
  assert.ok(mgr.backoffUntil > 0);

  payload = ONE_STICKER;
  await mgr.sync(true);   // 恢复这一发

  assert.equal(mgr.emptyStreak, 0);
  assert.equal(mgr.backoffUntil, 0);
  assert.equal(mgr.backoffLogged, false);
  assert.ok(logs.some((l) => l.includes('已恢复')), `应有恢复日志，实际：${JSON.stringify(logs)}`);

  // 恢复后立刻又能正常同步，不再被降频挡住
  const r = await syncFresh(mgr);
  assert.equal(r.backoff, undefined);
  assert.equal(r.fromCache, false);
});

test('调用失败不再静默：日志有失败原因，且同样会降频', async () => {
  const { api, logs, getCalls } = makeApi(() => { throw new Error('fetch_custom_face_detail 失败：retcode=100'); });
  const mgr = new StickerManager(api);

  const r = await syncFresh(mgr);

  assert.equal(r.fromCache, true);
  assert.match(r.error, /retcode=100/, 'error 要原样回给查看器');
  const line = logs.find((l) => l.includes('收藏同步失败'));
  assert.ok(line, `失败必须有日志，实际：${JSON.stringify(logs)}`);
  assert.match(line, /retcode=100/);

  for (let i = 0; i < 2; i++) await syncFresh(mgr);
  const beforeCalls = getCalls();
  const blocked = await syncFresh(mgr);
  assert.equal(blocked.backoff, true, '连续失败也要进降频');
  assert.equal(getCalls(), beforeCalls);
});

test('日志节流：连续 6 次空结果最多 3 行（首条 + 降频提示）', async () => {
  const { api, logs } = makeApi(() => []);
  const mgr = new StickerManager(api);
  for (let i = 0; i < 6; i++) {
    await syncFresh(mgr);
    mgr.backoffUntil = 0;   // 手动清掉降频，模拟"每轮都真的打了协议端"
  }
  const zeroLines = logs.filter((l) => l.includes('拿到 0 条'));
  assert.ok(zeroLines.length <= 3, `不做节流会刷 6 行，实际 ${zeroLines.length} 行`);
  assert.ok(logs.some((l) => l.includes('已自动降频')), '降频动作要提示一次');
});
