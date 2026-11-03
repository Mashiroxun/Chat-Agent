// 桌宠「直接对话」—— 一条**只属于主人**的会话（2026-10-24）。
//
// ── 这条会话是什么 ────────────────────────────────────────────────────────
//   chatKey = `private:<机器人自己的 QQ 号>`。主人就是这个 QQ 号的使用者，
//   和"自己"私聊在 QQ 里天然只有主人能进来 —— 群里任何人都在看，这条只有你能说。
//   数字 ID 能被所有既有链路吃下（存档文件名、控制台会话页的 `^(group|private):(\d+)$`
//   解析、私聊恒响应档位），不需要为它改任何正则。
//
// ── 为什么走真实流水线而不是自己拼一个对话 ─────────────────────────────────
//   自己拼人设/历史/工具的那一版，桌面上的它和群里的它不是同一个：人设一样，
//   但它看不到这个会话自己的历史、不按私聊恒响应档位决定带多少上下文、
//   也没有 send_message / 发表情那套工具。所以：
//     · 你说的话以「主人」身份 `store.appendIncoming` 进这条会话的存档
//       （和真实入站同一个入口，控制台会话页/对话审查看得到，历史跨重启保留）；
//     · 然后跑一次**完整的真实唤醒** —— 同一份人设、这条会话自己的历史、
//       同一套记忆与工具、同一份表情包策略、同一个上下文预算；
//     · 这一轮的发送被 capture sender 接住：不落 OneBot（没有群可发）。
//       2026-10-24 修「重启后回复全消失」：捕获回复原来**只在内存里**，重启即空 ——
//       窗口里就只剩你说的话（实测翻车）。现在本模块在收到捕获回复后，
//       按真实 QQ 出站同一条链路（`store.appendSelf`，同一套文本标签）把它
//       写进这条专属会话的存档，跨重启保留；本进程内仍用内存版渲染
//       （表情带原图），存档里的文本标签按条目 id 跳过、不画两条。
//
// ── 依赖注入 ─────────────────────────────────────────────────────────────
//   orchestrator / store / catalog / image / stateFile / selfId 都能从外部传
//   （tests/pet-chat.test.mjs 靠这个脱机跑完整链路），生产路径全用默认值。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { logger } from './logger.js';
import { atomicWriteJson } from './atomic-write.js';
import { skillManager } from './skills/manager.js';
import { CONSOLE_SENDER_ID } from './orchestrator.js';

const MAX_TEXT = 2000;        // 单条输入上限
const MAX_FILES = 8;          // 一条消息最多带几个附件（与 orchestrator 的 ATTACH_MAX_FILES 对齐）
const HISTORY_LIMIT = 60;     // 窗口里回看多少条真实存档
const OWNER_LABEL = '私聊 · 主人';
// 状态文件版本。v2 起"默认会话"从"最近活跃的群"改成"只属于主人的会话" ——
// 用户明确反馈过不想把话塞进别的群，所以旧选择（群）一次性作废，不留隐患。
const STATE_VERSION = 2;

/** 表情目录：{id, desc, note, tags, usage, useCount}（不含图片字节）。 */
function catalogViaSkill(limit = 30, query = '') {
  try {
    const p = skillManager.getCapabilityProviders('sticker.catalog', {})[0];
    if (!p) return [];
    const out = p.fn({ query, limit });
    return Array.isArray(out?.items) ? out.items : [];
  } catch (error) {
    logger.warn('pet-chat', `取表情目录失败：${String(error?.message ?? error)}`);
    return [];
  }
}

/** 单张表情 → data URL。读不到就返回空串（界面会显示"［表情］"占位）。 */
async function imageViaSkill(id) {
  try {
    const p = skillManager.getCapabilityProviders('sticker.image', {})[0];
    if (!p) return '';
    const out = await p.fn({ id, maxBytes: 2 * 1024 * 1024 });
    return out?.ok && typeof out.dataUrl === 'string' ? out.dataUrl : '';
  } catch (error) {
    logger.warn('pet-chat', `取表情图片失败（${id}）：${String(error?.message ?? error)}`);
    return '';
  }
}

/**
 * @param {{log?:Function, deps?:{orchestrator?:object, store?:object, catalog?:Function, image?:Function, stateFile?:string, selfId?:string}}} [opts]
 */
