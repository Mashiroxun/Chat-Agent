// 外部依赖检测：ffmpeg（≥5，ddagrab 需要）与 Wallpaper Engine。
// 移植自 zcode-beautify（MIT）并按本项目情况改造：
//   - WE 复用插件自己的 resolveWeDir（注册表 + 常见路径），不重复造；
//   - ffmpeg 探测在 PATH 之外额外扫 winget 安装目录 —— winget 装完后
//     PATH 只对新开的进程生效，QQ Agent 这种常驻进程拿不到，必须扫盘。
// 检测永不抛错：缺工具返回 { ok:false, detail } 供 UI 引导。
import fs from 'node:fs';
import os from 'node:os';
import { withinWindow } from '../../elapsed.js';
import path from 'node:path';
import { execFileP } from './exec.js';

const MIN_FFMPEG_MAJOR = 5;
let ffmpegCache = { at: 0, result: null };

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** winget 按用户装包的默认落点（Gyan.FFmpeg 解压后 bin 里有 ffmpeg/ffprobe）。 */
function wingetFfmpegCandidates() {
  const out = [];
  const roots = [
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages'),
    'C:\\ProgramData\\winget\\Packages',
    'C:\\Program Files\\WinGet\\Packages'
  ];
  for (const root of roots) {
    let dirs;
    try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const d of dirs) {
      if (!d.isDirectory() || !/^Gyan\.FFmpeg/i.test(d.name)) continue;
      // 包内还有一层 ffmpeg-<ver>-full_build/bin
      const pkgDir = path.join(root, d.name);
      let inner;
      try { inner = fs.readdirSync(pkgDir, { withFileTypes: true }); } catch { continue; }
      for (const sub of inner) {
        if (!sub.isDirectory()) continue;
        const bin = path.join(pkgDir, sub.name, 'bin', 'ffmpeg.exe');
        if (isFile(bin)) out.push(bin);
      }
    }
  }
  return out;
}

/** winget 的 Links 垫片目录：winget install 装便携包时把 ffmpeg.exe 放这里并写进用户 PATH。 */
function wingetLinksCandidates() {
  return [
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    'C:\\Program Files\\WinGet\\Links\\ffmpeg.exe'
  ].filter(isFile);
}

/**
 * 从注册表现读用户/系统 PATH（常驻进程的 process.env.PATH 是启动时的旧快照，
 * 用户中途装完 ffmpeg 后进程里看不到 —— 现读注册表才能「装完即认，不用重启」）。
 * reg query 对 REG_EXPAND_SZ 给的是未展开原值，手动展开常见变量。
 */
async function registryPathFfmpeg() {
  const keys = [
    ['HKCU\\Environment'],
    ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']
  ];
  const found = [];
  const expand = (v) => v
    .replace(/%USERPROFILE%/gi, os.homedir())
    .replace(/%LOCALAPPDATA%/gi, path.join(os.homedir(), 'AppData', 'Local'))
    .replace(/%APPDATA%/gi, path.join(os.homedir(), 'AppData', 'Roaming'))
    .replace(/%ProgramFiles(X86)?%/gi, 'C:\\Program Files (x86)')
    .replace(/%ProgramW6432%/gi, 'C:\\Program Files')
    .replace(/%ProgramFiles%/gi, 'C:\\Program Files')
    .replace(/%SystemRoot%/gi, process.env.SystemRoot || 'C:\\Windows');
  for (const [key] of keys) {
    try {
      const { stdout } = await execFileP('reg', ['query', key, '/v', 'Path'], { timeout: 5000 });
      const m = /(?:REG_SZ|REG_EXPAND_SZ)\s+(.+)/.exec(stdout);
      if (!m) continue;
      for (let raw of m[1].split(';')) {
        raw = expand(raw.trim().replace(/^"|"$/g, ''));
        if (!raw || raw.includes('%')) continue;   // 展不开的变量：跳过该目录
        const exe = path.join(raw.replace(/[\\/]+$/, ''), 'ffmpeg.exe');
        if (isFile(exe) && !found.includes(exe)) found.push(exe);
      }
    } catch { /* 键不存在 / 没权限 */ }
  }
  return found;
}

