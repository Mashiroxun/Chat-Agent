// 桌宠「直接对话」窗口（2026-10-24）。
//
// 这条窗口只连**一个会话**：`private:<机器人自己的 QQ 号>`，也就是只属于主人的那条。
// 没有会话选择器 —— 用户明确要求过"不要塞进别的群"，所以这里从一开始就不给选群的机会，
// 从根上排除误选。
//
// 与开发工单窗同一套骨架（白卡 + 消息列表 + 输入框），消息模型：
//   自己以「主人」身份说的话靠右（实心蓝），它的回复靠左（带头像），表情包按原图比例贴出来。
// 历史来自这条会话**真实的存档**（跨重启保留），捕获到的回复按时间戳插在后面。
//
// 数据全部经主进程转发（受限 preload）：页面不直连 HTTP、不碰文件、也拿不到模型凭据。
// 渲染只用 DOM API + textContent —— 模型说的话一律当纯文本处理，免得一句带尖括号的
// 台词被当成标签解析掉。
const api = window.qqPetChat;
const $ = (id) => document.getElementById(id);
// 空状态节点必须先缓存：render() 会清空列表，之后 getElementById 就找不到它了。
const emptyNode = $('empty');

const state = {
  messages: [],
  chatKey: '',
  chatName: '私聊 · 主人',
  notice: '',
  typing: false,
  busy: false,
  error: '',
  name: '对话',
  rendered: '',
  pending: []      // 待发送的附件：[{path, name, size}]
};

const scrollNearBottom = () => {
  const list = $('list');
  return list.scrollHeight - list.scrollTop - list.clientHeight < 90;
};

function el(tag, cls = '', text = '') {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function avatarText() {
  const name = String(state.name || '').trim();
  return name ? Array.from(name)[0] : '·';
}

const fmtSize = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
};

/** 一条消息：me=自己（右，实心蓝）/ bot=它（左，带头像）/ them=这条会话里的其他人。 */
function messageNode(message) {
  const role = String(message.role || '');
  const mine = role === 'me';
  const row = el('div', `row${mine ? ' me' : ''}`);
  if (!mine) row.append(el('span', 'ava', avatarText()));
  const stack = el('div', 'stack');
  const who = String(message.name || '').trim();
  if (role === 'them' && who) stack.append(el('div', 'who', who));
  const text = String(message.text || '').trim();
  if (text) stack.append(el('div', `bubble ${mine ? 'me' : 'them'}`, text));
  else if (message.media) stack.append(el('div', `bubble ${mine ? 'me' : 'them'}`, '［图片］'));

  // 自己这句话带的附件（原图在磁盘上，这里只列文件名与体积）
  if (mine && Array.isArray(message.files) && message.files.length) {
    const box = el('div', 'att');
    for (const f of message.files) {
      box.append(el('span', 'att-chip', `${f.name || '(文件)'}${f.size ? ` · ${fmtSize(f.size)}` : ''}`));
    }
    stack.append(box);
  }

  for (const sticker of message.stickers || []) {
    if (sticker.dataUrl) {
      const img = document.createElement('img');
      img.className = 'sticker';
      img.alt = sticker.desc ? `表情：${sticker.desc}` : '表情';
      img.src = sticker.dataUrl;
      stack.append(img);
    } else {
      // 表情图读不到（本地文件被清掉 / 插件刚被关）时别留个破图，
      // 说明白"这里原本是一张表情"，内容不至于整个消失。
      stack.append(el('div', 'sticker missing', sticker.desc ? `［${sticker.desc}］` : '［表情］'));
    }
  }
  if (message.image) {
    const img = document.createElement('img');
    img.className = 'sticker';
    img.alt = '图片';
    img.src = message.image;
    stack.append(img);
  }
  if (!stack.childElementCount) return null;
  row.append(stack);
  return row;
}

function typingNode() {
  const row = el('div', 'row');
  row.append(el('span', 'ava', avatarText()));
  const stack = el('div', 'stack');
  const bubble = el('div', 'bubble them typing');
  for (let i = 0; i < 3; i += 1) bubble.append(document.createElement('i'));
  stack.append(bubble);
  row.append(stack);
  return row;
}

