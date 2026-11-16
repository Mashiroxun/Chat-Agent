// 〔存档 / 用量〕——M9 拆分第 5 段
'use strict';
// ── 存档视图 ──
async function loadChats({ quiet = false } = {}) {
  try {
    const data = await api('/api/chats');
    const next = data.chats || [];
    // 2026-11-04（R174）：签名短路（与 02-sse-sessions.js 的 loadSessions BUG-13 同款）。
    // 以前 quiet 只用来压 console.error，列表照样整块重绘 —— 切回存档页时
    // 滚动位置会回到顶部，长列表还会闪一下。
    // ⚠️ 短路只跳"列表重绘"，**不跳消息刷新**：chats 没变不代表当前群的消息没变，
    //    两者是独立数据源（消息由 SSE 推、也可以被别处改写）。
    const sig = JSON.stringify(next);
    if (!(quiet && state.chatsSig === sig)) {
      state.chatsSig = sig;
      state.chats = next;
      renderChatList();
    }
    if (state.currentChatKey) {
      // 打开着某群详情时也刷新该群消息。
      // keepView=true：只更新内容，不动分页与滚动位置 ——
      // 否则用户滚出来的内容会被每 15 秒的轮询刷回去。
      loadChatMessages(state.currentChatKey, { keepView: true });
    }
  } catch (e) { if (!quiet) console.error(e); }
}

/**
 * 真实 QQ 头像 URL（2026-10-17，用户要求存档列表读取群聊真实头像）：
 *   群   → https://p.qlogo.cn/gh/<群号>/<群号>/100（群头像只能走 gh 接口）
 *   私聊 → /api/avatar/<QQ号>?s=100（2026-11-05 起改走本地磁盘缓存，R185 同款）
 * ⚠️ 群头像**不能**用 b=qq&nk=群号（那是个人接口，对群号返回 404）。
 * 与 15-chat-chrome.js 会话页左栏、05-memory-settings.js 记忆卡片同一套路
 * （15-chat-chrome 的实现闭在 IIFE 里拿不到，这里按同款规则再写一份）。
 * ⚠️ /api/avatar 只接受 40/100/140/640 四档尺寸，传别的会 404 并触发首字兜底，
 *    所以这里把非白名单尺寸收敛到 100（群头像的 gh 接口不受此限制）。
 * key 不是纯数字 ID 时返回 ''，由调用方退回首字。
 */
function qqAvatarUrl(chatKey, size) {
  const m = /^(group|private):(\d{5,12})$/.exec(String(chatKey || ''));
  if (!m) return '';
  const id = m[2];
  const s = size || 100;
  if (m[1] === 'group') return `https://p.qlogo.cn/gh/${id}/${id}/${s}`;
  const localSize = [40, 100, 140, 640].indexOf(Number(s)) >= 0 ? Number(s) : 100;
  return `/api/avatar/${id}?s=${localSize}`;
}

/**
 * 头像加载失败 → 揭开首字兜底（与 15-chat-chrome.js bindAvatarFallback 同款）。
 * ⚠️ error 事件**不冒泡**，必须捕获阶段监听；绑在长期容器上，
 *    innerHTML 重建不影响委托（渲染函数每次整体重画，不能逐节点绑）。
 */
function bindArchiveAvatarFallback(box) {
  if (!box || box.__avBound) return;
  box.__avBound = true;
  box.addEventListener('error', (e) => {
    const im = e.target;
    if (!im || im.tagName !== 'IMG' || !im.classList.contains('av-img')) return;
    const fb = im.parentNode?.querySelector('.av-fb');
    im.style.display = 'none';
    if (fb) fb.hidden = false;
  }, true);
}

/**
 * 存档群聊列表（2026-10-17 改版）：结构与「会话」页左栏的聊天对象行**逐字同款**
 * （.bp-row + .bp-av 真实头像 + .bp-rt 群名 / .bp-ri 末条预览 + .cc-pill 计数），
 * 两类样式全是全局类、直接复用，不再自造一套。
 * 右侧 pill：有未读 → 红胶囊「N 条未读」；否则 → 灰胶囊「N 条」（消息总数）。
 * 元素上保留 .chat-item class：new-item 入场动画与 ? 主题的彩蛋规则还挂在它上面。
 */
function renderChatList() {
  const box = $('#chat-items');
  state.seenChatKeys = state.seenChatKeys || new Set();
  box.innerHTML = state.chats.map((c) => {
    const name = formatChatTitle(c.key, chatNameOf(c.key));
    const isNew = !state.seenChatKeys.has(c.key);
    const fb = String(name || '?').trim().slice(0, 1) || '?';
    const url = qqAvatarUrl(c.key, 100);
    const av = url
      ? `<span class="bp-av" data-avk="${esc(c.key)}"><img class="av-img" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" /><span class="av-l av-fb" hidden>${esc(fb)}</span></span>`
      : `<span class="bp-av"><span class="av-l">${esc(fb)}</span></span>`;
    const pill = c.unread
      ? `<span class="cc-pill cc-error">${c.unread} 条未读</span>`
      : (c.total ? `<span class="cc-pill cc-gray">${c.total} 条</span>` : '');
    return `
      <div class="bp-row chat-row chat-item${c.key === state.currentChatKey ? ' on' : ''}${isNew ? ' new-item' : ''}" data-key="${c.key}">
        ${av}
        <span class="bp-rl">
          <span class="bp-rt">${esc(name)}</span>
          <span class="bp-ri">${esc(c.lastText || '（暂无消息）')}</span>
        </span>
        ${pill}
      </div>`;
  }).join('') || '<div class="bp-empty">还没有消息存档（等白名单里的群/好友来消息）</div>';
  for (const c of state.chats) state.seenChatKeys.add(c.key);
  bindArchiveAvatarFallback(box);
  // 2026-10-23：改事件委托（与 02-sse-sessions.js 的会话列表同一套做法）。
  // 此前逐行 addEventListener：列表每次 SSE/轮询刷新都重建 HTML，N 行就产生 N 个闭包，
  // 且与项目自己在会话列表里写下的"改委托"决策不一致。
  if (!box.__chatItemsBound) {
    box.__chatItemsBound = true;
    box.addEventListener('click', (e) => {
      const row = e.target.closest?.('.chat-item');
      if (row && row.dataset.key) selectChat(row.dataset.key);
    });
  }
}

async function selectChat(key) {
  state.currentChatKey = key;
  if (state.quoteMode) state.quoteSelected = new Set();   // 金句按单段对话收录，换会话清空勾选
  renderChatList();
  // R76：详情容器可能已被切页销毁（#chat-detail 只在存档页存在）—— 直接写
  // innerHTML 会抛 TypeError（10/10 日志实测过一次）。切走时静默跳过即可。
  const detail = $('#chat-detail');
  if (detail) detail.innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadChatMessages(key);
}

/**
 * 拉取并渲染某会话的存档消息。
 *
 * @param {string} key
 * @param {boolean} keepView  true = 保留当前分页与滚动位置（轮询刷新用）；
 *                            false = 重置为第一页并重建结构（切换会话用）。
 *
 * ⚠️ 这个参数是修"滚动被冲掉"的关键：
 *    轮询每 15 秒一次、每次 SSE 事件也会触发，如果都走"重置分页 + 重建 DOM"，
 *    用户辛辛苦苦滚出来的内容会瞬间被刷回前 500 条，滚动位置也回到顶部
 *    —— 表现为"明明滚下去了，过一会儿自己弹回上面"。
 */
async function loadChatMessages(key, { keepView = false } = {}) {
  try {
    // 2026-10-23 修复：原先 limit=100000 —— 几万条的群会一次拉回数十 MB JSON，
    // 主线程解析 + 排序造成明显卡顿与内存峰值。改为只取最近 5000 条（前端分页逻辑不变），
    // 更早的消息在计数文案里明确提示"仅载入最近 N 条"。
    const data = await api(`/api/chats/${key.replace(':', '_')}/messages?limit=5000`);
    // 期间用户可能切走了会话，那就别覆盖当前视图
    if (state.currentChatKey !== key) return;
    state.chatMessages = data.messages || [];

    if (keepView && (state.chatMsgLimit || 0) > 0 && $('#chat-msg-body')) {
      // 只更新表格内容：分页不变、滚动位置不变
      updateChatMessagesBody(true);
    } else {
      // 切换会话：重置分页并从第一页开始
      state.chatMsgLimit = CHAT_MSG_PAGE;
      renderChatMessages();
    }
  } catch (e) {
    if (state.currentChatKey !== key) return;
    const box = $('#chat-detail');
    if (box) box.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * 存档消息列表：首次建结构 + 填充内容。
 *
 * ⚠️ 关键：这个只在"切换会话 / 首次打开"时调用，负责建出完整骨架并绑定工具栏事件。
 *    滚动加载更多时走 updateChatMessagesBody() —— 只替换 tbody 与底部文案，
 *    不碰外层结构。
 *
 *    曾经每次加载更多都走整个函数（innerHTML 全量重建），后果有两个：
 *      1. 浏览器丢失 scrollTop → 表现为"明明在往下滚，却自己弹回上面"
 *      2. 工具栏事件被反复绑定 → 点一次发好几条
 */
function renderChatMessages() {
  const key = state.currentChatKey;
  if (!key) return;
  const detail = $('#chat-detail');
  if (!detail) return;

  // 2026-10-23 修复：切到别的会话时清掉上一个会话的勾选。
  //   chatDeleteSelected 存的是**消息 id**，跨会话残留会让「删除选中」把 A 群的 id
  //   发给 B 群的删除接口 —— 用户以为在删 B 的，实际删的是 A 的。
  if (state.chatDeleteKey !== key) {
    state.chatDeleteKey = key;
    if (state.chatDeleteSelected && state.chatDeleteSelected.size) state.chatDeleteSelected.clear();
  }

  // 切换会话时重置分页（每个会话独立从第一页开始）
  state.chatMsgLimit = CHAT_MSG_PAGE;

  // R190（2026-11-04）：页头与「会话选择」右栏会话头（.chat-head）统一版式：
  //   主标题 = 纯名字（拿不到真名才退回 formatChatTitle 的「群 群号」），
  //   群号挪进副行（原来标题里带（群号），两处两套格式）；头像复用列表行同款
  //   bp-av 结构（qqAvatarUrl 群→gh / 私聊→q1），加载失败揭首字（下方捕获兜底）。
  const name = chatNameOf(key) || formatChatTitle(key, '');
  const meta = state.chats.find((c) => c.key === key) || {};
  const km = /^(group|private):(\d+)$/.exec(String(key || ''));
  const keyText = km ? (km[1] === 'group' ? '群号 ' + km[2] : 'QQ ' + km[2]) : '';
  const headFb = String(name || '?').trim().slice(0, 1) || '?';
  const headAvUrl = qqAvatarUrl(key, 100);
  const headAv = headAvUrl
    ? `<span class="bp-av" data-avk="${esc(key)}"><img class="av-img" src="${esc(headAvUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" /><span class="av-l av-fb" hidden>${esc(headFb)}</span></span>`
    : `<span class="bp-av"><span class="av-l">${esc(headFb)}</span></span>`;

  detail.innerHTML = `
    <div class="detail-header is-chat">
      ${headAv}
      <div class="dh-main">
        <h2>${esc(name)} ${meta.unread ? `<span class="unread-pill">${meta.unread} 未读</span>` : ''}</h2>
        <div class="sub">${keyText ? `<span>${esc(keyText)}</span>` : ''}<span data-field="chat-msg-count"></span></div>
      </div>
    </div>
    <div class="chat-toolbar">
      <button class="btn btn-small" id="chat-wake-btn">唤醒一次处理</button>
      <button class="btn btn-small" id="chat-read-btn">全部标为已读</button>
      <button class="btn btn-small" id="chat-mute-btn" title="仅屏蔽：把未读标记为已读，不再触发回复（消息保留）">仅屏蔽</button>
      <button class="btn btn-small" id="chat-del-mode-btn" title="选择部分消息删除">选择删除</button>
      <button class="btn btn-small btn-danger" id="chat-clear-btn" title="清空这个会话的全部消息存档">清空存档</button>
      <input type="text" id="test-send-text" placeholder="手动发一条测试消息" style="flex:1" />
      <button class="btn btn-small" id="chat-testsend-btn">发送</button>
    </div>
    <div class="chat-toolbar chat-del-bar" id="chat-del-bar" style="display:none">
      <span class="muted" id="chat-del-count">已选 0 条</span>
      <button class="btn btn-small btn-danger" id="chat-del-confirm-btn">删除选中</button>
      <button class="btn btn-small" id="chat-del-cancel-btn">取消</button>
    </div>
    <table class="archive-table"><tbody id="chat-msg-body"></tbody></table>
    <div class="list-more muted" id="chat-msg-more"></div>`;

  // R190：页头头像的首字兜底（捕获委托，#chat-detail 容器长期存在、绑一次即可；
  // 与列表行的 bindArchiveAvatarFallback 同一函数，flag 防重复绑定）
  bindArchiveAvatarFallback(detail);

  // 工具栏事件：只在这里绑一次
  // 2026-10-23 修复：这三个按钮此前完全没有错误处理 —— 后端未连接 / 白名单未配时，
  // 点了毫无反应也不提示（用户会反复点，并误判"已生效"）。统一补
  // 「禁用 → 执行 → 失败 qaAlert → 恢复」，顺带挡住连点。
  const runChatAction = async (btn, fn, label) => {
    // 加载态走 qaBtnBusy：只加 spinner + .is-loading，不改文案（换字会让同行按钮跳动）
    qaBtnBusy(btn, true);
    try { await fn(); }
    catch (e) { qaAlert(`${label}失败：${e.message}`); }
    finally { if (btn.isConnected) qaBtnBusy(btn, false); }
  };
  $('#chat-wake-btn').addEventListener('click', (e) => runChatAction(e.currentTarget, async () => {
    await api(`/api/chats/${key.replace(':', '_')}/wake`, { method: 'POST', body: '{}' });
    refreshStatus();
  }, '唤醒'));
  $('#chat-read-btn').addEventListener('click', (e) => runChatAction(e.currentTarget, async () => {
    await api(`/api/chats/${key.replace(':', '_')}/mark-read`, { method: 'POST', body: '{}' });
    loadChats();
    // 保持视图：用户可能已经滚到中间了，别把他弹回顶部
    loadChatMessages(key, { keepView: true });
  }, '标记已读'));
  // 仅屏蔽：未读标记为已读、不再触发回复（消息保留在存档里）
  $('#chat-mute-btn').addEventListener('click', (e) => runChatAction(e.currentTarget, async () => {
    await api(`/api/chats/${key.replace(':', '_')}/mute`, { method: 'POST', body: '{}' });
    loadChats();
    loadChatMessages(key, { keepView: true });
  }, '屏蔽'));
  // 清空存档：删除这个会话的全部消息（不可恢复）
  $('#chat-clear-btn').addEventListener('click', async () => {
    const meta = state.chats.find((c) => c.key === key) || {};
    // ⚠️（2026-10-10 r86 修 P2）破坏性 → danger:true（红主按钮 + 明确按钮文案）
    if (!await qaConfirm({
      danger: true,
      confirmText: '清空存档',
      message: `确定清空「${name}」的全部消息存档？\n\n共 ${meta.total ?? '?'} 条消息，删除后不可恢复。\n（机器人之后来新消息会重新记录）`
    })) return;
    try {
      await api(`/api/chats/${key.replace(':', '_')}/clear`, { method: 'POST', body: '{}' });
      loadChats();
      loadChatMessages(key);
    } catch (e) {
      qaAlert(`清空失败：${e.message}`);
    }
  });
  // ── 选择删除（部分消息）──
  state.chatDeleteMode = state.chatDeleteMode || false;
  state.chatDeleteSelected = state.chatDeleteSelected || new Set();
  const delBar = $('#chat-del-bar');
  const updateDelBar = () => {
    $('#chat-del-count').textContent = `已选 ${state.chatDeleteSelected.size} 条`;
    delBar.style.display = state.chatDeleteMode ? 'flex' : 'none';
  };
  // 2026-10-23 修复：模板里 #chat-del-bar 写死 display:none，而 state.chatDeleteMode
  //   是全局的 —— 在删除模式下切会话，新会话的行首有勾选框、工具条却不出现，
  //   用户勾完既删不掉也退不出删除模式。这里按当前状态同步一次。
  updateDelBar();
  $('#chat-del-mode-btn').addEventListener('click', () => {
    state.chatDeleteMode = !state.chatDeleteMode;
    if (!state.chatDeleteMode) state.chatDeleteSelected.clear();
    updateDelBar();
    updateChatMessagesBody(true);   // 重渲染出行首勾选框
  });
  $('#chat-del-cancel-btn').addEventListener('click', () => {
    state.chatDeleteMode = false;
    state.chatDeleteSelected.clear();
    updateDelBar();
    updateChatMessagesBody(true);
  });
  $('#chat-del-confirm-btn').addEventListener('click', async () => {
    const ids = [...state.chatDeleteSelected];
    if (!ids.length) { qaAlert('请先勾选要删除的消息'); return; }
    // ⚠️（2026-10-10 r86 修 P2）破坏性 → danger:true
    if (!await qaConfirm({
      danger: true,
      confirmText: `删除 ${ids.length} 条`,
      message: `确定删除选中的 ${ids.length} 条消息？删除后不可恢复。`
    })) return;
    try {
      await api(`/api/chats/${key.replace(':', '_')}/delete-messages`, {
        method: 'POST', body: JSON.stringify({ ids })
      });
      state.chatDeleteMode = false;
      state.chatDeleteSelected.clear();
      updateDelBar();
      loadChats();
      loadChatMessages(key, { keepView: true });
    } catch (e) {
      qaAlert(`删除失败：${e.message}`);
    }
  });
  // 删除勾选框（事件委托，tbody 会被重建）
  if (!detail.__chatDelBound) {
    detail.__chatDelBound = true;
    detail.addEventListener('change', (e) => {
      const chk = e.target.closest?.('.chat-del-check');
      if (!chk) return;
      const id = Number(chk.dataset.mid);
      if (chk.checked) state.chatDeleteSelected.add(id); else state.chatDeleteSelected.delete(id);
      const cnt = $('#chat-del-count');
      if (cnt) cnt.textContent = `已选 ${state.chatDeleteSelected.size} 条`;
    });
  }
  // 2026-10-23 修复：手动发测试消息此前无 try/catch —— 发送失败（未连 OneBot /
  // 白名单拦截）时按钮毫无反应，用户会以为"已经发出去了"。现在失败明确提示，
  // 成功才清空输入框；并禁用按钮防连点（避免重复发两条）。
  $('#chat-testsend-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const input = $('#test-send-text');
    const text = input.value.trim();
    if (!text) { qaAlert('先输入要发送的内容'); return; }
    qaBtnBusy(btn, true);
    try {
      await api(`/api/chats/${key.replace(':', '_')}/test-send`, {
        method: 'POST', body: JSON.stringify({ text })
      });
      input.value = '';
      // 同理，保持当前分页与滚动位置
      loadChatMessages(key, { keepView: true });
    } catch (err) {
      qaAlert(`发送失败：${err.message}`);
    } finally {
      if (btn.isConnected) qaBtnBusy(btn, false);
    }
  });

  updateChatMessagesBody();
  // 滚动加载只挂一次（attachScrollLoader 内部有防重复）
  initChatScrollLoader();
  // 金句勾选：事件委托挂在容器上（tbody 会被轮询重建，委托不受影响的）。
  // 防重复：renderChatMessages 每次切会话都会跑，容器只绑一次。
  if (!detail.__quoteBound) {
    detail.__quoteBound = true;
    detail.addEventListener('change', (e) => {
      const cb = e.target.closest?.('.quote-check');
      if (!cb) return;
      const mid = Number(cb.dataset.mid);
      if (cb.checked) state.quoteSelected.add(mid); else state.quoteSelected.delete(mid);
      cb.closest('tr')?.classList.toggle('quote-selected', cb.checked);
    });
  }
}

/**
 * 排序缓存：state.chatMessages 的引用不变就复用上次的排序结果。
 *
 * 曾经在 updateChatMessagesBody 里每次都 slice + sort + 再 slice + reverse
 * （两遍全量拷贝 + O(n log n)）。轮询进来数据确实会变（新数组引用，重排一次），
 * 但滚动加载更多时数据根本没动 —— 每滚一批就白排一遍，几万条时卡在滚动事件里。
 *
 * 用"稳定排序"而不是简单 reverse：存档里 ts 是秒级精度（实测 2000 条中有 18 处
 * 同一秒内的消息毫秒级逆序）。直接 reverse 会把这些也翻过来，导致同一秒内的
 * 消息顺序不对。先按 ts 稳定升序排一遍（Array.sort 在现代引擎里是稳定的），
 * 再反转，就能保证"新的在上"且同秒内顺序也正确。
 */
let chatMsgSortCache = { src: null, newestFirst: [] };
function chatMessagesNewestFirst() {
  const src = state.chatMessages || [];
  if (chatMsgSortCache.src !== src) {
    const sorted = src.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    sorted.reverse();
    chatMsgSortCache = { src, newestFirst: sorted };
  }
  return chatMsgSortCache.newestFirst;
}

/** 单行消息 HTML（全量渲染与滚动追加共用同一个模板，保证两处长得一样）。 */
function chatMsgRowHtml(m) {
  // 金句勾选模式：行首加勾选框；选中态存 state.quoteSelected（按消息 id），
  // 轮询重建行时勾选状态不丢
  const q = state.quoteMode
    ? `<td class="q-check"><input type="checkbox" class="quote-check" data-mid="${m.id}" ${state.quoteSelected.has(m.id) ? 'checked' : ''} /></td>`
    : '';
  // 删除勾选模式：行首加删除勾选框（与金句勾选互斥）
  const d = state.chatDeleteMode
    ? `<td class="q-check"><input type="checkbox" class="chat-del-check" data-mid="${m.id}" ${state.chatDeleteSelected.has(m.id) ? 'checked' : ''} /></td>`
    : '';
  const sel = state.quoteMode && state.quoteSelected.has(m.id) ? ' quote-selected' : '';
  const dsel = state.chatDeleteMode && state.chatDeleteSelected.has(m.id) ? ' chat-del-selected' : '';
  return `
    <tr class="${m.read ? '' : 'unread'}${sel}${dsel}" data-midrow="${m.id}">${q}${d}
      <td class="t">${fmtTime(m.ts)}</td>
      <td class="w ${m.self ? 'self' : ''}">${m.self ? '我' : esc(m.senderName)}</td>
      <td class="text">${esc(m.text)}${m.read ? '' : ' <span class="unread-pill">未读</span>'}</td>
    </tr>`;
}

/** 更新底部"还有 N 条"与顶部计数文案（全量渲染与追加都要刷这两处）。 */
function updateChatMessagesMeta(newestFirst) {
  const total = newestFirst.length;
  const shownCount = Math.min(Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE), total);
  const rest = total - shownCount;
  const more = $('#chat-msg-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更早的（还有 ${rest} 条）`
      : (total > CHAT_MSG_PAGE ? `已显示全部 ${total} 条` : '');
  }
  const cnt = $('#chat-detail')?.querySelector('[data-field="chat-msg-count"]');
  if (cnt) {
    const meta = state.chats.find((c) => c.key === state.currentChatKey) || {};
    const t = meta.total || total || 0;
    // 2026-10-23：拉取上限 5000，超出时明确告知"只载入了最近多少条"，
    // 否则用户会把"看不到更早的"当成数据丢失。
    const clipped = t > total ? `（仅载入最近 ${total} 条，更早的在 data/messages 里）` : '';
    cnt.textContent = t
      ? `共 ${t} 条 · 已显示 ${shownCount} 条${clipped} · 存储于 data/messages/`
      : '暂无消息';
  }
}

