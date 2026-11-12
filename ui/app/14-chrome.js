// 〔信息架构 · 照原型 v2〕—— 一级 5 项 / 左栏每页一份 / 全屏页
'use strict';
/* ══════════════════════════════════════════════════════════════
 原型 v2 与 0.4.5 的差别只在「外壳」，不在数据：
   · 9 个页面（sessions/chats/memory/usage/skills/plugins/harness/connection/
     settings）两边同名，16 个渲染器一行不用改；
   · 差的是一级入口（9 平铺 → 5 平铺）、左栏（无 → 每页一份）、
     会话首页（列表+聊天 → PCL 启动页）+ 聊天进全屏页。

 本段是唯一的新增逻辑层，做法是**包裹**而不是改写：
   · switchTab 是全局函数声明（00-core.js），这里换成 wrapper →
     每次切页后同步顶栏高亮 / 左栏 / 全屏页，00-core 本体零改动；
   · 二级导航项复用 .tab 契约：带 data-tab 即可被 switchTab 认知，
     但**不加 .tab 类**，避免吃到顶栏胶囊样式与 $$('.tab') 的 active 覆盖。
 ══════════════════════════════════════════════════════════════ */
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  /* ── 信息架构表（与 index.html 顶栏 6 项一一对应）───────────────── */
  var GROUPS = [
    { key: 'sessions', label: '会话', home: 'sessions', subs: ['sessions', 'chats', 'memory'] },
    { key: 'usage',    label: '用量', home: 'usage',    subs: ['usage'] },
    // r91：导航栏「拓展」改名为「下载」。
    // r97：左栏**只留两个市场页**，撤掉 r94 加的「已安装（技能 / 插件）」那段。
    //   起因：r95 把"本机技能/插件的开关"整块搬进了「会话设置 → 扩展」（用户当时给的
    //   参照是 PCL「版本设置 → Mod 管理」）；同一件事在「下载」页左栏再列一遍就成了
    //   重复入口 —— 用户报「下载界面的这玩意是不是有点多余」。
    //   ⚠️ R102 复盘 r97：当时只想着"别重复"，却把「管已装的」入口撤到了**看不见**的
    //   地方 —— 它只剩「会话设置 → 扩展」一条路，而进会话设置要先点会话、再点齿轮，
    //   绝大多数用户走不到（用户反馈原话：「有不少人反馈说找不到插件的位置，就是
    //   不知道在哪个界面开关插件」）。市场的绿「已安装」钮又是个 disabled 的死按钮：
    //   点不动，也不告诉你去哪开。
    //   现在分工改成：**下载页左栏 = 一段「市场」（装新的）+ 一段「已安装」（管已装的）**，
    //   后者直接落到带开关的 #view-skills / #view-plugins；市场卡片上那颗绿钮同时
    //   改成可点的「管理」，点了跳过去并高亮那一张卡（见 16-market.js）。
    // subs 仍含 skills/plugins —— groupOfTab 靠它把 switchTab('skills'/'plugins')
    //   归到本组（否则顶栏高亮会掉回「会话」）。这两个页仍存在，只是入口在别处：
    //   ① 会话设置 → 扩展 → 右栏「打开完整管理页」 ② 设置 → 扩展 的同名按钮。
    { key: 'ext',      label: '下载', home: 'skillmarket',
      subs: ['skills', 'plugins', 'personas', 'skillmarket', 'pluginmarket', 'personamarket'],
      navSubs: ['skillmarket', 'pluginmarket', 'personamarket', 'skills', 'plugins', 'personas'] },
    // 2026-10-18：harness ↔ 连接页对调。萌新点「工具」绝大多数是去看
    // 机器人连上没有 / 该怎么装协议端，harness（自检 + 对话审查）是进阶排查
    // 工具 —— home 决定点一级入口先进哪个页，subs 顺序决定左栏排列，两处一起换。
    // 2026-10-23：页签 snowluma → connection（协议端改由用户自装，这一页只报连接）。
    // 2026-10-24：桌宠并进本组（原为独立一级入口「data-top=pet」）。顶栏 6 项 → 5 项，
    //   左栏 2 项 → 3 项：连接 / 自检 / 桌宠。桌宠与另两项同为"机器人跑不跑得起来 /
    //   长什么样"的杂务，放在一级平铺反而挤掉了常用入口。
    { key: 'ops',      label: '工具', home: 'connection', subs: ['connection', 'harness', 'desktop-pet'] },
    // 壁纸页（内置壁纸模块（src/wallpaper））。
    // 2026-10-23：从「设置」组的二级页改成**独立一级入口**（放在设置右边）。
    //   原因：settings 组的左栏渲染被 syncChrome 关掉了（settings 用自己那份
    //   #settings-sidebar 分区菜单），所以 wallpaper 虽然写在 subs 里，
    //   左栏永远不会画出「壁纸」这一项 —— 整页等于没有入口，用户报「切换不了壁纸」。
    //   提成一级之后：顶栏点「壁纸」直接进页，左栏也不需要（见 syncChrome 的 is-none）。
    { key: 'wallpaper', label: '壁纸', home: 'wallpaper', subs: ['wallpaper'] },
    // 2026-10-24：原「桌宠」独立分组已撤 —— desktop-pet 并进 ops 组（见上面那条注释）。
    //   groupOfTab 找不到归属会回退成「会话」组，顶栏高亮会掉到会话上，所以这里必须登记。
    { key: 'settings', label: '设置', home: 'settings', subs: ['settings'] }
  ];
  var SUB_LABEL = {
    sessions: '会话', chats: '存档', memory: '记忆', usage: '用量', skills: '技能',
    plugins: '插件', skillmarket: '技能下载', pluginmarket: '插件下载', personamarket: '人设下载',
    // 2026-10-22：「已安装」段的第三项。技能/插件管开关，人设管"用哪一个"，
    // 三者是同一层的东西，所以都挂在「已安装」下而不是另开一段。
    personas: '人设',
    // 2026-10-20：曾改成 '自检'（页内三个模块叫「自检系统 / 对话审查 / 自动修复」，
    // 取「自检」当页签名）。
    // 2026-10-21 改回 'harness'：内置化后该页是**工具链工作台**（自检 / 对话审查 /
    // 自动修复 / 锻造 / 工单 五块），「自检」已盖不住页内内容 —— 再叫自检，点进去
    // 看到的却是一整排工单/锻造，名不副实。旁边 SnowLuma 本来就是英文名，一致。
    // 2026-10-23 萌新化再改「自检」：左栏是小白第一眼看到的地方，英文 harness
    //   等于没有指引；页内多模块由子页签自己呈现，入口名只负责"看病查问题"。
    //   hover 说明走 navItemHtml 里给 harness 加的 title（结构上没有副标题位）。
    harness: '自检', connection: '连接', settings: '设置',
    // 2026-10-24：桌宠并进「工具」左栏，需要左栏能显示的名字（此前它在一级入口，
    //   顶栏按钮自带文字，这一项从未被用过）。
    'desktop-pet': '桌宠'
  };
  var SUB_ICON = {
    // r108：与「会话选择」全屏页「页面」三项的图标对齐同一套设计（会话=双气泡 /
    //   存档=归档箱 / 记忆=数据库圆柱），避免同一概念在两侧长成两副样子。
    sessions: 'M5 4 h5 a2 2 0 0 1 2 2 v3 a2 2 0 0 1 -2 2 h-5 a2 2 0 0 1 -2 -2 v-3 a2 2 0 0 1 2 -2 z M14 13 h5 a2 2 0 0 1 2 2 v3 a2 2 0 0 1 -2 2 h-5 a2 2 0 0 1 -2 -2 v-3 a2 2 0 0 1 2 -2 z',
    chats: 'M2 4h20v4H2z M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8 M10 12h4',
    memory: 'M12 3c4.97 0 9 1.34 9 3s-4.03 3-9 3-9-1.34-9-3 4.03-3 9-3z M3 6v12c0 1.66 4.03 3 9 3s9-1.34 9-3V6 M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3',
    skills: 'M12 3l2.2 5.4L20 10l-5.8 1.6L12 17l-2.2-5.4L4 10l5.8-1.6z',
    plugins: 'M10 4h4v3a2 2 0 1 0 4 0h2v6h-3a2 2 0 1 0 0 4h3v3H7v-3a2 2 0 1 0 0-4H4V7h3a2 2 0 1 0 3 0z',
    // 市场：下载箭头入库（r91 改名为「下载」子页）
    skillmarket: 'M12 4v10M8 10l4 4 4-4M5 18h14',
    pluginmarket: 'M12 4v10M8 10l4 4 4-4M5 18h14',
    // r113：人设市场**不能沿用上面那枚下载箭头** —— 技能/插件/人设三个并列时，
    //   同一个图标出现三次等于没有区分度，用户会以为是同一个页面。
    //   换成一枚人形（头 + 肩），与"人设"字面对上，也和左栏「人设与记忆」段的图标不同路。
    personamarket: 'M12 10.6a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6zM4.8 19.5c.9-3.2 3.7-5 7.2-5s6.3 1.8 7.2 5',
    // 2026-10-22：「已安装的人设」。刻意不用 personamarket 那枚单人形 ——
    //   两者在左栏上下紧挨着，同一个图标等于没有区分度。改成「人形 + 右侧三条
    //   列表线」：左边是"这一个人"，右边是"一串"，对上"人设库"的语义。
    personas: 'M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 19c.8-2.8 3.2-4.4 6-4.4s5.2 1.6 6 4.4M17 7h4M17 11h4M17 15h4',
    harness: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
    // 壁纸（内置壁纸模块（src/wallpaper））：相框 + 里面一座山，标准"图片/壁纸"语义。
    wallpaper: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M7.5 10.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z M3 16.5l4.8-4.3a1.6 1.6 0 0 1 2.1 0L15 17M13.2 14.6l2.6-2.3a1.6 1.6 0 0 1 2.1 0L21 15.5',
    // 桌宠（desktop-pet 插件）：与 index.html 顶栏那枚「猫头」同一套路径。
    'desktop-pet': 'M4 11l1.4-6 4.6 3h4l4.6-3L20 11v3a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6z M9.2 14h.01M14.8 14h.01',
    connection: 'M12 3v18M4 7l16 10M20 7L4 17',
    /* r96：与顶栏导航「设置」项（index.html #tabs 的 data-top="settings"）**同一枚**图标。
       它是两段 path（内圆 + 齿轮外圈）；此前「打开完整设置页」只抄了第一段内圆，
       15px 下渲染成 4.4px 的小圈，看着像个列表圆点，与上面 ✦ 技能 / 插件 的真图标不是一路。 */
    settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.11a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.56 1.03z'
  };
  /* 「用量」是单页，左栏照 PCL 做成本页分块的导航。
     ⚠️ 2026-10-09（r29）：「锚点滚动」改成「同页切换」——
        三块原本同时铺在同一个滚动区里（实测 #usage-page 内容 974px / 视口 826px），
        点左栏只是把滚动条推 148px，画面里的三张图一张没少，用户报「这仨显得很没用」。
        现在点哪一项就只显示哪一块，左栏才是真的导航。
        dim 取值必须与 04-archive-usage.js 里 [data-block] 的三个值逐字一致。 */
  var USAGE_ANCHORS = [
    { dim: 'days',   label: '按天',   icon: 'M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-3' },
    { dim: 'chats',  label: '按会话', icon: 'M4 5h16v11H8l-4 4z' },
    { dim: 'models', label: '按模型', icon: 'M4 7h16M4 12h10M4 17h7' },
    // 2026-10-19：插件维度（token 归因）。dim 必须与 04-archive-usage.js 里
    // [data-block="plugins"] 与 style.css 的 data-udim 选择器逐字一致。
    { dim: 'plugins', label: '按插件', icon: 'M4 8h7v7H4zM13 4h7v7h-7zM13 13h7v7h-7zM4 17h7v3H4z' }
  ];
  var usageDim = 'days';     // 用户选中的维度（对齐原型 usageAnchor 默认 usage-day）
  /* ══════════ 全屏页 · 会话设置（真·按会话）══════════
     ⚠️ 2026-10-09（r33）：这一页原先的做法是把 #settings-form **整体借过来**、
        只显示全局的前三个分区（人设与记忆 / 聊天 / 工具与技能）。实测后果：
          · 它和导航栏「设置」是**同一份内容**（同一个 DOM 节点被 appendChild 搬走），
            用户原话「一个放全局设置，一个放对话的设置，二者不要重复」；
          · 左栏「当前会话」一直显示「未选择会话」—— 它根本没绑定任何会话。
        现在改成**真·按会话**：只放"能按单个会话覆盖"的项
        （白名单归属 / 人设覆盖 / 响应档位 / 指令禁言 / 群成员屏蔽），
        全局默认值仍只属于导航栏「设置」页，两页不再有重复内容。
     ⚠️ 全局页那边**一个字符没动**（用户 r33 拍板）：设置→人设的「分会话按钮
        网格」、设置→聊天→活跃设置里的分群档位，是"跨会话批量管理"的入口，
        语义上属于全局页，保留。 */

  var setupChat = '';        // 当前正在配置的会话 chatKey（'' = 还没选）

  /* ── r95：这一页左栏的「视图」────────────────────────────────────
     'chat'  = 按会话的设置（默认，r33 起的正文）
     'skill' / 'plugin' = 本机已安装的技能 / 插件（卡片 + 开关）
     用户原话：「技能、插件这俩玩意能不能放到『会话设置』里面去」——
     PCL 的对应关系是「启动页『版本设置』 → 左栏『Mod 管理』 → 列表」，
     所以入口做在左栏、列表出在右栏（同一页切换，不跳页）。 */
  var setupView = 'chat';

  /* 左栏「扩展」两项右侧的计数：本机已装几个 / 几个生效。
     取 state.skills（/api/skills 那一份），与「下载 → 技能 / 插件」页同源。
     ⚠️ kind 为 null（自定义根目录）归入**技能**，与 renderModulePage 的归类逐字一致 ——
        不然左栏说「技能 3 个」、点进去却列了 4 张卡。 */
  function extStatOf(kind) {
    var st = { total: 0, on: 0 };
    // 人设的数据源是 /api/persona-templates（state.personaTemplates），
    // 与技能/插件的 /api/skills 不是同一份 —— 统计口径交给 19-personas.js 的
    // personaStatOf()，免得这里再算一遍、两边慢慢漂开。
    if (kind === 'persona') {
      try {
        if (typeof personaStatOf === 'function') return personaStatOf();
      } catch (e) { /* 未加载 → 显示 0 个 */ }
      return st;
    }
    try {
      var all = (typeof state !== 'undefined' && state.skills) || [];
      for (var i = 0; i < all.length; i++) {
        var s = all[i] || {};
        var k = s.kind == null ? 'skill' : s.kind;
        if (k !== kind) continue;
        st.total++;
        if (s.loaded && s.enabled && s.active) st.on++;
      }
    } catch (e) { /* state 还没就绪 → 显示 0 个，别抛 */ }
    return st;
  }
  /* 左栏那一条：图标与「下载」页左栏用的是同一份 SUB_ICON，认起来是一回事。
     aria-current 与 .on 同源（r86 的教训：视觉高亮读屏读不到）。 */
  function extEntryHtml(kind, label, icon) {
    var st = extStatOf(kind);
    var on = setupView === kind;
    return '<button class="bp-act' + (on ? ' on' : '') + '" type="button" data-setup-ext="' + kind + '"' +
      (on ? ' aria-current="true"' : '') +
      ' title="' + label + '：本机已装 ' + st.total + ' 个，' + st.on + ' 个生效（点开管理开关）">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + icon +
      '" stroke-linejoin="round" stroke-linecap="round"/></svg>' +
      '<span>' + label + '</span>' +
      // 人设是单选，"生效"这个词对不上 —— 用"使用中"。技能/插件保持"生效"。
      '<span class="su-ext-n">' + st.total + ' 个 · ' + st.on + (kind === 'persona' ? ' 使用中' : ' 生效') + '</span></button>';
  }
  /* 进「技能 / 插件」时补拉一次 /api/skills。
     用户完全可能从没点过导航栏「下载」页 —— 那时 state.skills 还是空的，
     左栏会写「技能 0 个 · 0 生效」、右栏一张卡都没有，看着像"东西被我弄丢了"。
     ⚠️ 只在这一页仍停在同一个视图时回写：拉取期间用户可能已经改点会话或关页，
        不能把画面抢回来。extLoading 保证一次访问只拉一遍
        （renderSetupPane 会在筛选/开关后反复重渲染，次次都拉就成轮询了）。 */
  var extLoading = '';
  function refreshSetupExt(kind) {
    if (typeof loadSkillsStatus !== 'function') return;
    if (extLoading === kind) return;
    extLoading = kind;
    loadSkillsStatus().then(function () {
      if (!bigpage || bigpage.hidden || setupView !== kind) { extLoading = ''; return; }
      renderSetupNav();     // 左栏那两条的计数也要跟着更新
      // ⚠️ extLoading 要等这次重画**结束**再放开：renderSetupPane 内部又会调
      //    refreshSetupExt —— 提前清空就成了"渲染→拉取→渲染→拉取"的轮询。
      renderSetupPane();
      extLoading = '';
    }).catch(function () { extLoading = ''; });
  }

  /* 标题条右侧那句话随视图换（'chat' 用 r33 的原话）。 */
  function setSetupCrumb(view) {
    var el = $('#bp-crumb');
    if (!el) return;
    el.textContent = view === 'skill' ? '本机已安装的技能 · 开关全局生效'
      : view === 'plugin' ? '本机已安装的插件 · 开关全局生效'
        : view === 'persona' ? '本机已安装的人设 · 全局生效，同一时间只有一个'
          : '只对选中的这一个会话生效 · 全局设置在顶栏「设置」里';
  }

  function escH(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function cfgNow() {
    try { return (typeof state !== 'undefined' && state.config) || {}; } catch (e) { return {}; }
  }
  /* 'group:123' → { kind:'group', id:'123' } */
  function splitKey(chatKey) {
    var p = String(chatKey || '').split(':');
    return { kind: p[0] || '', id: p[1] || '' };
  }
  /* 会话群名 / 私聊备注名（拿不到返回空串）。state.chats 由 /api/chats 灌入。 */
  function chatNameOfKey(chatKey) {
    try {
      var list = (typeof state !== 'undefined' && state.chats) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].key === chatKey) return String(list[i].chatName || '').trim();
      }
    } catch (e) { /* ignore */ }
    return '';
  }
  /* 左栏用：只要名字（拿不到才退回「群 123」）。左栏只有 216px，带上群号必被截断。 */
  function chatShortLabel(chatKey) {
    var nm = chatNameOfKey(chatKey), k = splitKey(chatKey);
    if (nm) return nm;
    if (k.kind === 'group') return '群 ' + k.id;
    if (k.kind === 'private') return '私聊 ' + k.id;
    return String(chatKey || '');
  }
  /* 右栏标题用：名字（群号） / 群 群号 —— 既好认又能核对身份。 */
  function chatLabel(chatKey) {
    var nm = chatNameOfKey(chatKey), k = splitKey(chatKey);
    if (k.kind === 'group') return nm ? (nm + '（' + k.id + '）') : ('群 ' + k.id);
    if (k.kind === 'private') return nm ? (nm + '（' + k.id + '）') : ('私聊 ' + k.id);
    return String(chatKey || '');
  }
  /* ── 白名单键归一化（r60）─────────────────────────────────────────
     后端权威格式是**裸号**（src/app.js allowed() 直接 includes(String(id))，
     设置页表单、跨会话发送工具同样按裸号比对）。此前 setupChatList 用精确
     字符串去重、setAllowState 还写入带前缀的 chatKey —— 裸号与 group:号
     在左栏里各渲染一行，就是用户看到的"两个相同的群"。读取时一律归一化、
     写入时一律落裸号，两端格式从此不再分叉。 */
  function bareIdOf(entry) {
    var m = String(entry).match(/^(?:group|private):(.+)$/);
    return m ? m[1] : String(entry);
  }
  /* 白名单 → 规范 chatKey 集合（'group:123' / 'private:456'）。 */
  function allowMapOf() {
    var c = cfgNow(), map = {};
    ((c.allow || {}).groups || []).forEach(function (x) { map['group:' + bareIdOf(x)] = true; });
    ((c.allow || {}).private || []).forEach(function (x) { map['private:' + bareIdOf(x)] = true; });
    return map;
  }
  /* 可配置的会话清单：白名单(群 ∪ 私聊) 在前，state.chats 里其余的补在后面
     （标记 inAllow=false —— 用户可能在会话列表里看到一个还没加白名单的群）。 */
  function setupChatList() {
    var seen = {}, out = [];
    Object.keys(allowMapOf()).forEach(function (k) { if (k && !seen[k]) { seen[k] = 1; out.push({ key: k, inAllow: true }); } });
    try {
      (((typeof state !== 'undefined' && state.chats) || [])).forEach(function (ch) {
        if (ch && ch.key && !seen[ch.key]) { seen[ch.key] = 1; out.push({ key: ch.key, inAllow: false }); }
      });
    } catch (e) { /* ignore */ }
    return out;
  }
  /* 该会话的人设覆盖（后端 personaForChat 认两种键：纯 id 与 chatKey，这里也两种都查）。 */
  function personaConfOf(chatKey) {
    var c = cfgNow(), k = splitKey(chatKey), map = c.personaByChat || {};
    return map[String(k.id)] || map[String(chatKey)] || {};
  }
  function hasPersonaOwn(chatKey) {
    var p = personaConfOf(chatKey);
    return Boolean(p.roleText || p.participation || p.customRules || p.systemPromptOverride);
  }
  /* 该群单独档位（滑条位置 0~100）；没有单独设置返回 null。
     ⚠️ 后端只有 store.unifiedTier === false 时才看 groupSliderPos（src/config.js:718）。 */
  function groupSliderOf(chatKey) {
    var c = cfgNow(), k = splitKey(chatKey);
    var m = (c.store || {}).groupSliderPos || {};
    var v = m[String(k.id)];
    if (v === undefined || v === null) v = m[String(chatKey)];
    var n = Number(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
  }
  var TIER_TEXT = { 1: '仅艾特', 2: '+关键词', 3: '+随机', 4: '全响应' };
  /* 该会话当前**实际生效**的档位摘要（含来源：本群单独 / 跟随全局）。 */
  function effectiveTierOf(chatKey) {
    var c = cfgNow(), st = c.store || {};
    var k = splitKey(chatKey);
    var unified = st.unifiedTier !== false;      // 默认统一
    var own = (!unified && k.kind === 'group') ? groupSliderOf(chatKey) : null;
    var pos = own !== null ? own : (Number.isFinite(Number(st.contextSliderPos)) ? Number(st.contextSliderPos) : 100);
    var t;
    try { t = (typeof sliderToTier === 'function' ? sliderToTier(pos) : { tier: 4, randomPercent: 100 }); }
    catch (e) { t = { tier: 4, randomPercent: 100 }; }
    // 峰谷开启时全局档位其实是两个点，全局摘要这里只做参考值，实际以活跃设置里的为准
    return { own: own !== null, pos: pos, tier: t.tier, randomPercent: t.randomPercent,
      unified: unified, peakOn: (st.peakSchedule || {}).enabled === true };
  }
  /* 指令禁言：该群是否处于禁言期（后端 commandMuteTier 同口径，仅群聊有意义）。 */
  function muteStateOf(chatKey) {
    var c = cfgNow(), k = splitKey(chatKey);
    var cm = c.commandMute || {};
    if (k.kind !== 'group' || !k.id) return { applicable: false };
    var until = Number((cm.active || {})[String(k.id)]);
    if (!Number.isFinite(until)) return { applicable: true, muted: false };
    if (until === 0) return { applicable: true, muted: true, manual: true };
    if (Date.now() < until) return { applicable: true, muted: true, until: until };
    return { applicable: true, muted: false, expired: true, until: until };
  }
  function blockedCountOf(chatKey) {
    var c = cfgNow(), k = splitKey(chatKey);
    var m = (c.blocklist || {})[String(k.id)] || (c.blocklist || {})[String(chatKey)] || [];
    return Array.isArray(m) ? m.length : 0;
  }
  /* 统一的 patch 提交口：POST /api/config 回 `{config}`，回写 state.config 供重渲染。 */
  function suSave(patch) {
    return api('/api/config', { method: 'POST', body: JSON.stringify(patch) }).then(function (r) {
      if (r && r.config) { try { state.config = r.config; } catch (e) { /* ignore */ } }
      return r;
    });
  }
  function suAlert(msg) {
    try { if (typeof qaAlert === 'function') { qaAlert(msg); return; } } catch (e) { /* ignore */ }
    console.warn('[setup] ' + msg);
  }

  function groupOfTab(name) {
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].subs.indexOf(name) >= 0) return GROUPS[i];
    }
    return GROUPS[0];
  }

  var sidebar = $('#sidebar');
  var sideLaunch = $('#side-launch');
  var sideNav = $('#side-nav');
  var panes = {
    chats: $('#chat-list'),
    memory: $('#memory-list'),
    settings: $('#settings-sidebar')
    // r36：#settings-community 已迁到设置页页脚（index.html #settings-foot），不再由外壳同步
  };

  /* ══════════ 侧栏宽度 ══════════
     启动页 300 / 导航页 176 / 存档·记忆（要列群聊）268 / 设置 196。
     用户拖过分隔条后 --pane-w 落在 #sidebar 行内样式上，此后**统一覆盖**各页默认值 ——
     否则「拖宽了启动页、切到设置又缩回去」会让人以为拖动没生效。 */
  function syncSidebarWidth(name, group) {
    if (!sidebar) return;
    var cls = 'is-launch';
    if (name === 'sessions') cls = 'is-launch';
    else if (name === 'chats' || name === 'memory') cls = 'is-wide';
    else if (group.key === 'settings') cls = 'is-set';
    // 壁纸页是整页布局（左壁纸库、右预览，自己带两栏），再挂一条 176px 左栏
    // 只会白白吃掉一块宽度 → 整条侧栏收起。is-none 的样式见 style.css
    // 「每页一份的固定宽度」那一节。
    else if (group.key === 'wallpaper') cls = 'is-none';
    // 2026-10-24：桌宠不再是"整页单页一级"（已并进 ops 组左栏），这里不再特例 ——
    //   它和技能/插件页一样走 is-nav，左栏 176px，面板自己缩。
    else cls = 'is-nav';
    sidebar.classList.remove('is-launch', 'is-nav', 'is-wide', 'is-set', 'is-none');
    sidebar.classList.add(cls);
  }

  /* ══════════ 用量页的「统计维度」切换 ══════════
     后端 stats.mode：'today' | '24h' | 'days' | 'all'（src/app.js 的 rangeWindow）。
     只有 'days' 时按天那块才有内容 —— 04-archive-usage.js:881 会把它整块 display:none。
     stats 参数：传本次**将要渲染**的那份统计（切时间范围时用，避免拿上一次的 mode 判断）；
              不传则取 state.usageRenderArgs（04 每次渲染都会写）。 */
  function usageModeOf(stats) {
    if (stats && stats.mode) return stats.mode;
    try {
      if (typeof state === 'undefined') return null;
      var a = state.usageRenderArgs;
      return (a && a.stats && a.stats.mode) || null;
    } catch (e) { return null; }
  }
  function usageOff(stats) {
    var m = usageModeOf(stats);
    return !!m && m !== 'days';      // 「今日 / 24 小时」→ 按天没有内容
  }
  /* 「今日」范围下按天没内容 → 降级显示「按会话」。
     ⚠️ 只降级**显示**，不动 usageDim：用户切回「近 7 天 / 近 30 天」时「按天」要自己亮回来。 */
  function usageDimNow(stats) {
    return (usageDim === 'days' && usageOff(stats)) ? 'chats' : usageDim;
  }

  /* 把「一次只显示一块」写进 DOM（页面 + 左栏选中/置灰一起刷，两处永远同步）。
     ⚠️ 这里**只**写 #usage-page 上的 data-udim，绝不写内联 display ——
        updateUsagePage 每次都会给按天块写内联 style.display（按 mode 决定），
        内联优先级高于一切选择器，我们写的那份会被它当场顶掉，
        表现为「切到按会话后按天又自己冒出来」。可见性交给 style.css 第 14 节
        的属性选择器 + !important 决定，那边才是唯一权威。 */
  function applyUsageDim(stats) {
    var cur = usageDimNow(stats);
    var off = usageOff(stats);
    var box = $('#usage-page');
    if (box) box.dataset.udim = cur;
    $$('#side-nav [data-usage-dim]').forEach(function (el) {
      var isDay = el.dataset.usageDim === 'days';
      el.classList.toggle('on', el.dataset.usageDim === cur);
      el.classList.toggle('is-off', isDay && off);
      if (isDay && off) el.setAttribute('aria-disabled', 'true');
      else el.removeAttribute('aria-disabled');
    });
  }

  /* ══════════ 左栏二级导航 ══════════ */
  // 左栏结构上没有副标题位，hover 说明走原生 title 属性（不动 DOM 结构与既有 class）。
  // 2026-10-23：harness（自检）先加；2026-10-24：桌宠并进左栏时补同款。
  var SUB_TITLE = {
    harness: '给机器人看病、查问题',
    'desktop-pet': '桌面上的 Live2D 小伙伴：今日用量卡片、开发工单'
  };
  function navItemHtml(sub, active) {
    const subTitle = SUB_TITLE[sub] ? ' title="' + SUB_TITLE[sub] + '"' : '';
    return '<button class="sn-item' + (active ? ' on' : '') + '" type="button" data-sub="' + sub + '"' +
      // ⚠️（2026-10-10 r86 修 P2）当前二级页要能被读屏识别。视觉靠 .on / .sn-bar，
      //    但对屏幕阅读器来说「一排长得一样的按钮」等于没有导航状态。
      (active ? ' aria-current="page"' : '') +
      ' role="button" tabindex="0"' + subTitle +
      '<span class="sn-bar"></span>' +
      '<svg class="sn-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="' + (SUB_ICON[sub] || '') +
      '" stroke-linejoin="round" stroke-linecap="round"/></svg>' +
      '<span class="sn-t">' + SUB_LABEL[sub] + '</span></button>';
  }

  function renderSideNav(name, group) {
    if (!sideNav) return;
    if (group.key === 'usage') {
      var cur = usageDimNow();
      // 「今日」下按天没有内容 → 该置灰不可点，不能做成"点了没反应"的哑按钮（r26 的教训）
      var offDay = usageOff();
      var h = '<div class="sn-sec">统计维度</div>';
      USAGE_ANCHORS.forEach(function (a) {
        var isOff = offDay && a.dim === 'days';
        h += '<button class="sn-item' + (a.dim === cur ? ' on' : '') + (isOff ? ' is-off' : '') +
          '" type="button" data-usage-dim="' + a.dim + '"' + (isOff ? ' aria-disabled="true"' : '') +
          // aria-current 与视觉的 .on 同源（r86 修 P2）
          (a.dim === cur ? ' aria-current="true"' : '') +
          ' role="button" tabindex="0">' +
          '<span class="sn-bar"></span>' +
          '<svg class="sn-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="' + a.icon + '" stroke-linejoin="round" stroke-linecap="round"/></svg>' +
          '<span class="sn-t">' + a.label + '</span></button>';
      });
      sideNav.innerHTML = h;
      return;
    }
    if (group.key === 'sessions') {
      // 存档 / 记忆 与「会话」同属一级，但首页被启动块占满 —— 给它们补一份
      // 「消息记录」导航，否则这两个页在界面上没有任何入口（只有会话设置里的跳转）。
      sideNav.innerHTML = '<div class="sn-sec">消息记录</div>' +
        GROUPS[0].subs.map(function (s) { return navItemHtml(s, s === name); }).join('');
      return;
    }
    // R102：「下载」页左栏分两段 ——「市场」（装新的）/「已安装」（管已装的）。
    //   写法与上面 usage / sessions 两个 case 一致（一个 .sn-sec 小标题 + 若干 .sn-item）。
    //   两段的条目合起来与 GROUPS 里 ext.navSubs **逐项对应**，要增减条目两处一起改。
    //   ⚠️ 这一段顺带修掉了「点进技能 / 插件页后左栏两条都不高亮」——
    //      此前这两个二级页在左栏根本没有对应按钮，.sn-item.on 无处可挂。
    if (group.key === 'ext') {
      var extSeg = function (title, list) {
        return '<div class="sn-sec">' + title + '</div>' +
          list.map(function (s) { return navItemHtml(s, s === name); }).join('');
      };
      sideNav.innerHTML = extSeg('市场', ['skillmarket', 'pluginmarket', 'personamarket']) +
                          extSeg('已安装', ['skills', 'plugins', 'personas']);
      return;
    }
    // r91：左栏渲染 navSubs（默认回退到 subs），而不是 subs —— 二级页可以"存在但不出现在左栏"。
    //   r94 曾在这里加过一层 navSections（按段渲染 + .sn-sec 小标题），只给「下载」组用；
    //   r97 撤掉那段后已无调用方，遂一并删除，免得留个没人用的分支。
    //   R102：上面 ext 那段就是"按段渲染"的正式版 —— 只给「下载」组用，其余组仍是一整段。
    var navSubs = group.navSubs || group.subs;
    sideNav.innerHTML = navSubs.map(function (s) { return navItemHtml(s, s === name); }).join('');
  }

  /* ══════════ 全屏页 ══════════ */
  var bigpage = $('#bigpage');
  var bpMode = '';                       // '' | 'chat' | 'setup'

  function bpWindowBtns() {
    var d = window.qqaDesktop;
    var minB = $('#bp-min'), maxB = $('#bp-max');
    // ⚠️ 2026-10-09（r25）：没有桌面壳时**只不绑事件，不再隐藏**。
    //    原先的 else 分支写 `minB.hidden = true`，于是用浏览器打开控制台 /
    //    预览页（无 window.qqaDesktop）时全屏页右上角只剩一颗 ✕ ——
    //    与真机、与原型都不一致（原型在浏览器里也画着最小化），用户会报"按钮消失了"。
    //    而且隐藏依赖本文件成功执行：脚本报错 / 渲染进程冻结都会停在隐藏态。
    //    现在：看得见由 HTML 保证，点得动由这里保证。
    if (minB && d && d.minimize) minB.addEventListener('click', function () { d.minimize(); });
    if (maxB && d && d.toggleMaximize) maxB.addEventListener('click', function () { d.toggleMaximize(); });
    // ⚠️ 关闭必须**无条件**绑定。早期写法把 #bp-x 和 min/max 一起塞进 if (d) 里，
    //    于是没有 window.qqaDesktop 时全屏页关不掉（返回键能用，只坏在这一条路径）。
    //    r54：三颗按钮同权（硬规矩 17）—— min/max 都作用于**真实窗口**，
    //    ✕ 却只关遮罩回主界面，用户报「点 x 没有关闭」。有桥时改调 d.close()
    //    （与主顶栏 #win-close-btn 同款）；关全屏页仍由 ← 返回键 / Esc 承担。
    //    无桥（浏览器 / 预览）才退回 closeBigPage，预览里 ✕ 依旧点得动。
    $('#bp-x') && $('#bp-x').addEventListener('click', function () {
      if (d && typeof d.close === 'function') { d.close(); return; }
      closeBigPage();
    });
  }

  /* ── 左栏：会话选择（= 这一页到底在配置谁）────────────────────── */
  // 2026-10-15：头像方块与 15-chat-chrome.js 的会话列表同风格（真实头像 + 首字
  // 兜底；error 用捕获委托揭兜底 —— CSP 禁内联 onerror，见 15 的 bindAvatarFallback）。
  // 2026-11-05：私聊改走 /api/avatar 本地缓存端点（R185 同款），群头像仍走 gh。
  // chatKey 形如 group:123456 / private:654321（冒号分隔），与 qqAvatarUrl 的正则一致。
  function setupAvatarHtml(key, label) {
    var m = /^(group|private):(\d{5,12})$/.exec(String(key || ''));
    var fb = escH(String(label || '?').charAt(0) || '?');
    var url = m ? (m[1] === 'group'
      ? 'https://p.qlogo.cn/gh/' + m[2] + '/' + m[2] + '/100'
      : '/api/avatar/' + m[2] + '?s=100') : '';
    if (!url) return '<span class="bp-av"><span class="av-l">' + fb + '</span></span>';
    return '<span class="bp-av" data-avk="' + escH(key) + '">' +
      '<img class="av-img" src="' + url + '" alt="" loading="lazy" referrerpolicy="no-referrer" />' +
      '<span class="av-l av-fb" hidden>' + fb + '</span></span>';
  }
  /* ── R131：左栏搜索词 ──────────────────────────────────────────────
     setupQRaw = 用户输入原文（回填 input 的 value，保留大小写与空格）；
     setupQ = 归一化（trim + 小写）后用于匹配，口径同 15-chat-chrome.js 的 st.q。
     只过滤会话清单，「扩展 / 全部设置」两段不参与。 */
  var setupQ = '', setupQRaw = '';

  /* 一次扫描 state.sessions 按 chatKey 汇总：总数 / 进行中数 / 最近一条摘要。
     口径与 15-chat-chrome.js 的 chatGroups 逐字一致（进行中 = running | waiting，
     摘要取 startedAt 最新一条的 trigger，42 字截断）—— 两页左栏显示同一个数。 */
  function sessionStatsByChat() {
    var map = {};
    try {
      var arr = (typeof state !== 'undefined' && state.sessions) || [];
      for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        if (!s || !s.chatKey) continue;
        var g = map[s.chatKey];
        if (!g) g = map[s.chatKey] = { total: 0, active: 0, last: '', newest: -1 };
        g.total++;
        if (s.status === 'running' || s.status === 'waiting') g.active++;
        var t = Number(s.startedAt) || 0;
        if (t > g.newest) {
          g.newest = t;
          g.last = String(s.trigger || s.triggerSummary || '').replace(/\s+/g, ' ').trim().slice(0, 42);
        }
      }
    } catch (e) { /* state 还没就绪 → 全 0，别抛 */ }
    return map;
  }

  /* 搜索命中：名称 / chatKey / 最近摘要（同 15-chat-chrome.js fillLeft 里的 hit）。 */
  function setupHit(it, stats, q) {
    if (!q) return true;
    var g = stats[it.key];
    var hay = chatShortLabel(it.key) + ' ' + it.key + ' ' + (g ? g.last : '');
    return hay.toLowerCase().indexOf(q) >= 0;
  }

  /* 一行会话 = 与「会话选择」页左栏 chatRow 同款排布（R131：用户要求两页一致）：
     [头像] [名称 + 最近会话摘要] [计数胶囊]。
     本页专属的两枚标记不破坏主排布：「未加白名单」折进摘要行末；
     「已设人设」仍是右侧第二颗胶囊（r95 语义保留）。 */
  function setupChatRowHtml(it, stats) {
    var g = stats[it.key] || { total: 0, active: 0, last: '' };
    var pill = g.active
      ? '<span class="cc-pill cc-running">' + g.active + ' 个进行中</span>'
      : '<span class="cc-pill cc-gray">' + g.total + ' 个会话</span>';
    var sub = g.last;
    if (!it.inAllow) sub = (sub ? sub + ' · ' : '') + '未加白名单';
    if (!sub) sub = '—';
    return '<div class="bp-row chat-row' + (it.key === setupChat && setupView === 'chat' ? ' on' : '') +
      '" type="button" role="button" tabindex="0" data-setup-chat="' + escH(it.key) + '" title="' +
      escH(chatLabel(it.key)) + '">' +
      setupAvatarHtml(it.key, chatShortLabel(it.key)) +
      '<span class="bp-rl"><span class="bp-rt">' + escH(chatShortLabel(it.key)) + '</span>' +
      '<span class="bp-ri">' + escH(sub) + '</span></span>' +
      pill +
      (hasPersonaOwn(it.key) ? '<span class="cc-pill cc-gray">已设人设</span>' : '') +
      '</div>';
  }

  /* 会话清单段 = 分区头（含计数与 + 钮）+ 行容器（含空态）。搜索时只重渲染这一段。 */
  function setupChatSegHtml(list) {
    var stats = sessionStatsByChat();
    var shown = list.filter(function (it) { return setupHit(it, stats, setupQ); });
    var h = '<div class="bp-sec bp-sec-row"><span>选择会话</span>' +
      '<span class="cc-cnt" id="bp-cnt">' + (list.length ? list.length + ' 个' : '') + '</span>' +
      // r60：+ 添加会话（用户要求在这一页直接加群聊/私聊）—— 弹窗见 openAddChatModal
      '<button class="bp-add" id="bp-add-chat" type="button" title="添加群聊 / 私聊" aria-label="添加群聊 / 私聊">' +
      '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.2v7.6M1.2 5h7.6"/></svg></button></div>';
    if (!list.length) {
      // 白名单与会话列表都空：指条路（设置 → 聊天）
      h += '<div class="su-empty">白名单为空 —— 先去「设置 → 聊天」把群 / 好友加进来。</div>';
    } else {
      h += '<div id="bp-rows">' +
        (shown.length
          ? shown.map(function (it) { return setupChatRowHtml(it, stats); }).join('')
          : '<div class="bp-empty">没有匹配的会话</div>') +
        '</div>';
    }
    return h;
  }

  /* 搜索框两枚图标 —— 与 15-chat-chrome.js 左栏搜索框逐字符相同
     （那边的常量在它自己的 IIFE 里，跨不过来说明显式复制一份）。 */
  var ICON_MAG = 'M675.9168 242.816C556.3008 123.2 362.4448 123.2 242.8288 242.816 123.2128 362.432 123.2128 556.288 ' +
    '242.8288 675.904 362.4448 795.52 556.3008 795.52 675.9168 675.904 795.5328 556.288 795.5328 362.432 675.9168 ' +
    '242.816L675.9168 242.816ZM1000.7168 892.48C1030.6048 922.368 1030.6048 970.816 1000.7168 1000.704 ' +
    '970.8288 1030.656 922.3808 1030.656 892.4288 1000.704L730.0608 838.336C728.1408 836.416 727.4368 833.92 ' +
    '725.7728 831.872 546.3168 960.448 295.7568 945.408 134.5408 784.192-44.8512 604.8-44.8512 313.92 ' +
    '134.5408 134.528 313.9328-44.864 604.8128-44.864 784.2048 134.528 945.4208 295.744 960.4608 546.304 ' +
    '831.8848 725.76 833.9328 727.424 836.4288 728.128 838.3488 730.048L1000.7168 892.48Z';
  var ICON_X = 'M2,0 L0,2 8,10 0,18 2,20 10,12 18,20 20,18 12,10 20,2 18,0 10,8 2,0Z';

  function renderSetupNav() {
    var left = $('#bp-setup-left');
    if (!left) return;
    var list = setupChatList();
    // R131：搜索框 —— 与「会话选择」页左栏同款（.bp-search + sticky 挡板，
    // 样式见 style.css 的 #bp-setup-left .bp-search-wrap 两条）。
    var h = '<div class="bp-search-wrap" id="bp-q-wrap">' +
      '<div class="bp-search">' +
      '<svg class="bp-mag" viewBox="0 0 1040 1040" aria-hidden="true"><path d="' + ICON_MAG + '"/></svg>' +
      '<input id="bp-q" type="text" placeholder="搜索会话" maxlength="50" autocomplete="off" aria-label="搜索会话" value="' + escH(setupQRaw) + '">' +
      '<button class="bp-clear" id="bp-q-clear" type="button" title="清空" aria-label="清空" data-show="' + (setupQ ? '1' : '0') + '">' +
      '<svg viewBox="0 0 20 20"><path d="' + ICON_X + '" fill="currentColor" stroke="none"/></svg></button>' +
      '</div></div>';
    // ── 段顺序：扩展 → 会话清单 → 全部设置 ──────────────────────────────
    // 2026-10-22：**「扩展」从会话清单下方挪到上方**。会话选择页左栏是
    // 「页面导航在上、会话清单在下」，而这边原来反过来（清单在上、扩展在下），
    // 两个左栏同一屏看过去结构不一致 —— 用户拿两张截图指出后统一到"导航在上"。
    // 「全部设置」仍留在最底：它是次要出口，不该压在日常要点的东西上面。
    //
    // r95：本机已安装的技能 / 插件 —— 带开关的列表就出在右栏（PCL「版本设置 → Mod 管理」）。
    // 2026-10-22：加「人设」。技能/插件管的是开关，人设管的是"用哪一个"，
    // 三者都是"本机已装的东西"，所以同列在「扩展」段。
    h += '<div class="bp-sec">扩展</div>' +
      extEntryHtml('skill', '技能', SUB_ICON.skills) +
      extEntryHtml('plugin', '插件', SUB_ICON.plugins) +
      extEntryHtml('persona', '人设', SUB_ICON.personas);
    h += setupChatSegHtml(list);
    h += '<div class="bp-sec">全部设置</div>' +
      '<button class="bp-act" type="button" data-setup-all="1">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + SUB_ICON.settings +
      '" stroke-linejoin="round" stroke-linecap="round"/></svg>' +
      '<span>打开完整设置页</span></button>';
    left.innerHTML = h;
  }

  /* 打字时的轻量刷新（R131）：只换行容器，搜索框本身不重建 —— 焦点与光标不丢。
     #bp-rows 不存在（清单全空、连行容器都没建）时退回全量重画。 */
  function applySetupFilter() {
    var rows = $('#bp-rows');
    if (!rows) { renderSetupNav(); return; }
    var stats = sessionStatsByChat();
    var shown = setupChatList().filter(function (it) { return setupHit(it, stats, setupQ); });
    rows.innerHTML = shown.length
      ? shown.map(function (it) { return setupChatRowHtml(it, stats); }).join('')
      : '<div class="bp-empty">没有匹配的会话</div>';
  }

  /* ── 右栏：本会话的专属设置 ─────────────────────────────────────
     只放"能按单个会话覆盖"的项。每一项的写入都直接 POST /api/config 的对应
     子树，保存后回写 state.config 并就地重渲染（不整页重拉）。 */
  function renderSetupPane() {
    var box = $('#bp-setup-scroll');
    if (!box) return;
    // r95：左栏点了「技能 / 插件」→ 右栏借这块滚动区渲染本机列表。
    // 渲染复用「下载 → 技能 / 插件」那一套（renderModulePage），compact 模式：
    //   只出「标题 + 计数 + 状态筛选 + 卡片」，不出「去市场 / ＋添加 / 刷新」——
    //   那几颗钮带全局唯一 id，而 #view-skills / #view-plugins 一直挂在 DOM 里，
    //   再来一份同 id 的 DOM 会让 $() 只认先出现的那一个，另一份变成哑按钮。
    if (setupView !== 'chat') {
      setSetupCrumb(setupView);
      // 人设走另一套渲染：数据源是 /api/persona-templates，不是 /api/skills，
      // 而且它没有 renderModulePage 那套卡片（人设是单选、不是开关型模块）。
      // 复用 19-personas.js 的 loadPersonasPage，传 box 指到右栏、compact 去掉尾注。
      if (setupView === 'persona') {
        if (typeof loadPersonasPage === 'function') {
          // 数据回来后左栏那一条的计数（N 个 · 1 使用中）也要跟着更新
          Promise.resolve(loadPersonasPage({ box: box, compact: true }))
            .then(function () { if (setupView === 'persona') renderSetupNav(); })
            .catch(function () { /* 失败时右栏自己会显示错误态 */ });
        } else {
          box.innerHTML = '<div class="su-empty-lg">人设列表加载失败：loadPersonasPage 不可用。</div>';
        }
        return;
      }
      if (typeof renderModulePage === 'function') renderModulePage(setupView, box, { compact: true });
      else box.innerHTML = '<div class="su-empty-lg">本地管理页加载失败：renderModulePage 不可用。</div>';
      refreshSetupExt(setupView);
      return;
    }
    setSetupCrumb('');
    var key = setupChat;
    if (!key) {
      box.innerHTML = '<div class="su-empty-lg">← 左侧选一个会话，这里显示它的专属设置</div>';
      return;
    }
    var c = cfgNow();
    var k = splitKey(key);
    var isGroup = k.kind === 'group';
    var inAllow = !!allowMapOf()[key];   // r60：归一化比对（裸号白名单 vs 带前缀 chatKey）

    // ① 白名单
    var allowCard =
      '<section class="su-card">' +
      '<h3>参与白名单</h3>' +
      '<div class="checkbox-row"><input type="checkbox" class="sw" id="su-allow"' + (inAllow ? ' checked' : '') + ' />' +
      '<label for="su-allow">机器人参与这个会话</label></div>' +
      '<div class="hint">关闭 = 从白名单移除：这个会话里的消息不再存档、不触发回复。"白名单为空时允许所有会话"若开着，移除后仍会被其它规则放行 —— 那一条在「设置 → 聊天」里。</div>' +
      '</section>';

    // ② 人设覆盖
    var pc = personaConfOf(key);
    var own = hasPersonaOwn(key);
    var LBL = { low: '安静型', medium: '普通群友', high: '活跃型' };
    var gPart = (c.persona || {}).participation || 'medium';
    var partNow = pc.participation
      ? escH(LBL[pc.participation] || pc.participation) + ' <span class="su-tag">本会话单独</span>'
      : escH(LBL[gPart] || gPart) + ' <span class="su-tag su-tag-off">跟随全局</span>';
    var roleNow = pc.roleText
      ? escH(String(pc.roleText).slice(0, 60)) + (String(pc.roleText).length > 60 ? '…' : '')
      : '<span class="su-none">跟随全局人设</span>';
    var extras = [];
    if (pc.customRules) extras.push('附加规则');
    if (pc.systemPromptOverride) extras.push('系统提示覆盖');
    var personaCard =
      '<section class="su-card">' +
      '<h3>人设覆盖</h3>' +
      (own ? '<div class="hint" style="margin-bottom:8px">本会话已单独设置人设（左栏那颗圆点就是它）。</div>'
           : '<div class="hint" style="margin-bottom:8px">本会话没有独立人设，当前跟随全局。</div>') +
      '<div class="su-kv"><span class="su-k">参与度</span><span class="su-v">' + partNow + '</span></div>' +
      '<div class="su-kv"><span class="su-k">角色设定</span><span class="su-v">' + roleNow + '</span></div>' +
      (extras.length ? '<div class="su-kv"><span class="su-k">另含</span><span class="su-v">' + escH(extras.join(' / ')) + '</span></div>' : '') +
      '<div class="su-acts">' +
      '<button class="btn btn-small" id="su-persona-edit">✎ 编辑本会话人设</button>' +
      (own ? '<button class="btn btn-small" id="su-persona-clear">清除独立人设（回到跟随全局）</button>' : '') +
      '</div></section>';

    // ③ 响应档位（仅群聊；私聊永远跟随全局，后端 storeConfigForChat 里写死了）
    //    r35 起只做「看状态 + 就地入口」：编辑（拖档位 / 峰谷 / 清除单独设置）
    //    统一收进「活跃设置」弹窗 —— 原先这里的下拉框与弹窗滑条改的是同一份
    //    groupSliderPos[群号]，两套控件两种交互，正是用户指出的重复。
    var eff = effectiveTierOf(key);
    var tierCard = '';
    if (isGroup) {
      var tagNow = eff.own
        ? ' <span class="su-tag">本群单独</span>'
        : ' <span class="su-tag su-tag-off">跟随全局</span>';
      var modeHint = eff.unified
        ? '现在是「统一档位」模式：全部群聊共用一个档位。要改成按群单独拖（含峰谷 / 指令禁言），打开下面的「活跃设置」。'
        : (eff.peakOn
          ? '⚠️ 峰谷切换开着：本群档位按「高峰 / 低谷」两个点走 —— 拖动与两点都在下面的「活跃设置」里调。'
          : '要单独拖动本群档位（或清除单独设置），用下面的「活跃设置」。');
      tierCard =
        '<section class="su-card">' +
        '<h3>响应档位</h3>' +
        '<div class="su-kv"><span class="su-k">当前生效</span><span class="su-v">' +
        eff.tier + ' 档 · ' + escH(TIER_TEXT[eff.tier] || '') + tagNow +
        '</span></div>' +
        '<div class="hint">' + modeHint + '</div>' +
        '<div class="su-acts"><button class="btn btn-small" id="su-active-config">⚡ 活跃设置（档位 / 峰谷 / 全部群）</button></div>' +
        '</section>';
    }

    // ④ 指令禁言（仅群聊）
    var mut = muteStateOf(key);
    var muteCard = '';
    if (isGroup && mut.applicable) {
      var mTxt, mCls;
      if (mut.muted && mut.manual) { mTxt = '已禁言 —— 直到手动解除'; mCls = 'su-tag'; }
      else if (mut.muted) {
        var mins = Math.max(1, Math.round((mut.until - Date.now()) / 60000));
        mTxt = '已禁言 —— 约 ' + mins + ' 分钟后自动解除'; mCls = 'su-tag';
      } else { mTxt = '未禁言'; mCls = 'su-tag-off'; }
      muteCard =
        '<section class="su-card">' +
        '<h3>指令禁言</h3>' +
        '<div class="su-kv"><span class="su-k">状态</span><span class="su-v">' + escH(mTxt) +
        ' <span class="su-tag ' + mCls + '">' + (mut.muted ? '生效中' : '正常') + '</span></span></div>' +
        '<div class="hint">群成员发指令（默认 <code>/安静</code>）可临时把本群压到 1 档仅艾特。' +
        '指令与时长在「活跃设置」弹窗里改（上面响应档位卡的 ⚡ 按钮）。</div>' +
        (mut.muted ? '<div class="su-acts"><button class="btn btn-small" id="su-mute-clear">解除本群禁言</button></div>' : '') +
        '</section>';
    }

    // ⑤ 群成员屏蔽名单（仅群聊）
    var blockCard = '';
    if (isGroup) {
      var n = blockedCountOf(key);
      blockCard =
        '<section class="su-card">' +
        '<h3>群成员屏蔽名单</h3>' +
        '<div class="su-kv"><span class="su-k">已屏蔽</span><span class="su-v">' +
        n + ' 人' + (n ? '' : ' <span class="su-tag su-tag-off">名单为空</span>') + '</span></div>' +
        '<div class="hint">被屏蔽成员的消息不存档、不触发回复、不进提示词背景。名单按群单独保存。</div>' +
        '<div class="su-acts"><button class="btn btn-small" id="su-blocklist">管理屏蔽名单</button></div>' +
        '</section>';
    }

    var head =
      '<div class="su-head">' +
      '<div class="su-name">' + escH(chatLabel(key)) + '</div>' +
      '<div class="su-meta">' + escH(key) + ' · ' + (isGroup ? '群聊' : '私聊') +
      ' · ' + (inAllow ? '在白名单' : '未加白名单') + '</div>' +
      '</div>';

    box.innerHTML = head + allowCard + personaCard + tierCard + muteCard + blockCard;
  }

  /* ── 会话设置：事件委托（绑在长期容器上，内容随 innerHTML 重建不丢）── */
  var suPane = $('#bp-setup-scroll');
  var suLeft = $('#bp-setup-left');
  suLeft && suLeft.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#bp-add-chat')) {
      openAddChatModal();
      return;
    }
    // R131：搜索框的清空钮（×）
    if (e.target.closest && e.target.closest('#bp-q-clear')) {
      var qi = $('#bp-q');
      if (qi) { qi.value = ''; qi.focus(); }
      setupQ = ''; setupQRaw = '';
      var qc = $('#bp-q-clear');
      if (qc) qc.dataset.show = '0';
      applySetupFilter();
      return;
    }
    // r95：「技能 / 插件」两条 —— 点开 = 右栏换成那一类的本机列表；
    // 再点一次同一条（或改点任一会话）退回按会话的设置。
    var ex = e.target.closest && e.target.closest('[data-setup-ext]');
    if (ex) {
      var want = ex.dataset.setupExt;
      setupView = (setupView === want) ? 'chat' : want;
      renderSetupNav();
      renderSetupPane();
      return;
    }
    var b = e.target.closest && e.target.closest('[data-setup-chat]');
    if (b) {
      setupChat = b.dataset.setupChat;
      setupView = 'chat';
      renderSetupNav();
      renderSetupPane();
    }
  });
  // R131：搜索输入 —— 只重画清单段（搜索框不重建，打字不丢焦点）
  suLeft && suLeft.addEventListener('input', function (e) {
    if (!e.target || e.target.id !== 'bp-q') return;
    setupQRaw = String(e.target.value || '');
    setupQ = setupQRaw.trim().toLowerCase();
    var qc2 = $('#bp-q-clear');
    if (qc2) qc2.dataset.show = setupQ ? '1' : '0';
    applySetupFilter();
  });
  // 2026-10-23 修复：会话行（setupChatRowHtml 里是 role="button" + tabindex="0"）此前
  //   只有 click 委托 —— 键盘能 Tab 到、按回车没反应，等于键盘用户进不去任何会话。
  //   焦点必须在行本身；直接 click() 复用上面那条委托的全部分支。
  suLeft && suLeft.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('bp-row')) return;
    e.preventDefault();
    t.click();
  });
  // 头像加载失败 → 揭开首字兜底（捕获：error 不冒泡；容器长期存在，绑一次即可）
  suLeft && suLeft.addEventListener('error', function (e) {    var im = e.target;
    if (!im || im.tagName !== 'IMG' || !im.classList.contains('av-img')) return;
    var box = im.parentNode;
    var fb = box && box.querySelector('.av-fb');
    im.style.display = 'none';
    if (fb) fb.hidden = false;
  }, true);

  /* ── 「+ 添加会话」弹窗（r60；r62 加「拉取群聊」）─────────────────
     照「活跃设置」弹窗同款外壳（modelModalShell，遮罩层号 910 —— 现由
     style.css 0.5 段的 --z-model-modal-overlay 统一给值，盖过 #bigpage 的 60）：
     类型选群聊/私聊 + 纯数字 ID，落白名单裸号。
     r62：ID 右侧多一个「拉取群聊 / 拉取好友」按钮 —— 调 GET /api/onebot/groups
     （私聊走 /api/onebot/friends）把机器人已加入的列表拉下来，选一个即回填 ID，
     省掉手抄群号。机器人没连上时后端返 502，这里降级成一行提示，手动填号照旧可用。
     保存 = POST /api/config {allow:{groups|private:{__replace__:[...]}}}
     （数组必须整体替换，deepMerge 对数组是覆盖不是拼接）。 */
  function openAddChatModal() {
    var overlay = modelModalShell({
      head: '添加会话',
      body:
        '<div class="field"><label>类型</label>' +
        '<select id="bp-add-kind"><option value="group">群聊</option><option value="private">私聊</option></select></div>' +
        '<div class="field"><label id="bp-add-id-label">群号</label>' +
        '<div class="bp-add-row">' +
        '<input type="text" id="bp-add-id" inputmode="numeric" placeholder="只填数字，如 123456789" />' +
        '<button class="btn btn-small" id="bp-add-pull" type="button">拉取群聊</button>' +
        '</div></div>' +
        '<div id="bp-add-pick"></div>' +
        '<div class="hint">可以直接「拉取群聊」从机器人已加入的群里选，也可以手动填号。' +
        '添加后自动加入白名单并选中。会话名称会在机器人收到该会话的消息后自动带出。</div>',
      foot:
        '<button class="btn" id="bp-add-cancel" type="button">取消</button>' +
        '<button class="btn btn-primary" id="bp-add-ok" type="button">添加</button>'
    });
    var kindSel = overlay.querySelector('#bp-add-kind');
    var idLabel = overlay.querySelector('#bp-add-id-label');
    var idIn = overlay.querySelector('#bp-add-id');
    var pullBtn = overlay.querySelector('#bp-add-pull');
    var pickBox = overlay.querySelector('#bp-add-pick');
    function isPrivate() { return kindSel.value === 'private'; }
    function pullLabel() { return isPrivate() ? '拉取好友' : '拉取群聊'; }
    kindSel.addEventListener('change', function () {
      idLabel.textContent = isPrivate() ? 'QQ 号' : '群号';
      idIn.placeholder = isPrivate() ? '只填数字，如 10001' : '只填数字，如 123456789';
      // 切类型后旧列表作废（群 ≠ 好友），按钮文案跟着回位
      pickBox.innerHTML = '';
      pullBtn.textContent = pullLabel();
    });
    pullBtn.addEventListener('click', function () {
      var isP = isPrivate();
      var ep = isP ? '/api/onebot/friends' : '/api/onebot/groups';
      var key = isP ? 'friends' : 'groups';
      var unit = isP ? '好友' : '群';
      var field = isP ? 'private' : 'groups';
      pullBtn.disabled = true; pullBtn.textContent = '拉取中…';
      api(ep).then(function (d) {
        var list = ((d && d[key]) || []).map(function (g) {
          return { id: String(g.id), name: String(g.name || g.id) };
        }).filter(function (g) { return /^\d+$/.test(g.id); });
        if (!list.length) {
          pickBox.innerHTML = '<div class="hint" style="color:var(--orange)">没有拉到任何' + unit +
            '（机器人上报的' + unit + '列表是空的）。</div>';
          return;
        }
        // 已在白名单的标出来并禁选，避免"选了却发现重复"
        var seen = {}, wl = [];
        (((cfgNow().allow || {})[field]) || []).map(bareIdOf).map(String).forEach(function (x) {
          if (!seen[x]) { seen[x] = 1; wl.push(x); }
        });
        var opts = list.map(function (g) {
          var has = wl.indexOf(g.id) >= 0;
          return '<option value="' + escH(g.id) + '"' + (has ? ' disabled' : '') + '>' +
            escH(g.name) + ' · ' + escH(g.id) + (has ? '（已添加）' : '') + '</option>';
        }).join('');
        pickBox.innerHTML =
          '<div class="field"><label>' + unit + '列表（共 ' + list.length + ' 个）</label>' +
          '<select id="bp-add-pick-sel"><option value="">— 从列表里选一个 —</option>' + opts + '</select></div>';
        pickBox.querySelector('#bp-add-pick-sel').addEventListener('change', function (e) {
          if (e.target.value) { idIn.value = e.target.value; idIn.focus(); }
        });
      }).catch(function (err) {
        var msg = (err && err.message) ? err.message : String(err);
        pickBox.innerHTML = '<div class="hint" style="color:var(--red)">拉取失败：' + escH(msg) +
          '<br />机器人可能没连上 OneBot（没上报' + unit + '列表）。手动填号一样能添加。</div>';
      }).then(function () {
        pullBtn.disabled = false; pullBtn.textContent = pullLabel();
      }).catch(function () { /* r108：兜底自检 unhandledRejection —— 按钮状态在 then 内已恢复 */ });
    });
    overlay.querySelector('#bp-add-cancel').addEventListener('click', function () { closeModelModal(overlay); });
    var okBtn = overlay.querySelector('#bp-add-ok');
    okBtn.addEventListener('click', function () {
      var id = String(idIn.value || '').trim();
      if (!/^\d{4,}$/.test(id)) { suAlert('请输入正确的数字 ID（群号 / QQ 号，只填数字）'); return; }
      var kind = kindSel.value === 'private' ? 'private' : 'group';
      var field = kind === 'private' ? 'private' : 'groups';   // 白名单字段名（后端 allow.groups/private）
      var seenA = {}, cur = [];
      (((cfgNow().allow || {})[field]) || []).map(bareIdOf).map(String).forEach(function (x) {
        if (!seenA[x]) { seenA[x] = 1; cur.push(x); }
      });
      if (cur.indexOf(id) >= 0) {
        suAlert('这个' + (kind === 'private' ? 'QQ 号' : '群号') + '已经在列表里了');
        return;
      }
      var patch = { allow: {} };
      patch.allow[field] = { __replace__: cur.concat([id]) };
      okBtn.disabled = true;
      suSave(patch).then(function () {
        setupChat = kind + ':' + id;   // chatKey 前缀是 group/private，不是字段名 groups
        closeModelModal(overlay);
        renderSetupNav();
        renderSetupPane();
      }).catch(function (err) {
        okBtn.disabled = false;
        suAlert('保存失败：' + (err && err.message ? err.message : err));
      });
    });
    idIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); } });
  }
  suPane && suPane.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'su-allow') {
      var on = t.checked;
      setAllowState(on).then(function () { renderSetupNav(); renderSetupPane(); })
        .catch(function (err) { t.checked = !on; suAlert('保存失败：' + (err && err.message ? err.message : err)); });
    }
    // r35：#su-tier 下拉框已移除 —— 档位编辑统一走「活跃设置」弹窗（su-active-config）
  });
  suPane && suPane.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'su-persona-edit') {
      // 复用全局页那套「会话人设」弹窗（自己 POST 落盘），不在这里重写一份保存逻辑
      try { if (typeof openPerChatPersonaModal === 'function') openPerChatPersonaModal(setupChat); }
      catch (err) { suAlert('打开人设弹窗失败：' + (err && err.message ? err.message : err)); }
    } else if (t.id === 'su-persona-clear') {
      clearPersonaOwn().then(function () { renderSetupNav(); renderSetupPane(); })
        .catch(function (err) { suAlert('清除失败：' + (err && err.message ? err.message : err)); });
    } else if (t.id === 'su-active-config') {
      // r35：带上当前群 —— 弹窗分群模式下直接聚焦它，不用再在群列表里点一次
      try {
        if (typeof openActiveConfigModal === 'function') {
          var fk = splitKey(setupChat);
          openActiveConfigModal({ focusGid: fk && fk.kind === 'group' ? fk.id : '' });
        }
      }
      catch (err) { suAlert('打开失败：' + (err && err.message ? err.message : err)); }
    } else if (t.id === 'su-mute-clear') {
      clearMute().then(function () { renderSetupPane(); })
        .catch(function (err) { suAlert('解除失败：' + (err && err.message ? err.message : err)); });
    } else if (t.id === 'su-blocklist') {
      try { if (typeof openBlocklistModal === 'function') openBlocklistModal(); }
      catch (err) { suAlert('打开失败：' + (err && err.message ? err.message : err)); }
    }
  });

  /* ── 会话设置的三个写操作（都用 __replace__ 整体替换，否则 deepMerge 删不掉旧键）── */
  function setAllowState(on) {
    var c = cfgNow(), k = splitKey(setupChat);
    var field = k.kind === 'private' ? 'private' : 'groups';
    // r60：读出来归一化成裸号（顺带清历史遗留的带前缀键），写回也落裸号 ——
    // 后端 allowed() 只认裸号，写入 group:xxx 等于没加白名单。
    var seenA = {}, arr = [];
    (((c.allow || {})[field]) || []).map(bareIdOf).map(String).forEach(function (x) {
      if (!seenA[x]) { seenA[x] = 1; arr.push(x); }
    });
    arr = arr.filter(function (x) { return x !== String(k.id); });
    if (on) arr.push(String(k.id));
    var patch = { allow: {} };
    patch.allow[field] = { __replace__: arr };
    return suSave(patch);
  }
  // r35：setGroupTier() 已随档位下拉框一并移除 —— 档位写入由「活跃设置」弹窗
  // 的保存逻辑负责（09-community.js openActiveConfigModal 的 #ac-save）。
  function clearMute() {
    var c = cfgNow(), k = splitKey(setupChat);
    var next = {};
    Object.keys((c.commandMute || {}).active || {}).forEach(function (g) {
      if (g !== k.id) next[g] = c.commandMute.active[g];
    });
    return suSave({ commandMute: { active: { __replace__: next } } });
  }
  function clearPersonaOwn() {
    var c = cfgNow(), k = splitKey(setupChat);
    var next = {};
    Object.keys(c.personaByChat || {}).forEach(function (g) {
      if (g !== k.id && g !== setupChat) next[g] = c.personaByChat[g];
    });
    return suSave({ personaByChat: { __replace__: next } });
  }

  function openBigPage(mode) {
    if (!bigpage) return;
    bpMode = mode === 'setup' ? 'setup' : 'chat';
    bigpage.hidden = false;
    // 2026-10-23 修复（回归）：这里原先是 remove/add `bp-in` 类做淡入 —— 但 `.bp-in`
    // 是批量价格弹窗的输入框类（见 04-usage.css 的 `.bp-in { width: 74px; padding: 4px 6px }`），
    // 类名撞车后全屏页被压成 **74px 宽**（用户截图：点「会话选择」只剩左栏一条，
    // 右侧露出会话首页的更新报告）。
    // 现在改用 WAAPI 播入场：不碰 class、不触发 15-chat-chrome 的 class MutationObserver。
    // 同时清掉可能残留的 bp-in，避免旧类继续压宽度。
    bigpage.classList.remove('bp-in');
    // 2026-11-04（R187）治「顶栏闪一下」：淡入**只播 .bp-body**，不播整个 #bigpage。
    //   根因：style.css 的 `.app-shell:has(> #bigpage:not([hidden])) > #topbar
    //   { visibility:hidden }` 在 hidden 摘掉的同一帧就把真顶栏藏掉，而旧写法
    //   `bigpage.animate(opacity 0→1)` 让替代顶栏的 .bp-head 也从 0 淡入 ——
    //   顶栏位置先空一帧、再慢慢浮现，用户看到的就是"顶栏闪一下/重建"。
    //   标题条不参与淡入（首帧就是 100% 不透明），换装零空帧；下方内容区照旧淡入。
    try {
      var bpBody = bigpage.querySelector('.bp-body');
      if (bpBody && bpBody.animate) {
        bpBody.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'cubic-bezier(.22, 1, .36, 1)' });
      }
    } catch { /* 不支持 WAAPI 就硬切 */ }
    bigpage.classList.toggle('mode-chat', bpMode === 'chat');
    bigpage.classList.toggle('mode-setup', bpMode === 'setup');
    var chat = $('#bp-mode-chat'), setup = $('#bp-mode-setup');
    if (chat) chat.hidden = bpMode !== 'chat';
    if (setup) setup.hidden = bpMode !== 'setup';

    if (bpMode === 'chat') {
      $('#bp-title') && ($('#bp-title').textContent = '会话选择');
      $('#bp-crumb') && ($('#bp-crumb').textContent = '左栏选会话 · 右栏看完整过程');
    } else {
      $('#bp-title') && ($('#bp-title').textContent = '会话设置');
      setSetupCrumb('');
      // r95：每次打开这一页都回到「按会话」—— 上次停在「技能」不留着，
      //      这一页的默认身份仍是"这个会话的设置"。
      setupView = 'chat';
      // ⚠️ r33 起**不再借用** #settings-form：这一页有自己的按会话内容（renderSetupPane），
      //     #settings-form 留在 #view-settings 原地，导航栏「设置」页随时可用、两页互不干扰。
      //     首选会话：上次选过的沿用，否则白名单第一个（都由左栏列表里切换）。
      var list = setupChatList();
      var keys = list.map(function (x) { return x.key; });
      if (keys.indexOf(setupChat) < 0) setupChat = keys[0] || '';
      renderSetupNav();
      renderSetupPane();
    }
  }

  function closeBigPage() {
    if (!bigpage) return;
    bpMode = '';
    bigpage.hidden = true;
    bigpage.classList.remove('mode-chat', 'mode-setup');
  }

  /* r95：关掉全屏页 → 切到指定的一级页。**两步之间必须隔一拍。**
     15-chat-chrome.js 的 sync() 挂在 #bigpage 的 hidden / class 变化上（MutationObserver），
     它会在微任务里把 tab 还原成"打开全屏页之前那一页"（那个文件里的 bpPrevSub）。
     同一 tick 里紧跟的 switchTab 会被它当场顶掉 —— 实测（r95）：
       ·「打开完整设置页」点完停在会话首页，设置页根本没进去；
       · 新加的「打开完整管理页」同理。
     放进 setTimeout（宏任务，永远排在 MutationObserver 的微任务之后）就落到它后面，
     落点才是我们要的那一页。 */
  function closeBigPageThen(tab) {
    closeBigPage();
    setTimeout(function () {
      try { if (typeof switchTab === 'function') switchTab(tab); } catch (e) { /* 忽略 */ }
    }, 0);
  }
  // 06-settings-render.js 的「打开完整管理页」要走同一条路径（跨文件的私有函数只能这么给）
  window.closeBigPageThen = closeBigPageThen;

  /* 2026-10-23 修复：给 02-sse-sessions.js 的 chat-update 一个刷新「会话设置」右栏的入口。
     群内发 /安静 改的是禁言态，右栏卡片不重绘就会一直显示「未禁言」——
     用户以为指令没生效（02:90-93 的注释就是为这件事写的，但那段判断引用的是
     setupChat / renderSetupPane，两者都是本 IIFE 私有的，typeof 恒为 undefined，
     所以从来没有真的执行过）。

     内部自己判「当前是不是会话设置模式、有没有选中会话」，不在该状态时是空操作，
     调用方不需要知道这些细节。 */
  window.refreshSetupPane = function () {
    try {
      if (!bigpage || bigpage.hidden) return;
      if (!bigpage.classList.contains('mode-setup')) return;
      if (setupView !== 'chat' || !setupChat) return;
      renderSetupPane();
    } catch (e) { /* 右栏渲染失败不该拖累 SSE 回调 */ }
  };

  bigpage && $('#bp-back') && $('#bp-back').addEventListener('click', closeBigPage);
  bpWindowBtns();
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && bigpage && !bigpage.hidden) {
      // 设置页里 Esc 有别的用途（收起下拉等），只在没有别的处理器消费时关页。
      if (e.defaultPrevented) return;
      closeBigPage();
    }
  });
  bigpage && bigpage.addEventListener('click', function (e) {
    // ⚠️ 会话设置页的按会话交互（选会话 / 各块按钮）由 suPane / suLeft 上的
    //    委托处理，这里只管「打开完整设置页」这一条跨页跳转。
    if (e.target.closest && e.target.closest('[data-setup-all]')) {
      // r95：原先是 closeBigPage() + switchTab('settings') 同一 tick 连做 ——
      //      15-chat-chrome.js 的 sync() 随后把 tab 还原回"打开前那一页"，
      //      设置页根本进不去（实测停在会话首页）。改走隔一拍的版本。
      closeBigPageThen('settings');
    }
  });

  /* ══════════ 左栏交互 ══════════ */
  // 「开始对话」：r51 —— 机器人未运行时，这个按钮是 PCL 隐喻里的「启动游戏」：
  // 拉起机器人用的 QQ（协议端由用户自己装、自己启动，2026-10-23 起不再托管），
  // 进度写在副标题上，而不是直接跳会话界面。已连接时才保持旧行为（进全屏会话页并选中第一个）。
  // 启动节奏与设置页 quick-start-btn 保持一致。
  $('#launch-btn') && $('#launch-btn').addEventListener('click', async function () {
    var btn = this;
    if (btn.dataset.starting === '1') return;   // 启动中防重复点击
    delete btn.dataset.launchMsg;               // 清掉上一轮的粘性提示

    var sub = $('#launch-sub');
    var setSub = function (t) { if (sub) sub.textContent = t; };
    var enterChat = function () {
      openBigPage('chat');
      try {
        var list = $('#session-items');
        var first = list && list.querySelector('.session-item, [data-chat], [data-session]');
        var hasSel = list && list.querySelector('.active, .on, .sel');
        if (first && !hasSel && typeof first.click === 'function') first.click();
      } catch (e) { /* 选择失败就让用户自己在左栏点 */ }
    };

    // 先看机器人是否已在线：在线 → 这就是「开始对话」，保持旧行为
    var st = null;
    try { st = await api('/api/status'); } catch (e) { /* 探不到就当未连接走启动链 */ }
    if (st && st.onebot && st.onebot.connected) { enterChat(); return; }

    var qqReady = !!(st && st.qqPortable && st.qqPortable.ready);
    var qqRunning = !!(st && st.qqPortable && st.qqPortable.running);
    var protoUp = !!(st && st.protocol && st.protocol.portOpen);
    // r90：ready=false = 便携副本没装且本机也没检测到 QQ —— 旧的"去点一键安装"
    //   指引在这时候必然失败（没源可复制）。改成让人去装 QQ / 重新检测。
    // 2026-10-23：「连接与启动」分区已改名「连接 QQ」，指路文案跟着改口。
    if (!qqReady) { setSub('没找到可用的 QQ：先装一个新版 QQ（QQNT），然后到 设置 → 连接 QQ 重试'); return; }

    btn.dataset.starting = '1';
    btn.classList.add('is-starting');
    try {
      if (!qqRunning) {
        setSub('启动 QQ 中…（不会自动弹窗，稍候需登录）');
        var r1 = await api('/api/qq-portable/launch', { method: 'POST', body: '{}' });
        if (!r1 || (!r1.ok && !r1.alreadyRunning)) {
          throw new Error('QQ 启动失败' + (r1 && r1.error ? '：' + r1.error : ''));
        }
        await new Promise(function (r) { setTimeout(r, 3000); });
      }
      // 协议端不归我们启动：没在跑就直接说清楚，别让用户对着"等待"干等 5 分钟。
      if (!protoUp) {
        var st2 = null;
        try { st2 = await api('/api/status'); } catch (e) { /* 探不到按未运行处理 */ }
        protoUp = !!(st2 && st2.protocol && st2.protocol.portOpen);
      }
      if (!protoUp) {
        btn.dataset.launchMsg = 'QQ 已启动，但协议端没在运行 —— 到 工具 → 连接 页按指引启动 SnowLuma 或 NapCat';
        setSub(btn.dataset.launchMsg);
        return;
      }
      setSub('等待机器人上线…（首次登录要扫码，可能要一两分钟）');
      // ⚠️（2026-10-17）旧实现只等 **30 秒** 就报「连接超时」—— 而这 30 秒里用户
      //   很可能还没扫码登录（首次登录本来就要一两分钟）。小白看到"超时"就以为失败，
      //   回去再点一次，越点越乱。现在：最多等 5 分钟，每 ~16 秒把"在等什么、
      //   现在该做什么"写清楚。
      //   ⚠️ 与设置页 quick-start-btn 的等待节奏保持一致（两处是同一套启动链）。
      var WAIT_STEP = 2000;
      var WAIT_MAX = 5 * 60 * 1000;
      var connected = false;
      for (var waited = 0; waited < WAIT_MAX; waited += WAIT_STEP) {
        await new Promise(function (r) { setTimeout(r, WAIT_STEP); });
        var s2 = await api('/api/status').catch(function () { return null; });
        if (s2 && s2.onebot && s2.onebot.connected) { connected = true; break; }
        if (waited % 16000 < WAIT_STEP) {
          setSub(waited < 20000
            ? '等待机器人上线…（QQ 还没登录的话，把 QQ 窗口调出来扫码）'
            : '还在等机器人上线（已 ' + Math.round(waited / 1000) + ' 秒）—— 登录完成会自动连上，不用再点');
        }
      }
      if (connected) {
        // 粘性提示：refreshStatus 的重渲染会用 launchMsg 重建副标题（syncIdentity），
        // 否则「✓ 已连接」一闪就被会话名盖掉
        btn.dataset.launchMsg = '✓ 已连接，机器人运行中 —— 再点一次进入会话';
        setSub(btn.dataset.launchMsg);
        try { if (typeof refreshStatus === 'function') refreshStatus(); } catch (e) { /* ignore */ }
      } else {
        btn.dataset.launchMsg = '还没连上：多半是机器人 QQ 没登录 —— 登录后会自动连上；状态见 工具 → 连接';
        setSub(btn.dataset.launchMsg);
      }
    } catch (e) {
      setSub('启动失败：' + (e && e.message ? e.message : e));
    } finally {
      delete btn.dataset.starting;
      btn.classList.remove('is-starting');
    }
  });
  $('#view-btn') && $('#view-btn').addEventListener('click', function () { openBigPage('chat'); });
  $('#cfg-btn') && $('#cfg-btn').addEventListener('click', function () { openBigPage('setup'); });

  $('#avatar-refresh') && $('#avatar-refresh').addEventListener('click', function () {
    try { if (typeof refreshStatus === 'function') refreshStatus(); } catch (e) { /* ignore */ }
    syncIdentity();
  });

  // 二级导航点击（每次渲染后重新绑定 —— 内容是 innerHTML 重建的）
  sideNav && sideNav.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-sub],[data-usage-dim]');
    if (!el) return;
    if (el.dataset.sub && typeof switchTab === 'function') { switchTab(el.dataset.sub); return; }
    if (el.dataset.usageDim) {
      // 「今日」下按天没内容：不作无声跳转，也不改用户的选择
      if (el.getAttribute('aria-disabled') === 'true') return;
      usageDim = el.dataset.usageDim;
      applyUsageDim();
      var ubox = $('#usage-page');
      if (ubox) ubox.scrollTop = 0;      // 换了块就回到顶部（原型切块也是从头上看）
      // 三张图的测量宽度取决于容器当时可不可见（隐藏的块 clientWidth = 0）→
      // 切完必须让 04 原地重画一次。走的还是它那套「折叠/换指标」用的重绘，不重新请求接口。
      var args = (typeof state !== 'undefined' && state.usageRenderArgs) || null;
      if (args) { try { updateUsagePage(args.stats, args.st, args.prices); } catch (err) { /* ignore */ } }
    }
  });

  // 一级导航：点一级 → 进它的默认二级页。
  $$('#tabs .nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (bigpage && !bigpage.hidden) closeBigPage();
      var g = null;
      for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].key === btn.dataset.top) g = GROUPS[i];
      if (g && typeof switchTab === 'function') switchTab(g.home);
    });
  });

  // 会话首页的提示条（可关，记住选择）
  var HINT_KEY = 'qa.stageHintClosed';
  (function () {
    var box = $('#stage-hint');
    if (!box) return;
    var closed = false;
    try { closed = localStorage.getItem(HINT_KEY) === '1'; } catch (e) { /* 隐私模式 */ }
    if (closed) box.hidden = true;
    $('#stage-hint-close') && $('#stage-hint-close').addEventListener('click', function () {
      box.hidden = true;
      try { localStorage.setItem(HINT_KEY, '1'); } catch (e) { /* ignore */ }
    });
  })();

  /* ══════════ 会话首页的「更新报告」（r99-C）══════════
     用户诉求：「这个地方我希望可以放更新报告方便用户查看」。
     内容走**本地数据**（下面这个数组），不接线上更新检查 —— 离线也看得见，
     改完刷新界面即可，不用重新打包。

     ⚠️ 要改内容只改 STAGE_CHANGELOG：**新的放最前面**，数组第 1 条会带「最新」标记。
        字段：version 版本号（建议与 resources/app/package.json 的 version 对齐）
              date    日期 YYYY-MM-DD
              items   这次改了什么，一条一行，写给用户看（别写内部术语）
        数组清空 → 整块不渲染，.stage-empty 回到原来的居中布局。
     ⚠️ 卡片由本段自己 insertBefore 进 .stage-empty，**不动 index.html**。

     r106：① 位置从「视觉中心」改到「页面底部」（CSS 那边 margin 由 auto 0 改成 auto 0 0）；
           ② 卡片右上角加 × —— 关掉后把**当前最新那一版的 version** 写进 localStorage
              （qa.stageReportClosed）；下次启动版本号对得上就整块不渲染。
              换了新版本（改 STAGE_CHANGELOG 第 1 条的 version）→ 对不上 → 自动再出现一次。
              所以「按版本记住」的维护约定是：**要重新推给所有人，必须把 version 改成新号**；
              只改 items 而不动 version，已经关掉过的用户不会再看到。
              version 与 date 都为空的条目退化成「只在本次会话内关闭」，不写盘。

     r108：用户「更新报告的内容也更新一下」—— 0.4.7 这一版前后做了 30 多轮（R76~R108），
           而原 items 只覆盖到 R95~R100 那一段，明显过时（例：完全没有 R102 插件入口、
           R106 卡片可关闭、R107 设置页切换动画）。本轮把**整版**面向用户的改动汇总
           重写成下面 8 条：稳定性 / 全 App 动效 / 各界面左栏统一 / 插件入口 / 滚动性能 /
           输入框焦点 / 设置页切换动画 / 这张卡片自身。口径一律「用户能感知到什么」，
           不写内部术语（不写「左栏左右留白对齐」这类实现说法）。
           ⚠️ r108 只改了 items、version 没动；**0.4.8 发布时（r109）version 已顶到新号 0.4.8、
              date 同步刷新** —— 已经点过 × 的 0.4.7 用户会重新看到这版内容。 */
  var REPORT_KEY = 'qa.stageReportClosed';
  /* r109（2026-10-17）：本版所有改动 —— 含半夜从「洛版修复版」移植进来的那批、
     用量页崩溃、SnowLuma 注入链路五项、崩溃/卡死加固、记忆索引瘦身、默认开关固化 ——
     **统一归到 0.4.8.5，不另起新版本号**（用户明确要求"别乱升"）。
     原 0.4.8.6 条目已并入 0.4.8.5 的 items，date 同步改成 2026-10-17。
     ⚠️ 副作用（知情即可）：version 是「重新推给已关闭用户」的唯一开关，不升号 =
     点过 × 且存的正是 0.4.8.5 的人不会再看到。本机实测存的关闭标记是 0.4.7 → 不受影响。

     r133（2026-10-18）：0.4.8.6 **正式启用**（用户这次明确要求升到 0.4.8.6）。
     上一版被并进 0.4.8.5 的那批内容仍留在 0.4.8.5 条目里不动，不重复搬。
     本条只放 2026-10-18 当天的改动：使用引导（OOBE）、错误本地化真正接上、
     Ctrl+V 一族、模型管理时序、默认人设重写、系统提示瘦身、就绪圆点缩写、
     市场装扩展警告、以及悬停出两个提示窗口的修复。
     ⚠️ 升号后，点过 × 且存的正是 0.4.8.5 的用户会**重新看到一次**这版报告 —— 符合预期。

     r134（2026-10-19）：**不升版本号，把当天全部改动并入 0.4.8.6 的 items**（用户要求
     「把今天所有的更新都写到 0.4.8.6 的更新报告里」）。当天做了：API 协议下拉
     （openai / responses / anthropic / google / mistral）、全局 LLM 代理、
     用量按插件归因、扩展安装预检与三档回执、扩展卡片熔断/调用性/警告徽章
     + 自动适配、就绪度体检卡复活、启动 24 分钟硬预算、横幅直达按钮、SnowLuma 刷新保交互态、
     工具集粘滞窗、表情收藏链路修复、多人同时 @ 漏回。date 同步改成 2026-10-19。
     ⚠️ version 仍是 0.4.8.6：点过 × 且存的正是 0.4.8.6 的用户不会重新看到本次追加。

     r135（2026-10-19 下午）：补当天后半天三项（提示词缓存结构优化 / 调用明细补账本 /
     四个统计维度版式统一），并合并重复条目 5 组（收藏与短名两条 → 1、提供商添加后两条 → 1、
     使用引导两条 → 1、界面小瑕疵两条 → 1、更新报告自身两条 → 1）；「多人同时 @」那条
     并入「被 @ 未发言时不能提前结束」的保险。版本号仍 0.4.8.6。

     r141（2026-10-20）：0.4.8.7 **正式启用** —— 用户要求「把今天所有的改动都放在更新报告上，
     版本为 0.4.8.7」。原打算另起的 0.4.8.8（小窗贴边收起 / 背景不透明度 / 卡片内菜单）
     已整段并入本条，package.json 的 version 同步为 0.4.8.7。
     本条覆盖 2026-10-20 当天全部 16 轮改动：注入链路两轮专项审查、界面状态机、
     新手自救卡、全站文案与入口校正、市场页可用性、SnowLuma 首屏三步化、
     「测试连通性」恒 401、全站鉴权头复查、桌面悬浮小窗、下载页签卡顿、
     「API 协议」保存不住、「保存不住」全站复查、发网图与安全开关入口、
     冷启动设置页崩溃、市场超时与缓存、小窗贴边收起与不透明度、当日改动回归审查。
     ⚠️ 升号后，点过 × 且存的正是 0.4.8.6 的用户会**重新看到一次**这版报告 —— 符合预期。

     r143（2026-10-21）：0.4.8.8 **只修安装包、不动应用代码**，于是暴露了老做法的问题 ——
     bump_versions() 是把第 1 条的 version 直接改成新号，不改内容，结果 0.4.8.7 那一整版
     （小窗贴边收起 / 背景不透明度 / 安全开关…）被挂上了 0.4.8.8 的版本号，用户看到的
     就是「0.4.8.8 = 小窗那一堆」，而真正的 0.4.8.7 条目在列表里消失了。
     本轮把原第 1 条还原成 0.4.8.7 / 2026-10-20，另**新插**一条 0.4.8.8 只写安装包修复。
     ⚠️ 维护约定：凡是「应用代码没变、只是重打包」的版本，都要新插一条，不要改第 1 条的号。

     r144（2026-10-21 下午）：用户「全面审查一下今天所有的修复，并且更新一下软件首页的
     更新报告，尽量把重复的内容合并一下」。当天下午第二轮做的是**分层记忆插件**的修复
     （15:53~16:24，`plugins/mem-layered/*`），它不在 08:18 那一版 items 里 —— 本轮补齐，
     并顺手把整条 0.4.8.8 对齐到 CHANGELOG.md 的 14 个条目：
       · 新增 6 条：记忆检索塌缩 / 记忆权重被重置 / API Key 换不掉 / 单账号硬约束 /
         三处白花的钱 / 雪茹日志两处
       · 合并 2 组：「ffmpeg 没进包」并入「安装包」（本来讲的是同一件事的两个侧面）；
         「设置页能看到记忆 4 个阈值」并入记忆检索那条（同属当天记忆相关改动）
       · 6 条 → 11 条，语义不丢、重复不重
     ⚠️ version 仍 0.4.8.8（沿用 r134 / r135 的既有做法：同一天追加不升号）。
        副作用知情即可：点过 × 且存的正是 0.4.8.8 的用户不会再看到本次追加。

     r145（2026-10-22）：用户「把所有更新都简化之后写到软件主页的 0.4.8.8 更新报告里」。
     0.4.8.8 条目 r144 之后又做了三大块，本轮全部并入、统一简化成口语化条目：
       ① 体验与编排（21:05–22:20）：被 @ 认不出自己 → 身份锚点三件套 + @ 判定行；
          finish 被拦截后仍结束会话 → 补 `&& !result.isError`；「承诺发表情却没发」
          → 同批发送 + 容量档；收藏支持 tags/usage。
       ② 工程化（22:40–23:59）：self-fix 批准令牌生命周期修复；harness 四模块内置化
          （self-doctor/self-fix/extension-forge/dev-orders → src/harness，core 类型）；
          fix 开关入口、左栏「工具」二级页签名回 harness；speech-to-text 探测不再乐观
          放行（缓存振荡）+ 本次基线重算（模块从拒载恢复加载）。
       ③ 安全与语义（10-22 体检后）：密钥端点伪造同源一律 403；502 改 400/404；
          拒发透传 usage errors；ffmpeg 随包解析。
     ⚠️ version 仍 0.4.8.8（用户点名写进 0.4.8.8，不另起版本号）；date 同步 2026-10-22。
        副作用知情即可：点过 × 且存的正是 0.4.8.8 的用户不会重新看到本次追加。 */
  /* r146（2026-10-23 首发 0.4.9；2026-10-24 修订为 **0.4.9.0**）：产品名「洛版 v0.4.9.0」。
     本版内容 = 0.4.9 合并进来的桌宠 / 壁纸两个改版 + 合并损失的修复 + 桌宠页与连接页重做
     + 桌宠加载链路修复。条目按「新增 / 修复 / 优化」开头，渲染层据此分组；同一件事只留一条。 */
  /* r147（2026-10-26）：0.4.9.1 —— 0.4.9.0 安装包（10-24 14:46）之后落地的全部改动：
     桌宠「直接对话」整套（含对话收文件、回复落档）、thinking 工具循环 400 修复、
     用量卡与顶栏同源、「接收整包」拖放化、工单窗「返回聊天」与拖动，
     以及安装包中文文件名乱码 + 漏带 13 个文件的修复。详见 CHANGELOG.md 的 0.4.9.1 节。 */
  /* r148（2026-10-27）：用户「东西归类到 0.4.9.1 里」—— 10-27 当天全部改动（R125~R136，
     见 CHANGELOG.md 未发布节）并入 0.4.9.1 条目、不升版本号（沿用 r134 / r144 先例）：
       · 连接页五轮重做（R127~R131）合成一条「连接页整体重做」，演进过程不展开；
       · R125 无窗口启动 / R126 一键接入 / R133 真实头像 / R134+R136 按钮修复 /
         R135 识图模型判定 / R136 滑动开关与自检误报清零，各成条目。
     date 同步改成 2026-10-27。
     ⚠️ version 仍 0.4.9.1：本机点过 × 且存了 0.4.9.1 的用户不会重新看到本次追加；
        免安装 zip 的接收者 data 全新、必然看到。 */
  /* r149（2026-10-28）：用户「把更新的东西放到首页更新报告上边去，就是 0.4.9.1 上边」——
     起初新插了一条 0.4.9.2；随后用户更正「不要升版本号，全并到 0.4.9.1，这个包还没分发，
     还有东西要改」→ 那两个条目已**整条并入 0.4.9.1 的 items**，0.4.9.2 / 0.4.9.3 不再存在，
     package.json 与 electron/main.js 的弹窗标题一起退回 0.4.9.1。
     内容 = CHANGELOG 未发布节的 R126（适配进度条）/ R127（自检页模型设置填了不生效）/
     R128（升级草稿显示待安装）/ R129（复查：超时预算、秒表、并发写草稿）/ R130（清理重复副本）。
     并入口径：新条目统一插在 items 数组最前，渲染层按「新增 / 修复 / 优化」前缀分组时，
     各组内仍保持数组顺序 → 新内容自然排在各组最上面。
     跨版本才成立的说法（如「上一版那条修复其实没生效」）已改写掉：包里只有一个版本，
     用户没看过中间态，留着只会让人困惑。技术细节留在 CHANGELOG 的 R130 里。
     口径同既有条目：只说用户能感知到什么，不写「chatCompletionWithRetry」这类内部名词。
     ⚠️ 不升号的老问题仍在：本机点过 × 且存的正是 0.4.9.1 的人不会再看到追加内容
        （清掉 localStorage 的 qa.stageReportClosed 即可重看）；免安装 zip 的接收者
        data 是全新的，必然看到。 */

  /* r150（2026-10-28 晚）：用户「把下午所有的修复都打到首页的更新报告上边去，
     删除重复的，版本还是 0.4.9.1」。
     做法：以 CHANGELOG 未发布节的 R131~R141（当天全部改动）为准，把 0.4.9.1 的
     items 前段整体重排（不是简单追加）——
       · 补 6 条当天做过但漏写的：切兼容模式重启期间的提示被轮询冲红 + 按钮能连点、
         状态条「桌宠显示中 / 桌面窗口未连接」两个绿点同屏、存档页一次拉全量 +
         甩裸 HTTP 状态码、表情详情失效回调累积、路径穿越检查漏检单反斜杠、
         已卸载升级目标的检查档位不一致；
       · 并 5 组重复：「草稿被两个请求同时改」与「被两个模型同时改」是同一个锁、
         「分发后桌宠不出现」与「关掉桌宠不还原」是同一条判定链、两条 L0 禁改清单、
         「升级草稿待安装」与「继续修改后装成第二个副本」、火绒拦杀与 GPU 判定；
       · 拆 1 条讲两件事的（丢弃草稿 / 超时被误报成未启用）；
       · 35 条 → 38 条（原有语义一条没丢）。
     date 同步 2026-10-28（同版本号内改日期不影响 × 的关闭记忆，记忆只认 version）。
     ⚠️ 维护约定：以后追加当天改动，**先按语义找已有条目合并**再去末尾加新的，
        否则这一版会重新变成一堵几十条的灰字墙。

     r151（2026-11-04 晚）：用户「把今天更新的东西写更新报告上去 0.4.9.2」。
     0.4.9.2 原 items 覆盖到 R183 前后（启动组合 / /help / 引导 / 桌宠 / 设置搜索等），
     本轮把当天后半段 R184~R204 汇总成 8 条插在数组最前（渲染层按「新增/修复/优化」
     前缀分组，同组内新内容自然排最上）：
       · 页头 / 列表 / 卡片统一（R190/191/194/203）、滚动条与维度切换不跳位
         （R197~R200）、会话卡空卡体与点按卡顿（R187/188/193）、半像素文字与
         问号居中（R184/192）、用量页同排控制条与「?」收纳说明（R195/196）、
         两处搜索框（R201/202）、击穿归因聚合折叠（R204）、头像本地缓存与
         动效 / 滚动性能（R182/183/185/186）。
       · R189 是本机 Windows 动画开关（系统设置），不是软件改动，不写进面向
         所有用户的报告。
       · 与已有条目按语义去重：设置搜索已有「能搜到什么」，本次只写「搜框本身
         看得清、提示不截断」；/help、引导、状态栏等已覆盖的不重复。
     ⚠️ version 仍 0.4.9.2、date 仍 2026-11-04（package.json / version.json 已是此号）：
        点过 × 且存的正是 0.4.9.2 的用户不会重新看到本次追加（清 localStorage 的
        qa.stageReportClosed 可重看）；免安装 zip 的接收者 data 全新，必然看到。
     ⚠️ 以上说明只适用于 0.4.9.2 那一条。0.4.9.3（2026-11-11）已独立成条，
        版本号变化会让按 version 记忆的关闭状态失效，所有人会再看一次。

     2026-11-11 晚（同版本内追加，date 故意不动）：
       0.4.9.3 推到 GitHub 之后又做了两轮修复（外部反馈包 11 条 / 故障注入），
       按上面的维护约定「先按语义找已有条目合并」处理，不新砌一面墙：
         · 点表情那条并入：表情目录读不到时的 5 分钟失败冷却与「改用编号」提示、
           msg_reactions 先截断后过滤导致有效表情被丢；
         · 群公告那条并入：协议端把系统消息包在对象里时不再误报「没有」；
         · 动作回执那条并入：引用纯图片消息时也带上 mid；
         · 只新加 3 条独立主题：表情收藏同步可诊断 + 异常降频、
           本机回环开关与状态接口版本号、headless 与桌面版数据目录统一。
       缓存预热那轮只是实测 + 补契约测试（没有用户可见改动），发版体检的版本
       一致性检查也是内部工具，都不写进面向用户的报告。
       没改 date：改了会让点过 × 的用户再被弹一次；本版刚推送、CDN 还在缓存期，
       绝大多数用户本来就没看过这一条。
       注意渲染层分组顺序是「新增 → 优化 → 修复」：6 条新增会排在最前，
       「看图不再评价」虽然最重要，但按规则落在修复组内第一位。

     2026-11-11 晚二次追加（真机日志审查）：又找到 1 条确凿会影响真实对话的
       bug —— 服务端偶尔回「只支持文本输入」时，image-compat 认不出这种措辞，
       整轮对话直接 400 失败（11-06/07 共 20 次真实请求）。
       现有 11 条没有语义贴合的，所以只新加 1 条独立主题，仍是 12 条、date 不动。

     2026-11-11 三次更正（用户指出「这不是多模态模型吗」后实测）：
       上面那条曾把根因写成「纯文本模型」，是错的。官方定义 + 真实端点实测都
       证明 sensenova-6.8-flash-lite 是原生多模态模型（合法 PNG 返回 200）。
       已改掉条目里的错误断言与「换一个能看图的模型」这类误导建议；
       代码注释 / 中文报错 / 模型能力表同步更正。降级逻辑保留为兜底，
       它只在服务端已经明确拒绝之后才摘媒体，不会主动关掉看图。
       条目数、date 都不动。

     2026-11-11 晚四次追加（插件安装界面重做 + 闸门报数修正）：
       这一轮改的是「从市场点安装之后」整段界面（三步横幅 / 确认区吸底 /
       市场三态 / 批量结果常驻 / 阻断态独立布局），外加闸门阻断数的算法。
       两条都是用户能直接看见的，所以必须进报告 —— 前几轮那些内部健壮性
       （时钟回拨、契约测试、缓存预热实测）仍然不写。
       一条以「优化」开头（classifyItem 里非"新增/修复"一律落优化组，
       这一组之前是空的），一条「修复」。
       12 条 → 14 条；date 依旧不动，避免点过 × 的人被重复弹
       （本版刚推、CDN 还在缓存期，多数人本来没看过这一条）。 */
  var STAGE_CHANGELOG = [
    {
      version: '0.4.9.3.1',
      date: '2026-11-12',
      items: [
        '新增 思考量按消息轻重自动分配：拍一拍、接一句短话这类轻松场景只给一点点思考，@ 提问、复杂任务才放开完整思考。说话本身不受影响，烧在思考上的 token 明显变少（实测常规对话降四成左右）；设置里可以一键关掉这个分配',
        '修复 偶发「缓存命中率暴跌到 13%」：提示词里有一句随每轮思考档位变化的小字标注，被放在了本该逐字节稳定的位置——档位一翻转，它后面的大段上下文就要全部重算。现在这句改为固定描述，命中率回到 96% 以上，不再出现深坑',
        '优化 被拍一拍时又想戳回去又想说话，一次完成：以前它先戳一下、等结果、再开口，白白多跑一轮请求（界面上能看到 token 翻倍）。现在戳和说在同一次回复里一起做，说完直接收尾',
        '优化 多群同时活跃时切换更省：几个群的角色卡统一成最新版，群与群之间切换时能复用的上下文变多——切换瞬间的缓存利用率从 74% 提到约 86%。提醒：以后如果给某个群单独设人设，角色卡有了差异，切换时的命中率会略有回落，属正常现象',
        '优化 自检日志不再「狼来了」：跨群切换时不会再刷「6/10 段内容变化、断点推到最前」的假告警——这类对比现在只在同一个群的相邻请求之间进行，真有变化时告警行会标明是哪个群',
        '修复 配了专用图片/视频模型后，读到图或视频必失败：以前只会把专用模型的**模型名**发往主模型的**接口地址**——名字和地址对不上号，服务商直接报错，整轮会话失败。现在会自动按模型名找到它所属的服务商，把接口地址、密钥、协议一起切过去；专用模型就配在主服务商上时行为不变',
        '优化 聊天上下文读取窗口从 80 条收窄到 40 条：单次输入更省，40 条足够接上群里正在聊的话题；私聊同样生效',
      ],
    },
    {
      version: '0.4.9.3',
      date: '2026-11-11',
      items: [
        '修复 看到图就忍不住评价画面：以前群里一发图，它多半会复述图里有什么、再补一个比喻或打个分，一眼就是机器。现在默认不看图——只有有人 @ 它、问了图里的东西、或者配文明显在等回应时才看；看完也可以只点个表情、或者干脆什么都不做。「看了就得说两句」这条从行为里划掉了',
        '新增 能给消息点表情：看到有意思的图、截图、成绩单这类「没什么可说、但又想表示看到了」的内容，可以给那条消息点个表情（赞、笑、无语这些），不发言、不插话。这填的正是以前只能二选一的空档——要么硬憋一句评价，要么彻底沉默。顺带修好两处：协议端读不到表情目录时不再每次都干等十几秒（会直接给出能用的编号，也不会再挨个换名字重试），查一条消息被点了哪些表情时，不会因为前几条无效就漏掉后面的有效表情',
        '新增 能撤回自己刚发的消息：说错话、发重了、发出去就后悔，可以撤回。只能撤自己的，撤别人的会被直接拒绝；撤完会提醒它对方可能已经看到，别以为撤了就没事',
        '新增 能给群友的名片点赞：关系近、刚聊得开心时随手赞一个。同一个人一天最多一次，换个群也不会重复打扰',
        '新增 能看群里的荣誉榜和今日打卡：龙王、话痨榜、群聊之火这些现成话题，以及今天谁签到了。冷清的小群没有数据时会明说「没有」，不会对着空榜单硬编',
        '新增 能看群公告和群进出通知：群规、谁申请进群、谁退群了都能查。以前有人问「群规是啥」「刚才谁进群了」，它只能靠猜或者干脆装没看见。协议端把通知包在一层对象里返回时也能正确读出来，不会明明有消息却回一句「没有」',
        '新增 能把聊天记录合并转发：说一句「把刚才那段转给他」，它会打包成一张聊天记录卡片发出去，而不是把内容重新复述一遍。跨会话转发仍然要走白名单开关',
        '修复 分不清「谁对谁做了什么」：拍一拍、@ 了谁、引用的是哪一条，现在都会明确回执。以前它拍完别人，看到自己动作的回显会当成「有人在拍我」，再对着自己的动作回应一遍；发图时 @ 了个不在群里的号，也照样以为叫到了人；引用的是纯图片消息时也会带上消息编号，不再出现「引用了却找不到原文」',
        '修复 表情收藏同步不过来、还查不到原因：日志以前只留一个「请求 500」的数字，分不清是收藏真的空、还是协议端压根没实现那个接口，失败时更是一个字都不写。现在会记下返回体的形状（不记任何表情内容）并说明可能原因；连续失败自动降频，不再每十分钟白打一次，手动刷新和刚收藏新表情仍能立刻重试，恢复后也会记一笔',
        '修复 本机自己访问自己被安全策略一律拦下：默认仍然拦着（防网页把请求打进内网），但设置里打开「允许本机回环」后，127.0.0.1 与 localhost 会放行，局域网地址照旧拦。状态接口也补上了版本号，外部工具查版本不用再靠猜',
        '修复 不打开界面启动时读的是另一份旧配置：以前无界面模式和桌面版把配置、日志、缓存写进不同目录，改了设置像没改、换台机器装好也对不上账。现在两条路径统一，看到的始终是同一份数据',
        '修复 群里发图之后整轮对话直接失败：服务商偶尔会退回一句「只支持文本输入」的英文 400，旧代码认不出这类拒绝，机器人这一轮一句话都发不出来，连缓存保活都被带图请求连累。现在能认出来，自动摘掉图片和视频重发一次（并叮嘱它别假装看过图），文字部分照常回；万一还是失败，报错也换成能看懂的中文，提示先排查视频输入和图片格式，不会让你误以为得换个模型',
        '优化 装扩展这一步终于像「装东西」了：以前从市场点「安装」，跳过去是一整页造扩展的界面——顶上一句「用一句话描述你要什么」，确认按钮压在整屏代码下面，装不了的时候还让你去点一个根本不存在的输入框。现在从安装进来只做三件事：顶部告诉你正在装什么、到第几步，中间是适配进度，底部「确认安装」一直贴在眼前。装过的插件在市场里会显示「待确认」，点它直接回到那份草稿，不用重新下载；批量贴口令时结果清单也不再一闪而过，哪个失败了、为什么，都留在屏幕上',
        '修复 闸门报「5 项阻断」，其实只有 1 个问题：另外 4 项是「因为结构没过所以没检查」，界面上却各占一张长得一样的卡片，把真正要修的那条淹了。现在只算真要修的项数，被跳过的合成一行说明。装不了的时候也不再让一个灰掉的「确认安装」占着最显眼的位置，改成整块红字写清还差几项，点一下就让模型接着修',
      ],
    },
    {
      version: '0.4.9.2',
      date: '2026-11-05',
      items: [
        '优化 界面统一：会话选择、存档、记忆三页页头改成同一副样式（真实头像＋名称＋群号/QQ 副行），记忆页左栏与存档页列表同款；计数胶囊、空态提示、时间显示口径全站归一；自检页「前缀缓存哨兵」也换成同款卡片。页头文字改用整数像素，软件渲染下不再发虚、不再差半个像素',
        '优化 头像全部走本地缓存：存档、记忆、会话、侧栏、连接页的私聊头像统一由软件缓存（群头像仍走群接口），首次拉取后跨重启复用，不再每张都等 DNS/TLS。缓存会校验图片真伪，坏档自动丢弃重拉，不会一直破图；拉不到时回落到首字或默认企鹅',
        '修复 滚动条出现时页面内容左右跳：各界面预先留好滚动槽，并改成左右对称留槽，位置与以前完全一致；按天/按会话/按模型/按插件切换时，标题行也不再上下跳 6 像素',
        '修复 会话卡空卡体与点按卡顿：空态占位不再被当成会话内容塞进卡体，真没内容会自动补拉详情；反复点同一张卡头不再整块重渲染；补拉失败也能自动恢复，不会永久停在「加载中…」。顺带修好打开「会话选择」时顶栏闪一下',
        '优化 用量页首屏更紧凑：图表指标、时间范围、刷新收到页头同一排；新增「?」把四个区块的说明与计算口径收进弹窗，页面只留图表和结论行。弹窗连点不会叠加',
        '修复 两处搜索框：会话选择页与设置页的提示文字不再被截断，完整说明放进悬停提示；设置页搜索框补了清楚的边框、底色与聚焦高亮',
        '优化 自检页「击穿归因」不再刷屏：同一原因反复触发时合并成一组显示「共 N 次」，改前/改后原文默认折叠，超过 4 类可展开；只取最近 60 次聚合，长历史不再拖慢页面',
        '优化 性能与 CPU：切回会话页/存档页数据没变就不重画（滚动位置与悬停行保留）；两处常驻呼吸动画改用缩放与透明度；桌宠视线跟随从 50ms 放宽到 100ms、位置不变不发；群聊状态事件 120ms 合并一次；顶栏刷新改成先给上次结果、后台更新（735ms → 0.2ms）。桌宠默认改为关闭，已开着的不受影响',
        '修复 指令一览（/help）重启后不可用、日志说「触碰了高危能力」：内置插件的安全指纹没跟源码更新，已重算并全量核对（21 个插件全部一致）',
        '修复 模型报错又冒英文 JSON：补上「内容审核」这类错误的翻译，说明不是配置或网络问题，并给出换说法/换渠道的建议',
        '优化 看图反应更像人：有文字时先接文字、图只作配图；不许给图里角色安性格或打分；被 @ 时回一个字或一张表情也算完成',
        '修复 人设改动不跟版本更新：内置人设模板修正后，你那份副本会在启动时按句子同步，自己改过的句子不动',
        '修复 市场左上角偏蓝色块：去掉那层氛围光，只保留右下角极淡的一层',
        '新增 底层「启动组合」装配：消息仓、会话仓、编排器、提示词等 20 个组件可在 overrides/ 里替换，删目录重启即恢复；覆盖层清单支持开关、排序、依赖校验，非法项明确报错并写日志。不装覆盖层时行为与 0.4.9.1 一致，界面一个像素没改。覆盖层里是原生代码，信任等级等同直接改源码，只放自己写的或信得过的',
        '说明 源码做了一次大扫除与分区：177 个接口从 5000 多行拆成 12 个域文件，1400 行用量统计独立；顺手清掉分区时抄进来的 908 个无用引用和一批历史残留。对外行为不变（接口逐条比对、308 个测试通过），分区中漏改的按需加载路径也已修复',
        '优化 设置页更好找：搜索能直达安全开关、思考强度/工具轮数、前缀缓存、开机自启与托盘；搜「日志」「自检」会跳到工具页并高亮。安全开关单独成块并常驻显示当前状态，回复节奏把思考强度、工具轮数、并发、发网图四个值直接印在页面上',
        '优化 /help 排版：两列对齐改成按内容自然堆叠（整图高度降 23%，不再被 6000px 裁掉）；顶部区分技能与插件并标色，技能在前、插件在后',
        '修复 使用引导滚动卡顿：引导层关掉毛玻璃（其他弹窗早就关了），滚动恢复流畅',
        '修复 更新检查一直失败：更新源仓库已转公开，并把国内可达的镜像配进默认地址；启动静默检查与手动「检查更新」都能正常返回「已是最新」。发版后镜像约有 12 小时缓存，提示可能延迟半天',
        '修复 侧栏机器人头像拉不到时显示破图：补上失败回落，露出默认企鹅',
        '优化 全站字号与圆角有了统一刻度：字号原先散成 29 种（含 11.5 / 12.5 / 10.5 这类半像素值），收敛到 10 / 11 / 12 / 14 / 16 五档；圆角原先 20 多种，收敛到 6 / 10 / 999 三档。以前同级元素总差半个像素、圆角差 1～2 像素，看着"到处都差一点"却说不出差在哪。正文 11.5→12、12.5→12，小标题 13→14，个别按钮文字会略大一点，整体更齐整',
        '说明 样式表做了拆分：原来是单个 10601 行、441KB 的 style.css，改一处要在 57 万字符里翻。现在按功能切成七份（基础 / 外壳 / 工作区 / 用量 / 对话框 / 主舞台 / 连接页），最大的一份 140KB。切分严格按原文件行序连续进行，拼接后与原文件逐字节一致（2864 个规则块不多不少），界面一个像素没变',
      ],
    },
    {
      version: '0.4.9.1',
      date: '2026-10-28',
      items: [
        '修复 机器人看图之后回复特别慢（有时候要 9 秒以上）：发出去的一次请求被撑到 **244 万字符**。原因是判断"这张图要不要压一下"时依赖的工具（ffprobe）根本没随包发出来，这个判断**从来没有生效过**，所有图都退化成"原图超过 4MB 才压"——于是 1~4MB 的图整段跳过压缩，转成文字编码后变成 200~330 万字符直接塞进请求。现在改用自带的 ffmpeg 读图片尺寸，并把压缩门槛降到 512KB；实测同一批图从 265万/333万/177万 字符降到 **37万/37万/8.6万**，最大的那张 11MB 从 1508 万降到 43.6 万。小图（512KB 以下）依然一点不折腾，实测 0 毫秒直接放行',
        '修复 在网盘/杀毒软件刚好占着配置文件的那一瞬间启动，你原来的 API Key、群白名单、人设会被**整份换成出厂设置** —— 因为"读不出来"被当成了"文件损坏"，备份改名后回落默认值，5 分钟一次的云端同步又把默认值写回磁盘。现在只有文件**真的损坏**才备份重建；只是这一次读不出来时，会先用默认配置把软件跑起来，但**整个会话都不写盘**，磁盘上那份原样留着、重启即恢复。保存时也会如实说"已生效但没写进磁盘"，不再假装成功',
        '修复 把包发给别人、或换一台电脑装好之后，桌面上根本找不到桌宠：以前只要软件被迫退回「软件渲染」（显卡加速用不了，或有安全软件拦杀显卡进程），桌宠就会被**静默跳过**，只在桌宠页里留一句提示 —— 拿到包的人不会去翻那一页，桌面上就是缺了这个功能。现在启动的第一秒就会判断「这台机器只能软件渲染、而你开着桌宠」，自动切到能让桌宠显示的模式，**本次启动直接生效，不需要重启、也不需要点任何按钮**；反过来，如果你本来就把桌宠关了，它不会为桌宠改动任何设置（安全选项保持原样），而在桌宠页关掉桌宠之后，先前为它让出的那一项会自动还回来（你手动点过「开启兼容模式」的不会被悄悄改回去）',
        '修复 兼容模式下桌宠明明启动了却一个像素都看不到、桌面上怎么找都没有，而桌宠页只会说「请通过 QQ Agent 桌面程序打开桌宠」，让人以为软件坏了：软件渲染时多给了 --disable-gpu，Chromium 的强制软件合成让透明窗口拿不到呈现面（窗口可见、置顶、内容也都正常，就是不上屏）。现在这条路上不再压 GPU，桌宠能正常显示；万一某台机器上还是被跳过，页面会照实说明原因，并给一个「开启兼容模式并重启」按钮，点一下就能恢复',
        '修复 别人的电脑上装了火绒 / 360 / 电脑管家时，软件会卡在启动画面反复闪白进不去：这类安全软件会拦杀沙箱化的渲染进程，以前只会崩了重载、重载再崩，最多 5 次后放弃。现在连崩 3 次就自动判定「本机沙箱不可用」，关闭渲染沙箱并重启，之后每次启动都直接生效 —— 拿到包的人不用做任何操作。另外显卡驱动有问题的机器上「自动退回软件渲染」这层安全网**从来没生效过**（判断崩的是哪个进程时名字写错了，永远对不上），现在能正常触发，同样连崩 3 次自动退软件模式',
        '修复 开了桌宠之后软件点开就崩溃、进不去：桌宠是 Live2D，起窗口就要 WebGL 上下文，而这台机器只能软件渲染（显卡加速已关），两者撞在一起会让渲染进程直接崩掉 —— 不只是桌宠不显示，主界面和悬浮小窗会一起挂。现在两道保险：桌宠只在真正拿得到 WebGL 时才起窗，条件不满足就跳过并在日志里写明原因，最坏也只是「桌宠不出现」而不会「软件打不开」；用无沙箱方式启动时则自动给 WebGL 接上软件后端（SwiftShader），Live2D 能正常出模型',
        '修复 壁纸页点「浏览…」挑好文件夹之后，输入框一个字都不填、也没有任何报错（桌面桥里同名的方法定义了两份，实际返回的字段名和页面读的不一致）：现在选完就直接填上',
        '修复 桌宠页有时会永远停在「读取中」，之后再也不会自己刷新；插件市场点「安装」遇到上游慢，会永久卡在「安装中…」且按钮点不动了。现在这些请求都有超时，到点明确报错并让你重试',
        '修复 另一个窗口正在改这份草稿时点「丢弃」，界面显示已放弃、草稿其实还在（下次进页面又冒出来）：现在会保留状态并说明原因，不再假装丢掉了',
        '修复 自动修复与扩展锻造台偶尔只是一次超时，却被说成"插件未启用"，还引导你去启用一个本来就开着的插件：现在如实说明是"读不到状态"，并给你重试',
        '修复 切换兼容模式后重启的那十几秒里，界面会把「正在重启，请稍候…」冲成红色的「读取桌宠状态失败」，按钮还恢复成可点 —— 连点两下就是两个重启请求。现在这十几秒里不轮询、不重绘、按钮锁住，并留了 90 秒兜底（万一重启被安全软件拦下，也不会把按钮永远锁死）',
        '修复 桌宠页状态条会出现「桌宠 显示中」和「桌面窗口 未连接」两个绿点同屏 —— 前者原来只看配置里的开关。现在分成「显示中 / 已开启·等待加载 / 已隐藏」，按窗口是不是真的加载出来了判断',
        '修复 打开存档会一次性把整段聊天记录全拉下来（不传条数就等于"不限"），长会话会明显卡一下；另外几处出错时直接甩一串英文的「HTTP 500」。现在默认只取最近 2000 条（存档页自己翻页不受影响），报错改成看得懂的中文',
        '修复 同一份扩展草稿能被两个请求同时改写：同时开两个窗口、刷新一下页面，或者在「自创扩展」页点适配的同时又在「升级扩展」页点对话升级 —— 界面上的按钮明明已经灰掉了，绕过去一样能发，最后谁最后写算谁的、改动静默消失。现在前后端一起拦：后到的那个请求会直接收到「这个草稿正在被适配处理中」，不会再出现"装进去的东西和检查结论不是同一份"',
        '修复 表情包里从聊天里收藏的动图，点开详情只剩一张静止的图：转码只给本机已有的动图做了视频版，网络来源的漏了，页面又判不出它本来是动图。现在网络动图也会生成视频版，详情里能正常播放（仍然走视频解码，不会再把界面拖崩）；万一转码失败，也会退回静态首帧而不是一片黑',
        '修复 表情包详情在"视频和首帧都还没生成好"的时候是一个破图图标（首次安装、刚启动时最容易撞见）：现在会显示占位提示，不再是坏图',
        '修复 收藏表情时图片只写了一半（磁盘满、进程被杀），会留下一个打不开的坏文件，而且因为"文件存在"永远不会重新下载 —— 面板上是破图、发出去是坏图，只能手动删。现在改成写完整后再原子替换，半截文件一律当没有、下次自动重修',
        '修复 用脚本或备份工具改过表情库（stickers.json）之后，只要让机器人备注 / 收藏一张表情，你改的那批就被旧快照整份盖回去了。现在这三条写入路径也会先合并磁盘上的外部改动再落盘 —— 外部新增的一条都不会丢',
        '修复 表情包详情反复开关之后，遇到一次图片链接过期，会一次性冒出十几条「图片加载失败」：每打开一次就多挂一个失效回调、从来不摘。现在每次只保留当前这一个',
        '优化 两个扩展的清单用了同一个 id 时，后加载的会静默顶掉前一个（"我装了两个，怎么有一个不生效"）。现在启动日志会明确指出是哪两个目录撞了，改目录名即可',
        '修复 起草 / 升级扩展时，给模型看的「好扩展长什么样」的示例文件丢了：文件搬了家，读取还指着旧位置，失败又被静默忽略 —— 结果不会报错，只是生成出来的扩展质量悄悄下降。现在两处都找，实测能读到示例',
        '修复 「自动修复」本来能改掉约束自己的代码：那条「绝对不许改」的清单在模块搬家后还指着旧位置，等于形同虚设；而且清单比对只认一种写法，前面加个 ./ 、换成大写、用反斜杠，都能绕过去。现在锚定到实际位置（闸门、体检、加载器这几处模型改不到），比对前也先统一路径写法',
        '修复 自动修复 / 锻造台改扩展文件时，那道拦住"写到扩展目录外面"的检查，用 Windows 的反斜杠写法就能绕过去（判断里多写了一个反斜杠，实际永远对不上）。现在两种斜杠都拦，正常文件名不会误伤',
        '修复 已装插件的升级草稿显示「待安装」，点下去还会装成第二个副本：暂存区里那些「给已装插件做修改」的草稿，状态原来写的是「待安装」，看着像要装个新的；更坑的是点「确认安装」真的会装成第二个副本（比如 sq-self-2），原插件一点没变 —— 「继续修改」一轮之后再点安装也一样。现在显示「⬆ 更新 sq-self」和「待更新」，点下去是先备份原版再覆盖，装坏了还能回滚；原扩展已经被卸载的，统一按全新安装对待（以前列表、点开、点下去三处说法各不相同）',
        '修复 原扩展已经卸载、只留下升级草稿时，检查标准还按"改的是第三方扩展"从宽放行 —— 现在这种情况和界面口径一致，按全新安装的严格标准来',
        '修复 升级 / 起草这类长任务会被界面提前放弃：升级这边后端最长要跑十几分钟（首轮加最多两轮自动修复），而界面四分钟就断开报「升级失败」—— 那次失败是假的，后端还在改草稿，你一重试就变成两个请求同时改同一份。现在前后端的等待时间已经对齐',
        '修复 启动时报「扩展加载失败：扩展锻造台」红卡：软件里同时躺着两份锻造台（一份是早期搬家时留下的旧副本），旧的那份每次启动都被校验拦下、报一次错，然后被新的顶掉。旧副本已清走，这张红卡不再出现（真出问题时仍会照常报，不是把提示关掉了）',
        '修复 自检页「模型设置」填了却不生效：以前勾上「使用独立配置」、把地址和模型填好，保存后界面也说切换成功，实际对话排查仍在用全局模型（费用还记在全局渠道名下）；现在会真的用你填的那一套。顺带说清楚一件事：这套配置同时决定「模型逐个审」「自动修复的提案」「锻造台的起草 / 适配 / 升级」和「开发工单」用哪个模型，填错会一起受影响',
        '修复 自检页「对话排查 → 生成修复提案」点不动：对话区每收到一次回答就局部重绘，按钮只在整页渲染时绑过一次事件，结果第一次问答后所有「🛠 生成修复提案」都成了死按钮（点了没反应），等于断掉了「排查 → 自动修复」的主链路；现在改成事件委托，重绘后照样可点',
        '修复 自检页永久删除开发会话的确认框没标红：删除是不可恢复的，确认键却用普通主色（同文件的删除审计、回滚备份都标红了），容易误点酿成数据丢失；现在统一标红并写明「确认删除」',
        '修复 接收整包「检查并登台」误导：登台后按钮被永久禁用并写成「已登台」，但之后改勾选既登不了台、又会被安装静默跳过 —— 看着登台了实际没装进去；现在按钮可「重新检查并登台」，改了勾选会提示重新过闸，且一个都不勾就点会提示「请至少勾选一个扩展」',
        '修复 技能 / 插件页筛选条的数字对不上：「全部 / 生效 / 已关 / 加载失败」和「不限来源 / 内置 / 第三方」两排数字以前各数各的、永远是整页总量，点了某一档后另一排的数字跟下面实际列出的卡片对不上 —— 现在每排数字都跟着另一排的选中档走，数字 = 卡片数；顺带补上漏掉的第 4 种状态「依赖未就绪」的档位（以前这种条目只算进「全部」，点遍三档都找不到它），没有这种情况时不占位置',
        '优化 插件自己的存储文件（表情库备注、标签、各项配置）从"直接覆盖写"改成原子写：以前写盘那一瞬间打开插件面板会读到半截文件而白屏，写到一半崩溃则下次整个存储被当成空的、一把清空。读坏了也会先留一份备份再继续，不再无声抹掉',
        '优化 「升级扩展」列表清爽了，启动也少做几份无用功：系统自检、自动修复、扩展锻造台、开发工单这四样是软件自带、不该出现也升不了级 —— 以前它们混在可升级列表里（选中还会做出一份改了也不生效的草稿），启动时还会被重复初始化两次（先按普通扩展装一遍、再被内置版本覆盖）。现在不再出现在列表里，也不再重复初始化',
        '优化 进度条上的「已用秒数」：适配和升级同时进行时，两条的秒表不再互相把对方停掉（以前后开始的那条会把先开始的停住，秒数就定住不动了）',
        '优化 技能 / 插件列表的默认排序：生效中的排前面、已关闭（含加载失败）的排后面 —— 打开页面先看到能用的；自己拖过顺序的仍按拖动的来',
        '优化 出厂默认开启的技能调整为三个：知识库（梗库）、指令一览面板、回忆工具默认开启，计算器 / 文生图 / 二次元配图 / 日程表 / 关键词自动回复保持默认关闭 —— 全新安装开箱即是这样；已在用的机器不受影响（按你自己的开关状态走）',
        '新增 自动适配看得到进度了：给扩展做适配（含设置页扩展卡片上的「🔧 自动适配」）不再是一行「正在适配…」干等 —— 现在能看到五步走到哪（读包 → 过闸门 → 模型改代码 → 重跑闸门 → 出对比）、当前在改哪个文件、已经改了几处、总共用了多久；模型停下来想改法的那几十秒，秒表照走，不用怀疑它卡死',
        '新增 桌宠直接对话：双击桌宠就能和它聊天 ——「私聊 · 主人」一条专属会话，走的是群里那套真实流水线（同一份人设、记忆、表情包策略和用量预算），但回复只回到窗口里、绝不会发到 QQ 群；你说的话和它的回复重启后都还在（想改回双击开开发工单，去桌宠页或右键菜单里设）',
        '新增 对话窗能收文件了：点输入框旁的 ＋ 选文件，或把文件直接拖进窗口 —— 图片它能看懂（自动收进缓存，和群里收图同一条路），文本直接读进消息（太大截断并注明），exe / zip 这类发不出去的会明说「附件未发送」，一条消息最多带 8 个',
        '修复 桌宠对话重启后「只剩你说的话，回复全消失」：它的回复以前只存在内存里，重启就没了；现在和真实发出的消息走同一条落档链路，重启后完整还原（修复前丢的那些找不回，从此不再丢）',
        '修复 开着 thinking 模式时工具调用第二轮必报 400：新协议要求把模型的思考原文随历史带回，以前整段丢掉 —— 群聊、控制台、开发工单、存档回读全链路都补上了',
        '修复 桌宠「对话」点进「开发工单」就回不去：工单窗头上现在有「返回聊天」按钮，两边随便切',
        '修复 开发工单窗拖不动：三张浮窗里就它没有拖动区，现在按住窗头就能挪（按钮照常能点）；单击弹的用量卡片保持「点一下就收」，不加拖动',
        '修复 桌宠「今日用量」卡片和顶栏数字对不上：以前两边口径不同、卡片还读的是最多 3 小时前的缓存；现在和顶栏逐字段同源，5 秒刷新是真实时',
        '优化 「接收整包」不用再手抄路径：自检 → 打包 / 接收 里，把别人发来的整包 .zip 拖进去或点「选择 zip 文件」就行；手填路径收成一条折叠退路',
        '修复 安装包两个硬伤：中文文件名不再装出来是乱码（使用说明.txt、桌宠默认模型目录「DS鼠控版」）；补齐漏带的 13 个文件（桌宠对话整套与测试）—— 这也是版本号定为 0.4.9.1 的原因',
        '新增 协议端无窗口启动：不用再让黑色命令行窗口常驻桌面了 —— 在「工具 → 连接」的协议端卡里点「启动」就行，启动 / 登录 / 报错的日志直接显示在同一页里；停止也在这里点，退出软件时它拉起的进程一起收走（协议端还是你自己装的那份，它的文件一个不碰）',
        '新增 一键接入：装好协议端后点一次「一键连接」就能把机器人 QQ 挂上 —— 软件自动走完启动 → 登录 → 注入，密码优先用启动日志里的初始密码自动登录并记住；需要你本人出手的（几个号里选一个、同意条款、改密码）会停下来明说，不会替你乱来；密码填错会等半分钟再试，不会把控制台锁死',
        '连接页整体重做：换成和全站同一套版式 —— 页头状态胶囊 + 一张状态卡（结论、机器人身份、在线时长、收发端口四格）+ 协议端独立成卡（启动 / 停止 / 打开控制台 / 随软件自动启动）+ 四个折叠收纳技术细节；没装协议端时有三步图文引导（下载 → 解压 → 选目录），选目录直接弹系统文件夹选择框，选完自动往下走',
        '连接页头像换成机器人的真实 QQ 头像（加载不到时退回原来的彩色首字，不会变成空白圆）',
        '修复 发图被拒「当前模型不支持图片输入」：主模型纯文字但配了识图模型时，图片会自动交给识图模型处理，不再被误拦；设置页的提示也会说清「识图模型可处理图片」，不再误导你重新配置',
        '修复 连接页一串「点了没反应」：填了密码点连接没动静（密码其实没提交出去）、网页版「打开控制台」复制出来是空的、「帮我找」点一下跑两遍提示还互相顶、没指定目录时「打开控制台」不再出现一个打不开的死链；「随软件自动启动」也换成了和设置页一样的滑动开关',
        '修复 没装 Node 的电脑上点「启动协议端」没反应、甚至弹出第二个软件窗口：以前兜底时误用了软件自己的主程序去跑协议端；现在只认协议端目录自带的 node 或系统里装的 Node.js，都没有时明确告诉你去哪下',
        '优化 协议端目录识别：解压多套一层同名文件夹会自动下钻、老版本只有 index.js 也能启动、路径带空格或中文不受影响；「帮我找」在装好但还没登录过的时候也能找到目录，下完解压就能直接点启动',
        '优化 自检页不再刷一屏假警告：以前「硬编码的绝对路径」一口气报 15 条，逐条核过全是把「环境变量兜底」「第三方软件位置探测」当成了硬编码；判定已修正 —— 以后这条警告再出现就值得认真看了',
        '修复 机器人偶发「说怪话」的两处根源：想分多条发送的 JSON 数组里引号没转义，整串原文直接进了群 —— 现在能自动修复并按原意拆成多条发送；把换行写成字面 \\n 的也会还原成真实换行，不再把「\\n」两个字发到群里',
        '修复 壁纸「重启就消失」的两个真实隐患：控制台端口被占漂移后，壁纸选择等本地状态会整库清空（现在启动优先沿用上次端口，不再漂）；壁纸库目录名是中文时整条链路被拒（预览恒 404、兜底状态还会被误删）—— 现在中文目录正常用',
        '优化 插件 / 技能卡片防误触：只有右侧滑块开关能启停插件，点名字、简介不再切换（手机操控云电脑时容易误开误关）；插件设置弹窗和扩展弹层改成「点空白不再关闭」，填了一半的配置不会因为点到旁边就全丢，关闭只走 × / 取消 / 保存 / Esc',
        '新增 自检页「模型设置」补齐两个缺了几个月的按钮：「⟳ 拉取模型」拉到列表后弹窗选择、单击回填；「连接检测」发一次最小请求，显示 ✅/❌ + 耗时 + 回复摘要；顺带修好模型管理页「拉取模型列表」在这类 Key 配置下恒 401 的问题',
        '修复 打开自检报「扩展加载失败：self-doctor」红卡：内置插件改过代码后随包基线没同步，安全闸按占名顶替拦下 —— 基线已重算，分发 zip 内的基线也一并替换，收包人不会再撞上这张卡',
        '修复 收包人 bug 清单里的三个 P0：① 机器人偶尔「思考完不说话」白白烧 token —— 空输出现在也会兜一轮逼它表态；② 推理模型把输出额度花完在思考上、正文为空 —— 自动放大输出上限重试一次；③ GIF 在识图路线只给模型看第一帧 —— 现在用随包 ffmpeg 均匀抽 3 帧，动图能看懂了',
        '修复 收包人清单里的其余几项：插件改了 lib 文件后热重载假失败；表情库被外部脚本改动会被内存盖回（现在写盘前先合并磁盘改动）；配了 token 的脚本 POST 被 403 拒收；「工具被排除」一次体检刷七八条警告（聚合成一条）',
        '优化 界面手感：技能设置 / 插件面板弹窗补上开合动画（不再是「砰」地出现消失）；拉取模型、连接检测这类等待型按钮加了加载转圈，不再让人以为点空了',
        '优化 自检扫出的 14 处「静默吞异常 / 未处理 Promise」清零：该吞的补上为什么吞的注释，该接的补上兜底 —— 都在桌宠渲染与壁纸链路，属于隐患清理',
        '优化 自检页瘦身：体检单只剩一张结论卡（计数与元信息收进卡内），下面挂「查看详细」按钮点开弹窗看全部问题 —— 技术详情、忽略 / 恢复都收进弹窗，不用再滚一屏',
        '新增 体检详情里的问题卡直接附明细：「会话报错」列出具体是哪些会话、报了什么错；「缓存未命中偏高 / 系统提示漂移」直接附上最近的漂移记录（时间 + 会话 + 变更段）—— 不用再按提示去别处找',
        '修复 自检页一批「切个页签回来就点不动」的按钮：哨兵区的刷新量表 / 哨兵分析 / 送去修复，以及模型审阅卡的「让模型自检」和结论过滤 —— 以前只有第一次进页面时绑得上事件'
      ]
    },
    {
      version: '0.4.9.0',
      date: '2026-10-24',
      items: [
        '新增桌宠：桌面右下角住进一个 Live2D 小伙伴（入口：工具 → 桌宠）。单击它弹「今日用量」卡片（花费 / 调用 / 输入输出 / 缓存命中率 / 会话数），双击开开发工单对话窗；置顶、鼠标穿透、大小、透明度、待机动作与表情都能调',
        '新增自己的桌宠角色：桌宠页可导入 Cubism 4 模型，动作组和表情会自动读出来（随包默认角色就是 DS鼠控版，8 个动作组 / 44 个表情；换成自己的模型也一样，动作和表情会自动读出来）。⚠️ 导入前先完整退出应用（含托盘），否则运行中每 5 秒的状态落盘会把新模型覆盖掉',
        '新增壁纸管家：设置 → 外观与数据 → 界面背景 里点「🎨 打开壁纸库」，能换壁纸、调效果（亮度 / 对比 / 饱和 / 模糊）、一键关掉；装了 Wallpaper Engine 还能翻创意工坊的库、换小红车壁纸、控制播放与暂停，也能把当前壁纸设成软件自己的背景',
        '修复 GIF 永远按图片发：勾了「视频输入」也没用 —— 转码要用的 ffmpeg 只在系统 PATH 里找，而包里明明带着一份。现在先找随包那份，实测 96×72 的 1 秒 GIF 能转成 24 帧视频',
        '修复读不出视频时长 / 分辨率：没有 ffprobe 时改用 ffmpeg 自己报的元数据兜底，不再直接放弃',
        '修复更新检查「假装已是最新」：服务器上的版本号没跟着发版更新时，界面以前照样显示「已是最新」，和真的最新分不开；现在会明说「更新源还没推进，所以不会提示更新」',
        '修复桌宠在别人机器上打不开：它之前不在随包清单里，收包的人会被安全闸拦下、显示「触碰了高危能力」；现在已随包登记，换台机器也能直接用',
        '修复自检命令：以前那两条命令指向开发目录，在发行包里必然报错；现在直接跑 tests 下的用例（67 个，含新增的 6 个）',
        '修复群禁言插件的文件指纹与清单对不上（已重算），以及信任清单里还留着一个早就删掉的插件名（已清掉，避免占名绕过安全闸）',
        '修复发布包漏文件：以前包里的内容可能和安装目录对不上（这次就漏了桌宠和壁纸整整两批文件，同版本号却是两份内容）。现在打包后逐文件比对，589 个文件与安装目录一一对应',
        '优化 安装目录名：改为「洛版v0.4.9.0」，和设置页显示的版本号对齐；已有配置、记忆、聊天记录、表情库原样保留',
        '桌面悬浮小窗换了默认档：现在默认就开着，默认「真·透明 + 背景 50%」—— 卡片浮在桌面上、直接看得见桌面（贴边自动收起仍是默认开，拖到屏幕边上会收成一条细缝、鼠标移近即展开）。改的只是默认值，已经用过的老配置保持原样不变',
        '「桌宠」从一级入口挪进了「工具」左栏（和「连接 / 自检」并列）：一级导航从 6 项回到 5 项。桌宠窗口右键菜单里的「打开控制台」、双击角色仍能直接进这一页',
        '修掉「一进自检页就白屏」：体检单的「忽略 / 恢复」那段（已忽略区 + 每条问题上的忽略按钮）在合并时被连带删掉，只剩两处引用，打开就报 ReferenceError。已按原样补回，忽略清单落盘在后端、重启后仍生效',
        '修掉「解禁了机器人还装聋」：禁言复检的几个关键件（60 秒复检间隔常量、强制刷新成员列表的 no_cache、复检翻案与宽限期）也在同一轮合并里丢了，导致复检永远读到旧值、解禁通知一丢就永久装聋。测试从 4 红变成全绿（67/67）',
        '修掉「桌宠一直显示正在加载」：桌面上的角色明明已经出来了，控制台卡片却永远停在「正在加载」、预览也生不出来。根因是主进程取不到桌宠服务（后端有三个访问器没导出），角色反向上报的「已加载」落进了空对象；现在动作预览、表情预览、屏幕观察、单击用量卡片、双击工单全部恢复',
        '另外补回两处被上游旧版整份盖掉的本地改动：桌面悬浮小窗的圆角处理（关掉真透明、改用毛玻璃档时，窗口四角会露出一块深色弧片），和启动失败提示条的「详情」折叠（修好之后首屏只显示一句人话，英文堆栈折在详情里，不再直接甩给用户）',
        '桌宠页重新做了一遍界面：以前那套样式引用的颜色变量在整体换肤时就被删了 —— 边框、圆角、底色全失效，所以这页看着和别的页面格格不入。现在和「连接 / 自检」页同一套版式：顶部的状态信息收成一条细横条（插件 / 桌面窗口 / 当前角色 / 桌宠，正常时不吵、出问题才多一行说明），分区改成带标题线的面板，页内导航滚动时自动高亮，导入角色、找回位置这些按钮都归到各自面板的右上角；所有勾选项也换成了和设置页一样的滑动开关',
        '连接页：连不上时页头就有「重新检测」按钮了（以前唯一的测试按钮藏在折叠的端点设置里，装好协议端只能干等）。状态区改成「一句话结论 + 三行事实 + 折叠的诊断详情」，每种状态直接说下一步该查什么；右边那句和标题重复的"没检测到协议端"换成了检测时间。「装一个协议端」没连上时自动展开、连上后自动收起；两张卡的第 1 步统一成「从官方仓库获取并安装」，都直接给出官网地址；协议端装完要人工把 QQ 接进来，所以两张卡下面都直接给出了控制台地址（SnowLuma 5099 / NapCat 6099），带一键打开和复制'
      ]
    },
    {
      version: '0.4.8.9',
      date: '2026-10-22',
      items: [
        '表情包会自己收图了：以前只有你亲口说「收藏这个」它才收 —— 24 小时群里过了 70 张图，只进了 5 张。现在刷到合适的图 / 表情会主动收下来，「先看图确认」也不再是必做步骤；「确实」「乐了」这种三五个字的短回应，也会顺手配一张',
        '短回应终于等得到那张表情了：「发完就收尾」的省 token 机制会直接掐掉第二轮，表情永远排在不存在的下一轮。现在只对短回应（不超过 10 字）或刚有人发图的情况松一次口 —— 单独给它一轮把表情补上，同一个群 5 分钟最多一次，其余照旧立刻收尾（宽限一次约多花 19K token，所以卡得很紧）',
        '人设预览终于像个正常窗口了：以前点「预览」弹出的是浏览器默认样式的一坨 —— 关闭键是个小灰块、正文是挤在一起的等宽小字。现在是一张正经的浮层卡片，看得清、能滚动，按 Esc 或点外面就关',
        '新增「下载 → 已安装 → 人设」一页：装过的人设终于能看全了。之前装完就找不回来 —— 看不到有哪些、也切不走删不掉；现在能预览、能切换、能删，还能改',
        '人设页和技能 / 插件页长得一样了：同一套网格卡片、同样的说明折叠条和筛选，切过去不用重新适应',
        '会话设置里也能管人设：左栏「扩展」多了第三项。这里看到的是全局人设，卡片上会写明「全局人设 · 所有会话共用」',
        '人设卡上能直接改了：自定义人设右上角有齿轮，改名称、正文、附加规则都在一个弹窗里，支持把 .txt 拖进去。内置人设改不了（正文写在程序里）',
        '人设同时只能用一个：开一个会自动关掉另一个，并明确告诉你「某某已自动关闭」—— 以前两个开关能同时亮着，看着像能同时启用',
        '换人设会把它自己的附加规则一起带过去：以前只换了角色设定，上一个人设的「管理员附加规则」会残留下来，两套设定串在一起',
        '切换不生效时会说清原因：分会话单独配过人设的、开了主人专属人设的、覆盖了系统提示词却没留占位符的 —— 这三种情况以前切了没反应，现在页面顶部会直接点出来',
        '插件和技能页能按来源筛了：内置的、自己后来装的，一眼分开',
        '点「下载」不再卡一下：市场页每次切回来都整页重建几百张卡，现在数据没变就不重建，切页几乎瞬间',
        '装完插件不用重新往下翻了：列表不再被弹回顶部，你正在看的位置保持不动',
        'SnowLuma 的日志不再自己往下跑：以前每 15 秒刷新一次就把你拽到最底下，正在读的那一行瞬间不见；现在刷新只更新内容，位置不动'
      ]
    },
    {
      version: '0.4.8.8',
      date: '2026-10-22',
      items: [
        '修掉「机器人明明记得，问它却检索不出来」：分层记忆的词表被硬卡在 2 万词，而被挤掉的恰好是中文里最常用的实词 —— 群友天天聊的东西全在裁剪名单里，检索自然搜不着。三处根因一起改：短词剪枝不再误伤中文、超上限时优先淘汰「区分不出内容」的词、群号和日期这类每个块都带的碎片不再占词表位置。词表从 2 万回到 2.7 万，中文单字从 0 回到 2126，同一批问题的检索从 0/5 命中变成 5/5。另外设置页现在能看到记忆整理相关的 4 个阈值了（以前只写在代码里，界面上找不到）',
        '修掉「重建一次记忆索引，机器人对老熟人的印象就全没了」：块目录名和内部记录用的键格式不一样（一个下划线、一个冒号），重建脚本按目录名传进去时查不到旧记录 —— 熟悉度、提及次数、关系强度全部静默退回初始值，还不报错。现在两种格式都认，实测 52 个块的权重逐块还原',
        '修掉「模型配置里换了 API Key 却不生效」：同一个弹窗里「清除」写的是提供商槽位、「保存」却写到顶层字段，而运行时的优先级是槽位高于顶层 —— 于是清得掉、换不掉，界面显示新 Key、请求还在用旧的（一直 401）。现在保存也写槽位，改完重启生效',
        '修掉回复整句被方括号包住：上下文里 [图片] [表情] [引用…] 这些系统标记太密集，小模型会照猫画虎把自己的整句也包一层；现在提示词里立了规矩，发送前还有一道兜底 —— 只剥「整条恰好是一对方括号」且不超过 60 字的那种，句中括号和 CQ 码一律不动',
        '修掉合并转发的聊天记录点开是空的：QQ NT 里转发消息的 id 常是负数，以前把负数直接丢给协议端会被当成另一个 id 去拉、报「payload 为空」；现在先取原消息、从转发段里抠出它自带的 id 再拉，正负都能用。引用别人的转发时也不会再撞一句看不懂的报错 —— 以前引用块里显示成英文的 [forward]，模型以为还有条转发没展开、回头去拉那条引用消息、必然失败；现在引用里直接写明「合并转发聊天记录」并把那条转发的编号带在引用块里（`[引用 #1234567890 名字：…]`），想看全就展开这个号；真拉错了也会直说「这条不是转发」，展开后转发里的图会一起给出来（最多 4 张），不会只剩一排 [图片]',
        '修掉设置页弹窗「点了没反应」：白名单里挑完群点确定，界面没动静、群里也没加上 —— 弹窗背后的提示节点会随设置页重渲染消失，旧代码往一个已经不存在的元素写文字，抛错后整段流程就断了；现在提示写不进去就直接跳过，目标输入框也会在点击那一刻重新确认，真找不到就明说「回白名单页签再点一次」',
        '修掉「两个号同时被注入也不管」：以前「只给一个号装注入」只是说明里的一句话，真检测到第二个号也被注入时不会有任何动作；现在会立刻处理，并说清楚是哪个号抢了端口、该保留哪一个',
        '省下三处白花的钱：① 系统提示里每轮都会变的那几句不再顶掉前缀缓存，命中率从 79–86% 回到 92% 档；② 启动预热不再重复发一遍、白占上游并发位；③ 发完语音 / 图片 / 跨会话消息后不再多跑一轮收尾，每句省约 19K token',
        '雪茹的两处日志问题：日志总量收到 256 MB、只留 3 天，不再越跑越占盘；设置里填的目录实际不存在时，日志里会直接说明白，不再只是静默不记',
        '修掉安装包的三个问题：① 超 4 MB 的图要先压缩，以前在新装的机器上这一步会静默失败（既发不出去也不报错）—— 现在 ffmpeg 随包分发，装完即可用，不用自己另外装；② 不再多带一份安装器备份，装完的目录更干净；③ 打包前自动体检（依赖是否齐全、该随包的文件在不在、有没有残留的备份 / 崩溃转储 / 锁文件）。代价是安装包从 166.8 MB 涨到 186.3 MB',
        '20 日那个 0.4.8.7 安装包打在上面几处修复落盘之前，装过旧包的覆盖安装即可补齐',
        '被 @ 不再装没听见：机器人以前经常认不出群里 @ 的是自己（群名片、QQ 号、角色名对不上就直接跳过）。现在系统提示里同时给出这三个锚点，每条被 @ 的消息还会标注「这一条 @ 了你本人」；同时修掉一个硬伤 —— 被点名时它若想直接结束对话，以前会拦下一次却仍然结束、群里什么都不回，现在拦下后会真的再走一轮（同一句话实测：以前静默，现在正常回复）',
        '「嘴上说了发表情、实际只发了文字」修好了：以前提示它先发文字、再单独发表情，而分两轮会被「发完就收尾」的逻辑砍掉第二句；现在文字和表情放进同一次调用里一起发',
        '发表情频率按库存自适应：库里 0 张就不再承诺发表情（空库时提示词会明说别答应）；1–3 张每 3–5 轮 1 张、4–9 张 2 张、10 张以上才按你的配置档 —— 不会再出现素材只有一两张却被反复点名去发',
        '收藏表情能带标签和用途了：收藏时顺手填 note / tags / usage 三样，之后挑选时按标签挑得更准；重复收藏会覆盖旧标签，已收藏的不会自动补',
        '自动修复不再「改到一半死透」：以前一个工单的批准票只能用一次 —— 应用失败或回滚后再申请必然被拒，而提交又要求先验证通过，工单直接卡死。现在验证失败 / 回滚后会自动重新发批准票，暂存区保留可以重跑；提案在批准之后又被改动也会明确提示，而不是静默失败',
        '四个开发类工具搬进软件本体：系统自检 / 自动修复 / 扩展锻造 / 开发工单不再是「插件」，不在插件列表里显示、也不会被误卸载或误禁用。代价是这四个模块改完不再即时生效，需要重启应用；左栏「工具」二级页签名也改回 harness（这一页已经是自检 / 对话审查 / 自动修复 / 锻造 / 工单五块的工作台，叫「自检」名不副实）',
        '自动修复的开关找到了：内置化之后开关不在插件页，「自检 → 自动修复」页的未启用状态里现在直接给「开启自动修复」按钮，写活配置、不用重启；页面里那些「去插件页找它」的过时指路也全部改掉了',
        '视频抽帧 / 视频理解修好：安装包里明明带了 ffmpeg，插件却只在系统 PATH 里找，于是一直报「未找到 ffmpeg」。现在优先用随包的 ffmpeg.exe，装完即可用，不用自己另外装',
        '语音消息不再「时好时坏」：探测期间的状态以前会被乐观放行，每 60 秒翻转一次，系统提示里的「语音消息」段跟着反复增删 —— 这一项实测占掉全天约 28% 的缓存 miss（约 15 万 token）。现在探测期间一律显示不可用，状态稳定；要真正用上语音转文字，还需在设置里填模型文件路径',
        '密钥读取不再「同源就能读」：以前伪造一个同来源的请求头，就能把控制台密码明文读出来。现在密钥类接口一律拒绝（除非在配置里显式打开），配置接口里的 Key 也已脱敏；实测无凭据 / 伪造同源 / 跨源三种来源全部被拒',
        '接口报错不再冒充 502：模型没配 Base URL、人格市场传了不存在的 id，以前都返回 502（看着像服务端坏了），现在返回 400 / 404 并说明原因',
        '被 QQ 拒发的消息现在记进用量账本：以前拒发的消息在应用日志和用量统计里都看不到（错误计数恒为 0），只能翻协议端日志；现在按调用计数记进去',
        '本版发布前做了 774 项全量体检（代码 / 加载 / 基线 / 数据 / 日志 / 外部服务 / 安全），发布包也做了泄漏扫描 —— 密钥、群聊记录、协议端凭据均确认未随包分发；从 10-21 的记忆检索与安装包修复，到今天的被 @ 回复、表情策略、自动修复与内置化，全部并入 0.4.8.8 这一条'
      ]
    },
    {
      version: '0.4.8.7',
      date: '2026-10-20',
      items: [
        '新增「卡住了？自助排查」卡片：卡在「机器人连接中」满 20 秒就自动出现，按现场分四种情况 —— 没指定机器人的号 / 指定的号没登录 / 注入装好了但网关没起来 / 网关没跑 —— 每种给一句话说明和一个能直接点的按钮，点一下就把那个号接上，或者只重启网关',
        '新增「🛡 安全开关」（工具与技能页）：浏览域名白名单（锁定后只允许访问名单里的站）、允许图片下载走内网地址、额外放行的主机 —— 这三项以前只有配置文件里有，界面上根本找不到；域名写成「https://xxx/路径」会自动裁成主机名',
        '新增「允许机器人发送网图」勾选框（设置 → 聊天 →「📨 信息发送配置」）：它是发图与搜图的安全总开关，和「工具与技能」里的工具开关不是一回事；总开关关着时那两张工具卡上会直接提示还差这一步，不用等调用失败才知道',
        '新增桌面悬浮小窗：桌面右下角一张小卡片，显示今日调用 / 估算成本 / 总 Token / 缓存命中率 + 机器人连接状态；可拖动、三档尺寸、可置顶、可鼠标穿透，右键菜单改成卡片内自绘的深色菜单，不再是系统白底菜单',
        '新增「贴边自动收起」：小窗拖到屏幕任意一条边 6px 内就收成一条细缝，鼠标移近整卡弹回原位、移开又滑回去（和 QQ 一个手感）；重启后仍是收起状态',
        '新增「背景不透明度」滑条：30%~100%，默认 100% 就是原来的深色小卡；调到 100% 以下变成半透明磨砂，拖动时卡片半秒内跟着变色，设置页和小窗右键菜单里都能调',
        'SnowLuma 页重新排过：首屏按钮从 18 个降到 8 个，控制台地址 / 密码 / 重置密码 / 连接排查 / 三块日志全部收进两个折叠区（出问题才需要展开）；节点名和按钮全换成动作句 ——「单独启动 QQ」改成「启动机器人的 QQ」、「切换到此账号」改成「就用这个号」、「仅保存」改成「先记下」、「取消注入」改成「停止接入」',
        '设置页的静默保存终于有反馈了：页头右侧出现 2.4 秒后淡出的「✓ 已保存 08:58」，失败时是红色「保存失败，正在重试…」，不弹框、不占位',
        '技能页从别的页签点「下载」不再空一下：有缓存时直接出完整页、不再先画骨架再重画，只有接口真慢（超过 120ms）才补骨架',
        '市场页等待超过 6 秒会把副标题改成「线路较慢，仍在等…（最长约 2 分钟）」，不再让人以为卡死',
        '市场列表加了本机缓存（内存 5 分钟 + 磁盘 24 小时）：再次进市场页多数情况立刻出内容，后台再悄悄换新；只有点「刷新」才强制重拉',
        '「仅保存」的提示说清当前状态：下次启动生效、现在仍按原来的号跑，要立刻切过去请点「就用这个号」',
        '「本机 QQ」模式的说明改成能兑现的话：只向这个号装注入、不会主动注入别的号，请确认它是机器人专用号；顺手删掉页面下方重复的第二处承诺',
        '修掉「连着个人号却显示一切正常」：以前只看“连上了没”，多号在场时谁抢到端口就是谁；现在用真实登录号与设置对账，连错号会橙色告警，并自动把抢占端口的号卸掉（卸不掉就明确让你重启那个 QQ）',
        '修掉切号时配置被提前写脏：填一个格式对但没登录的号点切换，接口报错但设置里已经记成它，之后每轮自动注入都空转；现在目标确认存在才落配置',
        '修掉「点了停止接入却照样被注回去」：网关没跑、登录失败、当前没有已注入进程这三条路径以前都不记「已暂停」，QQ 一重登又被注入',
        '修掉同一个 QQ 被连续注入两次：注入标记刷新慢于接口返回，旧判据会让同一进程被连续载入，轻则重建会话、重则丢消息',
        '修掉「重置控制台密码说成功其实没成」：停网关失败仍会删配置文件、随后新密码并没写进去，界面却报「✓ 已重置，密码：xxx」；现在端口没释放就中止，重置后先用新密码真登一次才报成功',
        '修掉切号后要等十几秒才连上：网关的令牌按 QQ 号分文件存，切号后旧令牌必然被拒；现在切号成功即按目标号对齐令牌并立刻重连',
        '修掉「被临时锁定」被说成密码错：连错 5 次网关会锁 15 分钟，以前和“密码被拒”共用一套话术、还劝你去重置（重置会重启网关、断开注入）；现在单独说明并劝你别重置',
        '修掉令牌过期被报成「进程表是空的（QQ 还没登录）」：鉴权失败的响应被当成正常数据用了，错误分支永不触发；现在一律按读取失败上报',
        '修掉网关快速重启后要等 30 秒才恢复：端口“关→开”这条变化在已连接时被吞掉，恢复只能等连接超时；现在一发现就立刻重连并补一次自动接入',
        '修掉「测试连通性」恒报 401：那个请求根本没带鉴权信息，Key 对不对都回 401；同时修掉在弹窗里挑别家模型时、服务端仍按主提供商协议去请求的问题',
        '修掉非 OpenAI 协议的「能不能看图」永远探测不出来：探测请求被写死成 OpenAI 形态，Claude / Gemini 一律 404 判成“未知”，看图工具因此被永久关掉；现在按各家自己的协议发',
        '修掉启动后 2 秒内设置页必崩一次（右下角红条「Cannot read properties of null」）：首次进设置页时状态还没到、页面读了个空值；现在状态未知时显示「正在读取机器人连接状态…」，不再误报“机器人没连上”',
        '修掉「API 协议选了保存不住」：保存一直是成功的，是保存后整页重建时下拉被缓存里的旧值回填；现在以刚写入的值为准',
        '修掉一批「保存不住」的同类问题（全站复查 9 处）：滑条松手后回弹、开关关掉又自己亮、输入框自动保存把刚打的字冲掉这类时序问题',
        '修掉 17 处「指到不存在页面」的提示：「设置 → 插件」「设置 → 模型价格」这些入口早就没了，模型报错和插件提示却一直往那儿指；现在全部指到真实位置',
        '修掉「发网图」的报错指错地方：它说去「设置页聊天设置 → 发网图」打开，而那个开关界面上根本没有；现在文案和真实入口一致',
        '修掉市场页「有时候加载不出来」：前端 15 秒就放弃而后端还在正常拉（现在前后端一并放宽到约 2 分钟）；响应体没读完时不再被当成“市场是空的”（以前会显示「共 0 个」）',
        '修掉「输入完 QQ 号连按两下回车会切两次号」：回车是第二个入口，绕过了按钮置灰；连着切两次会让同一个 QQ 被注入两遍、会话重建、可能丢消息',
        '修掉市场页每次进来都要重新拉一遍列表：上次留下的缓存时间戳被当成“刚拉的”，一进内存就过期；现在切页签不再白等一分半',
        '修掉装完插件点「刷新」还显示旧列表：刷新时若正好有条请求在途，界面会复用那条旧结果；现在刷新会作废在途请求',
        '修掉小窗「贴边收起又自己弹回来」：拖到边上松手时光标还停在判定区里，0.1 秒就被判成“鼠标移近”；现在收起后要先见到光标离开才允许悬停展开',
        '修掉小窗「鼠标移开不收回」：悬停展开的卡片现在鼠标移开就滑回细缝；从细缝拖出来的、菜单点开的则不会自己收走'
      ]
    },
    {
      version: '0.4.8.6',
      date: '2026-10-19',
      items: [
        '连续对话更省也更稳：系统提示里每轮都会变的那几句（当前场景、时间、上一条消息等）挪到了大段固定内容之后，前面的人设、插件与工具说明不再被它顶掉，能一直命中缓存；实测每轮被全价重算的部分缩到原来的二十分之一以内，聊得越久省得越明显',
        '修掉「调用明细只算最近几个小时」：弹窗写着「近 7 天」，实际只扫了最近 120 个会话文件（活跃时仅够几小时）—— 现在工具调用次数也会按天记进账本，被裁掉的老会话照样计入合计，近 7 天 / 近 30 天不再只剩今天',
        '四个统计维度（按天 / 按会话 / 按模型 / 按插件）版式统一：都是「标题 + 右侧计量 → 一行说明 → 一句结论 → 图表 → 折叠数值表 → 口径说明」，切换维度不再像换了一套设计；每块还会用一句话点出结论，比如「用量集中在哪一天」「主力是哪个模型」',
        '新增「API 协议」选择：添加或编辑模型提供商时，可以直接选 OpenAI Chat Completions / OpenAI Responses / Anthropic / Google / Mistral 五种协议，不用再靠中转站猜格式；地址留空会自动填上官方端点，测试连通性和实际对话走的是同一套协议',
        '新增网络代理：接入国外模型 API 时可以在设置里填本机代理（支持 http://），对话、拉模型列表、测连通性统一走代理；填了不支持的 socks5 会明确提示，不会装作已经生效',
        '新增「按插件」用量统计：能看清每个插件 / 技能到底花了多少 token —— 支持按「区间总消耗 / 每次固定开销 / 调用次数」三种方式排行，也能看到每次对话新进来的正文（聊天记录、人设等）占了多少',
        '新增扩展安装前体检与装完回执：清单 JSON 写坏、要求比本机更新的版本、声明的入口文件没打进包里 —— 这三类「装完一定不能用」的包现在会在安装前直接拦下，磁盘上不会留下垃圾目录；装完的提示也分成「已生效 / 已加载但当前关闭 / 加载失败」三档，不再一律说成功',
        '扩展卡片多了几种状态提示，以及一个「🔧 自动适配」按钮：「已熔断」表示工具连续失败被临时停用（几分钟后自动恢复）、「工具被关」表示工具全部进不了模型列表、「⚠️ 有警告」指放错目录或没写引导语这类「装了却没人调用」的问题；加载失败或反复出错时可以一键送进升级工作台，模型按你本机环境改好、你确认后才覆盖安装，原版自动备份、可回滚',
        '设置页的「就绪度体检」回来了：没填接口地址、没选模型、白名单空着时，设置页顶部会主动列出缺什么、点一下直达对应位置；全部就绪后自动收起，不打扰老用户',
        '启动等待改成按 24 分钟硬时间算：以前按轮数估算，遇到端口直接拒绝的情况 4 分钟就放弃，和「后台仍在重试」的提示对不上',
        '「OneBot 未连接」的横幅上多了「打开 SnowLuma 页」按钮：以前只有一行字，想处理还得去顶栏悬停找入口',
        'SnowLuma 页每 15 秒自动刷新时，不再吃掉你手上正在做的事：注入目标的 QQ 号打一半不会被重置、展开的账号列表不会自己收起、密码的显示状态和折叠块状态都会保留，光标也不丢',
        '插件装多了以后聊天不再突然变慢变贵：工具列表的频繁抖动会在 90 秒内折叠成一次变化，不会每次都把提示词缓存整段作废（实测一天抖 7 次，每次多付 1.5~2 万 token）；你自己手动开关插件仍然立刻生效',
        '修掉两类「插件明明开着，模型却调不到工具」：收藏表情的工具实际名字和提示词里写的不一致，模型每次调用都报「未知工具」（顺带补上了收藏引导，以前策略里只字未提）；带前缀的工具用短名调用现在也能自动兜底匹配',
        '修掉「好几个群友同时 @ 会漏回一个，有时还 @ 错人」：被 @、被点名、被引用提问现在按硬召唤处理，优先级高于人设里「少而精 / 挑着接」的风格要求，点名的每一条都必须回应；多人同时叫时要分别回给每个人，各自带上对方的 QQ 号；另外加了一道保险 —— 被 @ 且还没开口时，不能直接「结束本轮」混过去',
        '新增「使用引导」：第一次打开软件会自动弹出四步上手引导（配模型 / 连 QQ / 选会话 / 定人设），每步带实时完成状态 —— 配好一步就自动变绿，不用猜还差什么；随时能关掉，关掉照常进会话，不拦路也不强制跳设置页',
        '引导里点「去配置」会直接把对应的配置窗口弹出来（模型管理 / 人设编辑），省得在设置页里找不到那颗按钮；设置页侧栏留了「使用引导」入口，想回来看随时能看',
        '表情库里的表情可以自己改备注和标签了：点开表情详情直接编辑、保存，不用再让机器人在聊天里替你改',
        '修掉「Ctrl+V 时灵时不灵」：人设编辑、模型管理、社区口令粘贴都有这个毛病 —— 根因是粘贴前焦点停在只读的选择框上，按键被系统静默吞掉；现在粘完会把焦点交还给可编辑框',
        '编辑人设 / 模型这类弹窗，点窗外不再直接关闭了（误触丢内容太伤），右上角 ×、取消、Esc 照常能关',
        '配好提供商后不用再自己收尾：加完、拉完模型会自动刷新列表（不再显示「还没有提供商」），只有一个模型时直接帮你选上、多个才让你挑，新手引导也不会再卡在这一步不变绿',
        '模型报错终于说人话了：限流、Key 无效、余额不足、服务商故障、模型不存在、接口地址填错，都会给一张中文卡片讲清「发生了什么 + 该怎么办」—— 以前这些提示规则写好了却从没被调用过，你看到的始终是一串英文原文',
        '修掉「机器人思考了但没回话」：模型偶尔会把要说的话当成没加引号的参数塞进发送工具，导致整轮作废、群友什么都没收到 —— 现在会把这段话捞回来再发，实在救不回来才报错，不会凭空发错内容',
        '修掉「查看收藏的表情」打不开：插件自带的页面被安全策略挡掉了',
        '修掉添加提供商后模型名被存成一串编号：名字缺失时不再拿编号顶替',
        '默认人设「小鲸鱼」整体重写：群友反馈旧版怼人太厉害，这次降了攻击性、篇幅也砍了一半；存过旧版全文的老配置会静默换成新版，但你自己改过的人设一个字都不动',
        '修掉切换人设后被系统提示「压回去」：系统提示里写死的角色扮演已经全部搬进人设卡，切谁的卡就是谁，不会再左右脑互搏',
        '修掉「使用引导」的两处小毛病：用现成模板（含内置默认的小鲸鱼）不再被误判成「已自定义」；再次打开时步骤区也不会一片空白',
        '会话记录里能一眼看出错在哪了：模型报错会连同中文解释一起写进摘要，重启软件、从磁盘重建列表也不会丢',
        '顶栏四个就绪圆点会说话了：没就绪的会在旁边补一个红色缩写（⚠QQ / ⚠SL / ⚠OB / ⚠配置），不用把鼠标挪上去也知道缺哪一项；用你自己登录的那份 QQ、或挂外部 OneBot 的情况，不再误亮红灯',
        '「工具」入口默认先进 SnowLuma：新手点「工具」绝大多数是去启动 / 登录机器人 QQ，自检和对话审查属于进阶排查，顺序调过来了',
        '设置页顶部那两行说明不再天天占地方：第一次照旧完整显示，点「知道了」就收成一行，之后一直保持',
        '扩展页不再把「正在加载」显示成「一件都没装」',
        '内置插件 / 技能的默认顺序按重要性排了：以前按文件夹字母序，把账号池、前缀缓存这类核心项顶在最前面反而看不出重点；你自己拖过的顺序仍然优先',
        '市场页装扩展前加了常驻提醒：插件越多 token 用量越高、缓存命中率越低；本版已自带用量优化，不要再装同类的用量优化插件 —— 两者会冲突，导致都不生效',
        '修掉鼠标悬停在按钮上冒出两个提示窗口的问题：一个是软件自己的气泡、一个是系统的淡黄色小框；根因是提示文字挂在了外层容器上，而且状态刷新会把它重新写回去',
        '修掉几处界面小瑕疵：消息存档页和记忆页左栏多出来的一圈细边框（右缘一条竖线 + 上下圆角），设置里较长的标题被挤成两行',
        '更新报告本身也重排了：条目按「新增 / 优化 / 修复」分组、引号里的关键词加粗、旧版本收起成一行点开再展开；标题栏滚动时吸在顶部，条目再多也知道在看哪一版',
        '表情库顶部按钮换成图标：「重新载入」四个字挤在统计后面太占地方',
        'Windows 下任务栏 / 桌面图标优先用 .ico，显示更清晰',
        '退出时的兜底更稳：单实例提示失败也不会卡住退出'
      ]
    },
    {
      version: '0.4.8.5',
      date: '2026-10-17',
      items: [
        '自动注入的核心死锁修好了：注入成功过一次后，协议端一重启就再也不自动恢复，机器人永久掉线、界面却只显示「取消注入」—— 现在会自己重连重注入，不用重启软件',
        '「连不上」不再被当成「密码错了」：以前会白等 15 分钟、还劝你去重置密码；现在能分清是连不上还是真被拒，直接给出下一步',
        '自动注入失败后想手动注入：SnowLuma 日志里现在直接给出控制台地址、密码和三步操作；密码读不到时也不再整块消失，会给「重试」',
        '控制台里密码、配置等 7 个接口集体「读取失败」已修：根因是一处鉴权判断写错，最强的那个凭据从头到尾没被读到过',
        '密码框那团「糊掉的色块」已修：提示文字被密码遮蔽样式糊住了 —— 只有真密码才该遮蔽',
        '修掉几处会让软件自己退出或假死的问题：连接卡在半路时主进程崩溃、请求协议端没有超时、并发登录撞上「错 5 次锁 15 分钟」',
        '开箱可用：全新安装默认自动拉起协议端；启动时不再 30 秒就误报「连接超时」，等待窗口更合理',
        '记忆系统瘦身：索引里八成是重复抄写的块 id、落盘还带缩进 —— 同样的两份索引 3.6MB → 1MB，整个记忆目录 4.9MB → 2.3MB；召回门槛一个没动，命中率不受影响',
        '升级残留自动清理：旧版记忆插件覆盖安装后会留在磁盘上，和新记忆系统打架（重复注入、检索到旧数据）—— 现在启动时自动识别并清理',
        '用量页不再崩溃（一处空数据解引用）；「清空已结束会话不影响用量历史」这句提示以前是假的，现在按天汇总真的保住了，只有逐次明细会随文件消失',
        '聊天记录保存更快：以前每来一条消息就把整个会话文件重写一遍，聊得越久越卡',
        '界面某一块出错不再整页卡死：前端加了全局兜底，单个脚本异常不会拖垮其它功能',
        '还有一批稳定性修复：删了人设后残留旧人设、启动项重复、锁冲突被误报成「启动失败」、退出清理卡住会超时兜底、磁盘写满提前提示、日志不再明文记密钥',
        '插件和技能会真正「记住」你的选择：你关掉的，重装、升级或重置之后也不会自己跳回开启；你开着的，也照样是开着的（默认关闭 6 个 / 默认开启 8 个，可在设置里逐项确认）',
        '拍一拍更准了：修掉机器人被拍时文案写错、喊它没反应的问题；群友名字以「我」开头时也不会再认错成在拍自己',
        '修掉群被移出白名单后机器人仍在该群发言：以前设的提醒到点不再发，聊到一半被移出也不会再回复',
        '修掉「活跃设置」里的禁言指令不生效：禁言期间机器人不再条条都回，冷场也不会主动开话题',
        '修掉切换人设不成功：保存新人设不再被旧设置覆盖，写好的「管理员附加规则」也不会再被悄悄抹掉',
        '新增 QQ 版本核对：启动时自动比对 QQ 版本和协议端是否匹配，不一致会明说下一步怎么办，不再只报「登录被拒」让人干猜',
        '表情更积极了：默认积极程度提到最高档，回应「表情包发送概率太低」的反馈',
        '会话选择页新增左栏搜索：搜会话更快，样式与主界面左栏统一',
        '修掉让机器人翻旧记录时拿到重复内容的问题',
        '修掉从 GitHub 下载的插件带多层文件夹装不上的问题（会自动找到真正的插件目录）',
        '修掉只配置了群白名单时、机器人可能给陌生私聊发消息的越权问题',
        '峰谷计价配置不全时按最保守的档位计费，不再误按最贵的档位',
        '指令禁言后，状态卡片会立刻刷新，不用猜指令到底生没生效',
        '人设摘要卡现在会提示「分会话独立人设 / 主人专属人设」这两个会盖过全局人设的隐形层，切换不生效有据可查'
      ]
    },
    {
      version: '0.4.8.4',
      date: '2026-10-15',
      items: [
        '表情包独立成插件了：插件页新增「表情系统」卡片，开关和设置（积极程度、提示词里列举的数量、收藏上限等）都收在这一张卡里',
        '新增「表情库」界面：在「表情系统」设置里点「查看收藏的表情」就能打开 —— 可以搜 id / 备注 / 标签，按「用过 / 有备注 / 本地转存」筛选，点开看大图和完整备注',
        '表情可以删了：不想要的表情能让机器人干脆删掉（删掉后不再出现在表情列表和提示词里，也不会再被发出去）；删错了随时恢复，备注和使用次数都还在',
        '「分层记忆（增强版）」更名为「记忆系统」，并改为随包内置 —— 插件页里显示的新名字就是它',
        '注入全自动了：登录机器人 QQ 后自动完成注入并连上，不用再进控制台手动点「进程注入」',
        '只注入机器人那份 QQ：可填机器人 QQ 号或从已登录 QQ 里点选；不填也能自动识别，个人 QQ 不受影响',
        '机器人 QQ 号自动记住：首次注入成功后下次直接用，不用重复填',
        '控制台密码不用管了：自动接管 SnowLuma 控制台密码；忘记密码点「重置并接管」一键找回',
        '新增「取消注入 / 重新注入」：取消后重启也不会自动注入，点「重新注入」随时恢复',
        '登录后连接更快：修掉了登录后要空等一轮重试才连上的问题',
        '修复：人设市场拉不到列表、下载人设失败的问题',
        '「选择会话」列表与全屏会话选择页风格统一，带头像显示',
        '连续对话时回复更快：前缀缓存保活默认开启',
        'SnowLuma 升级到 1.14.22',
        '界面文字修正：修掉一批显示成 **星号** 的加粗标记、缺字与重复文案'
      ]
    },
    {
      version: '0.4.8.3',
      date: '2026-10-14',
      items: [
        '启动卡住不再无解：超过 45 秒连不上后端，会弹出「启动失败」卡片，写明原因和实时日志，并带「重新加载界面 / 打开日志目录 / 复制错误详情」三个按钮，方便定位',
        '后台持续重试：失败卡片弹出后程序仍在后台轮询，后端一旦恢复（慢机器建完索引、OneBot 连上、网络抖动恢复）会自动继续，不用手动刷新',
        '分清两类故障：现在能区分「端口根本没起来（被杀软拦了 / 端口被占）」和「服务在跑但还没就绪」，提示和排查方向不再混为一谈',
        '「重新加载界面」按钮加了 6 秒冷却，防止手抖连点把刚起来的页面又刷掉',
        '启动日志更详细：控制台服务每步耗时（端口监听 / 技能加载 / SnowLuma 拉起 / OneBot 首连）都会记下来，卡在哪一步一目了然',
        '修复：整理群记忆期间，记忆页左侧列表点不动的问题（列表被每秒整体重建，点击经常落空）',
        '修复：从没整理过记忆的群在记忆页里找不到、也就没法整理 —— 现在聊过的会话都会出现在记忆页，点开就能「整理本群记忆」',
        '「OneBot 连接」说明补充：长时间连不上时，点 SnowLuma 节点里的控制台链接打开 WebUI 手动注入一次即可'
      ]
    },
    {
      version: '0.4.8.2',
      date: '2026-10-14',
      items: [
        '会话列表不再自己乱跳：你手动点开某条会话或往上翻记录时，自动滚动会先让一让，不会硬把你拽回底部',
        '追最新消息时右栏只更新有变化的那几张卡片，不再整块重刷，滚动位置也不会被顶回去',
        '已经展开的会话卡片不会被自动收起，切走再切回来仍然保持展开',
        '修掉了会话卡内容偶尔「张冠李戴」（A 会话的卡片显示成 B 会话的内容）的问题',
        '设置页切换分区时不再闪一下'
      ]
    },
    {
      version: '0.4.8.1',
      date: '2026-10-14',
      items: [
        '修掉了一批会导致闪退、窗口自己消失、任务栏闪烁、卡住不动的问题',
        '全 App 的动效统一成一套：按压、悬停、切页、弹窗、列表逐个入场都有明确手感',
        '各个界面的左栏统一成一套：左右留白、分隔线、选中卡片、首个选项卡的位置全都对齐，每行开头多余的蓝点也去掉了',
        '插件更好找了：下载页左栏拆成「市场 / 已安装」，装完的插件卡片上直接点「管理」就能跳过去开关',
        '下载页滑动浏览插件不再卡顿',
        '键盘 Tab 切到输入框时能看到焦点框了',
        '设置页切换分区时有了弹出动画',
        '「更新报告」这张卡片可以关掉，关掉后这个版本不再弹出来'
      ]
    }
  ];

  (function renderStageReport() {
    var host = document.querySelector('#view-sessions .stage-empty');
    if (!host || !STAGE_CHANGELOG || !STAGE_CHANGELOG.length) return;
    var escHtml = (typeof esc === 'function') ? esc : function (s) { return String(s == null ? '' : s); };

    /* r134（2026-10-18）：卡片重排 —— 之前 30 多条混排成一堵灰字墙，扫不出重点：
       ① 条目按开头动词自动归入「新增 / 优化 / 修复」三组（渲染层分类，
         STAGE_CHANGELOG 不用贴标签；分不进前两类的都算优化，例如
         「默认人设…」「Windows 下…」「表情更积极了」—— 分组是扫读辅助，不求完美）；
       ② 引号「」里的短词（问题名 / 功能名）加粗当扫读锚点，超过 24 字的引号
         多半是整句话，不动；
       ③ 旧版本（第 2 版起）默认折叠成一行版本号，点版本行展开 —— 99% 的用户
         只看最新一版，不该被迫滚过五个旧版本；展开状态只活在本次会话
         （报告本身是常驻卡片，展开与否不落盘）。
       ④ 2026-10-23：没完成启动引导的用户（config.onboarding.seen !== true，
         读法照 18-onboarding.js 的 onboardingNeedsShow），**最新一版**也默认折成
         一行「本版改了 N 项改进，点击展开」—— 萌新的首页不该一上来就被十几条
         改进砸脸；已完成引导的老用户仍默认展开（与 r134 行为一致）。 */
    function classifyItem(text) {
      if (/^新增/.test(text)) return 'add';
      if (/^(修掉|修复)/.test(text)) return 'fix';
      return 'opt';
    }
    var GROUPS = [
      { id: 'add', label: '新增' },
      { id: 'opt', label: '优化' },
      { id: 'fix', label: '修复' }
    ];
    function emHtml(text) {
      return escHtml(text).replace(/「([^「」]{1,24})」/g, '「<strong>$1</strong>」');
    }

    var rows = [];
    for (var i = 0; i < STAGE_CHANGELOG.length; i++) {
      var e = STAGE_CHANGELOG[i];
      if (!e) continue;
      var items = [];
      for (var j = 0; j < (e.items || []).length; j++) if (e.items[j]) items.push(e.items[j]);
      if (!e.version && !items.length) continue;
      rows.push({ version: e.version, date: e.date, items: items });
    }
    if (!rows.length) return;

    // r106：用户点 × 关掉之后，同版本不再出现（换了新版本自动再出现一次）。
    // 2026-11-05：stamp 从「只认 version」改成「version|date」—— 同版本号内
    //   更新报告内容（改 date）时也重新出现一次，否则点过 × 的用户永远看不到
    //   这次合并精简后的新条目。发版频率低，多弹一次可接受；两者都空则不记忆。
    var stamp = String(rows[0].version || rows[0].date || '');
    if (rows[0].version && rows[0].date) stamp = rows[0].version + '|' + rows[0].date;
    if (stamp) {
      var closed = '';
      try { closed = localStorage.getItem(REPORT_KEY) || ''; } catch (e) { /* 隐私模式 */ }
      if (closed === stamp) return;
    }

    var h = '<div class="sr-head"><span class="sr-title">更新报告</span>' +
            '<span class="sr-sub">本版改了什么</span>' +
            '<button class="sr-x" id="stage-report-close" type="button"' +
            ' title="关闭更新报告（这个版本之后不再弹出）" aria-label="关闭更新报告（这个版本之后不再弹出）">' +
            '<svg viewBox="0 0 20 20" aria-hidden="true">' +
            '<path d="M2,0 L0,2 8,10 0,18 2,20 10,12 18,20 20,18 12,10 20,2 18,0 10,8 2,0Z"' +
            ' fill="currentColor" stroke="none" /></svg></button></div>';
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      var foldable = k > 0;
      h += '<section class="sr-ver' + (foldable ? ' sr-ver--old' : '') + '">' +
           '<div class="sr-vh' + (foldable ? ' sr-vh--toggle" role="button" tabindex="0" aria-expanded="false' : '') + '">';
      if (foldable) h += '<svg class="sr-caret" viewBox="0 0 10 10" aria-hidden="true"><path d="M3,1 L8,5 3,9Z" fill="currentColor" stroke="none"/></svg>';
      h += '<span class="sr-vn">' + escHtml(r.version ? ('v' + r.version) : '') + '</span>' +
           '<span class="sr-vd">' + escHtml(r.date || '') + '</span>';
      if (foldable) h += '<span class="sr-count" data-n="' + r.items.length + '">' + r.items.length + ' 条改动 · 点击展开</span>';
      h += (k === 0 ? '<span class="sr-badge">最新</span>' : '') + '</div>';
      if (r.items.length) {
        var buckets = { add: [], opt: [], fix: [] };
        for (var m = 0; m < r.items.length; m++) buckets[classifyItem(r.items[m])].push(r.items[m]);
        h += '<div class="sr-body"' + (foldable ? ' hidden' : '') + '>';
        for (var g = 0; g < GROUPS.length; g++) {
          var list = buckets[GROUPS[g].id];
          if (!list.length) continue;
          h += '<div class="sr-group"><span class="sr-tag sr-tag--' + GROUPS[g].id + '">' + GROUPS[g].label + '</span><ul class="sr-list">';
          for (var n = 0; n < list.length; n++) h += '<li>' + emHtml(list[n]) + '</li>';
          h += '</ul></div>';
        }
        h += '</div>';
      }
      h += '</section>';
    }

    var box = document.createElement('div');
    box.className = 'stage-report';
    box.id = 'stage-report';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', '更新报告');
    box.innerHTML = h;

    var note = host.querySelector('.stage-note');
    if (note) host.insertBefore(box, note); else host.appendChild(box);
    host.classList.add('has-report');

    // r134c：吸顶条的渐隐只在「真的滚动过」时出现（is-scrolled 开关）。
    // 停在顶部时第一条目不该被 ::after 渐变罩暗半截；滚回顶上就恢复。
    // 监听滚动容器自己即可，passive 不抢滚动性能。
    box.addEventListener('scroll', function () {
      box.classList.toggle('is-scrolled', box.scrollTop > 2);
    }, { passive: true });

    // r134：旧版本折叠 —— 点版本行展开 / 收起；Enter / 空格同样可操作（role=button）。
    var toggles = box.querySelectorAll('.sr-vh--toggle');
    for (var t = 0; t < toggles.length; t++) {
      (function (vh) {
        function toggle() {
          var body = vh.parentNode.querySelector('.sr-body');
          if (!body) return;
          var willHide = !body.hidden;   // 当前展开 → 这次点了就是收起
          body.hidden = willHide;
          vh.setAttribute('aria-expanded', String(!willHide));
          vh.classList.toggle('is-open', !willHide);
          var cnt = vh.querySelector('.sr-count');
          if (cnt) cnt.textContent = cnt.getAttribute('data-n') + ' 条改动 · ' + (willHide ? '点击展开' : '点击收起');
        }
        vh.addEventListener('click', toggle);
        vh.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
        });
      })(toggles[t]);
    }

    // r106：× 关掉 —— 连同 has-report 一起摘掉，让 .stage-note 回到原来的居中布局
    // （与「数组清空 → 不渲染卡片」走同一条路径，不留半截状态）。
    var xb = box.querySelector('#stage-report-close');
    if (xb) xb.addEventListener('click', function () {
      if (box.parentNode) box.parentNode.removeChild(box);
      host.classList.remove('has-report');
      if (stamp) { try { localStorage.setItem(REPORT_KEY, stamp); } catch (e) { /* ignore */ } }
    });
  })();

  /* ══════════ 身份区同步 ══════════
     真机的连接状态由 01-boot.js 的 refreshStatus() 写进 #onebot-dot / #onebot-label，
     这里只做「搬运」：包装 refreshStatus，让它跑完后再镜像一次，不新增轮询。 */
  // R80（BUG-14）：写前比较缓存。旧逻辑每次 refreshStatus（本地配置 15s 一轮）
  // 都无条件写 innerHTML / 重设 img.src —— 值没变也整块重建 DOM；头像更惨：
  // src 重设 = 重新走一次 CDN 加载，表现为头像周期性闪烁/闪白。
  // 现在记住「上次写进去的值 + 当时的元素引用」，签名没变就整个跳过；
  // 元素引用也进签名 —— 万一边上别的地方把这块 DOM 重建了，不会被缓存骗过去。
  var lastIdent = null;
  function syncIdentity() {
    var st = (typeof state !== 'undefined' && state.status) || {};
    var ob = st.onebot || {};
    // ⚠️ 只信 state.status.onebot.connected，绝不"读顶栏 #onebot-label 的文字"兜底：
    //    未连接时 01-boot.js 写进去的是后端诊断原文，例如
    //    「协议端未运行或未监听 WS 端口」—— 里面含子串「运行」，
    //    按关键字匹配就会把「未运行」误判成「已连接」。实测过：后端明明
    //    connected:false，身份区却显示「在线 · 已连接 OneBot」，与右下角
    //    那条「还没连上」的提示自相矛盾。state.status 是唯一权威来源。
    var on = !!ob.connected;
    // 2026-10-23（P1-3）：后端持续无响应时（01-boot.js 的 statusFailStreak 判定），
    // state.status 是**过期数据** —— 身份卡再写"在线 · 已连接 OneBot"就是撒谎，
    // 而旧实现里这一刻界面一切如常，用户根本看不出后端已经挂了。
    // 副标题改口径 + 圆点转灰；名字保留（是旧值，但比抹掉更认得出是谁）。
    // syncIdentity 由 wrapRefreshStatus 的 .then 每次触发（refreshStatus 内部吞错、
    // promise 恒 resolve），所以 stale 置位后的下一轮轮询就会走到这里。
    var stale = !!(typeof state !== 'undefined' && state.statusStale);

    // 昵称与头像都跟随「当前登录 QQ」（照原型 syncIdentity 的语义）：
    // 后端 /api/status 的 onebot.self = { userId, nickname }（src/routes.js:588）。
    var self = ob.self || st.self || null;
    var uin = String((self && self.userId) || ob.selfId || ob.self_id || '').trim();
    var nick = String((self && self.nickname) || ob.nickname || ob.nick || '').trim();
    var name = nick || (uin ? 'QQ ' + uin : '');

    var elName = $('#ident-name');
    // 拿不到 QQ 号才算「未登录」；此时若 OneBot 其实连着，只说「已连接」，
    // 不再出现「未登录 / 已连接 OneBot」这种自相矛盾的两行。
    var nameText = name || (on ? '已连接' : '未登录');
    var elSub = $('#ident-sub');
    var subHtml = '<span class="dot ' + (on ? 'dot-on' : 'dot-off') + '"></span>' +
      (on ? '在线 · 已连接 OneBot' : '未连接 OneBot');

    // 头像：优先用后端给的地址；没有就按 QQ 号走本地缓存端点（2026-11-05 起，
    // 与记忆 / 存档 / 会话页统一，不再每次重绘都直连 q1.qlogo.cn）；
    // 两者都拿不到 → 保持默认企鹅（.avatar-default）。
    // ⚠️ /api/avatar 只认 5~12 位纯数字，脏 uin 不拼 URL，免得 404 反复打接口。
    var img = $('#sidebar-avatar');
    var box = img && img.parentNode;                    // .avatar
    // 2026-11-05 回归防护：/api/avatar 拉不到时回的是 404（旧 CDN 直链对无效号
    //   给的是 200 默认企鹅图），没有兜底就会留一张破图。失败时摘掉 src 与
    //   .logged-in，露出常显的 #avatar-default。⚠️ 用 flag 一次性绑定 ——
    //   历史 bug「表情包详情每打开一次就多挂一个失效回调」就是这么来的；
    //   #sidebar-avatar 是 index.html 常驻元素，不需要每次重绘重绑。
    //   CSP 禁内联 onerror，必须 addEventListener。
    if (img && !img.__sidebarAvFallbackBound) {
      img.__sidebarAvFallbackBound = true;
      img.addEventListener('error', function () {
        try {
          img.removeAttribute('src');
          if (img.parentNode) img.parentNode.classList.remove('logged-in');
        } catch (e) { /* 忽略 */ }
      });
    }
    var url = String(ob.avatar || ob.avatarUrl || ob.face || '').trim();
    if (!url && /^\d{5,12}$/.test(String(uin || ''))) url = '/api/avatar/' + uin + '?s=640';
    var avatarUsable = /^(https?:|data:|\/)/.test(url);

    // 「开始对话」副标题：有会话就显示第一个会话名，否则提示还没会话。
    // r51：① 启动链进行中（starting）副标题是进度条，跳过重建；
    //      ② 启动结束的结论（launchMsg，已连接/超时）要粘住——refreshStatus 的
    //        重渲染不能把它盖回会话名，用户下次点击时才清除。
    var sub = $('#launch-sub');
    var lb = $('#launch-btn');
    var launchVal = null;   // null = 这次不该写（没元素 / 进度条中）
    if (sub && lb) {
      if (lb.dataset.starting === '1') { launchVal = null; }
      else if (lb.dataset.launchMsg) { launchVal = lb.dataset.launchMsg; }
      else {
        var items = $$('#session-items .session-item');
        var first = items[0];
        // 2026-10-23 修复：取「会话名」而不是整个条目的 textContent，并且不再 slice(0, 18)。
        //   旧写法有两处问题：① textContent 会把群名、时间、状态、统计连成一串，
        //   截 18 字常常切在半个词上；② 硬切之后 CSS 的 text-overflow:ellipsis
        //   永远不会触发（实测 scrollWidth === clientWidth），于是显示成
        //   「战地五【9158】刻晴真爱粉交流群（」这种断在半句的残句。
        //   现在只取名字，溢出交给 #launch-sub 的省略号。
        var nameEl = first && first.querySelector('.session-chat');
        var txt = nameEl
          ? String(nameEl.getAttribute('title') || nameEl.textContent || '').trim()
          : (first ? String(first.getAttribute('title') || first.textContent || '').trim() : '');
        launchVal = txt || (items.length ? '进入会话列表' : '还没有会话');
      }
    }

    // 签名：值 + 元素引用。全都没变 → 这次刷新没有任何可写的，直接返回。
    if (lastIdent
      && lastIdent.elName === elName && lastIdent.elSub === elSub && lastIdent.img === img
      && lastIdent.nameText === nameText && lastIdent.subHtml === subHtml
      && lastIdent.avatarUrl === url && lastIdent.avatarUsable === avatarUsable
      && lastIdent.launchVal === launchVal) return;
    lastIdent = { elName: elName, elSub: elSub, img: img, nameText: nameText, subHtml: subHtml, avatarUrl: url, avatarUsable: avatarUsable, launchVal: launchVal };

    if (elName) elName.textContent = nameText;
    if (elSub) elSub.innerHTML = subHtml;
    if (img) {
      // 头像 CDN 不需要、也不该把本机 origin 当 referer 带出去。
      img.referrerPolicy = 'no-referrer';
      if (avatarUsable) {
        img.src = url;
        box && box.classList.add('logged-in');
      } else {
        img.removeAttribute('src');
        box && box.classList.remove('logged-in');
      }
    }
    if (sub && launchVal !== null) sub.textContent = launchVal;
  }

  function wrapRefreshStatus() {
    if (typeof refreshStatus !== 'function') return;
    var raw = refreshStatus;
    refreshStatus = function () {
      var p = raw.apply(this, arguments);
      try { Promise.resolve(p).then(syncIdentity, syncIdentity); } catch (e) { syncIdentity(); }
      return p;
    };
  }

  /* ══════════ 主同步（switchTab 之后调用）══════════ */
  function syncChrome(name) {
    var g = groupOfTab(name);
    // 顶栏一级高亮
    // ⚠️（2026-10-23 晚）壁纸页已收回「设置 → 外观与数据」，顶栏不再有 data-top="wallpaper"
    //    这颗按钮（见 index.html 该处注释）。但 GROUPS 里仍然保留 wallpaper 分组 ——
    //    showNav / panes.settings 那些判断都靠 g.key 区分，归到 settings 组会把设置页内容
    //    一起亮出来。所以这里单独做一次「归属映射」：进壁纸页时高亮设置，
    //    否则会出现"切进壁纸页、顶栏一个都不亮"的迷路感。
    var topKey = g.key === 'wallpaper' ? 'settings' : g.key;
    $$('#tabs .nav-item').forEach(function (b) {
      var on = b.dataset.top === topKey;
      b.classList.toggle('active', on);
      // ⚠️（2026-10-10 r86 修 P2）一级导航同样要能"读"出选中态 ——
      //    此前只有 .active 这个视觉类，读屏用户听到的是一排无差别的按钮。
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    // 离开「会话」一级就别把全屏页留在屏幕上（用户点了别的页签 = 明确要去别处）
    if (bigpage && !bigpage.hidden && g.key !== 'sessions') closeBigPage();

    var isLaunch = name === 'sessions';
    sideLaunch && (sideLaunch.hidden = !isLaunch);
    // 左栏中间那块：启动页是启动块、设置页是设置分区菜单，其余页是「二级导航」。
    // ⚠️ 存档 / 记忆 也必须显示二级导航 —— 它们与「会话」同属一级，若这里一并隐掉，
    //    用户就没有任何途径在这三页之间来回切（原型在 存档/记忆 页的左栏同时列
    //    「消息记录」导航与群聊列表；本实现把列表交给该页自己的 .list-pane 承担）。
    // 壁纸页同设置页：左栏不挂二级导航（它没有二级页，整页自己带两栏）。
    // 桌宠 2026-10-24 起也走二级导航（ops 组第三项），所以这条判断里不再有 pet。
    var showNav = !isLaunch && g.key !== 'settings' && g.key !== 'wallpaper';
    sideNav && (sideNav.hidden = !showNav);

    // 每页一份的列表栏
    panes.chats && (panes.chats.hidden = name !== 'chats');
    panes.memory && (panes.memory.hidden = name !== 'memory');
    panes.settings && (panes.settings.hidden = g.key !== 'settings');
    // r36：社区块已从左栏迁到设置页内容区底部（#view-settings > .settings-foot），
    // 随 view 显隐，这里不再管。

    syncSidebarWidth(name, g);
    // 存档 / 记忆 的左栏里要同时有「消息记录」导航（列在列表栏上方）
    if (!sideNav.hidden) renderSideNav(name, g);
    if (bigpage && !bigpage.hidden && bpMode === 'setup') { renderSetupNav(); renderSetupPane(); }
    syncIdentity();
  }

  // 包裹 switchTab：00-core.js 本体不动，切页后补一次外壳同步。
  if (typeof switchTab === 'function') {
    var rawSwitch = switchTab;
    switchTab = function (name) {
      var r = rawSwitch.apply(this, arguments);
      // ⚠️（2026-10-17 N3 复核）**刻意静默**：syncChrome 只负责外壳高亮/左栏这类
      //    纯视觉同步，失败时页面本身已经切过去了 —— 再弹一个提示框反而更打断。
      //    保留 console.warn 作为线索即可。
      try { syncChrome(name); } catch (e) { console.warn('[chrome] 同步失败：', e && e.message); }
      return r;
    };
  }

  /* 包一层 renderSettings（06-settings-render.js 的全局函数，与 switchTab 同一种做法）：
     「会话设置」页的「编辑本会话人设」复用全局页的 openPerChatPersonaModal，那个弹窗
     保存后只调 renderSettings() 刷全局页 —— 不包这一层，改完人设回到全屏页摘要还是旧的。 */
  if (typeof renderSettings === 'function') {
    var rawRenderSettings = renderSettings;
    renderSettings = function () {
      var r = rawRenderSettings.apply(this, arguments);
      try { if (bigpage && !bigpage.hidden && bpMode === 'setup') renderSetupPane(); } catch (e) { /* ignore */ }
      return r;
    };
  }

  /* 包一层 updateUsagePage（04-archive-usage.js 的全局函数，与 switchTab 同一种做法）：
     它每次都会重画三张图，而图表的宽度是量容器得来的 —— 隐藏的块 clientWidth 是 0，
     会把图拉成整页宽。所以**先**把维度可见性定下来，**再**让它去量、去画。 */
  if (typeof updateUsagePage === 'function') {
    var rawUpdateUsage = updateUsagePage;
    updateUsagePage = function (stats) {
      applyUsageDim(stats);
      return rawUpdateUsage.apply(this, arguments);
    };
  }

  wrapRefreshStatus();

  // 首屏同步：DOM 就绪即可（脚本是 defer，元素已解析完）。
  syncChrome((typeof state !== 'undefined' && state.tab) || 'sessions');
  setInterval(syncIdentity, 3000);
  // 首屏后补一次：此时 status 可能已由 11-init 拉到
  setTimeout(syncIdentity, 1500);
})();