/** 内容指纹：同一份快照不重画（轮询每几秒一次，没必要反复重建 DOM、打断用户滚动）。 */
function signatureOf() {
  const msgs = state.messages.map((m) => `${m.role}:${m.at}:${(m.text || '').length}:${(m.stickers || []).map((s) => s.id).join()}:${m.image ? 1 : 0}:${m.media || 0}:${(m.files || []).map((f) => f.name).join()}`).join('|');
  return `${state.chatName}|${state.name}|${state.typing}|${state.error}|${state.notice}|${state.pending.map((f) => f.path).join()}|${msgs}`;
}

/** 待发送附件条：文件名 + 体积 + 一个删除。 */
function renderAttach() {
  const box = $('attach');
  box.textContent = '';
  if (!state.pending.length) { box.hidden = true; return; }
  box.hidden = false;
  for (let i = 0; i < state.pending.length; i += 1) {
    const f = state.pending[i];
    const chip = el('span', 'chip');
    chip.append(el('span', 'chip-name', f.name || '(文件)'));
    chip.append(el('span', 'chip-size', fmtSize(f.size)));
    const x = el('button', 'chip-x', '×');
    x.type = 'button';
    x.title = '移除这个附件';
    x.addEventListener('click', () => { state.pending.splice(i, 1); renderAttach(); render(); });
    chip.append(x);
    box.append(chip);
  }
}

function render() {
  const list = $('list');
  const pinned = scrollNearBottom();
  list.textContent = '';

  if (!state.messages.length && !state.typing) {
    list.append(emptyNode);
  } else {
    for (const message of state.messages) {
      const node = messageNode(message);
      if (node) list.append(node);
    }
    if (state.typing) list.append(typingNode());
  }
  if (state.error) list.append(el('div', 'tip err', state.error));
  if (state.notice) list.append(el('div', 'tip', state.notice));
  if (pinned) list.scrollTop = list.scrollHeight;

  $('who').textContent = state.name;
  // 徽标上写明这条会话的 key：认不出"我在新会话还是旧会话"时，这一行就是答案 ——
  // 旧版这里是个能选群的下拉框，新版只有 private:<机器人自己的号>，且不可改。
  const tag = $('chat-tag');
  tag.textContent = state.chatName || '私聊 · 主人';
  tag.title = state.chatKey
    ? `只属于你的会话：${state.chatKey}（不会跑到任何群里）`
    : '只属于你的会话（协议端未连接，还拿不到会话地址）';
  tag.hidden = !state.chatName;
  $('status').textContent = state.typing ? '正在回复…' : (state.error ? '出错了' : '');
  const dot = $('dot');
  dot.classList.toggle('busy', !!state.typing);
  dot.classList.toggle('on', !state.typing && !state.error);
  $('send').disabled = state.busy;
  $('plus').disabled = state.busy;
  renderAttach();
  state.rendered = signatureOf();
}

async function refresh() {
  if (!api) return;
  let snap;
  try { snap = await api.snapshot(); }
  catch (error) { state.error = `读取失败：${error?.message || error}`; render(); return; }
  if (!snap || snap.ok === false) {
    state.error = snap?.error || '对话不可用';
    state.messages = [];
    render();
    return;
  }
  state.messages = Array.isArray(snap.messages) ? snap.messages : [];
  state.chatKey = String(snap.chatKey || '');
  state.chatName = String(snap.chatName || '');
  state.notice = String(snap.notice || '');
  if (snap.greeting) state.name = String(snap.greeting);
  state.error = '';
  // busy 以主进程为准（窗口可能在回复中途被打开），本地正在发的那一轮不能被快照盖掉
  state.typing = snap.busy === true || state.busy;
  if (signatureOf() !== state.rendered) render();
}