/**
 * 滚动加载更多的追加路径：只把新批次的行插到 tbody 末尾。
 * 不重排（走缓存）、不重建已有行、不碰滚动位置 —— 内容加在视口下方，
 * 浏览器天然保持视口稳定，所以这里**绝对不能**做 scrollTop 补偿。
 */
function appendChatMessageRows(prevShown) {
  const tbody = $('#chat-msg-body');
  if (!tbody) return;
  const newestFirst = chatMessagesNewestFirst();
  const limit = Math.min(state.chatMsgLimit, newestFirst.length);
  const rows = newestFirst.slice(prevShown, limit);
  if (rows.length) tbody.insertAdjacentHTML('beforeend', rows.map(chatMsgRowHtml).join(''));
  state.chatMsgRendered = limit;
  updateChatMessagesMeta(newestFirst);
}

/**
 * 只更新消息表格的内容（不重建外层结构）。
 * 轮询刷新与首次填充走这里 —— 表格内容变长，但滚动容器没动，
 * 所以用户的滚动位置天然保持，不会再"自己弹回上面"。
 *
 * @param {boolean} keepScroll 轮询路径传 true：新消息从**顶部**进来，
 *        内容高度变化会把视口顶走，按增量补偿回阅读位置。
 *        （滚动加载更多不走这里，走 appendChatMessageRows —— 底部追加不需要补偿）
 */
function updateChatMessagesBody(keepScroll = false) {
  const detail = $('#chat-detail');
  const tbody = $('#chat-msg-body');
  if (!detail || !tbody) return;

  const prevTop = keepScroll ? detail.scrollTop : 0;
  const prevHeight = keepScroll ? detail.scrollHeight : 0;

  // 倒序后取前 N 条 = 最新的 N 条（排序结果走引用缓存，数据没变不重排）
  const newestFirst = chatMessagesNewestFirst();
  state.chatMsgLimit = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
  const shown = newestFirst.slice(0, state.chatMsgLimit);

  tbody.innerHTML = shown.map(chatMsgRowHtml).join('');
  state.chatMsgRendered = shown.length;   // 行数账本：滚动追加靠它判断该不该走增量
  updateChatMessagesMeta(newestFirst);

  // 保险：若内容高度变了导致视口跳动，按增量补偿回来
  if (keepScroll) {
    const delta = detail.scrollHeight - prevHeight;
    if (delta !== 0) detail.scrollTop = prevTop + delta;
  }
}

/* ══════════════════════════════════════════════════════════════
 用量页图表（按天折线 + 按会话/按模型横向条形）

 表格是"精确"，图表是"一眼看懂"：趋势、谁占大头、集中在哪几天，
 这些扫一眼图就知道，扫表格得逐行做心算。图下面仍保留数值表（默认折叠）。

 ⚠️ 本项目 electron/main.js 关掉了硬件加速（软件渲染）：图表里
   不要用 backdrop-filter、不要给常驻元素加 animation。
 ══════════════════════════════════════════════════════════════ */
function usageMetric() {
  const m = state.usageMetric;
  return USAGE_METRICS.some(([k]) => k === m) ? m : 'runs';
}

/** 取某项在当前指标下的数值 */
function metricOf(item, metric = usageMetric()) {
  if (!item) return 0;
  if (metric === 'cost') return Number(item.cost) || 0;
  if (metric === 'tokens') return (Number(item.promptTokens) || 0) + (Number(item.completionTokens) || 0);
  return Number(item.runs) || 0;
}

/** 完整格式（气泡/条形末端用） */
function fmtMetric(v, metric = usageMetric()) {
  if (metric === 'cost') return fmtMoneyChart(v);
  if (metric === 'tokens') return fmtTokens(v);
  return String(Math.round(Number(v) || 0));
}

/** 图表里的金额：低于 1 元给 3 位即可（fmtYuan 给 4 位是给表格用的，条形上太吵） */
function fmtMoneyChart(n) {
  const v = Number(n) || 0;
  if (v === 0) return '¥0';
  return Math.abs(v) < 1 ? `¥${v.toFixed(3)}` : `¥${v.toFixed(2)}`;
}

/**
 * 坐标轴刻度用的紧凑格式（太长会把图挤变形）。
 *
 * ⚠️ token 分支已改为复用 fmtTokShort：过去这里是 `n >= 10000 ? round(n/1000)+'k'`
 * —— 没有 M 档且 Math.round 丢精度，1687 万 token 会在坐标轴上显示成
 * 「16872k」。现在与顶部概览条、卡片完全同一套换算。
 *
 * 成本分支同理补了 ¥1 万 / ¥100 万 档：一天成本上万时旧版会输出「¥12345」。
 */
function fmtMetricShort(v, metric = usageMetric()) {
  const n = Number(v) || 0;
  if (metric === 'cost') {
    const abs = Math.abs(n);
    if (abs >= 1e6) return `¥${(n / 1e6).toFixed(2)}M`;
    if (abs >= 1e4) return `¥${(n / 1e4).toFixed(1)}万`;
    return n >= 100 ? `¥${Math.round(n)}` : `¥${n.toFixed(n < 10 ? 2 : 1)}`;
  }
  return fmtTokShort(n);
}

/** 坐标轴上界取 1 / 2 / 5 × 10^n，刻度才好看 */
function niceMax(v) {
  const n = Number(v) || 0;
  if (n <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(n)));
  const r = n / pow;
  const step = r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10;
  return step * pow;
}

/**
 * 平滑曲线路径（单调三次 Hermite，Fritsch–Carlson 限幅）。
 * ⚠️ 刻意不用普通的 Catmull-Rom：它在陡升陡降处会「过冲」，把曲线甩到 0 以下
 * 或刻度上界以上，数据图里看着像假数据。这里的算法保证曲线始终落在相邻两点
 * 的取值区间内 → 既没有折角，又不会冒出假的峰谷。点数 < 2 时返回空串。
 */
function smoothPath(pts) {
  const n = pts.length;
  if (n < 2) return '';
  const dx = [], sec = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x || 1;
    sec[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }
  // 端点切线取相邻割线，中间点取两侧割线的平均（异号说明是极值点 → 切线压平）
  const t = new Array(n);
  t[0] = sec[0];
  t[n - 1] = sec[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = sec[i - 1] * sec[i] <= 0 ? 0 : (sec[i - 1] + sec[i]) / 2;
  // 限幅：把切线拉回单调区，过冲就是在这里被消掉的
  for (let i = 0; i < n - 1; i++) {
    if (sec[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / sec[i], b = t[i + 1] / sec[i];
    const s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); t[i] = tau * a * sec[i]; t[i + 1] = tau * b * sec[i]; }
  }
  let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h3 = dx[i] / 3;
    d += `C${(pts[i].x + h3).toFixed(1)},${(pts[i].y + t[i] * h3).toFixed(1)}`
      + ` ${(pts[i + 1].x - h3).toFixed(1)},${(pts[i + 1].y - t[i + 1] * h3).toFixed(1)}`
      + ` ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
  }
  return d;
}

/**
 * 按天折线图（平滑曲线）。
 * viewBox 用真实像素尺寸（= 实测容器宽 × 固定高），所以线宽与字号不会被拉伸。
 * 窗口缩放后由 bindUsageResize() 重画一次。
 *
 * 「一眼看懂」靠三件事：
 *   1. 曲线平滑，趋势比折线好读（且不过冲）；
 *   2. 图上方摘要条直接给出 峰值（带日期）/ 日均 / 合计，不用在图上找数字；
 *   3. 峰值点带虚线下引线、最新一点实心高亮，位置一目了然。
 * ⚠️ 所有文字都放在 SVG 外的摘要条里：页面背景是渐变光晕，SVG 文字没法靠纯色描边
 *    挖底，压在线/面积上会糊成一团。图上只留形状。
 * ⚠️ 圆点提示用 data-tip 而不是 SVG <title> —— 窗口是 transparent 的，
 *    原生 tooltip 会渲染成淡黄色色块（见 tooltip.js）。
 */
function usageLineChart(points, metric, width, height = 156) {
  const metricLabel = (USAGE_METRICS.find(([k]) => k === metric) || [])[1] || metric;
  const w = Math.max(280, Math.round(width || 680));
  const h = height;
  const padL = 46, padR = 14, padT = 10, padB = 22;
  const iw = w - padL - padR;
  const ih = h - padT - padB;
  const n = points.length;
  const vals = points.map((p) => metricOf(p, metric));
  const max = niceMax(Math.max(...vals, 0));
  const base = padT + ih;
  const X = (i) => (n <= 1 ? padL + iw / 2 : padL + (iw * i) / (n - 1));
  const Y = (v) => base - (max > 0 ? (ih * Math.max(0, v)) / max : 0);

  let grid = '';
  // 分 5 段：niceMax 取 1/2/5×10^n，除以 5 必定是整数（除 4 会出现 12.5 这种刻度）
  for (let i = 0; i <= 5; i++) {
    const v = (max * i) / 5;
    const y = Y(v).toFixed(1);
    grid += `<line class="uc-grid" x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}"/>`
         + `<text class="uc-ylabel" x="${padL - 7}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end">${esc(fmtMetricShort(v, metric))}</text>`;
  }

  // x 轴日期：点太多就均匀抽，避免标签叠在一起
  const step = Math.max(1, Math.ceil(n / 6));
  const shownX = new Set();
  for (let i = 0; i < n; i += step) shownX.add(i);
  // 最后一天离前一个标签太近就不画了，否则两个日期会叠在一起糊成一团
  if (n && (n - 1) - Math.max(...shownX) >= Math.max(1, step * 0.6)) shownX.add(n - 1);
  let xlabels = '';
  for (const i of [...shownX].sort((a, b) => a - b)) {
    if (!points[i]) continue;
    xlabels += `<text class="uc-xlabel" x="${X(i).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(String(points[i].day || '').slice(5))}</text>`;
  }

  // ── 曲线 / 面积 ──
  const pts = points.map((p, i) => ({ x: X(i), y: Y(metricOf(p, metric)) }));
  const linePath = smoothPath(pts);
  const areaPath = linePath
    ? `${linePath} L${pts[n - 1].x.toFixed(1)},${base.toFixed(1)} L${pts[0].x.toFixed(1)},${base.toFixed(1)} Z`
    : '';

  // ── 峰值 / 日均（摘要条与图上的标记共用这两个值）──
  const peakV = Math.max(...vals, 0);
  const peakIdx = peakV > 0 ? vals.indexOf(peakV) : -1;
  const total = vals.reduce((a, v) => a + v, 0);
  const avg = n ? total / n : 0;
  const dayOf = (i) => String(points[i]?.day || '').slice(5);
  // 2026-11-13：给 SVG 一句可读的无障碍描述（原来只有 role="img"、没有标签，
  // 读屏软件只会念"图像"）。摘要条上的数字与它同源，信息不额外增加。
  const ariaLabel = `按天${metricLabel}趋势：峰值 ${fmtMetric(peakV, metric)}`
    + (peakIdx >= 0 ? `（${dayOf(peakIdx)}）` : '')
    + `，日均 ${fmtMetric(avg, metric)}，合计 ${fmtMetric(total, metric)}`;

  // 均值虚线：全 0 时贴着基线没意义，只有真的高于 0 才画
  const avgLine = avg > 0
    ? `<line class="uc-avg" x1="${padL}" y1="${Y(avg).toFixed(1)}" x2="${(w - padR).toFixed(1)}" y2="${Y(avg).toFixed(1)}"/>`
    : '';
  // 峰值下引线：一眼看出峰值落在哪一天（否则只能靠猜 x 轴）
  const peakGuide = peakIdx >= 0
    ? `<line class="uc-peak-guide" x1="${pts[peakIdx].x.toFixed(1)}" y1="${pts[peakIdx].y.toFixed(1)}" x2="${pts[peakIdx].x.toFixed(1)}" y2="${base.toFixed(1)}"/>`
    : '';

  // 点太密时普通点淡化处理（保留 3.4 半径的点击热区，只是不抢视线），峰值/最新永远醒目
  const dense = n > 22;
  const dots = points.map((p, i) => {
    const isPeak = i === peakIdx;
    const isLast = i === n - 1;
    const cls = ['uc-dot',
      dense && !isPeak && !isLast ? 'uc-dot-quiet' : '',
      isPeak ? 'uc-dot-peak' : '',
      isLast ? 'uc-dot-last' : ''].filter(Boolean).join(' ');
    const r = isPeak ? 4.6 : isLast ? 4.2 : 3.4;
    return `<circle class="${cls}" cx="${pts[i].x.toFixed(1)}" cy="${pts[i].y.toFixed(1)}" r="${r}" data-key="${esc(p.day)}" data-tip="${esc(String(p.day))}：${esc(fmtMetric(vals[i], metric))}"></circle>`;
  }).join('');

  const sumBar = `<div class="uc-sum">`
    + `<span class="uc-sum-item"><i>${esc(metricLabel)}</i></span>`
    + `<span class="uc-sum-item"><i>峰值</i><b>${esc(fmtMetric(peakV, metric))}</b>`
      + (peakIdx >= 0 ? `<span class="uc-sum-extra">${esc(dayOf(peakIdx))}</span>` : '') + `</span>`
    + `<span class="uc-sum-item${avg > 0 ? ' has-dash' : ''}"><i>日均</i><b>${esc(fmtMetric(avg, metric))}</b></span>`
    + `<span class="uc-sum-item"><i>合计</i><b>${esc(fmtMetric(total, metric))}</b></span>`
    + `</div>`;

  return `<div class="uc-line-wrap">${sumBar}`
       + `<svg class="usage-line" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="${esc(ariaLabel)}">`
       + grid + avgLine + peakGuide + xlabels
       + (areaPath ? `<path class="uc-area" d="${areaPath}"/>` : '')
       + (linePath ? `<path class="uc-line" d="${linePath}" pathLength="1" vector-effect="non-scaling-stroke"/>` : '')
       + dots
       + `</svg></div>`;
}

/**
 * 横向条形图（分类排名用）。会话/模型是并列关系，折线会误导"前后有趋势"，
 * 条形一眼看出谁多谁少。
 *
 * 「一眼看懂」靠三件事：
 *   1. 左侧名次徽标 + 条色随名次递减（第一名最实），不用逐行比长度；
 *   2. 每行右侧给百分比；条形按最大值归一化，第一名永远满格；
 *   3. 底部汇总「合计 + 前 N 项占比」，直接看出集中度（少数会话吃掉大部分用量）。
 */
/* ── R229（2026-11-14）：条形图「按键调和 + FLIP」────────────────────────
   切范围/切指标时三张条形图（按会话/按模型/按插件）曾经整块 innerHTML 重建。
   现在统一按键（key）调和：
     · 同 key 的行原位更新名次/名称/条宽/数值，条宽走 CSS width 过渡；
     · 行序变化用 FLIP：旧行平移滑到新位置，而不是闪现重排；
     · 新行照播 ucBarGrow 的 staggered 入场，消失的行直接移除；
     · 附带修一个存量 bug：chats/models 的条曾经 width 与 scaleX(--s) 双重
       叠加（第二条实际只显示真实长度的平方），现在统一纯 width 渲染。
   行描述符（裸字符串；转义交给 buildBarRow 的 esc，更新走 textContent）：
     { key, cls?, rank, top?, name, sub?, width, alpha?, valMain, valShare,
       title?, interactive?, pluginKey? }                                    */
