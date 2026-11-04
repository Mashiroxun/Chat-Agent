// 路由域：壁纸：列表 / 取文件 / 状态 / 导入
//
// 本文件由 src/routes.js 拆分而来（2026-11-04，R164）。**handler 代码逐字节原样搬运**，
// 只换了所在文件与函数外壳 —— 拆分的目的只是把 5248 行的单一函数按域切开，
// 不改任何一条路由的行为。新增路由请按域放进对应文件，不要再往 routes.js 里堆。
import fs from 'node:fs';
import path from 'node:path';
import { skillManager } from '../skills/manager.js';
// 探测结果的"可对外"视图：删掉两枚令牌，只留有无标记。
// 令牌不越过 HTTP 边界的保证在这个纯函数里，路由只负责调它。

export function wallpaperRoutes(deps, shared) {
  const {
    store, memory, sessions, onebot, orchestrator,
    emit, log,
    // app.js 内部的过程/状态
    localVersion, compareSemver, UPDATE_INFO_URL,
    sanitizeConfig, keyEndpointAllowed, sanitizeProvider,
    // r92：删掉 authorize 的死解构 —— 本文件从未用它，鉴权实际在 app.js
    // 统一执行。留着它会误导后来者以为某条路由漏鉴权。
    readBody,
    qqPortableStatus, qqPortableLogs, launchPortableQQ, stopPortableQQ,
    showPortableQQ, setupPortableQQFromLocal,
    visionScan,
    buildUsageStats, buildUsageBreakdown,
    reloadSkills,
    // 协议端配置探测（见 app.js autoFillProtocol）
    autoFillProtocol, detectProtocol,
    // 协议端进程托管（无窗口启动 + 日志，见 src/protocol-launcher.js）
    protocolLauncher,
    // 协议端「一键接入」向导（登录控制台 → 挑号 → 注入，见 src/protocol-onboard.js）
    protocolOnboard
  } = deps;
  const { bodyOf } = shared;

  return [
    {
      // 控制台「壁纸」页：壁纸列表。
      method: 'GET', pattern: '/api/wallpaper/list',
      handler: async ({ res, json }) => {
        const fn = skillManager.getCapabilityProviders('wallpaper.library', {})[0]?.fn || null;
        if (!fn) return json(res, 404, { ok: false, error: '壁纸模块未加载（内置模块 src/wallpaper）。改过它的代码的话重启一次 QQ Agent。' });
        try {
          return json(res, 200, await fn());
        } catch (error) {
          return json(res, 500, { ok: false, error: `壁纸列表失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 壁纸文件伺服：只按 id 取模块扫描时登记过的文件（不接受请求方提供的任何路径）。
      // 视频必须支持 Range（206）：Chromium <video> 的分段缓冲/拖进度条都依赖它，
      // 否则大视频起播慢、拖动直接卡死。GET/HEAD 之外的动词一律 405。
      method: '*', pattern: '/api/wallpaper/file',
      handler: async ({ req, res, url, json }) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return json(res, 405, { ok: false, error: 'method not allowed' });
        }
        const fn = skillManager.getCapabilityProviders('wallpaper.file', {})[0]?.fn || null;
        if (!fn) return json(res, 404, { ok: false, error: '壁纸模块未加载（内置模块 src/wallpaper）' });
        let r;
        try {
          r = await fn({
            id: url.searchParams.get('id') || '',
            kind: url.searchParams.get('kind') === 'preview' ? 'preview' : 'media'
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: `壁纸文件定位失败：${String(error?.message ?? error)}` });
        }
        if (!r?.ok || !r.path) return json(res, 404, { ok: false, error: r?.error || '文件不存在' });
        let st;
        try { st = fs.statSync(r.path); } catch { return json(res, 404, { ok: false, error: '文件不存在' }); }
        // 缓存策略分两类：
        //   预览图 —— 内容随 id 不变，缓存一天（启动秒出、缩略图不重下）。
        //   媒体（视频/循环）—— 同一 URL 会在「转动态」后换成另一个文件
        //     （4K 原片 → 1080p 循环），max-age 会让播放器一直拿缓存的旧片
        //     最长一天！改 no-cache + ETag：内容没变 304（缓存照用，只多一次
        //     回环确认），变了立刻拿新文件。
        const isMedia = url.searchParams.get('kind') !== 'preview';
        const etag = `"${st.size}-${Math.round(st.mtimeMs)}"`;
        const base = {
          'content-type': r.contentType || 'application/octet-stream',
          'accept-ranges': 'bytes',
          ...(isMedia
            ? { 'cache-control': 'no-cache', etag }
            : { 'cache-control': 'private, max-age=86400' })
        };
        if (isMedia && req.headers['if-none-match'] === etag) {
          res.writeHead(304, { etag });
          res.end();
          return;
        }
        // 流式响应。两个错误口都要堵住：流读失败、客户端中途关连接（拖动视频时常见）——
        // 不处理的话 unhandled 'error' 会走进程级 uncaughtException 直接退出整个应用。
        const sendStream = (opts) => {
          const stream = fs.createReadStream(r.path, opts);
          stream.on('error', () => { try { res.destroy(); } catch { /* 已断开 */ } });
          res.on('close', () => { try { stream.destroy(); } catch { /* 已结束 */ } });
          stream.pipe(res);
        };
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
        if (m && (m[1] !== '' || m[2] !== '')) {
          let start;
          let end;
          if (m[1] === '') {
            // 后缀区间 "-N"：取最后 N 字节
            const n = parseInt(m[2], 10);
            if (!Number.isFinite(n) || n <= 0) {
              res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return;
            }
            start = Math.max(0, st.size - n);
            end = st.size - 1;
          } else {
            start = parseInt(m[1], 10);
            end = m[2] === '' ? st.size - 1 : parseInt(m[2], 10);
          }
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= st.size || end >= st.size) {
            res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return;
          }
          res.writeHead(206, {
            ...base,
            'content-range': `bytes ${start}-${end}/${st.size}`,
            'content-length': end - start + 1
          });
          if (req.method === 'HEAD') { res.end(); return; }
          sendStream({ start, end });
          return;
        }
        res.writeHead(200, { ...base, 'content-length': st.size });
        if (req.method === 'HEAD') { res.end(); return; }
        sendStream({});
        return;
      }
    },
    {
      // 壁纸当前状态：控制台每次保存会 POST 一份镜像过来；GET 供控制台
      // 启动时对齐（机器人改过壁纸时以远端为准）。这里只做能力中介，
      // 不广播事件 —— 控制台改状态自己已生效，广播是 wallpaper-chat 部分的事。
      method: '*', pattern: '/api/wallpaper/state',
      handler: async ({ req, res, json }) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
          return json(res, 405, { ok: false, error: 'method not allowed' });
        }
        const cap = (name) => skillManager.getCapabilityProviders(name, {})[0]?.fn || null;
        const get = cap('wallpaper.state.get');
        if (!get) return json(res, 404, { ok: false, error: '壁纸模块未加载（内置模块 src/wallpaper）' });
        try {
          if (req.method === 'GET') return json(res, 200, await get());
          const body = await bodyOf(req);
          const set = cap('wallpaper.state.set');
          if (!set) return json(res, 404, { ok: false, error: '壁纸模块未加载（内置模块 src/wallpaper）' });
          return json(res, 200, await set({ cfg: body }));
        } catch (error) {
          return json(res, 500, { ok: false, error: `壁纸状态读写失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 动态壁纸导入：POST {id} 启动任务（一次一个，WE 渲染窗独占），
      // GET ?job= 轮询进度。场景导入会短暂弹出渲染窗口属正常现象。
      method: '*', pattern: '/api/wallpaper/import',
      handler: async ({ req, res, url, json }) => {
        if (req.method !== 'GET' && req.method !== 'POST') {
          return json(res, 405, { ok: false, error: 'method not allowed' });
        }
        const cap = (name) => skillManager.getCapabilityProviders(name, {})[0]?.fn || null;
        try {
          if (req.method === 'GET') {
            const fn = cap('wallpaper.import.status');
            if (!fn) return json(res, 404, { ok: false, error: '壁纸模块未加载（内置模块 src/wallpaper）' });
            return json(res, 200, await fn({ job: url.searchParams.get('job') || '' }));
          }
          const fn = cap('wallpaper.import.start');
          if (!fn) return json(res, 404, { ok: false, error: '壁纸模块未加载（内置模块 src/wallpaper）' });
          const body = await bodyOf(req);
          // redo=true：先清掉该壁纸的缓存循环再导入（成品坏了重录的入口）
          if (body?.redo) {
            const redoFn = cap('wallpaper.import.redo');
            if (!redoFn) return json(res, 404, { ok: false, error: '壁纸模块未加载（内置模块 src/wallpaper）' });
            const r = await redoFn({ id: body?.id });
            if (!r?.ok) return json(res, 409, r);
          }
          return json(res, 200, await fn({ id: body?.id }));
        } catch (error) {
          return json(res, 500, { ok: false, error: `动态壁纸导入失败：${String(error?.message ?? error)}` });
        }
      }
    },
  ];
}
