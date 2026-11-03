// 壁纸 id 校验放宽为 Unicode 感知（2026-10-27，R150）：
// 本地导入（myprojects）的 WE 壁纸目录名**经常是中文**，旧正则 [a-zA-Z0-9._-]
// 直接拒绝，三连后果：
//   1. /api/wallpaper/file 恒 "非法的壁纸 id" —— 选中了也铺不出来；
//   2. 保存状态时 canonicalize 失败 → stateSave 把后端镜像 wallpaper-state.json 删掉；
//   3. 兜底恢复腿（控制台重启对齐镜像）随之失效 —— 群友反馈的"重启后壁纸消失"。
// 修法：ID_RE 放宽到 Unicode 字母/数字（id 只作 Map 键与 URL 参数，从不拼路径）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-wp-id-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const core = await import('../src/wallpaper/core.js');
core.setup({ config: () => ({}), log: () => {} });

test('file: 中文目录名的本地壁纸 id 不再被拒（非法→改为正常的不存在语义）', async () => {
  const bad = await core.providers['wallpaper.file']({ id: 'm我的壁纸', kind: 'preview' });
  // 格式合法但库里没有（测试机没装 WE）→ 走到"不存在"，而不是"非法"
  assert.equal(bad.error, '壁纸不存在或已卸载');
  const evil = await core.providers['wallpaper.file']({ id: 'm..\\evil', kind: 'preview' });
  assert.equal(evil.error, '非法的壁纸 id');   // 路径分隔符仍拒
  const ctl = await core.providers['wallpaper.file']({ id: 'm\u0000x', kind: 'preview' });
  assert.equal(ctl.error, '非法的壁纸 id');    // 控制字符仍拒
});

test('state.set: 中文 id 的配置能写入镜像（不再被 canonicalize 清成 null）', async () => {
  const r = await core.providers['wallpaper.state.set']({ cfg: { id: 'm我的壁纸', title: '测试', kind: 'still' } });
  assert.equal(r.ok, true);
  assert.equal(r.cfg?.id, 'm我的壁纸');
  const onDisk = JSON.parse(fs.readFileSync(path.join(TMP, 'wallpaper-state.json'), 'utf8'));
  assert.equal(onDisk.id, 'm我的壁纸');
});

test('state.set: 工坊数字 id（既有形态）不受影响', async () => {
  const r = await core.providers['wallpaper.state.set']({ cfg: { id: 'w123456789', title: 'WE', kind: 'still' } });
  assert.equal(r.cfg?.id, 'w123456789');
});

test('state.set: 显式 null 仍清空镜像（关闭壁纸的合法路径）', async () => {
  await core.providers['wallpaper.state.set']({ cfg: null });
  assert.equal(fs.existsSync(path.join(TMP, 'wallpaper-state.json')), false);
});