function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function buildBarRow(d) {
  const el = document.createElement('div');
  el.className = `uc-bar-row${d.cls ? ` ${d.cls}` : ''}${d.top ? ' top' : ''}`;
  el.dataset.barKey = d.key;
  // data-key 仅供下钻委托（.usage-chart [data-key]）使用：chats/models 行有、
  // 插件/对照行没有（它们走自己的 openPluginToolsModal 委托，见 data-plugin-key）
  if (d.dataKey) el.dataset.key = d.key;
  if (d.interactive) { el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0'); }
  if (d.title) el.title = d.title;
  el.style.setProperty('--i', String(d.stagger ?? 0));
  el.innerHTML = `
    <div class="uc-bar-label"><span class="uc-rank">${esc(d.rank)}</span><span class="uc-name" title="${esc(d.name + (d.sub ? ' · ' + d.sub : ''))}">${esc(d.name)}${d.sub ? `<i class="uc-name-sub">${esc(d.sub)}</i>` : ''}</span></div>
    <div class="uc-bar-track"><div class="uc-bar-fill" style="width:${d.width.toFixed(1)}%;opacity:${Number(d.alpha ?? 1).toFixed(2)}"></div></div>
    <div class="uc-bar-val"><b>${esc(d.valMain)}</b><span class="uc-bar-share">${esc(d.valShare)}</span></div>`;
  return el;
}

function reconcileBarBlock(host, data, opts = {}) {
  if (!host) return;
  if (data.empty) {
    if (host.dataset.barMode !== 'empty' || host.innerHTML !== data.empty) host.innerHTML = data.empty;
    host.dataset.barMode = 'empty';
    return;
  }
  if (host.dataset.barMode !== 'rows' || !host.querySelector(':scope > .uc-bars')) {
    host.innerHTML = '<div class="uc-bars"></div>';
    host.dataset.barMode = 'rows';
  }
  const barsBox = host.querySelector(':scope > .uc-bars');
  const reduce = reducedMotion();
  // FLIP · First：调和前先记旧行位置
  const first = new Map();
  if (!reduce) {
    barsBox.querySelectorAll(':scope > .uc-bar-row').forEach((el) => {
      first.set(el.dataset.barKey ?? '', el.getBoundingClientRect());
    });
  }
  const byKey = new Map();
  barsBox.querySelectorAll(':scope > .uc-bar-row').forEach((el) => byKey.set(el.dataset.barKey ?? '', el));
  const kept = new Set();
  data.rows.forEach((d, idx) => {
    let el = byKey.get(d.key);
    if (!el) {
      el = buildBarRow({ ...d, stagger: idx });
    } else {
      // ── 原位更新（不重建、不重播入场动画）──
      el.className = `uc-bar-row${d.cls ? ` ${d.cls}` : ''}${d.top ? ' top' : ''}`;
      const rank = el.querySelector('.uc-rank');
      if (rank && rank.textContent !== d.rank) rank.textContent = d.rank;
      const name = el.querySelector('.uc-name');
      const nameSig = `${d.name}\u0001${d.sub || ''}`;
      if (name && el.dataset.nameSig !== nameSig) {
        el.dataset.nameSig = nameSig;
        name.textContent = d.name;
        let sub = name.querySelector('.uc-name-sub');
        if (d.sub) {
          if (!sub) { sub = document.createElement('i'); sub.className = 'uc-name-sub'; name.appendChild(sub); }
          sub.textContent = d.sub;
        } else if (sub) sub.remove();
      }
      const fill = el.querySelector('.uc-bar-fill');
      if (fill) {
        // 旧行被 insertBefore 移动时会重插节点 → CSS 入场动画重播（条重新"长一遍"）。
        // 老行一律禁播入场动画：宽度本就走 width transition，入场只属于新行。
        if (fill.style.animation !== 'none') fill.style.animation = 'none';
        const w = `${d.width.toFixed(1)}%`;
        if (fill.style.width !== w) fill.style.width = w;   // 宽度交给 CSS transition
        const op = Number(d.alpha ?? 1).toFixed(2);
        if (fill.style.opacity !== op) fill.style.opacity = op;
      }
      const val = el.querySelector('.uc-bar-val');
      if (val) {
        const b = val.querySelector('b');
        if (b && b.textContent !== d.valMain) b.textContent = d.valMain;
        const sh = val.querySelector('.uc-bar-share');
        if (sh && sh.textContent !== d.valShare) sh.textContent = d.valShare;
      }
    }
    if (d.interactive) {
      if (!el.hasAttribute('role')) { el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0'); }
    } else { el.removeAttribute('role'); el.removeAttribute('tabindex'); }
    if (d.title !== undefined && el.title !== d.title) el.title = d.title;
    if (d.pluginKey) el.dataset.pluginKey = d.pluginKey;    // 插件下钻委托读这个
    if (d.dataKey) { if (el.dataset.key !== d.key) el.dataset.key = d.key; }
    else if (el.dataset.key !== undefined) el.removeAttribute('data-key');
    kept.add(d.key);
    // 顺序对齐：只在不在预期位置时才移动（移动 = 重插节点，会重播 CSS 动画）
    if (barsBox.children[idx] !== el) barsBox.insertBefore(el, barsBox.children[idx] || null);
  });
  // 占位行（.uc-ph，见下方 R233）不在这里删除 —— 它们的去留由下面的
  // opts.filler 分支按剩余高度重新裁定，删了再加会重播入场动画。
  byKey.forEach((el, key) => { if (!kept.has(key) && !el.classList.contains('uc-ph')) el.remove(); });
  let footEl = host.querySelector(':scope > .uc-rest');
  if (data.footHtml) {
    if (!footEl) { footEl = document.createElement('div'); footEl.className = 'uc-rest'; host.appendChild(footEl); }
    if (footEl.innerHTML !== data.footHtml) footEl.innerHTML = data.footHtml;
  } else if (footEl) footEl.remove();
  /* ── R233（2026-11-14，用户：「底下这一大块不能空着吧，假装有群聊占位」）────
     按会话真实条目少（比如只有 4 条）时，面板底部会剩一大块空白。用「假群聊」
     占位行把版面填满：
       · 只动 DOM：不进 data.rows / footHtml，不参与合计、占比与点击下钻；
       · 占位行走稳定 key（ph:0…）的原位调和 —— 轮询刷新时不会闪、不会重播动画；
       · 样式 .uc-ph 整体调灰 + 虚线名次徽标，一眼能看出是占位（见 04-usage.css）。
     R235c：行数不再实测剩余高度。实测方案接连出三个同源 bug —— 隐藏态量出
     0/0 得 NaN；used 口径含占位行导致补了删、删了补的振荡；更隐蔽的是
     .uc-bars 为 flex:1 且 min-height:auto，旧占位行会把容器撑高，clientHeight
     随之变大 → free 恒为正 → 占位永不消失，面板卡在拉伸态（3→8 行切换实测
     复现：文案说「其余 2 项」下面却还挂着 3 行假群聊）。改为**无状态按固定
     容量补**：CAP 与 BAR_LIMIT 同源（R234 实测 400px 基准最多 6 行，R236
     收拢为 USAGE_BAR_CAP），真实行多到撑高面板时 rows.length > CAP，
     自动一行不补；隐藏态调和也成立（无测量即无 NaN/振荡/自持）。 */
  if (opts.filler) {
    const n = Math.max(0, Math.min(USAGE_BAR_CAP - data.rows.length, 4));
    const phBy = new Map();
    barsBox.querySelectorAll(':scope > .uc-bar-row.uc-ph').forEach((el) => phBy.set(el.dataset.barKey, el));
    const phKept = new Set();
    const base = data.rows.length;                      // 名次接着真实行往下编
    for (let i = 0; i < n; i++) {
      const key = `ph:${i}`;
      phKept.add(key);
      const d = opts.filler(i, base);
      let el = phBy.get(key);
      if (!el) {
        el = buildBarRow({ ...d, key, stagger: base + i });
        el.classList.add('uc-ph');
      } else {
        const rank = el.querySelector('.uc-rank');
        if (rank && rank.textContent !== d.rank) rank.textContent = d.rank;
        const name = el.querySelector('.uc-name');
        if (name && name.textContent !== d.name) name.textContent = d.name;
        const fill = el.querySelector('.uc-bar-fill');
        if (fill) {
          const w = `${d.width.toFixed(1)}%`;
          if (fill.style.width !== w) fill.style.width = w;
          const op = Number(d.alpha ?? 1).toFixed(2);
          if (fill.style.opacity !== op) fill.style.opacity = op;
        }
      }
      const idx = base + i;
      if (barsBox.children[idx] !== el) barsBox.insertBefore(el, barsBox.children[idx] || null);
    }
    phBy.forEach((el, key) => { if (!phKept.has(key)) el.remove(); });
  }
  // FLIP · Invert + Play：行序/行数变化时，旧行平移滑到新位置
  if (!reduce) {
    barsBox.querySelectorAll(':scope > .uc-bar-row').forEach((el) => {
      const f = first.get(el.dataset.barKey ?? '');
      if (!f) return;                                       // 新行走 ucBarGrow 入场
      // R236：调和发生在隐藏块（如按天视图下轮询跑到按会话卡）时，First 位置
      // 量出来全是 0 —— 切回可见的瞬间 dx/dy 是巨大的负位移，行会从屏外飞入。
      // First 没有尺寸说明当时不可见，直接放弃 FLIP（行留在原位即可）。
      if (!f.width && !f.height) return;
      const l = el.getBoundingClientRect();
      const dx = f.left - l.left;
      const dy = f.top - l.top;
      if (!dx && !dy) return;
      el.style.transition = 'none';
      el.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
      el.getBoundingClientRect();                           // 强制 reflow
      el.style.transition = 'transform .45s cubic-bezier(.22, .85, .28, 1)';
      el.style.transform = '';
      const clear = () => { el.style.transition = ''; el.style.transform = ''; el.removeEventListener('transitionend', clear); };
      el.addEventListener('transitionend', clear);
      setTimeout(clear, 520);
    });
  }
}

function usageBars(list, metric, labelOf, limit = 8) {
  // key 做二级比较项，保证排序稳定（同指标值的条目不随刷新跳动）
  const items = (list || []).slice().sort((a, b) => {
    const d = metricOf(b, metric) - metricOf(a, metric);
    if (d) return d;
    return String(a.key ?? '').localeCompare(String(b.key ?? ''));
  });
  if (!items.length) return { empty: '<div class="uc-empty muted">这段时间没有记录</div>' };
  const shown = items.slice(0, limit);
  const max = Math.max(...shown.map((x) => metricOf(x, metric)), 0) || 1;
  const totalV = items.reduce((a, x) => a + Math.max(0, metricOf(x, metric)), 0);
  const topV = shown.reduce((a, x) => a + Math.max(0, metricOf(x, metric)), 0);
  const topPct = totalV > 0 ? (topV / totalV) * 100 : 0;
  const rest = items.slice(limit);

  const rows = shown.map((x, i) => {
    const v = metricOf(x, metric);
    // ⚠️ 曾经是 Math.max(2, ...)：值为 0 的项也画出 2% 宽的条，看起来"有数据"
    // 点进去却是 0。零值就该是零宽度（仍保留行与百分比）。
    const w = max > 0 ? Math.max(0, (v / max) * 100) : 0;
    // 占比分母用全量 totalV（不截断），负值一律按 0，保证各行占比之和为 100%
    const share = totalV > 0 ? Math.max(0, (v / totalV) * 100) : 0;
    const alpha = Math.max(0.34, 1 - i * 0.1);
    return {
      key: String(x.key ?? `#${i}`),
      dataKey: true,
      top: i === 0,
      rank: String(i + 1),
      name: labelOf(x),
      width: w,
      alpha,
      valMain: fmtMetric(v, metric),
      valShare: `· ${share.toFixed(0)}%`,
      title: '点击查看明细',
      interactive: true,
    };
  });

  // 全部项都已经画出来时，「前 N 项占 100%」是废话，只留合计
  const footHtml = `合计 <b>${esc(fmtMetric(totalV, metric))}</b>`
    + (rest.length
        ? ` · 前 ${shown.length} 项占 <b>${topPct.toFixed(0)}%</b> · 其余 ${rest.length} 项占 <b>${(100 - topPct).toFixed(0)}%</b>`
        : '');
  return { rows, footHtml };
}

/** 画三张图（用 dataset.sig 做内容指纹，轮询时内容没变就不动 DOM） */
function renderUsageCharts(stats, box) {
  if (!box) return;
  const metric = usageMetric();
  const days = stats?.days || [];
  const host = box.querySelector('[data-chart="days"]');
  // 折线图要用真实像素宽度：优先量自己的容器，量不到再退回外层
  const width = (host?.clientWidth || box.clientWidth || 680) - 4;
  // ⚠️ 提前短路（2026-11-13）：原来的流程是"先生成三张图的完整 HTML 字符串，
  //    再拿字符串比 sig"。轮询一次就算数据一个字节没变，也要白造三遍字符串
  //    （「全部」范围几百天时是几百个 SVG 节点的字符串）。
  //    现在只有**按天折线**走「宽度|指标|后端统计时刻」指纹短路 —— computedAt
  //    是后端真正算完的时刻，走 3 小时结果缓存时它不变，数据没变就整段跳过。
  //    chats/models **不能**这样短路：它们的标签走 chatNameOf/m.model，
  //    会话改名后内容会变而 computedAt 不变，按内容比 sig 才不会漏更新
  //    （这两张每张最多 8 行，字符串生成极便宜，不值得冒险）。
  const daysStamp = `${width}|${metric}|${stats?.computedAt || ''}`;
  const dayEl = box.querySelector('[data-chart="days"]');
  if (dayEl && dayEl.dataset.sig !== daysStamp) {
    dayEl.innerHTML = days.length ? usageLineChart(days, metric, width, 232) : '<div class="uc-empty muted">这段时间没有记录</div>';
    dayEl.dataset.sig = daysStamp;
  }
  // R218（用户：「超出的群聊可以先收起来」）：左侧面板高度统一成 --usage-panel-h(360) 后，
  //   能放下的条形行数是固定的 —— 实测行距 34.4px、卡头/摘要/合计/数值表共占约 163px，
  //   (360-163)/34.4 ≈ 5.7，取 5 行最稳（6 行会把面板顶到 369，卡片高度又跟着变）。
  //   超出部分不是消失：usageBars 的合计行会写「其余 N 项占 X%」，完整清单在「数值表」里。
  //   R234（2026-11-14，用户：「当前大小下能塞几个会话」）：面板 R221 起为 400、
  //   条形 14→9px、行距 6px —— 真实 CSS 逐档实测 6 行时卡片仍正好 400px 不被撑高
  //   （第 7 行起撑到 424）。BAR_LIMIT 5→6：真实会话优先占满容量，占位行只在
  //   真实不足 6 行时补底（5 时第 6 个真实会话反被占位顶掉，本末倒置）。
  //   R236：数值收拢为 USAGE_BAR_CAP（定义在 renderChatsBars 上方）。
  const BAR_LIMIT = USAGE_BAR_CAP;
  // R229：条形图按键调和（原位更新 + FLIP 行序滑动），不再整块 innerHTML 重建
  // R233：按会话条目少时底部用「假群聊」占位行填满（只对按会话开 —— 假模型名 /
  // 假插件名看着像真数据会误导，群号一眼就是凑数的）。占位行名次接在真实行后面。
  // R233b：抽成独立函数 —— 维度切换（data-udim）不重渲染，切回按会话时要靠
  // bindUsageDimObserver 立刻补一次调和，两处共用同一段逻辑。
  renderChatsBars(stats, box);
  reconcileBarBlock(box.querySelector('[data-chart="models"]'),
    usageBars(stats?.models, metric, (m) => (m.vendor ? `${m.vendor}：${m.model}` : (m.model ?? m.key)), BAR_LIMIT));
  renderHeroSpark(stats, box);
}

/* ── R233：按会话条形图 + 底部占位行 ──────────────────────────────────
   renderUsageCharts 与 bindUsageDimObserver（R233b）共用。
   R234：BAR_LIMIT 6 与 renderUsageCharts 保持一致（400px 面板实测容量）。
   R236：容量常量收拢 —— 此前 6 散在四处（BAR_LIMIT / renderChatsBars /
   pluginBars 调用 / 占位 CAP），改面板高度时漏改任何一处就会互相打架。 */
const USAGE_BAR_CAP = 6;   // 400px 面板基准实测容量；改 --usage-panel-h 时两处一起动
const PH_GROUPS = ['群 114514', '群 1919810', '群 233333', '群 666666', '群 9527'];
function renderChatsBars(stats, box) {
  if (!box) return;
  reconcileBarBlock(box.querySelector('[data-chart="chats"]'),
    usageBars(stats?.chats, usageMetric(), (c) => formatChatTitle(c.key, chatNameOf(c.key)), USAGE_BAR_CAP),
    { filler: (i, base) => ({
        rank: String(base + i + 1),
        name: PH_GROUPS[i % PH_GROUPS.length],
        width: Math.max(1.6, 4.2 - i * 1.1),
        alpha: 0.15,
        valMain: '—',
        valShare: '',
      }) });
}

/* ── R233b（2026-11-14，用户：「占位有的时候会莫名其妙地消失」）──────────
   根因：维度切换只写 #usage-page 的 data-udim（14-chrome.js applyUsageDim），
   不触发重渲染。而在按天等其他视图下，chats 块 display:none，轮询的
   renderChatsBars 照跑 —— 隐藏时 getBoundingClientRect/clientHeight 全为 0，
   占位行数会算成 NaN，已有的占位行被当成「不需要」全删。等用户切回按会话，
   看到的就是被删过的旧 DOM，要干等下一次轮询才补回 —— 表现为「莫名消失」。
   修法：监听 data-udim 属性变化，切回按会话（或任何切换）时立刻补一次调和；
   隐藏期间的调和由 reconcileBarBlock 的测量防护兜底（不增不删）。 */
let usageDimObserverBound = false;
function bindUsageDimObserver() {
  if (usageDimObserverBound) return;
  const box = $('#usage-page');
  if (!box || typeof MutationObserver === 'undefined') return;
  usageDimObserverBound = true;
  new MutationObserver(() => {
    const args = state.usageRenderArgs;
    if (!args || !args.stats || state.tab !== 'usage') return;
    renderChatsBars(args.stats, box);
  }).observe(box, { attributes: true, attributeFilter: ['data-udim'] });
}

/* ── Hero 迷你趋势（2026-11-13 Phase 3）──────────────────────────────────
   Hero 里那条横跨全宽的细线：不用滚到趋势卡，先看"这段时间是平的还是炸的"。
   只画形状、无坐标轴无文字 —— 它是情绪层，不是读数层（精确值在下面的趋势卡）。 */
function usageHeroSpark(points, metric) {
  const list = points || [];
  const n = list.length;
  if (n < 2) return '';
  const W = 1000, H = 44, pad = 3;
  const vals = list.map((p) => Math.max(0, metricOf(p, metric)));
  const max = Math.max(...vals, 0);
  const min = Math.min(...vals, 0);
  const span = (max - min) || 1;
  const X = (i) => (W * i) / (n - 1);
  const Y = (v) => H - pad - ((H - pad * 2) * (v - min)) / span;
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${W.toFixed(1)},${H} L0,${H} Z`;
  return `<svg class="uh-spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" focusable="false">`
    + `<path class="hs-area" d="${area}"/>`
    + `<path class="hs-line" d="${line}" pathLength="1" vector-effect="non-scaling-stroke"/>`
    + `<circle class="hs-last" cx="${X(n - 1).toFixed(1)}" cy="${Y(vals[n - 1]).toFixed(1)}" r="3.2"/>`
    + `</svg>`;
}
function renderHeroSpark(stats, box) {
  const host = box.querySelector('[data-field="spark"]');
  if (!host) return;
  const html = usageHeroSpark(stats?.days, usageMetric());
  if (host.dataset.sig === html) return;
  host.dataset.sig = html;
  host.innerHTML = html;
}

/* ── Hero 成本数字滚动（2026-11-13 Phase 3）──────────────────────────────
   首次进入/切范围时从旧值滚到新值（easeOutCubic 560ms）。
   轮询刷新如果值没变就完全不动 DOM —— 否则每次轮询都会重新滚一遍，很吵。 */
function setCostValue(box, value) {
  const el = box.querySelector('[data-field="cost"]');
  if (!el) return;
  const to = Number(value) || 0;
  const prev = Number(el.dataset.v);
  el.dataset.v = String(to);
  const final = fmtYuan(to);
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || prev === to) {
    if (el.textContent !== final) el.textContent = final;
    return;
  }
  // 首次渲染（元素刚建、没有旧值）从 0 滚上去，是这页最直接的"数据在动"信号；
  // 之后的轮询/切换只从旧值滚到新值，不会每次归零。
  const from = Number.isFinite(prev) ? prev : 0;
  if (from === to) { el.textContent = final; return; }
  const t0 = performance.now();
  const dur = 480;
  // 动画代次：快速切范围时可能连着起两次动画，旧的那条必须立刻让位，
  // 否则两帧交替写 textContent，数字会来回抽。
  const run = String((Number(el.dataset.run) || 0) + 1);
  el.dataset.run = run;
  const frame = (now) => {
    if (el.dataset.run !== run) return;
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = `¥${(from + (to - from) * e).toFixed(2)}`;
    if (k < 1) requestAnimationFrame(frame);
    else el.textContent = final;
  };
  requestAnimationFrame(frame);
}

/** 窗口缩放后重画图表（只挂一次，防重复绑定） */
let usageResizeBound = false;
function bindUsageResize() {
  if (usageResizeBound) return;
  usageResizeBound = true;
  let timer = null;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const args = state.usageRenderArgs;
      const box = $('#usage-page');
      if (!args || !box || state.tab !== 'usage') return;
      // ⚠️ 必须核对 args 是不是当前范围的：state.usageRenderArgs 里存的是
      // **最近一次渲染时**的参数，而 resize 是 200ms 防抖的。若用户在这
      // 200ms 内切了时间范围，页面上的表已是新范围，args.stats 还是旧的
      // → 重画出来的图与表格对不上。现在渲染时一并记下范围（见
      // updateUsagePage），这里比对不一致就跳过，等下次数据回来自然重画。
      if (args.range !== usageRange) return;
      box.querySelectorAll('.usage-chart').forEach((el) => { el.dataset.sig = ''; });
      renderUsageCharts(args.stats, box);
    }, 200);
  }, { passive: true });
}

/* ══════════ R196（2026-11-04）：用量页「?」帮助弹窗 ══════════
   用户要求：页头「用量与成本」右边加设置页同款问号钮（.h2-help），
   把四个维度块的静态说明 + 「这些数字是怎么算的」一大坨收进弹窗，
   页面只留动态摘要行（.usage-sec-sum）和图表。
   外壳直接用 06-settings-render.js 的 openHelpModalShell（设置页同款），
   内容全是原来平铺在页面上的原文，一处不改、不丢信息。 */
function openUsageHelpModal() {
  if (typeof openHelpModalShell !== 'function') return;   // 设置页模块未加载时不弹（不报错）
  // 2026-11-05 审查修复：全局委托会在按钮重建后重复触发，openHelpModalShell
  //   本身没有幂等 —— 连点两下会叠出两个遮罩 + 两个焦点陷阱，Esc 只关掉最后
  //   注册的那个。已开时只重新聚焦，不再新建。
  const existing = document.querySelector('.modal-overlay[data-help="usage"]');
  if (existing) {
    try { existing.focus(); } catch (e) { /* 忽略 */ }
    return;
  }
  const { body, overlay } = openHelpModalShell('用量与成本 · 怎么读这些数字');
  overlay.dataset.help = 'usage';
  body.innerHTML = `
    <div class="help-sec">
      <div class="help-sec-t">页头控制条</div>
      <div class="hint help-sec-b">
        「图表」切换三张图显示的指标（调用次数 / 成本 / Token），数值表始终给全量；
        「今日 / 近 7 天 / 近 30 天 / 全部」切时间范围；「刷新」立即重算（跳过 3 小时缓存），
        右侧「数据更新于」标明这份统计的时刻。每个区块上方那一行<b>动态摘要</b>仍留在页面上，
        这里收的是各区块的说明文字与计算口径。
      </div>
    </div>
    <div class="help-sec">
      <div class="uh-t">按天</div>
      <div class="uh-note">一天一个点。看整体趋势和峰值，单日高低主要取决于那天聊得多不多。</div>
      <div class="up-howto-body">
        <p><b>哪一天</b>：按每次模型调用的<b>发生时刻</b>归日（本地时区）。一个跨零点的会话会被拆到两天，不会整段记在结束那天。</p>
        <p><b>缓存命中</b>：输入里命中前缀缓存、按折扣价计费的那部分；命中率 = 命中 ÷ 输入 token。</p>
        <p><b>成本</b>：各模型单价 × 用量。价格取「设置 → 模型与搜索 → 当前模型单价」，模型没有内置单价时按 0 计 —— 那是缺价，不是统计失败。</p>
        <p><b>图表画什么</b>：由上方「图表」按钮决定（调用次数 / 成本 / Token）；数值表始终给全量，不受指标切换影响。</p>
      </div>
    </div>
    <div class="help-sec">
      <div class="uh-t">按会话</div>
      <div class="uh-note">一个会话一条。排在前面的是消耗大户——聊得越久，每轮重发的历史越贵。</div>
      <div class="up-howto-body">
        <p><b>一个「会话」</b>＝一次完整对话（群聊、私聊各算一个），名字取会话标题。它的 token 与成本是所有模型调用的累加。</p>
        <p><b>为什么有的会话特别贵</b>：每次对话都要把这段历史重发一遍。同一句话在第 2 轮和第 40 轮的成本差几十倍——贵的是历史，不是新消息。</p>
        <p><b>排序</b>按上方「图表」指标（调用次数 / 成本 / Token）；点任意一根条或表格里的行，可以看这个会话逐步花在哪。</p>
        <p><b>更早的会话</b>：本地只保留最近 120 个会话明细（<code>store.keepSessionFiles</code>），被裁掉的那些仍按天记在账本里、照样计入合计，只是在这张按会话表里看不到明细。</p>
      </div>
    </div>
    <div class="help-sec">
      <div class="uh-t">按模型</div>
      <div class="uh-note">同一个模型走不同渠道算两个——官方、中转站、<code>:free</code> 版本的价格可能差好几倍。</div>
      <div class="up-howto-body">
        <p><b>为什么写成「渠道：模型 id」</b>：同一个 id 走官方直连和中转站是不同的商品，单价可能差几倍，混在一起会算错账，所以拆成两行。</p>
        <p><b>成本</b>：用量 × 「设置 → 模型与搜索 → 当前模型单价」里匹配到的单价。匹配不到单价时显示 ¥0 —— 那表示缺价，可以去那里补一条。</p>
        <p><b>命中率</b>：命中缓存 ÷ 输入 token。不同渠道的提示词前缀不一样，命中率会各自算，不要横向直接比。</p>
        <p><b>超过 20 行</b>时数值表默认只显示前 20 行，点「展开全部」看其余（求和与图不受影响，后端从不截断）。</p>
      </div>
    </div>
    <div class="help-sec">
      <div class="uh-t">按插件</div>
      <div class="uh-note">每次对话都会把<b>插件说明 + 工具说明 + 聊天记录</b>一起发给模型。最后一行「对话内容」是参照系——它不属于任何插件，但同样在花钱。</div>
      <div class="up-howto-body">
        <p><b>对话内容</b>（排行最后一行）：不是插件，是「这次输入里除了插件和工具说明之外剩下的部分」——聊天记录、人设、当前状态。它的口径是「每次真实输入 − 插件与工具说明」，用减法倒推，所以它一定和总数对得上。</p>
        <p><b>那"每轮新说的话"呢？</b>新消息本身很小（通常几十 token，见摘要行末尾的提示），但它会进入聊天记录，<b>之后每一次对话都要把它重发一遍</b>——所以聊得越久，单次输入越贵。要省钱，缩短历史比少说一句话有用得多。</p>
        <p><b>每次固定</b>：这个插件每次对话固定要付的 token = 说明文字 + 工具说明。即使没被调用也在付。</p>
        <p><b>区间使用</b>：这段时间里它的功能被真正调用了几次；「未使用」表示装了但一次都没用过，却仍在付固定消耗。</p>
        <p><b>结果 token</b>：功能返回的内容会存进对话历史，之后每一轮都会重新发给模型，是容易被忽视的一笔。</p>
        <p><b>缓存影响</b>：插件的说明里有一部分每轮都会变（比如当前状态），这部分无法命中缓存，只能按原价重算。没有这类内容的插件显示「无」。</p>
        <p>token 为估算值（字符 ÷ 2.5），用于横向比较大小，不适合拿去对账。</p>
      </div>
    </div>`;
}

/* 全局委托：renderUsagePage / 骨架会多次重建按钮，绑一次即可（含加载占位期）。
   诊断卡里的下钻按钮也随 innerHTML 反复重建，同样挂在这里，只绑一次。 */
document.addEventListener('click', (e) => {
  if (e.target?.closest?.('#usage-help-btn')) { openUsageHelpModal(); return; }
  const drill = e.target?.closest?.('.uic-drill[data-udim-go]');
  if (drill) usageInsightDrill(drill.dataset.udimGo);
});

function renderUsageSkeleton() {
  const card = '<div class="usage-card skeleton"><div class="sk-line"></div><div class="sk-line short"></div></div>';
  // 图表占位：一排参差小柱 + 扫光（暗示"这里会出现折线/条形图"）
  const cols = [38, 62, 45, 80, 55, 70, 40, 90, 58, 66, 48, 74, 60, 42]
    .map((h) => `<i class="sk-col" style="height:${h}%"></i>`).join('');
  const chart = (h) => `<div class="sk-chart" style="height:${h}px">${cols}</div>`;
  const h3 = '<div class="sk-line" style="width:64px;height:15px;margin:22px 0 10px"></div>';
  // R219：摘要占位跟着说明卡一起挪到右侧列，图表卡骨架里不再留这一条。
  const sum = '<div class="sk-line" style="width:100%;height:64px;margin:0;border-radius:10px"></div>';
  // 顺序与正式页面一致（控制条 → 三块图 → 统计卡），加载完成时布局不跳。
  // R232（2026-11-14）：Hero 骨架也要逐层对齐正式 Hero ——
  //   ① .uh-ring 是 position:absolute;inset:0，缺了 .uh-ringbox 这层定位父级时
  //      会相对整个 .usage-hero（position:relative）铺开，环跑到卡片中央被占位条横穿；
  //   ② 三个 KPI 原来各是一条 44px 大方块，改成 .uh-kpi 里的 label/数值/副文本三条；
  //   ③ 补 .uh-spark（正式页面 46px 高），否则数据回来时 Hero 会突然长高一截。
  //   原先 padding-bottom:16px 的补偿随之撤掉，改由真实结构撑高。
  // R231：光顺序一致还不够 —— 之前两块图用的是裸 .usage-card-panel，
  // 正式页面里它们分别是 [data-block="days"] 和 .usage-attrib，按天视图下
  // 后者会被 06-stage.css 隐藏。骨架没这些类名，于是加载时多出一块卡、
  // 数据回来又突然消失，看着像"跳了一下"。现在类名与正式页面逐一对上，
  // 显示/隐藏完全交给同一套 [data-udim] 规则。
  // 提示文案（R49）：大数据下统计可能要几秒，让用户知道页面没死。
  return `
    <div class="usage-wrap">
      <div class="usage-head">
        <h2>用量与成本<button class="h2-help" id="usage-help-btn" type="button"
          aria-label="查看用量与成本各区块的说明与计算口径"
          title="这页的数字怎么算的？点开看说明">?</button></h2>
        <span class="muted" style="font-size:12px">正在统计…历史数据较多时可能需要几秒</span>
        <div class="usage-ctrl"><span class="sk-line" style="width:280px;height:26px;margin:0"></span></div>
      </div>
      <div class="usage-hero skeleton">
        <div class="uh-lead">
          <div class="sk-line" style="width:44%;height:12px;margin:0"></div>
          <div class="sk-line" style="width:78%;height:36px;margin:9px 0 0;border-radius:10px"></div>
          <div class="sk-line" style="width:56%;height:12px;margin:9px 0 0"></div>
        </div>
        <div class="uh-kpis">
          ${[0, 1, 2].map(() => `<div class="uh-kpi">
            <div class="sk-line" style="width:72%;height:10px;margin:0"></div>
            <div class="sk-line" style="width:88%;height:18px;margin:7px 0 0"></div>
            <div class="sk-line" style="width:60%;height:9px;margin:7px 0 0"></div>
          </div>`).join('')}
        </div>
        <div class="uh-rate">
          <div class="uh-ringbox">
            <svg class="uh-ring" viewBox="0 0 84 84" aria-hidden="true">
              <circle class="uh-ring-bg" cx="42" cy="42" r="32"/>
              <circle class="uh-ring-fg" cx="42" cy="42" r="32" pathLength="100"
                      transform="rotate(-90 42 42)" style="stroke-dasharray:0 100"/>
            </svg>
          </div>
          <div class="sk-line" style="width:56px;height:10px;margin:2px 0 0"></div>
        </div>
        <div class="uh-spark"><div class="sk-line" style="width:100%;height:46px;margin:0;border-radius:0"></div></div>
      </div>
      <div class="usage-main">
        <div data-block="days" class="usage-sec usage-card-panel">${h3}${chart(180)}</div>
        <div class="usage-side">
          ${sum}
          <div class="usage-insight skeleton"><div class="usage-card skeleton"><div class="sk-line"></div><div class="sk-line short"></div></div></div>
        </div>
      </div>
      <div class="usage-attrib usage-card-panel">${h3}${chart(150)}</div>
    </div>`;
}

/** 建骨架（只建一次，轮询走 updateUsagePage 以免滚动位置丢失）。 */
/* ── 诊断与建议（2026-11-13）──────────────────────────────────────────────
   只用已有 stats 算规则、不额外请求：命中率偏低 / 成本集中在单一模型 /
   单一会话吃掉大半成本。数字只有变成"要不要改"才有用。

   本次增量：卡片补常显核心数字（token / 成本 / 调用 / 单轮 / 均值对比）、
   命中率与占比条、最低命中率会话归因，以及复用左栏维度机制的下钻入口。
   ⚠️ 用户反馈「信息有点太多」后收敛：每卡只留 3 个指标 + 1 条进度条 +
      1 行关键对比，占比不再和标题/进度条重复；口径说明压成一句短语，
      完整口径仍看页头「?」弹窗。改动只删展示项，不改统计口径。
   ⚠️ 统计全部是**区间聚合值**，不是单价明细：不做"按缓存价省了多少钱"，
      渲染层没有 estimateCost 同款口径、价格表也不含缓存折扣系数，硬算必错。
      宁可少一项，只用 stats 里现成的 cost / token / runs 做同口径换算。
   ⚠️ 下钻只复用左栏那套 data-udim（14-chrome.js 的 applyUsageDim），
      不新建第二套 Tab、不写内联 hidden 覆盖。 */
function usageInsightDrill(dim) {
  const target = ['chats', 'models', 'plugins'].indexOf(String(dim)) >= 0 ? String(dim) : '';
  if (!target) return;
  const navBtn = document.querySelector(`#side-nav [data-usage-dim="${target}"]`);
  if (navBtn && navBtn.getAttribute('aria-disabled') !== 'true') {
    // 点一下左栏对应按钮：14-chrome.js 的委托会同步 usageDim、写 data-udim、
    // 刷新左栏高亮并原地重画图表（隐藏块量不到宽度，必须走它那次重绘）。
    navBtn.click();
  } else {
    // 左栏按钮尚未渲染 / 置灰：只写同一个 data-udim，不新建 Tab、不覆盖 hidden。
    // 不调 updateUsagePage —— 它被 14-chrome.js 包了一层 applyUsageDim，
    // 会按它自己记住的维度把值改回去。
    const page = document.querySelector('#usage-page');
    if (page) page.dataset.udim = target;
  }
  const block = document.querySelector(`#usage-page [data-block="${target}"]`);
  if (!block) return;
  const det = block.querySelector('details.usage-details');
  if (det) det.open = true;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  try {
    block.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  } catch (e) {
    const pane = document.querySelector('#usage-page');
    if (pane) pane.scrollTop = 0;
  }
}

function renderUsageInsights(stats, box) {
  const host = box.querySelector('#usage-insight');
  if (!host) return false;
  const t = stats?.totals || {};
  const totalCost = Number(t.cost) || 0;
  const totalRuns = Math.max(0, Number(t.runs) || 0);
  const avgUnit = totalCost / Math.max(1, totalRuns);   // 全站单轮成本，除零保护
  const cards = [];

  // 所有对外展示的数字先过 num()：缺失 / null / 非有限值一律当 0，
  // 绝不把 NaN / Infinity / undefined 拼进 HTML。
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const pct0 = (v) => (Math.max(0, Math.min(1, num(v))) * 100).toFixed(0);
  const width = (v) => (Math.max(0, Math.min(1, num(v))) * 100).toFixed(1);
  const cnt = (v) => String(Math.max(0, Math.round(num(v))));
  const modelName = (m) => (m.vendor
    ? `${m.vendor}：${m.model ?? m.key ?? ''}`
    : String(m.model ?? m.key ?? '未知模型'));
  const chatName = (c) => formatChatTitle(c.key, chatNameOf(c.key));
  /** R211：单轮成本 + 与全站均值的倍数，压成一行。
   *  上一版把「单轮成本」单列一个指标、又在 rows 里写「单轮 vs 全站均值 /
   *  全站 ¥… · 本项 N 倍」，两处重复且字数偏多。现在合并成一行，只留
   *  本项数值 + 相对倍数；成本为 0 时不比较，不编数字。 */
  const unitNote = (unit) => (avgUnit > 0
    ? `${fmtYuan(unit)} · 全站 ${(num(unit) / avgUnit).toFixed(1)} 倍`
    : fmtYuan(unit));
  const kvHtml = (k, v) => `<div class="uic-kv"><span class="uic-k">${esc(k)}</span><b class="uic-v">${esc(v)}</b></div>`;

  // R211：脏数据兜底 —— 后端正常不会给 null / 字符串元素，但排序比较器会
  // 直接读 b.cost，这种输入一进来就抛 TypeError、整块用量页渲染中断。先滤掉
  // 非对象元素，后面的 top.cost / modelName() / chatName() 才都有对象可用。
  const cleanRows = (arr) => (Array.isArray(arr) ? arr : []).filter((x) => x && typeof x === 'object');
  const byCost = (a, b) => num(b.cost) - num(a.cost)
    || String(a.key ?? '').localeCompare(String(b.key ?? ''));
  const models = cleanRows(stats?.models).slice().sort(byCost);
  const chats = cleanRows(stats?.chats).slice().sort(byCost);

  // ① 峰谷成本（R212）：替换原先与 Hero 圆环 / 输入 token 重复的「缓存命中率」卡。
  //    Hero 已展示估算成本、缓存命中率(圆环)、输入 token，再放一张缓存卡是纯重复；
  //    后端 totals 里的 peakCost / offPeakCost / peakRatio(按 token) 是 Hero 完全没有
  //    的维度，用它讲「峰时贵」这个新故事：峰时只占 peakRatio 的 token，却吃了绝大部分
  //    成本（峰时单价更高）。整张卡自洽、不下钻——峰谷是时间维度，现有 chats/models/
  //    plugins 下钻都不展示峰谷拆分，硬下钻会误导，故省略「看明细」按钮。
  //    成本占比用成本口径算（peakCost/(peak+offPeak)），与后端 peakRatio（token 口径）
  //    分开，不在同一个数字上混两个口径。两者都为 0（没有峰谷区分的价格）则不发卡。
  const peakCost = Math.max(0, num(t.peakCost));
  const offPeakCost = Math.max(0, num(t.offPeakCost));
  const peakCostRatio = (peakCost + offPeakCost) ? peakCost / (peakCost + offPeakCost) : 0;
  const peakTokRatio = num(t.peakRatio);   // 后端按 token 算，独立于成本占比
  if (peakCost + offPeakCost > 0) {
    // R216：三张卡统一成「环形占比 + 标题 + 明细行」同一骨架（用户「风格不符，
    //   怎么感觉可以考虑饼状图」）。峰谷卡不再单独出模板：环 = 峰时成本占比，
    //   三行分别是峰时金额 / 谷时金额 / token 口径占比。
    //   tone 用 warn（橙）—— 峰时贵本来就是提醒语义，颜色由 tone 驱动，不写行内色。
    cards.push({
      key: 'peak-cost',
      tone: 'warn',
      ring: peakCostRatio,          // 成本口径，环里显示
      title: '峰时成本占比',
      rows: [
        ['峰时', fmtYuan(peakCost)],
        ['谷时', fmtYuan(offPeakCost)],
        ['token 占比', `${pct0(peakTokRatio)}%`]   // 后端 token 口径，与环的成本口径分开
      ]
    });
  }

  // ② 成本集中在单一模型：环 = 占比，明细 3 行 + 下钻。
  //    R211：删说明句 / 口径定义行；「单轮成本」并入 rows，不再单列第三个指标。
  //    R216：标题只留模型名（占比已在环里，标题再写一遍就是重复），
  //          旧标题「成本集中在「X」（67%）」在窄栏里还会被省略号截掉后半句。
  if (models.length && totalCost > 0) {
    const top = models[0];
    const share = num(top.cost) / totalCost;
    if (share >= 0.6) {
      const runs = Math.max(1, Math.round(num(top.runs)));
      const unit = num(top.cost) / runs;
      cards.push({
        key: 'top-model',
        tone: 'info',
        ring: share,
        title: modelName(top),
        rows: [
          ['区间成本', fmtYuan(top.cost)],
          ['调用次数', `${cnt(top.runs)} 次`],
          ['单轮成本', unitNote(unit)]
        ],
        drill: { dim: 'models', label: '看明细' }
      });
    }
  }

  // ③ R219 撤掉「单一会话吃掉大半成本」卡：它与右侧「当前视图」说明卡里
  //    「按会话」那条结论是同一件事（top 会话 + 占比），且 >=50% 的阈值让它在
  //    49% 这类场景里干脆缺席。位置让给说明卡，右栏不再并排写两遍同一个数字。

  if (!cards.length) {
    host.hidden = true;
    host.innerHTML = '';
    host.dataset.sig = '';
    return false;
  }
  host.hidden = false;
  // R211：卡片不再渲染说明句（uic-body）与口径定义（uic-hint）—— 这两处是纯文字、
  //   信息量最低，用户两次反馈「字有点多」。
  // R216：三张卡统一骨架 —— 左侧环形占比 + 右侧「标题 / 明细行 / 下钻」。
  //   环用 conic-gradient 画，--p 是百分比；颜色由卡片的 tone 类决定（见 04-usage.css）。
  //   峰谷卡没有下钻，.uic-foot 为空，靠 CSS 的 :empty 收起，三卡结构仍然一致。
  // R220：诊断卡不再是「环 + 信息」的小卡片，而是版面读数 ——
  //   一个超大百分比（呼应 Hero 的 ¥3.14）+ 3px 细进度条 + 细线分隔的明细行。
  //   右栏因此从「等权卡片堆叠」变成「一主一辅 + 贴底注解」的编辑式层次。
  const cardHtml = (c) => `
    <div class="usage-insight-card ${esc(c.tone)}">
      <div class="uic-readout">
        <span class="uic-big">${esc(pct0(c.ring))}<span class="uic-pct">%</span></span>
        <div class="uic-readout-side">
          <div class="uic-title" title="${esc(c.title)}">${esc(c.title)}</div>
          <div class="uic-track"><i style="width:${width(c.ring)}%"></i></div>
        </div>
      </div>
      <div class="uic-kvs">${(c.rows || []).map(([k, v]) => kvHtml(k, v)).join('')}</div>
      <div class="uic-foot">${c.drill ? `<button class="uic-drill" type="button" data-udim-go="${esc(c.drill.dim)}">${esc(c.drill.label)} ›</button>` : ''}</div>
    </div>`;
  // R228（2026-11-14，用户反馈「切范围时右栏希望数字和占比条在变，而不是重建」）：
  // 诊断卡改为**按键调和（keyed reconciliation）**——按 c.key 找 DOM 里的同款卡：
  //   · 大百分比数字滚动到新值（easeOutCubic 560ms，与 Hero 成本数字同节奏）；
  //   · 占比条宽度改 inline style，交给 CSS transition 平滑过渡（不再 scaleX 重播）；
  //   · 明细行键序不变时只原地改 .uic-v 文本；
  //   · 只有卡出现/消失/明细行结构变化才动 DOM —— 新插入的卡照播 R224 入场动画。
  const tweenPct = (el, ringValue) => {
    const target = Math.round(Math.max(0, Math.min(1, num(ringValue))) * 100);
    const txt = el.firstChild;                       // 文本节点（后随 .uic-pct）
    if (!txt || txt.nodeType !== 3) return;
    const from = Number(el.dataset.v ?? target);
    el.dataset.v = String(target);
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || from === target) { txt.textContent = String(target); return; }
    const t0 = performance.now();
    const DUR = 560;
    const ease = (p) => 1 - Math.pow(1 - p, 3);
    const step = (now) => {
      const p = Math.min(1, (now - t0) / DUR);
      txt.textContent = String(Math.round(from + (target - from) * ease(p)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
  const existing = new Map();
  host.querySelectorAll(':scope > .usage-insight-card').forEach((el) => existing.set(el.dataset.uicKey ?? '', el));
  const kept = new Set();
  cards.forEach((c, idx) => {
    let el = existing.get(c.key);
    if (el) {
      // ── 原位更新（不重建，不重播入场动画）──
      if (el.dataset.tone !== c.tone) { el.className = `usage-insight-card ${esc(c.tone)}`; el.dataset.tone = c.tone; }
      tweenPct(el.querySelector('.uic-big'), c.ring);
      const bar = el.querySelector('.uic-track i');
      if (bar) bar.style.width = `${width(c.ring)}%`;
      const titleEl = el.querySelector('.uic-title');
      if (titleEl && titleEl.textContent !== c.title) { titleEl.textContent = c.title; titleEl.title = c.title; }
      const kvBox = el.querySelector('.uic-kvs');
      const rowKeys = (c.rows || []).map(([k]) => k).join('\u0001');
      if (kvBox && kvBox.dataset.keys !== rowKeys) {
        kvBox.dataset.keys = rowKeys;               // 行结构变了才重建明细
        kvBox.innerHTML = (c.rows || []).map(([k, v]) => kvHtml(k, v)).join('');
      } else if (kvBox) {
        const vs = kvBox.querySelectorAll('.uic-v');
        (c.rows || []).forEach(([k, v], i) => { const n = vs[i]; if (n && n.textContent !== String(v)) n.textContent = String(v); });
      }
      const footEl = el.querySelector('.uic-foot');
      const footHtml = c.drill ? `<button class="uic-drill" type="button" data-udim-go="${esc(c.drill.dim)}">${esc(c.drill.label)} ›</button>` : '';
      if (footEl && footEl.innerHTML !== footHtml) footEl.innerHTML = footHtml;
    } else {
      // ── 新卡：走模板插入（入场动画由 CSS 在插入时自动播放一次）──
      const tmp = document.createElement('div');
      tmp.innerHTML = cardHtml(c).trim();
      el = tmp.firstChild;
      el.dataset.uicKey = c.key;
      el.dataset.tone = c.tone;
      const big = el.querySelector('.uic-big');
      if (big) big.dataset.v = String(Math.round(num(c.ring) * 100));
      const kv = el.querySelector('.uic-kvs');
      if (kv) kv.dataset.keys = (c.rows || []).map(([k]) => k).join('\u0001');
    }
    kept.add(c.key);
    // 顺序对齐：只在不在预期位置时才移动节点（appendChild/insertBefore 会重插
    // 节点、导致 CSS 入场动画重播 —— 能不动就不动）
    if (host.children[idx] !== el) host.insertBefore(el, host.children[idx] || null);
  });
  existing.forEach((el, key) => { if (!kept.has(key)) el.remove(); });
  const sig = cards.map((c) => c.key).join(',');
  if (host.dataset.sig !== sig) { host.dataset.sig = sig; }
  return true;
}

let usageSeenOnce = false;        // 是否渲染过一次用量页：入场动画只在首次播放
function renderUsagePage(stats, st, prices) {
  const box = $('#usage-page');
  if (!box) return;
  // 首次进入播入场动画；之后切页重建 DOM 不再重播（见 04-usage.css 的 [data-fresh] 段）——
  // 否则每次切页都"整页浮现"，数据明明还在却像刚加载完，被感知为慢。
  box.dataset.fresh = usageSeenOnce ? '0' : '1';
  usageSeenOnce = true;

  box.innerHTML = `
    <div class="usage-wrap">
      <!-- R195（2026-11-04）：控制条挪进页头一行（标题左 / 选项右，用户要求）。
           ⚠️ 它必须是 [data-block="days"] 的兄弟节点（现在住在 .usage-head 里），
              不能放进块内 —— 选「今日 / 24 小时」时后端 mode ≠ 'days'，
              updateUsagePage 会把整个 [data-block="days"] 隐藏（那时光图表本来
              就没数据）——控制条若住在里面会跟着一起消失（实测 bug：
              点「今日」后所有按钮都不见了）。 -->
      <div class="usage-head">
        <h2>用量与成本<button class="h2-help" id="usage-help-btn" type="button"
          aria-label="查看用量与成本各区块的说明与计算口径"
          title="这页的数字怎么算的？点开看说明">?</button></h2>
        <div class="usage-ctrl">
          <span class="usage-metrics" title="选择三张图表显示的指标">
            <span class="usage-metrics-label">图表</span>
            ${USAGE_METRICS.map(([k, label]) => `<button class="btn btn-small" data-metric="${k}">${label}</button>`).join('')}
          </span>
          <span class="usage-sep"></span>
          ${USAGE_RANGES.map(([v, label]) => `<button class="btn btn-small" data-range="${v}">${label}</button>`).join('')}
          <button class="btn btn-small" id="usage-refresh-btn" title="立即重算（跳过 3 小时缓存）">刷新</button>
          <span class="usage-fresh" id="usage-updated"></span>
        </div>
      </div>

      <!-- 2026-11-13：结论区重做成 Hero —— 一个大数 + 四个内联指标，
           取代原先五张等宽卡片并排（那是旧页面最明显的影子）。
           data-field / id 保持唯一，updateUsagePage 照旧填充。 -->
      <div class="usage-hero" data-zone="hero">
        <div class="uh-lead">
          <div class="uh-label">估算成本<span class="uh-range" data-hero-range></span></div>
          <div class="uh-value" data-field="cost">-</div>
          <div class="uh-sub" data-field="cost-sub">-</div>
        </div>
        <div class="uh-kpis">
          <div class="uh-kpi">
            <span class="uh-kl">模型调用</span>
            <b data-field="runs">-</b>
            <i data-field="runs-sub">-</i>
            <button class="uh-link" id="runs-card" type="button" title="查看各类工具分别调用了多少次">工具明细 ›</button>
          </div>
          <div class="uh-kpi">
            <span class="uh-kl">输入 token</span>
            <b data-field="prompt">-</b>
            <i data-field="prompt-sub">-</i>
          </div>
          <div class="uh-kpi">
            <span class="uh-kl">搜索次数</span>
            <b data-field="search">-</b>
            <i data-field="search-sub">-</i>
          </div>
        </div>
        <div class="uh-rate">
          <div class="uh-ringbox">
            <!-- SVG 圆环取代 conic-gradient（2026-11-13 用户反馈"不圆润"）：
                 conic 的弧两端是平头切线，90% 时缺口夹在两个平头之间显得生硬；
                 stroke-linecap:round 给两端真正的圆头，dasharray 还能平滑过渡。 -->
            <svg class="uh-ring" data-field="rate-ring" viewBox="0 0 84 84" aria-hidden="true"
                 title="缓存命中率分档：≥90% 绿 · 75–90% 橙 · &lt;75% 红">
              <circle class="uh-ring-bg" cx="42" cy="42" r="32"/>
              <circle class="uh-ring-fg" cx="42" cy="42" r="32" pathLength="100"
                      transform="rotate(-90 42 42)"/>
            </svg>
            <b data-field="rate">-</b>
          </div>
          <span class="uh-kl">缓存命中</span>
          <i data-field="rate-sub">-</i>
        </div>
        <!-- 迷你趋势：一眼看出这段时间是"平稳/爬升/尖峰"，不用先滚到趋势卡 -->
        <div class="uh-spark" data-field="spark" aria-hidden="true"></div>
      </div>

      <div class="usage-main">
      <div data-block="days" class="usage-sec usage-card-panel">
        <div class="usage-sec-head">
          <h3 class="usage-h3">趋势</h3>
          <span class="usage-sec-meta" data-meta="days"></span>
        </div>
        <!-- R219：动态摘要已收进右侧「当前视图」卡，图表卡只放标题 / 图 / 折叠数值表。 -->
        <!-- 时间序列 → 折线图（看趋势） -->
        <div class="usage-chart" data-chart="days"></div>
        <!-- 原始数值表：默认折叠，精确数字与点击下钻都还在 -->
        <details class="usage-details">
          <summary>数值表</summary>
          <table class="usage-table clickable" data-table="days">
            <thead><tr><th>日期</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">缓存命中</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody></tbody>
          </table>
        </details>
      </div>

      <div class="usage-side">
        <!-- R219：四条 data-sum 共用一张卡，由 04-usage.css 按 data-udim 只显示当前维度那一条。 -->
        <div class="usage-view-note" id="usage-view-note" aria-live="polite">
          <p class="usage-sec-sum" data-sum="days"></p>
          <p class="usage-sec-sum" data-sum="chats"></p>
          <p class="usage-sec-sum" data-sum="models"></p>
          <p class="usage-sec-sum" data-sum="plugins"></p>
        </div>
        <aside class="usage-insight" id="usage-insight" aria-live="polite"></aside>
      </div>
      </div>

      <!-- 维度切换由**左侧栏**（「统计维度」四项）负责：它写 #usage-page 的
           data-udim，由 06-stage.css 的规则决定哪个 [data-block] 可见。
           ⚠️ 曾经这里还有一套「按会话/按模型/按插件」的横排 Tab（用 hidden 控制），
              和侧栏是两套机制抢同一批 [data-block] —— 侧栏点击被 hidden 压掉，
              表现为"点了没反应"。已删除，只保留侧栏一套。 -->
      <div class="usage-attrib usage-card-panel" id="usage-attrib">

      <div data-block="chats" class="usage-sec">
        <div class="usage-sec-head">
          <h3 class="usage-h3">按会话</h3>
          <span class="usage-sec-meta" data-meta="chats"></span>
        </div>
        <!-- 分类排名 → 横向条形（折线会暗示"前后有趋势"，反而误导） -->
        <div class="usage-chart" data-chart="chats"></div>
        <details class="usage-details">
          <summary>数值表</summary>
          <table class="usage-table clickable" data-table="chats">
            <thead><tr><th>会话</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody></tbody>
          </table>
        </details>
      </div>

      <div data-block="models" class="usage-sec">
        <div class="usage-sec-head">
          <h3 class="usage-h3">按模型</h3>
          <span class="usage-sec-meta" data-meta="models"></span>
        </div>
        <div class="usage-chart" data-chart="models"></div>
        <details class="usage-details">
          <summary>数值表</summary>
          <!-- ⚠️ 这个按钮从 h3 挪进来了（表格现在默认折叠，按钮留在标题上会点不着） -->
          <div class="usage-details-tools">
            <button class="btn btn-small ub-expand" id="models-expand" style="display:none">展开全部</button>
          </div>
          <table class="usage-table clickable" data-table="models">
            <thead><tr><th>模型（渠道：模型 id）</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody></tbody>
          </table>
        </details>
      </div>

      <!-- ── 按插件（2026-10-19 新增）──
           回答"是谁花的 token"：每个插件每次请求的固定开销（提示词片段 + 工具定义）、
           区间内实际调用次数与返回内容 token、以及易变片段对缓存命中率的影响。
           数据来自 /api/usage/plugins（src/plugin-usage.js），数值为估算值
           （字符 / 2.5，与 llm.js 的 LCP 日志同口径）。 -->
      <div data-block="plugins" class="usage-sec">
        <div class="usage-sec-head">
          <h3 class="usage-h3">按插件</h3>
          <!-- 段落头右侧：先给一句计量（几个插件、几个在用），再放本块专属的排序切换。
               四个块的段落头都是「左标题 + 右小字/小按钮」这一副骨架（2026-10-19 统一）。 -->
          <span class="usage-sec-side">
            <span class="usage-sec-meta" data-meta="plugins"></span>
            <span class="up-metric" data-up="metricbar">
              <span class="up-metric-label">排行依据</span>
              <button class="btn btn-small" type="button" data-plugin-metric="total">区间总消耗</button>
              <button class="btn btn-small" type="button" data-plugin-metric="fixed">每次固定</button>
              <button class="btn btn-small" type="button" data-plugin-metric="calls">调用次数</button>
            </span>
          </span>
        </div>

        <div class="usage-chart" data-chart="plugins"></div>

        <details class="usage-details">
          <summary>数值表</summary>
          <table class="usage-table clickable" data-table="plugins">
            <thead><tr>
              <th>插件</th>
              <th class="r">每次固定</th>
              <th class="r" title="区间总消耗 = 每次固定 × 调用次数 + 工具结果">区间总消耗</th>
              <th class="r" title="插件写给模型看的「行为说明」占用">行为说明</th>
              <th class="r" title="插件工具的说明书（名称、描述、参数）占用">工具说明</th>
              <th class="r">区间使用</th>
              <th class="r" title="工具返回结果占用，会作为历史反复重发">结果 token</th>
              <th class="r" title="易变内容占比：越高，每轮越难命中缓存">缓存影响</th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </details>
      </div>
      </div>

    </div>`;

  // 「调用次数」卡片可点开明细（骨架重建后重新绑定，所以放在 renderUsagePage 里）
  const runsCard = $('#usage-page #runs-card');
  if (runsCard) runsCard.addEventListener('click', () => openToolBreakdown());

  $$('#usage-page [data-range]').forEach((el) => {
    el.addEventListener('click', () => {
      usageRange = el.dataset.range;
      // R226：inPlace —— 切范围原地更新数值层，不重建 DOM、不重播入场动画
      loadUsageView({ force: true, keepContent: true, inPlace: true });
    });
  });
  // P0-03：刷新点击即进入"重算中"态（防抖 + 反馈），成功/失败都恢复按钮
  const refreshBtn = $('#usage-refresh-btn');
  refreshBtn?.addEventListener('click', () => {
    if (refreshBtn.disabled) return;
    refreshBtn.disabled = true;
    refreshBtn.textContent = '重算中…';
    // R230：带 keepContent+inPlace —— 强制加载也走原地更新，不再整页重建：
    // ①「重算中…」按钮节点不会被 renderUsagePage 重建冲掉，反馈终能显示；
    // ② 命中缓存时不再 renderUsagePage 两次，且不丢「展开全部」等前端状态；
    // ③ 仍然 hard=true（服务端跳过 3h 缓存重算），数据照常是最新的。
    Promise.resolve(loadUsageView({ force: true, hard: true, keepContent: true, inPlace: true }))
      .finally(() => { refreshBtn.disabled = false; refreshBtn.textContent = '刷新'; });
  });

  // 图表指标切换：只重画图，不重新请求接口（数据没变）
  $$('#usage-page [data-metric]').forEach((el) => {
    el.addEventListener('click', () => {
      state.usageMetric = el.dataset.metric;
      const args = state.usageRenderArgs;
      if (args) updateUsagePage(args.stats, args.st, args.prices);
    });
  });

  // ── 图表点击 / 键盘下钻（委托挂 box 上，必须防重复绑定）──
  // ⚠️（2026-10-12 修「明细弹窗多开」）box 是 #usage-page —— index.html 里的
  //    **持久容器**，而本函数会被反复调用（切到用量页签 / 切时间范围 / 点刷新
  //    都走 loadUsageView({force:true}) → 在此重建骨架）。委托监听器挂在 box
  //    自身上，innerHTML 重建**清不掉它们** —— 每调用一次就多积一份。
  //    积 N 份后，点一次图表条形会同时触发 N 次 openUsageBreakdown → 弹出 N 个
  //    完全相同的「明细」弹窗（用户报障：「点击明细弹出很多个弹窗」，且每次
  //    刷新后再点都会再多一个）。表格行的绑定挂在每次重建的 table 元素上，
  //    不受影响；此处两个是唯一挂在持久容器上的。
  //    与 bindSessionListDelegation（dataset.delegated）/ bindMarketList
  //    （dataset.mkBound）/ __chatDelBound、__quoteBound 同一约定：只绑一次。
  if (box.dataset.usageDrillBound !== '1') {
    box.dataset.usageDrillBound = '1';
    // 图表点击 → 与表格行点击走同一套下钻
    box.addEventListener('click', (e) => {
      const hit = e.target.closest('.usage-chart [data-key]');
      if (!hit) return;
      const chart = hit.closest('[data-chart]');
      const dim = chart?.dataset.chart === 'days' ? 'day' : chart?.dataset.chart === 'chats' ? 'chat' : 'model';
      openUsageBreakdown(dim, hit.dataset.key);
    });
    // 键盘可达：条形图是 tabindex 元素，回车等同点击
    box.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const hit = e.target.closest?.('.usage-chart [data-key]');
      if (!hit) return;
      e.preventDefault();
      const chart = hit.closest('[data-chart]');
      const dim = chart?.dataset.chart === 'days' ? 'day' : chart?.dataset.chart === 'chats' ? 'chat' : 'model';
      openUsageBreakdown(dim, hit.dataset.key);
    });
  }

  bindUsageResize();
  bindUsageDimObserver();   // R233b：维度切换不重渲染 → 切回按会话立刻补占位调和

  // 行点击 → 弹明细
  box.querySelector('[data-table="days"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('day', tr.dataset.key);
  });
  box.querySelector('[data-table="chats"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('chat', tr.dataset.key);
  });
  box.querySelector('[data-table="models"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('model', tr.dataset.key);
  });

  // 「展开全部 / 收起」按钮：显隐与文案由 updateUsagePage 里的 fill() 负责，
  // 但此前**没有任何地方监听它的点击**，也没有代码把 tbody.dataset.expanded 置为 '1' ——
  // 结果是：模型超过 20 行时按钮会出现、写着「展开全部（还有 N 行）」，点下去却毫无反应，
  // 剩下的行永远看不到。这里补上开合逻辑（复用 updateUsagePage 重绘，不重新请求接口）。
  const modelsExpandBtn = box.querySelector('#models-expand');
  if (modelsExpandBtn) {
    modelsExpandBtn.addEventListener('click', () => {
      const tb = box.querySelector('[data-table="models"] tbody');
      const args = state.usageRenderArgs;
      if (!tb || !args) return;
      tb.dataset.expanded = tb.dataset.expanded === '1' ? '0' : '1';
      updateUsagePage(args.stats, args.st, args.prices);
    });
  }

  updateUsagePage(stats, st, prices);

  // 插件块用**上次的结果**先恢复一份（2026-11-13 修"切到按插件先空白一下"）。
  // 背景：切页/切范围会重建整页 DOM，插件块的 DOM 也跟着变空；它的数据来自
  // 独立接口（/api/usage/plugins，同步算约 120ms + 网络），期间「按插件」维度
  // 就是一片空白。这里用 state.pluginUsage 立刻填好，随后 loadPluginUsage
  // 到达时再覆盖一次。范围不一致就不恢复（那是另一份数据）。
  if (state.pluginUsage && pluginUsageRange === usageRange) {
    try { renderPluginUsage(state.pluginUsage); } catch (e) { /* 恢复失败不阻塞主页 */ }
  }
}

