// headless 数据目录解析（2026-11-11 反馈核查补）。
//
// 问题：桌面版 electron/main.js 的 resolveDataDir() 把数据放在
//   <安装目录>/data（exe 同级），而 headless 的 src/config.js 默认是
//   ROOT/data = <安装目录>/resources/app/data。
// 同一个安装包因此有两套 config / sessions / memory / plugins-data，
// 用 headless 排查时看到的是「插件没了、记忆空了」，其实是读错目录。
//
// 本模块只做纯解析，不写盘、不碰 config.js（那样会把 DATA_DIR 提前固化）。
// 调用方必须在动态 import app.js 之前把结果写进 process.env。
import path from 'node:path';
import fs from 'node:fs';
import { dataDirName } from './profile.js';

/**
 * @param {string} appRoot  <安装目录>/resources/app 或开发态项目根目录
 * @param {{env?: object, exists?: (p: string) => boolean}} [opts]
 * @returns {{dir: string, source: string, warning: string}}
 */
export function resolveHeadlessDataDir(appRoot, { env = process.env, exists = (p) => fs.existsSync(p) } = {}) {
  // 显式覆盖永远优先（多开、systemd、用户自己搬过数据都靠它）
  const override = String(env.QQ_AGENT_DATA_DIR || '').trim();
  if (override) return { dir: override, source: 'env', warning: '' };

  const name = dataDirName();                       // 含 QQ_AGENT_PROFILE 后缀
  const legacy = path.join(appRoot, name);          // resources/app/data
  const parent = path.dirname(appRoot);             // <安装目录>/resources
  const packaged = path.basename(parent).toLowerCase() === 'resources';

  // 开发态（直接 node src/server.js 跑项目根目录）本来就该用项目内 data/，
  // 桌面版开发态也是这么解析的，不存在「两套目录」。
  if (!packaged) return { dir: legacy, source: 'dev', warning: '' };

  const portable = path.join(path.dirname(parent), name); // <安装目录>/data

  // 兼容回退：桌面版目录不存在、而旧 headless 目录里确实有数据时，
  // 不擅自换家（否则用户一升级 headless 就「数据全没了」），只给一条明确提示。
  if (!exists(portable) && exists(legacy)) {
    return {
      dir: legacy,
      source: 'legacy-headless',
      warning: `旧 headless 数据目录 ${legacy} 里有数据，而桌面版目录 ${portable} 不存在；本次继续沿用旧目录以免数据突然消失。要与桌面版共用，请把旧目录整体合并到 ${portable}，或显式设置 QQ_AGENT_DATA_DIR。`
    };
  }
  // 正常打包形态：与桌面版对齐（桌面版目录已存在，或两边都没有 → 新建到同一处）
  return { dir: portable, source: 'portable', warning: '' };
}