export function createPetChat({ log = null, deps = {} } = {}) {
  const warn = (text) => { try { log?.(text); } catch { /* ignore */ } logger.warn('pet-chat', text); };
  const orchestrator = deps.orchestrator || null;
  const store = deps.store || null;
  const catalogOf = typeof deps.catalog === 'function' ? deps.catalog : catalogViaSkill;
  const imageOf = typeof deps.image === 'function' ? deps.image : imageViaSkill;
  const stateFile = String(deps.stateFile || path.join(DATA_DIR, 'pet-chat.json'));

  let saved = load();
  let busy = false;
  // 捕获到的回复：不写"自己说过"的存档（没有真的发出去），只在本次进程内按时间插回消息流。
  const captured = [];
  // 存档条目 id → 这一句带的附件（只在本进程内有效，用于把文件名画在气泡下面）
  const sentFiles = new Map();

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
      const ownerChatKey = String(data?.ownerChatKey || '');
      return { ownerChatKey: /^private:[0-9]{5,12}$/.test(ownerChatKey) ? ownerChatKey : '' };
    } catch {
      return { ownerChatKey: '' };
    }
  }

  function save() {
    try { atomicWriteJson(stateFile, { v: STATE_VERSION, ...saved }); }
    catch (error) { warn(`专属会话标识落盘失败：${String(error?.message ?? error)}`); }
  }

  /**
   * 只属于主人的会话 key：`private:<机器人自己的 QQ 号>`。
   * 拿不到 QQ 号（协议端没连上）时返回空串 —— 由调用方给明确提示，
   * 不用假 ID 糊过去（非数字 ID 进不了会话清单，控制台会看不到这条会话）。
   */
  function ownerChatKey() {
    if (saved.ownerChatKey) return saved.ownerChatKey;
    const selfId = String(deps.selfId || orchestrator?.onebot?.selfId || '').trim();
    if (!/^\d{5,12}$/.test(selfId)) return '';
    saved.ownerChatKey = `private:${selfId}`;
    save();
    return saved.ownerChatKey;
  }

  /** 这条会话的真实存档 → 窗口消息。 */
  function historyMessages(chatKey, limit = HISTORY_LIMIT) {
    if (!chatKey || !store) return [];
    let rows = [];
    try { rows = store.recent(chatKey, { limit }) || []; } catch { return []; }
    return rows.map((m) => {
      const self = m?.self === true;
      const senderId = String(m?.senderId || '');
      const entryId = Number(m?.id) || 0;
      const files = entryId ? (sentFiles.get(entryId) || []) : [];
      const raw = String(m?.text || '');
      // 机器人自己留档的表情标签 → 表情占位（原图只有本进程内有；重启后
      // 画 ［desc］ 占位，与"表情图文件被清掉"的形态一致，不至于变成一行裸标签）
      const stickerTag = self ? /^\[表情包:([^\]]*)\]$/.exec(raw.trim()) : null;
      return {
        id: `a${m?.id ?? Math.random()}`,
        entryId,
        role: self ? 'bot' : (senderId === CONSOLE_SENDER_ID ? 'me' : 'them'),
        name: self ? '' : String(m?.senderName || senderId || '').slice(0, 24),
        text: stickerTag ? '' : raw.slice(0, 4000),
        at: Number(m?.ts) || 0,
        stickers: stickerTag ? [{ id: '', desc: stickerTag[1], dataUrl: '' }] : [],
        media: Array.isArray(m?.media) ? m.media.length : 0,
        // 自己发的附件：文件名 + 体积（原图在磁盘上，窗口里不重复存一份）
        files: files.map((f) => ({ name: String(f.name || f.path || '').slice(0, 80), size: Number(f.size) || 0 }))
      };
    });
  }

  /** 捕获到的回复 → 窗口消息（贴纸补 data URL，图片原样带出）。 */
  async function capturedMessages() {
    const out = [];
    for (let i = 0; i < captured.length; i += 1) {
      const it = captured[i];
      if (it.type === 'text') {
        out.push({ id: `c${i}`, role: 'bot', name: '', text: String(it.text || '').slice(0, 4000), at: it.at || 0, stickers: [], media: 0 });
        continue;
      }
      if (it.type === 'sticker') {
        let dataUrl = '';
        if (it.dataUrl) dataUrl = it.dataUrl;
        else if (it.id) { dataUrl = await imageOf(it.id); it.dataUrl = dataUrl; }
        out.push({ id: `c${i}`, role: 'bot', name: '', text: '', at: it.at || 0, media: 0, stickers: [{ id: it.id, desc: it.desc, dataUrl }] });
        continue;
      }
      if (it.type === 'image') {
        out.push({ id: `c${i}`, role: 'bot', name: '', text: '', at: it.at || 0, media: 0, image: it.dataUrl || it.url || '' });
      }
      // media / poke 等在窗口里没有对应形态，跳过（不会让消息流断开）
    }
    return out;
  }

  /**
   * 捕获项 → 存档文本标签。与真实 QQ 出站的留档口径逐字一致
   * （sender.js 的 appendSelf：文本原样、表情 `[表情包:desc]`、图片 `[图片]`）——
   * 重启后窗口从存档就能还原对话流，控制台存档页看到的也是同一套记录。
   * media / poke 在窗口里没有对应形态，也不留档（返回 null）。
   */
  function archiveLabel(item) {
    const type = String(item?.type || '');
    if (type === 'text') return String(item.text || '').slice(0, 4000);
    if (type === 'sticker') return `[表情包:${String(item.desc || item.id || '').slice(0, 60)}]`;
    if (type === 'image') return '[图片]';
    return null;
  }

  /** 给界面的一份完整快照。 */
  async function snapshot() {
    const key = ownerChatKey();
    // 本进程内已用内存版渲染的回复（表情带原图），存档里那条文本标签跳过、
    // 防止同一句画两条；重启后 captured 为空 → 存档版顶上，历史不丢。
    const liveIds = new Set(
      captured.map((it) => Number(it.entryId)).filter((n) => Number.isFinite(n) && n > 0)
    );
    const messages = key
      ? [...historyMessages(key).filter((m) => !liveIds.has(m.entryId)), ...await capturedMessages()]
        .sort((a, b) => a.at - b.at)
        .slice(-Math.max(20, HISTORY_LIMIT + 20))
      : [];
    return {
      ok: true,
      available: true,
      busy,
      thinking: busy,
      chatKey: key,
      chatName: OWNER_LABEL,
      // 协议端没连上时拿不到机器人 QQ 号：说清楚，别让用户对着一个空窗口发呆
      notice: key ? '' : '还没拿到机器人的 QQ 号（协议端未连接）—— 连上之后这里就是只属于你的会话。',
      messages,
      greeting: String(getConfig()?.persona?.botName || '小鲸鱼')
    };
  }

  /**
   * 发一句话（可带附件）：以「主人」身份进入这条专属会话，跑一轮真实唤醒，把回复接住。
   * @param {{text:string, files?:Array<{path:string,name?:string,size?:number}>}} arg
   */
  async function send({ text, files = [] } = {}) {
    const clean = String(text || '').trim().slice(0, MAX_TEXT);
    const list = (Array.isArray(files) ? files : [])
      .map((f) => ({
        path: String(f?.path || f || ''),
        name: String(f?.name || ''),
        size: Number(f?.size) || 0
      }))
      .filter((f) => f.path)
      .slice(0, MAX_FILES);
    if (!clean && !list.length) return { ok: false, error: '说点什么吧，或者带个文件' };
    if (busy) return { ok: false, error: '上一条还在回复中，稍等一下' };
    if (!orchestrator) return { ok: false, error: '编排器未就绪（核心没有起来？）' };
    const key = ownerChatKey();
    if (!key) {
      return { ok: false, error: '还没拿到机器人的 QQ 号（协议端未连接），连上之后再试', state: await snapshot() };
    }

    busy = true;
    try {
      const result = await orchestrator.injectOwnerMessage(key, { text: clean, files: list });
      if (!result?.ok) {
        return { ok: false, error: result?.error || '没有跑起来', state: await snapshot() };
      }
      // 捕获到的出站内容：贴纸补图、图片带出，按时间插回消息流。
      // ⚠️ 同时按「机器人自己说的」写进这条会话的存档（appendSelf）——
      // captured 只在内存里，重启即空；不落档的话窗口历史就只剩用户消息。
      // 文本标签与真实出站一致（sender.js），本进程内由 snapshot 按
      // entryId 跳过存档版、继续用内存版渲染，不会出现两条。
      for (const item of result.items || []) {
        if (item.type === 'sticker' && item.id && !item.dataUrl) item.dataUrl = await imageOf(item.id);
        if (store) {
          const label = archiveLabel(item);
          if (label !== null) {
            try {
              const entry = store.appendSelf(key, { text: label, ts: Number(item.at) || Date.now() });
              if (entry && entry.id != null) item.entryId = entry.id;
            } catch (error) { warn(`回复留档失败：${String(error?.message ?? error)}`); }
          }
        }
        captured.push(item);
      }
      while (captured.length > 200) captured.shift();
      // 把"这一句带了哪些文件"按存档条目 id 记住，界面把它画在自己的气泡下面
      // （存档里只有文件名和［图片］标记，没有字节，画不出原图）
      if (list.length && result.entryId != null) sentFiles.set(Number(result.entryId), list);
      return { ok: true, items: result.items || [], entryId: result.entryId ?? null, state: await snapshot() };
    } catch (error) {
      const msg = String(error?.message ?? error);
      warn(`一次插话失败：${msg}`);
      return { ok: false, error: msg, state: await snapshot() };
    } finally {
      busy = false;
    }
  }

  return {
    snapshot,
    send,
    get busy() { return busy; },
    get chatKey() { return ownerChatKey(); }
  };
}