/** 只更新数值与表格行，不碰骨架。 */
function updateUsagePage(stats, st, prices) {
  const box = $('#usage-page');
  if (!box) return;
  // 记住最近一次渲染参数：供「展开全部/收起」按钮与窗口缩放重画图表使用。
  // range 必须一起记 —— resize 回调要靠它判断这份 stats 是不是当前范围的
  // （见 bindUsageResize 里的注释）。
  state.usageRenderArgs = { stats, st, prices, range: usageRange };
  const t = stats?.totals || {};
  const cfg = state.config || {};

  // 统一存字符串：曾经这里把数字直接赋给 textContent（如 runs=0 时存的是数字 0
  // 而非 '0'）。浏览器会隐式转换所以显示没问题，但类型不一致会在别处埋雷
  // （比较、测试断言、序列化时都可能踩到）。这里显式转成字符串。
  const set = (f, v) => {
    const el = box.querySelector(`[data-field="${f}"]`);
    if (!el) return;
    const s = String(v);
    if (el.textContent !== s) el.textContent = s;
  };
  // R229：Hero 大数字统一「滚动到新值」（easeOutCubic 480ms，与 setCostValue
  // 完全一致——成本早就滚动，模型调用/输入 token/搜索次数却直跳，一页两种脾气）。
  // 中间值走同一个 fmt，最终值与直接写完全一致；副行说明文字仍用 set 直换。
  const tweenField = (field, to, fmt) => {
    const el = box.querySelector(`[data-field="${field}"]`);
    if (!el) return;
    const target = Math.max(0, Number(to) || 0);
    const from = Number(el.dataset.v ?? target);
    el.dataset.v = String(target);
    const final = fmt(target);
    if (reducedMotion() || from === target) {
      if (el.textContent !== final) el.textContent = final;
      return;
    }
    const t0 = performance.now();
    const DUR = 480;
    const ease = (p) => 1 - Math.pow(1 - p, 3);
    const step = (now) => {
      const p = Math.min(1, (now - t0) / DUR);
      const s = fmt(from + (target - from) * ease(p));
      if (el.textContent !== s) el.textContent = s;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  // 价格口径说明（不再显示"当前模型" —— 全天可能换过多个模型）
  const today = st?.usage || {};
  tweenField('runs', t.runs || 0, (v) => String(Math.round(v)));
  // ⚠️ 这两个数字**口径不同**，曾经并排显示成「132 / 今日 800 次」，
  // 用户必然以为数据错了：
  //   大字 runs      = LLM 调用次数（本页统计，一个会话多轮就是多次）
  //   /api/status 的 usage.runs = 会话运行次数（每完成一个会话 +1）
  // 现在把口径写进文案，避免"看起来自相矛盾"。
  set('runs-sub', `今日 ${today.runs ?? 0} 次会话运行`);
  // 搜索次数：只列数量，不参与成本计算（搜索通常是资源包或免费的）
  const searches = Number(stats?.searchCount) || 0;
  // ⚠️ fmtTok 是 toLocaleString，浮点中间值会短暂显示 3 位小数（1,234.567），
  // 滚动过程中取整，最终值不受影响（token/次数本来就是整数口径）。
  tweenField('search', searches, (v) => fmtTok(Math.round(v)));
  // 拆开显示搜索与抓取的构成（曾经三元两分支文案相同，判定是死逻辑）
  {
    const nSearch = Number(stats?.toolCounts?.web_search) || 0;
    const nFetch = Number(stats?.toolCounts?.web_fetch) || 0;
    set('search-sub', searches
      ? `搜索 ${nSearch} · 抓网页 ${nFetch}`
      : '本区间没有联网');
  }
  tweenField('prompt', t.promptTokens, (v) => fmtTok(Math.round(v)));
  set('prompt-sub', `输出 ${fmtTok(t.completionTokens)}`);
  // P1-06（2026-11-14）：区间内没有任何调用时，命中率是"无数据"而不是"缓存很差"
  // ——曾经 fmtRate(0) 显示红色的 0.0%，把新装首次使用 / 「今日」无调用吓一跳。
  // 没调用时显示 '—'（环形也走灰色 none 档，见下方 tone）。
  const hasRuns = (Number(t.runs) || 0) > 0;
  set('rate', hasRuns ? fmtRate(t.cacheHitRate) : '—');
  set('rate-sub', `命中 ${fmtTok(t.cachedTokens)} / 输入 ${fmtTok(t.promptTokens)}`);
  // P1-05：这行分母是命中率唯一的口径说明（CSS 截断已改为换行），补 title 双保险
  const rateSubEl = box.querySelector('[data-field="rate-sub"]');
  if (rateSubEl) rateSubEl.title = '缓存命中率 = 命中 token ÷ 输入 token';
  setCostValue(box, t.cost);
  // ⚠️（2026-10-17 N7）成本 0 有**两种完全不同的含义**，必须让用户分得清：
  //   ① 真的没花钱（免费模型 / 本区间没调用）—— 正常；
  //   ② **没匹配到官方单价**（走中转站、或模型不在内置价格表里）——
  //      算术上只能得 0，但看起来像"统计坏了 / 价格算错了"。
  //   实测本机：模型是 `sensenova-6.8-flash-lite`（token.sensenova.cn 中转站），
  //   内置官方价格表里查无此模型 → 快照里 cost 全为 0，而 token 有近千万。
  //   这不是 bug（顶栏早就为此不显示 ¥0），但用量页的副标题上没说清楚，
  //   容易被误当成故障。这里补一句，并指向可自定义单价的位置。
  const costZero = !(Number(t.cost) > 0);
  const noPriceHint = (costZero && (Number(t.totalTokens) || 0) > 0)
    ? '未匹配到内置官方单价（中转站 / 未收录模型），可在「设置 → 模型与搜索 → 当前模型单价」自定义'
    : '';
  // 副标题：区间标签已搬到上面的胶囊里，这里改放"日均"——大数是总额，
  // 日均是它旁边最有决策价值的一个数。成本为 0（没匹配到单价）时不写日均，
  // 否则会出现"日均 ¥0"这种误导。
  {
    const dayCount = (stats?.days || []).length;
    const totalCost = Number(t.cost) || 0;
    const bits = [];
    if (dayCount >= 2 && totalCost > 0) bits.push(`日均 ${fmtYuan(totalCost / dayCount)} · 共 ${dayCount} 天`);
    if (noPriceHint) bits.push(noPriceHint);
    set('cost-sub', bits.join(' · ') || '按当前区间累计估算');
  }
  const rate = Number(t.cacheHitRate);
  const ratePct = Number.isFinite(rate) ? Math.max(0, Math.min(100, rate * 100)) : 0;
  // 2026-11-13：命中率从"横条"升级成"环形仪表"（SVG 圆环 + 圆头描边，实现细节见
  // 04-usage.css 的「环形命中率仪表」段与模板注释）。
  // 分档配色沿用用户定的阈值：≥90% 绿 / 75–90% 橙 / <75% 红。
  const ring = box.querySelector('[data-field="rate-ring"]');
  if (ring) {
    // P1-06：没有调用 → 'none' 灰档（无数据），不落到 'bad' 红档
    const tone = !hasRuns ? 'none' : ratePct >= 90 ? 'ok' : ratePct >= 75 ? 'warn' : 'bad';
    const pct = ratePct.toFixed(1);
    ring.dataset.tone = tone;
    // SVG 圆环：dasharray 按 pathLength=100 归一化，"pct 100" = 弧长 pct%。
    // stroke-linecap:round 让弧两端是圆头（conic-gradient 版是平头，用户嫌不圆润）。
    const fg = ring.querySelector('.uh-ring-fg');
    if (fg) {
      if (ring.dataset.painted === '1') {
        fg.style.strokeDasharray = `${pct} 100`;
      } else {
        // 刚插进 DOM 的元素：此时写目标值不会有过渡（首次样式计算就已是终值）。
        // 等两帧让 0% 的初始样式先生效，再写目标值 —— 环才会"长"出来。
        ring.dataset.painted = '1';
        requestAnimationFrame(() => requestAnimationFrame(() => {
          fg.style.strokeDasharray = `${pct} 100`;
        }));
      }
    }
  }

  // 范围按钮高亮
  $$('#usage-page [data-range]').forEach((el) => {
    el.classList.toggle('btn-primary', el.dataset.range === String(usageRange));
  });

  // 统计新鲜度：服务端把统计结果缓存住了（默认 3 小时一次），所以这页的数字
  // 未必是"刚刚"的。必须把算出来的时刻摆出来 —— 否则用户会拿一个几小时前的
  // 成本数当成实时的，那比"慢"更糟。想立刻要最新的就点右边「刷新」。
  const fresh = box.querySelector('#usage-updated');
  if (fresh) {
    const at = Number(stats?.computedAt) || 0;
    const txt = at ? `数据更新于 ${fmtTime(at)}` : '';
    if (fresh.textContent !== txt) fresh.textContent = txt;
    fresh.title = '用量统计每 3 小时自动重算一次；点「刷新」立即重算。'
      + '页面顶部的「今日」概览是实时的，不受此缓存影响。';
  }

  // 单日/24小时 → 隐藏"按天"。P1-01（2026-11-14）：'all' 模式后端同样返回完整
  // days（20+ 个点），按天块必须可达 —— 曾经只用 mode==='days' 判断，把「全部」
  // 范围的趋势图整块藏掉，左栏「按天」还跟着置灰，用户切不回来。
  const daysBlock = box.querySelector('[data-block="days"]');
  if (daysBlock) daysBlock.style.display = (stats?.mode === 'days' || stats?.mode === 'all') ? '' : 'none';

  // 行数很多时（按模型常有几十行）默认只显示前 N 行，点"展开全部"再看全部。
  // 注意：后端不截断（保证求和一致），这里只是前端显示层面的折叠。
  const COLLAPSE_AT = 20;
  /**
   * 按当前指标降序排（与横向条形图 usageBars 用的是同一个 metricOf）。
   *
   * ⚠️ 曾经表格直接用后端顺序（cost 优先，见 app.js 的 mergeGroups），
   * 而条形图按**当前选中指标**排 —— 于是切到「Token」指标时，
   * 「按模型」的图按 token 排、它下面的表还按成本排，同一个维度两种顺序，
   * 用户对照时会以为数据错了。
   *
   * 排序必须**稳定**：大量条目 cost 为 0，若只按指标值比较，
   * 相等项的相对顺序取决于后端 Map 的插入序（= readdirSync 顺序，
   * 依赖文件系统），每次刷新可能不一样。所以用 key 做二级比较。
   */
  const sortByMetric = (list) => (list || []).slice().sort((a, b) => {
    const d = metricOf(b) - metricOf(a);
    if (d) return d;
    return String(a.key ?? '').localeCompare(String(b.key ?? ''));
  });
  const fill = (name, list, build, opts = {}) => {
    const tbody = box.querySelector(`[data-table="${name}"] tbody`);
    if (!tbody) return;
    const wanted = sortByMetric(list);
    const collapsed = Boolean(opts.collapsible) && wanted.length > COLLAPSE_AT
      && tbody.dataset.expanded !== '1';
    const shown = collapsed ? wanted.slice(0, COLLAPSE_AT) : wanted;
    const moreBtn = opts.expandBtn ? box.querySelector(opts.expandBtn) : null;
    if (moreBtn) {
      if (wanted.length > COLLAPSE_AT) {
        moreBtn.style.display = '';
        moreBtn.textContent = collapsed
          ? `展开全部（还有 ${wanted.length - COLLAPSE_AT} 行）`
          : '收起';
      } else {
        moreBtn.style.display = 'none';
      }
    }
    // 折叠起来的表格：把行数写进 summary，用户才知道值不值得展开
    const det = tbody.closest('details');
    const sumEl = det ? det.querySelector('summary') : null;
    if (sumEl) {
      const txt = wanted.length ? `数值表（${wanted.length} 行）` : '数值表（无记录）';
      if (sumEl.textContent !== txt) sumEl.textContent = txt;
    }
    if (!wanted.length) {
      if (tbody.dataset.empty !== '1') {
        // ⚠️ 曾经写死 colspan="7"，但「按会话」表只有 6 列 —— 空态的
        // 占位格比表头多一格，视觉上会错位。改为读真实列数，读不到再兜底 1。
        const cols = Number(tbody.closest('table')?.querySelectorAll('thead th').length) || 1;
        tbody.innerHTML = `<tr><td colspan="${cols}" class="muted">无</td></tr>`;
        tbody.dataset.empty = '1';
      }
      return;
    }
    tbody.dataset.empty = '0';
    const html = shown.map(build).join('');
    if (tbody.dataset.sig !== html) { tbody.innerHTML = html; tbody.dataset.sig = html; }
  };

  fill('days', stats?.days, (d) => `
    <tr data-key="${esc(d.day)}">
      <td>${esc(d.day)}</td>
      <td class="r">${d.runs}</td>
      <td class="r">${fmtTok(d.promptTokens)}</td>
      <td class="r">${fmtTok(d.completionTokens)}</td>
      <td class="r">${fmtTok(d.cachedTokens)}</td>
      <td class="r">${fmtRate(d.cacheHitRate)}</td>
      <td class="r">${fmtYuan(d.cost)}</td>
    </tr>`);

  fill('chats', stats?.chats, (c) => `
    <tr data-key="${esc(c.key)}">
      <td>${esc(formatChatTitle(c.key, chatNameOf(c.key)))}</td>
      <td class="r">${c.runs}</td>
      <td class="r">${fmtTok(c.promptTokens)}</td>
      <td class="r">${fmtTok(c.completionTokens)}</td>
      <td class="r">${fmtRate(c.cacheHitRate)}</td>
      <td class="r">${fmtYuan(c.cost)}</td>
    </tr>`);

  // 模型与供应商分两列显示：同一个 id 走不同渠道是不同的"商品"，
  // 价格可能差很多（中转站加价、:free 版本等），必须能区分开。
  fill('models', stats?.models, (m) => `
    <tr data-key="${esc(m.key)}">
      <td>${esc(m.vendor ? `${m.vendor}：${m.model}` : (m.model ?? m.key))}</td>
      <td class="r">${m.runs}</td>
      <td class="r">${fmtTok(m.promptTokens)}</td>
      <td class="r">${fmtTok(m.completionTokens)}</td>
      <td class="r">${fmtRate(m.cacheHitRate)}</td>
      <td class="r">${fmtYuan(m.cost)}</td>
    </tr>`, { collapsible: true, expandBtn: '#models-expand' });

  // 图表指标按钮高亮
  $$('#usage-page [data-metric]').forEach((el) => {
    el.classList.toggle('btn-primary', el.dataset.metric === usageMetric());
  });

  // 四个维度块的段落计量 + 摘要行（「按插件」那块由 renderPluginUsage 自己填）
  fillUsageSectionSummaries(stats, box);

  // 三张图（按天折线 / 按会话条形 / 按模型条形）
  renderUsageCharts(stats, box);

  // 诊断与建议（纯前端规则，不额外请求）
  const hasInsight = renderUsageInsights(stats, box);
  // 分栏自适应：趋势被隐藏（今日/24h 无按天）、或右列连说明卡带诊断卡都没有时，退成单栏
  // R219：说明卡也占右列，不能只看 hasInsight，否则右列明明有内容却把整行压成单栏。
  const hasNote = !!box.querySelector('#usage-view-note [data-sum]:not(:empty)');
  const main = box.querySelector('.usage-main');
  if (main) main.classList.toggle('is-single', (stats?.mode !== 'days' && stats?.mode !== 'all') || (!hasInsight && !hasNote));
  // Hero 的区间标签（"近 30 天"等）—— 放胶囊里，前面不再拼 " · "
  const hr = box.querySelector('[data-hero-range]');
  if (hr) hr.textContent = stats?.rangeLabel || '';
}

/**
 * 缓存命中率百分比。
 *
 * ⚠️ 曾经卡片用 1 位小数、表格用 0 位小数，同一页两种精度（`96.7%` vs `97%`），
 * 用户对照表格时会以为算错了。现在统一 1 位。
 * 同时不再用 `x.cacheHitRate || 0` —— 那会把"字段缺失(undefined)"与
 * "真实的 0"混为一谈，这里显式区分：缺失时显示 '—' 而不是骗人的 0%。
 */
function fmtRate(rate) {
  if (rate === null || rate === undefined || !isFinite(Number(rate))) return '—';
  return `${(Math.min(1, Math.max(0, Number(rate))) * 100).toFixed(1)}%`;
}

/* ══════════════════════════════════════════════════════════════
   四个维度块统一的「段落计量 + 摘要行」
   （2026-10-19 用户要求：按天 / 按会话 / 按模型 / 按插件 四块风格统一）

   R219 起图表卡固定两段，顺序不再各自发挥：
     ① .usage-sec-head   左标题 + 右侧计量（data-meta）
     ② .usage-chart      图表 —— 再往下是折叠的数值表
   摘要行（.usage-sec-sum）统一收进右侧「当前视图」卡（.usage-view-note），
   由 04-usage.css 按 data-udim 只显示当前维度那一条；本函数照旧按数据生成，
   「按插件」仍由 renderPluginUsage 填。图表卡里不再出现任何常驻说明文字。
   静态说明文案与「这些数字是怎么算的」仍在页头「?」帮助弹窗
   （openUsageHelpModal），内容一字未丢。

   摘要行只写「不看数字就不知道的事」：平均、最大、占比、命中率。
   合计/占比这类图里已经有的（.uc-rest 脚注）不再重复 ——
   同一个数字在一页里出现三遍，读者反而不知道该信哪个。
   ══════════════════════════════════════════════════════════════ */
function fillUsageSectionSummaries(stats, box) {
  if (!box) return;
  const t = stats?.totals || {};
  const metric = usageMetric();
  // 占比的口径要跟着上方「图表」按钮走，否则切到成本后写着"39% 调用"会自相矛盾
  const metricWord = metric === 'cost' ? '成本' : metric === 'tokens' ? 'Token' : '调用';

  const setMeta = (k, txt) => {
    const el = box.querySelector(`[data-meta="${k}"]`);
    if (!el) return;
    if (el.textContent !== txt) el.textContent = txt;
    // 计量文字可能为空（没有记录时）——空着比写"0 个"更诚实，也少一行噪声
    el.style.display = txt ? '' : 'none';
  };
  const setSum = (k, html) => {
    const el = box.querySelector(`[data-sum="${k}"]`);
    if (!el) return;
    if (el.innerHTML !== html) el.innerHTML = html;
    el.style.display = html ? '' : 'none';
  };
  // 会话/模型名可能很长，摘要行里截断，完整名字在表格里
  // （30 字符：够放下「api.deepseek.com：deepseek-chat」这类常见写法，再长才省略）
  const short = (s, n = 30) => {
    const str = String(s ?? '');
    return str.length > n ? `${str.slice(0, n)}…` : str;
  };
  const byMetricDesc = (a, b) => metricOf(b, metric) - metricOf(a, metric)
    || String(a.key ?? '').localeCompare(String(b.key ?? ''));

  // ── 按天（单日 / 24 小时范围下整块被隐藏，这里也就没有数据）──
  // ⚠️ 摘要行**故意不重复**图上方那条「峰值 / 日均 / 合计」（.uc-sum，随「图表」指标变）：
  //    两条数字挨着写同一批值，读者只会觉得啰嗦。这里只给"看形状才得出的结论"——
  //    用量集中在哪天、日均能不能代表整体。
  const days = Array.isArray(stats?.days) ? stats.days.slice() : [];
  if (days.length) {
    // P0-04（2026-11-14）：这里曾经硬编码 `days.map(d=>d.runs)` —— 切「成本/Token」
    // 指标后，同屏的折线/数值表都换了口径，右栏结论仍写调用次数的 41%，还劝用户
    // 「看峰值比看日均更有意义」（QA 实测复算：41% / 100% / 42% 三种口径并存）。
    // 现在峰值/合计/占比/日均全部由当前指标派生，与图表永远同口径。
    const vals = days.map((d) => Math.max(0, metricOf(d, metric)));
    const totalV = vals.reduce((a, v) => a + v, 0);
    const peak = Math.max(...vals, 0);
    const peakDay = peak > 0 ? days[vals.indexOf(peak)] : null;
    const peakShare = totalV > 0 ? Math.round((peak / totalV) * 100) : 0;
    const daily = totalV / days.length;
    // 日均的单位跟指标走：调用 → N 次；成本 → ¥N；Token → 紧凑格式
    const dailyTxt = metric === 'cost' ? fmtMoneyChart(daily)
      : metric === 'tokens' ? fmtTok(daily)
      : `${Math.round(daily)} 次`;
    setMeta('days', `${days.length} 天`);
    if (days.length < 2) {
      setSum('days', '只有一天的记录，折线上只落得下一个点 —— 想看趋势请换「近 7 天 / 近 30 天」。');
    } else if (peakShare >= 40) {
      setSum('days',
        `用量很不均匀：最忙的 <b>${esc(String(peakDay?.day ?? '').slice(5))}</b> 一天占了全区间 <b>${peakShare}%</b> ——`
        + ` 看峰值比看日均更有意义，日均会被它拉高。`);
    } else {
      setSum('days',
        `用量分布比较均匀（最忙的一天也只占 <b>${peakShare}%</b>），`
        + `日均 <b>${dailyTxt}</b> 可以代表整体水平。`);
    }
  } else {
    setMeta('days', '');
    setSum('days', '');
  }

  // ── 按会话 ──
  const chats = Array.isArray(stats?.chats) ? stats.chats.slice() : [];
  if (chats.length) {
    const totalV = chats.reduce((a, c) => a + Math.max(0, metricOf(c, metric)), 0);
    chats.sort(byMetricDesc);
    const top = chats[0];
    const topVal = Math.max(0, metricOf(top, metric));
    const topShare = totalV > 0 ? Math.round((topVal / totalV) * 100) : 0;
    const totalRuns = chats.reduce((a, c) => a + (Number(c.runs) || 0), 0);
    setMeta('chats', `${chats.length} 个会话`);
    // 只有一个会话时，「占 100%」是句废话。也**不**在这里报"每次输入多少"：
    // 「按插件」那块会给出同一个指标，但口径来自另一条统计链路（llmCalls），
    // 两处数字差几个百分点就会被当成算错 —— 这里改成指路。
    if (chats.length === 1) {
      setSum('chats',
        '只有一个会话，全部用量都来自它 —— 单次输入有多贵、钱花在插件说明还是历史上，'
        + '去「按插件」看构成最清楚。');
    } else {
      setSum('chats',
        `平均每个 <b>${(totalRuns / chats.length).toFixed(1)}</b> 次调用；`
        + `用得最多的是「<b>${esc(short(formatChatTitle(top.key, chatNameOf(top.key))))}</b>」，`
        + `占 <b>${topShare}%</b> ${metricWord}。`);
    }
  } else {
    setMeta('chats', '');
    setSum('chats', '');
  }

  // ── 按模型 ──
  const models = Array.isArray(stats?.models) ? stats.models.slice() : [];
  if (models.length) {
    const labelOf = (m) => (m.vendor ? `${m.vendor}：${m.model}` : (m.model ?? m.key));
    const totalV = models.reduce((a, m) => a + Math.max(0, metricOf(m, metric)), 0);
    models.sort(byMetricDesc);
    const top = models[0];
    const topShare = totalV > 0 ? Math.round((Math.max(0, metricOf(top, metric)) / totalV) * 100) : 0;
    // 命中率最低的那个：只看真有输入的，避免 0/0 算出来的假 0% 抢戏
    const rated = models.filter((m) => (Number(m.promptTokens) || 0) > 0);
    const worst = rated.length > 1
      ? rated.slice().sort((a, b) => (Number(a.cacheHitRate) || 0) - (Number(b.cacheHitRate) || 0))[0]
      : null;
    setMeta('models', `${models.length} 个模型`);
    setSum('models',
      `主力是 <b>${esc(short(labelOf(top)))}</b>（占 <b>${topShare}%</b> ${metricWord}）；`
      + `整体缓存命中 <b>${fmtRate(t.cacheHitRate)}</b>`
      + (worst ? `，最低的 <b>${esc(short(labelOf(worst)))}</b> 只有 <b>${fmtRate(worst.cacheHitRate)}</b>` : '')
      + '。');
  } else {
    setMeta('models', '');
    setSum('models', '');
  }
}

/**
 * 加载用量页。
 *
 * @param {object}  [opts] 全部可选，对象形式传入（不再是位置参数）。
 * @param {boolean} [opts.force=false]  true = 加载页面（切换页签、切换时间范围、
 *                         点刷新）；false = 轮询刷新，只更新数值与表格行，不重建 DOM。
 * @param {boolean} [opts.hard=false]   仅 force 时生效：URL 追加 force=1，服务端
 *                         跳过 3 小时结果缓存当场重算（只有刷新按钮用）。
 * @param {boolean} [opts.inPlace=false] [force 时生效] 切换时间范围/点刷新专用：
 *                         **原地更新数值层**（updateUsagePage），不重建 DOM、
 *                         不重播入场动画（R226/R230）。
 * @param {boolean} [opts.keepContent=false] [force 时生效] 目标范围没缓存也没有可
 *                         原地更新的内容时，保留旧内容淡示"切换中"，不闪骨架屏（R226）。
 *
 * ── 为什么要分开 ──
 * 轮询按 ui.refreshMs（默认 15 秒，设置页可调）定时跑，如果每次都重建 DOM，
 * 用户正在看的行会被重新渲染、
 * 滚动位置也会丢。所以轮询走"只更新数值"这条路。
 *
 * ── 加载为什么快 ──
 * 1. 三个接口用 Promise.all **并行**请求（串行会慢 3 倍）
 * 2. 骨架屏**立即**显示，不等数据回来 —— 用户切过去马上看到布局，不会"黑一会"
 * 3. 竞态防护：请求期间用户可能切走或改了时间范围，回来时丢弃过期结果
 */
let usageLoadToken = 0;          // 每次加载递增，用于丢弃过期结果
// R226（2026-11-14，用户反馈「上面切换的时候下侧会闪烁」）：按范围缓存最近几次
// 加载成功的数据（range → {stats, st, prices}，LRU 上限 6）。用途有二：
//   ① 切回用量页时立即画出旧内容，避免"黑一下"（原 usageLastData 只存 1 个范围，
//      来回点「近 7 天 ↔ 近 30 天」永远 miss）；
//   ② 切换时间范围时若目标范围有缓存，立即渲染再后台更新，全程无骨架。
const usageDataCache = new Map();
const USAGE_DATA_CACHE_MAX = 6;  // 页面一共 4 个范围，留余量即够
function usageDataCachePut(range, data) {
  usageDataCache.delete(range);                 // delete + set = LRU 触底续命
  usageDataCache.set(range, data);
  while (usageDataCache.size > USAGE_DATA_CACHE_MAX) {
    usageDataCache.delete(usageDataCache.keys().next().value);
  }
}

/* P0-03（2026-11-14）：刷新/切范围失败不能再静默 —— 旧数字 + 旧时间戳会伪装成
   实时（与本页「数据更新于」的设计承诺直接冲突）。非阻断内联横幅挂在
   #usage-page 顶部（.usage-note 样式），任何一次成功加载即撤；带重试入口。 */
let usagePollFails = 0;                          // 轮询连续失败计数
function showUsageErrNote(message) {
  const box = $('#usage-page');
  if (!box) return;
  let note = box.querySelector('#usage-err-note');
  if (!note) {
    note = document.createElement('div');
    note.id = 'usage-err-note';
    note.className = 'usage-note';
    note.style.maxWidth = '940px';
    note.style.margin = '0 auto 14px';
    box.insertBefore(note, box.firstChild);
  }
  const cachedNow = usageDataCache.get(usageRange);
  const at = cachedNow?.stats?.computedAt
    ? `当前显示 ${fmtTime(Number(cachedNow.stats.computedAt))} 的旧数据，`
    : '';
  note.innerHTML = `${esc(message)} ${at}不影响本页其它操作。`
    + `<button class="btn btn-small" id="usage-err-retry" style="margin-left:8px">重试</button>`;
  note.querySelector('#usage-err-retry')?.addEventListener('click', () => {
    loadUsageView({ force: true, hard: true });
  });
}
function clearUsageErrNote() {
  $('#usage-page #usage-err-note')?.remove();
}

/**
 * 统计请求 URL。
 *
 * hard=true（用户明确点了「刷新」）→ 带 force=1，服务端跳过 3 小时结果缓存当场重算。
 * 其余入口（轮询、SSE、切页签、切时间范围）一律走缓存 —— 服务端为了"点今日要等很久"
 * 已经把统计结果缓存住了，前端不该再用 force 把它顶掉，否则缓存等于不存在。
 * 这三者的区别要一直保持：**只有刷新按钮才代表"我现在就要最新的"。**
 */
function usageStatsUrl(range, hard = false) {
  return `/api/usage/stats?range=${encodeURIComponent(range)}${hard ? '&force=1' : ''}`;
}

/* ══════════ 按插件统计（2026-10-19）══════════
   与主统计分开请求：插件维度要额外扫会话文件 + 算提示词片段，比主统计慢；
   单独请求的好处是"它失败不连累主页面"，也方便按需刷新（30 秒节流）。 */
let pluginUsageAt = 0;
let pluginUsageRange = '';

let pluginUsageToken = 0;                        // P1-16：竞态防护令牌
async function loadPluginUsage(range, { force = false } = {}) {
  if (!force && pluginUsageRange === range && Date.now() - pluginUsageAt < 30000) return;
  const token = ++pluginUsageToken;
  try {
    const r = await api(`/api/usage/plugins?range=${encodeURIComponent(range)}`, { timeoutMs: 20000 });
    // P1-16（2026-11-14）：曾经回包即渲染，无任何守卫 —— 快速切范围时，慢的旧
    // 范围回包会把新范围的数据顶掉（插件统计 20s 超时，比主统计慢得多，必现）。
    // 对齐主统计的四重守卫里管用的三条：令牌 / 页签 / 范围。
    if (token !== pluginUsageToken) return;            // 期间又发了更新的请求
    if (state.tab !== 'usage' || usageRange !== range) return;  // 期间切走页签 / 切了范围
    if (!r || r.ok !== true) return;
    pluginUsageAt = Date.now();
    pluginUsageRange = range;
    state.pluginUsage = r;
    renderPluginUsage(r);
  } catch (e) {
    // 2026-10-20：原文案让用户"重启 QQ Agent 后重试"—— 代价太重，而且这里失败
    // 多半是后端一时没响应（接口本身存在，上面刚成功过）。页面上就有「刷新」，
    // 它走的是 force=true，会把插件统计一起重拉，指过去就够了。
    const tb = $('#usage-page [data-table="plugins"] tbody');
    if (tb) {
      tb.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:18px">'
        + `插件统计暂时拿不到（${esc(String(e?.message || '后端未响应'))}）—— 点上方「刷新」重试。`
        + '</td></tr>';
    }
  }
}

/** 插件排行条：复用「按模型」的 .uc-bar-* 视觉（名次徽标 + 渐隐条 + 百分比）。
 *
 *  三种排行依据（2026-10-19 用户补充：只排"每次固定"会漏掉真正用起来的开销）：
 *    total → 区间总消耗 = 每次固定 × 调用次数 + 工具结果（默认，最贴近"花了多少"）
 *    fixed → 每次固定消耗（看"装了就在付"的底噪）
 *    calls → 区间调用次数（看"用得勤不勤"）
 *
 *  数据来自 /api/usage/plugins（不在 stats.xxx 里），所以不复用 usageBars；
 *  但 DOM 结构与它完全一致，样式不用改一行。 */
const PLUGIN_METRIC_DEFS = {
  total: { value: (p) => Number(p.periodTotal) || 0, unit: 'tok', hint: '区间总消耗 = 每次固定 × 调用次数 + 工具结果' },
  fixed: { value: (p) => Number(p.fixedPerCall) || 0, unit: 'tok/次', hint: '每次对话都要付的固定部分' },
  calls: { value: (p) => Number(p.toolCalls) || 0, unit: '次', hint: '区间内功能被调用的次数' }
};

/* ── R235（2026-11-14，用户：「按插件怎么还是这么一大坨」）────────────────
   第 4 参 limit：排行条总行数上限（**含对照行**）。R218 时代按插件「不受条数
   限制」是刻意的，但代价是 11+ 个插件时卡片被撑到 600+px，右栏下面空一大块，
   四个视图高度基准对它失效。现在有了统一的 6 行容量（R234 实测）与占位机制，
   按插件也一视同仁：只画前 N 名，超出的不消失 —— 合计行写「其余 M 项占 X%」
   （分母是全量 total，各行 share 之和仍为 100%），完整清单照旧在数值表。 */
function pluginBars(plugins, metric = 'total', extras = [], limit = 0) {
  const def = PLUGIN_METRIC_DEFS[metric] || PLUGIN_METRIC_DEFS.total;
  const items = (plugins || [])
    .filter((p) => def.value(p) > 0 || p.fixedPerCall > 0 || p.toolCalls > 0)
    .slice()
    .sort((a, b) => def.value(b) - def.value(a) || String(a.id).localeCompare(String(b.id)));
  const extraRows = (extras || []).filter((p) => p && def.value(p) > 0);
  if (!items.length && !extraRows.length) return { empty: '<div class="uc-empty muted">这段时间没有插件消耗记录</div>' };
  // 容量减去对照行：对照行只在 total/fixed 档存在，calls 档插件可以多画一行
  const cap = limit > 0 ? Math.max(1, limit - extraRows.length) : 0;
  const shownItems = cap ? items.slice(0, cap) : items;
  const restItems = cap ? items.slice(cap) : [];
  // 条形长度统一按「含对照行」的最大值归一 —— 这样能一眼看出插件条和对话条谁长，
  // 而不是各自满格造成"插件也很大"的错觉。
  const max = Math.max(...items.map(def.value), ...extraRows.map(def.value), 1);
  const total = items.reduce((a, p) => a + Math.max(0, def.value(p)), 0);
  const rows = shownItems.map((p, i) => {
    const v = Math.max(0, def.value(p));
    const w = max > 0 ? Math.max(0, (v / max) * 100) : 0;
    const share = total > 0 ? Math.max(0, (v / total) * 100) : 0;
    const alpha = Math.max(0.34, 1 - i * 0.1);
    const isCore = p.id === '(core)';
    const label = isCore ? '核心功能（非插件）' : p.name;
    // 副标注：切到"总消耗"时把调用次数带出来，否则用户看不出"贵是因为装得多还是用得多"
    const sub = metric === 'total'
      ? (p.toolCalls > 0 ? ` · ${p.toolCalls} 次调用` : ' · 装了没用过')
      : '';
    return {
      key: `p:${String(p.id ?? i)}`,
      pluginKey: String(p.id ?? ''),
      top: i === 0,
      rank: String(i + 1),
      name: label,
      sub,
      width: w,
      alpha,
      valMain: fmtTok(v),
      valShare: `· ${share.toFixed(0)}%`,
      title: '点击看它每个功能用了多少',
      interactive: true,
    };
  });
  // 对照行（对话内容）：不是插件、不参与名次，放在最后用虚线分隔，
  // 作用是给上面的插件条一个参照系 —— 「插件 3,877 / 对话 11,284」一眼可见。
  const contrast = extraRows.map((p, i) => {
    const v = Math.max(0, def.value(p));
    const w = max > 0 ? Math.max(0, (v / max) * 100) : 0;
    return {
      key: `x:${String(p.name ?? i)}`,
      cls: 'contrast',
      rank: '—',
      name: String(p.name ?? ''),
      sub: String(p.note ?? ''),
      width: w,
      alpha: 1,
      valMain: fmtTok(v),
      valShare: def.unit,
      title: String(p.title || ''),
    };
  });
  // 合计口径标注：摘要行给的是"只算插件"的数，这里包含核心功能——不写清楚会对不上账
  const hasCore = items.some((p) => p.id === '(core)');
  const shownTotal = shownItems.reduce((a, p) => a + Math.max(0, def.value(p)), 0);
  const shownPct = total > 0 ? (shownTotal / total) * 100 : 0;
  const footHtml = `插件合计${hasCore ? '（含核心功能）' : ''} <b>${esc(fmtTok(total))}</b> ${esc(def.unit)}`
    + (restItems.length
      ? ` · 前 ${shownItems.length} 项占 <b>${shownPct.toFixed(0)}%</b> · 其余 ${restItems.length} 项占 <b>${Math.max(0, 100 - shownPct).toFixed(0)}%</b>`
      : '')
    + `<span class="uc-rest-hint">${esc(def.hint)}</span>`;
  return { rows: [...rows, ...contrast], footHtml };
}

/** 把「按插件」块填上数据。骨架在 renderUsagePage 里，这里只写值，不重建 DOM。 */
function renderPluginUsage(r) {
  const box = $('#usage-page');
  if (!box) return;
  const t = r.totals || {};
  const s = r.summary || {};
  const plugins = Array.isArray(r.plugins) ? r.plugins : [];

  const avg = Number(t.avgInputPerCall) || 0;
  const pluginFixed = Number(s.pluginFixedPerCall ?? s.fixedPerCall) || 0;
  const share = avg > 0 ? Math.round(pluginFixed / avg * 100) : 0;

  // 区间口径就地补算（2026-10-19）：periodFixed / periodTotal 是这次新加的字段，
  // 主进程没重启时接口里还没有它们——与其显示 0，不如用「每次固定 × 调用次数
  // + 工具结果」在本地算一遍。摘要行和表格都读这一份，数字永远对得上。
  const llmCalls = Number(t.llmCalls) || 0;
  const periodFixedOf = (p) => Number.isFinite(Number(p.periodFixed))
    ? Number(p.periodFixed)
    : (Number(p.fixedPerCall) || 0) * llmCalls;
  const periodTotalOf = (p) => Number.isFinite(Number(p.periodTotal))
    ? Number(p.periodTotal)
    : periodFixedOf(p) + (Number(p.resultTokens) || 0);
  const rowsData = plugins.map((p) => ({ ...p, periodFixed: periodFixedOf(p), periodTotal: periodTotalOf(p) }));
  const others = rowsData.filter((p) => p.id !== '(core)');
  const periodFixedSum = others.reduce((a, p) => a + p.periodFixed, 0);

  // ── 对话侧（2026-10-19 用户第二次澄清：要的是「每次对话新进来的文本」这一块）──
  // 口径：每次输入的真实平均 token 减去全部固定开销（插件说明 + 核心工具说明），
  // 剩下的就是聊天记录 / 人设 / 运行时状态。倒推值，但分子分母都是真数。
  // 与后端 summary.chatPerCall 同口径；接口没这字段时（主进程未重启）本地补算。
  const allFixed = rowsData.reduce((a, p) => a + (Number(p.fixedPerCall) || 0), 0);
  const coreFixed = rowsData.filter((p) => p.id === '(core)').reduce((a, p) => a + (Number(p.fixedPerCall) || 0), 0);
  const corePeriodFixed = rowsData.filter((p) => p.id === '(core)').reduce((a, p) => a + p.periodFixed, 0);
  const chatPerCall = Number.isFinite(Number(s.chatPerCall))
    ? Number(s.chatPerCall)
    : Math.max(0, avg - allFixed);
  const chatPeriod = Number.isFinite(Number(s.chatPeriod))
    ? Number(s.chatPeriod)
    : Math.max(0, (Number(t.promptTokens) || 0) - allFixed * llmCalls);
  const coreShare = avg > 0 ? Math.round(coreFixed / avg * 100) : 0;
  const chatShare = avg > 0 ? Math.round(chatPerCall / avg * 100) : 0;
  const newTextPerCall = Number(s.newTextPerCall) || 0;

  // 段落头右侧的计量文字：「6 个插件 · 3 个在用」。
  // 与「按天/按会话/按模型」的 meta 同一副样子（data-meta），四个块对齐。
  const metaEl = box.querySelector('[data-meta="plugins"]');
  if (metaEl) {
    const usedN = others.filter((p) => Number(p.toolCalls) > 0).length;
    const txt = others.length
      ? `${others.length} 个插件 · ${usedN ? `${usedN} 个在用` : '本区间都没用过'}`
      : '';
    if (metaEl.textContent !== txt) metaEl.textContent = txt;
  }

  // 摘要行：一句把「一次输入到底花在哪」说完 —— 插件 / 核心工具 / 对话内容
  const topEl = box.querySelector('[data-sum="plugins"]');
  if (topEl && avg > 0) {
    topEl.innerHTML = `每次输入 <b>${fmtTok(avg)}</b> tok =`
      + ` 插件 <b>${fmtTok(pluginFixed)}</b>（${share}%）`
      + ` + 核心工具 <b>${fmtTok(coreFixed)}</b>（${coreShare}%）`
      + ` + 对话内容 <b>${fmtTok(chatPerCall)}</b>（${chatShare}%）`
      + `<br>区间累计：插件 ${fmtTok(periodFixedSum)} + 核心工具 ${fmtTok(corePeriodFixed)}`
      + ` + 对话内容 <b>${fmtTok(chatPeriod)}</b>`
      // 这条提示是整块的重点：让用户明白贵的不是"刚说的那句"，而是历史在重发。
      + (newTextPerCall > 0
        ? ` <span class="up-sumline-note">（每轮新进来的消息只占 ${fmtTok(newTextPerCall)} tok，其余都是历史在重发）</span>`
        : ' <span class="up-sumline-note">（新消息本身只有几十 tok，贵的是历史每轮重发）</span>');
  } else if (topEl) {
    topEl.innerHTML = '';
  }

  // 排行依据切换（区间总消耗 / 每次固定 / 调用次数）
  const metric = PLUGIN_METRIC_DEFS[state.pluginMetric] ? state.pluginMetric : 'total';
  const metricBar = box.querySelector('[data-up="metricbar"]');
  if (metricBar) {
    metricBar.querySelectorAll('[data-plugin-metric]').forEach((b) => {
      b.classList.toggle('btn-primary', b.dataset.pluginMetric === metric);
    });
    if (metricBar.dataset.upBound !== '1') {
      metricBar.dataset.upBound = '1';
      metricBar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-plugin-metric]');
        if (!b) return;
        state.pluginMetric = b.dataset.pluginMetric;
        if (state.pluginUsage) renderPluginUsage(state.pluginUsage);
      });
    }
  }

  // 排行条（与「按模型」同一套 .uc-bar-* 视觉）+ 一条「对话内容」对照行
  const chartEl = box.querySelector('[data-chart="plugins"]');
  if (chartEl) {
    const chatRow = {
      id: '(chat)',
      name: '对话内容',
      note: '聊天记录 · 人设 · 状态',
      // 三档排行下都能给出对应值：total → 区间累计，fixed → 每次携带量；
      // calls 档没有意义（对话不按"调用次数"计），所以不显示。
      fixedPerCall: chatPerCall,
      periodTotal: chatPeriod,
      toolCalls: 0,
      title: `每次输入里扣除插件与工具说明后剩下的部分，主要是聊天历史被反复重发（本轮新消息约 ${newTextPerCall} tok）`
    };
    const extras = metric === 'calls' ? [] : [chatRow];
    // R229：条形图按键调和（原位更新 + FLIP），不再整块重建
    // R234：插件少的时候底部也用占位行填满 —— 与按会话同一套机制
    // （filler 只动 DOM，不进合计/下钻；条目多到面板被撑高时 free≤0，自动一行不补）。
    // 假插件名沿用群号梗，一眼是占位；占位行无 data-plugin-key，不会误触下钻委托。
    const PH_PLUGINS = ['插件 114514', '插件 1919810', '插件 233333', '插件 666666', '插件 9527'];
    reconcileBarBlock(chartEl, pluginBars(rowsData, metric, extras, USAGE_BAR_CAP), {
      filler: (i, base) => ({
        rank: String(base + i + 1),
        name: PH_PLUGINS[i % PH_PLUGINS.length],
        width: Math.max(1.6, 4.2 - i * 1.1),
        alpha: 0.15,
        valMain: '—',
        valShare: '',
      }),
    });
    if (chartEl.dataset.upBound !== '1') {
      chartEl.dataset.upBound = '1';
      const openFromRow = (e) => {
        const row = e.target.closest('[data-plugin-key]');
        if (!row) return;
        const p = (state.pluginUsage?.plugins || []).find((x) => x.id === row.dataset.pluginKey);
        if (p) openPluginToolsModal(p);
      };
      chartEl.addEventListener('click', openFromRow);
      chartEl.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        openFromRow(e);
      });
    }
  }

  const tb = box.querySelector('[data-table="plugins"] tbody');
  if (!tb) return;
  const rows = rowsData.filter((p) => p.fixedPerCall > 0 || p.toolCalls > 0 || p.promptVolatile > 0);
  // R236：summary 补行数标注 —— 按天/按会话/按模型的数值表都有「（N 行）」，
  // 按插件漏了，四张表一致（也呼应排行条截断后「完整清单在数值表」的引导）。
  const pSum = tb.closest('details')?.querySelector('summary');
  if (pSum) {
    const pTxt = rows.length ? `数值表（${rows.length} 行）` : '数值表（无记录）';
    if (pSum.textContent !== pTxt) pSum.textContent = pTxt;
  }
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:18px">本区间没有插件开销记录。</td></tr>';
  } else {
    const maxFixed = Math.max(1, ...rows.map((p) => p.fixedPerCall || 0));
    tb.innerHTML = rows.map((p) => {
      const impact = Number(p.hitImpactPct) || 0;
      // 缓存影响用「人话分级」代替百分数：满屏 0% 会让人以为是 bug。
      const impactHtml = impact >= 2
        ? `<span class="up-badge bad" title="易变内容占比 ${impact}%，每轮都在拖慢缓存">明显</span>`
        : impact >= 0.5
          ? `<span class="up-badge warn" title="易变内容占比 ${impact}%">轻微</span>`
          : '<span class="up-badge" title="没有每轮都变的内容">无</span>';
      const isCore = p.id === '(core)';
      const nameCell = isCore
        ? '<span class="up-name">核心功能</span><span class="up-sub">框架自带 · 一般不用动</span>'
        : `<span class="up-name">${esc(p.name)}</span><span class="up-sub">${esc(p.id)}${p.toolCount ? ' · ' + p.toolCount + ' 个功能' : ''}</span>`;
      const used = p.toolCalls
        ? `${fmtTok(p.toolCalls)} 次`
        : '<span class="up-unused" title="装了但一次没用过，固定消耗照付">未使用</span>';
      const bar = `<span class="up-cost-bar"><i style="width:${Math.max(2, Math.round(p.fixedPerCall / maxFixed * 100))}%"></i></span>`;
      return `<tr data-plugin="${esc(p.id)}" title="点一下，看它每个功能各用了多少">
        <td>${nameCell}</td>
        <td class="r"><div class="up-cost"><b>${fmtTok(p.fixedPerCall)}</b>${bar}</div></td>
        <td class="r"><b>${fmtTok(p.periodTotal)}</b></td>
        <td class="r">${fmtTok(p.promptStable + p.promptVolatile)}</td>
        <td class="r">${fmtTok(p.toolDefTokens)}</td>
        <td class="r">${used}</td>
        <td class="r">${p.resultTokens ? fmtTok(p.resultTokens) : '<span class="muted">—</span>'}</td>
        <td class="r">${impactHtml}</td>
      </tr>`;
    }).join('');
  }

  // 行点击 → 功能明细（委托挂在每次重建的 tbody 上，不会重复绑定）
  if (tb.dataset.upBound !== '1') {
    tb.dataset.upBound = '1';
    tb.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-plugin]');
      if (!tr) return;
      const p = (state.pluginUsage?.plugins || []).find((x) => x.id === tr.dataset.plugin);
      if (p) openPluginToolsModal(p);
    });
  }
}

