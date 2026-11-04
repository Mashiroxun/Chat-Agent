// API 路由表：把 handleHttp 的巨型 if-else 链拆成声明式路由。
//
// 每个路由：{ method, pattern, handler }
//   - method: 'GET' | 'POST' | 'PUT' | 'DELETE' | '*'（'*' 匹配任意方法）
//   - pattern: 字符串（精确匹配）或 RegExp（exec 捕获组传给 handler）
//   - handler: async (ctx) => 结果
//       ctx = { req, res, url, pathname, method, match, body?, ...deps }
//       handler 返回 undefined 表示"已自行写响应"（如 SSE）；否则框架统一 json() 返回。
//
// ── 文件结构（2026-11-04 拆分，R164）────────────────────────────────────────
// 本文件只负责**聚合与顺序**，具体路由按业务域放在 src/routes/ 下：
//
//   doctor.js    /api/doctor/*                       自检与体检
//   forge.js     /api/forge/*                        扩展锻造
//   dev.js       /api/dev/*                          开发工单
//   bundle.js    migrate / bundle / reset-data …     数据管理
//   providers.js providers / api-key / vision …      模型与服务商
//   protocol.js  protocol / qq-portable / onebot …   协议端
//   market.js    market / persona-* / community …    市场与人设
//   skills.js    skills / tools / config / plugin-tool
//   sessions.js  sessions / chats / memory-files …   会话与存档
//   system.js    composition / status / usage / logs 系统状态
//   fix.js       /api/fix/*                          自动修复
//   wallpaper.js /api/wallpaper/*                    壁纸
//
// 拆分前的单文件 5248 行 createRoutes 闭包已拆散：跨域共享的 bodyOf /
// skillRuntimeContext / createForgeProgress 等沉淀在 src/routes/_shared.js。
// 新增路由请放进对应的域文件，**不要再往本文件里堆规则** —— 这个文件保持
// 「只有装配、没有业务」是这次重构唯一的长期约束。
//
// 依赖（store/memory/sessions/onebot/orchestrator/…）通过 createRoutes(deps) 注入，
// 各域模块再从 deps 解构，避免在 app.js 里反复传参。

import { makeBodyOf, makeCreateForgeProgress, skillRuntimeContext } from './routes/_shared.js';
import { doctorRoutes } from './routes/doctor.js';
import { forgeRoutes } from './routes/forge.js';
import { devRoutes } from './routes/dev.js';
import { bundleRoutes } from './routes/bundle.js';
import { providersRoutes } from './routes/providers.js';
import { protocolRoutes } from './routes/protocol.js';
import { marketRoutes } from './routes/market.js';
import { skillsRoutes } from './routes/skills.js';
import { sessionsRoutes } from './routes/sessions.js';
import { systemRoutes } from './routes/system.js';
import { fixRoutes } from './routes/fix.js';
import { wallpaperRoutes } from './routes/wallpaper.js';

/**
 * 构建路由表。
 * @param {object} deps 依赖注入
 */