async function send() {
  if (!api || state.busy) return;
  const input = $('input');
  const text = input.value.trim();
  const files = state.pending.slice(0, 8);
  if (!text && !files.length) return;

  state.busy = true;
  state.typing = true;
  state.error = '';
  input.value = '';
  state.pending = [];
  fitInput();
  render();

  try {
    const result = await api.send(text, files);
    if (result?.state) {
      state.messages = result.state.messages || [];
      state.chatKey = String(result.state.chatKey || state.chatKey);
      state.chatName = String(result.state.chatName || state.chatName);
      state.notice = String(result.state.notice || '');
      if (result.state.greeting) state.name = String(result.state.greeting);
    }
    if (result && result.ok === false) state.error = result.error || '回复失败';
  } catch (error) {
    state.error = `回复失败：${error?.message || error}`;
  } finally {
    state.typing = false;
    state.busy = false;
    render();
    input.focus();
  }
}

/** 加号：主进程弹原生选择框（可多选）。 */
async function pickFiles() {
  if (!api || state.busy) return;
  let out;
  try { out = await api.pickFiles(); }
  catch (error) { state.error = `选文件失败：${error?.message || error}`; render(); return; }
  if (!out || out.ok === false) {
    if (!out?.canceled) { state.error = out?.error || '选文件失败'; render(); }
    return;
  }
  for (const f of out.files || []) {
    if (state.pending.length >= 8) break;
    if (state.pending.some((x) => x.path === f.path)) continue;   // 重复的不叠
    state.pending.push({ path: f.path, name: f.name, size: f.size });
  }
  state.error = '';
  render();
  $('input').focus();
}

/** 拖入：File → 主进程反查磁盘路径。多文件逐个来，失败的单独报。 */
async function acceptDropped(fileList) {
  if (!api || state.busy) return;
  const files = Array.from(fileList || []).slice(0, 8);
  if (!files.length) return;
  const failed = [];
  for (const file of files) {
    if (state.pending.length >= 8) break;
    try {
      const r = await api.pathForFile(file);
      if (!r?.ok || !r.path) { failed.push(`${file.name}：${r?.error || '取不到路径'}`); continue; }
      if (state.pending.some((x) => x.path === r.path)) continue;
      state.pending.push({ path: r.path, name: r.name || file.name, size: r.size || file.size });
    } catch (error) {
      failed.push(`${file.name}：${error?.message || error}`);
    }
  }
  state.error = failed.length ? `有几个文件没能加入：${failed.join('；')}` : '';
  render();
}

function fitInput() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(96, input.scrollHeight)}px`;
}

$('send').addEventListener('click', () => void send());
$('plus').addEventListener('click', () => void pickFiles());
$('dev').addEventListener('click', () => api?.openDev?.());
$('close').addEventListener('click', () => api?.hide?.());
$('input').addEventListener('input', fitInput);
$('input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void send();
  }
});
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') api?.hide?.(); });

// ── 拖拽传入：整张卡片都是落点 ──
// dragover 必须 preventDefault，否则浏览器/Electron 不认这是放置区；
// 拖到卡片外面（或拖到资源管理器那种外部源失败）就只是不高亮，不会有别的副作用。
const panel = $('panel');
let dropDepth = 0;
panel.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  dropDepth += 1;
  panel.classList.add('is-drop');
});
panel.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types?.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
panel.addEventListener('dragleave', () => {
  dropDepth = Math.max(0, dropDepth - 1);
  if (!dropDepth) panel.classList.remove('is-drop');
});
panel.addEventListener('drop', (event) => {
  event.preventDefault();
  dropDepth = 0;
  panel.classList.remove('is-drop');
  if (state.busy) { state.error = '它正在回上一条，稍等一下再发文件'; render(); return; }
  void acceptDropped(event.dataTransfer?.files);
});

api?.onTyping?.((value) => {
  const typing = value?.typing === true;
  if (state.typing === typing) return;
  state.typing = typing;
  render();
});
api?.onRefresh?.(() => { void refresh(); });
api?.ready?.();
fitInput();
void refresh();
// 这段对话跨重启保留：隔几秒拉一次，让窗口里的历史跟着真实存档动
// （这条会话只有你在写，所以轮询很轻；8 秒而不是 2 秒，快照要读存档目录）。
setInterval(() => { if (!document.hidden) void refresh(); }, 8000);
$('input').focus();