/** 单个插件的功能明细：每个工具调用了多少次、返回多少 token、错了几次。
 *
 * ⚠️（2026-10-19）不要复用「调用明细」的 .tb-row —— 那套是 74px 名字 + 118px 代码
 *    + 34px 数字的窄三列，为"分类分组 + 条形图"设计的。插件功能行只有 id 和数字，
 *    塞进 34px 的数字列时「2,655 tok」会被挤成两行（用户截图反馈"看着奇怪"）。
 *    这里用独立的 .upt 网格：功能名自适应，三个数字列定宽右对齐。 */
function openPluginToolsModal(p) {
  const tools = (p.tools || []).slice()
    .sort((a, b) => b.calls - a.calls || b.resultTokens - a.resultTokens);
  const head = `<div class="upt-row upt-head">
      <span class="upt-what">功能</span>
      <span class="upt-n">调用</span>
      <span class="upt-n">返回 token</span>
      <span class="upt-n">错误</span>
    </div>`;
  const rows = tools.length
    ? tools.map((t) => `
      <div class="upt-row">
        <span class="upt-what">
          <b>${esc(t.name || t.id)}</b>
          ${t.name ? `<i>${esc(t.id)}</i>` : ''}
        </span>
        <span class="upt-n">${fmtTok(t.calls)}</span>
        <span class="upt-n">${fmtTok(t.resultTokens)}</span>
        <span class="upt-n">${t.errors ? `<span class="up-err">${t.errors}</span>` : '—'}</span>
      </div>`).join('')
    : '<div class="empty-hint">这个插件在当前区间没有工具调用记录。</div>';

  if (typeof modelModalShell !== 'function') return;
  modelModalShell({
    head: `${p.name} · 功能用量`,
    body: `
      <div class="tool-breakdown">
        <div class="tb-lead">
          固定开销 <b>${fmtTok(p.fixedPerCall)} tok/次</b>：提示词 ${fmtTok(p.promptStable)}（稳定）+ ${fmtTok(p.promptVolatile)}（易变），工具定义 ${fmtTok(p.toolDefTokens)}。
          共 ${p.toolCount} 个功能，区间内调用 ${fmtTok(p.toolCalls)} 次，返回内容约 ${fmtTok(p.resultTokens)} tok。
        </div>
        <div class="upt">${head}${rows}</div>
      </div>`,
    foot: '<div class="muted" style="font-size:11.5px">token 为估算值（字符÷2.5）；「返回 token」是工具结果进对话后的体积，会作为历史反复重发。</div>'
  });
}