export function createRoutes(deps) {
  const { readBody, emit, log } = deps;

  // 跨域共享件：只构造一次，各域模块共用同一个实例。
  // （bodyOf 依赖注入的 readBody；createForgeProgress 依赖 emit 推 SSE。）
  const shared = {
    bodyOf: makeBodyOf(readBody),
    skillRuntimeContext,
    createForgeProgress: makeCreateForgeProgress(emit)
  };

  // 启动组合信息（0.4.9.3）：/api/composition 用它回答"这个行为是谁提供的"。
  // 只暴露 id / order / 组件键，**不暴露模块路径**（层目录结构属于本机信息）。
  const compositionComponents = deps.components ?? {};
  const compositionReport = deps.composition ?? null;

  // 顺序说明：dispatch 是线性匹配（app.js 逐条 exec/test），同 pattern 先匹配先赢。
  // 下面的拼接顺序与拆分前路由表的相对顺序一致；同域路由被聚到一起，
  // 但各条 pattern 之间没有通配重叠（全是精确字符串或锚定正则），顺序不影响匹配结果。
  //
  // /api/composition 留在聚合器里而不是 system.js：它是"启动组合归属查询"，
  // 与下面 console.routes 的合并逻辑是同一件事的两面；同时保证它仍是第一条
  // （拆分前的位置），拼接后路由顺序与原表逐条一致。
  const builtinRoutes = [
    // ── 启动组合归属查询（0.4.9.3）──────────────────────────────────────
    // 层一多就会问"这条提示词是出厂实现还是我的层在起作用"，这个接口回答它。
    {
      method: 'GET', pattern: '/api/composition',
      handler: async ({ res, json }) => {
        const ownerByKey = new Map();   // 组件键 -> 提供它的层 id
        const layers = [];
        if (compositionReport && Array.isArray(compositionReport.layers)) {
          for (const layer of compositionReport.layers) {
            const keys = Array.isArray(layer.components) ? layer.components : [];
            const enabled = layer.enabled !== false;
            layers.push({ id: layer.id, order: layer.order, enabled, components: keys });
            if (enabled) for (const key of keys) ownerByKey.set(key, layer.id);
          }
        }
        const components = {};
        for (const key of Object.keys(compositionComponents).sort()) {
          const owner = ownerByKey.get(key);
          components[key] = { owner: owner ? `layer:${owner}` : 'default' };
        }
        const errors = Array.isArray(compositionReport?.errors)
          ? compositionReport.errors.map((item) => ({ dir: item.dir, key: item.key ?? null, error: item.error }))
          : [];
        return json(res, 200, {
          ok: true,
          // 只列被层覆盖的键；未覆盖的走 default，不逐个罗列以免刷屏
          layers,
          overridden: Object.entries(components).filter(([, v]) => v.owner !== 'default').map(([k]) => k),
          components,
          errors,
        });
      }
    },
    ...doctorRoutes(deps, shared),
    ...forgeRoutes(deps, shared),
    ...devRoutes(deps, shared),
    ...bundleRoutes(deps, shared),
    ...providersRoutes(deps, shared),
    ...protocolRoutes(deps, shared),
    ...marketRoutes(deps, shared),
    ...skillsRoutes(deps, shared),
    ...sessionsRoutes(deps, shared),
    ...systemRoutes(deps, shared),
    ...fixRoutes(deps, shared),
    ...wallpaperRoutes(deps, shared),
  ];

  // ── 启动组合（0.4.9.3）：console.routes 可以追加路由表 ──────────────────
  // 组件签名：(deps) => Array<{ method, pattern, handler }>
  // 返回的条目排在**内置路由前面**，所以同 pattern 的层路由会先匹配到，
  // 等于可以覆盖某条内置接口；只声明新 pattern 时就是纯追加。
  // 校验从严：形状不对整批忽略并留痕，不让半张表悄悄生效。
  const routeLayer = compositionComponents['console.routes'];
  if (typeof routeLayer !== 'function') return builtinRoutes;
  let extra;
  try {
    extra = routeLayer(deps);
  } catch (error) {
    log?.(`[composition] console.routes 层执行失败，已忽略：${error?.message ?? error}`);
    return builtinRoutes;
  }
  if (!Array.isArray(extra) || !extra.length) return builtinRoutes;
  // 形状校验：pattern 可以是字符串（精确匹配）或正则（exec），与内置路由一致。
  const valid = extra.filter((item) => item
    && (typeof item.pattern === 'string' || item.pattern instanceof RegExp)
    && typeof item.handler === 'function');
  if (valid.length !== extra.length) {
    log?.(`[composition] console.routes 有 ${extra.length - valid.length} 条形状不合法，已跳过`);
  }
  return [...valid, ...builtinRoutes];
}