async function whereExecutable(name) {
  try {
    const { stdout } = await execFileP('where', [name], { timeout: 5000 });
    return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch { return []; }
}

async function ffmpegVersion(exe) {
  try {
    const { stdout } = await execFileP(exe, ['-version'], { timeout: 8000 });
    const m = /ffmpeg version (\S+)/.exec(stdout);
    if (!m) return undefined;
    const raw = m[1];
    const numeric = raw.replace(/^n/i, '').match(/^(\d+)/);
    if (!numeric) return { raw, major: Number.MAX_SAFE_INTEGER };   // git 构建：按最新算
    return { raw, major: Number(numeric[1]) };
  } catch { return undefined; }
}

/**
 * 找 ffmpeg：环境变量 QQ_AGENT_FFMPEG > 进程 PATH > 注册表 PATH（现读，
 * 装完即认）> WinGet Links 垫片 > winget 包目录扫盘。
 * 命中缓存 60 秒；未命中只缓存 15 秒（用户刚装完回来重试，别让他等）。
 */
export async function checkFfmpeg() {
  const now = Date.now();
  const ttl = ffmpegCache.result?.ok ? 60000 : 15000;
  if (ffmpegCache.result && withinWindow(ffmpegCache.at, ttl, now)) return ffmpegCache.result;
  const override = process.env.QQ_AGENT_FFMPEG;
  const candidates = [
    ...(override && isFile(override) ? [override] : []),
    ...(await whereExecutable('ffmpeg')),
    ...(await registryPathFfmpeg()),
    ...wingetLinksCandidates(),
    ...wingetFfmpegCandidates()
  ];
  let result;
  for (const c of candidates) {
    if (!isFile(c)) continue;
    const v = await ffmpegVersion(c);
    if (!v) continue;
    if (v.major < MIN_FFMPEG_MAJOR) {
      result = { ok: false, path: c, detail: `ffmpeg ${v.raw} 版本过旧，ddagrab 需要 ≥ ${MIN_FFMPEG_MAJOR}.0。请升级：winget upgrade Gyan.FFmpeg` };
      break;
    }
    result = { ok: true, path: c, detail: `ffmpeg ${v.raw}` };
    break;
  }
  if (!result) {
    result = {
      ok: false,
      detail: '这台电脑还没装 ffmpeg（转动态壁纸要用它录制/转码；只需装一次，不影响壁纸系统的其它功能）。\n\n'
        + '最简单装法（约 1 分钟）：\n'
        + '1. 按 Win 键，输入 powershell，回车打开蓝色窗口\n'
        + '2. 粘贴这行命令后回车：winget install Gyan.FFmpeg\n'
        + '3. 等它跑完，回到这里再点一次「转动态壁纸」即可 —— 不用重启 QQ Agent（装完最多等 15 秒）。\n\n'
        + '如果 winget 装完还是提示没找到：可能是 portable 版落点特殊，让帮你装的人设置环境变量 QQ_AGENT_FFMPEG 指向 ffmpeg.exe 的完整路径。'
    };
  }
  ffmpegCache = { at: now, result };
  return result;
}

// ── 硬件视频编码器探测（NVENC > AMF > libx264）─────────────────────────
// 导入/录制是无缝循环的编码环节：libx264 软编码在弱 CPU 机器上要跑满核
// 好几分钟；N 卡 NVENC / A 卡 AMF 硬编码几十秒完事且几乎不占 CPU。
// 探测用「真编三帧」而不是查 -encoders 列表 —— 列表里有 ≠ 驱动能用。
// 结果按进程缓存（每次探测要拉起一次 ffmpeg + 初始化 GPU 编码会话）。
let hwEncoderCache = null;
export async function resolveHwEncoder(ffmpegPath) {
  if (hwEncoderCache) return hwEncoderCache;
  const candidates = [
    { codec: 'h264_nvenc', extra: ['-preset', 'p4', '-rc', 'vbr', '-cq', '20', '-b:v', '0'], label: 'NVIDIA NVENC' },
    { codec: 'h264_amf', extra: ['-quality', 'quality', '-b:v', '20M'], label: 'AMD AMF' },
    { codec: 'libx264', extra: ['-preset', 'veryfast', '-crf', '18'], label: 'CPU libx264' }
  ];
  for (const c of candidates) {
    try {
      await execFileP(ffmpegPath, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.2',
        '-frames:v', '3', '-c:v', c.codec, ...c.extra,
        '-f', 'null', '-'
      ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
      hwEncoderCache = { ...c };
      break;
    } catch { /* 驱动不支持/编码器不存在：试下一个 */ }
  }
  if (!hwEncoderCache) hwEncoderCache = { codec: 'libx264', extra: ['-preset', 'veryfast', '-crf', '18'], label: 'CPU libx264' };
  return hwEncoderCache;
}