async function loadUsageView({ force = false, hard = false, keepContent = false, inPlace: opts_inPlace = false } = {}) {
  const box = $('#usage-page');
  if (!box) return;

  // ── 轮询刷新：只更新数值，不重建 DOM ──
  if (!force) {
    const range = usageRange;   // 发请求前记下范围，回来时比对（下面）
    try {
      const [stats, st] = await Promise.all([
        api(usageStatsUrl(range, false), { timeoutMs: 15000 }),
        api('/api/status', { timeoutMs: 15000 })
      ]);
      // 用户可能已经切走页签了，那就别动了
      if (state.tab !== 'usage') return;
      // ⚠️ 也可能只是**切了时间范围**。轮询分支不重建骨架、不递增
      // usageLoadToken，所以这里没有 token 守卫 —— 曾经只查了页签，
      // 结果是：在途的 15s 请求回来后把**旧范围**的统计覆盖到新范围的
      // 页面上，卡片与表格瞬间对不上。范围变了直接丢弃，等新范围自己的
      // 加载流程把正确数据送上来。
      if (usageRange !== range) return;
      state.usageStats = stats;
      // ⚠️ 价格不用再请求：启动时已加载进 state.modelPrices（/api/model-prices），
      //    更新时按需拉取即可。曾经这里请求了一个**不存在的** /api/usage/prices，
      //    404 会让整个 Promise.all reject → 用量页永远加载失败。
      updateUsagePage(stats, st, state.modelPrices || {});
      // P0-03：轮询恢复/成功 → 清掉过期警示与失败横幅
      usagePollFails = 0;
      clearUsageErrNote();
      // 插件维度单独拉（30 秒节流；失败静默，不让它拖累主页面）
      loadPluginUsage(range);
    } catch (e) {
      // P0-03：轮询失败不能完全无声 —— 连续 3 次失败把「数据更新于」改写成
      // 过期警示（非阻断；下一次成功时 updateUsagePage 会自动覆写回来）。
      usagePollFails++;
      if (usagePollFails >= 3 && state.tab === 'usage') {
        const fresh = $('#usage-page #usage-updated');
        const at = Number(state.usageStats?.computedAt) || 0;
        if (fresh) fresh.textContent = `数据可能已过期${at ? ` · 更新于 ${fmtTime(at)}` : ''}（自动重试中）`;
      }
    }
    return;
  }

  // ── 强制加载（页签进入 / 切时间范围 / 点刷新）──
  const token = ++usageLoadToken;
  const range = usageRange;

  // R226（2026-11-14，用户反馈「上面切换的时候下侧会闪烁」，两轮修复）：
  //   第一轮：切范围不再闪骨架屏 —— 保留旧内容淡示"切换中"。
  //   第二轮：光不闪骨架还不够 —— 重建 DOM 会让 R224 的入场动画整体重播
  //   （大数字/读数从 opacity:0 淡入、折线重描），用户看到的仍是闪。
  //   于是切范围**彻底不重建**：updateUsagePage 就是完整的数值填充层
  //   （KPI / 成本滚动 / 环形仪表 / 范围角标 / 迷你曲线 / 图表 / 表格 / 按钮高亮
  //   全在里面），原地更新只有真实变化的部分会动。
  // inPlace 判据：页面上有**非骨架**的用量内容（骨架里没有可填充的字段节点，
  // 直接 update 会扑空）；首进页面（骨架或空）仍走原来的骨架→重建流程。
  const cached = usageDataCache.get(range) || null;
  const inPlace = !!opts_inPlace && !!box.querySelector('.usage-hero:not(.skeleton)');
  // R231：骨架阶段也要先定维度。正式页面的 data-udim 由 14-chrome.js 的
  // applyUsageDim 在 updateUsagePage（数据回来后）才写入，而 index.html 里
  // #usage-page 初始没有这个属性 —— 骨架时不设，R231 给底部占位加的
  // .usage-attrib 就不会被 06-stage.css 的 [data-udim="days"] 规则隐藏，
  // 加载时仍多出一块卡、数据回来又消失。默认维度 days 与 14-chrome.js 的
  // usageDim 初值一致；用户已选过别的维度时这里不覆盖。
  if (!box.dataset.udim) box.dataset.udim = 'days';
  if (cached) {
    state.usageStats = cached.stats;
    if (inPlace) updateUsagePage(cached.stats, cached.st, cached.prices);
    else renderUsagePage(cached.stats, cached.st, cached.prices);
  } else if (inPlace) {
    box.classList.add('usage-switching');
  } else {
    box.innerHTML = renderUsageSkeleton();
  }

  try {
    const [stats, st] = await Promise.all([
      api(usageStatsUrl(range, hard), { timeoutMs: 15000 }),
      api('/api/status', { timeoutMs: 15000 })
    ]);
    const prices = state.modelPrices || {};   // 启动时已加载，无需再请求
    // 竞态：期间用户切走了页签、或又点了别的时间范围 → 这次结果作废
    if (token !== usageLoadToken) return;
    if (state.tab !== 'usage' || usageRange !== range) return;

    state.usageStats = stats;
    usageDataCachePut(range, { stats, st, prices });

    box.classList.remove('usage-switching');
    clearUsageErrNote();                       // P0-03：成功即撤失败横幅
    usagePollFails = 0;                        // P0-03：强制刷新成功也得归零，否则下个轮询失败一次就又弹过期提示
    if (inPlace || cached) {
      // R226：切范围（原地更新）或已有页面（缓存命中）→ 只更新数值层。
      // textContent / sig 差量替换不重播入场动画；成本数字自带滚动过渡、
      // 图表随数据重绘，这些本身就是"换了"的反馈，不需要整页闪一遍。
      updateUsagePage(stats, st, prices);
    } else {
      // ⚠️ renderUsagePage 不返回字符串 —— 它内部自己写 box.innerHTML、
      //    绑定事件、并调用 updateUsagePage 填数值。
      //    所以这里只能"直接调用"，不能再赋值（赋 undefined 会把页面清空）。
      renderUsagePage(stats, st, prices);
    }
    // 范围变了 → 插件统计也要重算（force：点刷新/切范围必须拿到新数）
    loadPluginUsage(range, { force: true });
  } catch (e) {
    if (token !== usageLoadToken) return;
    // R226：切范围时旧内容还在页面上 —— 拿掉"切换中"淡示即可，别用错误页覆盖
    // （用户至少能看到上一次的数字）。P0-03：但不能完全无声 —— 挂非阻断横幅，
    // 写明当前看到的是几点的旧数据，并给重试入口。
    if (keepContent || cached) {
      box.classList.remove('usage-switching');
      showUsageErrNote(`用量统计刷新失败：${String(e?.message || '后端未响应')}。`);
      return;
    }
    // 曾经这里只有一行错误文案：请求 hang 死时（无超时时代）骨架屏永远转下去，
    // 用户只能重启。现在超时/失败都落到这张卡上，给一个明确的出路（R49）。
    box.innerHTML = `
      <div class="empty-hint">
        用量加载失败：${esc(e?.message || String(e))}<br/>
        <button class="btn btn-small" id="usage-retry-btn" style="margin-top:10px">重新加载</button>
      </div>`;
    $('#usage-retry-btn')?.addEventListener('click', () => loadUsageView({ force: true, hard: true }));
  }
}

function peakSplitHtml(sum) {
  if (!sum || !sum.hasPeakModel) return '';
  if (!(sum.peakCost > 0 || sum.offPeakCost > 0)) return '';
  const ratio = sum.peakRatio || 0;
  return `
    <div class="usage-peak">
      <div class="up-title">峰谷拆分</div>
      <div class="up-row">
        <span class="up-dot peak"></span>
        <span class="up-label">高峰时段</span>
        <span class="up-val">${fmtYuan(sum.peakCost)}</span>
        <span class="up-bar"><i style="width:${(ratio * 100).toFixed(1)}%"></i></span>
        <span class="up-pct">${(ratio * 100).toFixed(0)}% token</span>
      </div>
      <div class="up-row">
        <span class="up-dot off"></span>
        <span class="up-label">闲时</span>
        <span class="up-val">${fmtYuan(sum.offPeakCost)}</span>
        <span class="up-bar"><i class="off" style="width:${((1 - ratio) * 100).toFixed(1)}%"></i></span>
        <span class="up-pct">${((1 - ratio) * 100).toFixed(0)}% token</span>
      </div>
      <div class="up-hint">高峰 = 北京时间工作日 9:00-12:00、14:00-18:00；周末全天闲时。</div>
    </div>`;
}

/**
 * 点表格行 → 弹明细。
 * dim 决定可选的第二个维度：
 *   chat  → 按模型 / 按天
 *   model → 按会话 / 按天
 *   day   → 按模型 / 按会话
 */
function openUsageBreakdown(dim, key) {
  const tabs = {
    chat: [['model', '各模型'], ['day', '各天']],
    model: [['chat', '各群聊'], ['day', '各天']],
    day: [['model', '各模型'], ['chat', '各群聊']]
  }[dim] || [['model', '各模型']];

  const dimLabel = { chat: '会话', model: '模型', day: '日期' }[dim] || '';
  let activeBy = tabs[0][0];

  const overlay = modelModalShell({
    head: `明细：${dimLabel} ${key}`,
    body: `
      <div class="ub-wrap">
        <div class="ub-tabs" id="ub-tabs">${tabs.map(([v, l]) => `<button class="btn btn-small" data-by="${v}">${l}</button>`).join('')}</div>
        <div id="ub-peak"></div>
        <div class="ub-scroll">
          <table class="usage-table">
            <thead><tr><th id="ub-col">项目</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody id="ub-body"><tr><td colspan="6" class="muted">加载中…</td></tr></tbody>
          </table>
        </div>
      </div>`,
    foot: `<button class="btn" id="ub-close">关闭</button>`
  });

  const bodyEl = overlay.querySelector('#ub-body');
  const peakEl = overlay.querySelector('#ub-peak');
  const colEl = overlay.querySelector('#ub-col');

  async function load() {
    bodyEl.innerHTML = '<tr><td colspan="6" class="muted">加载中…</td></tr>';
    try {
      const r = await api(`/api/usage/breakdown?range=${encodeURIComponent(usageRange)}&dim=${dim}&key=${encodeURIComponent(key)}&by=${activeBy}`, { timeoutMs: 15000 });
      peakEl.innerHTML = peakSplitHtml(r.totals);
      colEl.textContent = { model: '模型', chat: '会话', day: '日期' }[activeBy] || '项目';
      bodyEl.innerHTML = (r.rows || []).length
        ? r.rows.map((x) => `
            <tr>
              <td>${esc(activeBy === 'chat'
                ? formatChatTitle(x.key, chatNameOf(x.key))
                : (x.vendor ? `${x.vendor}：${x.model}` : (x.model ?? x.key)))}</td>
              <td class="r">${x.runs}</td>
              <td class="r">${fmtTok(x.promptTokens)}</td>
              <td class="r">${fmtTok(x.completionTokens)}</td>
              <td class="r">${fmtRate(x.cacheHitRate)}</td>
              <td class="r">${fmtYuan(x.cost)}</td>
            </tr>`).join('')
        : '<tr><td colspan="6" class="muted">无数据</td></tr>';
    } catch (e) {
      bodyEl.innerHTML = `<tr><td colspan="6" class="muted">加载失败：${esc(e.message)}</td></tr>`;
    }
  }

  overlay.querySelectorAll('#ub-tabs [data-by]').forEach((el) => {
    el.addEventListener('click', () => {
      activeBy = el.dataset.by;
      overlay.querySelectorAll('#ub-tabs [data-by]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.by === activeBy));
      load();
    });
  });
  overlay.querySelector('#ub-close').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelectorAll('#ub-tabs [data-by]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.by === activeBy));
  load();
}
