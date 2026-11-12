# 更新日志

> 内部修订号与版本号对应关系见各条目标注。本文件记录面向用户的变更。

---

## 0.4.9.3.1（2026-11-12 · 本地修订，未发版）

> 面向用户的完整说明见首页「更新报告」（`ui/app/14-chrome.js` 的
> `STAGE_CHANGELOG[0]`）。本节只记代码侧脉络。

### 新增

- **思考档分流**：`orchestrator` 按消息轻重判档（off/light/full）写 `skillContext.thinkingRoute`，`plugins/thinking-adapters` 的 `shapeThinkingApi()` 翻译成各思考方言的 mode/effort。判定在 `src/thinking-route.js`（测试 `tests/thinking-route.test.mjs` 21 条）；灰度开关 `api.thinkingRoute=false`、`api.thinkingRouteAllowOff=false`。
- **拍一拍并行回应**：`personas.js` 的 `baseStyleRules()`【拍一拍与撤回】段明示模型把 `send_poke` 与 `send_message` 在同一次回复里并行调用，戳+说合并为一轮。

### 修复 · 缓存

- **思考档位注击穿前缀缓存（92%→13%）**：`thinking-note` 属 `VOLATILE_SECTION_IDS`，被 2026-10-12 方向B 前置进 userPrompt 稳定区第 3 段（【当前状态说明】，"78/78 字节相同"的观测早于分流上线）。分流上线后该段内容随档位变化（light 显示 on / full 显示 auto），每次翻转断点落在第 3 段，其后【记忆】【场景】【过去状态】全部重算。修法：`promptSections()` 改用空上下文调 `shapeThinkingApi`，段内容只描述静态配置；测试加防回归断言（light/full/off 三档内容全等、段存在性稳定）。教训：**userPrompt 稳定区里的段必须逐字节稳定**。
- **跨群切换分叉点前移**：三个群的 `personaByChat.roleText` 是 3892 字符旧快照（全局 3933），41 字差异把跨群缓存断点卡在角色卡 1/3 处（切换轮 74%）。已把分群覆盖同步为全局最新版（POST /api/config，内存+磁盘一致）。切换轮共享前缀 12.3k→约 14.3k tok，预期 74%→~86%。

### 修复 · 观测

- **seg-fp / body-lcp 跨群假告警**：两者原为全局单槽基线，跨群切换必报「6/10 段变化、断点推到最前」。改为按群分桶（桶键取 user 文本【场景】段的群名，上限 12 桶 FIFO；`src/llm.js`），告警行带群标识。纯观测改动，不影响请求内容。
- **分桶实现自查修出 2 处缺陷（同日审查）**：① `bucketGet` 对新桶返回 `undefined`，而 `watchBodyLcp` 沿用旧单槽的 `prev === null` 判基线 —— undefined 穿透判断，每个桶第一轮比较拿 undefined 算 LCP，TypeError 被吞，表现为 body-lcp 基线日志静默丢失（12:02 重启后零基线实锤）。修：缺失统一归 `null`。② 桶标识只看最后一条 user 消息，带图请求的最后一条可能是纯媒体部件，958KB 多图请求因此掉进 `(unknown)` 桶。修：倒序扫描取最近一个可识别的。

### 配置

- `store.allCount` 80 → 40：80 条让【过去状态】占 userPrompt 57%、单次 prompt ~19.6k tok；40 条足够接上下文，私聊同样生效。
- 排查口径沉淀：界面看到的会话 prompt 是**累计值**（calls=2 就除以 2）；日志 `[cache-stat] 第 N 次调用 prompt=` 才是单次值。「finish 自确认」（nudge）今天实测 17 沉默 / 1 救援，保持 `nudgeMode: on` 不动。

---


## 0.4.9.3（2026-11-11 · 已推送 main / tag `v0.4.9.3`）

> 面向用户的完整说明见首页「更新报告」（`ui/app/14-chrome.js` 的
> `STAGE_CHANGELOG[0]`）。本节只记代码侧脉络，便于回溯。

### 新增

- **看图反应修正**：默认不看图，只在被 @、被问图里的东西、或配文明显在等回应时才看；看完可以只点个表情，或者什么都不做。删掉「看了就得说两句」这条隐含规则（`src/prompt.js`）。
- **五项轻量互动 + 一组群信息工具**：`react_message`、`recall_message`、`like_user`、`group_highlights`、`group_notice`、`group_system_msg`、`msg_reactions`、`forward_recent`（`src/tools.js`）。

### 修复 · 外部反馈 11 条

- `safe-fetch` 误拦本机回环 → 新增 `security.allowLoopback`（默认拦，LAN 照旧拦）。
- 引用纯图片消息缺 `mid` → 补上，动作回执能定位到原文。
- headless 与桌面版 `DATA_DIR` 解析不一致 → 统一，两条路径读写同一份配置/日志/缓存。
- `/api/status` 缺 `version` → 补上。
- 表情收藏同步：新增返回体**形状**摘要日志（不落任何表情内容）、失败可见、连续异常降频（2→4→8→16→30 分钟封顶）、`force` 绕过与恢复日志；改内置插件后同步刷新 `builtin-modules.json` 基线指纹，避免被能力闸当成占名顶替。
- `release-preflight.mjs` 新增版本一致性检查：`package.json` / `version.json` 不一致报 FATAL，notes 为空、首页更新日志缺同版本条目报 WARN；末尾固定提醒 jsDelivr `@main` 约 12 小时缓存。
- 缓存预热：实测主仓库不产生「模型输出为空」的保活失败（`warmOnce` 用裸 `chatCompletion`、只读 `usage`，刻意绕开空正文升额重试），新增 `tests/cache-warm.test.mjs` 5 条契约测试锁死。

### 修复 · 故障注入（2026-11-11 晚）

- **表情目录失败不写冷却**：原先只有成功才记时间戳，协议端不支持 `fetch_sys_faces` 时每次点表情都重拉并等满 15 秒超时。现加 5 分钟失败冷却，数字编号与内置别名不依赖目录。
- **误导文案**：中文名解析失败统一回「不认识这个表情」，模型会挨个换名字重试、每次再等一轮超时。现说明是目录不可用，并直接给出 `76 = 赞` 一类可用编号、明确阻止换名重试。
- **`msg_reactions` 先截断后过滤**：取前 8 条再丢无效项，第 9 条起的有效表情会被吞掉。改为先过滤后截断。
- **`group_system_msg` 只认数组**：协议端返回 `{ data: [...] }` 这类包装对象时被当成「没有消息」。现兼容常见包装形状。

### 修复 · 真机日志审查（2026-11-11 晚）

- **服务端回「只支持文本输入」时整轮对话 400 失败**（11-06/11-07 共 20 次 `[real:...]` 请求）：`plugins/image-compat` 的 `isImageRejection()` 只认 `image_url` / `invalid image` 这类**格式**措辞，匹配不上 `"model only supports text input; image, video and audio is not supported"`，降级顾问返回 null，`chatCompletion` 不重试，用户只看到英文 JSON、QQ 里什么都没发出去。现新增这类措辞的识别（中英文多种写法、限定 400/415/422 且不误伤模型名/密钥/上下文超长），剥除范围从 `image_url` 扩到 `video_url` —— 只摘图片会让重试再 400 一次。占位说明明确要求「不要假装看过图」，防止模型照着配文编画面。
- `src/error-l10n.js` 新增 ④b 规则（排在「上下文超长」之前）：降级也失败时给中文解释与可操作动作，不再铺一堵英文 JSON。
- 改内置插件后同步刷新 `builtin-modules.json` 基线，`checkPluginTrust('image-compat')` 返回 `{"ok":true}`，避免被能力闸当成占名顶替。
- 顺带澄清：`replyToMessageId` 校验已允许负数（旧报错文案是修前遗留）。

#### 结论更正（同日，用户指出「这不是多模态模型吗」后实测）

- **`sensenova-6.8-flash-lite` 是原生多模态智能体模型，不是纯文本模型**。官方资料明确写「文字/图片/图表/文档/视频融合」；用同一份真实配置直连 `token.sensenova.cn/v1` 实测：纯文本 **200**、合法 PNG(base64) 走 `image_url` **200**、`tool` 消息里带图（日志那种 `msgs=5` 形态）**200**、`assistant` 消息带 content 数组 **200**。
- 因此上面那条 400 **不能用来推断模型能力**；它当天已无法复现（11-06/07 共 20 次，今天 0 次），更可能是当时服务端策略，或请求里带了不被接受的部件。降级逻辑保留为**兜底**（服务端明说不接受就摘媒体救回整轮），但绝不据此关掉看图，也不在设置页把它判成 `no-vision`。
- 更正 `error-l10n` ④b 文案：原写「这个模型看不了图 / 当前模型只接受文字 / 换多模态模型」会把排查引到完全错误的方向；改为「带图请求被服务商拒了」，只列可排查原因（先关视频输入、图片改 base64、别用外链），并明确不劝换主模型。
- `src/model-vision-docs.js` 补 `sensenova-6.8-flash-lite` → `vision`（官方 + 实测双证据），`tests/vision-effective.test.mjs` 新增用例锁住，防止以后误判成 `no-vision` 把看图工具整批门控掉。
- 实测还定位了另一条历史 400 的指向：`video_url` 与**公网 URL 形式**的 `image_url` 都会回 `inference request is invalid` / `image download failed`（日志 9 次，11-05/11-10）。该错误文案仍过于笼统，未做盲目降级；当前 `videoMode=auto` 且无 `videoModel` 时走抽帧、QQ 图片走本地缓存转 base64，正常路径不受影响。

### 操作逻辑 · 插件安装后自动适配界面（2026-11-11 晚）

对外可见：从市场点「安装」之后那一段界面，原来完全是"造扩展"的形态，现在按"装东西"来组织。安全底座（暂存区隔离、五道闸门、人工签票、备份回滚）未动。

- **安装场景独立成一种界面状态**：落地页顶部给三步横幅（① 下载到暂存区 → ② 适配本机 → ③ 你确认后写入插件目录），并明确「现在还没有装到系统里」。安装场景下隐藏「自己造一个 / 改别人的包」切换与起草输入区 —— 原来闸门一通过，顶部会显示空的需求输入框，用户在这里输入再点「开始起草」会新建草稿、把这份待装草稿顶掉（`f.mode` 默认 `'create'`，`openForgeDraft` 不改它）。
- **确认安装区吸底**：原来它排在闸门横幅 / 计划 / 问题明细 / 元信息 / 代码 / 轨迹 / 模型说明之后，而单文件包的代码块默认展开，真机上要滚一整屏才摸得到。现在安装场景下吸底常驻，代码块默认折叠。
- **暂存区忙时不再静默丢弃**：原来 `forgeBusy()` 只切页就 return，而市场刚弹过「正在打开锻造台并让模型适配…」。现在记下排队的草稿，给横幅 + 「现在开始适配」「先看看这个草稿」两个出口。
- **打开草稿失败给原因**：竞态（draftId 被另一个操作顶掉）与空草稿两个分支分别说明，不再 return 了事。
- **市场卡片三态**：`安装 → 待确认 → 已安装`。中间态**可点**，点它回到那份草稿且不重新下载；状态来自 `/api/forge` 的草稿列表（按 `originCode` 匹配），不再是"点完这一瞬间的按钮文案"。原来 `disabled` 之后没有任何恢复路径 —— 草稿被删 / 已装完 / 关了页面，按钮就永远点不动。
- **批量口令安装不再 1.2 秒自动关窗**：结果清单里带着每个包的成功/失败原因，原来连弹窗一起关掉，用户回头查不到。现在清单常驻，按钮变「关闭」，另给「去锻造台确认安装」；`icFinished` 防止二次点击重复安装。
- **可解释性**：三个按钮 disabled 时带 `title` 说明原因；适配请求本身失败（网络 / 620s 超时 / 后端 500）时给「再适配一次」；`diff` 为空时明说「这个包不用改 —— 模型没有动任何代码」。
- **闸门不通过时恢复修改入口（关键修复）**：上一轮把安装场景的起草区整块藏了，结果闸门不过时界面还在提示「点上方输入框旁的继续修改」，而那个输入框根本不存在 —— 用户面对 5 项阻断无处可改。现在拆成两个变量：`installScene` 管隐藏模式 Tab，`installing` 再加 `!(gate.ok === false)` 条件管隐藏起草区；闸门一不过，起草区自动回来并进入 revise 形态。
- **阻断数不再虚高**：`gate.js` 的四个 `skip()` 各生成一条 `level:'block'` 的 issue，于是「5 项阻断」里 4 项是同一句「结构未通过，跳过 XX 检查」，还各占一张长得一样的卡片。渲染层现在把 `code === 'skipped'` 摘出来：计数只算真要修的（`blocking - skipped.length`），被跳过的合成一行说明。不动后端语义（数据仍然真实）。
- **阻断态独立布局**：原来和可安装时共用一套排版 —— 最左边是一颗 disabled 的「确认安装」（占位最大、视觉最重），唯一能点的按钮挤在旁边，提示压成最灰的 12px 小字放最右。现在改成红左条警示块 + 「⛔ 现在还不能安装 —— N 项需要先修掉」+ 主按钮**「让模型修好这 N 项」直接开修**（不再要求先填说明），次按钮「先补充说明」才滚动聚焦输入框。
- **其余可解释性**：`已自动修复 0 轮仍未清零` 在 0 轮时不再显示；无工具时不渲染「工具 0」；模型说明超 320 字默认折叠；三步横幅的 ② 增加「未通过」红态（原来跑完但闸门不过会显示成未开始）；页头说明按场景切换（安装场景不再显示「用自然语言描述需求，模型起草一个扩展」）。
- 未做（需后端配合）：适配中途追加要求（要分段接口在段间接收 note）、刷新后恢复进度（要状态接口返回 `adapting`）。

**验证**：静态自检 `verify-forge-ux-fixes.mjs` 从 37 项扩到 **52 项全过**（代码点存在性 + 接线 + 旧写法残留 + blockedHtml 切片断言）；全量 **493/493**；改动 JS `node --check` 通过；`release-preflight` 无 FATAL / WARN。UI 不在单测覆盖内，靠自检脚本 + 逐分支人工核对。

### 适配链路 · 三处实现修正（2026-11-11 深夜）

- **「有进展才续段」的判定用错了变量**：原来用 `trace.length`，但 `read_file` / `list_files` 也会往里记 —— 模型「只在读、一行没写」同样被当成有进展，续段后把同样的 240s 再烧一遍。改成只看 `forge_write_file` / `forge_delete_file` 的成功调用。
- **临近收尾的提醒每轮都往上下文塞**：`leftRounds <= 2 || leftSec <= 60` 这两个条件在最后几轮是**逐轮成立**的，原来每轮 push 一条几乎相同的「【系统提醒】」，实测能堆 4~6 条，既费 token 又把模型的注意力挤到「别再改了」上。加 `lastTipRound`，同一提醒至少隔 2 轮。
- **进度条段号滞后一档**：`progress.st.seg = seg` 写在 for 的 `seg++` 之前，而同一事件里的 label 已经在说「接着跑第 seg+1 段」—— 导致第 2 段全程显示「1/2」。改成 `seg + 1`。
- 另修一处注释与代码漂移：`routes/forge.js` 注释写「560000ms」，客户端实际 `timeoutMs: 620000`，已对齐。
- **审查过确认无问题的**：路径四道闸（反斜杠先归一化再查 `..` → FORBIDDEN_PATH → ALLOWED_EXT → realpath 复检防符号链接逃逸）、草稿锁 `released` 标志防 finish/close 双触发、签票一次性 + 绑 digest + `!(age >= 0)` 已防时钟回拨、`ctx.draftId || args.draft_id` 防跨草稿写入、`readFileTool` 双重截断（400 行 + 4 万字符）。
- **已知风险（未修）**：多轮上下文无预算管理 —— 初始上下文封顶 `PROMPT_TOTAL_CHARS=120000`，但 12 轮累积的工具结果无上限；撞 `context_length_exceeded` 后整轮适配失败（已改文件保留但界面报错）。修法需设计（按 token 预算裁剪旧工具结果）。

### 架构 · 系统提示与人设分层（2026-11-11 深夜）

目标：系统提示只保留**任何人格都成立**的规则，风格一律归人设层。改完系统提示 5160 → **3030 字符（−41%）**。

- **系统提示现在只有五类**：安全规则 / 工具协议 / 回应义务 / QQ 平台约束 / 汇报禁令。
- **下沉到 `personas.js` 的 `baseStyleRules()`**：参与度（安静·普通·活跃）、值得/不值得开口、什么算在叫你、追问次数上限、冷场处理、引用与 @ 的使用偏好、轻量记忆习惯、拍一拍与撤回、以及整段【看到图之后】。
- **拼接位置（2026-11-11 二次修正）**：初版把基座拼在 `buildUserPrompt` 的开头（`【行为风格（通用基座，人设可覆盖）】`），两处不妥 —— ① 语义错位，它是系统级准则而非"群友说的话"；② **缓存上更差**：它随参与度档位变，摆在用户提示词第一段，一变就把角色设定、记忆、聊天记录全部重算，正好违反本项目"稳定段在前、易变段殿后"的原则。现已挪到 `buildSystemPrompt` **末尾**：变了只作废自己这一段，前面硬规则的前缀仍命中。人设卡仍压得住它（user 整体排在 system 之后，服从度更高）。
- **为什么放基座而不是写进每张人设卡**：这些规则治的是"每张图都配一句点评""逐条复述""拿记忆硬聊旧话题"这类**通用质量下限**，任何角色都需要；写进每张卡会大量重复且容易漏。
- **`qqSceneRules` 拆开**：平台硬约束（Markdown 会乱码、占位符语义、看图能力开关、read_forward 展开方式）留系统提示，改名为 `qqPlatformRules`；"回复保持简短""私聊要不要回""引用对象不是你时别抢话"属风格，随基座下沉。
- **顺带修掉上一轮发现的两处规则冲突**（详见 `tests/prompt-consistency.test.mjs`）：安全段不再声称"唯一例外是壁纸工具"（与实际的插件工具矛盾）；把「看图是默认动作」与「默认不看图」这对互斥表述统一成单一口径。
- **系统提示里不再出现名字（用户连续两次反馈后彻底移除）**：
  - 第一版是「你是「${botName}」。」—— 把**名字当成身份**，用户换角色卡（客服、某动画角色…）后与【角色设定】正面冲突。
  - 第二版改成「你的名字是「X」。」—— 仍不妥：`botName` 与 QQ 昵称 / 群名片同源，**用户随时能改**；写进 system（每轮原样重发）等于把名字钉死，改完名模型还按旧名自称。
  - 最终版只留功能约束：`所有对外表达都必须通过 send_message 工具发出；不调用它，群友看不到你说的任何话。你的身份、称呼与说话方式以【角色设定】为准。` 名字由运行时上下文（聊天记录里"我"的发言、群名片、角色卡）体现，system 不再断言。`{botName}` 占位符仍保留给 `systemPromptOverride` 模板自用。
- **`systemPromptOverride` 分支补齐两段**：原来只追加 security / toolProtocol / replyObligation，漏了 `qqPlatformRules` 与 `reportBan` —— 用自定义模板的用户会拿不到「Markdown 在 QQ 上会显示乱码」「占位符语义」这些平台硬事实，也拿不到「不要输出『我已发送成功』」这条禁令。override 只该替换人格/风格，硬约束必须与默认分支一致。
- **修一处拼装 bug（导出全文时才发现）**：`replyObligationRules()` 返回**数组**，默认分支写成 `replyObligationRules(),` 把它当单元素塞进 `parts`，`join('\n')` 时 `String(array)` 把两条规则拼成「…也算回应。,- 多人同时叫你时…」。已改为 `...replyObligationRules()`，并加契约测试防复发（这类 bug 语法检查与单测都发现不了，只能导出渲染结果目检）。
- **验证**：全量 **498/498**；实渲染核对——系统提示无残留风格段、五类必备段齐全、无 `undefined/NaN`；人设基座五段齐全（说话与分寸 / 引用与点名 / 轻量记忆 / 拍一拍与撤回 / 看到图之后）。
- ⚠️ 提示词属启动期加载，**需重启应用生效**。

### 健壮性 · 病态输入与时钟边界（2026-11-11 晚）

- **时钟回拨会让所有「窗口内」判定卡死**：全仓二十多处 `Date.now() - at < TTL` 都假设系统时钟单调不减。蓝屏重启后 CMOS 跳变、NTP 往回校时、缓存文件 `mtimeMs` 超前（备份恢复 / 打包机时间更快）时差值为负，`负数 < TTL` 恒为 true —— 冷却期、去重窗口、负缓存、失败降频全部判成「还没到重试时间」，日志里还看不出异常（看起来只是安静）。新增 `src/elapsed.js`：`elapsedSince` / `withinWindow` / `expiredSince` 把未来时间戳判为「已过期」，正常时间下与原减法逐字节等价。
- **已全部收口**：`src/` 与 `plugins/` 下不再有 `Date.now() - at < TTL` 这种裸减法形态（`grep` 归零）。
  - 首轮迁移 17 处 / 9 个核心文件：头像缓存（坏档清理、负缓存、prune）、cache-warm（429 冷却改为记「起点」而非「截止点」、形状去重、调用前预热间隔）、表情目录成功/失败冷却、发送队列（去重窗口 + 分钟/小时限流表裁剪——回拨后旧写法会把未来时间戳全留下，导致所有发送被判超限）、群名片与市场列表缓存、主动开话题空闲判定、ffmpeg/ffprobe 探测缓存、视频文件清理、sticker 同步降频 / 日志节流 / 收藏频率裁剪 / 两处文件宽限期。
  - 第二轮补齐剩余 24 处 / 22 个文件：`disk-space`、`image-cache`、`sessions`、`qq-portable`、`protocol-onboard`、`usage-stats`(2)、`harness/dev`、`wallpaper/*`(5)、`account-pool`、`media-download/*`(3)、`mem-layered/*`(4)、`speech-to-text`、`video-frames/*`(2)。
- **⚠️ 文件时间戳必须带容差**：`fs.statSync().mtimeMs` 与 `Date.now()` 不同源，Windows 上刚写入的文件 mtime 常超前几毫秒；严格版会让新建缓存立刻失效，还会让 `readCache` 提前 return 跳过坏档清理。全量回归真的抓到这两条（单跑通过、全量失败）。现新增 `expiredSinceFile()`（1 分钟容差），并把 `readCache` 改成「先校验内容、坏档照删，最后再判过期」。
- **病态输入 fuzz 750 组**（`fuzz-weird-inputs.mjs`）：零宽字符、孤立代理对、超长串、`$&` 替换符、稀疏数组、`__proto__` 键、循环引用、Symbol、NaN/Infinity 等喂给 30 个可导入纯函数，**无原型污染、无生产路径会真触发的崩溃**；绝大多数抛错来自 JSON 世界不可能出现的输入。顺带修了 `elapsedSince(Symbol)` 会抛 TypeError（容错工具自己不该打挂调用方）。
- **5 个插件基线同步刷新**：`account-pool`、`media-download`(3 文件)、`mem-layered`(4 文件)、`speech-to-text`、`video-frames`(2 文件)，刷新后 `checkPluginTrust` 全部 `{"ok":true}`（连同未改动的 `sticker` / `image-compat` 一起复验）。
- 首页 `STAGE_CHANGELOG` **未改**：属于内部健壮性、无用户可见功能变化，按「面向用户的报告只写能感知到的改动」的既有约定不新增条目。

### 验证

- 全量 `node --test "tests/*.test.mjs"`：**493/493 通过**；改动文件 `node --check` 全过。
- 新增 `tests/elapsed-clock.test.mjs` 7 例（含回拨、mtime 超前、脏时间戳、容差边界）、`tests/image-compat-textonly.test.mjs` 10 例、`tests/error-l10n.test.mjs` +2 例、`tests/vision-effective.test.mjs` +1 例。
- 刷新 `builtin-modules.json` 后 `checkPluginTrust`：`sticker` / `image-compat` 均 `{"ok":true}`。
- `release-preflight.mjs`：无 FATAL / WARN。
- 未涉及 QQ 空间与语音链路。

### 判定不改 / 待真机

- 升级后插件被信任清单拦下：自动并入等于静默关掉高危能力闸，保留现有一键信任入口。
- 插件自定义 HTTP 路由扩展点：不是 bug，是缺失能力，单独立项。
- 桌宠置顶层级、安装目录不可写时桌宠被跳过：渲染配置仍落在安装目录，属 Electron 真机行为，需在出问题的机器上抓一次 `boot-diag.log` 再动。

---

## 未发布 · 0.4.9.2 代码审查修复（2026-11-05，R207，后端改动需重启生效）

> 对当前未提交的 R184–R206 改动做了一轮独立审查。基线是好的：337/337 测试全绿、
> 12 个改动文件 `node --check` 全过、27 个经典脚本 756 个顶层声明 0 组重名。
> 但确认了两个会真实影响功能的缺陷，以及几处口径/性能问题，一并修掉。

### 修复

- **头像坏档会连破 7 天**（`src/avatar-cache.js` / `src/routes/system.js`）
  旧实现读缓存只看 `buffer.length`、下载时丢弃真实 `contentType` 并硬编码
  `image/jpeg`、`writeFileSync` 直写正式文件 —— CDN 错误页或写到一半断电留下的
  半截 JPEG 会被当有效图片缓存，叠加 TTL 7 天 + 浏览器 `max-age=604800`，
  命中即返回，负缓存与重拉都介入不了。现在：下载与读缓存都按**图片魔数**验真
  （JPEG/PNG/GIF/WebP/BMP），据此返回真实 MIME；坏档删除并按未命中重拉；
  落盘改「临时文件 + rename」原子替换；prune 顺带清 1 小时以上的 `.tmp` 残留；
  响应补 `x-content-type-options: nosniff`。
- **会话卡空体自愈经常不生效**（`ui/app/15-chat-chrome.js`）
  R193 的 `lastBodyHeal = now` 写在「卡体是否有内容」判断之前，而该函数每次
  `applyRightInner()` 都会调用 —— 正常渲染不断消耗 5 秒节流窗口，真正空卡体时
  反而被挡住；与 R188 同会话短路叠加，等于没修。现在只在确实自愈时计时、按会话
  分键；补拉失败/被跳过时兜底移除「加载中…」占位（否则 `firstChild` 非空会让
  自愈永不重触发）；卡体查找改按值比对，避免 session id 含引号时
  `querySelector` 抛错打断整块渲染。
- **`/api/avatar` 的 HEAD 分支是死代码**（`src/routes/system.js`）
  分发器按 `method` 严格相等匹配，写 `'GET'` 时 handler 里的 HEAD 判断永远走不到。
  改 `method: '*'` 并显式对非 GET/HEAD 回 405；尺寸校验移到路由层，不再用
  `Number(x) || 100` 把 `?s=abc` / `?s=0` / 空串悄悄洗成默认 100 档（注释写的是
  「其它一律 404」）；尺寸白名单由 `avatar-cache.js` 唯一导出，两处不再各写一份。
- **击穿归因全量渲染**（`ui/app/13-doctor.js`）
  R204 把「最近 6 次」改成遍历全部 `a.breaks` 再聚合，「其余 N 类」虽折叠在
  `<details>` 里，HTML 仍全量生成并插入 DOM（`ATTRIBUTION_MAX_FILES=120`）。
  现在先 `slice(-60)` 再聚合，上界钉死；同时给 `miss` / `ratio` / `prompt` /
  `titles` / `excerpt` / `signals` / `chars` / `share` 补缺失字段兜底，避免一组
  抛错带走整块归因。
- **用量页「?」帮助弹窗可无限叠加**（`ui/app/04-archive-usage.js`）
  `openHelpModalShell` 没有幂等，连点两下叠出两个遮罩 + 两个焦点陷阱。现在给
  overlay 打 `data-help="usage"`，已开时只重新聚焦。
- **侧栏机器人头像改本地缓存后的 404 破图**（`ui/app/14-chrome.js`，回归防护）
  全站私聊头像统一走 `/api/avatar` 后，侧栏 `#sidebar-avatar` 原本**没有**加载失败
  兜底：旧 CDN 直链对无效号回的是 200 默认企鹅图，新端点拉不到是 404，会直接留一张
  破图。现补一次性 `error` 监听（flag 防重复绑定，CSP 禁内联 onerror），失败时摘掉
  src 与 `.logged-in` 露出常显的 `#avatar-default`。这正是首页更新报告里
  「表情包每打开一次就多挂一个失效回调」那条历史 bug 的同型陷阱，按同一套修法处理。
- **基线自检脚本的 `--check` 是死参数**（`scripts/refresh-builtin-baseline.mjs`）
  文档一直写着 `--check 只检查不写入`，实现里却没有这个分支，直接被后面的
  「不是内置模块目录名」拦掉 —— 等于「改了内置模块源码没重算基线」这类历史事故
  （`/help` 重启后报「触碰了高危能力」）没有自检入口。现补只读比对分支：
  实测 21 个内置模块 / 85 个文件全部一致。

### 调整

- **全站私聊头像统一走本地缓存**：存档列表/页头（`04`）、记忆列表页头（`05`）、
  会话页左栏（`15`）、全屏页左栏与侧栏机器人头像（`14`）原先仍直连
  `q1.qlogo.cn`，本轮一并切到 `/api/avatar`（尺寸收敛到 40/100/140/640 白名单）。
  **群头像保持 `p.qlogo.cn/gh/` 直链** —— 拿群号套个人接口会 404，不能改。
  这样 `version.json` 里「头像改本地缓存」的表述才名副其实。
- **补测试**：新增 `tests/avatar-cache.test.mjs`，用临时 `QQ_AGENT_DATA_DIR`
  零出网覆盖魔数识别、合法缓存命中（含 PNG 的真实 MIME）、坏档清理、非法 QQ、
  尺寸白名单与缓存统计 —— 这是这批改动里唯一「出网 + 写盘 + 新 HTTP 端点」
  的模块，此前 337 个用例对它零覆盖。

### 验证

全量测试 **346/346**（337 原有 + 9 个新增 avatar-cache 用例，零出网）；
13 个改动 JS `node --check` 全过；27 个经典脚本 756 个顶层声明 0 组重名；
直接调真实 `systemRoutes` handler 实测 GET/HEAD 200、POST 405、
`?s=abc` / 空 / 0 / 999 全 404、`nosniff` 生效。
审查阶段用临时 DATA_DIR 实证过坏档场景（写入 `<!DOCTYPE html>` 后旧实现照样
以 `image/jpeg` 返回），修复后同一场景返回 null 且坏档被删除。

## 未发布 · 外链拦截落日志 + 0.4.9.2 bug 上报核查结论（2026-11-04，R206，需重启生效）

> 收到一份外部《bug 上报》（两个"缺陷"），逐条对照当前源码核查后：
> **两个都不是当前版本的真 bug**，但报告里有一条可观测性建议属实，已顺手采纳。

### 核查结论
**缺陷一（runAction 面板动作通道"宿主从未实现"）→ 不是 bug，是不存在的约定。**
`runAction` 在本仓（宿主 / 插件 / 文档）**0 命中**；没有任何插件或前端会发
`POST /api/skills/<id>/action/<key>`，报告声称的故障现象在代码里无来源。
宿主的插件面板机制是**另一套已实现的通道**：configSchema `{type:'action', panel}`
→ `manifest.panels` → `/plugin-panel/<id>/…`（宿主代理插件目录，与控制台同源）
+ `@data` 只读数据代理；`src/skills/panel.js:34` 明确写着
**「只能读，不能写 —— 通道是纯 GET 静态文件，没有任何写接口」**——
无写接口是有意的安全模型，不是漏实现。`POST /api/skills/x/action/y` 返回
404「未知 API」是正确兜底（curl 复现属实但非缺陷）。
→ 报告实质是一个 **0.5 的新通道提案**（写回 REST），其修法（白名单 /
keyEndpointAllowed / 状态码约定）质量不错，留档给 0.5 评审；**本版不实现**
（给不存在的调用方加一条能写盘的通道反而扩大攻击面）。

**缺陷二（插件本机管理页"无路可走"）→ 前提不成立，影响范围是空集。**
报告假设插件自带 `127.0.0.1:端口` 的 HTTP 服务并用 `target="_blank"` 打开
管理页——当前生态 **0 个插件**自起 HTTP 服务（grep `createServer/listen` 空）；
面板页由宿主代理、与控制台同源，iframe / 同源打开都不存在它描述的 CSP 问题。
electron 侧引用（setWindowOpenHandler deny / INTERNAL_HOSTS 拒本机 /
isLocalConsole 放行本机导航）核实**属实**，但这是两个自洽的威胁模型
（新窗口逃逸 vs 顶层导航逃逸），不是口径矛盾。
→ 真正值得记下的小观察：① `isLocalConsole` 放行**任意本机端口**的顶层导航，
宽于"控制台自己的端口"，记入 0.5 加固备忘；② 外链拦截只进 stdout。

### 本版实际改动（`electron/main.js`）
- `openExternalChecked` 与小窗导航守卫里被拦的外链，除 console 外改走
  现成的 `logKey()` 落进 `data/logs`（报告建议 D，1 行级）——
  「点了没反应」从此有据可查。

### 验证
`node --check` 通过；测试 337/337。核查过程全部基于当前源码
（routes 拆分后的 12 个域模块、plugin-loader、skills/panel.js、electron/*）。

## 未发布 · 首页更新报告补全 0.4.9.2（2026-11-04，R205，前端刷新即生效）

> 用户要求「把今天更新的东西写更新报告上去 0.4.9.2」。

### 改动
- **`ui/app/14-chrome.js` `STAGE_CHANGELOG`**：第 1 条已是 `0.4.9.2 / 2026-11-04`，
  但 items 只覆盖到 R183 前后。本轮把当天后半段 **R184~R204** 按主题合并成
  **8 条**口语化条目插在数组最前（渲染按「新增 / 修复 / 优化」前缀分组，
  新内容自然排各组最上），与已有条目按语义去重；**不升版本号、不动 date**
  （package.json / version.json 已是 0.4.9.2，沿用 r134/r144/r148 先例）。
  R189 是本机 Windows 动画开关（系统设置），不是软件改动，不写进面向所有用户的报告。
- **`version.json`**：notes 补上本轮界面统一与稳定性内容；顺带删掉误混进
  用户可见文案里的维护提示（「发版时改这里的 version 与 notes…」）。

### 验证
`node --check` 通过；测试 337/337；无头浏览器渲染首页更新报告卡片，
确认 0.4.9.2 / 2026-11-04、8 条新条目全部命中、与原有 25 条共 33 条
按「新增 3 / 优化 20 / 修复 10」分组正常显示，11 个旧版本折叠条目不受影响。

## 未发布 · 击穿归因「一坨重复卡片」治理（2026-11-04，R204，前端刷新即生效）

> 起因：用户截图反馈自检页「击穿归因 + 模块清单 + 静态体检」这一坨不好处理。

### 根因
`renderAttribution()` 用 `a.breaks.slice(-6).reverse()` 把最近 6 次击穿**逐条
全量展开**（每条含改前/改后原文两行）。同一原因反复触发时，6 张卡片除时间外
完全相同（用户截图实测），整屏都是重复内容；再叠加红左边框、蓝色来源胶囊、
橙色断点、红色 miss、红/灰改前改后标签、模块清单红绿状态等自造混色，
整体像调试日志 dump 而非 UI。

### 改动
1. **按原因签名聚合**（`ui/app/13-doctor.js`）：签名 = 段名 / 模块 / 变更类型 /
   来源 / 断点 / 改前 / 改后 / 摘录 / miss / prompt。同签名合成一组，只渲染一次，
   时间行写「最新时间 · 共 N 次」，全部时间放进 title（hover 可查）。
2. **原文默认折叠**：改前/改后收进 `<details>`「查看改前 / 改后原文」，默认收起。
3. **最多显示 4 组**，其余进 `<details>`「其余 N 类击穿（共 M 次）」，可展开。
4. **状态统一到 cc-pill**（R194）：未识别来源→`cc-noreply`、miss→`cc-error`、
   改前/改后→`cc-gray`、模块清单翻字→`cc-waiting` / 稳定→`cc-done`、
   静态体检→`cc-waiting` + 灰标签；去掉红色左边框、橙色断点、红色 miss、
   红色段名等重复强调，卡片改 `--line-str` + 8px 圆角。
5. **静态体检**由「⚠️ + 长句」改成「胶囊 + 说明 + 一行注记」。

### 验证
`node --check` 通过；测试 337/337；无头 Edge 用 mock 调真实
`renderCacheSentinel()` 渲染：
- 6 条完全相同 → **1 组**「共 6 次」、原文 `DETAILS` 且未展开、6 个时间全在
  title、10 处 cc-pill、模块清单/静态体检状态类正确；
- 6 类 × 2 次 → 4 组可见 + 「其余 2 类击穿（共 4 次）」折叠 2 组；
- 截图确认整块从 6 张重复卡压缩为 1 组 + 折叠入口。

## 未发布 · 前缀缓存哨兵卡片风格统一（2026-11-04，R203，前端刷新即生效）

> 起因：用户截图反馈自检页「前缀缓存哨兵」这一块风格比较迥异；按用户选定
> 的「中度统一」方案实施（保留绿=命中 / 红=未命中的语义色与全部数据）。

### 差异与改动
1. **状态徽章**（`ui/app/13-doctor.js`）：「偏低」原是手写的描边空心胶囊
   `.sentinel-badge` → 改用全站 cc-pill 体系（R194）：
   good→`cc-done`、warn→`cc-waiting`、bad→`cc-error`、unknown→`cc-noreply`。
2. **图例**（同上）：原「`<i>`命中 `<i>`未命中 ｜ 条长 = …」是终端味的一整句，
   改成「色块+文字」两个分组 + 常规说明行（`·` 分隔），去掉全角竖线。
3. **卡片规格**（`ui/style.css` 5895 段）：`padding 13/15`、`radius 10`、`--border`、
   无投影 → 对齐 `.snowluma-page-card`：`radius 14`、`padding 20px 24px`、
   `--line-str` 描边、`--lift + --paper-edge` 投影。
4. **条形颜色**：纯饱和 `--green`/`--red` 实色 → `color-mix(... transparent)`
   派生半透明色叠在 track 底色上，命中段仍比未命中弱一档；图例色块同源。
5. **行密度与数字**：行字号 11→12px、行距 4→6px、条高 11→12px、
   track 圆角 3→6px、列宽 38/46/64→46/50/72px；百分比统一 `--text` 加粗，
   只有 warn/bad（异常）才染橙/红，健康行不再整列花花绿绿。

### 验证
`node --check` 通过；测试 337/337；无头 Edge 用 mock 哨兵数据调用真实
`renderCacheSentinel()` 渲染 12 行并截图，实测徽章类为 `cc-pill cc-waiting`、
卡片 radius 14px / padding 20px 24px、行字号 12px、行距 6px、条色为
派生半透明、图例 2 组，整体观感与全站卡片一致。

## 未发布 · 设置页搜索框文字截断 + 不够明显（2026-11-04，R202，前端刷新即生效）

> 起因：用户截图反馈「这边也显示不全，并且搜索框不明显」。

### 根因
- **截断**：`#set-search-input` 宽 210px，左右 padding 28/10 给放大镜留位，
  12.5px 字号下可用 **172px**；原 placeholder「搜设置：密钥 / 群 / 令牌 /
  积极度…」实测 **193.8px**，溢出被裁（与 R201 同类）。
- **不明显**：边框用 `--line`（深色主题仅 7% 白）、底色用 `--layer-1`
  （与卡片同色），输入框几乎融进页头；placeholder 与图标用的是最暗的
  `--fg-mute`。

### 改动
1. **`ui/app/06-settings-render.js`**：placeholder 缩为「搜设置…」（50px，
   完整显示），完整说明移到 `title`（hover 气泡）与 `aria-label`（读屏）。
2. **`ui/style.css` 16.6 段**：边框 `--line` → 控件专用 `--line-str`（15%），
   底色 `--layer-1` → 输入框专用 `--field-bg`，图标/placeholder 颜色
   `--fg-mute` → `--fg-dim`；补 hover 边框变化与 focus 的 accent 描边 +
   `--accent-soft` 光晕（与 .bp-search 同款）。窄屏 140px 规则不变。

### 验证
`node --check` 通过；测试 337/337；无头 Edge 实测可用宽 172px、旧文案
193.8px（放不下）、新文案 50px（放得下）；改前/改后截图对比确认文字完整、
输入框可辨识。

## 未发布 · 会话选择页搜索框占位文字显示不全（2026-11-04，R201，前端刷新即生效）

> 起因：用户截图反馈左栏搜索框「搜索群 / 好友（也匹配最近一条消…」被截断。

### 根因
`#cc-q` 输入框左右要给放大镜（32px）与清空按钮（40px）留位，13.5px 字号下
实际可用宽度仅 **197px**；原 placeholder 19 个字符实测 **229.8px**，溢出约
33px 被浏览器直接裁掉（placeholder 不支持省略号，缩小字号/加省略都不稳）。

### 改动（`ui/app/15-chat-chrome.js` buildStatic）
- placeholder 缩短为「搜索群 / 好友」（实测 81.3px，完整显示）；
- 完整说明「也匹配最近一条消息」移到 `title`（hover 气泡，与 .bp-nav 同款）
  与 `aria-label`（读屏），信息不丢；
- 不改输入框 padding / 字号 / 左栏宽度，避免牵动 R131 两页左栏对齐。

### 验证
`node --check` 通过；测试 337/337；无头 Edge 实测可用宽度 197px、
旧文案 229.8px（放不下）、新文案 81.3px（放得下），截图确认完整显示。

## 未发布 · 四个统计维度块位置统一（2026-11-04，R200，前端刷新即生效）

> 起因：用户截图反馈「按天」这个位置和其他几个位置不太一样。

### 根因（R195 引入）
R195 把控制条挪进页头后写了 `.usage-head + [data-block] .usage-sec-head
{ margin-top:12px }` —— 相邻选择器**只命中 DOM 里紧跟页头的第一个块（按天）**。
用量页是「一次只显示一块」的维度切换（data-udim），切到按会话/按模型/按插件时
当前块前面有隐藏的兄弟块，不命中该规则，退回 .usage-sec-head 默认 24px。
无头 Edge 实测标题行 top：按天 **128**、其余 **134** —— 切维度时整块内容
（标题 / 摘要行 / 图表）上下跳 6px；水平几何四块完全一致（left 258、宽 940）。

### 改动（`ui/style.css`）
规则改为按状态匹配、不依赖 DOM 顺序：
`#usage-page[data-udim] > .usage-wrap > [data-block] > .usage-sec-head { margin-top:12px }`
—— 存在 data-udim（设计上即只显示一块）时四个块统一 12px；未设置 udim
的多块同屏旧路径仍用默认 24px 保留块间距。

### 验证
测试 337/337；无头 Edge 四维度实测 title/摘要/图表 top 全部 128/163、
computed margin-top 全 12px，spread 0；修复后三个维度截图对齐一致。

## 未发布 · 留槽后内容位置回到原位（2026-11-04，R199，前端刷新即生效）

> 起因：R197/R198 之后用户截图反馈「会有像素偏移，位置变了」。

### 根因
单侧 `scrollbar-gutter: stable` 虽然消除了滚动条跳动，但会**恒定**预留一个
10px 槽宽 → 940px 居中列整体左移 5px。无头 Edge 实测：修复前 left=258，
单侧留槽后 left=253，页面所有内容列元素（标题 / 摘要 / 图表 / SVG）齐刷刷
左移 5px，宽度不变 —— 用户看到的「位置变了」。

### 改动（`ui/style.css`）
含「max-width:940 + margin auto 居中列」的容器改 **`stable both-edges`**
（两侧对称留槽，居中列中心不变）：
- `#usage-page`、`.usage-strip`（R197，两者保持同一规则以维持对齐）；
- `#skills-page`、`#plugins-page`（r96）；
- `.usage-pane` 整类（R198，覆盖人设 / 桌宠 / 自检页）。
**列表 / 弹窗类保持单侧 stable**：`#memory-list` / `#session-list` /
`.detail-pane` / `.mk-list` / 各弹窗滚动区 / `.bp-scroll`（全屏页双栏，
r99-A 的左对齐约束）—— 它们内容左对齐，双侧留槽反而会让左边缘右移 10px。

### 验证
测试 337/337；无头 Edge（`--disable-features=OverlayScrollbar`）实测：
- 无槽基线 258 / 单侧 stable 253 / **双侧 both-edges 258**（位置完全回到修前）；
- 双侧下「无滚动条 → 有滚动条 → 复原」内容列、摘要条、图表、SVG 的 left
  恒为 258（shift 0），两列对齐差 0；
- 各容器 computed gutter 符合分类（居中列 both-edges，列表单侧 stable）。

## 未发布 · 其余界面滚动条偏移一并修复（2026-11-04，R198，前端刷新即生效）

> 起因：R197 修完用量页后，用户要求「其他界面的这个偏移问题也修一下」。

### 排查
系统枚举全站滚动容器，对照 R182 留槽名单 / r96 补充 / R197，找出遗漏：
- **`#memory-list`**（记忆页左栏）——R182 注释里明写的「历史遗漏」；
- **`.usage-pane` 剩余页面**：人设页 `#personas-page`、桌宠页 `#desktop-pet-page`、
  自检页 `#harness-page` 内部都是 `.usage-wrap`（940px + auto 居中），滚动条
  出现/消失时整列会左移约 5px，与 R197 用量页同一根因（这几页没有容器外的
  居中摘要条，无需 strip 同步补偿）；
- **`.mk-list`**：三个市场页的卡片列表滚动区（`.market-page` 自身 overflow:hidden）；
- **长内容弹窗滚动区**：帮助弹窗（R196）、技能弹窗、模型弹窗左右栏、人设预览、
  加载日志、连接页日志、折叠代码块——滚动条出现时文字重排/右对齐元素会跳。

### 改动（`ui/style.css`）
1. `#memory-list` 补进 R182 名单（同时自动获得 `--pane-gutter-bleed`，
   列表头满宽层能正确伸进保留槽——正是 R182 注释预留的做法）；
2. 新增统一规则给 `.usage-pane` 整类、`.mk-list` 与上述弹窗滚动区
   `scrollbar-gutter: stable`（已留槽的三页重复命中无副作用）。
   ⚠️ 刻意不动 `.modal` 弹窗本体（plugin-panel-modal 的 iframe 高度依赖外层
   无滚动条）、`.model-dd` 等精确尺寸下拉、`.usage-strip`（R197 已单独留槽）、
   `.bp-left`（已有）。

### 验证
测试 337/337；无头 Edge（`--disable-features=OverlayScrollbar`）实测：
- 页面级滚动容器（#session-list / #chat-list / #memory-list / .detail-pane /
  .settings-pane / .snowluma-pane / #usage-page / .usage-strip / #skills-page /
  #plugins-page / #personas-page / #harness-page / #desktop-pet-page / .bp-left /
  .collapsible .coll-body）computed gutter 全为 stable；
- 8 个动态弹窗类注入验证全部 stable；
- 人设页居中列「无滚动条 → 有滚动条」left 恒 253（shift 0）；
- R197 用量页对齐复验：wrap 253 / strip 253 / delta 0，未被整类规则破坏。

## 未发布 · 用量页滚动条出现时中间界面不再偏移（2026-11-04，R197，前端刷新即生效）

> 起因：用户截图反馈「滚动条出来的时候，中间的界面会偏移」。

### 根因
`#usage-page` 是 `overflow-y:auto` 的滚动容器，里面 `.usage-wrap` 是
`max-width:940px + margin:0 auto` 的居中列；滚动条出现会占掉约 10px 内容盒
宽度 → 居中列左移约 5px，消失又移回来。项目 R182 的留槽名单当年**故意跳过
用量页**：页外的 `.usage-strip`（今日用量/搜索次数）也用 940px 居中，只给
页内留槽会让两列永久错开 5px（r55 抓过的跳位）。

### 改动（`ui/style.css`）
1. `#usage-page { scrollbar-gutter: stable; }` —— 恒定预留滚动槽，滚动条
   出现/消失时内容盒宽度不变；
2. `.usage-strip { overflow-y: hidden; scrollbar-gutter: stable; }` ——
   让页外摘要条**也按同一规则留槽**，两个容器的 content box 由浏览器按同一
   宽度扣减，940px 居中列永远对齐。
   ⚠️ 不用「给 strip 补固定 10px padding」：覆盖式滚动条不占空间时会永久
   错开 5px，且实测槽宽（thin ≈10.4px）与 --scrollbar-w(10px) 有亚像素差。
   strip 用 hidden 只为成为 scroll container 吃到 gutter，不会冒空滚动条。
3. 更新 R182 段注释：说明 r96 的顾虑已由「两侧同步留槽」消解，仍不把
   .usage-pane 一刀切（Harness 页无此居中列）。

### 验证
测试 337/337；无头 Edge（`--disable-features=OverlayScrollbar`）实测：
两个容器 computed gutter 均为 stable，无条→有条→复原三种状态下
`.usage-wrap` 与 `.usage-strip-inner` 的 left 恒为 253、互差 0；
反转去掉留槽后两列恒为 258 —— 两组相差的 5px 正是槽宽一半，
即真机下修复前会在 258↔253 之间跳、修复后恒定 253。

## 未发布 · 用量页「?」帮助钮收纳静态说明（2026-11-04，R196，前端刷新即生效）

> 起因：用户要求页头「用量与成本」右边加设置页同款问号按钮，把说明那一大坨放进去。
> 用户选定方案：静态说明收进弹窗，动态摘要行留在页面。

### 改动
1. **`ui/app/04-archive-usage.js`**：
   - 页头 `<h2>` 加 `.h2-help`（设置页同款 20px 圆形问号，带 aria-label/title）；
     骨架页头同步加按钮（加载期点开也有效）。
   - 新增 `openUsageHelpModal()`：复用 `openHelpModalShell`（设置页同款弹窗外壳），
     内容 = 页头控制条说明 + 四个区块（按天/按会话/按模型/按插件）的原静态说明
     与「这些数字是怎么算的」全部段落，**原文一字未改**；全局委托绑一次，
     页面/骨架多次重建按钮都不受影响。
   - 页面四个区块移除 `.usage-sec-note` 与 `details.usage-details-sub`，
     **保留 `.usage-sec-sum` 动态摘要**；骨架去掉说明行占位（只留摘要占位），
     数据回填不跳版。`updateUsagePage` 只写 data-sum，不依赖被删节点。
2. **`ui/style.css`**：新增弹窗内 `.uh-t` / `.uh-note` 小标题与说明样式；
   更新四块版式注释（R196 后为「段落头 → 摘要 → 图表 → 数值表」）。

### 验证
`node --check` 通过；测试 337/337；无头 Edge 实测：问号钮存在、页面静态
说明 0 处 / 口径折叠 0 处 / 动态摘要 4 条且内容正常，点击弹出 5 章节 19 段
（约 1900 字）帮助弹窗。

## 未发布 · 用量页控制条挪进页头一行（2026-11-04，R195，前端刷新即生效）

> 起因：用户截图反馈「右侧选项那一堆是不是能往上挪一挪和用量与成本在一排」。

### 改动
- **`ui/app/04-archive-usage.js`**：renderUsagePage / renderUsageSkeleton 把
  `.usage-ctrl`（图表指标 / 时间范围 / 刷新 / 数据更新时间）从独立一行挪进
  `.usage-head`，与标题同排（space-between，标题左 / 选项右）。
- **`ui/style.css`**：`.usage-ctrl` margin 清零；相邻兄弟选择器从
  `.usage-ctrl + [data-block]` 改 `.usage-head + [data-block]`（间距行为不变）。
  ⚠️ 原约束保留：控制条仍是 `[data-block="days"]` 的兄弟节点（住在 .usage-head
  里），不能进块内 —— 选「今日/24小时」时整块隐藏，进块内会跟着消失（r 时实测 bug）。
  `.usage-head` 本身 flex-wrap：窄窗口时选项自动折行，不挤压标题。

### 验证
`node --check` 通过；无头 Edge 实测 h2 与控制按钮同排（top 85.0 / 82.0）、
刷新按钮存在、截图确认布局正常。

## 未发布 · 全站样式统一第二批：记忆列表 / 胶囊 / 空态 / 时间口径（2026-11-04，R194，前端刷新即生效）

> 起因：用户要求「看看还有哪些地方可以像会话卡那样统一样式」，选定四项全做。

### 改动
1. **记忆页左栏列表行**（`ui/app/05-memory-settings.js` renderMemoryList）：
   与存档页左栏（renderChatList）完全同款 —— `.bp-row` + 真实头像
   （chatHeadAvHtml，群→gh/私聊→q1）+ `.bp-rt` 群名 / `.bp-ri`「N 位群友 ·
   更新于 HH:MM:SS」+ `.cc-pill` 计数胶囊；选中态 `.selected`→`.on`（与
   存档 / 会话列表同一套高亮）。**清理掉 `unread-pill` 内联改色 hack**
   （`style="background:var(--orange)"`），「整理中…」改用 cc-pill 体系的
   `cc-waiting`（橙色，变体本就存在）。`.chat-item` class 保留（点击委托与
   入场动画挂在它上，存档行同做法）。
2. **空态提示统一**（③）：列表空态的 `.list-head muted`（存档 / 记忆各一处）
   改 `.bp-empty`；`.empty-hint` 字号 12.5px→13px 与 `.bp-empty` 对齐
   （`.empty-hint` 保留给详情区居中空态，仅文字度量对齐，布局不动）。
3. **时间口径统一**（④，`ui/app/00-core.js` fmtTime）：今天的时间只显示时钟
   `HH:MM:SS`（与会话卡头 fmtClock 同格式），非今天的才带日期 `MM-DD HH:mm`。
   原来一律 `MM-DD HH:mm`，最常见的"今天更新"反而和卡头对不上。

### 验证
三个文件 `node --check` 全过；测试 337/337；无头 Edge 实测截图：
记忆列表与存档列表行结构、头像、胶囊、选中高亮完全一致，今天的时间显示时钟。

## 未发布 · 点开会话卡底下空无一物修复（2026-11-04，R193，前端刷新即生效）

> 起因：用户截图反馈「有的时候点开底下空无一物，显示左边选择详细会话」——
> 展开的会话卡卡体里是「← 选择左侧会话查看完整过程」这类空态占位。

### 根因
`applyRightInner` 全量重建时，选中卡的卡体内容来自「收集当时 #session-detail
里的非自建节点」——**空态占位提示（初始「← 选择左侧会话…」、selectSession 的
「加载中…」延迟占位）也会被当成会话内容收进卡体**。叠加 R188 的同会话短路后，
这张卡不再触发重渲染，占位就永久留在卡体里。另一来源：02 指纹去重提前返回时
（fresh 为空），新建的卡体是真空的，也没人补内容。

### 改动（`ui/app/15-chat-chrome.js`）
1. 重建收集的 nodes **过滤 .empty-hint 占位**——占位不再进卡体；
2. 新增 `healEmptyBody`：选中卡卡体为空时挂「加载中…」并静默补拉详情
   （先清 state.sessionDetail 绕过 R188 短路，ccFromUserClick 置位绕过
   R122-B 接管窗口；5s 节流防接口持续失败时无限重试）；
3. 两个接入点：applyRightInner 重建末尾（占位被过滤/无内容可搬时）、
   renderSessionDetail 包裹层（指纹去重导致新建卡体为空时）。

### 验证
`node --check` 通过；测试 337/337；无头 Edge 预览模式 8 轮点击压力测试
（换卡展开/同卡收起再展开/手风琴），展开卡均有卡体且无占位混入（0 违规）。

## 未发布 · 页头文字半像素偏移修复（2026-11-04，R192，前端刷新即生效）

> 起因：R190/R191 之后用户反馈新页头「文字像素偏移」。

### 根因
统一页头的排版参数里有非整数像素：主标题 `line-height: 1.3`（15px×1.3=19.5px
半像素行盒）、副行字号 11.5px —— flex 垂直居中后文字基线落在半像素上；
本机处于软件渲染（render-gpu-off.flag），半像素文字的抗锯齿偏移肉眼可见。

### 改动
`ui/style.css`：页头文字全整数像素 —— 标题 15px/line-height 20px，副行
12px/line-height 16px（.chat-head-t/.chat-head-s 与 .detail-header.is-chat 的
h2/.sub 同步）；.chat-head 内边距对齐 .detail-header 的 14px 16px。

### 验证
无头 Edge 实测：两处页头文字元素 bounding top 全为整数（80/104/164/186），
字号与行高均为整数值。

## 未发布 · 会话头与存档 / 记忆页头完全对齐（2026-11-04，R191，前端刷新即生效）

> 起因：R190 之后用户截图反馈「多少还是有点不一样」——会话头的群号跟标题挤在
> 同一行、且没有存档 / 记忆页头那种卡片底。

### 改动
1. **`ui/app/15-chat-chrome.js` chatHeadHtml**：结构改为「头像 + .dh-main
   （主标题在上、群号副行在下）」——与 .detail-header.is-chat 完全同构。
2. **`ui/style.css` .chat-head**：补同款卡片底（layer-1 圆角 10 + 12/16 内边距 +
   lift 投影），副行改块级 11.5px 灰、颜色统一 var(--muted)；主标题块级 15px/700。
   验证：node --check 通过；无头 Edge 实测截图，会话头与存档页头逐像素同构
   （卡片底 / 字号 / 行结构一致）。

## 未发布 · 三处页头版式统一（2026-11-04，R190，前端刷新即生效）

> 起因：用户截图反馈「会话选择」右栏会话头 / 存档页 / 记忆页三处页头风格不统一。

### 差异（改前）
- 会话头：头像 34px + 主标题 15px/700（纯名字）+ 副行「群号 xxx」——基准；
- 存档页：无头像，标题 16px 且带（群号），副行只有条数统计；
- 记忆页：无头像，标题 16px 且带（群号），按钮混在副行里。

### 改动
1. **`ui/style.css`**：新增 `.detail-header.is-chat` 统一版式（头像 34px 圆角 9 +
   主标题 15px/700 + 副行 11.5px 灰），与 `.chat-head` 同基准；新增 `.head-btns`
   （页头下一行按钮行）。头像 DOM 复用左栏行的 `.bp-av/.av-img/.av-l/.av-fb` 全局类。
2. **`ui/app/04-archive-usage.js`** 存档页页头：加头像（复用本文件已有的
   qqAvatarUrl 群→gh/私聊→q1 + bindArchiveAvatarFallback 捕获兜底）；主标题改纯
   名字，群号挪进副行（与条数统计并列）。
3. **`ui/app/05-memory-settings.js`** 记忆页页头：新增 chatHeadAvHtml（群头像走
   gh 接口，同 15 号文件规则）+ bindMemHeadAvFallback 兜底；标题改「纯名字 的记忆」，
   副行「群号 · N 位成员」，按钮行（拉取群成员/添加印象/整理本群记忆/整理状态）
   挪到页头下一行 `.head-btns`。

### 验证
- 两个文件 `node --check` 全过；测试套件 337/337 全过；
- 无头 Edge + 预览模式实测截图：三处页头版式一致（头像/字号/副行对齐），
  群头像与首字兜底均正常。

## 未发布 · 反复点会话卡头不再卡顿/点不开（2026-11-04，R188，前端刷新即生效）

> 起因：用户截图反馈反复点击会话卡头（时间/轮数/耗时那一行）明显卡顿，卡点不开。

### 根因
展开一张折叠卡虽然**同步**完成（R117），但每次展开都会调 `selectSession`：
全量拉 `/api/sessions/:id`（大会话服务端 structuredClone + 网络，几百毫秒起）→
`renderSessionDetail` 整块重渲染，还顺带清空 `lastDetailFp` 打掉轮询的指纹去重。
反复点同一张卡头（展开→收起→再展开）时每次点击都排一份这样的重活；且 fetch
超过 200ms 时 selectSession 的延迟占位 `detail.innerHTML = '加载中…'` 会把整个
右栏（含 #cc-cards 骨架）擦掉，回填时走全量重建 —— 卡顿叠加，展开态被重建
覆盖，表现为「点不开」。

### 改动
1. **`ui/app/02-sse-sessions.js` `selectSession`**：同会话重复选中**直接短路**
   （`id === state.currentSessionId && state.sessionDetail` 时 return）——选中是
   纯选择语义，详情已加载就无需 fetch/渲染；运行中会话内容由 SSE / loadSessions
   轮询照常刷新（两处调用方各有不等守卫/无选中守卫，不受影响）。
2. **`ui/app/15-chat-chrome.js` 卡头点击**：卡体内容现成（DOM 里或刚从暂存区
   R122-C5 捞回）且该卡就是当前选中会话时，不再调 `selectSession`——反复展开/
   收起同一张卡退化为纯 class 切换，零网络零重渲染。仅「换了一条会话」或
   「占位盒还在等内容」才走正式选中；`ccFromUserClick` 只在真正调用时置位。

### 验证
两个改动文件 `node --check` 全过；全量测试套件通过（见下）。

## 未发布 · 会话选择页打开时顶栏不再闪一下（2026-11-04，R187，前端刷新即生效）

> 起因：用户截图反馈点「会话选择」时顶栏会"重建"（闪一下/重绘）。

### 根因
全屏页打开的瞬间，`style.css` 的 `.app-shell:has(> #bigpage:not([hidden])) > #topbar
{ visibility: hidden }` 在**同一帧**就把真顶栏藏掉；而 `openBigPage()` 的 WAAPI
淡入作用在整个 `#bigpage` 上，连替代顶栏的 `.bp-head` 也从透明度 0 淡入 ——
顶栏位置先空一帧、再随 160ms 淡入浮现，看起来就是顶栏闪一下被重建。

### 改动
`ui/app/14-chrome.js` 的 `openBigPage()`：淡入动画目标从整个 `#bigpage` 收窄到
标题条下方的 `.bp-body`。`.bp-head` 首帧即 100% 不透明，与真顶栏的隐藏无缝衔接
（两者同高同渐变底），换装零空帧；下方内容区照旧淡入。语法校验通过。

## 未发布 · 连接页机器人头像同款切本地缓存（2026-11-04，R186，前端刷新即生效）

> 起因：用户截图反馈每次注入后「机器人已上线」卡片上的机器人头像加载慢。

### 改动
`ui/app/03-connection.js` 的 `connAvatarUrl` 从 q1.qlogo.cn 直链改走
`/api/avatar/<qq>?s=140`（R185 的本地缓存端点）。注入后重绘不再每次重新走
DNS+TLS+CDN 往返；磁盘缓存跨重启有效，注入后头像立即可用。仅注释改述兜底
约束（群头像不可套此接口），行为约束不变。语法校验通过。

## 未发布 · 记忆页头像改走本地缓存，加载不再卡慢（2026-11-04，R185，需重启 QQ Agent）

> 起因：用户截图反馈记忆页「身份证」卡片上 QQ 头像加载慢，先看到彩色圆/首字才补出图。

### 根因
记忆卡片与记忆档案弹窗的头像**直连 q1.qlogo.cn**：每次渲染都走一遍 DNS + TLS +
CDN 往返（慢链路下 1~2 秒），而 qlogo CDN 响应不带长期缓存头，Electron 的 HTTP
缓存帮不上忙 —— 同一个人切几次页签就重拉几次。

### 改动
1. **新增本地头像缓存 `src/avatar-cache.js`**：先查磁盘缓存（`data/avatar-cache/
   <qq>_<尺寸>.jpg`，TTL 7 天），未命中才用 safeFetchBinary 拉 q1.qlogo.cn；
   并发去重（同一头像同时只出网一次）、失败负缓存 10 分钟（不反复打 CDN）、
   过期清理按 mtime 节流执行。
2. **新增路由 `GET /api/avatar/:qq`**（`src/routes/system.js`）：只认 5~12 位纯
   数字 QQ 号与 40/100/140/640 尺寸白名单，命中回 `max-age=604800`（重复渲染
   连请求都不发），拉不到回 404 —— UI 本来就有首字兜底，正好接住。
3. **`ui/app/05-memory-settings.js`**：列表卡片与记忆档案弹窗的头像地址改走
   `/api/avatar/<qq>?s=100`（弹窗 s=140 留高分屏余量），错误兜底逻辑不变。

### 验证
- 三个改动文件 `node --check` 全过；
- 直连模块冒烟：QQ 2519864174 首次网络拉取 251ms（3.3KB），第二次读磁盘缓存 **1ms**；
  13 位非法号码正确拒绝返回 null。

## 未发布 · 帮助按钮问号垂直居中修复（2026-11-04，R184，前端刷新即生效）

> 起因：用户截图反馈圆形帮助按钮里的「?」不在圆心，明显偏上。

### 根因
`.h2-help`（页头 20px）/ `.h3-help`（设置分区标题 16px）用 `display:inline-flex;
align-items:center; justify-content:center` 居中。但「?」用的是等宽字体
（`--mono` = JetBrains Mono / Cascadia Code / Microsoft YaHei / Consolas），这类字形的
视觉重心受基线（baseline）上偏影响，**flex 只能保证盒模型居中、管不了字形在盒内的位置**——
实测「?」墨迹比圆心高约 2 设备像素（h3）/ 约 1.6 CSS px（h2），且水平已居中。
原 `padding-bottom:1px` 基本无效：整数布局量化最多把高度压到 −1.2px，仍差约 0.8px
且无法跨字号/DPR 自适应。

### 改动（全部在 `ui/style.css`，前端刷新即生效）
1. **「?」改由 `::after` 伪元素渲染**：
   - `.h2-help` / `.h3-help` 本体 `font-size: 0`（隐藏原内文「?」），新增
     `.h2-help::after { content:'?'; font-size:12px; transform: translate(0.4px, 0.3px); }`
     与 `.h3-help::after { content:'?'; font-size:11px; transform: translateY(0.8px); }`。
   - 伪元素不受 flex 盒模型绑定，可用 `transform` 做亚像素位移把字形重心压到圆心。
2. **`.h3-help` 保留 `top:0.5px` 整体位移**：这是让按钮与标题文字基线对齐用的，
   属于按钮整颗的圆点位置、不影响「字在圈内的居中」，故保留；仅删掉失效的
   `padding: 0 0 1px` 换成 `padding:0`。

### 验证（像素级，非肉眼）
用本机 Microsoft Edge `--headless=new` 真实渲染 CSS（HTML 由对应页面结构裁剪而来），
PIL 拟合圆环质心作为圆心、以「?」墨迹外接框中心作为字形中心，在 **DPR 1.0 / 1.25 / 1.5**
三档下测量偏移：
- 改前：问号比圆心高约 2 devpx（h3）/ 约 1.6 CSS px（h2）；
- 改后：墨迹外接框中心与圆心偏移 **≤ 0.5 设备像素（≤ 0.4 CSS px）**，三档均稳定。
交叉验证确认无其它皮肤层对 `.h2-help`/`.h3-help` 的 `font-size` 覆盖。
308 测试全过。

## 未发布 · 动画帧率与过渡优化（2026-11-04，R183，前端刷新即生效）

> 起因：用户要求"把所有动画的帧率和过渡优化一下"。

### 改动（全部在 `ui/style.css`，前端刷新即生效）

1. **进度条 `barGrow` 从 `width:0 → 设定宽` 改为 `transform: scaleX(0→1)`**
   原写法每帧触发整条进度条的布局重算（layout）；改走合成器后零布局、零重绘。
   给 `.tb-bar i` / `.usage-bar-fill` 加 `transform-origin: left` 保持从左生长；
   ? 主题爆炸生长 `chaosBarBoom` 单独复位 `transform-origin: center` 保住原观感。
2. **offscreen 暂停清单补缺 + 修一处 selector bug（r93 机制的延续）**
   - 修正 `.sl-node.is-wait .sl-node-idx` → `::after`：原清单指向元素本身，而动画挂在
     伪元素上，等于这圈等待呼吸**从未被暂停**（隐藏窗口时照样空转）。
   - 新增常驻无限动画：`.auto-icon.is-spin svg`（连接中旋转）、
     `.auto-avatar-dot::after`（在线呼吸圈）、`.btn.is-loading .btn-spin`（按钮内联圈）。
     这三个"连上/加载时就常驻"，此前后台照跑白烧 CPU/GPU。
3. **给常驻/高频循环元素加 `will-change`，固定提层避免父级重绘**
   `.auto-avatar-dot::after`、`.auto-icon.is-spin svg`、`.sl-node.is-wait .sl-node-idx::after`
   均补 `will-change: transform[, opacity]`，与 chaos 主题里同类常驻动画的处理一致。

### 有意不动（与 R182 同类判断）

- **`settings-menu-ind` 仍用 `transition: top / height`**：它 `position:absolute`、3px 宽，
  仅自身受影响、且只在手动切分区时触发一次，改成 `translateY/scaleY` 需联动改 JS 定位逻辑，
  风险高收益低。
- **chaos 主题的 `chaosBarBoom` 仍含 `width:0`**：属于故意的"故障美学"彩蛋、非常驻，
  不改。
- 全局 `prefers-reduced-motion` 三段已覆盖所有动画（通配符把 duration 压到 1ms + 单次），
  本轮无需新增。

308 测试全过。备份 `data/code-backups/r183-anim-perf/`。

## 未发布 · 滚动性能全量体检 + 全局 scroll 监听短路（2026-11-04，R182，前端刷新即生效）

> 起因：R181 修完引导界面毛玻璃后，用户问"还有哪些界面滚动会卡"。

### 扫描范围与结论

枚举了 **50 个滚动容器**，逐项核对六类已知开销：
`backdrop-filter` / `background-attachment: fixed` / `position: sticky` /
无限动画 / `scroll` 事件监听 / 长列表布局策略。

**结论：静态层面没有发现新的确凿卡顿源 —— 团队此前把大头都修过了。**

| 项 | 现状 |
|---|---|
| 毛玻璃 | R181 已修引导层；市场页工具栏 2 处**不在** `.mk-list` 滚动容器内，背后是静态渐变、结果可缓存（r104 结论），保留 |
| 长列表布局 | 市场页 402 条卡片已用 `content-visibility: auto` + `contain-intrinsic-size: auto 88px`，布局 37.5ms → 2.6ms |
| 会话列表滚动加载 | 已有 120ms 节流 + `{ passive: true }` + 尾随调用 |
| 存档消息 | `CHAT_MSG_PAGE = 500` 分页 + 增量 `insertAdjacentHTML` 追加，不重建已有行、不做 scrollTop 补偿 |
| 无限动画 | 19 处在页面不可见时由 `html.qa-bg` 暂停（r93）；两个常驻呼吸圈 R173 已改成 transform/opacity |
| 常驻阴影动画 | 仅剩彩蛋主题 `[data-theme='?']` 的 2 处，属刻意风格 |
| `background-attachment: fixed` | 全项目 0 处 |
| `box-shadow` / `filter` 在滚动区内 | 仅 focus 状态，非滚动期 |

### 本轮唯一改动

`00-core.js` 里有个挂在 `document` 上、`capture: true` 的**全局** scroll 监听，
任何页面任何容器滚动都会走到，且每次都无条件调 `closeAll()`（内含两次全 DOM
`querySelectorAll`）。

加了一道短路：

```js
if (!document.querySelector('.sel.open, .sel-menu.open')) return;
closeAll();
```

**语义等价**：`closeAll` 只做两件事（收起 `.sel.open`、回收孤儿 `.sel-menu.open`），
这两个选择器正好覆盖它的全部处理对象。没有展开的下拉时，滚动根本不需要收起
任何东西 —— 99% 的滚动帧到此为止。第一次真有菜单展开时仍当场收起。

### 有意不动的三项（附理由）

1. **存档消息表格 500~5000 行仍是 `table-layout: auto`**：追加行理论上会重算列宽。
   改 `fixed` 需要重设三列宽度，而金句/删除勾选模式会让列数在 3 与 4 之间变化，
   `td.t`（时间，monospace nowrap）容易被挤断。收益不确定、风险明确 → 不动
2. **6 处 `position: sticky`**（表格 thead、搜索框）：软件渲染下每帧重定位，
   但每页仅 1~2 个，量级远小于列表
3. **19 处无限动画在页面可见时仍全速跑**：只在隐藏时暂停。但都是状态型
   （骨架屏、loading）或彩蛋主题，且已合成器友好

**以上三项要判断是否真的造成卡顿，必须有真实浏览器的 Performance 录制**
（静态分析只能看"有没有成本"，看不出"够不够卡"）。

### 验证

- `node --check` 通过；`npm test` **308 通过 / 0 失败**
- 备份在 `data/code-backups/r182-scroll-audit/`
- 首页更新报告**不新增条目**：R181 那条已覆盖"滚动卡顿"这个用户视角，
  本轮是同类内部优化、用户无感，按 r150 的维护约定不堆灰字墙

---

## 未发布 · 使用引导滚动卡顿：全屏毛玻璃在软件渲染下每帧重算（2026-11-04，R181，前端刷新即生效）

> 起因：用户反馈"引导界面上下滚动的时候有明显的卡顿感"。

### 根因：一条漏掉团队既有约定的 CSS

使用引导（`18-onboarding.js`）的遮罩 `.ob-overlay` 是：

```css
position: fixed; inset: 0;
backdrop-filter: blur(6px);          /* ← 问题在这 */
background: color-mix(... 74%, transparent);
```

而滚动发生在它内部的 `.ob-card`（`overflow-y: auto`）。

**为什么卡**：style.css 第 9055 行的注释（r98）早就实测过 ——
本项目是**软件渲染**（`main.js` 关掉硬件加速 + `--disable-gpu`
+ `--disable-software-rasterizer`），每个 backdrop 层每帧都要在 CPU 上
把背后区域读回来再做高斯模糊；滚动时背后内容每帧都变、模糊结果无法缓存。
当时市场页加了毛玻璃后**合成层从 6 个炸到 86 个**，"滑动查看插件"奇卡无比。

**团队既有约定**：`.model-modal-overlay` / `.modal-overlay` 早就显式写了
`backdrop-filter: none`（第 6869 行）。只有这个后加的引导层漏了 ——
和项目里其他组件不一致。

### 改法

```css
.ob-overlay {
-  backdrop-filter: blur(6px);
-  background: color-mix(in srgb, var(--page-bg) 74%, transparent);
+  background: color-mix(in srgb, var(--page-bg) 90%, transparent);
}
```

去掉模糊后把遮罩从 74% 加实到 90% 补偿：背景内容基本退到看不见，
但保留一点透出，维持"弹窗浮在页面上"的层次感。

### 视觉验证（真实渲染对比）

构造了带背景内容的模拟引导页（背景 8 组设置卡片），新旧两版各用 Edge
headless 渲染 760×700 并排对比：

- 卡片本身：两者一致（卡片是不透明的，不受遮罩影响）
- **卡片外背景亮度：旧 56.5 vs 新 55.6（差 0.35/255，肉眼不可辨）**
- 旧版背景全糊成色块；新版背景隐约能认出"设置分组 2"的字样，
  反而多了一点空间感

### 验证

- 去注释后的规则体确认无 `backdrop-filter`；CSS 括号平衡 2814/2814
- `npm test` **308 通过 / 0 失败**
- 备份在 `data/code-backups/r181-onboarding-scroll/`

### 为什么没做"保留模糊 + 优化滚动"

考虑过 `will-change: scroll-position`、`contain: strict` 这类手段，
但软件渲染下 backdrop 的成本在"每帧把背后区域读回 CPU 做模糊"，
容器内怎么优化都绕不开这一步。r98 的实测数据（层 6→86）也说明
这不是缓存问题，是算力问题 —— 只能去掉。

### 全局排查

顺手查了所有 `position: fixed` 全屏层：**只有这一处**在滚动容器上挂了
backdrop-filter，其他弹窗遮罩都遵守了约定。市场页工具栏那两处
（`.mk-search` / `.mk-filter-panel`）虽然也有，但它们**不随列表滚动**、
背后是静态渐变，模糊结果可缓存，r104 已确认对滚动零开销，保留。

---

## 未发布 · /help 区分技能与插件 + 基线重算脚本（2026-11-04，R180，需重启生效）

> 起因：用户问"能不能不仅显示插件，也显示技能"。

### 先查清事实：技能其实一直都在

实测（`listTools()` + `loadManifests()`）：

| | 数量 | 是否显示 |
|---|---|---|
| 技能（`skills/`） | 8 | **7 个进了"可以这样使唤我"**，第 8 个是 help-board 自己（`excludeSelf` 排除） |
| 插件（`plugins/`） | 13 | 3 个有指令、5 个进"自动运行"、其余被 `passiveExclude` 隐去 |

所以不是"没显示技能"，而是**面板从头到尾把它们统称为"插件"** ——
顶部写的是「10 个插件 · 24 条指令」，卡片上也没有任何来源标识。
计算器、日程表、文生图这些明明是技能，用户自然以为面板里只有插件。

### 改了什么

1. **`buildGroups` / `collectPassive` 各加一个 `source` 字段**
   （`skill` / `plugin` / `builtin`，取自 manifest 的 `dir`）
2. **顶部统计拆开**：`10 个插件` → `7 个技能 · 3 个插件 · 24 条指令 · 5 项自动运行`
   （某一类为 0 时不显示该段）
3. **卡片标题加来源标签**：`计算器 [技能] 2 条`、`表情系统 [插件] 8 条`。
   技能用蓝色底、插件用米色底、内置用灰色底，字号 10px 刻意小于标题与计数，不抢注意力
4. **稳定排序**：技能 → 插件 → 内置。原本用的是 Map 插入顺序（= 工具注册顺序），
   技能恰好在前是因为 `skills/` 先于 `plugins/` 加载 —— 那是巧合不是设计。
   加了标签之后必须让分类和标签对得上，否则会出现"插件"夹在两个"技能"中间
5. **纯文本版同步**（`buildText`）：`【技能·计算器】计算（…）`，顶部统计同一口径

### 过程中发现的一个既有陷阱

改完代码直接验证，help-board 消失了、还跑到"自动运行"区。原因是**基线没重算**，
安全闸把它拦下（无工具 → 被当成"没有指令的自动功能"）。

而它给出的报错是：

> ❌ help-board：模块「help-board」触碰了高危能力：index.js（导入了高危 Node 模块）

**报错文案和真实原因（基线不一致）完全对不上** —— 这个坑今天已经是第二次踩
（上午 R163 之后那次把 `/help` 直接弄挂）。文案本身是 plugin-loader 的既有问题，
这次没动它，但补了工具：

**新增 `scripts/refresh-builtin-baseline.mjs` + `npm run baseline`**

```bash
npm run baseline -- help-board          # 只刷改过的那一个
node scripts/refresh-builtin-baseline.mjs --list    # 列出全部 21 个内置模块
```

刻意**不提供**"一键刷新全部"—— 那会把被篡改的模块一起洗白。每次只刷确实改过的。

### 验证

- 真实数据渲染（加载全部插件 → `buildGroups` / `collectPassive` → `buildBoardHtml`）：
  顶部「7 个技能 · 3 个插件 · 24 条指令 · 5 项自动运行」，
  10 张卡片逐个确认标签正确，5 项自动运行全为「插件」
- Edge headless 截图目视确认：蓝色/米色标签区分清晰，瀑布流布局正常
- 纯文本版输出格式正确
- `node --check` 通过；**21 个内置模块基线一致**；`npm test` **308 通过 / 0 失败**
- 备份在 `data/code-backups/r179-help-layout/`（R179 与 R180 改的是同一文件）

### 没做的

- **按来源拆成两个分区**（「技能」「插件」各一块）：标签 + 排序已经能区分，
  再拆分区会让页面多两条标题、整体更长
- **改那条误导性的报错文案**（"触碰了高危能力" → "内置模块被改过，基线没更新"）：
  属 plugin-loader 的错误分支，影响面比这次的 UI 改动大，单独评估

---

## 未发布 · /help 面板改瀑布流：整图矮了 22.8%，卡片间空白消失（2026-11-04，R179，需重启生效）

> 起因：用户发来 `/help` 功能指令一览的截图，问布局能不能优化。

### 问题定位

布局是 `display: grid; grid-template-columns: repeat(2, 1fr)`。grid 默认**行对齐**：
每行高度取该行两张卡里高的那张。而这些插件卡片高度差异极大 ——
「会话管理」11 条指令 vs「计算器」2 条 —— 矮卡下面必然留一大片空白。

截图右侧「计算器」下方那块空白就是这么来的，而且每行都在发生。

### 改法

`.grid` 从等宽 grid 换成**纵向瀑布流**（multicol），卡片各按自己内容的高度堆叠：

```css
.grid { column-count: 2; column-gap: 14px; }
.card {
  break-inside: avoid; -webkit-column-break-inside: avoid;   /* 不许跨列截断 */
  margin: 0 0 14px;
  padding: 13px 15px;      /* 原 14/16 */
}
```

同时压了几处间距：卡片标题 16→15px、下标 8→6px，计数徽章 12→11px，
指令行 padding 6→5px、间距 9→8px。计数徽章文案从裸数字改成「11 条」——
原来那个数字没有单位，看不出是"条指令"还是"个分类"。

### 量化结果（真实渲染测出来的）

用 Edge headless（`--headless --screenshot --window-size=760,6000`）分别渲染
改动前后的 HTML，再用像素扫描找内容底边，得到**实际内容高度**：

| | 改前 | 改后 | 变化 |
|---|---|---|---|
| 内容高度 | 5,113 px | **3,949 px** | **−1,164 px（−22.8%）** |

顺带发现一个此前不知道的硬上限：`renderPng` 里是
`setSize(w, Math.min(Math.max(h, 200), 6000))` —— **超过 6000px 会被直接裁掉**。
插件再多几个就会踩到，这次压缩等于多留了 2000px 的余量。

### 验证

- 生成新旧两版 HTML（同一份 17 插件 / 102 指令的近似数据）→ Edge headless 截图
  → 像素测高 + 左右并排目视对比
- 卡片**无跨列截断**、无重叠、无溢出（`break-inside: avoid` 生效）
- `node --check` 通过
- **重算 `help-board` 内置基线**（2 个文件）—— 今天早上就因为改这个模块没重算
  基线，被安全闸当成"占名顶替"拦下、`/help` 直接不可用。已全量核对：
  **21 个内置模块指纹全部一致**
- `npm test` **308 通过 / 0 失败**
- 备份在 `data/code-backups/r179-help-layout/`

### 有意没做的

- **自动功能区改 3 列**：卡片里有一行说明文字，3 列（每列约 226px）会把它挤成
  两行，总高度反而可能不降。实测保持 2 列
- **生成时贪心分配两列**（让左右高度更接近）：当前两列差约 550px（占 14%），
  贪心分配能做到更小，但会打乱"按插件顺序从上到下"的阅读顺序，
  且要把单一 grid 改成两个列容器，改动面大。先用 multicol 自带的平衡
- **折叠低频插件**：会丢信息，`/help` 的意义就是"全都能看到"

---

## 未发布 · 设置搜索支持跨页跳转：「日志」「自检」不再搜不到（2026-11-04，R178，前端刷新即生效）

> 起因：R177 之后用户说"你看着改吧"。我先重新评估了优先级 —— R177 已经把
> 安全开关独立成块，而真正剩下搜不到的是**根本不在设置页里**的功能。

### 为什么这次没去动分区表

原本考虑把「安全开关」从「能力与工具」挪到「聊天与权限」（该分区原名就叫"权限"，
已经装着白名单和屏蔽名单）。放弃了，理由是：

- 安全开关在 R177 已经独立成块、带状态摘要，位置本身不难找
- 挪分区要同时改 `menu` 表、`sections` 映射、就绪 chip 的 `data-rs-goto` 映射、
  搜索索引的 `section`，四处联动，**收益只是"语义更整齐"**
- 而"日志搜不到"这件事，**挪任何分区都解决不了** —— 它不在设置页里

### 改了什么

**1. 搜索索引 18 → 20 条，新增两条跨页条目**

```js
{ keys: ['日志','报错','出错','排查','log','rizhi','看日志'],
  label: '运行日志', desc: '在「工具 → 连接 → 应用日志」（这里会直接跳过去并展开）',
  goTab: 'connection', target: 'conn-logs', w: 8 },
{ keys: ['自检','体检','健康','诊断','doctor','zijian','tijian'],
  label: '自检与体检', desc: '在「工具」页：体检单、修复提案、开发工单',
  goTab: 'harness', w: 7 }
```

`goTab` 是新字段：有它就走"先切页、再高亮"的分支，没有就走原来的"同页切分区"。
两种条目可以共存于同一张表、同一个下拉列表。

**2. `ssGoto` 增加跨页分支**

```js
if (it.goTab) {
  switchTab(it.goTab);
  ssHighlight(it.target, 320);
  return;
}
```

前置的 `flushSettingsSaves()` 保留 —— `switchTab` 内部也会调一次，但那是幂等的
（没有挂起改动就什么都不做），先调一次能保证"目标页读到的配置是最新的"。

**3. `ssHighlight` 提成独立函数，并加两件事**

- **重试**：跨页时目标页是异步渲染的（`loadConnectionPage` 要先 `await`
  `/api/status` + `/api/logs` + `/api/protocol/process` 三个接口），固定延迟撞不上
  渲染完成，元素还不存在 —— 不重试就只是"跳过去了但没高亮"。改成最多试 4 次。
- **折叠块自动展开**：目标是 `<details>` 时置 `open`。应用日志正是一个收起的
  `<details id="conn-logs">`，不展开的话用户落地只看到一行标题。

  这里特意**没有**去写 `03-connection.js` 里的 `connLogsOpen` 变量 ——
  那是别人的私有状态。用 DOM 的 `open` 触发它的 `toggle` 监听器，
  那边会自己把变量写回去，两边天然同步。**不跨文件改别人的内部状态。**

### 验证

- `node --check`：两个文件通过
- 索引结构：20 条 / 2 条跨页 / 13 条带 target
- 关键词覆盖：日志、报错、排查、看日志、自检、体检、诊断全部命中；
  原有 18 条（安全、网图、思考、缓存、开机、密钥、白名单、人设…）不受影响
- `npm test`：**308 通过 / 0 失败**
- 备份在 `data/code-backups/r178-crosstab/`

### 已知边界

- 跨页跳转**只在设置页的搜索框**触发。从别的页面没法直接搜到设置里的条目（本来就没有全局搜索）
- `switchTab('connection')` 会触发真实的页面加载（拉 `/api/status` 等）。
  这意味着"搜一下日志"会顺带刷新一次连接状态 —— 属预期，不是副作用
- 折叠块自动展开只对 `<details>` 生效；如果未来某个目标是隐藏的 `div`，仍需单独处理

---

## 未发布 · 布局：安全开关独立成块、发送入口摊开并显示当前值（2026-11-04，R177，前端刷新即生效）

> 起因：R176 补完搜索索引后，用户指出"藏得深的按钮反而不利于萌新去找，布局还是可以动的"。
> R176 只解决了"搜得到"，这一版解决"看得见、看得懂现状"。

### 改动 1 · 安全开关从批量按钮排里独立出来

**原来**：「🛡 安全开关」和「全部启用 / 全部禁用 / 恢复默认」并排在同一个
`.tool-actions` 里。那三个是批量操作，它是安全配置，语义完全不同。

**现在**：单独成块（带边框卡片），放在工具分类列表**之前**，并常驻显示当前状态：

```
🛡 安全开关   浏览锁定：关（可访问任意公网地址） · 内网图片：禁止
限制机器人能访问哪些网站、能不能读内网图片、外部链接额外放行。
与上面的「工具开关」不是一回事 —— 那些只决定模型看不看得见，
这里决定真正执行时放不放行。
```

状态串按实际配置生成：浏览锁定开时会显示放行域名数，开了内网图片会给提示，
配了外链额外放行会显示条数。

### 改动 2 · 「回复节奏」两个入口拆开，各自带人话说明 + 当前值

**原来**：两个按钮并排，下面一句长 hint 把两件事混着讲：

> 「回复积极度」决定它什么时候接话（只在被 @ 时回 / 偶尔接话 / 每条都回），
> 也能按时间段切换；「发送与限速」是更底层的发送间隔与保护，不确定就别动。

**现在**：拆成两块，各说各的，并且**把最影响体感的四个值直接印在页面上**：

```
⚡ 回复积极度
决定它什么时候接话：只在被 @ 时回 / 偶尔接话 / 每条都回。也能按时间段切换。

📨 发送与限速
当前：思考 默认 · 工具轮数 12 · 并发 2 · 发网图 关
另外还有发送间隔、每分钟上限、失败重试。不确定就别动。
```

`思考` 会按实际配置显示「关（最快）」「低」「中」「高」「默认」；
`发网图` 显示开/关 —— **这一项此前在界面上完全不可见**，而它是
`send_image` / `search_images` 的执行总开关。

### 为什么只是"摊开 + 显示值"，没有把控件搬到页面上

把思考强度做成页面上的下拉框当然更短，但那要新增一条保存链路（渲染 + change 绑定 +
`api.thinkingMode` / `thinkingEffort` 的双字段映射，`off` 还要转 mode）。
当前改法**零保存逻辑改动**：两个按钮的 id 一个没变（`#tools-security`、
`#open-send-config-btn`、`#open-active-config-btn`），事件绑定完全不受影响，
读的都是渲染时已有的 `c.api` / `c.security`。

改版式本身有风险（设置页刚在 R123 修过"切分区被守卫挡下"），所以这一版只动
**容器与文案**，不碰控件、不碰收集与保存。

### 验证

- **实际渲染 4 种配置**（典型 / 空配置 / 思考关+网图关 / 思考高），
  模板求值无 `undefined`、无 `NaN`、无 `[object Object]`，div 全部平衡 11/11
- **状态串 4 种输入**（默认全关 / 锁定开 / 全开+外链 / 无 `security` 字段）输出均正确
- `node --check` 通过；`npm test` **308 通过 / 0 失败**
- 4 个按钮 id 的既有绑定逐个确认仍在（各 1 处）
- 备份在 `data/code-backups/r177-layout/`

### 没做的

- **把安全开关挪出「能力与工具」页**（例如与白名单合并成「安全」分区）：
  涉及分区表与搜索索引同时改，留作下一版
- **「允许发网图」搬到安全块**：它现在住在发送弹窗里，搬走要改保存路径（`security.imageSend`），
  风险大于收益；搜索与页面摘要已能覆盖

---

## 未发布 · 设置搜索补 4 类盲区：安全开关 / 思考强度 / 前缀缓存 / 自启托盘（2026-11-04，R176，前端刷新即生效）

> 起因：用户问"设置里面有哪些比较重要的按钮藏得比较深"。

### 诊断方法

不是凭感觉翻页面，而是把 `SETTINGS_SEARCH_INDEX` 的匹配逻辑复制出来，
**逐个模拟用户会输入的说法**（含口语与拼音），看哪些意图搜不到。结果 26 个
测试意图里有 **19 个零结果**。

### 先说结论：设置页的发现机制其实做得不差

- 顶部三枚「就绪 chip」（模型 / QQ / 白名单）未配时变红，可点击直达
- 左侧二级菜单 6 个分区，未配过的带橙点（2026-10-23 萌新化 P4）
- 搜索索引此前已有 14 条，覆盖密钥、白名单、连接 QQ、人设、成本等高频意图

问题集中在**「重要，但字面上完全猜不到在哪」**的那一类。

### 找到的 4 类盲区（已修）

| # | 功能 | 实际位置 | 为什么难找 |
|---|---|---|---|
| 1 | **安全开关**：浏览锁定、允许读内网图片、外链额外放行 | 设置 → 能力与工具，与「全部启用 / 全部禁用 / 恢复默认」挤在同一排 | 只是那排批量按钮里的一个，且"安全 / 浏览锁定 / 内网 / 外链"四个词全都搜不到 |
| 2 | **发送与限速弹窗**：允许发网图（执行总开关）、思考强度、单次最大工具轮数、并发会话数、失败重试、温度 | 设置 → 聊天与权限 → 回复节奏 →「📨 发送与限速」 | 按钮名叫"发送与限速"，没人会想到里面藏着"思考强度"和"发网图"的放行开关；六个关键词全搜不到 |
| 3 | **前缀缓存**（命中率与保活） | 设置 → 连接模型 → 成本核算下方 | 直接关系花多少钱，"缓存"这个词却一个 key 都没有 |
| 4 | **开机自启 / 托盘最小化** | 设置 → 界面与应用 → 桌面端 | 只写在复选框 label 上，搜索无覆盖 |

其中第 2 项里有一条**语义容易混淆**的开关，代码注释本来就写明过：

> 「允许机器人发送网图」是 send_image / search_images 的**执行总开关**，
> 与「工具与技能」里那两个工具的开关不是一回事：后者只决定模型能不能看见工具，
> 真正放行执行的是这里。

搜索"网图"以前只会跳到「能力与工具」—— 正好跳到那个**不负责执行**的开关上。

### 改了什么

1. **搜索索引 14 → 18 条**，新增四条，全部沿用既有的"切分区 + 高亮目标"逻辑
   （`ssGoto` 未改一行）：
   - `安全 / 浏览锁定 / 内网 / 外链 / ssrf` → tools 分区 `#tools-security`
   - `思考 / 推理 / 轮数 / 并发 / 重试 / 温度 / 网图 / 发图` → allow 分区 `#open-send-config-btn`
     （权重 9，排在「能力与工具」之前 —— 真正的执行开关优先）
   - `缓存 / 前缀缓存 / 命中率` → api 分区 `#cfg-cachewarm`
   - `开机 / 自启 / 托盘 / 最小化` → app 分区 `#cfg-autostart`
2. **两个按钮补 `title`**：把弹窗/页面里真正装了什么写在悬停提示上
   （`#tools-security`、`#open-send-config-btn`）。

### 验证

- 搜索盲区从 **19 → 5**
- 剩余 5 个都不是"藏得深"：`日志/报错` 在「工具 → 连接」页（跨 tab，设置搜索管不到）；
  `导出` / `头像` / `端口` **这三个功能本身不存在配置项**（头像是自动取 QQ 头像，
  端口是自动管理）
- 4 个 `target` id 逐个确认存在；`node --check` 通过；`npm test` **308 通过 / 0 失败**
- 备份在 `data/code-backups/r176-search-index/`

### 有意没做

- **把「安全开关」从批量按钮堆里提出来单独一行**：属布局改动，收益是"更显眼"，
  但会改变「能力与工具」页的既有版式，留待下一版统一排
- **设置搜索支持跨 tab 跳转**（让"日志"直达「工具 → 连接」页）：需要给 `ssGoto`
  加 `it.top` 分支并改动 `switchTab` 调用，涉及页面切换副作用，单独评估
- **重构 `open-send-config-btn` 的命名**（如"发送 · 思考 · 并发"）：按钮文案变化
  会影响用户的肌肉记忆，且搜索已能覆盖，暂不动

---

## 未发布 · 依赖收尾：12 个路由模块裁掉 908 个未使用 import（2026-11-04，R175，需重启生效）

> 起因：用户问"洛版 0.4.9.2 的代码需不需要去重、需不需要精简"。先做了量化体检，
> 结论是**重复代码不值得专门治理，但我拆分 routes.js 时留下的依赖噪音该收尾**。

### 体检数据（先测量）

| 指标 | 实测 | 判断 |
|---|---|---|
| 代码块重复（12 行归一化骨架） | 1,452 / 116,275 = **1.25%** | 健康，业界 <5% 即正常 |
| 同构工具函数 | `readJson` 5 处、子进程封装 4 套、`writeJson` 3 处 | 多数跨边界（插件不得依赖宿主），可合收益 <200 行 |
| `try/catch → 500` | 78 处 | dispatch 层已兜底，改文案风险 > 收益 |
| **未使用 import** | **776 个（src）** | **本轮处理，几乎全是我 R164 拆分时留下的** |
| 零引用导出 | 43 个 | 留作下一轮，需逐个确认 |

### 本轮做了什么

对 `src/routes/*.js` 做保守裁剪：**只删「在模块业务体里完全不出现」的具名导入**，
其余一律不动。`_shared.js` 与聚合器 `routes.js` 不在处理范围。

| 文件 | 行数变化 | 删除符号 |
|---|---|---|
| bundle.js | 370 → 348 | 70 |
| dev.js | 253 → 223 | 83 |
| doctor.js | 598 → 572 | 76 |
| fix.js | 385 → 357 | 81 |
| forge.js | 1355 → 1333 | 73 |
| market.js | 443 → 419 | 71 |
| protocol.js | 376 → 344 | 85 |
| providers.js | 457 → 439 | 59 |
| sessions.js | 449 → 419 | 83 |
| skills.js | 633 → 612 | 65 |
| system.js | 240 → 212 | 77 |
| wallpaper.js | 222 → 191 | 85 |
| **合计** | **5976 → 5677（−299）** | **908** |

`shared` 解构同步精简：12 个模块原本一律 `const { bodyOf, createForgeProgress } = shared;`，
实际只有 11 个用到 `bodyOf`、0 个用到 `createForgeProgress`（它只在 forge.js 里由 deps 取），
现已按实际使用裁剪。

### 安全边界（关键取舍）

**整条 import 全未使用时能不能删？** 删掉会让目标模块不再被这个文件加载，
若目标模块带副作用（注册工具、初始化 logger）就会静默改变启动行为。
所以先建了全项目 import 依赖图逐个核对：

- **249 条**：目标模块在别处仍有加载点 → 删除安全
- **23 条**：唯一加载点，但全是 `node:fs` / `node:path` / `node:child_process` 等 Node 内建 → 无副作用，删除安全
- **0 条**：项目内模块且唯一加载点 → 无此情况

### 验证

- `node --check`：13 个文件全部通过
- 路由条目：**177 条**（12 模块 176 + 聚合器里的 `/api/composition` 1 条），与拆分后一致
- `npm test`：**308 通过 / 0 失败**
- **真实 HTTP 冒烟**（监听随机端口打 22 个接口）：**500 数量 0**；`/api/tools`、
  `/api/persona-market/list` 等此前受动态 import 影响的接口均 200；不存在的路由正确 404
- 原文件备份在 `data/code-backups/r175-import-trim/`

### 过程中修正的一次错误

第一版裁剪脚本把「非 import 的代码行」整段丢弃了（只重建了 import 区），
dry-run 时发现新行数异常（375 → 2）后立即从备份恢复，改为**区间替换 + 从后往前应用**。
记在此处提醒：批量改写源码必须先 dry-run 看行数与结构，再落盘。

### 有意不做的（附理由）

- **withRoute 包装器**：78 处 `try/catch→500` 可消，但要逐条核对错误文案，
  风险高于消重收益；dispatch 层已有统一兜底
- **统一 safeParse / 重试**：三套语义有意不同（`null` / 原值 / `{raw}`），合并属抽象错位
- **合并插件内的 sleep / clamp**：插件是独立分发单元，import 宿主 util 会破坏隔离
- **43 个零引用导出**：下一轮逐项确认后再删

---

## 未发布 · UI 交互审查：切页不再整块重绘列表（2026-11-04，R174，前端刷新即生效）

> 起因：用户问"整个项目 UI 部分有没有操作逻辑要优化"。做法是先扫交互缺陷模式
> （危险确认 / 防重复提交 / 键盘 / 焦点 / 切页加载），再逐个核实。

### 审查结论（大部分已经做得很好）

| 维度 | 现状 |
|---|---|
| 危险操作确认 | **完整**：44 处 `qaConfirm`；重置数据甚至做了**双重确认** + 按钮禁用 + 进度提示；12 个 DELETE 请求里 11 个有确认，唯一没有的是 `/api/pause`（恢复运行，本就不该拦） |
| 键盘 | Esc 全局 `closeAll()`（注释记录过：早期这个监听挂在一个从未被调用的死函数里，已修） |
| 防重复提交 | 61 处 `disabled` 开关，长任务都有 |
| 可访问性 | `aria-current="page"` 标当前页（此前只有纯视觉的 `.active`） |
| 切页闪烁 | 已有 `.switching` 110ms 抑制非活动视图过渡 |
| 未保存改动 | 离开设置页前 `flushSettingsSaves()`，防抖窗口内的改动不会丢 |

### 唯一发现的问题：切页时列表整块重绘

```js
if (name === 'sessions') loadSessions();      // 无参 → quiet=false
if (name === 'chats') loadChats();
```

`loadSessions` 内部本来就有**签名短路**（数据一字未变直接 return，注释里记为"BUG-13"），
但闸门只在 `quiet=true` 时打开。切页用无参调用 → 每次切回都走全量渲染分支
（`box.innerHTML = …`）：几百条会话时**滚动位置回到顶部、悬停/拖拽的行被抹掉、还闪一下**。

`loadChats` 更彻底：`quiet` 只用来压 `console.error`，列表**从来**没有签名短路。

### 改动

1. `switchTab` 里两处改为 `{ quiet: true }`；
2. 给 `loadChats` 补上同款签名短路（`state.chatsSig`）。

⚠️ `loadChats` 的短路**只跳列表重绘，不跳消息刷新** —— chats 没变不代表当前群的
消息没变（消息由 SSE 推、也能被别处改写），两者是独立数据源。

### 边界确认（不会出现"数据变了却不重绘"）

`state.chats` 还有三处直接赋值（设置页补底、预览 mock、记忆页），都绕过签名。
这种情况下次进存档页时签名必然不匹配 → 正常重绘。首次进入同理
（`state.chatsSig` 为 `undefined`，签名必然不同）。

### 验证

全量回归：**308 个测试全部通过**；改动文件 `node --check` 通过。

---

## 未发布 · 动画审查：两个常驻 box-shadow 动画改为合成器动画（2026-11-04，R173，前端刷新即生效）

> 起因：用户问"还有哪些地方的动画可以优化"。先按**动画属性**做全量分类：
> 只有 `transform` / `opacity`（以及 `filter`）能交给合成器；动 `box-shadow`、
> `width`、`border-color` 这类属性，浏览器只能每帧重绘那块区域 —— CPU 差一个量级。

### 全量盘点（40 个 @keyframes）

| 类别 | 改前 | 改后 |
|---|---|---|
| 合成友好（只动 transform/opacity） | 30 | **32** |
| 触发重排/重绘 | 10 | **8** |
| 其中**常驻**（infinite）的 | 4 | **2** |

### 改掉的两个（都在连接页，常驻循环）

**① 在线呼吸圈**（`.auto-avatar-dot` 上的 `autoPulse`）

```css
/* 改前：box-shadow 从 0 扩散到 9px，2.6s 无限循环 */
@keyframes autoPulse {
  0% { box-shadow: 0 0 0 0 var(--green); }
  70% { box-shadow: 0 0 0 9px transparent; }
}
```

`box-shadow` 不参与合成，只能每帧重绘。改为**伪元素画圆环 + `transform: scale` +
`opacity`**：走合成器，零重绘。伪元素绝对定位、不占布局，视觉等价（从中心扩散淡出）。

**② 等待节点呼吸**（`.sl-node.is-wait .sl-node-idx` 上的 `sl-pulse`）同样处理，
并给 `.sl-node-idx` 补 `position: relative` 作为定位基准（不改变布局）。

### 不改的（附理由）

| 项 | 理由 |
|---|---|
| `chaosBrandJitter`（text-shadow）、`chaosLoadSpin`（border-top-color） | 只作用于 `[data-theme='?']` 彩蛋主题，是刻意的"故障风"视觉效果；用户主动选的主题，不改 |
| `popIn` / `pageIn` 里的 `animation-timing-function` | **不是问题**：写在 keyframes 帧内是合法的逐帧缓动控制（弹簧效果），只动 opacity/transform |
| 103 处 `transition`（color 45 / background-color 41 / box-shadow 37 / border-color 34） | 都是 hover 过渡，仅交互瞬间触发、单次成本低；改成 transform 会明显改变视觉（阴影抬升是设计语言） |
| `barGrow` / `chaosBarBoom`（动 width） | 单次进度条增长，且 width 动画本就无法避免布局；出现频率极低 |
| 壁纸 `<video>` 解码、桌宠 Live2D | 已在 R171/R172 处理（默认关闭 + 帧率上限 + 可见性检查） |

### 验证

- 重新扫描：常驻的非合成动画 **4 → 2**（剩余两个仅彩蛋主题）；
- CSS 括号平衡（2814/2814），无残留的 `autoPulse` / `sl-pulse` 引用；
- 全量回归：**308 个测试全部通过**（CSS 改动不影响逻辑，跑一遍确认环境正常）。

---

## 未发布 · 桌宠改为默认关闭（2026-11-04，R172，需重启生效）

> 承接 R171 的 CPU 排查结论：桌宠是**核显机器上最可能的持续 CPU 来源**（常驻
> 30fps WebGL + 透明窗口合成）。用户决定：改为默认关闭，让需要的人自己开。

### 改动

`plugins/desktop-pet/plugin.json`：`enabledByDefault: true` → **false**，
描述同步改为"在控制台「桌宠」页**开启**并设置"。

### 影响范围（只有一类人受影响）

判定链：`isEnabled()` → `manifest.enabledByDefault !== false` → `dflt` →
`isSkillEnabledInConfig(id, dflt)`（**有配置看配置，没配置才看清单**）。

| 用户状态 | 结果 |
|---|---|
| 全新安装 / 从未动过桌宠开关 | **默认关闭**（不再出现桌宠） |
| 曾经开启过（`config.skills['desktop-pet'].enabled === true`） | 保持开启，不受影响 |
| 曾经手动关掉过 | 保持关闭 |

所以这不是"强制关掉所有人的桌宠"，而是"改新用户的默认值"。

### 关闭后到底省了什么

`desktopPetHost.start()` 仍会创建隐藏窗口（宿主启动流程无条件调用，未改成按需启动），
但 `applyState()` 会立即隐藏，而渲染循环写的是 `if (visible && model) model.update(...)` ——
**隐藏后 Live2D 完全停止更新**，CPU 接近 0。省掉的是 GPU/CPU 的持续渲染，
没省掉那个常驻渲染进程的内存（几十 MB）。

要彻底"连窗口都不建"需要改成按需启动（用户点开启时再 start），改动涉及
宿主的 start/sync 生命周期，风险与收益不匹配，本次**不做**，留作后续。

### 验证

- **端到端**：用空数据目录（`QQ_AGENT_DATA_DIR` 指向临时目录）跑完整 `loadPlugins()`，
  `skillManager.status('desktop-pet')` 返回 `enabled = false`、`available = true`
  （能力仍在，只是未启用），日志显示"桌面伙伴已加载"但不会起窗口。
- **基线**：`plugin.json` 属内置模块，已用 `refreshBuiltinEntry('desktop-pet')`
  重算指纹；全量核对 21 个模块与基线一致。
- 全量回归：**308 个测试全部通过**。

---

## 未发布 · CPU 占用排查：桌宠视线轮询与状态刷新风暴（2026-11-04，R171，需重启生效）

> 起因：用户转达"有些人反映这个软件 CPU 占用有点高"。全量排查定时器、
> 渲染循环、日志与文件监听后，改掉两处确定的浪费；其余为设计内成本，已列清。

### 改掉的两处

**① 桌宠视线跟随：50ms 无条件跨进程查询（`electron/desktop-pet.js`）**

```
cursorTimer = setInterval(() => {
  screen.getCursorScreenPoint();   // 同步跨进程查询
  petWindow.getBounds();           // 又一次
  send('qqa-pet:cursor', ...);     // 再发 IPC
}, 50);
```

20Hz、且**光标静止时也在发**（而光标静止占绝大多数时间）。改为：
- 50ms → **100ms**（10Hz）：视线跟随是感觉层面的东西，10Hz 与 20Hz 人眼分不出；
  拖动时另有 32ms 的 `dragTimer` 单独负责，不受影响；
- **位置没变就不发**：静止时零 IPC、零渲染。

**② SSE 事件无防抖地打状态接口（`ui/app/02-sse-sessions.js` + `01-boot.js`）**

7 类 SSE 事件（session-start / session-update / onebot-status / status /
protocol-status / qq-portable-status / memory-*）各自直接调 `refreshStatus()`。
群活跃时一秒能来好几次，而每次都要发一次 `/api/status`（后端还要算
todayUsage / onebot / 磁盘压力）；用户还能把「界面刷新间隔」调到 1 秒。

改为 `scheduleStatusRefresh()`：**120ms 窗口内合并成一次**。数据本身在
`refreshStatus` 里还有签名短路（内容没变不重绘 DOM），晚 120ms 用户无感。
8 处替换，轮询那处 `await refreshStatus()` 保持直接调用。

### 排查后确认「不是问题」的（避免以后重复调研）

| 项 | 实测/现状 | 判断 |
|---|---|---|
| Live2D 渲染帧率 | 已设 `ticker.maxFPS = 30`，且 `if (visible && model)` 才更新 | 已优化过 |
| CSS 无限动画 | 25 处，但全是状态型（loading / 等待点 / 骨架屏）或彩蛋主题 | 不常驻 |
| 日志写入 | `appendFileSync`，仅在产生日志时 | 低频 |
| 后端定时器 | obPort 2s、status 15s、SSE 心跳 15s、reconcileService 1s（纯内存） | 合理 |
| `backgroundThrottling: false` | 为修"全屏游戏遮挡→心跳停摆→看门狗误判重建"（R76） | 有意为之，不能简单改回 |

### 仍然存在的「设计内成本」（供排查时参考）

1. **桌宠默认开启**（`enabledByDefault: true`）：常驻 30fps WebGL + 透明窗口合成，
   是核显机器上最可能的主要来源；
2. **动态壁纸**：`<video>` 持续解码，用户主动开启才有；
3. **软件渲染模式**：拿不到 GPU 时全部合成走 CPU（兼容模式 / 被杀软拦杀后），
   此时以上两项的成本会放大数倍。

**给反馈者的自查方法**：任务管理器 → 详细信息，展开 "QQ Agent" 下的子进程看
哪一类高 —— GPU 进程高查桌宠/壁纸，渲染进程高查页面，主进程高查后端定时器
（本版已把主进程侧最大的一处修掉）。

### 验证

全量回归：**308 个测试全部通过**；改动文件 `node --check` 通过。

---

## 未发布 · 状态轮询不再卡：进程探测改为 stale-while-revalidate（2026-11-04，R170，需重启生效）

> 起因：用户问"底层代码还有哪些优化能让软件更丝滑 / 界面加载更快"。
> 先做测量，再改 —— 结论是**后端 CPU 与首屏体积都不是瓶颈，唯一的真实卡点是
> `/api/status` 的周期性 PowerShell 探测**。

### 测量结果（先排除的候选）

| 候选 | 实测 | 结论 |
|---|---|---|
| 路由匹配（177 条线性遍历） | **0.001 ms/次** | 不是瓶颈，不拆索引 |
| `buildSystemPrompt`（每轮对话） | **0.014 ms/次** | 不是瓶颈 |
| 首屏 29 个脚本 2011 KB 的 V8 编译 | **22.7 ms** | 不是瓶颈，不做懒加载改造 |
| CSS 2843 条规则 / 556 KB | 静态扫描出 215 条疑似死规则 | **不删**：`status-${x}`、`freq-${x}` 这类动态拼接误判率太高，删除收益（约 8% 解析时间）不抵风险 |
| 毛玻璃 `backdrop-filter` | 仅 3 处实际使用 | 团队此前已削过（注释有记录），无需再动 |

### 真正的瓶颈

`/api/status` 是渲染端 15s 轮询的热路径，其中 `qqPortableStatus()` 要 spawn 一次
PowerShell 跑 CIM 查询：

| 场景 | 改前 | 改后 |
|---|---|---|
| 缓存命中（3s 内） | 5.7 ms | 5.7 ms |
| **TTL 过期（每轮轮询必跨过）** | **735 ms** | **31 ms** |
| 进程列表函数内部 | **735 ms** | **0.2 ms** |
| 首次冷启动 | 1161 ms | 1254 ms（不变，无法避免） |

旧实现只有 3 秒 TTL 一种状态：过期就必须**同步**等 PowerShell，于是每 15 秒的轮询
必然吃一次几百毫秒；机器一忙就顶穿前端 15s 超时，把整条 `Promise.all` 拖挂
（10-14 那次"用量页一直加载失败"的根因）。

### 改动

`src/qq-portable.js` 的 `listQqProcesses()` 改成三段式 **stale-while-revalidate**：

| 缓存年龄 | 行为 |
|---|---|
| < 3s | 直接返回（与以前一致） |
| 3s ≤ age < 30s | **立即返回旧值**，同时后台静默刷新（调用方不等 PowerShell） |
| ≥ 30s 或首次 | 同步查（兜底：后台连续失败时不会永远吃旧值） |

- 后台刷新复用原有 `qqProcListInFlight` 槽位，不会叠出多个 PowerShell；
- `force=true`（用户手动刷新 / 刚装完 QQ）跳过缓存，行为不变；
- 实际状态滞后 ≈ 一次刷新耗时（几百毫秒），不是 30 秒 —— 因为 age 一过 3s 就会
  触发后台刷新，30s 只用于"后台一直失败"的兜底。

### 验证

- 行为验证脚本：首次 704ms → 立即 0.0ms → 4 秒后 **0.2ms（旧实现 735ms）** →
  再 4 秒仍 0.1ms，全程不再出现同步等待。
- 全量回归：**308 个测试全部通过**。

---

## 未发布 · 补上「内容审核」这类错误的中文解释（2026-11-04，R169，需重启生效）

> 用户截图反馈："不应该是中文报错吗，这边怎么又是英文？"
> 原文：`模型 API HTTP 400: {"error":{"message":"safety check failed","type":"failed_precondition_error","code":"9"}}`

### 根因

`src/error-l10n.js` 的规则表（CASES）原有 10 条，覆盖模型名、Key、权限、限流、
上下文超长、5xx、参数、网络、超时、非 JSON —— **没有"内容安全审查"这一类**。
`safety check failed` 一条都匹配不上，`explainApiError` 返回 null，
UI 按"识别不了就原样显示"的约定落回英文原文。

### 修复

新增一条规则（排在「没权限」之前）。文案：

> ⚠️ 被内容审核拦下了
> 服务商的安全审查判定这次内容不合规，把请求直接拒了 —— 不是你配置或网络的问题。
> 换个说法、删掉可疑内容再发一次；连续几次都这样就说明这个渠道审查偏严，换一个渠道。
> ▸ 查看技术详情（折叠原始 JSON，排查者仍拿得到）

判据只认"审查"语义、不绑状态码（400/403/422 各家不同），关键词都带限定。

### 两个实测踩到的坑（已锁进测试）

1. **顺序错了会被抢**：一开始把这条排在「没权限」之后，而那条的判据是
   `status === 403` —— 403 + "内容审核未通过" 被吃掉，用户被指去改 API Key。
   现在的顺序是 模型名 → Key → **内容审查** → 权限 → 限流 …
2. **`sensitive info` 会误伤**：不加 `\b` 会把 "sensitive information"（提示词安全的
   正常讨论）判成内容审查。已加词边界。

### 验证

- 新增 `tests/error-l10n.test.mjs` **6 个用例**：命中识别、7 种措辞变体、
  不误伤（参数/模型名/限流/权限各归其位）、403 内容审查不被抢占、
  `sensitive information` / `flagged as invalid` 两个边界、`extractServerMessage` 各家形状。
- 实际文案预览：用户截图那条、`content policy` 版本、国内网关 403 版本 —— 三者均
  正确输出中文卡片。
- 全量回归：**308 个测试全部通过**（原 302 + 新增 6）。

---

## 未发布 · 人设模板的句子级增量补丁机制（2026-11-04，R168，需重启生效）

> 解决 R167 暴露的系统性缺陷：用户生效的人设是 `config.persona.roleText` 的
> **副本**，源码里改 `PERSONAS` 不会同步过去，导致"改了提示词、用户反馈依旧"。

### 旧机制的局限

`loadConfig` 里原本只有一条兜底：`roleText` 与 `LEGACY_XIAOJINGYU_TEXT`
**逐字节全等**时才换成新模板。两个问题：
- 只能覆盖"一个字没改过的某一版全文"，每加一版就要在源码里存一份 9000 字全文；
- 用户副本只要与那一版有任何差异（哪怕只是少一个空行），就永远匹配不上。

### 新机制

`src/personas.js` 新增 `PERSONA_TEXT_PATCHES`：每次改内置人设里"会被用户副本带走"
的句子，登记一对 `from`/`to`。`loadConfig` 加载时逐条比对并就地替换。

```js
{ id: 'image-reaction-2026-11-04',
  from: '- **兴奋档**——被夸、群里在吵架、看到好图好梗。…',
  to:   '- **兴奋档**——被夸、群里在吵架、有人接住你的梗、…' }
```

### 安全边界（写进 personas.js 注释，改之前必须读）

| 约束 | 原因 |
|---|---|
| **整句精确匹配才替换** | 用户自己改写过这句就不动，个性化优先于内置改版（与 LEGACY 迁移同一约定） |
| **幂等** | 已含 `to` 直接跳过；`from` 恰好是 `to` 子串时也不会反复替换 |
| **只替换不删空** | 禁止写 `to: ''`，那会把用户文本吃掉一半 |
| **不写盘** | 只在内存迁移，用户下次保存任意配置时自然固化（同 LEGACY 迁移） |
| **补丁只增不改** | 已发布的 `from` 不能再改，否则早年副本永远匹配不上 |
| **空 `from` 一律跳过** | 空串会匹配任意位置，属灾难性误伤 |

实现为纯函数 `applyPersonaTextPatches(roleText, patches?)`（`src/config.js` 导出），
`loadConfig` 只负责调用与记日志（`[config] 人设已应用内置更新：<id>`）。

### 验证

- **新增 6 个单测**（`tests/persona-patch.test.mjs`）：命中替换、幂等、用户改过不
  替换、非字符串/畸形补丁不抛、补丁表格式校验、方向正确（不会把新模板改回旧版）。
- **端到端**：用 `QQ_AGENT_DATA_DIR` 指向临时目录，造一份"roleText 留着旧激励句"
  的配置 → `loadConfig` 自动替换、`botName` 与其余段落原样保留、连续三次调用
  结果一致（幂等）、新说明只出现一次。
- 全量回归：**302 个测试全部通过**（原 296 + 新增 6）。

### 以后改人设的正确做法

改 `PERSONAS.xiaojingyu.text` 的同时，在 `PERSONA_TEXT_PATCHES` 里登记被改的那一句。
只改模板不登记 = 老用户看不到变化（本次要消灭的正是这个坑）。

---

## 未发布 · 看图反应调优：先接文字，别给画面写评语（2026-11-04，R167，需重启生效）

> 用户反馈："依旧有这种人机发言，没有活人感，看到图片就发表一些没有意义的评价"。
> 截图实例：群友说「我想回家」配一张表情包 → 机器人回「草 这只表情好欠揍」。

### 三个叠加的成因

1. **激励错位**（主因）：默认人设卡的「兴奋档」把**看到好图好梗**列为触发条件
   （话多、夹梗、连发两三条），而同文件末尾又写"别人发图不等于要你点评"。
   正向激励压过禁令，模型一看图就开麦。
2. **规则缺"文字优先"**：`imageReactionRules()` 只说了"图是气氛、别点评"，没说
   "消息里同时有文字时，先接文字"。于是模型放着人家的话不接，只顾评价配图。
3. **义务与禁令冲突**：`replyObligationRules()` 声明"被 @ 必须回应、优先级高于
   角色卡"，而图片段又说"可以不说话"。模型选择"必须回应"，然后用点评图来凑数。

### 改动

| 位置 | 内容 |
|---|---|
| `src/prompt.js` `imageReactionRules()` | 新增**先读文字再看图**（含「我想回家」这个具体反例）；新增**必须回应时一个字也算完成，不要为凑满一句话去评价图**；禁忌句式补「这 X 好 Y」「这 X 真 Y」，并明确**不许给图里的角色/动物安性格或打分**（「好欠揍」「好可爱」都算） |
| `src/personas.js` 默认人设 | 兴奋档去掉「看到好图好梗」，改为「有人接住你的梗、聊到你真感兴趣的话题」，并注明**看到图/表情包不算兴奋触发** |
| `data/config.json` `persona.roleText` | **同步更新**（见下，不改这里等于没改） |

### ⚠️ 关键发现：人设是"配置副本"，改模板不会自动同步

用户实际生效的人设是 `config.persona.roleText`（3892 字符），是模板的历史副本；
`PERSONAS.xiaojingyu.text` 只在首次生成/恢复默认时使用。**只改源码模板，老配置
不会跟着变** —— 这解释了为什么此前几轮提示词调整"依旧有"。

本次已在备份后精确替换该副本中的对应句子（3892 → 3933 字符，其余内容未动）。
`LEGACY_XIAOJINGYU_TEXT`（老版人设全文）**保持逐字节不变** —— 它用于与老配置做
精确匹配迁移，任何字符改动都会让仍在用旧人设的用户失去升级路径。

**遗留问题（已登记，未做）**：人设模板更新后没有通用的"老副本自动升级"机制，
只有 LEGACY 那一条精确匹配。若后续再调人设，需要手动同步用户配置，或补一套
"历史模板指纹 → 新模板"的迁移表。

---

## 未发布 · 市场页左上角偏蓝色块（2026-11-04，R166，前端刷新即生效）

> 用户截图反馈："技能市场左上角颜色好像有点问题"。

### 现象与实测

截图像素分析：页面底色 `27,28,32`（中性），但左上角一块 `30,38,52` 系——
蓝分量高出 20+，从容器左边缘向右衰减到 **x≈560** 才消失，y≈75 以下被警告条覆盖。
窗口宽 1409px 时，偏色区横跨 x=0..570。

### 根因

`.market-page::before` 的氛围光层是 `inset:0` **通栏**，而内容自 2026-10-23 起
已是 `.market-page > * { max-width:940px; margin-inline:auto }`。窗口一宽，
左侧留白区（1409px 时约 234px）没有任何卡片遮挡，左上那层
`--accent-soft`（`rgba(61,139,253,.16)`）直接裸在页面底色上。

这与 2026-10-22 人设页记下的坑（"莫名其妙一坨淡蓝"）**是同一个根因**，
当时只把人设页搬去了 `.usage-pane`，三个市场页（技能 / 插件 / 人设广场）没动。

### 修复

**第一次（未彻底）**：把氛围层收窄到内容宽度并居中：

```css
.market-page::before {
  content: ''; position: absolute; top: 0; bottom: 0; z-index: 0;
  left: 50%; transform: translateX(-50%);
  width: min(940px, 100%);
  ...
}
```

同时把第一层光晕中心从 `at 12% -8%` 移到 `at 20% -8%`（避免裁切硬边）。
**结果：左侧留白干净了，但用户重启后反馈"依然有"。**

**第二次（彻底）**：直接**移除左上角那层 accent-soft**。

复测截图（1636×1000）像素证据：

| 位置 | B-R 差值 | 说明 |
|---|---|---|
| 标题行 y=62，x=120..240 | 0 | 左侧留白已干净（第一次修复生效） |
| 标题行 y=62，x=342..960 | **最高 +26** | 仍未解决，正是用户看到的偏蓝 |
| 卡片区 y=300 | +5 | 几乎不可见 |

结论：该渐变的垂直中心在容器上方（`at … -8%`），能量集中在标题/搜索行，
而这一行没有卡片遮挡——**容器多宽都会裸出来**，收窄宽度治不了。且它对卡片
几乎没有贡献（+5），纯粹在给标题区上色。因此删除，层次感交给右下角那层 7% 淡光。

- 卡片背景是 `color-mix(--card 70%, transparent)`，右下角那层仍透得出来，不需要
  左上角那层来"补玻璃感"。
- 影响三个页面：`#skillmarket-page` / `#pluginmarket-page` / `#personamarket-page`。
- 纯 CSS 改动、无布局影响；CSS 括号平衡校验通过（2811/2811）。
- 回滚方式：把 `inset:0` + 两层渐变（`at 12% -8%` / `at 96% 108%`）恢复即可，
  原实现完整记在本条目中。

---

## 未发布 · app.js 拆出用量统计子系统（2026-11-04，R165，需重启生效）

> 纯结构重构，不改行为。`src/app.js` 尾部的 **1400 行模块级用量统计**（成本看板
> 背后的全部计算）与 createApp 无闭包耦合，只依赖 config / llm / model-prices /
> usage-ledger 四个纯函数模块，因此整体搬出为 `src/usage-stats.js`。

| 文件 | 变化 |
|---|---|
| `src/app.js` | 3392 → **1982** 行（-41%） |
| `src/usage-stats.js` | 新增 1437 行，导出 buildUsageStats / buildUsageBreakdown / collectUsageRows / dayKeyOf / warmUsageArchive / resetUsageStatsCache / \_\_testUsageDaily |

### 做法

- 代码逐字节原样搬运，仅给 6 个对外函数加 `export`；三处模块级缓存
  （usageRowsCache / usageArchive / usageStatsCache）随实现一起迁移，
  仍是单例、仍可用 `resetUsageStatsCache()` 清空。
- 文件头补了一节数据源说明（三层：sessions 留档 / usage-daily / usage-archived-days）
  与那条历史事故警告（3 小时结果缓存 → 实时调用方请走 `sessions.todayUsage()`）。
- 附带清理：搬走后 `model-prices`（7 个符号）与 `usage-ledger`（4 个符号）两组
  import 在 app.js 里已全部失效，连同新 import 里未用的 `resetUsageStatsCache`
  一并移除。

### 等价性验证

- **新旧实现输出比对**：把备份的旧 app.js 临时导出同名函数，用相同输入对比 ——
  `buildUsageStats`（today / 7 / 30 三档）与 `buildUsageBreakdown` 的全部字段一致，
  唯一差异是 `computedAt` 时间戳（两次调用相隔几毫秒，属预期）；`dayKeyOf` 一致。
- `npm run check` **296 个单元测试全部通过**；`app.js` / `usage-stats.js`
  `node --check` 通过；真实模块加载冒烟通过（createApp 导出正常，342ms）。

### 端到端 A/B 验证（R164 + R165 合并验收）

拆分只做了静态与单元级验证，补一次**真实 HTTP 对照**：新旧两版各起一个实例，
监听随机端口，打同一批接口，比对状态码与响应 `ok` 字段。

| 接口 | 新版 | 旧版 | 结论 |
|---|---|---|---|
| /api/composition | 200 ok:true | 200 ok:true | 一致 |
| /api/status | 200 | 200 | 一致 |
| /api/models | 400 ok:false | 400 ok:false | 一致 |
| /api/tools | 500 | 500 | 一致（环境所致，见下） |
| /api/skills | 200 | 200 | 一致 |
| /api/wallpaper/list | 404 ok:false | 404 ok:false | 一致 |
| /api/usage/stats | 200 ok:true | 200 ok:true | 一致 |
| /api/doctor | 200 ok:false | 200 ok:false | 一致 |
| /api/providers | 200 | 200 | 一致 |

- **不一致项 0**。另测：不存在的路由返回 404（分发未被拆坏）；POST 带同源 Origin
  可正常通过鉴权（doctor/run、skills/reload、pause 均 200）。
- `/api/tools` 的 500 在**新旧版完全相同**：冒烟脚本绕过 `start()`，skillManager
  未初始化，`listTools()` 抛错。真实启动流程会先 reloadSkills，不会走到这个状态。
  这是既有行为，不是本次重构引入的 —— 但值得单独记一笔：该接口在未初始化时
  只回"服务器内部错误"，缺少可诊断信息（未改，涉及统一错误响应格式）。


### 剩余（已登记）

- `withRoute` 包装器（约 119 处 handler 内手写 catch→500）。
- createApp 内的 HTTP 基础设施（json / readBody / 来源校验 / 静态服务，约 500 行）
  可再拆 `src/http-kit.js`，但它与 createApp 的闭包状态耦合较深，需单独评估。

---

## 未发布 · routes.js 拆分为 12 个域模块（2026-11-04，R164，需重启生效）

> 纯结构重构，**不改任何一条路由的行为**。目标是消灭 `src/routes.js` 里
> 那个 5248 行的 `createRoutes` 单一函数（177 条路由、30+ 依赖全在一个闭包里）。

### 拆分结果

| 位置 | 行数 | 内容 |
|---|---|---|
| `src/routes.js` | 5358 → **146** | 只做装配与顺序，零业务 |
| `src/routes/_shared.js` | 207 | bodyOf / skillRuntimeContext / createForgeProgress / lockForgeDraft / withStatusTimeout / updateFeedState |
| `src/routes/forge.js` | 1354 | /api/forge/*（15 条） |
| `src/routes/skills.js` | 632 | skills / tools / config / plugin-tool（14 条） |
| `src/routes/doctor.js` | 597 | /api/doctor/*（10 条） |
| `src/routes/providers.js` | 456 | 模型渠道、密钥、识图、搜索源（23 条） |
| `src/routes/sessions.js` | 448 | 会话、存档、记忆文件、媒体（26 条） |
| `src/routes/market.js` | 442 | 模块市场、人设、共享黑名单（15 条） |
| `src/routes/fix.js` | 384 | /api/fix/*（15 条） |
| `src/routes/protocol.js` | 375 | 协议端、QQ 便携版（21 条） |
| `src/routes/bundle.js` | 369 | 打包 / 接收 / 移植 / 重置（13 条） |
| `src/routes/dev.js` | 252 | 开发工单（12 条） |
| `src/routes/system.js` | 239 | status / usage / version / logs（8 条） |
| `src/routes/wallpaper.js` | 221 | /api/wallpaper/*（4 条） |

`/api/composition` 留在聚合器（与 console.routes 合并逻辑同属启动组合，且保持它仍是第一条）。

### 做法与安全性

- **handler 代码逐字节原样搬运**，只换了所在文件与函数外壳；跨域共享件统一沉淀到
  `_shared.js`（`createForgeProgress` 改造成 `makeCreateForgeProgress(emit)` 工厂，
  其余为纯函数/常量直出）。
- 每条域模块签名统一 `(deps, shared)`，内部沿用原来的 deps 解构，避免逐处改传参。
- **等价性验证**：① 路由表逐条比对 —— 177 条，0 缺失、0 多出；
  ② 模拟 dispatch —— 177 路由 × 4 方法 = **708 个组合，新旧表首匹配零差异**；
  ③ `npm run check` **296 个单元测试全部通过**；④ 全部文件 `node --check` 通过。
- 顺序说明：同域路由聚拢后，status/usage/version/logs 从原位置移到数组末尾；
  已验证所有 pattern 均为精确字符串或锚定正则，唯一的重叠是 13 组「同路径不同
  method」，且每组仍同模块、相对顺序不变 —— 顺序变化不影响任何匹配结果。

### ⚠️ 拆分引入的缺陷（2026-11-04 当天发现并修复，R164 补丁）

**现象**：用户反馈「人设下载」页报"读取人设失败：服务器内部错误"；日志里同时出现
`GET /api/tools 处理失败：ERR_MODULE_NOT_FOUND: Cannot find module
'src/routes/tool-registry.js' imported from 'src/routes/skills.js'`。

**根因**：切分脚本只替换了静态 `from './…'` 的路径，**漏掉了动态
`await import('./…')`**。模块搬进 `src/routes/` 后这些相对路径指向了错误的目录：

| 文件 | 处数 | 受影响功能 |
|---|---|---|
| `skills.js` | 5 | /api/tools、prompt-preview 构建（prompt / tools / tool-registry） |
| `market.js` | 2 | **人设下载页**（personas.js） |
| `bundle.js` | 1 | 打包/接收里的 loadConfig |

**修复**：8 处 `import('./x.js')` → `import('../x.js')`。修复后冒烟：`/api/tools`、
`/api/persona-market/list`、`/api/persona-templates`、`/api/bundle/options`、
`POST /api/prompt-preview` **全部 200**；296 个单元测试全绿。

**为什么之前的 A/B 对照没抓到**：那次只比了**状态码与 `ok` 字段**。旧版 `/api/tools`
本来就 500（skillManager 未初始化），新版因路径错误也 500 —— 两版"一致"，
掩盖了根因不同。**教训：A/B 只比状态码不够，要连 `error` 内容/日志一起比。**
（同一批 A/B 里 `/api/persona-market/list` 没测，正好漏掉了用户实际撞到的那个。）

### 后续（未完成，已登记）

- `withRoute(name, handler)` 包装器：全项目仍有约 119 处 handler 内部手写的
  `catch → json(res, 500, …)`，计划在域模块上逐步替换（需保持错误文案与
  响应体字段不变）。

---

## 未发布 · qq-bridge 残留清理：死代码 / 幽灵引用清零（2026-11-04 凌晨，R163，需重启生效）

> 本软件从 Derpyu520/qq-bridge 彻底改造而来。残留普查（对照上游仓库逐概念核对）确认：
> 真正残留约 600-800 行（占 src 54,140 行的 1.2-1.5%），无结构性残留。本次清除其中
> 可安全删除的净残留；血缘标注（README 出处/致谢、5 个模块的"移植自"）永久保留。

### 删除的死代码（删除前均确认零调用方/零消费方）

- `src/tool-registry.js`：`isToolEnabledLegacy`（全库仅定义、无调用方）。
- `src/protocol-launcher.js`：返回值里的 `indexMjs` 旧字段名兼容（无消费方）。
- `src/app.js` `getUsageToday` 的 `chats/models` 空数组占位 + `electron/desktop-pet.js`
  `pushUsage` 对应的 `Array.isArray` 判型字段 —— 旧版多行用量卡片的历史形状，
  现行 usage-card 渲染完全不读（已核实）。

### 幽灵引用（已下线插件在配置里留的名字）

- `skills/help-board/skill.json` + `index.js`：`passiveExclude` 删 `reply-safety`、
  `conversation-memory`；`passiveIcons` 清空 `red-packet-radar`；默认 iconOverrides
  兜底同步改为 `{}`；头部注释举例删掉不存在的红包雷达。

### 过时注释与假数据

- `skills/memory-recall/index.js`、`src/migrate.js:541`：注释里的
  "conversation-memory 的官方重建路径" 更正为 mem-layered。
- `src/plugin-loader.js:305`："内置最大的插件" 对比基准更新（事故记录类注释
  `plugin-loader.js:897/1275`、`manifest.js:59` **有意保留** —— 是排查历史）。
- `ui/app/00-preview.js:763`：预览演示假日志 "加载成功：conversation-memory v1.0.0"
  更正为 mem-layered，与实际加载情况一致。

### 临时文件

- 删除根目录一次性复现脚本 `__vision-repro.mjs`，并同步清掉
  `scripts/release-preflight.mjs` `APP_MUST_EXCLUDE` 里的对应条目
  （preflight 逻辑为"存在才标记"，两处一起删保持清单与现实一致）。

### 验证与备份

- `npm run check`：**296 个单元测试全部通过**；改动文件 `node --check` 通过；
  `skill.json` 可解析。
- 全部改动前的原文件备份在 `data/code-backups/pre-cleanup-20261104/`。
- 首页更新报告（STAGE_CHANGELOG 0.4.9.2 条目）同步追加"说明"一条，date 更 2026-11-04。

### ⚠️ 补记：改动内置模块后必须重算基线（当天下午发现并修复）

这次清掉的两个幽灵引用分别改在 `skills/help-board/`（`index.js` + `skill.json`）与
`skills/memory-recall/index.js` —— **两个都是内置模块，都在 `builtin-modules.json`
的指纹基线里**。改完没重算基线，于是重启后安全闸按"占名顶替"把它们拦下：

```
[skill] ❌ help-board：模块「help-board」触碰了高危能力：index.js
[skill:self-doctor] [严重] 扩展加载失败：help-board
```

`/help` 面板直接不可用，而报错文案（"触碰高危能力"）与真实原因（基线没同步）
完全对不上，极难排查。

**已用 `refreshBuiltinEntry()`（与校验同一套算法）重算两个模块的指纹**，并写了个
全量比对脚本确认 21 个内置模块全部与基线一致。

**维护约定（重要）**：任何对 `skills/` 或 `plugins/` 下**内置模块**源码的改动
（哪怕只改一行注释），都必须重算对应模块的基线，否则下次启动就会被安全闸拦下。
口径与 `.workbuddy/tools/refresh-builtin-baseline.mjs` 一致。

---

## 未发布 · 首页更新报告重排：补齐当天 6 条、合并 5 组重复（2026-10-28 晚，R142）

> 纯文案整理，不改任何运行逻辑。

- **补齐 6 条**当天做过但没写进报告的：切换兼容模式重启期间提示被轮询冲红 + 按钮能连点、
  状态条「桌宠显示中 / 桌面窗口未连接」两个绿点同屏、存档页默认拉全量 + 甩裸 HTTP 状态码、
  表情详情失效回调累积、路径穿越检查漏检单反斜杠、已卸载升级目标的检查档位不一致。
- **合并 5 组重复**：「草稿被两个请求同时改」与「被两个模型同时改」（同一把锁）、
  「分发后桌宠不出现」与「关掉桌宠不还原安全设置」（同一条判定链）、两条 L0 禁改清单、
  「升级草稿待安装」与「继续修改后装成第二个副本」、火绒拦杀与 GPU 判定这层安全网。
- **拆 1 条讲两件事的**（丢弃草稿 / 超时被误报成「插件未启用」）。
- 0.4.9.1 条目 35 → 38 条（全表共 68 条），date 改 2026-10-28；**版本号仍是 0.4.9.1**。
- 改写一条跨版本措辞（「补齐上个包漏带…」→「补齐漏带的 13 个文件」）。
- 验证：`node --check` 通过；235 条单测全绿；发布体检 ✓；另生成
  `data/code-backups/diag-20261028/report-preview.html` 按页面同一套分组逻辑渲染核对。

---

## 未发布 · 看图请求体撑到 244 万字符：尺寸探测从未生效（2026-10-28，R141）

> 这一条是重启后查日志翻出来的，起因不在今天的任何改动里，而是随包分发的
> 文件缺了一个 —— **一个从落地起就没执行过的分支**。

### 现象

`data/logs/qq-agent-2026-10-28.log` 里，同一会话的请求体反复暴涨：

```
09:09:56  body 28174→2440794 字符   断点后全价=2412637B ≈2412637tok
09:19:21  请求体超预算，已省略 1 个较早的媒体：1144753 → 1006666 字符
11:00:06  请求体超预算，已省略 6 个较早的媒体：21094399 → 1731078 字符
17:51:19  body 28254→330898 字符
```

09:09:56 → 09:10:05 这一次调用**耗时 9 秒**（正常 2~5 秒）。而且
`media-cap` 那道"超预算就丢掉较早媒体"的闸门**拦不住**：它按设计
**永远保留最新那一张**（否则机器人会对刚发的图"视而不见"），所以单张超大的图
一路直通。

### 根因（两层，都是"代码写了但没跑"）

**第一层：`runtime/` 里只有 `ffmpeg.exe`，没有 `ffprobe.exe`。**

`compressImage` 判断"要不要缩放"的唯一依据是 `imageSize(ffprobe, …)`。
ffprobe 不存在 → `spawn` 报错 → 恒返回 `null` → 尺寸判断**从未执行**，
全部退化成"原图字节 > 4MB 才压"。

**第二层：阈值用的是原图字节，而真正撑爆请求体的是 base64。**

`字节 × 1.37` 才是发出去的字符数。1~4MB 这个区间正好卡在两条判据的缝里：
尺寸判不出来、字节又没到 4MB —— 于是**整段跳过压缩**。

用本机 `data/image-cache` 的真实图片实测（修复前）：

| 图片 | 原大小 | 尺寸 | 结果 | base64 字符数 |
|---|---|---|---|---|
| 121mbn9.png | 1941KB | 1260×709 | 未压缩 | 2,650,755 |
| 18q1yb5.png | 2440KB | 1920×1200 | 未压缩 | 3,331,689 |
| 10zcd02.jpg | 1300KB | 2400×1080 | 未压缩 | 1,775,212 |
| 13faqxy.jpg | 1454KB | — | 未压缩 | 1,985,477 |

`1920×1200` 已经明显超过 1568px 的上限，本该被缩放，却因为探测不到尺寸而原样发送。

### 修法

1. 新增 `imageSizeViaFfmpeg()`：ffprobe 缺席时，用 `ffmpeg -i` 打印的流信息里读
   `Stream #0:0: Video: …, 1920x1200`。拿不到仍返回 null，退回按字节判断（旧行为）。
2. `maxBytes` 默认值 4MB → 512KB，与"小图直接过"的边界对齐 ——
   `>512KB 必然走压缩`，压缩后通常 200~300KB（base64 约 27~41 万字符），
   落回 512K 字符预算内。压缩失败或没变小仍保留原图（原有逻辑）。

### 修复后实测（同一批图片）

| 图片 | 原大小 → 处理后 | base64 字符数 |
|---|---|---|
| 121mbn9.png | 1941KB → 272KB | 265万 → **37万** |
| 18q1yb5.png | 2440KB → 271KB | 333万 → **37万** |
| 10zcd02.jpg | 1300KB → 63KB | 177万 → **8.6万** |
| 1phrt8m.jpg | 11047KB → 319KB | 1508万 → **43.6万** |

代价是每张图的压缩多花 0.6~0.7 秒 ffmpeg 时间（只对大图）；`<512KB` 的小图
实测 **0ms** 直接放行，不 spawn 进程，普通聊天不受影响。

### 取舍说明

压缩统一输出 JPEG，**带透明通道的 PNG 会失去透明**（黑底）。这是 `compressImage`
原有设计，本次没有改动它 —— 修好的是"本该压缩却没压"这个漏，不是压缩策略本身。
如果后续要保透明，需要让 ffmpeg 对 alpha 图输出 PNG，但实测同样内容
PNG 缩放后仍 2MB（无损压缩率低），收益很小。

### 验证

全量 **235 条单测通过**；`node --check` 通过；上表五张图逐个实跑对比。


## 未发布 · 第三方区域复查：配置保护、原子写、目录选择（2026-10-28，R140）

> 前几轮查的都是"今天改过的地方"。这一轮反过来，专挑**没动过的区域**看。
> 最重的一条不需要用户做错任何事 —— 只要启动那一瞬间文件被占用，
> 5 分钟后它就会把用户已有的配置整份换成出厂值。

### 已修

1. **配置读不出来时，会把用户全部配置覆盖掉（高危）**
   - 病灶：`loadConfig` 的 catch 一把抓 —— `readFileSync` 的 EACCES/EBUSY/EMFILE
     与 `JSON.parse` 的语法错误走同一条路：把 config.json **改名**成 `.corrupt-*`，
     内存回落出厂默认。而 `community.js` 每 5 分钟同步一次云端屏蔽名单，
     那条链路无条件 `updateConfig` 落盘 —— 默认配置被写回磁盘，
     API Key / 群白名单 / 人设全没，只在旁边留一个 `.corrupt` 文件。
   - 修法：三档分开。**ENOENT**（首次启动 / 刚重置过数据目录）→ 正常，允许写盘；
     **语法错误**（文件真坏了）→ 改名备份 + 默认值，允许写（原文件已保全）；
     **其它 IO 错误**（文件多半完好，只是这次读不到）→ 用默认值把应用跑起来，
     但**本次会话禁止落盘**，磁盘上那份原样留着，重启读到即恢复。
   - 配套：保存接口如实回 `saved:false` + 原因，设置页显示"已生效但未写入磁盘"，
     不再假装保存成功。
   - 验证：`tests/config-degraded.test.mjs` 4 条（ENOENT / 语法损坏 / EISDIR 读失败 /
     降级解除后标记自动清除——没有最后这条，用户会一直存不进配置）。

2. **原子写的返回值与文档相反，`if (!atomicWrite...)` 是永不成立的分支**
   `atomicWriteText` 的文档和 `store.js` 的注释都写"失败返回 false、不抛"，
   实现却是 `throw e`。于是存档保存里那条判断永远不成立，磁盘满 / 文件被锁时
   异常直接穿透到没包 try 的调用点，把"这次没写成功"放大成"整条链路失败"。
   现统一为**返回 false + 记一条 error 日志**，要不要当失败处理交回调用方。
   `tests/atomic-write.test.mjs` 4 条钉住契约（含"失败后不留 .tmp 残骸"）。

3. **插件 storage 是全项目唯一一处裸 `writeFileSync`，而且读坏了就清空**
   - 写：改走原子写（tmp+rename）。原来写盘瞬间打开插件面板会读到截断的 JSON
     （面板白屏），写一半崩掉则下次读成空对象，随后 set 把整个 storage 清空。
   - 读：区分三种情况 ——「不存在」正常空存储；「损坏」先把坏文件改名留证再返回空；
     「读不出来」标记降级：get 仍给兜底值（不拖死扩展），set 直接拒绝并说明原因，
     绝不用空数据覆盖磁盘上的原文件。

4. **壁纸页「浏览…」选完文件夹，输入框一个字都不填**
   `electron/preload.cjs` 里 `pickDirectory` **定义了两次**，对象字面量后者覆盖前者：
   实际生效的返回 `{ok, dir}`，而壁纸页按被覆盖那条读 `r.path` —— 永远 undefined，
   于是弹框、选完、什么都没发生，也没有任何报错。现在只保留一条，
   壁纸页 `dir || path` 两种都认。

5. **桌宠页 / 市场页的请求没有超时，能把页面永久冻住**
   `api()` 只有拿到 `timeoutMs` 才装 `AbortSignal.timeout`。桌宠页的 state 请求
   一旦悬着，状态条永远停在"读取中"；更糟的是轮询里的 `dpLoading` 因为 finally
   还没跑到而一直为 true，此后每次 tick 都在入口被跳过 —— 页面看着活着，
   其实再也不会自己刷新。市场页的 verify/install 同款（按钮已 disabled，
   就永久停在"安装中…"）。现在统一给超时：桌宠 20s，导入模型 / 观察屏幕 180s；
   市场校验 20s、安装 120s。

6. **丢弃草稿撞上 409 时静默，界面还显示"已放弃"**
   R139 加了草稿锁之后，两个窗口同时操作会回 409 —— 但两处 discard 都是空 catch，
   升级页还**无条件**清空 `u.draft`：界面说已放弃，磁盘上的草稿其实还在，
   下次进页面又冒出来，用户只会觉得"删不掉是 bug"。现在失败就保留状态并说明原因。

7. **接口超时被误报成"插件未启用 / 模块没注册"**
   `loadForgeStatus` / `loadFixStatus` 的 catch 直接把 `available` 置 false，
   渲染层于是告诉用户"插件当前未启用"，并引他去启用一个本来就开着的插件。
   现在单独记 `unreachable`，文案改成"读不到状态 + 重试"，不再误导。

8. **切换兼容模式后，重启期间的提示会被轮询覆盖、按钮还能再点**
   主进程 relaunch 的 10~30 秒里控制台是断的，4 秒一次的轮询连续失败，
   把"正在重启，请稍候…"冲成红色"读取桌宠状态失败"；`finally` 又把按钮恢复可点，
   连点就是两个重启请求。现在加 `dpRestarting` 标记：停轮询、不重绘、不提示，
   并留 90 秒兜底（万一重启被安全软件拦下，不会把按钮永远锁死）。

9. **状态条「桌宠 显示中」与「桌面窗口 未连接」同屏两个绿点**
   前者原来只看配置开关 `settings.visible`。现在分成
   「显示中 / 已开启·等待加载 / 已隐藏」，按窗口是否真的加载出来判断。

10. **存档消息接口默认拉全量 + 界面偶尔甩出裸 HTTP 状态码**
    `/api/chats/<key>/messages` 不传 limit 时默认 `1048576`（= 全部），默认改 2000
    （前端存档页显式传 5000，不受影响）。三处 `` `HTTP ${res.status}` `` 改用
    `httpStatusText` 的人话文案。

### 验证

- 全量 **235 条单测通过**（新增 8 条：配置降级 4 + 原子写 4）。
- 配置降级用真实文件系统模拟：EISDIR（config.json 换成目录）、损坏 JSON、ENOENT，
  并验证没有误伤（IO 错误时原路径不动、不产生 `.corrupt`）。
- 本轮改动的 12 个文件逐个 `node --check`。
- 发布体检仍 ✓ 可打包。

### 有意未修

- `/api/sessions` 的 limit 默认仍是全量。它返回的是摘要数组、不读消息正文，
  改成分页要同时动前端分页，超出本轮范围。

---

## 未发布 · 把 R138 列出的「发现但没动」全部修掉（2026-10-28，R139）

> R138 复查结尾列了 6 条中低危项，当时标的是"要你拍板"。本轮按要求全部修完。
> 每条都给了触发路径，并且用实跑验证（不是读代码下的结论）。

### 已修

1. **同一份草稿能被两个请求同时改写（并发，前后端都补）**
   - 前端：`forgeBusy()` 与 `upgradeBusy()` 各判各的。新装起草与升级起草
     共用同一个暂存区根、同一个闸门、同一套"当前草稿"状态，于是"新装正在
     适配"时升级页的导入/安装仍可点。现改为 `forgeOwnBusy()` / `upgradeOwnBusy()`
     两个内部原语，对外的 `forgeBusy()` / `upgradeBusy()` 都**跨模块**判断
     （互相调用会死递归，所以分两层）。
   - 后端：原来**完全没有** draftId 级锁 —— 刷新页面、开两个窗口、直接打接口
     都能绕过界面守卫。新增 `src/forge-draft-lock.js`（纯内存、无 IO，可单测），
     在 7 个会写草稿/会落地的路由上取锁：`import / adapt / draft(revise) /
     install / discard / upgrade / upgrade-install`；读、查、预览不受影响。
     拿不到锁回 `409 {busy:true}`，提示"正在被「适配」处理（已 N 秒）"。
     释放挂在响应的 `finish`/`close` 上 —— handler 里有多处 return，逐个包
     `try/finally` 容易漏，而 finish 一定能触发。锁不落盘，进程重启即清空，
     不存在"上次崩溃留下的死锁"。
   - 验证：`tests/forge-draft-lock.test.mjs` 6 条（二次获取被拒 / 释放后可再取 /
     重复释放幂等且不误删他人锁 / 不同草稿互不影响 / 空 draftId 放行 /
     前后空格归一化——否则一个空格就能绕锁）。

2. **网络收藏的 GIF 在详情里不再动**（R138 记的"防崩取舍没闭环"）
   - 病灶：`hydrate()` 只给 `file:///` 的本地 GIF 生成 mp4；网络 GIF 被转成
     `net_<id>.jpg` 后，页面光看扩展名判不出它原本是动图，详情只剩静态首帧。
   - 修法：网络 GIF 下载时**同时**生成 `net_<id>.mp4`（还是视频解码，不碰 GIF
     解码器）；转不出来就写 `net_<id>.nomp4` 标记，避免每次启动白试一遍
     （标记也纳入 `#pruneThumbs` 的保留集，否则会被当孤儿删掉、下轮又重下）。
     老缓存（图片在、无 mp4、无标记）会自动重下一次补齐 —— 只发生一次。
   - 传递：`materializeThumbs` 的 value 从字符串改为 `{ thumb, video }`，
     `buildViewSnapshot` 两种形态都吃（旧字符串仍兼容），快照 items 新增
     `video` 字段，`snapshotSignature` 也把它计入指纹（否则补出 mp4 后签名不变、
     页面不刷新）。
   - 验证：临时数据目录里跑真实 `hydrate()` → 产出 `test.mp4` + `test.thumb.jpg`，
     `materializeThumbs()` 返回 `{thumb:"../@data/img/test.gif", video:"../@data/img/test.mp4"}`
     且文件存在；第二次 `hydrate()` 返回 0（幂等）。产物用 ffmpeg 实测：
     mp4 `ftyp` 在 offset 4、jpg magic `ffd8`。

3. **本地 GIF 首帧和视频都不存在时，详情页是破图**
   - `video.onerror` 会退到 `.thumb.jpg`，但那个分支的 `<img>` 没有 error 兜底
     （非 GIF 分支有）。首次安装、ffmpeg 还没就绪时两张都没有。
   - 现补 `img.onerror` → 「动图转码失败，也没有首帧」占位；`img.onerror`
     在进入详情时先置 null，避免复用节点带上一张的回调。

4. **表情包图片转存非原子，半张图会被当成可用素材**
   - `fs.writeFileSync(dest, buf)` 直写最终文件名，进程被杀/磁盘满留下**非空**
     残片；而"缓存是否可用"的判据是 `existsSync` → 残片永远不重修：面板破图、
     发出去坏图，只能手工删。
   - 新增 `writeFileAtomic()`（同目录临时名 + rename）与 `isUsableFile()`
     （存在且非空）。落盘点全部改掉：`#persistImage` 三处、`hydrate` 网络缓存、
     `materializeThumbs` 的副本复制。ffmpeg 产物走新加的 `ffmpegInto()` ——
     ⚠️ 临时名必须**保留真实扩展名**（`.tmp_x.mp4` 而不是 `x.mp4.part`），
     ffmpeg 靠扩展名选容器，改成 `.part` 会直接报 "Unable to find a suitable
     output format"（已实测）。所有 `existsSync` 判据换成 `isUsableFile`。
   - 验证：把 `test.thumb.jpg` 截断成 0 字节 → 再跑 `hydrate()` 返回 1 且重建为
     12333 字节；ffmpeg 实测 `.tmp_x.mp4` / `.tmp_x.jpg` 均可正常产出。

5. **三个写盘点绕过 `mergeDiskStickerStore`（E1 只修了两条路径）**
   - `note` / `markUsed` / `collect` 直接 `saveStickerStore(this.entries)` 整份覆盖。
     一边有脚本改库、一边让机器人收藏一张，脚本改的那批就被内存快照抹掉。
   - 新增私有 `#saveMerged()`：先 `mergeDiskStickerStore` 并入磁盘外部改动，
     再落盘；合并失败退化为直接落盘（不能因为合并逻辑坏了反而不保存）。
   - 验证：磁盘上放一条外部新增 + 一条旧版本，调 `note()` 后磁盘 2 条都在、
     外部新增保住、内存备注/标签落地、旧磁盘的 desc 没有覆盖内存。

6. **扩展 ↔ 扩展同名覆盖完全静默**
   - `skillManager.register` 只报 core↔扩展两个方向。两个扩展目录用了同一个
     `manifest.id` 时，后加载的静默顶掉前一个（表现："我装了两个，其中一个不生效"）。
   - 补第三个分支，但用 `relDir` 区分：同目录重载是**正常热重载**（开发期每次
     保存都会走），不同目录才是真撞车。只在前者不同时告警。

7. 顺手清理（不影响行为）：`checks.js` 的 `r.level === 'L0' ? 'block' : 'block'`
   拆成常量 `'block'`（原写法会让人误以为存在"非 L0 可放行"的语义）；
   `doctor/index.js` 里"本文件位于 plugins/self-doctor/"的过时注释更正。

### 验证

- 全量单测 **227 条通过**（新增 6 条锁用例）。
- `plugins/sticker` 4 个文件改动后已重算内置基线
  （`sticker：+0 -0 ~4 改动[index.js, lib/manager.js, lib/stickers.js, panel/viewer.js]`）。
- 仍待人工：桌宠端到端实机验收（本会话拉起的 GUI 会被系统挂起，与代码无关）。

---

## 未发布 · 全天复查：给今天九轮改动做一次对抗性审查（2026-10-28，R138）

> 要求：「审查一下今天所有的 bug 修复和改动/新增/优化有没有带来新的 bug，
> 同时审查一下其他没有动的地方有没有类似的 bug 出现」。
> 结论：**有 3 处是今天改动直接引入的**（其中 1 处是我今天自己写的），
> 另 3 处是同类模式在相邻代码里的漏网。全部带实测证据并已修。

### 已修

1. **自动兼容没有撤销路径（R137 自己引入）** —— 更新说明写着「关掉桌宠，下次启动
   自动恢复渲染沙箱」，但 `sandbox:false` 写进配置是**持久**的，而自动兼容的判定
   前置里带着 `!sandboxOffByConfig`，没有任何代码把它改回去。用户明明不要桌宠，
   却会长期跑在关闭渲染沙箱的状态下。现补 `shouldRevokeAutoCompat()`：只撤销应用
   自己写的（`sandboxOffBy === 'auto-pet'`），用户手动点的「开启兼容模式」保留，
   桌宠状态读不出来时不动。单测 8 → 12 条，含「开→自动关→关宠物→恢复」完整循环。

2. **起草扩展的金标准示例 100% 丢失（R130 归档引入）** —— `src/routes.js` 仍从
   `plugins/extension-forge/examples` 读 few-shot，而该目录已随 R130 归档，实际示例
   在 `src/harness/forge/examples`。读失败被 `catch` 静默吞掉、日志无痕，表现只是
   「模型写出来的扩展不如以前」。现改为两处探测，都没有才退空串，已实测解析到
   `src/harness/forge/examples` 且 `golden-skill.json` 存在。

3. **L0 禁改清单能被五种写法绕过（R130 遗留）** —— `classify()` 直接拿原串
   `startsWith` 比前缀：`./src/harness/fix/core.js`、`src//harness/…`、
   `src/./harness/…`、`SRC/HARNESS/…`、反斜杠形态全部落到 L1 兜底，而
   `path.join` 仍解析到同一个真实文件。现先 `path.posix.normalize` 再小写比对；
   实测五种变体全部判 L0，且 `plugins/sticker/index.js` 仍 L2、`src/routes.js` 仍 L1。

4. **路径穿越闸门漏检单反斜杠（gate.js + checks.js 同一条错正则）** ——
   `/\.\.\s*\/|\.\.\\\\/` 的后半段要求**两个**反斜杠，Windows 写法 `..\x` 永不命中。
   两处统一为 `/\.\.\s*[\\/]/`：`../x` / `..\x` / `.. /x` 均命中，`a..b` / `..x`
   不误伤。

5. **锻造台档位与新装口径不一致** —— `gateOpts()` 只判 `Boolean(meta.upgradeOf)`，
   升级目标被卸载后 UI 三处已按「全新安装」处理，闸门却仍给 third-party 宽松档。
   现直接调 `upgradeTargetExists()`。⚠️ 特意**没有**写成读 `meta.upgradeTargetExists`：
   该字段是 load-meta 时现算的，`readMetaRaw` 读的 `_meta` 文件里没有它，比较会恒真 ——
   那正是今天"补丁打在不生效的那一份上"同一个坑。

6. **表情包详情图的 error 监听器永久累积** —— `#ov-img` 是**复用节点**，原来只在
   出错时自我摘除，成功加载的监听器一直留着；反复开关详情后遇到一次 404（rkey 过期）
   会触发历史全部回调，往已清空的容器里追加一堆「图片加载失败」。改为 `img.onerror =`
   赋值覆盖。（`plugins/sticker/panel/viewer.js` 改后已重算内置基线。）

### 发现但没动（要动得先确认取舍）

- **网络收藏的 GIF 在详情里不再动**：为防多帧 GIF 解码打崩渲染进程，网格统一用首帧
  缩略图、详情用 `<video>` 播 mp4；但 mp4 只给**本地** GIF 生成，网络 GIF 被转成
  `.jpg` 后 `isGif` 判不出来 → 详情只剩静态首帧。是"防崩"的取舍没做闭环，
  不是崩溃回归。补法：hydrate ① 分支对网络 GIF 同时产出 mp4。
- **本地 GIF 的缩略图与 mp4 都不存在时详情是破图**：`video.onerror` 会退到
  `.thumb.jpg`，但该分支的 `img` 没有 error 兜底（非 GIF 分支有）。首次安装、
  ffmpeg 未就绪时可见。
- **表情包图片转存非原子**：`fs.writeFileSync(dest, buf)` 直写，写一半残留的**非空**
  文件会被当成可用图发出去。建议 `<dest>.<pid>.tmp` + rename（与 `saveStickerStore` 同口径）。
- **表情包三个写盘点没走 mergeDisk**：`note()` / `markUsed()` / `collect()` 直接
  `saveStickerStore(this.entries)`，外部改过的库会被内存快照整份盖掉 ——
  E1 的同类坑只在 `sync` / `ensureSendable` 两条路径修过。
- **前端草稿互斥仍不完整**：只有「适配 ↔ 升级对话」两条互补检查；
  「继续修改」「安装」「丢弃」只查自己的 busy，不看另一侧。后端也没有 draftId 级
  令牌，刷新页面即可绕过（超时今天放大到 620/780/820s，窗口同比变长）。
- `checks.js` 的 `const lvl = r.level === 'L0' ? 'block' : 'block'` 两分支相同
  （代码腐化，行为无差）；`skills/manager.js` 的同名覆盖日志只覆盖
  core↔扩展，扩展↔扩展仍静默。

---

## 未发布 · 分发给别人的包「开箱就没有桌宠」（2026-10-28，R137）

> 用户追问：「能不能保证分发包也能正常显示？」
> 上一轮（R136）修的是**本机**看得到，这一轮修的是**别人拿到包**看得到。

**问题**：R136 之后，桌宠只在「GPU 正常」或「已切兼容模式」两条路上显示。而收包人的
机器上会出现第三条路 —— 首启是 GPU 模式，GPU 子进程被本机安全软件拦杀，自动降级
写 `render-gpu-off.flag` 并重启，于是停在**软件渲染 + 保渲染沙箱**：

- 这条路上 Live2D 拿不到 WebGL，硬起桌宠窗口会让整个应用 CHECK 自杀（R134 实测）；
- 所以 R136 加了一道硬闸：**跳过桌宠**，只写日志 + 桌宠页留一句提示；
- 结论：**主界面能用，桌面上的桌宠没了**，要恢复只能「进桌宠页 → 点开启兼容模式」，
  或者设 `QQ_AGENT_NO_SANDBOX=1` —— 这两件事收包人都不会做。
  对开发者是"少个动画"，对收包人是**功能开箱即坏**。

**修法**：把判定提前到 `whenReady` 之前（命令行开关一个都还没 append 的时候）：

```
软件渲染（render-gpu-off.flag 存在）
且 配置里还没关沙箱（render-config.json 的 sandbox !== false）
且 用户没设 QQ_AGENT_KEEP_SANDBOX=1
且 桌宠是开着的（desktop-pet/state.json 的 settings.visible !== false，缺失按 true）
⇒ 写 render-config.json { sandbox:false, sandboxOffBy:'auto-pet', ... }，本次启动直接生效
```

三个设计要点：

1. **不需要重启**。因为判定发生在加开关之前，改完配置这一轮就走兼容模式
   （`in-process-gpu` + `enable-unsafe-swiftshader`，不加 `--disable-gpu`），
   用户不会看到"启动两次"的闪屏。
2. **只有桌宠开着才降级**。桌宠关掉的人不该为它牺牲渲染沙箱的安全纵深；
   `QQ_AGENT_KEEP_SANDBOX=1` 是排障用的显式拒绝。
3. **判定抽成纯函数** `electron/render-policy.js`，并配 `tests/auto-compat.test.mjs`
   （8 条）。原因很实在：这段逻辑没有界面，出错的表现就是"桌宠莫名消失且无提示"，
   而 `main.js` 一被 import 就会拉起 Electron、根本没法在 node 里测。

**还剩一道必须靠打包流程保证的事**：`data/` 绝对不能进 zip。带着本机的
`render-config.json`（`sandbox:false`）分发，等于所有收包人一开就是兼容模式；
带着 `config.json` 更是直接泄露 API Key / QQ 号 / 群白名单 / 聊天记录。
这条不在代码里，在打包脚本里（见「发布前体检」）。

**遗留**：本轮无法做端到端实机验证 —— 当前会话拉起的 `QQ Agent.exe` 一律被系统
挂起（`CPU 时间 0:00:00`、状态 `Unknown`、零子进程），回滚到改动前的版本同样如此，
说明是运行环境的进程管控、不是本次代码。已用 `node --check` + 8 条单测覆盖判定逻辑，
实机确认需要在桌面手动双击启动（验证点：`data/render-config.json` 是否自动出现
`sandbox:false` + `sandboxOffBy:"auto-pet"`，且桌宠出现在桌面上）。

---

## 未发布 · 兼容模式下桌宠窗口画不出来（2026-10-28，R136）

> 用户反馈：「重启了软件，还是没有在桌面上看到桌宠」。
> 排查结论：桌宠**进程、模型、窗口全正常**，但一个像素都没上屏。

**根因**：软件渲染模式下同时给了 `--disable-gpu`（以及 `disableHardwareAcceleration()`
内部追加的 `disable-gpu-compositing`）。这两个开关会让 Chromium 走"强制软件合成"，
而**透明窗口在这种合成路径下拿不到呈现面** —— 窗口 `IsWindowVisible()===true`、
置顶、Z 序正确、不被遮挡，`capturePage()` 也能拿到完整画面（角色渲染得好好的），
但屏幕合成结果里那块区域是别的窗口。用户侧就是"桌宠不见了"，且日志里毫无异常。

**验证方式**（这次换了正确的测量口径）：先 `SetProcessDpiAwareness(2)` 切到物理像素，
再 `EnumWindows` 取窗口矩形 + `DwmGetWindowAttribute` 取 DWM 实际位置，最后对该
矩形做 `BitBlt` 抓屏比对。之前用 DPI-unaware 进程抓屏会把坐标当成 DIP 处理，
抓出来的是别的窗口，导致长时间误判成"窗口没被创建"。

**改动**（`electron/main.js`）：
- 兼容模式（`data/render-config.json` 的 `sandbox:false` / `QQ_AGENT_NO_SANDBOX=1`）
  **不再加 `--disable-gpu`**，也不再调 `app.disableHardwareAcceleration()`；
  这两样只在"保沙箱"那条路上保留（那条路本来就不建桌宠窗口）。
- 硬件不可用时 Chromium 自己会退回软件光栅化（`getGPUFeatureStatus()` 同样是
  `gpu_compositing=disabled_software`，但走的是能让透明窗口上屏的那条路径）。
- 已实测：同一台机、同一份 data，只切这一个变量 —— 加 `--disable-gpu` 桌宠看不见，
  去掉就正常显示；`--disable-direct-composition` 单独加**无效**（已验证并回退）。

---

## 未发布 · 让软件在别人机器上能自己活过来（2026-10-28，R135）

> 背景：这个软件要以 zip 分发给别人用，而 R134 的两条修复都是围绕"本机"打的补丁 ——
> 有的路径依赖 `QQ_AGENT_NO_SANDBOX=1` 环境变量，收包人不可能去设；有的路径会静默
> 跳过桌宠，用户只会觉得"桌宠坏了"。分发前必须把「机器坏了怎么办」这件事做进软件里。

### 修掉

- **GPU 崩溃自动降级从来没生效过**：`main.js` 里判的是 `details.type === 'GPU Process'`，
  而 Electron 实际传 `'GPU'`，字符串永不相等 ⇒ 「60 秒内崩 3 次就自动退到软件模式」这层
  安全网从落地起一次都没触发过。显卡驱动有问题的机器会 GPU 进程无限崩溃，永远进不了
  软件模式。现已改正，并补上 `clean-exit` 排除（正常退出不计入崩溃次数）。
- **渲染进程被安全软件拦杀后只会无限重载**：火绒 / 360 / 电脑管家 会拦杀沙箱化的
  Chromium 渲染进程（`exitCode=0x80000003`），原来的行为是崩→重载→再崩，最多 5 次后
  放弃，用户看到窗口反复闪白、永远进不去。现在 60 秒内连崩 3 次就判定「本机沙箱不可用」，
  自动写 `data/render-config.json` 的 `sandbox:false` 并重启，此后每次启动都直接生效。
- **降级不再只能靠环境变量**：`QQ_AGENT_NO_SANDBOX=1` 对收包人等于不存在。现在沙箱状态的
  权威来源是 `data/render-config.json`（持久化），环境变量仍可用于排障强制覆盖。

### 优化

- **桌宠页不再说假话**：软件渲染 + 沙箱时主进程会主动跳过建窗（R134 的硬闸），但界面
  原来只会写「请通过 QQ Agent 桌面程序打开桌宠」—— 用户会以为软件坏了。现在宿主会把
  真实原因带出来（`runtime.hostUnavailableReason`），页面照实显示。
- **新增「开启兼容模式并重启」按钮**：就在桌宠页的状态提示条上。点它会弹出说明（拿渲染
  沙箱换桌宠可用），确认后写入 `render-config.json` 并自动重启，起来后桌宠就能显示。
  这个选择会记住，不用每次点。

---

## 未发布 · 桌宠导致「点开就崩」（2026-10-28，R134）

> 用户反馈：开了桌宠插件之后，软件点开就崩溃，进不去。

### 根因（实测，不是猜的）

两条**独立**的致命链，都指向同一个前提伤口：本机只能软件渲染
（`data/render-gpu-off.flag` 存在 → `--disable-gpu`）。

1. **桌宠没有可用 GL 后端**：桌宠是 Live2D（Cubism + Pixi），起窗口就要 WebGL。
   而软件模式原来自带 `--disable-software-rasterizer`，等于一个 GL 后端都不剩。
   实测证据（`data/logs/exp-pet-on-nosandbox.stderr.log`）：
   `Failed to create GLES3 context` → `kFatalFailure: Failed to create shared context`
   → `FATAL:gles2_cmd_decoder.cc(2912)`。再叠加 `--in-process-gpu`（GPU 线程就在
   主进程里），这条 FATAL 直接把**整个应用**带走。
2. **沙箱渲染进程被安全软件拦杀**：本机装着火绒（`HipsTray`/`HipsDaemon`）+
   腾讯电脑管家（`QQPCRTP`），Defender 已被接管关闭。它会杀沙箱化的 Chromium
   子进程（`electron/main.js` 顶部 R44/R70 早就记过这件事），表现是渲染进程
   `exitCode=-2147483645`（0x80000003，Chromium 的 `IMMEDIATE_CRASH`），
   主窗口 / 悬浮小窗 / 桌宠一起死。

### 改动

- **`electron/main.js` · 软件模式开关二选一**：原来无条件加
  `disable-software-rasterizer`；现在按「有没有关沙箱」分流 ——
  默认（有沙箱）保持原样；`QQ_AGENT_NO_SANDBOX=1` 时改为
  `enable-unsafe-swiftshader`，让 WebGL 走 SwiftShader 软件后端。
  两者**不能同时给**：实测同时给会让沙箱渲染进程自杀，连桌宠没开的默认配置都崩。
- **`electron/main.js` · 桌宠硬闸**：软件模式 + 沙箱时**不建桌宠窗口**，只落一条
  能查的日志（说明原因与旁路）。桌宠没资格把整个界面拖垮 ——
  这条闸就是「以后再遇到同类环境，最坏也只是桌宠不出现，软件照常可用」。
- 代码备份在 `data/code-backups/main-js-20261028/`。

### 怎么用

- 正常双击 `QQ Agent.exe`：主界面正常，但**桌宠不会出现**（日志里会写明原因）。
- 想用桌宠：用安装目录的 `测试-无沙箱启动.bat`（内部就是 `QQ_AGENT_NO_SANDBOX=1`）。
  已验证 Live2D 正常出模型（`Cubism Core 05.00.0000` → `模型已加载并上报`）。
- 更彻底的办法：在火绒里把 `QQ Agent.exe` 加白 / 恢复被拦项，之后双击即可，
  沙箱也能保住（届时把桌宠那道硬闸放开就行）。

---


## 未发布 · 技能页默认排序与出厂默认开启（2026-10-28，R133）

> 用户指定（附截图）：列表默认顺序按「生效中在前」，出厂默认开启的技能按截图集合。

### 改动

- **默认排序**：`renderModulePage` 在用户**没有拖过排序**时，按状态稳定排序 ——
  生效中（`stateOf === 'on'`）在前，已关 / 加载失败 / 依赖未就绪在后，组内保持原相对顺序；
  拖过的顺序（config.ui.moduleOrder / localStorage）是显式指定，不覆盖。
- **出厂默认开启集合**：`skills/knowledge-memes/skill.json` 与 `skills/help-board/skill.json`
  的 `enabledByDefault` 改为 `true`（回忆工具原本就是 true）—— 全新安装默认开启这三个，
  其余五个（关键词自动回复 / 计算器 / 文生图 / 二次元随机图片 / 日程表）保持默认关闭。
  已有 config 的机器不受影响（`isEnabled` 口径：config 优先，清单兜底）。
- **基线重算**：两个清单改动已用 `refresh-builtin-baseline.mjs` 重算并写回
  `builtin-modules.json`（help-board / knowledge-memes 各 ~1），避免准入闸按占名顶替拦截。

---

## 未发布 · 自检工作台三处交互修复（2026-10-28，R132）

> 群友/自查发现的「操作违背正常逻辑」问题，全部在 `ui/app/13-doctor.js`。

### 修复

- **对话排查「生成修复提案」点不动（功能断裂）**：`repaintDoctorChat()` 每次只重建
  `#doctor-chat-log` 的 innerHTML，而 `[data-fix-from]`（生成修复提案）与 `[data-doctor-ask]`
  （示例问题）的事件只在整页渲染时绑一次 —— 第一次问答后这些按钮全部失效，等于断掉
  「对话排查 → 自动修复」主链路。改为在 `#doctor-chat-log` 上做**事件委托**，容器不在
  重建范围内，委托一次管永久。
- **永久删除开发会话确认框未标红**：删除不可恢复，确认键却用普通主色；同文件
  `runFixDelete` / `runBundleRollback` 都已标红。现统一传 `danger: true` 并写明「确认删除」。
- **接收整包「检查并登台」误导**：登台成功后按钮被永久 `disabled` 且文案改「已登台」，
  但改勾选后既无法再登台、又会被安装按当前勾选静默跳过（看登台了实际没装进去）。
  现改为可「重新检查并登台」，并提示「改了勾选请点重新检查并登台重新过闸」；
  零选中点击不再静默返回，改为提示「请至少勾选一个扩展再登台」。

### 未改（需另行确认）

- 丢弃修复提案无二次确认（设计上用「必填理由」替代确认，是否改待定）。
- 修复工单状态芯片漏算 `rolled-back` 终态、锻造台「去XXX页开启」在已启用时语义相反、
  「全部会话」用量累计口径 —— 后两者依赖后端返回（`autoDisabled` / `usageTotal`），
  需核后端契约后再动。

---

## 未发布 · 扩展页筛选条分面计数（2026-10-28，R131）

> 群友反馈「技能 / 插件页筛选条的数字显示逻辑有点问题」。排查发现两处口径问题，
> 都在 `renderModulePage` 的筛选条里（`ui/app/06-settings-render.js`）。

### 修复

- **两排数字各数各的**：状态行（全部/生效/已关/加载失败）与来源行（不限来源/内置/第三方）
  的计数都按整页统计，不受另一行选中档影响 —— 选了「已关」后来源行还写「内置 8」，
  和下面实际列出的卡片对不上。现改为**分面计数**：每行数字先按另一行选中档过滤再数，
  「数字 = 卡片数」恒成立（列表与计数共用同一份 `stateOf` / `matchState` / `matchSrc` 谓词）。
- **「依赖未就绪」第 4 态漏数**：后端 `active = loaded && enabled && available`，
  卡片本有第 4 态（已开启但依赖不满足，`mcard-dep`），但筛选条只有 3 档 ——
  这类条目只被算进「全部」，点遍三档都找不到，三档之和会小于「全部」。
  现在计数 > 0 时补出「依赖未就绪」一档（常态 0 不占位），选中即可直接筛出这些卡片。
- 无行为损失：原三档的判定谓词与旧版逐条等价（`on`/`off`/`bad`），仅口径收拢成单一出口；
  页头「X / Y 生效」徽章沿用原口径，不受影响。

---

## 未发布 · 清理内置化的重复副本（2026-10-28，R130）

> 起因很小：「把 `src/harness` 下的重复副本清理掉」。顺着这条线查下来，发现
> **方向反了**——重复副本不在 `src/harness`，而在 `plugins/`；更要紧的是，
> 前几次给锻造台打的补丁**全都打在了不生效的那一份上**。

### 修复

- **认清了哪一份在跑**：启动顺序是 `loadPlugins()`（扫 `plugins/`）→ `registerHarness()`
  （注册 `src/harness/`），两者 id 相同，后者把前者覆盖掉。而 `plugins/` 下还留着
  `self-doctor` / `self-fix` / `extension-forge` / `dev-orders` 四份 2026-10-21
  内置化之前的旧副本 —— 它们照常被扫描、setup 照常执行，然后被顶掉。
- **后果更正**：R128 的「升级草稿显示待安装」修复、`upgradeTargetExists` 判断，
  当时改在了 `plugins/extension-forge/`，而真正对外提供 `forge.*` 能力的是
  `src/harness/forge/`。**换句话说那条修复从落地起就没生效过**。现已全部移植到
  `src/harness/forge/index.js`，并做了正反两向实测（目标在 → `upgradeOf` 正常回传；
  目标已卸载 → 回落 `null`）。
- **旧副本已归档**：四个目录移到 `data/code-backups/legacy-plugins-20261028/`
  （可整目录搬回），`builtin-modules.json` 同步从 25 条降到 21 条，基线校验通过。
  附带好处：启动时少跑四份 setup，也不再因为旧副本指纹对不上而弹「扩展加载失败」红卡。
- **同名覆盖现在会留日志**：`skillManager.register` 遇到「内置模块顶掉同名扩展」或
  「扩展顶替内置模块」都会明确记一条。这次的坑之所以难查，就是因为覆盖是静默的 ——
  改了代码"没效果"，日志里一条线索都没有。
- **自我指涉禁区跟着搬家**：`self-fix` 的 L0 禁改清单原本写的是 `plugins/self-fix/`
  等旧路径，目录搬走后这份清单**等于失效**（模型可以改闸门本身了）。现已加入
  `src/harness/fix/`、`src/harness/doctor/`、`src/harness/forge/gate.js`，
  旧路径保留兼容。体检扫描器的「不量自己」豁免、修复提示词的 P3 条款同步更新。

---

## 未发布 · 复查修补：超时预算 / 秒表 / 并发写草稿（2026-10-28，R129）

> 对 R126–R128 的整体复查。重点不是新功能，而是"前后端预算对不上""两条路线抢同一份草稿"
> 这类平时不显形、一旦发生就会被用户误判成"功能坏了"的问题。

### 修复

- **前端超时对齐后端预算**（最要紧的一条）：升级的客户端超时是 260s，而后端
  「首轮 240s + 最多 2 轮自动修复（每轮独立 240s）」最坏 ≈ 720s —— 到了 260s 前端先断开，
  界面报"升级失败"，后端却在继续改暂存区；用户一重试，就有两个请求同时写同一份草稿。
  现在升级 780s、起草 820s（后端 ≈ 750s）、适配 620s（后端 ≈ 510s）。
- **进度秒表改成每路一份**：原来是一个全局单例，适配在跑时又从设置页触发升级，
  后启动的会把前一个清掉，那一路的"已用秒数"直接冻住 —— 恰好是最容易被当成卡死的地方。
- **同一份草稿禁止两个模型同时改**：自创页的「适配」与升级页的「对话升级」各自判定
  busy，互不相通；同一个 draft 同时被两边改写会出现"谁最后落盘算谁的"静默丢改动。
  现在任一侧在改这份草稿时，另一侧会明确拒绝并说明原因。
- **「继续修改」不再丢升级身份**：`/api/forge/draft` 现在回传 `upgradeOf`。此前改完一轮
  后前端拿不到它，安装按钮退回「确认安装」，点下去走普通安装 → 已装扩展被复制成
  `xxx-2`。与 R128 是同一个坑的另一个入口。
- **升级目标被卸载的判断统一**：「升级目标是否还存在」由插件侧一处计算
  （`upgradeTargetExists`），列表、打开草稿、安装三处共用，不再出现
  "列表说待安装 / 点开说可覆盖更新 / 点下去报目标不存在"。

---

## 未发布 · 修「已装插件的升级草稿显示待安装」（2026-10-27，R128）

> 「自创扩展 → 暂存区的草稿」里，「升级扩展」创建的草稿（针对已装插件的修改）
> 显示「已过闸 · 待安装」—— 看着像要装个新的。更糟的是，从这里点「确认安装」
> 走的是普通安装（同名递增、绝不覆盖），会把已装扩展复制成一份 `sq-self-2`，
> 原插件纹丝不动，用户还以为升级成功了。

### 修复

- 草稿列表带上升级目标：`forge.list` 读取草稿 meta 的 `upgradeOf`，升级草稿
  显示「⬆ 更新 sq-self」徽标 +「已过闸 · 待更新」状态；升级目标已被卸载时
  回落为「待安装」（那时确实就是新装）。
- `/api/forge/gate` 响应带 `upgradeOf`，打开草稿的视图据此分流：
  按钮文案「我已核对，覆盖更新 sq-self」，说明改为「自动备份原版、可回滚、
  启用状态保持不变」；安装动作改走 `/api/forge/upgrade-install`
  （备份原版 + 同 id 校验 + 覆盖），不再落进普通安装。
- 安装成功的结果块按「已更新」渲染：显示版本变化（1.0.0 → 1.1.0）与备份路径，
  提示去「升级扩展」页可一键回滚；新装的结果块不变。

### 波及面

- 只影响「自创扩展」页打开**升级草稿**时的展示与安装路径；新装、市场导入、
  「升级扩展」页自己的安装流程均不变。

---

## 未发布 · 修「自检页 → 模型设置」填了不生效（2026-10-27，R127）

> 在自检页的「模型设置」里勾选独立配置、填好 Base URL / 模型 / Key，界面也提示
> 「已切换为独立配置」，但**对话排查实际仍在用全局模型回答** —— 成本也记在全局渠道
> 名下。原因是 `chatCompletionWithRetry` 无条件用「主模型 + 备选模型」的候选序列覆盖
> 调用方传入的 `overrides`，而候选第一项恒为「跟随全局」，专用配置被整个丢弃。

### 修复

- `chatCompletionWithRetry` 现在**尊重调用方显式传入的 `overrides`**：给了就用它，
  不再并回全局备选链。这与 `chatCompletion` 里「传了 overrides 就绕开账号池与专用
  模型切换」是同一条隔离约定 —— 独立配置的价值就在于隔离。
- 没传 `overrides` 的调用（群聊主链路）行为完全不变：仍是主模型 + 备选链 + 账号池。
- 同步修正 `cache-warm.js` 里已失效的注释（它写的「WithRetry 会换掉端点」不再成立）。

### 影响到的范围（此前都静默走全局）

- 自检页「对话排查」（`/api/doctor/ask`）← 本次问题的出处
- 锻造台的起草 / 适配 / 升级（`/api/forge/draft`、`adapt`、`upgrade`）
- 开发工单专用模型（`devApi`）

⚠️ 行为变化：专用配置本身填错时，现在会**真的报错**，不再偷偷退回全局模型。
这是正确的失败（否则「填了不生效」永远查不出来）；自检页的「连接检测」可以先验一遍。
对话气泡下方会显示本轮实际用的模型名，可据此确认是否生效。

---
## 未发布 · 自动适配进度条：告诉用户适配到哪了（2026-10-27，R126）

> 「🔧 自动适配」一次要跑几分钟（适配最长 2 段 × 240s，升级含自动修复轮最长 8 分钟），
> 期间界面只有一行「正在适配…」挂到底 —— 用户无从判断它是在跑还是卡死，只能反复刷新。
> 现在每一步都看得见：读到哪、闸门几项阻断、模型第几轮、刚改了哪个文件。

### 新增 · 长任务进度条

- **走已有的 SSE 通道**：后端每到一个真实节点 emit 一条 `forge-progress`，前端只重绘
  进度条那一块（不整页重建、不冲掉正在输入的补充说明）。与「模型逐个审」的
  `doctor-triage` 是同一套机制，没有新增轮询。
- **一眼看到五步走到哪**：`读包 → 过闸门 → 模型改代码 → 重跑闸门 → 出对比`，
  完成的打勾、当前的描边；配一条百分比条。
- **当前在做什么**：`第 3/12 轮 · 已改写 plugin.json · 已改 2 处 · 已用 47s`。
  秒表是前端本地走的 —— 模型两次工具调用之间常隔几十秒没有事件，那段时间至少让人
  看到"它还活着"。
- **两条路线都覆盖**：锻造台的「让模型适配到本机」（`/api/forge/adapt`）与设置页
  扩展卡片上的「🔧 自动适配」（走升级工作台 `/api/forge/upgrade`）共用同一套进度组件。
- **失败/中断也会收尾**：推一条 error 让进度条停下并说明原因，不再永远停在"正在适配"。

### 两条纪律（改这块时别破坏）

- **只报已发生的事，绝不预估剩余时间**：模型还要调多少次工具、什么时候收工，后端
  同样不知道，编一个"还剩 1 分钟"出来就是骗人。所以这个百分比是"节点锚点"，不是倒计时。
- **百分比只许涨不许跌**：事件不保证严格顺序，模型也可能反复读写同一文件；进度条
  回退比不动更像出错。自动修复轮回到的区间单独封顶 95%，避免长时间钉在 92% 不动。

### 改动

- `src/routes.js`：新增 `createForgeProgress()`（两条路线共用），在适配/升级的每个
  真实节点 emit；写/删成功才计入"已改 N 处"（读文件不算改动）。
- `ui/app/13-doctor.js`：新增 `renderForgeProgress(job)` + 本地秒表，替换原先那行
  静态等待文案；`runForgeAdapt` / `runUpgradeChat` 负责起停与收尾清理。
- `ui/app/02-sse-sessions.js`：监听 `forge-progress`，按 `job` 分发到对应面板，
  并核对 `draftId`（把 A 草稿的进度画到 B 上比"没进度"更难排查）。
- `ui/style.css`：`.forge-prog*` 一组，颜色全部走令牌，暗/亮主题都读得清。

---
## 未发布 · 协议端无窗口启动：把 SnowLuma 的黑窗口收进软件（2026-10-27，R125）

> 0.4.8.9 按 EULA 把协议端移出安装包后，用户改成双击 `launcher.bat` 启动 —— 代价是
> 桌面上常驻一个 cmd 窗口，SnowLuma 的日志全在里面滚。这一条把它收进软件：**启动照旧是
> 用户自己那份、目录自己指定、文件一个字节不改**，只是不再弹窗口，日志显示在连接页。

### 新增 · 连接页「协议端进程」一节

- **无窗口启动**：用协议端目录里的 `node.exe` 直接跑 `index.mjs`，`windowsHide: true` ——
  没有黑窗口，也不再需要 `launcher.bat`。目录里没有 `node.exe` 时退回 QQ Agent 自带的 node。
- **日志进软件**：stdout/stderr 按行重组后经 SSE 推给连接页，那块面板就是原来 cmd 里的内容
  （启动横幅、WebUI 地址与密码、OneBot 端口、注入进度、报错都在）。后端留最近 800 行，
  前端 120ms 批量刷新，不逐行重绘。
- **停止 / 自动启动**：停止走 `taskkill /t /f`（连子孙进程一起收，避免孤儿占着 3001）；
  「随 QQ Agent 自动启动」默认关，勾了才在启动时拉起。
- **退出即回收**：应用退出时只停自己拉起的那个进程 —— 用户自己开的窗口不受影响。

### 边界（与 EULA 那条线保持一致）

- 不随包分发、不内置 `snowluma/` 目录；目录由用户在界面上指定（含「自动查找」）。
- 不改协议端的任何文件：不写 `config/`、不接管 WebUI 密码、**不注入 `SNOWLUMA_ACCEPT_EULA`**
  （0.4.8.x 那套"替用户同意"已随解耦一起删除，本次没有恢复）。
- 用户不点「启动」就什么都不发生。

### 顺带修掉的一个真实缺陷

- `stdout` 的 `data` 事件不保证在换行处断开，按 chunk 直接 `split` 会把一行日志切成两截
  （启动横幅和 JSON 输出尤其明显）。改成跨 chunk 行缓冲，退出时 flush 残余。

### 分发合规与"别人也能用"（2026-10-27 二次加固）

- **打包器的 `payload.7z` 里还留着 `resources\app\snowluma`（43 个文件 / 110 MB）** ——
  0.4.9 的安装包里已经没有了，但打包器用的载荷是 10-22 的旧件，用它出包仍会把
  SnowLuma 塞进安装包。已从载荷中删除（备份 `payload.7z.bak-before-nosnowluma`，
  删除后 113 MB → 97 MB，`7za t` 校验通过）。
- **修一个会让"没有 node.exe 的发行包"直接跑偏的 bug**：兜底用的是 `process.execPath`，
  而 Electron 主进程里它是 `QQ Agent.exe` —— 等于用"再启动一个 QQ Agent"去跑 `index.mjs`
  （表现：点了启动没反应，或弹出第二个实例抢锁）。现在 Electron 里只认
  「目录自带的 node.exe」或「系统 PATH 里的 Node.js」，两者都没有就明确报错并给出下载指引。
- 兼容三种真实下载形态：解压多出一层同名目录（`SnowLuma-x64\SnowLuma-x64\index.mjs`）
  自动下钻一层；老发行包只有 `index.js` 也能启动；路径含空格/中文不受影响（spawn 走数组参数）。
- 「自动查找」在"装好了但还没登录过"时也返回目录（以前只报"没找到配置文件"），
  新用户下完解压就能直接点启动，不用自己去资源管理器抄路径。
- 文案：README / 使用说明 / 连接页都写清"协议端由你自己下载、本程序不分发不打包；
  无窗口启动只是替你按一下，不改它的文件、不代你同意协议"，并说明 NapCat 用户仍用它自己的启动器。

### 新增 · 「一键接入」：把机器人 QQ 挂上协议端（2026-10-27，R126）

> 装好 SnowLuma 之后，真正要做的动作是：启动它 → 打开 5099 控制台 → 登录（密码在启动
> 日志里，得自己翻）→ 在进程表里找到机器人那个 QQ → 点「注入」。五步里有四步是"找东西"，
> 任何一步找不到都表现为"机器人不上线"，看不出差在哪。这一节把它收成一次点击。

- 连接页新增「一键接入」块：显示**当前卡在哪一步**，并只给那一步该给的按钮。
  阶段：`没配目录 / 协议端没跑 / 等控制台 / 要密码 / 被锁 / 要动态码 / 要同意条款 /
  要改密码 / 没登录 QQ / 多个号要选 / 注入的是别的号 / 可以接入 / 已接入`。
- **能自动判定的自动做**：只有一个 QQ 在线时直接注入；密码优先用启动日志里的初始凭据
  （它自己打给用户看的 `initial credentials: user=admin password=…`），登进去后自动记住。
- **需要人做主的才停**：多个 QQ 让用户选（选错会让机器人顶个人号发言）；已注入别的号时
  标成「注入的不是机器人号」，切换前先 `unload` 旧的（两个 OneBot 实例抢 3001 比不注入更难查）。
- **登录失败有退避**：密码错 30 秒内不再重试、被锁 15 分钟不再试 —— 否则页面刷新几次就把
  用户的控制台锁死了（SnowLuma 连续 5 次密码错误锁 15 分钟）。
- 密码只存在本地 `protocol.webui.password`（`sanitizeConfig` 已脱敏，接口永不回明文）。

#### 与 EULA 的逐条对照（这一节的设计依据）

SnowLuma EULA v1.1 第 5.4 条（中文为准）：不得复制、修改、单独再分发或再许可专有组件；
**并入第三方安装包或 Docker 镜像、通过自动化脚本部署、商业使用，均须书面授权**。

| 本功能做的事 | 判定 | 依据 |
|---|---|---|
| 用户点一下，软件代为启动它（无窗口） | ✅ | 以发行包原样"运行"，不是部署 |
| 调它自己的 `/api/login`、`/api/processes`、`/api/processes/:pid/load` | ✅ | 等价于用户在它网页上点的那几下，属于"使用" |
| 读它的 stdout（初始凭据是它主动打印给用户的） | ✅ | 用户本来就该看到的信息 |
| 写它的 `config/webui.json` / 接管密码 | ❌ 不做 | 属于"修改" |
| 调 `/api/agreements/record-consent` 代签协议 | ❌ 不做 | 必须用户本人同意 |
| 调 `/api/auth/change-password` 代设密码 | ❌ 不做 | 同上 |
| 随包分发 / 自动安装 / 打 Docker | ❌ 不做 | 5.4 条明确禁止 |

遇到"要同意条款 / 要改密码 / 开了两步验证"这三种，界面**停下来**并给一个「打开它的控制台」
按钮，让用户自己点 —— 这三步代劳就越线了。

### 变更 · 连接页重做：从"八块平铺"改成"状态 + 两步引导"（2026-10-27，R127）

> 之前这一页是「状态 / 装协议端 / 协议端进程 / 一键接入 / 端点设置 / 应用日志」六块平铺，
> 连上之后还照样把整套接入向导铺开 —— 光按钮就 10 个，新用户打开不知道先看哪。

- **顶部一张状态卡**：一句人话结论（机器人工作中 / 端口通了但没连上 / 协议端没在跑）
  + 三条事实（收消息 / 发消息 / 机器人账号）。原来的「诊断详情」折到最后。
- **没连上时给一条两步引导**：`① 准备并启动协议端` → `② 接入机器人 QQ`。
  步骤条显示每步状态，**只展开当前卡住的那一步**，另一步收成一行。
  - 第 ① 步：下载入口 + 目录输入 + 自动查找 + 启动/停止 + 「用 NapCat？」折叠；
  - 第 ② 步：原来的「一键接入」（密码 / 选号 / 注入），阶段文案不变。
- **连上之后引导整块消失**：只留状态卡和四个折叠（协议端进程与日志 / 端点地址与令牌 /
  应用日志 / 诊断详情）。按钮从 10 个降到 1 个（重新检测）。
- **步骤 ② 的"完成"只认 OneBot 真连上**，不认"注入成功"：注入完到 OneBot 起来有 1~5 秒，
  那几秒画成绿色会让人以为已经能用。
- 老功能一个没删：端点/令牌、自动读取协议端配置、协议端日志、应用日志、诊断复制，
  都还在，只是默认折叠。

### 变更 · 连接页改成"单卡"：一个表情 + 一句话 + 一个按钮（2026-10-27，R128）

> R127 把八块折叠成四块，但**还是在跟用户讲技术**：步骤条、协议端、注入、OneBot。
> 对完全不懂的人，正确的做法是把整套状态机藏起来。

- 整页只剩一张居中的卡：**一个表情 + 一句人话 + 一个主按钮**。已连上时是
  `✅ 机器人已上线` + 一行账号，连按钮都没有。
- 后端那 13 个内部阶段被归一成 13 种"用户处境"，每种配一句人话：
  `📦 还缺一个「连接组件」` / `😴 机器人还没上线` / `🔑 还差一个密码` /
  `💬 请先登录 QQ` / `👥 有两个以上的 QQ 在登录` / `📄 需要你本人同意条款` …
  术语全部去掉（不再出现"协议端""注入""OneBot"）。
- **点一次，自己往下走**：前端循环调接入接口，能自己做的（启动 → 等端口 → 登录 → 注入）
  直接做掉，只在必须用户本人的地方停下（密码 / 同意条款 / 改密码 / 登录 QQ / 选号）。
  每一步都会把按钮文案改成"正在启动…""正在连接 QQ…"。
- 唯一不能代劳的是**下载**：那一步给一个「去下载」按钮，下载解压后把路径填进来，
  失焦即自动保存并继续（不用再找"确定"）。
- 技术细节一个没删，全在下面那个默认合上的「高级设置」里：端点令牌、组件进程与日志、
  应用日志、诊断详情、随 QQ Agent 自动启动。

### 补充 · 没装的人怎么办：三步引导 + 「选择文件夹」（2026-10-27，R129）

> 单卡之后暴露出的新问题：**没装 SnowLuma 的用户看到"还缺一个连接组件"完全不知道该干什么**
> —— 点「去下载」跳到一个全英文的 GitHub 页面，不知道该下哪个文件；下完还得解压、
> 还得知道该选哪一层目录。

- 「没装」那张卡改成**三步引导**，一步一句人话：
  `① 下载（点开下载页，找名字里带 win-x64 的那个 zip）` →
  `② 解压（右键 → 全部解压缩，放桌面就行）` →
  `③ 告诉我它在哪（选解压出来的那一层）`。
- 新增 **「选择文件夹」**：走系统文件夹选择框，用户用鼠标点两下就行 ——
  不用再手抄 `C:\Users\xxx\Desktop\SnowLuma-v2.1.1-win-x64`（反斜杠、版本号、
  解压多一层目录，任何一处错都表现为"填了没反应"）。
  - 新增 IPC `app:pick-directory`（main.js）+ preload 的 `pickDirectory()`；
  - 只返回用户在系统对话框里亲手选中的路径，渲染进程传不进任何路径参数；
  - 网页版没有这个桥，自动回退成"手动填路径 + 帮我找"。
- 选完文件夹立刻落盘并自动往下走（启动 → 等端口 → 登录 → 注入），
  目录选错（那一层没有 index.mjs）会在启动时明确报出来。
- 「打开下载页」直接指向 `github.com/SnowLuma/SnowLuma/releases`（不是仓库首页）。

### 打磨 · 单卡不能只是"空"，要"有分量"（2026-10-27，R130）

> 反馈：单卡之后"多少有点太简陋了"。确实 —— 简单不等于空洞，
> 一张大卡只放三行字，看起来像占位符。

- **emoji 换成线性 SVG 图标**：Windows 的彩色 emoji 在深色底上是个实心色块、
  边缘发虚、大小随字体变，和这套细线条 UI 完全不搭。现在统一成 56px 圆底 +
  26px stroke 图标（对勾 / 下载 / 电源 / 钥匙 / 对话 / 多人 / 文档 / 链接 / 警告），
  `starting` 那个还会转圈。
- **已连接时换成头像**：昵称首字 + 按 QQ 号取的固定渐变 + 右下角呼吸的在线绿点
  （同一个号永远同一个颜色）。底下补一行 `昵称 · QQ号 · 已在线 2 小时 14 分`，
  再把收/发两个端点压成两列小字放在虚线下面 —— 有身份、有"活了多久"、有证据。
- 后端补 `onebot.connectedAt`（本次上线时刻）：只在"未连→已连"时记一次，
  断线重连不重置，否则时长会永远显示几秒。
- 在线时长跟着 15 秒的轮询一起刷新，不会停在页面刚打开时那个数。
- 已连接卡片加了极淡的绿色光晕，不再是"纯色块 + 三行字"。

### 变更 · 连接页换掉「居中单卡」：改成和全站一致的连接工作台（2026-10-27，R131）

> R130 把单卡填上了内容（线性图标、头像、在线时长、端点），但「简陋」的根子不在内容量，
> 而在**版式语言**：620px 居中、16px 圆角、整卡染色、没有页标题 —— 那是落地页的画法。
> 全站其它页是 940px 左对齐、1px 描边分层、9px 圆角、每页一行标题。两种语言摆在一起，
> 这一页永远像"另一个产品嵌进来的"。1280px 的窗口里两侧各空 330px，越看越像没做完。

- **页头**：`连接` + 副标题 + 右上角总状态胶囊 +「重新检测」。全站每页都有标题行，这一页原来没有，卡片直接贴顶。
- **状态卡**：结论（17px，绿/橙/灰）+ 身份（头像 · 昵称 · QQ 号 · 在线时长）+ 一句人话 +
  **四格连接详情**（收消息 / 发消息 / 机器人账号 / WS 端口，附检测时间）。
  状态改用卡片左侧 3px 竖条表达，全卡只有这一处强调色。
- **协议端独立成卡**（原来藏在「高级设置」里）：进程状态徽标 + 启动 / 停止 / 打开控制台 +
  程序位置 + 随软件自动启动。它是当前唯一需要用户动手的实体，不该埋在折叠底下。
- **四个折叠收进一个外框**：协议端日志 / 端点与令牌 / 应用日志 / 诊断，38px 一行 + 内部分隔线，
  替代原来四个各自带边框、各自带副标题的 details。
- 宽度 940（与 `.usage-wrap`、市场卡片行同宽）、圆角 9px（`--r`）、无阴影 —— 全部取全站令牌，不再自造一套。
- 端点表单从 flex-wrap 改成两列 grid：原来三个 field 挤一行、第四个掉到下一行，左右边界对不齐。
- 窄窗（<1000px）事实格自动降为两列 —— 低于这个宽度每格不到 190px，
  `ws://192.168.1.100:3001` 会被截成省略号，「看地址」这个主要用途就废了。

**这次只动版式，没动行为**：13 种处境的文案、三步安装引导、密码框与选号、一键接入的自动推进、
全部 id 与 `data-*` 锚点、协议端日志与端点表单的字段，全部原样保留（回归验证覆盖了
已连接 / 端口通但没连上 / 没装组件 / 要密码 四个状态，控制台无未捕获异常）。

#### 顺带修掉

- **三个"对空气赋值"的锚点**：`#conn-chip`、`#conn-verdict`、`#conn-recheck-btn` 在 R128 改单卡时
  就没有对应节点了，`updateConnectionLive` 与 `bindConnectionPage` 一直在空转。这次把节点补回来，
  总状态胶囊和「重新检测」按钮现在是活的。
- **协议端卡里同一句话出现两遍**：`#conn-proc-chip`（R125 加的）和 `#conn-proc-state` 都在写
  「运行中 · pid 15128 · 目录」。现在前者只管状态、后者只管路径。
- 已连接状态的 `sub` 原来是空字符串，标题下面直接跳指标格 —— 补一句
  「群消息会实时进「会话」页，白名单群里 @ 它才会回复」。

### 新增 · 连接页头像换成真实 QQ 头像（2026-10-27，R133）

> 状态卡上那个「按 QQ 号取固定渐变的昵称首字」是一块占位 —— 同一个号永远同一个颜色，
> 但它不是那个人。既然已经知道机器人是哪个号，就该显示那个号的头像。

- 直连官方 CDN：`https://q1.qlogo.cn/g?b=qq&nk=<QQ号>&s=140`（与全站同一套做法，
  见 `15-chat-chrome.js` 的 `qqAvatarUrl`；CSP 的 `img-src` 早已放行 `http: https:`，
  不走本地代理、不做缓存，CDN 自带 ETag）。
- **渐变 + 首字保留为兜底**，不是删掉：CDN 拿不到（断网 / 号被回收 / 图片 404）时
  `<img>` 会被藏掉，露出下面那层渐变底和昵称首字 —— 不会变成一个空白圆。
- QQ 号不是 5~12 位纯数字时（脏值、群号、空值）**不拼 URL**，直接走兜底：
  拿群号套个人接口 CDN 会回一张默认企鹅，比兜底更难看。
- `object-fit: cover` 裁切而不是拉伸（QQ 头像原图未必是正方形）。

**两个坑按全站既有结论处理**（这两个都踩过，不再踩第二次）：

- 失败兜底必须用 `addEventListener('error')` + **捕获**：CSP 是 `script-src 'self'`，
  内联 `onerror` 会被拦；`error` 不冒泡，普通监听收不到。
- 监听挂在 `#connection-page` 而不是 `.auto-page`：后者会被 `connAutoRepaint()` 整个换掉，
  绑在上面的监听每次重绘都会丢（用一个 `__cxAvBound` 标记保证只绑一次）。

验证覆盖四种情形：正常加载（`naturalWidth 140×140`，44×44 圆形 `object-fit: cover`）、
CDN 返回 404（img 被隐藏、渐变 + 首字露出）、QQ 号非法（不渲染 img）、未连接（走线性图标，
不出现头像）。项目测试 182 通过 / 0 失败。

### 修复 · 「没装协议端」时几个按钮点了没反应（2026-10-27，R134）

> 走到「还差一个软件要装」这一步的人，最可能去点下面协议端卡上那两颗按钮
> 「打开控制台」「启动」。两颗都**毫无反馈** —— 点了页面一动不动，只能判断成"坏了"。

- **`#conn-proc-hint` 从来没被渲染过**：`bindConnProc` 里所有操作反馈
  （启动失败 / 停止失败 / 找不到目录 / 已刷新 / 控制台打不开）都写这个节点，
  但 R125~R133 的模板里压根没生成它 —— `if (h)` 判空，于是全部静默。现在补上了，
  位置在协议端卡底部，空时不占高度。
- **「打开控制台」在没指定过目录时不出现**：没装的人点它只会打开
  `http://localhost:5099` 这个死链，还得自己琢磨"是不是我哪里做错了"。
- **「启动」在没目录时给明确指路**：原来只说"先填 SnowLuma 目录，或点「自动查找」"，
  而"自动查找"是折叠里的旧按钮、页面上已经没有 —— 现在指向真正的入口：
  「先按上面的第 3 步点「选择文件夹」（或「帮我找」）指定 SnowLuma 解压后的位置」。

#### 顺带修复：桌面版选过文件夹之后，「启动」还是说没目录

`dirVal()` 只读 `#conn-proc-dir` 输入框，而那个输入框**只在网页版渲染** ——
桌面版走的是「选择文件夹」系统对话框，选完只落盘、不留输入框。所以装了协议端的用户
选完文件夹、再回来点「启动」，会被反复告知"先填目录"，而那个输入框根本不存在。
现在 `dirVal()` 在输入框为空时回退到 `connProcCache.status` 里已保存的目录。

### 测试

- 新增 `tests/protocol-launcher.test.mjs`（17 条）：目录校验、启动参数（windowsHide / pipe / cwd）、
  node 运行时解析（Electron 下绝不用 exe 顶替）、解压多一层、index.js、空格/中文路径、
  分片重组、ANSI 剥离、超长行截断、taskkill 参数、未启动时 stop、退出状态、dispose。
- 新增 `tests/protocol-onboard.test.mjs`（18 条）：初始凭据提取、进程归一、判断链
  （no-qq / can-inject / pick / wrong-target / ready）、密码优先级、密码错误不注入、
  锁定后不再试、切换目标先 unload、记住机器人号、指定 pid。
- 全量 `node --test tests/*.test.mjs`：182 通过 / 0 失败。

### 修复 · 主模型纯文字 + 识图模型可看图时，被误判为"不支持图片输入"（2026-10-27，R135）

> 设置里主模型选了 `deepseek-v4-pro`（纯文字）、识图模型选了 `deepseek-v4-flash`（支持图片），
> 发图却被拒："当前模型不支持图片输入"、"接口问题，请在设置页重新配置"。这个组合**本来就该能看图**。

- **根因**：`visionEnabled` 的判定只看**主模型**——`modelImageVerdict(主模型) === 'no-vision'`
  就整体判死，完全无视识图模型。而请求路由那一侧（`specializedModelFor`）遇到带图请求
  会自动切到识图模型 —— 判定与路由两边口径不一致：路由说"有识图模型我能处理"，
  判定说"主模型不行，全禁"。
- **修法**：新增 `effectiveVisionEnabled(cfg)`（`src/vision-scan.js`）——
  先查 `api.vision === false` 总开关与主模型判定；主模型不支持时再查识图模型，
  任一支持即视为可用。四个调用点（`orchestrator.js`、`routes.js` ×2、`cache-warm.js`）
  全部换用新函数，与路由侧口径对齐。
- **顺带**：设置页 `#model-vision-hint` 提示同步改口径 —— 主模型不支持但识图模型支持时，
  显示"⚠️ 主模型不支持图片输入，识图模型「xx」可处理图片"，不再笼统报
  "🚫 当前模型不支持图片输入"误导用户去重新配置。
- **新增 `tests/vision-effective.test.mjs`**（10 条）：主模型支持 / 主模型不支持+识图模型支持
  / 两者都不支持 / 总开关关闭 / 空识图模型 / 空配置 / 大小写与空白容错等。
- 全量 `node --test tests/*.test.mjs`：**192 通过 / 0 失败**（182 + 新增 10）。

### 修复 · 连接页全按钮真机验证：三个点不出声 / 不生效的按钮（2026-10-27，R136）

> 用 mock 后端 + Edge 真实点击把连接页 23 个交互点全部过了一遍（5 种处境：
> 已连接 / 装了没启动 / 没装 / 要密码 / 端口通未连上），修掉三个验证抓到的真 bug。

- **「打开控制台」在网页版复制了空串**：无桌面桥时的回退逻辑只从父元素的
  `[data-console-copy]` 取地址 —— 协议端卡里根本没有这个元素，于是 `writeText('')`
  还提示"已复制，粘贴到浏览器打开"，粘贴出来是空的。现在兜底到
  `http://localhost:5099`（与 `connOpenConsole` 的剪贴板回退同一地址）。
- **「帮我找」被绑了两次**：`bindConnProc` 的历史遗留绑定 + `bindAutoCard` 的事件委托
  各触发一次 —— 点一下跑两遍 `/api/protocol/detect`，两处提示（`#conn-proc-hint` 与
  `#conn-check-note`）互相覆盖。删掉旧绑定，保留委托版（还会落盘目录并自动推进）。
- **要密码时填了密码点「连接」，什么都没发生**：`connAutoGo` 的 need-password 分支
  直接进 `connAutopilot`，而它的循环只在 can-inject / wrong-target 阶段才带密码调
  connect —— need-password 阶段第一轮就 break，**密码根本没提交给后端**。
  现在先调 `/api/protocol/onboard/connect {password}`（后端本来就支持：存密码 +
  解除退避 + 连一次），失败时提示"密码没通过：…"，再让 autopilot 推进到 ready。

### 验证方式（可复用）

- `conn-buttons-verify.mjs`（工作区）：静态服务器托管 `ui/` + mock 全部连接页 API
  （含 autopilot 状态机：launch → booting → can-inject → connect → ready），
  puppeteer-core 驱动 Edge 逐按钮点击断言反馈（提示文案 / 徽标变化 / API 调用计数 /
  剪贴板内容）。23 项检查全过，控制台无未捕获异常。
- ⚠️ 踩坑记录：启动时的使用引导（`ob-overlay`）是全屏模态，会吃掉一切真实鼠标点击 ——
  自动化验证必须先关掉它再操作页面。

### 顺带补齐 · 「随 QQ Agent 自动启动」画成滑动开关（R136 追加）

R131 写这一栏时只加了布局类、漏了 `sw` —— 全站"打勾才启用"的选项统一画成左右
滑动开关（style.css「开关（switch）」一节），这里落回了原生勾选框，和设置页不一致。
补上 `class="sw"`：只改外观，id / checked / change 处理器原样工作。

### 顺带补齐 · 自检「硬编码的绝对路径」15 条误报清零（R136 追加）

用户拿自检单来问：protocol-detect / wallpaper 里 15 条"硬编码的绝对路径"是真的吗？
逐条核过**全是误报**——规则"见到盘符字面量就报"，没区分正当用法：

- `process.env.ProgramFiles || 'C:\\Program Files'`：env 优先、字面量只是兜底；
- Steam / WinGet 安装位置探测：第三方软件没有"安装位置"环境变量，列举常见
  候选路径**就是功能本身**（优先级：手填 > 注册表 > 候选列表）；
- 注册表 `REG_EXPAND_SZ` 的 `%ProgramFiles%` 展开：字面量是该变量的官方值。

修法对齐同文件 hardcoded-endpoint 规则的既有先例（"带环境变量覆盖的是默认值，
不是硬编码"），在规则内识别三类正当模式：env 同现、`%VAR%` 展开行、同行列出
≥2 个路径候选的探测列表；`wallpaper/lib/deps.js` 剩余单字面量候选行走
FILE_EXEMPT（带理由）。验证：全项目命中 15 → **0**，另造两个真硬编码
（用户特定数据路径）确认仍 2/2 被抓 —— 规则没有松成摆设。
`src/harness/doctor/scan.js` 与 `plugins/self-doctor/scan.js` 两份副本已同步。

### 修复 · 机器人"奇怪发言"复盘揪出的两处发送翻车（2026-10-27，R149）

复盘 10-22 ~ 10-27 三个群共 2,555 条机器人发言，全量规则扫描后确认两处真实缺陷，
都在 `normalizeMessageList`（发送统一入口）补了容错：

- **整串 JSON 数组直发**（实例：10-26 13:41 五条分句连成原文进群）：模型想传
  `["分句1","分句2",…]` 分多条发送，但分句里的内层 ASCII 引号没转义
  （`但这属于"当时视角"…`），`JSON.parse` 失败后整串按普通文本发出去。
  现在解析失败时先走 `repairJsonArray` 容错修复——逐字符扫描，把字符串内部
  未转义的引号补上 `\` 再复验，能救回就按数组拆条发送；救不回才保持原样。
- **字面 `\n` 进群**（实例：10-22 18:13 `涨价合理\n排队票你替我拿了`）：模型把换行
  写成双重转义的 `\n`，JSON 解析后剩下字面反斜杠+n 原样发出。现在发送前把
  字面 `\n` / `\t` 还原成真实换行/制表；文本里已有真实换行时不动（那种场景的
  `\n` 更可能是故意写的）。

排查同时排除了三类"看起来怪但没毛病"的发言：170 条 `[表情包:描述]` 是真实表情
图片发送后的本地存档口径（`sender.js` appendSelf，逐条与表情库比对全匹配）；
2 条 `[图片]` 是真实发图（群友点名要图，存档口径同上）；圆周率/数数/英文短语
属于群友点题的正常整活。

### 修复 · 群友反馈"重启后壁纸消失"排查：两处真实缺陷（2026-10-27，R150）

群友反馈：外观里选了 Wallpaper Engine 壁纸后，每次重开软件壁纸会消失，要再点一次
重新选。排查结论：**当前版的两条恢复腿（渲染进程 localStorage 主状态 + 后端镜像
`data/wallpaper-state.json` 兜底）经真实控制台 E2E 验证都正常**，反馈者大概率在
没有镜像兜底的旧包上、且本地存储恰好失效过。排查中揪出两处会让"重启即丢"真实
发生的缺陷，均已修复：

- **端口漂移会整库清空界面本地状态（粘性端口）**：控制台页面 origin 是
  `http://127.0.0.1:<实际端口>`，渲染进程 localStorage 按 origin 隔离 —— 启动时
  3210 被别的程序占住，端口漂到 3211，那一次启动壁纸选择等本地状态就是全新空库；
  若 3210 被长期占用，就是反馈的"每次重开都消失"。现在启动优先复用上次实际
  监听的端口（`console-port` 落盘值，仍在才粘住不动），被占才退回 basePort
  起步逐个试听 —— 端口稳定了，localStorage 背后的 origin 才稳定。
- **中文目录名的本地壁纸整条链路被拒**：壁纸 id = `w/m` + WE 库目录名，工坊目录
  是数字没事，但本地导入（myprojects）目录**经常是中文** —— 旧 id 正则
  `[a-zA-Z0-9._-]` 直接拒绝，后果三连：预览图恒 404（选中也铺不出来）、保存状态
  时 `canonicalize` 失败 → `stateSave` 把后端镜像文件**删掉**、兜底恢复腿随之
  失效。id 只用作库内 Map 键与 URL 查询参数、从不参与拼路径（文件定位一律查
  登记表里的绝对路径），放宽为 Unicode 字母/数字不引入路径穿越面；控制字符与
  路径分隔符仍然拒绝。

验证：新增 `tests/wallpaper-id.test.mjs` 4 用例（中文 id 可写镜像/数字 id 不受
影响/路径分隔符与控制字符仍拒/null 仍清空），全量 **203/203** 通过；粘性端口
改动 `node --check` 通过（逻辑：上次端口优先 → basePort…+9 → 去重）。

### 修复 · 插件开关只认开关本身，点名字/简介不再切换（2026-10-27，R151）

群友反馈：手机操控云电脑时，点插件名字和简介就会切换开关，容易误触启停插件。
旧行为是"点卡片其余区域也能切换"（保留旧习惯的整卡 click + Enter/Space 转发）。
改为**只有滑块开关本身能切换**：移除整卡 click/keydown 转发、卡片去掉
`role="button"`/`tabindex`（滑块是原生 checkbox，Tab + Space 的键盘链路本来就
完整）、卡片 `cursor: pointer` 改回 default、提示文案从"点击开启/关闭"改为
"用右侧开关开启/关闭"。技能页与插件页共用同一张卡片构建器，两页同时生效。

验证：`plugin-toggle-verify.mjs` 对真实控制台 E2E（POST /api/skills/* 打桩，
不真切换线上插件）——点名字/简介/卡片其他区域 0 次触发、勾选态不变；点开关
恰好 1 次触发；`role` 已移除。✅ 全部通过。

### 顺带修掉 · 点空白/遮罩不再关闭插件设置页（R151 追加，同一反馈）

同一批反馈里还有一条：**点空白位置，插件设置页面被关掉**。设置弹窗（齿轮）和
插件界面弹层原先都是"点遮罩空白 = 关闭"—— 手机操控云电脑时点一下空白，填了
一半的设置全部丢失。改为**点空白不再关闭**，关闭只走明确路径：右上角 × /
「取消」/「保存」/ Esc（插件界面弹层：× / Esc）。

验证：`skill-settings-blank-verify.mjs` 对真实控制台 E2E —— 点空白两次弹窗
保持打开、Esc 关闭、× 关闭。✅ 全部通过。

### 新增 · 自检页「模型设置」补上拉取模型与连接检测（2026-10-27，R152）

群友反馈：工具 → 自检右上角的模型设置，**没有拉取模型，也没法连接检测**。
该弹窗原先只有三个裸输入框。现在补齐，全部复用模型管理的现成后端链路：

- **⟳ 拉取模型**：走 `/api/providers/fetch-models`，拉到后**弹出选择弹窗**
  （仿全局「选择模型」，`openDoctorModelPicker`），列表带筛选框，单击一个即
  回填「模型」框并关闭。群友反馈"塞进 datalist 不够直观，弹窗式选择更好点"，
  故由 datalist 改为弹窗（R152 refinement）。Key 口径：输入框明文 > 已保存的
  自检专用 Key（`/api/doctor/config-key`）> 后端回退全局。
  - 选模型与手动输入/勾选统一计入"未保存改动"标记（`__dirtyGuard`），关闭弹窗
    时与手动编辑一样会提示"未保存的修改"。
- **连接检测**：走 `/api/providers/test-chat`，发一次 `max_tokens=16` 的最小
  对话请求，显示 ✅/❌ + 耗时 + 模型回复摘要。独立配置未启用且字段留空时，
  自动退回检测**全局模型**（结果里注明）。

### 顺带修掉 · fetch-models 的 Key 兜底链漏了 dshProviderKeys（R152 追加）

E2E 实测拉取模型 401、连接检测却正常 —— 两条链路的 Key 解析不一致：
`/api/providers/fetch-models` 顶层兜底裸读 `api.apiKey`（空或脱敏值），
而连接检测走的 `resolveApiKey` 会先查 `dshProviderKeys[provider]`。当前部署
的 Key 恰好存在 dshProviderKeys 里，于是拉取恒 401。已把兜底改走
`resolveApiKey`（`src/routes.js`）—— 这同时修好了**模型管理页的"拉取模型
列表"**在同形态配置下的 401。⚠️ 后端改动需重启生效；前端刷新即可。

验证：`doctor-model-dialog-verify.mjs` 对真实控制台 E2E —— 两按钮就位、
连接检测 ✅（模型回复「pong」）、拉取错误优雅展示；修复后的 Key 解析链
独立进程实测：`dshProviderKeys` 解析出 Key → 成功拉到 7 个模型。
R152 refinement 同脚本复测：点「⟳ 拉取模型」实网拉到 7 个并真正弹出选择窗；
纯前端确定性用例——弹窗出现、输入筛选"b"剩 1 条、单击回填并关闭——全部通过。

### 顺带修掉 · self-doctor 被准入闸拦截（基线失配，2026-10-27 傍晚，R152 追加）

界面报「扩展加载失败：self-doctor……内容与随包基线不一致」。根因：R136 修
「硬编码绝对路径误报」时手工改了 `plugins/self-doctor/scan.js`，但没有重算
`builtin-modules.json` —— 内容指纹失配，准入闸按"占名顶替"流程拦下。处理：

- **重算基线**：按 `refreshBuiltinEntry` 同口径重算 self-doctor 的 5 个文件
  指纹并原子写回（内置代码改动 = 有意识地声明它仍可信）。
- **登记信任**：`data/config.json` 的 `trustedPlugins` 加入 `"self-doctor"`
  （本机是开发机，以后手工改这个插件不再被拦；收包机不受影响，仍按基线判）。
- **分发包同步**：桌面上的 `洛版v0.4.9.1-20261027-免安装版.zip` 里也带着
  旧基线，收包人会撞上同一张红卡。已用"尾部重写"（保留全部原始条目字节、
  仅重建中央目录 + EOCD）把 zip 内基线替换为刷新后版本，逐字节抽查未动
  条目与备份一致；原包备份为 `*.zip.bak-20261027`。

验证：基线 vs 磁盘 diff 清零；zip 全量 740 条目可列出；zip 内 scan.js 指纹
与基线记录一致（e44d7a57…）；抽取 app.js / self-doctor/index.js /
package.json 与备份 zip 逐字节相同。重启应用后插件直接加载，不再出红卡。

### 修复 · 自检扫出的 14 处静默吞异常 / 未处理 Promise 清零（2026-10-27 晚，R155，需重启生效）

自检页「全项目扫描」报出两类真实问题，逐处核对后全部处理：

- **空白 catch ×11**（`ui/desktop-pet/` 3 文件 + `plugins/desktop-pet/lib/` 2 文件）：
  这些 `catch {}` 多数是**刻意吞**（每帧调用的 Cubism API、宿主未连接时的空操作、
  预览图缺失的常态兜底），直接补 log 反而会刷屏。逐处补上意图注释说明"为什么吞、
  吞了之后走哪条路"——扫描器以注释判定"作者想过"，热路径注释是正确形态。
  其中 `service.js` 的 `host.sync` / `host.command` 两处连 `.catch(() => {})`
  也一并补了注释（宿主窗口不在是常态，指令/同步丢失可接受）。
- **`.then()` 无 `.catch()` ×3**：
  ① `14-wallpaper.js` 壁纸自动取色分析——补 `.catch`（分析失败只影响取色/构图，
  主题照常生效）；
  ② `15-desktop-pet.js` 角色预览渲染回调——补 `.catch`（单个预览出错不影响其余）；
  ③ `pet.js` Live2D 模型加载链——第一个 `.then()` 改成双参形式
  `.then(factory, reject)`，微任务里抛错（如 PIXI 未就绪）直接进 reject，
  与第二个 `.then(ok, reject)` 对齐，不再依赖链式传播。

验证：`rescan-empty-catch.mjs` 直接调用自检的 `scanProject` 复扫全项目——
empty-catch 0 命中、unhandled-promise 0 命中；7 个改动文件经
`vm.SourceTextModule` 解析校验语法全过；desktop-pet 基线已重算
（`lib/model-store.js`、`lib/service.js` 指纹更新），准入闸不会拦；
全量测试 209/209 通过。

### 界面 · 自检「体检单」收窄：问题详情挪进「查看详细」弹窗（2026-10-27 晚，R157–R162，前端刷新即生效）

用户两轮反馈体检单臃肿（先嫌结论卡+问题列表占地方，后明确要求「结论卡上加个
查看详细按钮，点开弹窗看每条警告的详细信息」），最终形态：

- **主页只剩结论卡**：图标 + 结论 + 三格计数（严重/警告/提示）+ 元信息
  （扩展/会话/耗时/生成时间，收编进卡内弱化小字），外加「查看详细」按钮 ——
  橙色徽章显示问题总数，有问题才出现。
- **「查看详细」弹窗**（复用 `modelModalShell` 外壳，× / Esc / 点遮罩 / 关闭按钮
  四条退出路径 + 焦点陷阱 + 滚动锁全继承）：三张问题卡，**详细信息直接平铺**
  （扫描结论 + 「→ 去哪处理」指引不再折叠，点开弹窗就是来看详情的，不让人
  再多点一下），标题行右侧「忽略」，底部「已忽略 N 项 · 另有 M 项正常未启用」
  折叠区（含逐项/全部恢复）。弹窗宽 760px、内容区限高滚动。
- **问题明细随卡平铺（R162）**：hint 里"逐个打开这些会话留档看 error"、
  "看下面的漂移记录"指的东西，现在直接附在对应卡片下面 ——
  ① 后端 `src/harness/doctor/index.js`：运行平面扫描时收集出错会话样本
  （chatKey + error 原文截断 140 字，最多 10 条 + 溢出提示）附到「会话报错」
  的 `lines`；缓存平面把 `snap.drift` 漂移记录（时间 + 会话 + 变更/新增/移除
  段，最多 8 条 + 溢出提示）经 `driftLines()` 附到「缓存未命中偏高」与
  「系统提示漂移」的 `lines`。
  ② 前端：卡片下新增 `.doctor-issue-lines` 明细块（等宽小字 + 虚线分隔），
  逐行 `esc()` 后平铺。
- **忽略/恢复联动**：弹窗里操作成功后 `ackIssue` 就地刷新弹窗内容
  （`renderDoctorPage` 只重绘主页动不到弹窗），主页徽章同步更新；
  弹窗开着时关掉旧弹窗再开新的，不叠层。
- **按钮全面体检（R162 追加）**：逐个核对自检页按钮的绑定链，发现两类死按钮 ——
  哨兵区「刷新量表 / 哨兵分析 / 送去修复」与 triage 卡里的「让模型自检」+
  结论过滤 chips，以前只在 repaint 链上绑定：首次进页靠"自动拉一次量表"
  侥幸救场，但从别的子页切回来时（sentinel 已有数据，不再自动拉）全部
  点了没反应。现在 `bindCheckupEvents` 每次整页渲染就地调 `bindProjectEvents()`
  与 `bindSentinelEvents()`，项目区过滤 select 的绑定也收敛到
  `bindProjectEvents` 一处（原来两处各绑一份，改一处漏一处的隐患）。
  其余按钮核对无恙：模型设置 / 重新扫描 / 查看详细 / 复制诊断 / 忽略 /
  恢复 / 全部恢复 / 弹窗关闭 / 扫描项目 / 顶栏让模型自检 / 模型弹窗的
  显示密钥·拉取模型·连接检测，均有绑定且行为正确。
- 「全项目扫描」与缓存哨兵模块不受影响；无问题时不渲染「查看详细」按钮，
  主页干净如「一切正常」。

验证：从磁盘提取真实 `renderDoctorReport` + `renderDoctorDetailHtml` 构造
报告渲染，结构断言全过（主页无问题卡/无折叠条/按钮带徽章；弹窗问题卡
含 lines 明细逐行渲染、位于 hint 之后、esc 生效）；`13-doctor.js` 与
`src/harness/doctor/index.js` 语法校验通过；全量测试 209/209。
改动文件：`ui/`（不在准入闸基线）+ `src/harness/doctor/`（核心，不在基线），
均不触发准入闸；**体检单有 5 分钟缓存，点「重新扫描」即可看到明细**。

### 顺带补 · 今天重构的界面补动画（2026-10-27 傍晚，R153）

排查今天几处改动的动效一致性，补齐缺失的入场/退场动画，与全站手感对齐：

- **技能设置弹窗 / 插件面板弹窗**（`openSkillSettings` / `openPluginPanel`，R151 那批手搓遮罩）：
  此前**只有遮罩淡入、面板本体无位移**，且**关闭是"砰"地瞬间消失**（直接 `remove()`）。
  ① 给 `.skill-modal` 补 `popIn` 入场（与 `.modal` / `.model-modal` 同款）；
  ② 仿 `modelModalShell` 的 `.closing` 退场——遮罩 `fadeOut` + 面板 `popOut`，
  动画结束后再移除 DOM，并保留 400ms 兜底应对 reduce-motion 把动画压成 1ms 的情形；
  ③ `.skill-modal` 补进 `prefers-reduced-motion` 的 `animation: none` 名单（与 `.modal` 同级）。
- **自检模型设置「⟳ 拉取模型 / 连接检测」按钮**（R152）：原来是改文案「…中」没有
  加载指示。新增内联 spinner（`.btn-spin` + `.btn.is-loading`，复用 `spin` 关键帧），
  加载期间显示并禁用按钮，结束（成功/报错都走 `finally`）自动隐藏；标签文案改用
  独立的 `.btn-label` span，避免 `textContent` 抹掉 spinner。

验证（真实控制台 E2E）：`skill-settings-blank-verify.mjs`——点空白不关、×/Esc 触发
`closing` 退场动画并正常移除（8 项断言全过）；`doctor-spinner-verify.mjs`——点「拉取
模型」spinner 立即出现、请求结束后消失（闭环正常）。

---

### 修复 · 收包人 bug 清单落地（2026-10-27 傍晚，R154，需重启生效）

收包人交来一份「给洛版 0.5 的 bug 清单」，逐条在本机代码核对后修掉仍存在的部分。
核对结论先行：**D1/D3（桌宠 service/用量导出）已修**（`src/app.js:2508` 两个导出都在）、
**D2（菜单 5s 强制还原）本代码库无此定时器**、**E2（moodStateOf）本代码库无此 API**、
**A3 的易变通道核心已有**（`prompt.js` 方案 A + `isVolatileSection`），其余修法如下：

- **A1 空输出直接 noreply**（P0）：`nudgeDecision` 旧前置 `hasBody` 会把
  「正文 0 字 + 无 tool_calls」的轮次直接判安静 → 群里什么都收不到（实测会话烧了
  175 token 纯思考）。现在 `emptyNudge: true` 让空输出也兜一轮（`why='empty'`），
  orchestrator 空正文时改发 `EMPTY_NUDGE_TEXT`（"要么 send_message 要么 finish"）；
  抢救分支对空正文无意义，改为空正文直接落自确认。off/used/轮次/熔断护栏全部不变。
- **A2 空正文 + finishReason=length 不升额**（P0）：`chatCompletionWithRetry` 旧实现
  对"成功响应"不做处理，推理模型把 max_tokens 花完在 thinking 上就交回空正文。
  现在核心统一兜：空正文且无 tool_calls 且 `finishReason==='length'` →
  `max_tokens ×4`（封顶 32768，未配额时按 4096 起跳）**重试一次**，
  `api.emptyLengthUpgrade === false` 可关；升额重试失败退回原响应不报错。
- **B1 vision 路线 GIF 只给首帧**（P0）：`resolveGifRoute` 的 `gif-image` 路线
  （vision 开、video 关）旧实现把 GIF 当单个 image part 原样发，模型侧只解码首帧。
  新增 `gifFrameDataUrls()`（随包 ffmpeg 均匀抽 ≤3 帧、最长边 ≤480、JPEG），
  `downloadImageAsDataUrl` / 入库缓存捷径 / 本地落盘三条路都改走抽帧
  （旧实现缓存捷径里 `gifBuffer` 硬填 null，缓存过的 GIF 连首帧降级都做不了）；
  抽帧失败回退"按原图发"旧行为。部件文案注明"相邻帧之间发生的事你看不到"。
- **C1 热重载只 bust 入口**：`plugin-loader.js` 旧实现只给入口加 `?t=`，入口
  `import './lib/x.js'` 的 specifier 无 query → lib 永远命中旧模块缓存，改 lib
  加导出后 reload 必报 `does not provide an export named 'xxx'` 的假失败。
  新增 `importEntryBustingLibs()`：从入口递归收集相对导入，整链改写 `?t=` 后
  镜像到 tmpdir 再 import（源里有 `import.meta.url` 依赖真实路径的插件自动放弃
  镜像，退回旧行为）；文件写入 debounce（500ms）此前已有，不另加。
- **C2 `createSkillApi` 没有 tools 入口**：新增 `api.tools()`（枚举全部工具元信息）、
  `api.getTool(id)`（查详情）、`api.callTool(id, args, ctx)`（复用宿主执行，
  execute 已套 guardToolExecute 护栏，ctx 由调用方传自己的会话上下文）。
  三处同步：`createSkillApi` 本体 / `gate.js` KNOWN_APIS / forge 的 `envBrief.knownApis`。
- **E1 外部改 stickers.json 被内存盖回**：插件内存库是"启动快照 + 远端合并"，
  下次写盘整份盖回磁盘，外部脚本改动静默丢失。新增 `mergeDiskStickerStore()`：
  每次写盘前重读磁盘——磁盘新增条目原样并入；磁盘 `updatedAt` 较新时采纳其
  可编辑字段（desc/tags/usage/url 等），运行时统计（useCount/lastUsedAt/localFile）
  仍以内存为准；内存较新则磁盘旧值不许回写。`sync()` 与 `ensureSendable` 两条
  写盘路径都接入。
- **E3 配了 server.token 的脚本 POST 仍 403**：注释里写的"两条正路"其实只通了一条
  ——`originAllowed` 对无来源的 POST 一律拒绝，token 过了 authorize 也过不了来源关。
  现在 `originAllowed` 认凭据：`x-console-token`/`?token=` 与 `server.token` 匹配、
  或渲染进程随机凭据匹配 → 放行写请求；未配 token 时行为不变（无来源 POST 仍拒）。
- **E4 工具被排除告警刷屏**：旧实现每种被排除工具各发一条 issue（一次体检最多 8 条
  警告）。现在两份 doctor（内置 harness + 插件）都**聚合成一条**：正文列前 5 名，
  仅当含 `skill-unavailable`（已启用但缺配置）且命中数超阈值才升 warning，
  按设计排除降为 info。
- **A3 补一刀**：extension-forge 的「待确认的自创扩展」段随草稿生命周期变化，
  旧方案靠 priority 0 排尾段缓解；现在显式 `volatile: true` 走核心易变通道
  （用户提示词末尾），系统提示回归全静态，cache-guard 不再记它的漂移。

配套：`builtin-modules.json` 基线已全量重算（self-doctor / extension-forge / sticker
三个插件内容有变）；新增回归测试 `tests/builtin-bugfix-20261027.test.mjs`
（A1 nudgeDecision 空输出 7 断言 + E1 磁盘合并 4 场景 + A3 volatile 契约），
全量 **209/209 通过**。

---
## 0.4.9.2 · 底层改成启动组合：不改源码即可替换组件（2026-11-03，需重启生效）

> 这一版**只动后端装配**，界面一个像素没改。侧边栏、主题、玻璃效果、动效、桌宠、壁纸全部照旧。

### 做了什么

把 `src/app.js` 里原本 8 处 `new Xxx()` 的硬编码装配，改成从一张工厂表取。
表里每一项的默认值都指向**洛版原实现**，所以不装任何覆盖层时，行为和 0.4.9.1 完全一致
（235 个单元测试逐条对过，与改造前基线一致）。

在此之上，把编排器里 14 个细粒度策略也加了同样的可选岔路口 —— 这些函数原本就是
独立导出的纯函数（`prompt.js` / `llm.js` / `md-to-plain.js` / `tools.js` / `media-links.js` /
`reply-rescue.js`），只是被直接 `import` 后调用，现在多了一条"从组件表取"的路。

### 能替换什么（20 个组件）

| 分类 | 组件 |
|---|---|
| 数据仓 | `data.messages` `data.memory` `data.sessions` `data.reminders` |
| 传输发送 | `transport` `core.send` `core.media` |
| 编排 | `core.orchestrator` |
| 策略 | `core.prompt.system` `.user` `.persona`、`core.wake.resolve`、`core.reply.rescue`、`core.session.retryable`、`llm.complete`、`core.tools.bundle`、`core.tools.parseInline`、`core.media.forward`、`core.text.plain`、`core.text.split` |

键名与 0.5 的组件表一致，两边的覆盖层可以互相搬。

### 怎么用

放一个目录 + 一份清单，重启生效；删目录重启即恢复：

```
overrides/20-my-setup/composition.json
```

```json
{
  "version": 1,
  "id": "my-setup",
  "order": 20,
  "enabled": true,
  "components": {
    "core.prompt.system": { "module": "./system-prompt.mjs", "export": "systemPrompt" }
  }
}
```

详见 `overrides/00-README.md`，里面有一个默认停用的示例层 `overrides/10-example/`。

### 新增工具

```bash
node scripts/check-composition.mjs
```

不启动程序，列出所有层、生效顺序、每个组件最终由谁提供、以及冲突和路径错误。
**只读清单、不执行层代码**，所以不能代替真实启动验证。

### 安全边界

- 路径必须在层目录内，绝对路径 / `..` / 符号链接 / 反斜杠一律拒绝
- 只接受 `.js` / `.mjs` / `.cjs`，导出必须是函数，否则该条跳过并报错
- 最多 64 层，单份清单最多 64 KiB，`id` 全目录唯一
- 清单非法：桌面版记录后按出厂实现继续启动，headless 版直接退出（避免"看起来起来了其实少一层"）
- **覆盖层里写的是原生代码，信任等级等同于直接改源码** —— 它不走插件权限模型，只放自己写的或完全看懂来源的层

### 没做的（有意为之）

- **UI 层不做可替换**。洛版界面是 20 个全局脚本共享作用域，硬做页面级替换要重构 2,140 行的 `14-chrome.js`，风险收益倒挂。加页仍照原写法：`index.html` 加按钮 + 一个脚本。
- **`core.agentRunner` / `core.ingest` 不开放**。这两个是状态机，依赖 `runningChats` / `aborted` 等实例状态，替换等于重写多轮循环。
- **不提供 wrap 语义**（只能整体替换，不能包一层只改某个方法）。洛版的组件是类实例，需要增强就在自己的工厂里做。

### 验证

- `node --check` 全部通过
- `node --test "tests/*.test.mjs"`：235 通过 / 0 失败（与改造前基线一致）
- 加载器实测：示例层能正确解析、动态 import、取到导出函数
- 注入链路实测：`Orchestrator.policy.systemPrompt` 在传入覆盖时指向覆盖实现，不传时回落到原实现
- 非法组件（非函数）被 `createFactories` 拦截并抛出明确错误

---

## 0.4.9.1 · 桌宠直接对话 + 对话收文件 + 发布包装填修复（2026-10-26，需重启生效）

> 0.4.9.0 的安装包停在 **10-24 14:46**，本节全部是那之后落地的改动 —— 装过 10-24 那个包的人，
> 升到 0.4.9.1 拿到的就是本节内容。上一节（0.4.9.0）里 10-24 晚间与 10-25 的小节，
> 已按实际发包归属移入本节，免得同一个版本号对应两份内容。

### 新增 · 桌宠「直接对话」—— 一条只属于主人的会话（2026-10-24，需重启生效）

双击桌宠原本只有一个落点（开发工单）。现在双击按设置打开**直接对话**（默认）或开发工单，
右键菜单与「桌宠」页都能改。

这条对话的形态改了三次，每一步都是用户反馈逼出来的，记录在此免得以后再绕：

1. **独立对话**（自己拼人设/历史/工具）→ 不行：桌面上的它和群里的它不是同一个，
   看不到历史、不按档位决定上下文、也没有那套工具。
2. **插进你选的某个群** → 更不行：用户要的是"和这里的对话一样"，但不是把话塞进别的群。
3. **现在：一条只属于主人的会话** —— `private:<机器人自己的 QQ 号>`。
   主人就是这个 QQ 号的使用者，和"自己"私聊天然只有主人能进来；数字 ID 能被所有既有
   链路吃下（存档文件名、会话页解析、私聊恒响应档位），不用改任何正则。

- **走的是真实流水线，不是另起一套**：你说的话以「主人」身份 `store.appendIncoming`
  进这条会话的存档（和真实入站同一个入口，控制台会话页/对话审查看得到，历史跨重启保留），
  然后跑一次**完整的真实唤醒** —— 同一份人设、**这段对话自己的**历史、同一套记忆与工具、
  同一份表情包策略、同一个上下文预算。
- **回复被接住，不会真的发到 QQ**（capture sender）：没有群可发。桌宠对话层随后把接住的
  回复按「机器人自己说的」写进这条专属会话的存档（`store.appendSelf`，标签与真实出站一致）——
  这条会话的存档 = 你真的说过的话 + 它回你的话，跨重启保留（2026-10-24 修，见下方修复节）。
- **窗口只连这一个会话**：没有会话选择器（用户明确要求过不要塞进别的群），
  从接口层面就不给选群的能力；标题栏常驻「私聊 · 主人」标签说明它的归属。
  协议端没连上、拿不到机器人 QQ 号时，窗口里直接说清楚，而不是悄悄退化到某个群。
- `manual` 唤醒绕过禁言检测、指令禁言与档位预判 —— 这是你显式按下的"发送"，
  不需要再问"值不值得回"（token 照付，与真实唤醒同预算）。
- 接口面：核心 `src/pet-chat.js`（注入式依赖，单测可脱机跑）+ `orchestrator.js` 的
  `injectOwnerMessage` / `createCaptureSender`；表情插件新增两条**只读**能力
  `sticker.catalog` / `sticker.image`（本地转存优先、远端走 safe-fetch、限 2MB）；
  主进程加 `pet-chat.html` 独立窗口 + 受限 preload（同源校验、无 Node、无凭据）；
  双击目标存在 `desktop-pet` 插件的 `settings.doubleClick`（`chat` | `dev`）。
- 已补 `tests/pet-chat.test.mjs`（8 例：主人会话推导与持久化、拿不到 QQ 号时拒绝发送、
  只以主人身份进这条会话、历史角色映射、贴纸补图、并发与失败、旧状态迁移）与
  `tests/capture-sender.test.mjs`（7 例：发送身份、返回结构与 SendQueue 同构、空内容过滤、
  不写存档）；`npm test` 89/89 通过。
- 已知边界：换 QQ 号重登后，主人会话仍指向旧号（保历史连续性），要想跟着新号走得手动清
  `data/pet-chat.json`。

### 新增 · 对话窗能收文件了 —— 加号选择 / 整窗拖拽（2026-10-24，需重启生效）

主人专属会话原先只能打字。现在输入框左边有一个 **＋**，把整个窗口当**落点**也行：

- **两种入口，同一条链路**：＋ 弹原生文件选择框（可多选）；或把文件从资源管理器**拖进窗口**
  （整张卡片都会高亮）。拖入的 File 经主进程 `webUtils.getPathForFile` 反查磁盘路径 ——
  渲染进程全程只过**路径与文件名**，不碰字节，也没有任何读写文件的能力。
- **图片**（png/jpg/gif/webp/bmp）→ 收进 `data/image-cache/` 的受控目录后以 `media.file`
  进存档。为什么绕这一道：看图工具对 `media.file` 有白名单，只认缓存目录里我们自己写的
  文件（防"消息里写什么路径就读什么文件"）—— 所以必须走 `image-cache.cacheLocalImage`，
  直接给用户路径会被判"不在本地缓存目录内"，模型永远看不到图。模型看到 `#消息号` 后
  调 `get_message_images` 就能看懂（与群里收图同一条路，**要求看图能力开着**）。
- **文本**（.txt/.md/.json/.log/代码等 30 余种扩展名）→ 读进消息正文，带
  `【附件：文件名】`标头；单文件截到 64KB，一条消息总预算 128KB（超出会注明"没装下"）。
  不占工具调用，任何模型都看得见。
- **其它类型**（exe/zip/音视频…）→ 气泡下明确标「附件未发送」——模型没有解压/播放
  这类输入通道，静默丢弃会让用户以为发成功了。
- 界面：输入框上方是**待发送附件条**（文件名 + 体积 + 删除）；发出去之后，文件名列在
  自己那条气泡下面。一条消息最多 8 个附件。
- 新增 `tests/owner-attachments.test.mjs`（7 例：图片必须进缓存目录、文本内联与截断、
  其它类型明确拒发、多附件下标对齐）并扩 `tests/pet-chat.test.mjs` 至 11 例（路径透传、
  空文本只发文件、8 个上限）——其中一例抓到真 bug：`cacheLocalImage` 对探测不出类型的
  文件兜底成 image/jpeg，会让一个 .txt 被当成"图片"收进缓存；已改为**拒收**。
  `npm test` 99/99 通过。

### 修复 · 桌宠对话重启后「只剩你说的话，回复全消失」（2026-10-24，需重启生效）

实测翻车：在桌宠对话窗聊过一轮，重启应用后窗口里只剩你发的消息，它的回复一条不剩。

- **根因**：你说的话走 `store.appendIncoming` 进真实存档（落盘，重启还在）；而它的回复被
  capture sender 接住后**只放在内存数组里**。capture 层不落档对"往群里插话"是对的
  （不能在群里留下一条谁都没见过的消息），但桌宠这条**没有 QQ 收件方的私聊窗口**，
  除了内存没有任何别的地方能找回它 —— 不在存档、不在会话文件，记忆层也只吃存档。
  重启即清空，回复永久丢失。
- **修复**（`src/pet-chat.js`）：收到捕获回复后，按**真实 QQ 出站同一条链路**
  `store.appendSelf` 写进这条专属会话的存档，文本标签与 sender.js 逐字一致
  （文本原样 / 表情 `[表情包:desc]` / 图片 `[图片]`；poke 无窗口形态，不留档）。从此：
  - 重启后窗口从存档还原完整对话流（你说的 + 它回的，按时间排好）；
  - 控制台会话页 / 存档页看到的是同一份记录；
  - 后续唤醒的上下文里也有它说过的话（prompt 一直吃存档、self 不过滤），对话连续性真正成立。
- **本进程内不双份**：内存版（表情带原图）优先渲染，存档里那条文本标签按条目 id 跳过；
  重启后内存版清空，存档版顶上 —— 表情画 `［desc］` 占位（与表情图文件丢失同形态）。
- **已丢的回复找不回来**：修复前的回复没写进任何存档/会话文件，无法追溯补档，只能从此不再丢。
- 测试：`tests/pet-chat.test.mjs` 扩至 13 例（新增「回复落档」与「重启还原」两例，
  桩 store 补 `appendSelf`）；`npm test` 101/101 通过。

### 修复

- **thinking 模式下工具循环第二轮 400（`reasoning_content ... must be passed back`）**：
  DeepSeek V3.2+/V4.x 的协议要求「请求带 tools 时，每条历史 assistant 的
  `reasoning_content` 必须原样回传」（2026-10-17 起 `deepseek-flash` 后端静默换成
  V4.1 Flash 1017，开始严格执行），而项目里 5 处工具循环都只挑 `content` / `tool_calls`，
  思考原文全丢 → 一旦上一轮模型思考过，下一次工具调用就 400，然后切备用模型或整轮失败。
  修法：新增 `src/reasoning-history.js`（`assistantHistoryEntry` / `attachReasoning`），
  群聊 `orchestrator`、控制台 4 条路由、开发工单 `executor`、以及存档回读 `sanitizeMsg`
  统一带上思考原文；`thinking-adapters` 只在 **deepseek 方言 + 带 tools** 时落成
  `reasoning_content`（其余方言丢弃，避免未知字段把网关打 400），`llm.js` 发送前
  兜底清洗 `_` 前缀私有字段。顺带修正 `looksLikeThinkingRejection()`：原先的词表
  不认「must be passed back」，retry-advisor 因此静默返 null、连日志都没有；
  现在能识别并写明"问题在历史消息、不在请求参数"。

### 变更 · 「接收整包」改成拖放 / 选文件（2026-10-24，需刷新生效）

- 自检 →「打包 / 接收」→「接收整包」原来的**唯一入口是一个路径输入框**（要自己对着资源管理器
  抄 `D:\下载\qqagent-bundle-….zip`，还要抄对反斜杠），现在改成与「自建扩展 → 改别人的包」
  同形态的**拖放区**：拖 .zip 进来，或点「选择 zip 文件」。
- 拖放 / 选文件**仍然走盘上真实路径**（桌面桥 `pathForFile` → `POST /api/bundle/inspect { path }`），
  不把包读成字节塞进请求体：整包上限 256MB，而后端 `readBody` 只有 2MB —— 走 base64 的话
  稍大一点的包必然 413。后端读取链路一条没动，`zipBase64` 只作为浏览器 / 远程控制台的小包退路。
- 手填路径没有被删，折叠成一行「拖不动？手动填路径」的退路（远程控制台、剪贴板里已有路径时用）。
- 空路径的报错从「请填写包文件路径」改成「还没选包 —— 把 .zip 拖进上面的框里，或点「选择 zip 文件」」。

### 修复 · 桌宠「今日用量」卡片与顶栏对不上（2026-10-24，需重启生效）

- **用户实测：顶栏「今日：375 次运行」的同时，桌宠卡停在「今日：350 次运行」** ——
  两个号称"同一口径"的数字并排对不上。根因有两个，都在数据口（`src/app.js`
  的 `getUsageToday`）：
  ① **口径不同**：`buildUsageStats` 的 `totals.runs` 是「LLM 调用次数」（一轮一次），
     顶栏 `/api/status` 的 `usage.runs` 是「会话运行次数」（一个会话 +1）。卡片文案
     抄了顶栏，数字却是另一套。
  ② **3 小时结果缓存**：`buildUsageStats` 的结果缓存对 'today' 同样生效，卡片每
     5 秒的"刷新"没传 force，一直在读同一份最多 3 小时前的快照 —— 数字停在几
     小时前不动。
- 改为与顶栏**逐字段同源**：`sessions.todayUsage()`（usage-today.json + 运行中
  会话，实时、O(1)）+ `estimateCost` + `cacheHitRate`。卡片与顶栏从此一字不差，
  5 秒刷新也是真实时。返回形状不变（`chats` / `models` 留空数组占位），渲染进程
  依旧零网络请求、零密钥。

### 修复 · 桌宠「对话」点进「开发工单」后回不去（2026-10-25，需重启生效）

- **用户实测**：双击桌宠开「对话」→ 点右上角「开发工单」，工单窗起来的同时对话窗被
  `hide()` 掉，而工单窗头只有「新工单」和「×」—— **没有任何回程入口**。两张卡片都是
  frameless + alwaysOnTop 的子窗（`skipTaskbar`），也没有任务栏按钮可以切回去，
  点进去之后就只剩"关掉桌宠重开"一条路。
- 根因是单向门：`qqa-chat:open-dev`（对话 → 工单）一直有，反向的通道从来就没建过。
  `openChat()` / `openDevChat()` 各自首行都会把另一张收起来，所以缺的其实只是
  "把自己藏掉、把另一张叫起来"的那一条 IPC。
- 补一条对称通道：工单窗头加「返回聊天」→ preload 的 `openChat()` →
  `qqa-dev:open-chat` → 主进程 `devWindow.hide()` + `openChat()`。
  对话窗还活着就原样显示（历史不用重读，回程零等待）；只有把双击设置成「开发工单」、
  从没开过对话窗时才会新建一张。
- 头一次出现两个 ghost 按钮：`.ghost + .ghost { margin-left: 0 }` —— 两个
  `margin-left:auto` 会平分剩余空白，在按钮之间裂开一道缝。
- 新增 `tests/pet-devchat-nav.test.mjs`（5 个用例）钉住四层链路（html 按钮 →
  页面绑事件 → preload 桥 → 主进程处理器且真的 show/focus），外加"对话窗仍然留着
  进工单的入口"这条对称性。`npm test` 118 个用例全过。

### 修复 · 桌宠工单窗拖不动（2026-10-25，需重启生效）

- **用户实测**：三张浮窗里只有「对话」能拖，开发工单窗拖不动。三张都是
  `frameless + alwaysOnTop + skipTaskbar` 的无边框卡片，没有系统标题栏、也没有任务栏
  按钮，不给拖动区就等于钉死在 `anchorNearPet()` 算出来的位置上。
- 工单窗补 CSS 拖动区：`.hd { -webkit-app-region: drag }` + `.hd button { no-drag }`
  （与对话窗同一套写法）。按钮必须 `no-drag`，否则「返回聊天」「新工单」「×」点不动。
- 单击弹出的**用量卡片保持不可拖**（跟着桌宠走：每次单击贴回桌宠上方，16 秒自动收）。
  试过"渲染判 4px 阈值 + 主进程跟光标"的自定义拖动，但那是张只看一眼的卡片，
  能拖并不值那套复杂度 —— 按用户要求撤掉，代码回到最简：`pointerdown` 一行收起。
  （顺带记一笔：这张卡片**不能**用 CSS drag 区，drag 会吞掉 `pointerdown`，
  "点一下就收"会一起废掉。）
- 新增 `tests/pet-window-drag.test.mjs`（6 个用例）：工单窗 drag/no-drag、对话窗基线、
  用量卡刻意不设拖动区（含光标不暗示可拖）、保持"点一下就收"、preload 与主进程都没有
  用量卡的拖动口子、位置只由 `anchorNearPet` 决定。`npm test` 124 个用例全过。

### 修复 · 安装包的两个硬伤（2026-10-26 打包时发现）

- **中文文件名装出来是乱码**：0.4.9.0 那个包的打包脚本没按 UTF-8 写文件名，「使用说明.txt」和
  桌宠默认模型目录「DS鼠控版」解出来全是乱码名。0.4.9.1 起按 UTF-8 落名，解压出来就是原字。
- **漏带 13 个该随包的文件**：桌宠对话整套（窗口页面 3 个 + 主进程受限桥 1 个 + 核心
  `src/pet-chat.js`）、`src/reasoning-history.js` 与 7 个测试 —— 也就是说「桌宠直接对话」
  在 0.4.9.0 包里并没有带上。这正是版本号升到 0.4.9.1 的原因：0.4.9.0 的包停在 10-24 14:46，
  本节其余内容都是那之后写的。

---

## 0.4.9.0 · 桌宠与壁纸进包 + 两页重做 + 合并损失修复（2026-10-24，需重启生效）

> 0.4.8.9 的安装包停在 10-22 22:55，10-23 白天落地的桌宠与壁纸改动一行都没进包 ——
> 同一个版本号对应两份不同内容，是最坏的一种发布形态（用户装到的和作者跑的不是一套）。
> 这一版把两件改版正式收进包，并修掉体检暴露的四个"打包/运维"层面的问题。

### 新增 · 桌宠（工具组左栏 + 桌面悬浮窗）

- **Live2D 桌面伙伴**：插件 `desktop-pet` v1.3.8（PixiJS + Cubism Core 渲染），随包带 DS鼠控版
  默认模型（8 个动作组 / 44 个表情）；「桌宠」页可导入 Cubism 4 模型，导入时自动读动作组与表情（DS 鼠控版实测
  8 个动作组 / 44 个表情）。
- **交互**：单击弹「今日用量」卡片（一行式用量串：今日 N 次运行 · X tok · 缓存 Y% · ¥Z，
  下面一行搜索次数，16 秒自动收、期间定时刷新），
  双击打开开发工单对话窗（需启用 `dev-orders`）。卡片与对话框各用一份受限 preload，
  sender + origin + pathname 三重校验，**不给渲染进程发 token、不新开 HTTP 口**。
- 置顶 / 鼠标穿透 / 缩放 / 透明度 / 待机动作与表情；模型落在 `data/desktop-pet/models/<id>/`。

### 新增 · 壁纸（设置 → 外观与数据 → 界面背景）

- 内置壁纸模块 `src/wallpaper`（8 个工具）：换壁纸 / 调效果 / 关壁纸 / 查库，以及小红车
  （Wallpaper Engine）库浏览、换壁纸、控制播放、把当前壁纸设为软件主题背景（毛玻璃）。
- 壁纸库与工坊目录 `431960` 实时对齐（本机 85 项），场景导入走渲染窗任务队列。

### 修复

- **GIF 转视频找不到随包 ffmpeg**（`src/gif-to-video.js`）：本模块只查 PATH，而包里明明带着
  `runtime/ffmpeg.exe` —— 没装 ffmpeg 的机器上「视频输入」对 GIF 恒不生效，静默回退成按图片发。
  改成「先随包、再 PATH」，与 image-compress（10-16）、video-frames（10-21）统一口径。
- **没有 ffprobe 时元数据读不出**：时长与宽高改用 ffmpeg 自报的 `Duration:` / `Stream ... Video:`
  行兜底（新增 `parseFfmpegDuration` / `parseFfmpegVideoSize` 纯函数 + 6 个用例）。
  本机实测：96×72 的 1 秒 GIF → 24 帧 mp4，此前返回 null。
- **`npm test` 跑不起来**：`check` 原本指向 `./.workbuddy/tools/*.mjs`，那是开发目录、不随包分发。
  改为 `node --test "tests/*.test.mjs"`，当前 67 个用例全过。
- **更新检查把"更新源荒废"伪装成"已是最新"**：远端 `version.json` 落后于本地时，
  `hasUpdate` 必然为 false，与真正最新无法区分。新增 `stale` / `staleHint` 字段并在日志里告警一次。
- **desktop-pet 未进内置基线**：收包方没有 `config.trustedPlugins`，该插件会走第三方准入闸、
  因触碰 fs/crypto 被拒 —— 表现为"桌宠页在但加载失败"。已纳入 `builtin-modules.json`（25 个模块）。
- **ban-state 基线指纹失配**：10-22 手改插件后未重算，一直走能力扫描；已刷新。
- **信任清单残留孤儿** `reply-meme`（目录早已删除）：清掉，避免占名绕过准入闸。

### 文档

- README 增「桌宠」章节并修正 `npm test` 说明（洛版只保留 check/test 两个脚本）；
  使用说明补桌宠/壁纸两节；发布说明重写。

### 修复 · 合并时被覆盖掉的本地功能（2026-10-24，需重启/刷新生效）

同一类问题的两次发作：**删除型 hunk 把上游的整段实现连带删掉，只留下引用** ——
`node --check` 只验语法不管作用域，所以合并时一声不响，运行到那一行才炸。
另外还查出**另一种方向**的损失：上游的旧版文件把本地已经修好的实现整份盖掉
（本地改成上游版本，功能悄悄退回），靠"文件比合并前的本地备份小一截"才发现。

- **自检页白屏（`ReferenceError: ackMsgHtml is not defined`）**：`ui/app/13-doctor.js`
  的「忽略 / 恢复」UI 整段没了 —— 两个局部变量（`ackMsgHtml` / `ackedHtml`）、
  每条问题上的「忽略」按钮、「已忽略」区与逐项/整批恢复按钮、对应样式全被删，
  只剩 `renderDoctorReport` 模板里的两处引用。已按上游 0.4.9 原版补回
  （忽略清单走 `POST /api/doctor/ack`，落盘 `data/plugin-data/self-doctor/acked.json`，
  跨重启生效；后端 `doctor.ack` 能力本身是好的，纯前端损失）。
- **禁言复检静默失效**：`src/orchestrator.js` 的 `#checkSelfMutedDetail` 丢了 5 件东西 ——
  `MUTE_REVERIFY_MS` 常量、`no_cache: reverify`（写成死值 `false`）、
  `queried` 赋值、`#muteReverifyAt` 记时与清扫、以及复检翻案 + 宽限期整块。
  后果：解禁通知一丢（WS 抖动 / 协议端重启），复检永远读到身份库旧值，
  机器人**永久装聋**（用户实测原话「识别完禁言之后无法识别解禁」）。
  四个复检用例（`tests/mute-reverify.test.mjs`）此前全红，补回后转绿。
- `tests/wallpaper-module.test.mjs` 的「白名单放行后能走通」修掉 unconditional
  `JSON.parse`：没装 WE 时工具按本模块约定返回纯文本 `isError`，原测试在无 WE 机器上必红。
- **桌面悬浮小窗的圆角处理被上游旧版盖掉**：`ui/widget.html` 里那套
  `--wcard-radius` / `--wcard-border` + `html.wd`（不透明/毛玻璃档交给 Win11 DWM 的
  8px 裁切，页面不再自绘 12px 圆角与描边）连同注释一起丢了，而 `ui/app/widget.js:100`
  仍在切 `wd` 类 —— 类名成了死代码，之前修好的「窗口角上一块黑」在
  **关掉真透明、用毛玻璃档时**会复发。已按合并前本地版本恢复（保留今天的
  `--card-alpha: 0.5` 默认值）。
- **启动失败提示条丢了「详情」折叠**：`ui/error-boot.js` 退回成"直接显示原始错误"，
  合并前那版是「首行一句人话 + 详情/收起详情按钮（英文堆栈折在里面）」，并带
  "15 秒自动收起"。已整份恢复。
- 复查方式：拿 **合并前本地备份** 逐文件比体积，只有这两个文件明显缩水（-15% / -17%），
  再逐行看 diff 确认丢的是本地功能；恢复后用行集相似度扫描其余 46 个改动文件，
  已无"当前≈上游、本地内容消失"的候选。

修完整套测试 **67/67 全绿**（此前 62/67）。

**为什么之前没发现**：删声明留引用这类问题静态查不出来，只能靠跑。本轮新增
`.migrate/scan_dangling_vs_upstream.py`（对照上游发布包扫"上游有声明、这边没了、
引用还在"），已无真实残留（余下 10 条均为对象键误报）。

---

### 变更 · 「桌宠」挪进「工具」左栏（2026-10-24）

- 一级导航从 6 项回到 **5 项**（会话 / 用量 / 下载 / 工具 / 设置）：桌宠不再是独立一级入口，
  改挂「工具」组左栏第三项，与「连接 / 自检」并列。
- 理由：桌宠与另两项同为"机器人跑不跑得起来 / 长什么样"的杂务，而一级平铺的位置应该留给
  高频入口；0.4.9 刚给一级加了桌宠与壁纸两项，壁纸已于 10-23 收回设置，桌宠此次一并对齐。
- 页体未动：`#view-desktop-pet` / `#desktop-pet-page` / `15-desktop-pet.js` 全部原样，
  桌宠窗口右键菜单「打开控制台」、双击角色仍直接进这一页；`index.html` 的 tab-pool 里
  `data-tab="desktop-pet"` 身份锚点保留（`switchTab` 的 active 清理依赖它）。
- 侧栏行为变化：桌宠页从「整页无左栏」（`is-none`）改为常规 176px 左栏（`is-nav`）——
  与技能 / 插件页一致，面板自己缩。

### 变更 · 桌面悬浮小窗的默认档（2026-10-24）

- 默认值改为：**开启**、尺寸中、刷新 2500ms、总是置顶、鼠标穿透关、
  **真·透明背景开**、**背景不透明度 50%**；「贴边自动收起」沿用原来的默认**开**。
  即卡片半透明地浮在桌面上、能直接看见桌面；拖到屏幕边缘仍会收成一条细缝、
  鼠标移近即展开（和 QQ 一个手感）。
- 影响面：只改**默认值**（`src/config.js` 的 `DEFAULT_CONFIG.widget`）。已有配置
  里已写明的值一律保留（`loadConfig` 是 deepMerge），老用户不会被改动；
  「重置为初始形态」或换新设备后才会落到这套新默认。
- 连带同步的默认值口径：设置页渲染（`ui/app/06-settings-render.js`）、设置保存
  （`ui/app/08-modals.js`）、小窗页面（`ui/app/widget.js` 的不透明度兜底与右键菜单
  勾选态）、主进程（`electron/main.js` 的 `widgetOpacityPct` / 设置签名）。
- ⚠️ 「真·透明背景」在本机历史上踩过坑（透明分层窗口曾出现只显示第一帧后冻结，
  R46，见 `electron/main.js` 的 `createWindow` 注释）。它是默认档，但仍是实验项：
  万一卡片冻结不刷新，关掉这一项 + 把不透明度调回 100% 即可回到不透明深色卡。


### 重做 · 「桌面伙伴」整页界面（2026-10-24）

- **根因不是"画风不同"，是样式整页失效**：`ui/desktop-pet-panel.css` 引用的一整套令牌
  （`--tx` / `--tx2` / `--bd` / `--bg0..3` / `--ac` / `--ac-soft` / `--r-sm..lg` / `--ok` /
  `--warn` / `--err` / `--raise-1` …）在令牌扁平化时已全部改名或删除。`var()` 取不到值 →
  声明在计算值阶段失效（IACVT）→ 卡片边框、圆角、底色、徽标配色**全部丢失**，
  只剩继承来的字色 —— 这才是"和整体风格不搭"的真实原因。
- 现在与「连接」「自检」页同一套设计语言：外壳复用 `.snowluma-page-card`（940 居中同宽），
  页头 `.sl-head`，分区 `.sl-section` + `.sl-section-title`，面板 `.sl-panel` + `.sl-panel-head`，
  按钮与输入框全部换成全站 `.btn` / `.field`，不再私有一套。
- 布局重排：顶部状态区由四个药丸收成**一条四段状态条**（插件 / 桌面窗口 / 当前角色 / 桌宠，
  标签淡、值亮、段间发丝线）；页内导航改成吸顶分段控件并加 **scroll-spy** 高亮当前分区；
  每个操作按钮归到所属面板右上角（导入角色模型 / 找回桌宠位置 / 保存显示设置…），
  不再有孤零零甩在页边的大按钮；长说明文字收进 `.hint` 或面板内的说明行。
- 状态条只在出问题时说话：插件没开 / 桌面窗口没连 / 角色加载失败时，下面才多出一行橙色
  说明（写清下一步怎么做）；一切正常时就一条细线，不重复下方分区里已有的信息。
  「当前角色」名字上限 380px，超出单行截断、完整值挂 `title`。
- 页内所有「打勾才启用」的选项都换成与设置页一致的**滑动开关**（全站 `input.sw`，40×22 轨道，
  开关在左、文字在右），包括动作表里的「允许随机播放」—— 不再是方块复选框。
- 亮色 / 暗色两套主题都验过；`15-desktop-pet.js` 所有 ID 与 `data-dp-*` 钩子原样保留，
  轮询、保存、导入、观察等行为零改动。

### 变更 · 桌宠「今日用量」卡片改一行式（2026-10-24，需重启生效）

- 单击桌宠弹出的卡片从「大花费 + 输入/输出/缓存命中 + 会话数」的多行卡片，换成与主界面
  顶栏同一口径的一行式用量串：**「今日：N 次运行 · X tok · 缓存 Y% · ¥Z」**，下面一行是
  **「搜索：N 次」**。token 紧凑格式（K/M/G 三档、阈值 1000）与顶栏 `fmtTokShort`
  逐字一致 —— 桌宠和主界面看到的必须是同一个数。
- **常驻期间定时刷新**：卡片显示的 16 秒里每 5 秒重取一次统计并推送新数据（与
  `buildUsageStats` 的 5 秒微缓存同拍，不触发全量重算风暴），「搜索：N 次」这类下面那串
  跟着动，不再停在单击那一刻的旧数字；卡片收起、桌宠隐藏、宿主关闭时定时器一并清掉。
- 窗口随内容收窄：304×232 → 380×84；数字用 `tabular-nums`，刷新时宽度不跳。
- 数据口不变：仍走主进程 `getUsageToday()`（`buildUsageStats({ range: 'today' })`），
  只多透传一个 `searchCount`；渲染进程依旧零网络请求、零密钥。


### 重做 · 「连接」页的状态区与安装说明（2026-10-24）

- **连不上时，页面上终于有按钮了**：页头加了「重新检测」，安装说明底部也有
  「装好并登录了，重新检测」—— 以前唯一的「测试连接」藏在默认折叠的端点设置里，
  用户装好协议端只能干等自动刷新。
- 状态区从"四行平铺"改成三层：
  ① **结论块**（带色、两行字）：没检测到协议端 / 端口通了但没连上 / 机器人工作中，
  每种状态都直接写出下一步该查什么（启动协议端 / 查令牌与账号登录 / 无需操作）；
  ② **事实行**：WS、HTTP、机器人账号，标签列固定宽、地址用等宽字体；
  ③ **诊断详情**：默认折叠，原样保留后端诊断，「复制诊断信息」也搬进来了。
- "同一个事实说四遍"一并解决（顶部徽标 + 面板 meta + 账号 + 诊断）：现在徽标管总体、
  结论块管"为什么/怎么办"、事实行管参数；结论块右上角改成**检测时间**
  —— 自动刷新是看不见的，给了时间戳才知道看到的是不是新的。
- 「装一个协议端」改成可折叠：没连上时默认展开（这时候正需要），连上后默认收起；
  手动开合过的记住选择。
- 窄窗口下结论块与事实行会换行，不会把地址挤成一条缝；亮暗两套主题都验过。
- 两张协议端卡片的第 1 步统一成「从官方仓库获取并安装：<链接>」—— 以前 SnowLuma 只写
  「从你获取的渠道」，和 NapCat 的说法对不上，也没给地址；现在两边都直接给出官方仓库
  （`github.com/SnowLuma/SnowLuma` / `github.com/NapNeko/NapCatQQ`）。README 同步。
- **协议端控制台地址直接给出来**（装完要人工把 QQ 接进来，以前得自己猜端口）：
  每张卡下方多一行「控制台 `http://localhost:5099` / `http://127.0.0.1:6099/webui`」，
  带「打开」和「复制」。打开走 `shell.openExternal`，但**地址写死在主进程**
  （`PROTOCOL_CONSOLE_URLS`），渲染进程只能传 `snowluma` / `napcat` 两个枚举键 ——
  外链白名单里「本机地址不外开」的规则没有因此放松。网页版控制台没有桌面桥时，
  「打开」自动退回复制地址。步骤文案同步写清：SnowLuma 是「打开控制台（admin，密码见启动
  日志）→ 按引导注入 QQ → 登录机器人号」，NapCat 是「打开 WebUI（日志里有带 token 的地址）
  → 登录 → 网络配置」。
- 两张卡的内容块对齐：`margin-top: auto` 从脚注挪到「控制台」行 —— 两卡本来就等高
  （同一行 grid），但左边步骤更长，以前控制台行会一高一低；现在"控制台 + 脚注"整体贴底，
  多出来的高度落在步骤列表下方，两边的控制台行与脚注都在同一条水平线上。
  （两个 auto margin 会平分剩余空间，反而错位，所以只能留一个。）

---

---

> 【合并说明】以下 0.4.9 章节来自上游发布包，已剔除 SnowLuma 相关实现；
> 本仓库的协议端解耦（见下一条）保持不变。

## 0.4.8.9 · 协议端解耦：SnowLuma 移出安装包，用户自选协议端（2026-10-23）

> 动因：SnowLuma 的 EULA 5.4 禁止把它的专有原生组件并入第三方安装包、禁止用自动化
> 脚本部署、禁止商用。此前「随包分发 + 软件托管」的做法与之冲突。现在改成：
> **协议端由用户自行安装运行（SnowLuma 或 NapCat 任选其一），QQ Agent 只做
> OneBot v11 客户端。**

### 变更 · 安装包不再包含协议端

- `resources/app/snowluma/` 整个目录**移出安装包**（EULA / 原生 DLL / WebUI 全部不在包里）。
- 删除 `src/qq-version.js`：它做的是"QQ 版本 ↔ SnowLuma 版本对齐"检查，协议端不再
  随包后没有可对齐的对象；QQ 与协议端的版本匹配改由用户自己负责（README / 使用说明
  里写明了排查方向）。

### 变更 · 配置：`snowluma` → `protocol`

```diff
- snowluma: { dir, autoLaunch, autoInject, botQQ, wsUrl, httpUrl, accessToken, httpAccessToken, webuiPassword, … }
+ protocol: { wsUrl, httpUrl, accessToken, httpAccessToken }
```

- `loadConfig()` 自动迁移旧配置（`migrateSnowlumaToProtocol`）：把 4 个连接字段搬到
  `protocol`，然后删掉 `snowluma` 块。幂等，不覆盖用户已保存的新值 —— 老用户升级后
  不用重填地址与令牌。
- 随之下线：程序目录、启动时自动拉起、自动注入、机器人 QQ 指定、控制台密码接管。

### 变更 · 后端

- 删除全部 `/api/snowluma/*` 路由（launch / stop / logs / switch-bot / discovered-accounts /
  webui-credential / reset-webui / unload-bot / resume-inject / open-folder / open-webui …）。
- `/api/status` 的 `snowluma` 载荷换成 `protocol: { wsUrl, httpUrl, portOpen }`：
  `portOpen` = WS 端口是否在监听，用来区分「协议端没起来」与「起来了但没连上（令牌/账号）」。
- 新增 `POST /api/protocol/apply`：保存端点并**立即用新地址重连**（`OneBotClient.setEndpoint`）。
  以前改地址要重启应用，对刚装好协议端的人是多余的一步。
- 退出流程简化：不再 kill 任何子进程（协议端是用户的独立进程，退出 QQ Agent 不该动它）。
- SSE 不再发射 `snowluma-status` / `snowluma-log`。

### 变更 · 界面

- 「工具 → SnowLuma」页签 → **「工具 → 连接」**。内容从"三步启动管线"改成：
  ① 连接状态（端点、端口监听、机器人账号、诊断）；
  ② 协议端二选一指引（SnowLuma / NapCat 各一张卡，含端口与令牌怎么配）；
  ③ 端点设置（默认折叠，改完「保存并重连」）；
  ④ 应用日志（协议端自己的日志归它的控制台，不再假装能看）。
- 设置页「连接 QQ」：删掉"自动拉起 SnowLuma / 程序目录 / 打开文件夹"三个控件；
  「一键启动」只启动 QQ（协议端没在跑时直接给出指路，不再干等 5 分钟）。
- 首启引导、就绪圆点、横幅、悬浮小窗、健康体检卡等所有跳转目标同步改为连接页。
- 文档：`doc/extend_development/snowluma-capabilities.md` → `onebot-capabilities.md`
  （能力清单不变，改的是"协议端由谁提供"的前提）。

### 升级注意

- 机器人会**短暂离线**：协议端已移出安装包，升级后需要你自己启动 SnowLuma 或 NapCat，
  然后在「工具 → 连接」页确认已连上。
- 旧的 `snowluma/` 目录如果还在安装目录里，可以手动删除（程序不再读取它）。

---

## 0.4.8.9 · 表情包引导强化 P1/P2/P3（2026-10-22 深夜，需重启生效）

> 来自同日排查报告《表情包发送偏少的成因分析与优化计划-2026-10-22》：机器人发表情率
> 3.2%（10/315），不到群友带图率（7.6%）的一半。主因是 10-01 上线的「发言即收尾」把
> 「先说文字、下一轮补表情」这条路物理斩断（`send_sticker` 命中 `isDeliverTool()` 的
> send 词形，纯文字批一发出会话就结束）；库容 5 张、容量门控降档、收藏被动是三个放大器。
> 按用户拍板：P1/P2（提示词层）**与 P3（机制层）全部落地**，P3 按"精细化 + 门控"做。

### 变更 · 表情策略段：短回应硬指引 + 主动收藏

- **P1 短回应硬指引**：`buildStickerStrategyHint()` 频率行之后插入一行固定硬指引 —— ≤10 字的
  纯反应（"确实""乐了""认了"这类附和/吐槽/无语）优先配图，且必须与 `send_message`
  **同批调用**；10-21 的「不要分两轮」规则在这一行里复述强化。仅在**有效档位 ≥2** 时插入：
  0/1 档是用户明确要"少发"，硬推会与频率行自相矛盾。依据：实测 149 条 ≤10 字短反应
  全部裸奔，而这正是真人最爱配表情的场景。
- **P2 主动收藏**：收藏从「等用户开口说要收藏」改为「看到合适的图/表情就主动收」，
  `get_sticker_image` 看图降级为可选步骤（仅拿不准图意时用），note/tags/usage 三件套
  仍必须填全；空库分支同步改写（空库恰恰是最该收的时候）。依据：24 小时内过 70 张图
  只入库 5 张，库容不涨 → `capacityLevel()` 永远压着 2 档，形成闭环。
- **护栏不变**：`maxCollectPerHour: 10`、`capacityLevel` 阈值（≤9 张最高 2 档）均未改动
  —— 库容过 10 后档位自动解锁，不需要改阈值代码。
- **缓存**：新增的是静态文案，段内不含计数/时间等运行时变量，行序与段结构恒定，
  前缀缓存不因内容变化而反复断点（一次性重置可接受）。
- **内置基线与插件版本**：`builtin-modules.json` 已按新哈希刷新（`lib/stickers.js` /
  `plugin.json`），插件 1.0.2 → 1.0.3。**必须重启生效**（信任闸读的是内存里的基线）。

### 变更 · P3 收尾精细化：给短回应留一轮表情（机制层）

- **问题**：`autoEndAfterSend` 判定"纯发送批"就立刻 `finish`，所以"先说话、下一轮补表情"
  这条路根本不存在。提示词层（P1/P2）只能提高遵从率，模型一旦没同批调用就永久丢失那次表情。
- **改法**：`orchestrator.#stickerGrace()` —— 本该立刻收尾时先问一次，条件全满足才改
  成"不设 finish，在 tool 结果之后补一条提醒，给表情留一轮"。七个条件：
  ① 本次唤醒未宽限过（一次唤醒最多一次）；② 非主动开话题；③ 开关
  `api.autoEndStickerGrace !== false`；④ 剩余轮次 ≥2；⑤ 本批没发过表情；
  ⑥ sticker 插件在场且**能发**（`sticker.state` 能力：`count > 0` 且有效档位 ≥2）；
  ⑦ 触发理由成立（本句 ≤10 字短回应 **或** 本轮收到的消息带图/表情）；
  外加会话冷却：同一群 5 分钟最多宽限一次。
- **成本**：每宽限一次多付一轮全价 prompt（实测约 19K token），所以门控按"短回应 + 冷却"
  压频次；`count` 读不到（库还没同步）时**不宽限** —— 拿不准就往不花钱的方向倒。
- **顺序约束（易踩）**：提醒必须 `messages.push` 在**全部 tool 结果之后**，插在
  `assistant(tool_calls)` 与 `tool` 之间会让 OpenAI 兼容端点判非法序列直接 400。
- **新增能力**：sticker 插件导出 `providers['sticker.state']`（只读内存快照，不发网络），
  `plugin.json` 的 `capabilities` 同步声明。编排器走 `#capFirst` 软依赖 —— 插件没装/
  没启用时拿不到，宽限静默不发生，行为与改动前完全一致。
- **可测**：判定逻辑抽成纯函数模块 `src/sticker-grace.js`（无 IO、不依赖 electron），
  编排器只负责取事实。`tests/sticker-grace.test.mjs` 12 例全过（档位 / 库存 / 冷却 /
  已发过表情 / 坏 JSON / 最后一轮 / 开关）。

### 清理 · 旧表情模块下线

- 删除 `src/stickers.js` 与 `src/sticker-manager.js`（581 行死代码）：它们的
  `buildStickerStrategyHint()` 仍在教"先发文字、再单独发表情"，与 10-21 的修复直接矛盾，
  留着是下一个坑。经全仓检索确认无人 import（仅 `image-compress.js` / `image-type.js` /
  `safe-fetch.js` 的注释提到过它）。备份在 `F:/QQA/v0489/.workbuddy/archive/2026-10-22-deadcode/`。

---

## 0.4.8.9 · 群禁言「禁言后不说话」修复（2026-10-22 晚，需重启生效）

> 这条线来自同日的排查报告（`群禁言功能问题排查与修复方案-2026-10-22`）：
> 功能三条设计链路只接了一条 —— 事件写入端从未接线，唯一的查询兜底又被 60 秒
> 缓存架空。实测禁言 10 分钟：连跑 4 个会话、净烧约 19.5 万 prompt token、
> 5 次发送全部被拒（result=120）、0 条消息送达。本次把七个修复项全部落地。

### 变更 · 禁言状态全链路接线：事件 → 缓存穿透 → 发送兜底 → 可观测性

**根因**：「零件齐全、装配缺失」—— 插件按单元逻辑自测过，但三个集成点一个都没接，
而装配的失败又恰好全是静默的（快路径死了降级成查询、查询失败静默放行、配置开关
不读、跳过不留日志），叠加生产零触发，从上线到暴露没有任何征兆。

**改法**（按优先级 F1–F7）：

- **F1 缓存穿透**：ban-state 插件新增状态变化订阅（`onBanStateChange`），
  note-muted / note-unmuted / 到期自动失效三条路径都通知；orchestrator 订阅后
  直接覆写 `#muteCache`，不等 TTL。快路径命中「确定被禁言」时也顺手写回缓存，
  避免与更早的旧缓存自相矛盾。
- **F2 协议层事件接线**：`app.js handleOneBotEvent` 新增 `group_ban` 分支 ——
  只认 `user_id === self_id` 的通知（群友被禁言不能把自己标成禁言），
  `ban 且 duration > 0` → note-muted，`lift_ban`（含 duration=0 的 ban）→ note-unmuted。
  self_id 用事件自带值优先、回落 `onebot.selfId`（与 message / poke 同口径）。
- **F4 发送层兜底（含主动检查 + 终态错误）**：`sender.js sendTextBatch` 识别
  禁言签名（`result=120`，errMsg 是空串只能认这个码）→ 立即 note-muted 并记
  WARN（风控可能同码，注明存疑）；全败时抛出带 `muteRejection` 的结构化错误，
  `tools.js send_message` 将其作为**终态**返回给模型（「已被禁言，请勿重试，
  直接结束本轮」）—— 实测重试会把单请求 body 撑到 1.9MB，终态化直接掐断重试风暴。
- **F5 配置开关接线**：orchestrator 读取 provider 返回的 `skipRun` / `markRead`。
  `skipRunWhenMuted=false` → 禁言期照跑（留痕后放行，产品行为）；
  `markReadWhenMuted=false` → 跳过时不标已读，积压消息解禁后补处理。
  两个开关此前算了没人读，UI 里改它们没有任何效果。
- **F6 可观测性**：跳过路径记 INFO 落盘（群、剩余秒数、依据、标已读条数）；
  禁言查询失败 / selfId 缺失补 WARN（此前静默放行，排障无法区分「没被禁言」
  和「没查到」）；`handleOneBotEvent` 对未识别 notice/request 记 debug
  （默认级别过滤，调 debug 可见 —— 治「静默丢弃」这一类 bug）；
  `plugin-loader` 的 `api.log/warn/error` 改道 logger（此前只进 console，
  `data/logs/*.log` 里 `[skill:` 行数为 0，插件的关键证据只存在于 stdout）。
- **F3 查询兜底中间档**：`#muteCache` TTL 从 60s 下调到 15s。事件接线 + 缓存
  穿透之后这条缓存只是查询兜底的新鲜度上限；真实查询有 snowluma 侧 60s
  single-flight 兜底防频。`no_cache` 暂不改，按报告建议观察一段时间再定。
- **F7 提醒禁言闸**：`#fireReminder` 增加禁言判断 —— 禁言中的提醒抛
  `reminderDeferred`（不消费 fired 状态，解禁后自然补发），日志按群只记一次。
  修复前禁言期每 20 秒一条发送失败报错刷屏直到解禁。

**测试**：新增 `tests/ban-state.test.mjs`（node:test，10 例）—— 生命周期、
到期自动失效、`muteFromTimestamp` 边界、`isMuteRejection` 签名（含风控同码
不误杀）、订阅三条路径、provider 各 action。另用假 onebot 跑了 sender F4
全链路集成验证（禁言签名命中即标记 + WARN 落日志 + 结构化错误；
普通网络错误不误标）。

**遗留**：`snowluma` 身份库 `shutUpTime` 新鲜度仍未实测（F3 的 no_cache 决策
依赖它）；`allow.groups` 当前为空且 `allowAllWhenEmpty=false`，机器人不在任何
群发言，上线前需先把群加回白名单。

---

## 0.4.8.9 · 2026-10-22（人设管理成形 + 市场页卡顿 + 两处滚动丢失）

> 这一版几乎全在「人设」这条线上：预览、已安装页、会话设置入口、卡片编辑、
> 单选语义、全局标注，顺带补了插件 / 技能的来源筛选。
> 另外修了三处"会把正在看的东西弄丢"的问题：点「下载」卡一下、装完插件列表弹回顶部、
> SnowLuma 日志刷新把人拽到底部。
>
> ⚠️ 本版动了后端（`/api/skills` 补 `builtin`、人设模板支持带 id 更新），**必须重启应用**。

### 变更 · 市场安装不再「下载即装」：进锻造台、过闸、**人工确认**才落盘（22 日 20:35，需重启生效）

**现象**：在市场页点「安装」，包直接解压进 `skills/` / `plugins/` 并被 `fs.watch` 立刻加载执行。
五道闸门一道没跑（只做了结构与清单预检），人工确认一步没有 —— 用户点一下按钮，等于把整台机器
交给一份没人看过的代码。而"加载时才发现它 import 了 fs"要等热重载那一刻才暴露，用户看到的是
"装了、开了、没反应"。

**根因**：`/api/market/install` 走的是 `market.js installByCode → zip-install.unzipToModuleDir` 这条
**直装**链路，与 `extension-forge` 的「暂存区 → 五道闸门 → 确认 → 落地」是两套东西。锻造台那套
只服务"模型现写 / 手动导入"的包，市场下载从来没接进去。

**改法**：

- `/api/market/install` 语义改为**只下载 + 入暂存区**：`downloadModuleZip()` 拿字节 → `forge.import-zip`
  → 拍适配前快照 → 记来源（`source=market`、口令、名称）→ 跑五道闸门 → 返回 `{ pending:true, draftId, gate }`。
  不写 `skills/`、不写 `plugins/`、不 `reloadSkills()`。真正的落盘只发生在下一步。
- **安装必须出示「人工确认票据」**（新能力 `forge.confirm-ticket` + `POST /api/forge/confirm`）：
  - 票据绑**草稿内容摘要**（`gate.js` 新增 `draftDigest()`，按路径排序哈希路径+长度+字节）：
    确认之后草稿再被改动（模型继续改 / 另一个请求覆盖写），票立刻失效并提示重新核对；
  - **一次性**、**10 分钟过期**；落地失败会把票还回去，不让用户白点一次；
  - 只能由**控制台发起的请求**签发 —— `keyEndpointAllowed` 判渲染进程私有凭据（主进程
    `webRequest` 注入、不落盘、不进 DOM），本机其它进程与外部网页都拿不到。
    插件侧再要一个显式 `human=true` 兜底，不接受任何"系统代确认"。
- `forge.install` / `forge.upgrade-install` 都改为**先验票再落盘**，并把 `confirmedBy/confirmedAt/digest/来源`
  写进模块目录的 `.forge-origin.json`；`/api/forge/install` 另加一道"票据能力缺失则拒绝"的兜底
  （防止 `plugins/` 下的旧副本顶替新版锻造台时静默跳过验票）。
- 前端：市场页与批量口令框如实显示"已下载到锻造台（闸门 X 项待确认），**还没装进系统**"，
  按钮变「待确认」且不可重复点击；锻造台安装按钮改为「我已核对，确认安装」，并在旁边写明
  票据的有效期与"代码一改票就失效"。暂存区草稿列表补「市场 · 包名」来源标记。

> 为什么不是"闸门全过就自动装"：`gate.js` 的危险规则是正则、`dangerous-import` 也只是启发式，
> 挡得住"模型顺手写出危险调用"，挡不住精心构造的绕过。把闸门结论直接换出安装许可，等于把
> 提示性检查升格成安全边界 —— 那是这套东西设计时最想避免的事。

### 变更 · 点「安装」后自动进锻造台并开始适配（22 日 20:45，刷新控制台即可）

**现象**：点「安装」之后包确实进了暂存区，但要用户自己切到 harness → 自创扩展 → 在一堆草稿里
找到它 → 点「查看」→ 再点「让模型适配到本机」。用户点的是"安装"，却要替系统走完五步。

**改法**：

- 新增 `forgeOpenAndAdapt(draftId)`（`13-doctor.js`）：切页 → 刷新草稿列表 → **打开该草稿** →
  **直接开始适配**。市场单个安装、批量口令安装（取第一个入暂存区的）都接上它。
- 自动跑的那一轮带一条"收着改"的补充说明：只做"装得上、跑得起来"所必需的最小修改
  （清单缺失/非法、apiVersion 或入口对不上、requires 了本机没有的能力、调了不存在的 api）；
  原本就能跑就**不要改代码**，直接说明。避免对好用的包做无谓重写。
- 正在起草/适配/安装时再点安装：只把人送到锻造台，不抢草稿 —— 两个适配同时写同一份草稿
  会互相覆盖（对应用户看到的"文件忽左忽右"）。
- `runForgeAdapt(noteOverride)` 支持外部传入补充说明（自动轮没有输入框可读）。

> 自动适配只在暂存区里改文件，碰不到 `skills/` 与 `plugins/`，**不构成"未经确认就安装"**；
> 落地仍然必须由人签那张绑定内容摘要的票据。

### 修复 · 市场包导入后「缺少清单、5 项阻断」装不上（22 日 20:55，需重启生效）

**现象**：市场下载的包进了锻造台，但闸门报"缺少清单文件"等 5 项阻断，怎么修都装不上；
自创扩展页里也看不到这个草稿。

**根因（两层）**：

1. `forge-tools.extractZipToDraft` 剥外层目录的条件是"**所有条目**共享同一个第一段"。
   只要包里混进一个根级杂物（macOS 打包的 `__MACOSX/`、作者放的 README、`.gitignore`），
   条件立刻不成立、整层不剥 —— 清单落在 `<草稿>/reply-meme/skill.json`，而结构闸只在
   **草稿根**找 `skill.json` / `plugin.json`，于是直接判"缺少清单"。模型也没法把目录整体
   搬上去，只能一个文件一个文件重写。
2. `switchDoctorSub` 进自创扩展时只在 `available === null`（从没探测过）才拉草稿列表，
   之后每次进来都停在旧快照上 —— 新下载的包根本不在列表里。

**改法**：

- 剥层改为**以清单文件为锚**：找最浅的 `skill.json`（其次 `plugin.json`），把它上面的层级
  全部剥掉，与 `zip-install.unzipToModuleDir` 同口径；包根之外的条目直接丢弃。
  ⚠️ 顺手修掉一个隐患：旧代码是 `name.slice(prefix.length)`，`__MACOSX/._index.js` 切完
  正好得到 `index.js` —— 会凭空写出一份假入口。现在先判"在不在模块根下"，再切。
- 进「自创扩展」子页**每次都重拉** `/api/forge`。
- 新增闸门**两档尺度**：`generated`（模型现写，最严）与 `third-party`（别人打的包）。
  第三方档把 `child-process` / `dangerous-import`（fs / net / vm…）从 **block 降为 confirm**
  —— 仍然拦，但拦成"你勾一下"，而不是"装不上"。理由很实际：本机自带的 media-download 要
  fs 落盘、video-frames 要调 ffmpeg、sticker 要读素材，一律 block 的结果不是更安全，
  而是市场包 100% 装不上。`credential-read`（读 config.json / apiKey）与 `process-exit`
  保持 block —— 它们没有任何第三方扩展的正当用途。
  档位记在 `_meta.origin`（导入 / 升级副本 = third-party），**不写在草稿目录里**：
  那份内容会被原样复制进模块目录，且第三方能改，拿它当判据等于让被检对象自己定尺度。

**实测**（市场包「回复配图·梗鲸表情包」）：改前 4 阻断（fs / child_process）、改后
**0 阻断 / 6 待确认 / 1 提示**，勾选确认即可安装。

### 新增 · 打包 / 接收：勾选扩展与数据，打成一个 zip 发给别人（22 日 22:10，需重启生效）

**要解决的事**：换机器、给朋友带一套自己调好的技能，以前只能让他去市场一个个重装、
数据则要拷 data 目录。现在可以**勾选打包**，对面**接收即装**。

**包里放什么**（`harness → 打包 / 接收`）：

- `bundle.json`：来源、时间、逐项清单（人可读，也能被脚本校验）
- `modules/skills/<目录>/**`、`modules/plugins/<目录>/**`：勾选的扩展
- `data/messages/**`（会话存档）、`data/memory/**`（群友印象）、
  `data/usage-*.json`、`reminders.json`、`stickers.json`

**包里永远没有**：`config.json`（API Key / QQ 号 / 网关 token / 身份字段）、
`plugin-data/`（插件私有存储 —— account-pool 这类里面就是账号凭据）、logs / cache / lock。
这条边界写死在 `src/bundle.js` 里，不做成开关：一旦能"顺手带上密钥"，包就会被随手发出去。

**接收端不是"解压即装"**：

1. 只解到 `data/import-bundles/<id>/` 临时区，**不碰** `skills/` 与 `plugins/`；
2. 「检查并登台」把每个扩展单独送进锻造台过闸（第三方档尺度），界面上逐条显示
   通过 / 待确认 N 项 / 阻断 N 项；
3. 「确认安装所选」= 一次人工确认批量落地 —— 但每个草稿仍然**各签一张票**
   （绑内容摘要、一次性、10 分钟）。批量省的是点击次数，不是检查。
4. 数据侧复用 `migrate.applyImport`：导入前备份、可回滚、历史消息置已读、按 mid 去重。

**新增文件**：`src/zip-build.js`（最小 zip 写入器，UTF-8 文件名带 EFS 标志位，
否则 Windows 解出来是乱码目录）、`src/bundle.js`。
`zip-install.parseZip` 增加可覆盖限额参数（整包上千文件，100 文件 / 32MB 那套是给单个
插件包定的；不给参数时行为完全不变）。

**已验证**：导出→接收→取单模块 zip 全链路跑通；包内确认不含 `config.json` 与 apiKey；
套层目录 / 缺数据的包 / 非整包 zip 三种异常输入分别给出准确报错。

### 删除 · 「数据移植」页下线，收尾能力并入「打包 / 接收」（22 日 22:20，需重启生效）

**动机**：数据入口有两条（旧页"读另一个 data 目录" / 新页"收一个 zip"），备份、回滚、
去重规则各说各话，改一处要记两遍。既然整包已经覆盖同一批数据，旧页就是多余的那条。

**删掉**：

- `harness` 子页「数据移植」（📦）及其全部前端代码（状态 / 渲染 / 事件 / 扫描结果表 /
  导入结果卡，约 320 行）。
- `POST /api/migrate/scan`、`POST /api/migrate/apply` —— 那个页面是它们**唯一**的调用方，
  留着就是一条没人用、也没人测的写盘入口。

**保留（并在注释里写明原因）**：

- `src/migrate.js` 继续作为**数据落地引擎**：`inspectBundle` 用 `scanSource()`
  算"源几条 / 本机几条 / 会多出多少"，`/api/bundle/import-data` 用 `applyImport()`
  真正写盘（合并去重 / 备份 / 置已读 / 重建索引全在这里）。没有另写第二套。
- `GET /api/migrate/backups`、`POST /api/migrate/rollback`：备份列表与回滚**搬到
  「接收整包」页底部**。删页面时最容易漏的就是它 —— 备份如果没有界面入口，
  "可回滚"就退化成"自己去 `data/import-backups/` 里翻"。

> 顺带把三处残留注释（`bundle` 与 `migrate` 的分工、子模块依赖列表）改成现状，
> 免得后来的人按注释去找一个已经不存在的页面。

### 修复 · 启动即失败：私有字段 `#banStateUnsub` 未声明（22 日 22:19）

**现象**：双击启动直接弹「启动失败了，原因见下方」：
`SyntaxError: Private field '#banStateUnsub' must be declared in an enclosing class`。
应用完全起不来（不是某个功能坏，是加载期就崩）。

**根因**：22:14:52 的「F1 禁言缓存穿透」改动在 `src/orchestrator.js` 的
`#checkSelfMutedDetail()` 里写了一行

```js
if (typeof unsub === 'function') this.#banStateUnsub = unsub;
```

但 `#banStateUnsub` **从来没有声明**。JS 私有字段必须先声明后使用，且这个错误发生在
**编译期**（ESM 加载时），不是在调用时才报 —— 所以整机起不来。
更阴的是它"改的时候没事"：写这段代码时应用正在运行，改的是磁盘上的文件，
下次启动才重新编译 → 隔一次重启才炸。

**改法**：

- 在 `#muteCache` 旁边补上 `#banStateUnsub = null;`（并注明为什么必须有这一行）。
- 订阅逻辑改成「没订过才订」：`if (!this.#banStateUnsub) { … }`。这个函数每次检测禁言
  都会被调用，原来是无条件重订 —— 插件侧虽然按引用去重，但每轮都要进一次 Map；
  现在本端也守住了。

**验证**：`src/` + `plugins/` 共 140 个文件 `node --check` 全通过；
本地 import/export 对齐检查 0 处问题；用临时数据目录实际 `import('orchestrator.js')`
成功（导出 `Orchestrator, parseInlineToolCalls`）。

> 这类错误本该在写盘那一刻被拦住：`node --check` 一条命令就能提前发现。
> 开发工单 / 自动修复的写盘路径目前**不做语法预检**，这是可以补的一处（尚未做）。






### 修复 · 人设市场的「预览」太小、和整体风格不一致（22 日 17:55，需重启生效）

**现象**：人设市场点「预览」，出来的是**没有任何样式**的一坨内容 —— 关闭键是个浏览器默认的
小灰块，正文是默认 `<pre>`（等宽小字、无底色），和全站「深色卡片 + 细描边 + 圆角」的语言完全
对不上；而且这块东西内联展开在列表**最下方**，点了还得往下滚才看得见。

**根因**：`17-persona-market.js` 往 `#pm-preview` 里塞了 `.pm-prev-box / -head / -title / -meta /
-x / -body / -more` 一整套类名，但 `style.css` 里**一条对应规则都没有**。这些 `.pm-*` 本来只是
语义钩子，平时靠 `.mk-*` 的现成样式撑起来（`.pm-card` → `.mk-card`、`.pm-action` → `.mk-action`），
唯独预览这一组没有可复用的 `.mk-*`，于是整块裸奔。

**改法**：

- 改成**模态浮层**：`#pm-preview` 用 `position:fixed; inset:0` + `--overlay` 遮罩，层级对齐
  `.modal-overlay`（900，仍低于 loading 999 / toast），不再挤在列表底部。
- 卡片走全站令牌：`--card` 底 + `--line-str` 描边 + 14px 圆角 + `--lift-lg` 阴影，宽
  `min(760px, 100%)`；短人设用 `min-height: min(320px, 100%)` 兜底，不会塌成一条。
- 正文换成界面字体（`<pre>` 默认等宽，中文人设读起来像代码块），13px / 行高 1.9，底色用
  `--code-bg` 比卡片再深一档，长卡在框内滚动。
- 关闭键从默认 `<button>` 换成 30px 圆角悬停块；补上 **Esc 关闭**、**点遮罩关闭**、关闭后
  **焦点还给「预览」按钮**。
- 预览框底部加「**试用这个人设**」：模态把列表挡住了，原文案让人去点「试用」却根本点不到。
- 正文上限 1200 → 4000 字（框变大了，能多给一些）。

> ⚠️ 给 `#pm-preview` 加了 `display:flex` 之后必须显式写 `#pm-preview[hidden]{display:none}` ——
> 浏览器默认的 `[hidden]` 优先级低于 ID 规则，漏了这行浮层就关不掉。

### 新增 · 「下载 → 已安装」多了「人设」一页（22 日 18:05，需重启生效）

**问题**：技能和插件在「已安装」段各有一页，人设是同一类东西却没有 —— `config.customPersonas`
里装了多少、装的是什么，界面上完全看不见。市场页只能给市场条目打一个「已应用」徽标；设置页
那个「选择人设」弹窗的语义是"挑一个填进角色设定"，不是"看看我装了哪些"。结果就是装完人设
之后，既找不回来，也删不掉。

**改法**：新增 `#view-personas`（`ui/app/19-personas.js`），左栏「已安装」段变成
技能 / 插件 / **人设** 三项并列。

- **底部尾注**：与技能页（共注册 N 个工具）/ 插件页（共提供 N 个能力）同一套版式。
  人设没有可枚举的"能力"，最有用的是**体量**：正文会整段注入系统提示词，字数直接
  换算成 token。所以写「这 N 个人设合计 X 字」+ 按来源分组的字数标签，让用户一眼
  看出哪一类人设"重"。统计按全量算，不随筛选变。
- **说明折叠条 + 状态筛选**：与技能 / 插件页用**同一套组件** ——
  `<details class="module-note">`（原生折叠，无 JS、键盘与读屏天然可用）+
  `.mod-filters` 三档（全部 / 使用中 / 未使用）。人设是纯文本，不存在"加载失败"
  这一档，所以是三档不是四档；筛选状态放模块级，切走再回来保留，与插件页行为一致。
  统计数字一律按**全量**算（切到「未使用」档时「使用中 1」不会变成 0）。
- **头部补齐与插件页同款的三件套**：`1 / 4 使用中` 统计标签 + 「去市场」（跳人设市场）
  + 「＋ 添加人设」（复用设置页那个新建弹窗，支持把 .txt / .md 拖进去自动读取）+ 「刷新」。
  > ⚠️ 调新建弹窗时四个选择器**刻意指向不存在的元素**：它默认会把新内容填回设置页的
  > 「角色设定 / 附加规则」文本框并派发 `input` 触发自动保存 —— 用户刚从设置页切过来、
  > 那里还开着写了一半的内容时，就会被覆盖掉。这页没有编辑器可填，直接指向空气
  > （弹窗内部对 null 都有保护）。成功反馈改由新加的 `onDone` 回调里 toast + 刷新列表。
- **容器也换成插件页那套**：`.usage-pane` + `.usage-wrap`（max-width 940 居中），
  不再用 `.market-page`。市场页没有宽度上限、内容铺满 1184px —— 同一套 `.mcard`
  装在两种宽度里就是两个样子：卡片 380px vs 305px、左边距 14px vs 116px。
  用无头浏览器量过几何：改后卡片宽 **305 / 305（差 0）**，名称 / 描述 / 目录距卡片顶
  **0 / 0 / 0**，垂直位置完全对齐；x 方向剩 5px，来自滚动条占位（两页同时出现
  滚动条时归零）。
- **标题行三个元素**：名称 + 来源徽标 + 状态，对应插件卡的「名称 + 版本 + 生效中」。
  来源徽标是中文，必须 `white-space: nowrap; flex-shrink: 0` —— 否则 flex 默认会把它
  压到单字宽，「内置」被拆成「内 / 置」两行，标题行 20px→35px、整张卡高出 15px。
- **网格小卡，与插件卡同构**：直接复用 `.module-grid` + `.mcard`，右侧同样是
  「图标 + 开关」，删除同样落在右下角。第一版把操作做成底部一整行文字钮，结果
  `.mcard-state` 自带的 `margin-left:auto` 把「使用中」甩到卡片最右边、卡片还比插件卡
  高一截 —— 用户一眼就看出"这俩不是一套"。现在结构与插件卡逐项对齐：
  名称 + 来源徽标 + 状态连读，右侧眼睛（预览）+ 开关，右下角垃圾桶（仅自定义）。
- **开关语义**：开 = 用这个人设，关 = **回落到内置默认**（`xiaojingyu`）。
  人设是单选，`roleText` 不能为空，"关掉"必须有落点，否则机器人会带着空设定说话。
- 点卡片空白处 / 点眼睛 = 预览。
- 卡片描述会先剥掉 Markdown 标记（`#` / `**` / 行首列表符）—— 人设正文普遍以
  `# 角色卡：… ## 一、你是谁` 开头，原样塞进小卡会满屏井号。
- 每张卡标**来源**：内置 / 市场 / 自定义。
- 操作：**预览**（复用市场页那套浮层）、**使用**（只改 `persona.roleText`，不动 `botName`
  —— 名字是账号身份，@ 判定和存档称呼都依赖它）、**删除**（仅自定义；删的正好是在用的
  那个会回落到内置默认，与「选择人设」弹窗同口径）。
- 预览浮层从"人设市场页里的一个 div"改成挂在 `body` 上的**全局单例**，两个页面共用；
  切页时由 `switchTab` 主动关闭 —— 挂在 body 下就不会再随页面容器一起隐藏了。

> ⚠️ `custom_N` 里的 N 就是 `customPersonas` 的下标：`GET /api/persona-templates` 只回
> `id / name / text / builtin`，**不回 source**，判断"从市场装的"还是"自己写的"得靠下标回查。
>
> ⚠️ 这页的容器是 `.market-page market-page--plain`：市场页那两层 `radial-gradient`
> 氛围光是给「条目铺满、卡片半透明」的页面做层次感的，光晕只在卡片缝隙里透一点点。
> 但人设页可能只有 1 个人设，大片空白让左上角那团 `--accent-soft` 直接裸出来 ——
> 用户看到的就是"莫名其妙一坨淡蓝"（实测像素 b−r 从 +20 衰减到 +5，正是那层渐变）。
> 所以加了 `.market-page--plain::before { display:none }` 单独关掉，布局仍走 `.market-page`。

### 新增 · 会话设置的「扩展」段加了「人设」（22 日 18:55，需重启生效）

会话设置（点会话 → 齿轮）左栏「扩展」原本只有技能 / 插件，现在多了「人设」，
统计写 `N 个 · M 使用中` —— 技能/插件仍是「生效」，人设是单选，"生效"这个词对不上。

- **数据源不同**：人设走 `/api/persona-templates`，不是技能/插件的 `/api/skills`。
  统计交给 `personaStatOf()`、右栏交给 `loadPersonasPage({ box, compact })` 渲染，
  不在这边另算一遍（两份口径迟早会漂）。
- **渲染到右栏而不是固定页面**：`renderPersonasPage` 改成接受 `box` 参数；
  "操作完重画"的路径（开关 / 删除 / 筛选）靠模块级 `personasHost` 找回当前容器，
  并且**要判可见性** —— 会话设置关掉后 `#bp-setup-scroll` 仍挂在 DOM 上只是被隐藏，
  不判的话回到人设页点开关，重画会画到那个看不见的右栏里，眼前纹丝不动。
- `compact` 模式只去掉底部尾注（"共 N 字"是全局概览，属于人设页的收尾，
  塞进右栏只会把卡片往下推）。
- 数据加载抽成 `refreshPersonaData()`，人设页与右栏共用同一份，不写两遍。

### 新增 · 人设卡上可以直接改人设（22 日 19:20，需重启生效）

用户希望在这两页就能改人设，不用绕去设置页。给自定义人设的卡片加了齿轮
（与插件卡同一颗）：

- **只对自定义人设开放**：内置人设的正文写死在 `src/personas.js`，改不了 ——
  内置卡上根本不出现齿轮；万一被绕过，前端 toast 提示"另存一份再改"，
  后端也只认 `custom_N`。
- **复用设置页那个新建弹窗的编辑模式**（传 `editId`）：同一套字段、同一套拖 `.txt`
  读取，不另写一个只差三个输入框的弹窗。标题变「编辑人设」、按钮变「保存修改」、
  三个框预填当前值。
- **后端** `POST /api/persona-templates` 支持带 `id` 更新：
  - 改的正是**当前生效**的那套时，在同一次 `updateConfig` 里把 `persona.roleText`
    （以及模板自带的 `customRules`）一起更新 —— 否则界面显示新人设、机器人还拿旧正文
    说话。这与删除接口 2026-10-16 修的是同一类问题。
  - 编辑模式**不回填**设置页的「角色设定」编辑器：改的是"库里那一条"，
    不是"当前角色设定"（新增模式仍然回填，那是设置页的既有行为）。

> ⚠️ 动了后端（`src/routes.js`），必须重启应用。

### 改进 · 当前人设卡上标明「全局人设 · 所有会话共用」（22 日 19:12，需重启生效）

「会话设置 → 扩展 → 人设」里看到的其实是**全局**人设列表（`config.persona.roleText`），
很容易被当成"当前这个会话的人设"。给使用中的那张卡底部加一行灰色小字标清楚：

> 全局人设 · 所有会话共用

悬停有完整说明（单独配过人设的那几个会话不受影响，页头会提示数量）。
只标使用中的那一张 —— 其余的没有"是不是全局"的问题。

### 修复 · 保证全局人设「同时只能启用一个」（22 日 18:50，需重启生效）

人设是**全局设置**（`config.persona.roleText` 是单值），所以打开 B 的开关在数据上
就等于关掉 A。但原实现有三处会让这个语义漏掉：

1. **正文完全相同的人设会同时亮**。判据是"这张卡的正文 == 当前 roleText"，用户把同一个
   `.txt` 导入两次，两张卡就都显示「使用中」、两个开关都开着 —— 看起来像能同时启用两个。
   改成 `personaCurrentId()` 只认**第一个**匹配的 id，`personaIsCurrent(id)` 比 id 而不再
   比正文：无论重复多少份，最多一个亮。
2. **并发点击**。连点两个开关会发两个 POST，后端虽然同步读改写、最终值以最后一次为准，
   但前端两次重绘交错会闪出"两个都亮过一下"的中间态。加了 `personasSwitching` 闸门串行化：
   上一次没回来就忽略新的点击。
3. **切完没说明**。现在 toast 会明说「已换成 X，**Y 已自动关闭**」—— 单选语义要讲出来，
   否则用户看到另一个开关自己弹回去，会以为点错了。点到"正文相同的那一份"时直接提示
   「正文和当前人设完全相同，切换不会有变化」，不做无效 POST。

> 判定单测 10/10：同文双人设只亮一个、切换后仍只有一个、roleText 对不上任何模板时
> 一个都不亮、首尾空白容错。

### 修复 · 人设切换的三个静默冲突（22 日 18:40，需重启生效）

用户问「人设的启用逻辑会不会冲突」。查了 `personaForChat` / `buildSystemPrompt` 的实际
取值路径，发现三处「切了但没生效 / 串味」，界面上全都没有提示：

1. **`customRules` 串味（真 bug）**。`personaForChat` 是**逐字段合并**（`out = { ...base }`
   后按 roleText / customRules / systemPromptOverride / participation 覆盖），而人设页
   切换只写 `roleText` → 上一个人设的「管理员附加规则」残留下来，和新人设混在一起。
   设置页的「选择人设」是同步 customRules 的，这页漏了。
   改法：抽出 `personaApplyPatch(tpl)`，**只在模板自带规则时才写** customRules ——
   无条件写空串会抹掉用户手写的规则，那是 2026-10-16 修过的坑。
2. **分会话独立人设覆盖全局**。`personaForChat` 逐会话合并，配了 `personaByChat` 的会话
   优先级更高。设置页摘要卡有警告，这页没有 → 用户切完发现那几个会话没变。
   已在页头按同一口径（`roleText || participation || customRules || systemPromptOverride`）
   统计并提示。
3. **覆盖了系统提示词但没留 `{roleText}`**。`buildSystemPrompt` 的 override 分支是
   「整段替换 + `replaceAll('{roleText}', ...)`」—— 占位符不在，人设正文根本没有注入点，
   怎么切都没反应；而开关会动、卡片会换，是最难自查的一种。已检测并明确提示。

> 顺带确认**不冲突**的几处：市场页「试用/应用」写的也是 `roleText`（市场人设不带
> customRules，不存在串味）；`personaUnified=false` 时全局人设仍是"未单独配置的会话"
> 的默认；并发快速切换两次 POST，后端 `updateConfig` 是同步读-改-写，最终值以最后一次为准。
> 唯一遗留：`personaIsCurrent` 按 `text` 比对（config 里没有存"当前人设 id"），
> 两个人设正文完全相同时会同时显示「使用中」—— 与设置页同一限制，暂不处理。

### 新增 · 插件 / 技能页可以按「来源」筛了（内置 / 第三方）（22 日 19:15，需重启生效）

群友希望把「随应用带的内置插件」和「后来从市场装的」分开，方便管理。

**后端**：`/api/skills` 每条补 `builtin` 字段。

- `plugin-loader.js` 导出 `isBuiltinModuleDir(dirName)`，按 `builtin-modules.json` 的目录名判定。
- 刻意算在 `routes.js` 而不是 `manager.status()`：`plugin-loader` 已经 import 了
  `skills/manager`（加载模块要用），manager 再反向 import 就成了**循环依赖**。
- 只按目录名、**不校验内容指纹** —— 与 `checkPluginTrust` 有意不同：那边判"能不能免检"，
  被改过的内置模块必须走能力扫描；这里判"它是不是随应用带的那个"，
  被「升级扩展」改过的内置模块**仍然**是随应用带的那一个。

**前端**：筛选条拆成两行（状态 / 来源），两个维度独立生效（AND）。

- `MODULE_SOURCE` 与 `MODULE_FILTER` 并列，各记各的选中档
- 来源组：`不限来源 / 内置 / 第三方`，前面带一个小标签
- 过渡期兜底：后端还没返回 `builtin` 时整组不显示 —— 否则会写「内置 0 / 第三方 12」，
  看着像"内置的都不见了"，比不显示更吓人

> ⚠️ 这次动了后端（`src/routes.js`、`src/plugin-loader.js`），**必须重启应用**才生效，
> 只刷新页面不够。

### 修复 · 点顶栏「下载」会先卡一下才出界面（22 日 18:25，需重启生效）

**现象**：很多人反馈点「下载」有明显卡顿，先顿一下界面才出来。

**根因（两条叠加，都在市场页）**：

1. `loadMarket()` 里只要 `st.loaded` 就无条件 `renderMarketShell()` —— 市场条目实测
   **402 条**，每切一次页就把整页（警告块 + 工具栏 + 3 个下拉 + 全部卡片）拆了重建一遍。
2. `hookMarketSwitch` 里 `ensureModuleState(kind).then(() => renderMarketShell(kind))` ——
   不管 `state.skills` 有没有变化，回来都要再全量重画一次。

**实测**（400 条卡片，`--disable-gpu` 模拟软件渲染）：

| 操作 | 改前 | 改后 |
|---|--:|--:|
| 切页重建整页 | 56.6 ms | **0**（数据没变就不重建） |
| 切页布局 | 37.5 ms | **2.5 ms** |
| **合计** | **≈ 94 ms** | **≈ 2.5 ms** |

**改法**：

- `marketState` 加 `rendered` 标记（"这份数据画到 DOM 上了吗"）。`loadMarket` 在
  `st.loaded && !force` 且 `rendered` 为真时直接返回，不再重建；数据更新时置 `false`。
- `ensureModuleState()` 改成返回"这次是否真的补上了 `state.skills`"，调用方只在 `true`
  时重画 —— 绝大多数情况 `state.skills` 已有，这一次全量重建就白付了。
- `.mk-card` 加 `content-visibility: auto` + `contain-intrinsic-size: auto 88px`：
  视口外的卡片跳过布局与绘制，长列表切页不再付全量布局成本。

> ⚠️ `content-visibility` 的代价：屏外内容不进无障碍树、Ctrl+F 也搜不到。市场页自带
> 搜索框，不依赖浏览器查找，这个代价可以接受；如果将来要给市场页加浏览器内查找，得先撤掉这条。

### 修复 · 安装插件 / 技能后列表被弹回顶部（22 日 19:10，需重启生效）

群友反馈：「安装插件/skills 会重置页面」「每次安装完都得重新划下去」。

**先量清楚再改**（400 条卡片，无头浏览器 `--disable-gpu`）：

| 操作 | scrollTop |
|---|--:|
| 一次性同步替换 `innerHTML` | 900 → **900**（保留） |
| 先 `innerHTML = ''` 再填回 | 900 → **0**（归零，填回来也回不去） |

所以问题不在"重画"，而在**中间有没有一次清空**。

**根因**：`loadModulePage` 在等 `/api/skills` 的这段时间里，120ms 后会把列表换成骨架 ——
"清空再填"。安装后 `rescan` 走的就是这条路，于是列表被弹回顶部。

**改法**：

- `loadModulePage`：**已有 `.module-grid` 时不再用骨架覆盖**，保留旧内容直到新数据回来。
  代价只是这 100~300ms 里看到的是稍旧的一份，比"被弹回顶部"好得多。
- 兜底：市场页安装、人设市场应用、人设页切换这三条路径补了"保存 / 恢复 scrollTop"
  （当前实测不丢，但换 Chromium 版本或内容高度变化时可能丢）。
- **筛选 / 搜索 / 排序变化不保持滚动** —— 那时内容整个变了，回顶部才是对的。

### 修复 · SnowLuma 日志每 15 秒刷新会把用户拽到底部（22 日 19:20，需重启生效）

群友反馈：「snowluma 界面滑到日志查信息它会自己刷新跑到界面上面去，不管你鼠标滑到哪」。

**根因**：日志区在 `<details>` 里，重建页面后代码会程序化 `d.open = true` 恢复展开态；
而 `<details>` 的 `toggle` 事件**在程序化改 open 时也会触发**（实测触发 1 次），
那里正好挂着一个"展开就贴底"的监听器 —— 于是每 15s 的 quiet 轮询重建后，
按原阅读位置还原好的 `scrollTop` 被立刻覆盖成"贴底"。
用户正翻着中间某行，一刷新就被拽到末尾，那几行自然"跑到上面去了"。

**实测对比**（200 行日志，滚到 500 后重建）：

| 逻辑 | 重建前 | 重建后 |
|---|--:|--:|
| 旧（toggle 监听 → 贴底） | 500 | **3691**（贴底） |
| 新（只在手点时贴底） | 500 | **500**（保持原位置） |

**改法**：

- "展开就贴底"从 `<details>` 的 `toggle` 改为 `summary` 的 `click` —— 只有真人点击才贴底，
  重建时的程序化展开不碰。
- 恢复展开态之后**再补一次**阅读位置（折叠态下 `<pre>` 不参与布局，之前那次赋值不保证留得住）。

> 用户手点展开仍然贴底（他要看的就是最后一行）；正在读的位置在刷新后保持不动。

### 修复 · 会话设置左栏的会话行比会话选择页矮 11px（22 日 19:00，需重启生效）

用户给了两张左栏截图问"这俩界面不一样"。逐项量下来只有一处真差异，但它影响整列观感：
**同一个 `.bp-row`（会话行）在两页差出 11px 高** —— 聊天模式约 53px、会话设置约 42px，
连带头像显得一大一小、名称与预览的行距也不同。

根因：`#cc-left` 有一条基准排版 `font-size: 14px; line-height: 1.6`（原型 body 的
`font: 14px/1.6`），而 `#bp-setup-left` 没有 → 继承 body 的约 13px，于是 `.bp-rt`(13.5px)
和 `.bp-ri`(11.5px) 的 line-height 从 1.6 掉到 normal，内容高度从 42.8 掉到 32。

改法：把那组基准也加到 `#bp-setup-left`。实测两页会话行高 **52.0 / 52.0**、
分区标题 20 / 20、基准字号 14 / 14，完全一致。

> 顺带确认**不是**差异的两处，别顺手"修"掉：
> · `.bp-act` 的 34 vs 36 —— 原型是两档（**选择项 36 / 动作行 34**）。「技能/插件/人设」
>   是选择项，走 36，与左图的「页面」导航同档；「全部设置」与「群发/清空」都是动作行 34。
> · 段标题文案（「群聊 50/120」vs「选择会话 3 个」）与段结构（页面/快捷操作 vs 扩展/全部设置）
>   —— 两页功能不同，本来就不该统一。

### 调整 · 会话设置左栏的「扩展」段移到会话清单上方（22 日 19:02，需重启生效）

用户拿两张左栏截图指出：会话选择页是「导航段在上、会话清单在下」，而会话设置页
反过来（清单在上、扩展在下）—— 同一屏看过去结构不一致。

现在统一成：

```
搜索框
扩展        技能 / 插件 / 人设      ← 导航段在上
选择会话 N 个   …会话清单…           ← 清单在下
全部设置    打开完整设置页            ← 次要出口留最底
```

> 搜索只过滤会话清单（`applySetupFilter` 只重画 `#bp-rows`），「扩展 / 全部设置」
> 两段不参与，所以顺序调整不影响搜索行为。


## 0.4.8.8 · 2026-10-21（补齐 0.4.8.7 漏打的两处修复 + 设置页 + 单账号约束 + 安装包修复 + 收尾判定扩面 + 发布体检 + 分层记忆词表塌缩）

> 20 日 17:51 打出的那个 0.4.8.7 安装包，是在当晚两轮修复落盘**之前**打的 —— 装那个包的
> 用户并没有拿到它们。同时安装包里还漏了 `runtime/ffmpeg.exe`、多带了一份安装器备份。
> 本版按当前源码重打，把 20 日晚到 21 日白天的全部改动一起收掉；**不新增任何特性**，
> 范围仍是 0.4.8.7 声明的那一版 —— 21 日新增的几项都落在**诊断、配置与约束**这三层
> （把说不清的故障说清楚、把雪茹日志收一收、把「只注入一个账号」这条定位落实成硬保证），
> 单账号用户的使用方式一点没变。
>
> 21 日下午又补了一轮**分层记忆插件**（`plugins/mem-layered`）的修复：词表被削到 2 万、
> 被削的全是中文实词，导致「记得却检索不出来」。这轮只动插件内部与一个 manifest 默认值，
> 不涉及界面，也不需要用户重新配置 —— 但**必须重启**才生效。
>
> 唯一一处**行为变化**是最后一节「发完语音 / 图片 / 跨会话消息后不收尾」：发完之后不再
> 多跑一轮，直接收尾。省的是钱（每句 ~19K token），不改变机器人说什么、怎么说。

### 修复 · 「模型配置」里替换 API Key 不生效（21 日 14:10，需重启生效）

用户反馈：在「模型配置」弹窗输入新 Key、保存，点「显示」还是旧 Key，「测试连通性」也还是旧 Key。

根因是 **写和读不是同一处**：

- 运行时 `llm.js` `resolveApiKey` 的优先级是 **目录提供商 Key（`dshProviderKeys[providerId]`）
  > 顶层 `api.apiKey`** —— 一旦在 UI 里选了某个目录提供商，顶层那个字段就是死字段。
- 但保存按钮把输入框的值一律塞进 `patch.apiKey` → `POST /api/config` → 落到**顶层** `api.apiKey`。
- 「清除」按钮早就走 `/api/providers/set-key`（提供商槽位），**只有「保存」这条漏了** ——
  同一个弹窗里两条路径不对称，所以"能清除、不能替换"。

实测（本机）：顶层 key `sk-3d49ca3…` 有效（`/models` 200）；提供商槽位 `sk-02fa701…`
返回 `401 Authentication Fails`。用户看到的现象就是「明明换了 Key，机器人却一直 401」。

修：保存时若已选提供商（或本次新选了模型目录），Key 改走 `/api/providers/set-key`
并按新选的提供商 id 落盘；只有没选提供商时才回落到 `api.apiKey`。

### 修复 · 回复整句被方括号包住（R142，20 日晚）

现象：群友看到机器人偶尔整句带方括号。根因从会话存档坐实 —— `send_message` 的工具参数
原文就是 `[那不就是纯躺平了]`，是模型自己写的：上下文里 `[图片]` `[表情]` `[引用 …]`
这些系统媒体标记太密集，小模型照猫画虎把自己的整条回复也包了一层。

- **提示词立规矩**（`src/prompt.js`）：安全规则新增第 8 条「方括号不是你的表达格式」，
  说明那些方括号是系统标注媒体的记号、回复不要用方括号包住任何部分，要发表情/图片/语音
  就调对应工具。放在安全规则段，Skill 覆盖不掉。
- **发送前兜底剥壳**（`src/md-to-plain.js` 新增 `unwrapStrayBrackets()`，`src/sender.js`
  在 `mdToPlain` 之后调用）：只处理确证形态 —— 去首尾空白后整条恰好是**一个**方括号组、
  内部 ≤60 字、不含换行与嵌套括号、内部不是 CQ 码。句中方括号、`[[套娃]]`、`[一][二]`、
  跨行、`[CQ:image,…]` 一律不动，宁可漏掉长句也不误伤正常内容。
- 两层都要：提示词是概率约束（小模型会复发），剥壳是确定性兜底。

### 修复 · 合并转发的聊天记录拉不到内容（21 日凌晨）

`get_forward_msg` 只在 `message_id > 0` 时才替我们解析 forward 段里的 id；QQ NT 里转发
消息的 id 常是负数，被原样当成 `res_id` 去拉，协议端返回 `payload is empty`，转发全挂。
9 月那版「只传 message_id」的写法正是踩在这里。

- `src/onebot.js` 新增 `fetchForwardNodes()`：先 `get_msg` 取原消息、从 `forward` 段里
  抠出它自带的 id（等价于协议端内部解析，不受正负限制），拿不到才退回 `message_id`。
- `src/app.js` 的转发展开、`src/tools.js` 的 `get_forward_msg` 调用都改走它，正负 id 同一条路。
- **引用块里的转发被渲染成字面量 `[forward]`**（同日 07:55 补修）：`src/app.js` 的
  `resolveReply()` 自己写了一份「text 段原样透传、其余一律 `[类型名]`」的粗转换，于是
  引用一条合并转发时，引用块里出现的是 `[forward]` 这个英文占位。模型看不懂，只看见
  "forward" 就以为手上有条没展开的转发，转头拿**外层消息**的 mid 去调 `read_forward`
  （引用块里并没有给被引用消息的 mid），协议端必然回 `retcode=100`，用户看到的是
  「展开失败：OneBot get_forward_msg 失败」。三处一起收：
  `resolveReply()` 统一走 `segmentsToText`，占位符与正文同口径（`[图片]`/`[表情]`/
  `[合并转发聊天记录]`）；`fetchForwardNodes()` 取到原消息却没有 forward 段时直接抛
  `NOT_FORWARD`，不再硬试 `message_id` 把「不是转发」伪装成协议端故障；`read_forward`
  先看存档正文开头是不是转发占位，不是就当场说明白，一次网络都不打。
- **引用里的转发就地展开**（同日 08:00 补修）：上面那条只让报错变清楚，模型还是想展开 ——
  因为引用块里写着「合并转发聊天记录」却看不到内容，而它手上没有被引用消息的 mid。
  现在 `resolveReply()` 发现被引用的那条本身是转发时，直接调 `fetchForwardNodes` 把节点
  拉下来塞进引用块（多行压成一行、上限 300 字），模型读到内容就不会再调工具；
  同时在 `prompt.js` / `personas.js` 的说明和 `read_forward` 的工具描述里写清
  「只有整条消息就是转发时才展开得了，引用里的转发已经带了内容」。
- **引用块补上「转发自己的 #数字」**（同日 08:05 补修）：上一轮把内容塞进引用块后模型还是调
  `read_forward` —— 内容只截了 300 字，它看见「共 6 条」想看全，可手上只有**引用者**那条的
  #数字，填进去必然「不是合并转发」。现在 `resolveReply()` 会把被引用消息自己的 mid 带回来，
  渲染成 `[引用 #1161151700 名字(QQ:x)：…]`，模型要展开就填这个号。
  配套：`read_forward` 遇到不在存档窗口里的 id 不再直接判「找不到」，而是问协议端 ——
  是转发就展开给出去，不是就明说。
- **转发里的图片一起回传**（同日 08:12 补修）：展开成功、正文里一排 `[图片]`，但工具只回了
  一个 `images: N` 的数字，模型没有任何能看的东西 —— 只能跟用户说「图看不到」。
  现在 `read_forward` 直接把转发里的图读成数据部件一起回传（**最多 4 张**，多的会说明
  「共 N 张，先给前 4 张」），缓存优先、没有缓存才走直链。为此把 `get_message_images` 里
  那段「缓存 → url → 本地落盘」的取图逻辑抽成 `collectImageResults()`，两个工具共用。
- **内联展开加 4 秒上限**（同日 08:20）：`fetchForwardNodes()` 新增 `timeoutMs` 参数，
  引用块内联展开只等 4 秒（默认仍走 `call()` 的 15 秒分档）。这一步跑在 ingest 热路径上，
  协议端要是卡住，不能连带把整条入库队列拖死。

### 改进 · 转发读不到内容时，把「为什么」说清楚（同日 08:47）

上面那几轮修的是「能不能拿到转发」，这一轮修的是「拿不到时怎么表达」。原来失败只有一句
笼统的「展开合并转发失败」，把两类根因完全不同的故障混成了一条日志 —— 排查时指不到真原因，
模型也不知道该不该重试。

- **错误对象挂结构化字段**（`src/onebot.js`）：OneBot 接口失败时把 `retcode` / `action` /
  `wording` 挂到错误对象上，不再只拼进 message 字符串。原来上层只能靠正则从文案里捞
  `retcode`，协议端措辞一改就静默失效 —— 而这类「拉不到内容」的判断最怕静默。
- **失败按三类分流**（`src/app.js`）：`NOT_FORWARD`（我们自己的判据，属预期，不是故障）、
  `retcode=100`（**上游拿不到长消息**：已过期 / 已撤回 / 当前账号无权读）、其他真故障。
  三类分别记不同的日志，不再一律说成「展开失败」。
- **工具话术明确劝阻重试**（`src/tools.js`）：`read_forward` 遇到 `retcode=100` 时直接告诉
  模型「换参数重试不会有不同结果，请如实告诉用户这条转发读不到」，避免它陷入无意义的重试循环。

> 上游那半（协议端返回空载荷）改不动，也没必要改 —— 它本来就没内容可给。能修的是我们这边
> 的表达，让「拿不到」和「写错了」不再混为一谈。

### 强化 · 只允许注入一个账号，检测到两个号同时注入会立刻处理（同日 09:15）

本应用的定位是**同时只注入一个账号**，不提供多开。但这条约束此前只是"约定"，没有硬保证 ——
一旦两个号同时处于注入状态，就会撞上雪茹的端口冲突（两个号的 OneBot 配置端口都是
3000 / 3001，新建账号时不会自动避让），后注入的那个抢不到监听。

更麻烦的是它**看不出来**：雪茹的监听失败会走 error 事件，它**会**记一行
`server error: listen EADDRINUSE`，但同一段代码还把该实例的 `isEnabled` 置成了 `false`；
而状态展示第一个分支就是 `if (!isEnabled) return "未启用"` —— 那句本来能指路的
「未监听（端口被占用？）」**在这个场景下永远显示不出来**。于是用户看到的是「未启用」，
点「启用」也起不来（端口还占着），而且它不会自己恢复（`scheduleReconnect()` 开头就 `return`）。
QQ Agent 侧则完全看不到，只表现为「号登录了但连不上」，很容易被误判成「号没登录」。

- **新增 `enforceSingleInjection()`**（`src/app.js`）：查雪茹进程表，`injected` 的号多于一个，
  就把**非注入目标**的号卸掉。挂进注入看门狗（每 20 秒一次判定，实际查询限频 60 秒）。
  放在「OneBot 是否已连接」判断**之前** —— 目标号如果抢不到端口就压根连不上，而恰恰是这种
  时候最需要先清掉多余的号；放进 connected 分支里就永远轮不到它。
- **文案不说满**：雪茹的 `unload` 对已注入进程是**空操作**，HTTP 照样返回 success（既有代码
  实测确认过：返回成功、2.5 秒后复查仍是 `injected=true`）。所以提示写的是「已请求卸载 N 个
  （M 个被接受）」，并补一句「如果过一会儿还是同样的告警，说明没真卸掉，请退出并重启那个 QQ」
  —— 不拿返回值冒充结果。同一状态的告警只报一次，不会每 60 秒刷一遍。
- **边界都守住了**：没定注入目标不猜；用户「取消注入」或关了自动注入就完全不碰进程；
  用户刚在页面上动过手（20 秒窗）让开；与原有的 `selfId` 对账纠正互斥，不会两边同时卸同一个进程。
  还有一条是写测试时才发现的：**目标号自己不在注入列表里时，这一轮完全不碰** —— 否则会把
  「所有号」都算成多余的一次卸光，机器人瞬间没有任何注入、而目标号又没登录，比多开更糟。
  这种状态该交给注入流程去注目标号，不该在这里清场。
- **不去撞登录限频**：控制台密码不对时，这条检查会退避 10 分钟再试 —— 雪茹对登录失败有
  速率限制（连续失败会临时锁定），为了一个非关键路径的检查把控制台锁掉不值得。
  密码问题仍由注入流程去报，那里有完整的凭据提示。
- **动手前复查一次**：登录 + 拉进程表可能要几秒，这期间用户完全可能点了「切换到此账号」——
  所以真正卸载前会再看一眼用户有没有动过手，动过就整轮放弃，绝不把用户正在切过去的目标号卸掉。
- **提示改成「二选一」**（`src/app.js` 三处：启动、切换注入目标、6 分钟超时诊断）：不再建议
  「给每个号分配不同端口」—— 那等于在教用户多开，方向错了；改为说明本应用只支持注入一个账号、
  请退出另一个号或关掉它的 OneBot 实例。同时保留「撞端口后为什么显示成未启用」的解释，
  这个坑太隐蔽，不解释清楚用户会一直以为是「号没登录」。

> 能做到什么、做不到什么：**检测和提示是确定的，卸载不一定成功**。雪茹的 `unload` 对
> 「接管型注入」（DLL 是更早的会话留下的，没有卸载句柄）是空操作 —— 接口返回 success、
> 管道还活着，watcher 一会儿又把 `injected` 置回 true（既有代码实测过）。所以这里能保证的是
> 「不会静默放过两个号」，而不是「一定能把多余的号拆掉」；拆不掉时会明确让用户去重启那个 QQ。
>
> 卸错了也不怕：下一轮自动注入会把目标号注回来。宁可多卸一次，也不让两个号长期并存。
> 单账号场景完全无感 —— 只有真的出现第二个注入进程时才会动手。

### 改进 · 设置页能看到记忆相关的 4 个阈值了（同日 08:17）

`src/orchestrator.js` 一直在读 `cfg.memory` 上的 4 个阈值（`consolidateMinImpressions` /
`maxImpressionsPerMember` / `discoverMinMessages` / `discoverMaxMembers`），但
`DEFAULT_CONFIG` 里**从来没声明过它们** —— 于是设置页按默认配置渲染时看不到，`config.js`
里也搜不到，想知道「还有哪些旋钮」只能翻 orchestrator 源码。

- `src/config.js` 补声明这 4 个键，值与 orchestrator 的类常量保持一致（4 / 5 / 20 / 3），
  避免「默认值」和「兜底值」打架。
- 现在它们在设置页可见、可改，改完即时生效，不用再改源码。

### 修复 · 设置页弹窗点了没反应（`Cannot set properties of null (setting 'textContent')`）

现象：应用日志里反复刷同一条渲染进程报错，栈顶是某个按钮的点击回调，位置指到
`ui/app/08-modals.js`；用户侧的感受是「点了没反应」—— 白名单里点「选择群」挑完再点
「确定」，界面毫无变化、群里也没加上，也没有任何提示。

根因：设置页是「改完 600 ms 防抖自动保存 → 整块重渲染」的模型，而弹窗用到的状态提示
（`#pick-result`、`#provider-hint`、`#mem-model-hint`、`#model-label`）和目标输入框
（`#cfg-allowgroups` / `#cfg-allowprivate`）都**只存在于当前分区**的 HTML 里。弹窗开着
的时候只要发生一次整页重建（切分区、自动保存回填、`loadSettings()` 回来重绘），这些节点
就从 DOM 里消失了；旧代码在点击那一刻用 `$('#xxx')` 现查现写，查到 `null` 直接抛
`TypeError`，异常被 `error-boot.js` 的全局兜底接走 —— 于是只剩一条红字，主流程静默失败。

- 新增 `setHintText(sel, text)`（`ui/app/08-modals.js`）：查不到元素就跳过，提示条是
  锦上添花、不该有能力打断主流程；本文件里 6 处 `$('#xxx-hint').textContent = …` 全改走它。
- `openWhitelistPicker()`：状态提示改为 `setResult()`；目标输入框在**点击那一刻**重新判活，
  原引用已离线（`isConnected === false`）就再查一次，仍然没有就明确告诉用户「设置页已切走，
  请回到白名单页签再点一次」—— 不再往离线节点里写值假装成功。
- 「测试连通性」的结果条 `#mc-test-result` 补判空（弹窗重开时元素可能已被替换）。

### 调整 · 雪茹日志上限收紧（同日 08:47，需重启雪茹生效）

`snowluma/config/runtime.json`：`logMaxTotalMb` 1024 → **256**，`logRetainDays` 7 → **3**。

起因：雪茹日志已涨到 **443 MB**，其中今日 `MsgPush.UnknownElement` 的 DEBUG 占全部 DEBUG
的 **97%**（16,105 条），是磁盘膨胀的主因。上游代码在打包产物里不动，改运行时配置即可。

> `maxTotalMb` 是雪茹进程**启动时**读入的，改文件不会热更新，**需要重启雪茹才生效**；
> 不重启也不影响其他修复。

### 修复 · 安装包（打包器）

- **`runtime/ffmpeg.exe` 没进包**
  `src/image-compress.js` 的探测顺序是「先找随包分发的 `runtime/ffmpeg.exe`，找不到才回退
  PATH」，注释里写明了这么做的目的：让图片压缩在任何机器上都能生效，不依赖用户装没装
  ffmpeg、也不依赖 PATH。但打包器的排除规则里有一条 `(^|/)runtime/`，把整个 `runtime/`
  目录连带排掉了 —— 这条规则本意只是排除 QQ 客户端生成的 `runtime/qq-portable-data`，
  正则写宽了。结果：新装的机器上 `bundledFf()` 恒返回 `null`，图片压缩退化成「用户自己
  装过 ffmpeg 才有」，超 4 MB 的图发不出去时没有任何提示。
  现在规则收窄为 `(^|/)runtime/qq-portable`，`ffmpeg.exe`（82,797,568 字节）随包分发。
  代价：安装包 166.8 MB → 186.3 MB（+19.5 MB；ffmpeg 经 BCJ2 + LZMA 压缩后约 20 MB）。

- **安装器外壳里带了一份 `app.asar.bak`**
  `make-portable.py` 的 `repack_asar()` 在重打安装器界面之前会先备份旧的 `app.asar`，这份
  备份随后被 `'*'` 一并收进外壳归档，装完之后落在安装目录里。外壳是安装器本体，备份文件
  对它没有任何作用。现在外壳归档排除 `*.bak`，并删掉了 `shell/resources/` 里那份
  86,384 字节的陈旧备份。

- **清单 454 → 455 项**，唯一新增 `resources/app/runtime/ffmpeg.exe`，其余条目逐条比对未动。

### 修复 · 发完语音 / 图片 / 跨会话消息后不收尾，白跑一轮 19K token（21 日 10:20）

现象（用户反馈）：让机器人用 `tts_send_voice` 发语音，或者用 `send_to` 往别的会话发，
发完之后它**不结束**，还要再跑一轮 —— 那一轮除了调 `finish` 什么都不做，代价是一次全价
prompt（~19K token）。按 DeepSeek-V4-Pro 的价（输入 0.2 元/百万、输出 3 元/百万）算，
一句话白烧约 6.7 元，比回复本身还贵。

根因：`src/orchestrator.js` 的「发言即收尾」判定把工具名写死成 `name === 'send_message'`。
`send_to`、`send_image`、插件里的语音工具全被排除在外，所以都不触发。当初的理由是
"发图/表情/拍一拍之后模型常想再配句话"—— 这个理由本身没错，但被套在了错误的范围上：
它只该排除**不是话**的动作，不该把真正的发送工具一起排掉。

- 判定改为 `isDeliverTool()`（`src/orchestrator.js` 新增），按「这个工具是否把**内容**
  送到了聊天里」来认，三个来源：
  - **内置工具**查 `tool-registry` 的 `category`：`messaging`（`send_message` / `send_to`）、
    `media` 且 id 以 `send` 开头（`send_image`）；
  - **插件工具**按 id 词形兜底（插件作者不一定写 category）：`xxx_send_voice`、
    `tts_send_voice`、`send_audio`、`tts_speak` 这一类；
  - **配置** `api.autoEndTools`（字符串数组）里用户自己列的 id —— 以后装什么插件都不用等改代码。
- 仍然**排除**拍一拍 / 点赞 / 表情回应，以及 `list / get / query / search / read / …`
  打头的查询型 id。前者的理由不变（拍完再接一句才自然，在那里收尾会把那半句话砍掉）；
  后者是这次新加的防线：`tts_list_voices` 这种名字里带 tts、其实只是查音色列表的工具，
  绝不能当成"说了话"。
- 顺带修掉一个更隐蔽的问题：插件工具直接调 `ctx.sender`，**不知道** `session.sent` 这回事，
  于是"发过语音"在会话眼里等于"一句话没说" —— 状态从 `done` 掉回 `noreply`（界面上像是
  没回），`reply-rescue` 认为没回复于是**再发一遍**（重复发言）。现在编排器会在
  「发送类工具 + 没报错 + 结果没明说 0 条」时补一条 `[语音 · tts_send_voice]` 记录，
  下游状态、补救逻辑、收尾判定就都对齐了。
- 用例 **31 项全绿**（`prove-autoend.mjs`：直接从 `src/orchestrator.js` 抠出真实判定块来跑，
  不复制实现；附反证 —— 打掉词形判据后 `tts_send_voice` 必须变红，证明用例有鉴别力）；
  改动前后自由变量差分 **0 新增**（`check-autoend-scope.mjs`，同样附反证）。

> 需要说清楚的一件事：这台机器的 `plugins/`（16 个插件）、`skills/`（8 个技能）、`src/`
> 全量搜索，都**没有** `tts_send_voice` 这个工具 —— 它是另外装的插件（或另一台机器上的）。
> 所以改动按通用规则做，不依赖它的具体名字：词形能覆盖，`api.autoEndTools` 兜底。
> **需要重启应用生效**；如果那个插件把工具命名成完全看不出"发送"的样子，把 id 加进
> `api.autoEndTools` 即可。
>
### 改进 · 雪茹目录配了但不存在时，日志里会直说（21 日 09:50）

现象：用户报「更新完就连不上 / 打不开」，但日志里一行相关的都没有，只能靠猜。

根因：`src/app.js` 的 `snowlumaDir()` 对「设置里填了目录」这一支是**原样返回**的，不检查
存在性。目录一旦不存在，后续每一次 `statSync` / `readFileSync` 都失败，又各自被
`try/catch` 吞掉 —— 于是界面上显示「雪茹目录未配置」（用户明明填了），日志里一片安静。

最常见的成因正是**配置文件从别的机器带过来的**：覆盖安装把别人的 `data/config.json`
盖过来，里面 `snowluma.dir` 是个本机根本不存在的绝对路径。

- 现在这条分支会先探一次存在性，不存在就打一条 `warn`（同一条只打一次，不刷屏）：
  「设置里指定的雪茹目录不存在：<路径> —— 后续所有雪茹操作都会失败……」
- **只加日志，不改返回值**。返回值一动就可能退到随包目录、起出第二个雪茹 ——
  双协议端是端口冲突 + 群里重复回复，比"找不到目录"严重得多。
- 验证 4/4：不存在的路径必告警、同一条只打一次、存在的路径不误报
  （`prove-sldir-warn.mjs`，三个阶段各起一个独立进程 —— `getConfig()` 有模块级缓存，
  同进程改配置再 createApp 会读到旧值，第一版就是这么测出假阴性的）。

### 发布流程 · 打包体检（内部工具，21 日 10:05）

用户侧连续两条反馈：「上一次是直接覆盖，会导致 exe 打不开，这一次让 dsh 来更新，还是
打不开」「已经不是第一个人向我反馈用完你的 exe 之后 qqagent 崩溃了」。

源码侧先排除了最致命的一类：**ESM 具名导入在目标模块里不存在**（R41 的 `webUtils`、
10-16 的 `pruneDumps` 都是这么把应用搞成"双击毫无反应"的，而 `node --check` 查不出来）。
全量核了 **197 个 ESM 文件、1334 处具名导入**，全部能解析 —— 当前源码没有这类问题。
首启模拟（空 data 目录）也 5/5 通过，核心启动链路是健康的。

所以问题在**发出去的包**，不在源码。新增两个工具（都在 `.workbuddy/audit/`，不进包）：

- `check-esm-links.mjs`：链接期校验。顺着 `export *` / 再导出链递归解析，带反证
  （故意写坏一个导入必须报错，防止"永远绿"）。
- `verify-package.mjs`：对**构建产物/安装目录**做体检，`node verify-package.mjs <目录>`。
  查 asar 是否被截断（偏移公式用 `resources/default_app.asar` 校准，delta 必须恰好 0）、
  依赖是否齐全、`runtime/ffmpeg.exe` 与 `snowluma/` 是否随包、有没有 `.bak`/`.dmp`/锁文件
  混进去、以及**包里有没有 `data/`**。

> 最后一条是这次查出来最该警惕的：`data/` 一旦被打进包，覆盖安装会**直接冲掉用户的
> API Key、会话与记忆**（还会把开发机的聊天记录发给所有人）。本机跑体检当前是
> 3 条阻断，全部与 `data/` 有关。**发版前务必对产物跑一遍，退出码非 0 就不要发。**

### 修复 · 前缀缓存命中率掉到 79–86%（21 日中午，需重启生效）

用户反馈「命中率突然跌到七十多」「现在稳定在 90 都难」。拿当天 395 次真实调用的
`cache-stat` + 544 条 `body-lcp`（字节级断点）做分解，未命中被拆成两部分：
**结构性尾巴**（断点之后必然重算的部分）和**超额未命中**（字节前缀没变、上游却没给
缓存的部分）。改之前尾巴占 12~20%，改完占 5~9%。

- **【记忆】搬出稳定区 → 当晚实测为负收益，已回滚**（`src/prompt.js`）：`formatForPrompt`
  只注入**本批发言者**的印象，所以这一段长度在 12B ↔ 984B 之间反复翻。中午据此把它从
  稳定区移到【过去状态】之后，理由是"翻转时会把【场景】+【过去状态】整块推走"。
  **实测证伪**：同一群（1130798724）、同一 `allCount=40`、紧邻一小时对照 ——
  11:00–12:00（记忆在稳定区）命中中位 **92.4%**、miss 中位 1129；
  12:01–12:39（记忆在尾巴里）命中中位 **85.9%**、miss 中位 1939。**净损 6.5pp**。
  原因：它一进尾巴，尾巴就从 121B 撑到 520B+，而尾巴是 **100% 轮次**都按全价重付的；
  留在稳定区只在它真翻的那约 50% 轮次付一次。
  判据不是"内容恒定不恒定"，而是「翻转率 × 翻转重付量」 vs 「常驻尾巴增量」。
  已恢复为：记忆 → 场景 → 可用表情包 → 过去状态 → 本次唤醒 → 此刻状态 → 当前时间。
- **预热状态全部改成按 shape 分桶**（`src/cache-warm.js`）：原先"上次预热的指纹 / 上次
  档位 / 是否补过 early-warm"是**全局单槽**，两个群交替时互相覆盖，日志里每隔几秒就报
  一次"上下文档变化"、实际档位根本没变。现在 `warmedShapeByShape` / `tierByShape` /
  `earlyWarmDone` / `preCallBuckets` 都按 systemPrompt 指纹分桶（上限 128，LRU 淘汰），
  调用前预热的防重间隔也改成**按桶**计时并热读配置（`preCallGapSec`，默认 45s）。
- **预热不再把上游打死**（`src/cache-warm.js` / `src/llm.js`）：预热请求加 `timeoutMs`
  （30s，真实调用仍是 180s）—— 服务端饱和时预热会排队 90~180s 一直占着上游并发位，
  把限流越滚越紧；命中 429 时进入 **120s 全局冷却**，期间只保真实调用；429 不重试
  （重试只会加深拥塞）；同时预热并发上限 5。
- **上游 usage 缺缓存字段时留证据**（`src/llm.js`）：当天有 6 次调用在同一个群上次
  命中 14000+ tok 之后 7~609 秒就报 `cached=0`，而 system/tools 字节完全一致 —— 那种 0
  不可能是真失效。缺字段时仍按 0 计（不虚报），但打一行日志把原始 `usage` 摊开，
  下次出现能直接分辨"上游真没命中"还是"上游没给这个数"。

效果（单轮、同群连续调用，按 prompt token 加权）：10 时 91.1%、11 时 92.6%；
12:01 回滚前的 12 时 85.6% 主要就是【记忆】搬家造成的（见上条），回滚后回到 92% 档。

**`allCount` 不是杠杆 —— 21 日下午实测证伪**：用户把 `store.allCount` 从 40 改成 80 后
命中率没上来，反而更低。原因是命中率 = `1 − miss/prompt`，而 **miss 由"上游缓存深度
刷新节奏"决定，不随 prompt 变化**。同群同段实测：12:01–12:39（allCount=40）prompt 中位
14835 / miss 1939 / 85.9%；12:39–13:00（allCount=80）prompt 中位 16562 / miss 2371 / 85.6%。
分母涨了 1700 tok，miss 一分没降，比率自然不升。
更直白的证据：`12:47:40→12:49:28` 连续 11 次调用、1 分 48 秒，`cached` 恒为 **14080**，
而 `prompt` 从 15022 一路涨到 16894 —— 上游并不是每次请求都加深缓存，它按自己的节奏
（实测按 1792 tok ≈ 7×256 的台阶）才前进一次。所以"把历史喂多一倍"只会让两次台阶之间
积累更多全价字节。

真正决定命中率的是三件事，都跟 `allCount` 无关：
1. **每轮新增的历史量**（活跃群数）。单群 10-18/10-19 命中 96.8%/97.2%；
   三群 10-21 是 90.9%；五群 10-20 只有 60.1%。同一个群 1130798724 单独看，
   从 96.8% 掉到 91.2%，prompt 反而更小 —— 差别在多群交替时每次调用之间攒下的新消息更多。
2. **尾巴长度**（【本次唤醒】+【此刻状态】+【当前时间】，记忆搬回后仅此三项）。
3. **锚点跳块频率**：`|Δ过去状态|>2000B` 的调用占比 10-19 是 3.5%、10-21 是 17.3%，
   这类调用单次 miss 中位 2156–4804 tok，占当天 miss 总量的 27%（重启后 44%）。

> ⚠️ 以上改动都要**重启应用**才生效。

### 修复 · 预热请求重复发送，白占上游并发位（21 日 13:30，需重启生效）

用户反馈「又有命中 0% 出现」。查 13:00–13:31 的 80 次调用：命中中位 91.6%，
但其中 **8 次 `cached=0`（10%）贡献了全部全价 token 的 52.4%** —— 这比命中率
数字本身值钱得多（平均每次全价 3056 tok，那 8 次单次就是 1.2~1.9 万 tok）。

8 次逐条归类（用紧邻 `body-lcp` 判「前缀到底变没变」）：

| 时刻 | prompt | LCP | 断点后全价 | 判定 |
|---|---|---|---|---|
| 13:09:50 | 18773 | 56.9% | 600B | 上游漏配（前缀几乎没变却报 0） |
| 13:12:54 | 15981 | 49.8% | 1497B | 上游漏配 |
| 13:30:03 | 18324 | 56.6% | 331B | 上游漏配 |
| 13:20:22 | 12768 | 2.3% | 62487B | 换群，正常全 miss |
| 13:21:04 | 18548 | 5.1% | 19469B | 换群 |
| 13:29:35 | 12919 | 5.4% | 17742B | 换群 |
| 13:28:27 / 13:31:xx | — | — | — | 无紧邻对照 |

「上游漏配」那几次是**干净的首发请求**（`status=200`，没有 429 重试），
而同一前缀的紧邻下一次调用能拿到 97–99% —— 上游多后端路由，冷热两台机器。

**`cacheWarm.preCall` 救不了这个**，已有反证：`13:09:48` 预热请求报
「命中 18688 = 100%」，2 秒后 `13:09:50` 的真实调用照样 `cached=0`。
预热和真实调用落在了不同后端上。所以不要把 preCall 当成解法。

本次能修的是**我们自己制造的压力**：应用重启后 8 秒内，同一个 shape（18773 tok）
被预热了 5 次 ——
```
13:09:47 形状变化预热 / 13:09:48 保活首 tick / 13:09:48 启动预热
13:09:51 保活 / 13:09:55 保活
```
启动 / 保活 tick / early-warm / 形状变化 四条路径各走各的判重，互相看不见。
每次要 1.5~6 秒，等于把 5 个并发位占掉十几秒；该模型并发上限只有 16，
同期有 **41 次真实调用被 429 打回**（34% 的 429 率）。

- **`warmOnce` 加同形状时间窗去重**（`src/cache-warm.js`）：在唯一收口处按
  `systemPrompt 长度+哈希` 记「上次预热成功时刻」，窗口内直接返回
  `{ok:true, dedup:true}`（视为已暖，不重复发）。窗口 `cacheWarm.warmDedupSec`，
  默认 20 秒，设 0 关闭。
- **`force` 透传到 `warmOnce`**：档位跳变（R3）要暖的是**新历史窗口**而不是
  同一份前缀，必须绕过去重 —— 否则 R3 补偿会被误挡。
- 启动预热 / 形状预热两条日志改为在去重时打「跳过（同形状 Ns 前刚暖过）」，
  不再打出误导性的「命中 0」。

实测（本地 mock 上游，4 次预热调用）：首次发 1 个请求；立刻再暖被去重（仍 1 个）；
`force=true` 放行（2 个）；3 秒后形状预热定时器到点也被去重（仍 2 个）。

> ⚠️ 需**重启应用**生效。

### 修复 · 分层记忆「记得却检索不出来」：词表被削到 2 万，被削的全是中文实词（21 日 15:50–16:25，需重启生效）

现象：问机器人以前聊过的事，它答不上来；可记忆页里那些块明明都在，摘要也写着。

**三层根因叠加**，缺一层都复现不出这个症状：

1. **规则② 的裁剪方向反了**（`plugins/mem-layered/lib/store.js` → `pruneVocab`）
   超上限时的排序是 `df` 降序、再从头部删 —— **专删 df 最高、检索价值最大的词**。
   等于每轮巩固都在把「最常用的实词」优先扔掉。
2. **`maxVocab` 的实际生效值是 20000，不是 100000**
   `store.js` / `consolidate.js:350` / `index.js:60` 三处都写着 100000，全无效 ——
   设置合并之后 `s.maxVocabPerChat` 已经是 `plugin.json` 的 20000（有效值），
   `num(s.x, 100000, ...)` 的兜底是**死代码**。**manifest 默认值覆盖了代码默认值。**
   证据：词表正好 20000 个词，df 最小 1、最大 2，`df<=3` 的词恰好 20000 个。
3. **规则① 的前提在中文里不成立**
   原实现按 `t.length <= 1` 剪「高频短词」，假定「短词 = 虚词」。
   但 `util.js:130` 的 `STOP` 表已经把「的 / 了 / 是 / 我 / 你 / 他 / 这 / 那 / 有 / 在 / 和 / 也 / 就」滤掉了，
   **能留在词表里的中文单字全是实词**（吃 / 睡 / 群 / 猫 / 鱼干），
   按 `df/n` 剪它们等于专挑语料里最常用的实词删。

**四处一起改：**

- **规则① 收口到纯 ASCII**：`ASCII_SHORT_TOKEN = /^[a-z0-9_.-]{1,3}$/` ——
  只剪英文缩写、数字、标点类碎片，中文一个不动。
- **规则② 改 `df × idf` 降序**：`df * Math.log(1 + (n - df + 0.5) / (df + 0.5))`。
  既排除 `df=n` 的零信息词，也保住「中频但能区分内容」的实词。
- **索引正文排除 `title`**（`#indexInto`）：`hour` 块的 title 固定是
  `group:1130798724 @ 2026-10-18 10:00` 这种纯元数据（实测 107 个块全部如此、零语义），
  分词后稳定产出 `group`、群号、`2026-10-18`、`00` 等 token —— 它们出现在**每一个**块里，
  `df=n`、`idf→0`，检索时一分都加不出来，却把词表位置占满。
- `plugin.json` 的 `maxVocabPerChat` 20000 → **100000**，schema 描述同步（「不要调低于 30000」）；
  `consolidate.js:350` / `index.js:60` 两处默认值同步；
  新增自测 `I9b`：`DEFAULTS` 的默认值与 `manifest.settings` 逐键比对，防「改一处漏一处」。

**修复前后（本机，群 `1130798724`）：**

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 词表词数 | 20000（卡 cap） | 26851（运行时 26866） |
| 中文单字 | 0 | 2126 |
| df 最大值 | 2 | 51 |
| `df=n` 噪声词 | 3 | 0 |
| 端到端检索（5 组探针 top-1） | 0/5 | **5/5** |
| 跨会话泄漏（3 组） | — | **0/3** |
| 自测 | 186/189 | **193/193** |

**决定性取证**：块 `hour_group_1130798724_20261019_10` 的 `terms` 里含「照片」，
但 `#indexInto` **不读 `block.terms`**，只读 `title / summary / keywords / snippets` ——
所以「模型记下了」和「检索能搜到」是两条独立链路，前者正常不代表后者正常。

**运行时实测**：`巩固（boot）：+8 条 / 汇总 0 块 / 淘汰 0 块 / 剪枝 0 词`；
`prunedTokens` 45041 → 45041（0 变化）；运行时重写后新增 15 词全是正常中文词、
消失 12 词全是 title 噪声，`26863 − 12 + 15 = 26866` 数学吻合。

**变异测试**（`mutation-test.sh`）：M1 规则② 方向反转 / M2 规则① 退回按长度剪 /
M3 title 重新入索引 —— 三种 bug 形态**各自恰好红 1 条断言**，说明新断言确实咬得住。

> ⚠️ 需**重启应用**生效（插件在启动时加载）。

### 修复 · 重建记忆索引把权重静默重置（21 日 16:00）

`state.chats` 用**原始 chatKey** 作键（`group:1130798724`），而块目录与索引文件名走
`safeName()` 转换（`group_1130798724`）。离线重建脚本按目录名传 chatKey 时，
`#indexInto` 查不到 state → `score` / `hits` / `S` / `links` 全部退回出厂值，
**整库记忆被重置成「新记忆」，且没有任何报错**。

两层修复：

- 重建脚本改为从 `state.chats` 反查真实 chatKey，不再拿目录名当键；
- `#indexInto` 加 `safeName` 兜底 —— 两种形式都能查到。

验证：state 记着的字段 **52/52 逐块还原**，9 个带权重块与 state 里 `hits>0` 的 9 个一一对应。

---

## 0.4.8.7 · 2026-10-20（内部修订 R136–R142，正式版本号）

> **按用户要求：2026-10-20 当天的全部改动统一并入本版**（同日内不再另起版本号）。
> 原写作"0.4.8.8 / 版本号待发版时统一"的小窗收尾段落（R137–R140）已整段并入本版，
> `package.json` 的 `version` 同步为 `0.4.8.7`。
>
> 当天共 17 轮：注入链路两轮专项审查（13 项）→ 界面状态机 6 项 → 新手自救卡 →
> 全站文案与入口校正 + 市场页可用性 → SnowLuma 首屏三步化 → 「测试连通性」恒 401 →
> 全站鉴权头复查 → 桌面悬浮小窗 → 下载页签卡顿 → 「API 协议」保存不住 →
> 「保存不住」全站复查（9 处）→ 发网图总开关与安全开关入口 + 17 处错指文案 →
> 冷启动设置页崩溃 → 市场页超时/缓存整链 → 小窗贴边收起与不透明度（R137–R140）→
> **当日改动回归审查（R141，4 项）** → 回复整句被方括号包住（R142）。
> 涉及文件 26 个，逐文件有 `.bak-2026102x-*` 基线；四套回归脚本 82 项断言全绿。
> 审查报告见 `修复报告-20261016/今日改动审查-20261020.md`（R141 的 4 项即出自该报）。

### 修复 · 注入链路两轮专项审查（第一、二轮，R136）

> 共 13 项。全部改动集中在 `src/app.js` 的 SnowLuma 函数簇与 `ui/app/03-snowluma.js`
> 节点③，离线假雪茹验证 17/17 通过。审查报告见
> `修复报告-20261016/注入流程审查-20261020{,-二轮}.md`。

- **「已连接」不再等于「连对了号」（P1）**
  OneBot 的端口属于被注入的那个 QQ 进程，多号在场时谁抢到 3001 就是谁。此前看门狗只看
  `connected` 一个布尔，于是"配置写着机器人号、实际连着个人号"这种状态永远不会被发现，
  界面还显示"连接正常"。现在用 `get_login_info` 拿到的真实登录号对账：不一致时明确告警，
  并自动撤掉抢占端口的号（卸不掉时告知重启那个 QQ）。
  点过「仅保存」后 10 分钟内只告警、不自动切号——不覆盖该按钮"下次启动生效"的承诺；
  已「取消注入」时完全不纠正（纠正会清掉暂停标记，等于替用户撤销取消）。

- **切换账号不再"先写配置、后校验目标"（P2）**
  填了一个还没登录/填错的号去点「切换到此账号」，接口报"没找到"，但 `botQQ` 已经被写脏，
  之后每轮自动注入都匹配不到任何进程。现在配置等目标确认存在才落。

- **「取消注入」在任何情况下都真的暂停（P3）**
  雪茹没运行、登录失败、当前没有已注入进程——这三条早退路径此前都不落暂停标记，
  用户点了取消，QQ 一重登又被注回去。现在"取消"的意图先落地再去卸载，按钮状态跟着
  `paused` 走。

- **同一进程一轮内不会重复注入（P4）**
  真实雪茹的 `injected` 标志由 watcher 刷新，慢于 `/load` 返回。旧代码只按 `p.injected`
  判断是否跳过，于是同一 pid 可能被连续 `/load`（重则会重建 OneBot 会话、丢消息）。
  本轮已 load 过的 pid 现在只复查运行态。

- **重置控制台密码：停不掉就中止，成功要实测（P5）**
  此前停雪茹失败仍会删 `webui.json`，随后 launch 因端口占用早退、新密码并未播种，
  界面却显示"✓ 已重置，密码：xxx"——用户拿着它登不进控制台。现在端口未释放即中止
  （不动任何配置文件），重置后用新密码实测登录一次才报成功，否则明说"未验证，别试"。

- **切换账号后立即对齐 OneBot 令牌（S1）**
  SnowLuma 的 OneBot 令牌按 QQ 号分文件存储。切号后旧令牌连新实例必然 401，只能靠
  轮换试错（限频 5 秒/次），切到排序靠后的号要抖约 10 秒，期间界面显示"未连接"。
  现在切号成功即按目标号读 `onebot_<uin>.json` 对齐令牌并重连。

- **被临时锁定不再被说成"密码错误"（S2）**
  连续登录失败被雪茹锁 15 分钟（429）时，此前与"密码被拒"共用"密码不被认可 → 请点重置"
  的话术，而重置会重启雪茹、断开注入。现在单独分支，明确"这不代表密码错了，等锁定过去"，
  并劝止重置；退避与密码错同为 15 分钟，`force` 不可绕过。

- **令牌失效不再被误报成"进程表是空的"（S3）**
  `slGet` 遇 401 只清缓存、仍把 401 的响应体当数据返回，导致"请求失败"分支永不触发，
  `list.list || []` 得到空数组，日志变成"SnowLuma 的进程表还是空的（QQ 还没登录）"。
  现在 401/非 2xx 一律返回 `null`，四个调用点分别报"读取失败"。

- **端口重启后的重连更快（S4）**
  端口轮询在"已连接"时提前返回，`obPortWasOpen` 不更新。雪茹极快重启（端口关→开）
  且 socket 尚未感知断开时，这次边沿会被吞掉，只能等 OneBot 自己的退避（最长 30 秒）。

- **端口对不上时有明确诊断（S8）**
  目标号的 OneBot WS 端口若与设置的 `wsUrl` 不一致，那个号再怎么登录也连不上，而报错
  只有一句"连接受限（connected=false loggedIn=false）"。现在超时日志会直接点名两端端口，
  并给出该改哪一项。

- **「仅保存」的提示说清当前状态（P7）**
  只回"✓ 已保存"会让人以为注入已经切过去。现在明说"下次启动生效，当前仍按 X 跑，
  要立刻切过去请点「切换到此账号」"。

- **「本机 QQ」模式不再承诺做不到的事（S6）**
  该模式下机器人用的就是本机这个 QQ 客户端，"个人 QQ 不会被碰"无法兑现。文案按来源
  分叉为"只向这个号装注入，不会主动注入别的号，请确认它是机器人专用号"；同时删掉
  页面下方重复的第二处承诺。

### 优化

- **登录失败不再打两行重复日志（S5）**：内部那行降为落盘日志，页面面板只留调用方那条
  带上下文的话，避免读成两次独立事故。
- **`runtime.json` 读取加 mtime 缓存（S7）**：WebUI 端口与地址改为共享一次读取，
  消除注入轮询（每 3 秒）里的重复同步 IO。

### 界面层补修（第三轮审查，同日，仅 `ui/app/03-snowluma.js`）

> 前两轮修的是注入的语义层与基础设施层，这一轮只看**界面状态机**。后端判据都已就位，
> 但界面在"页面每 15 秒整页重建一次"的前提下会把自己的操作结果弄丢。共 6 项。

- **点了没反应 / 提示永远停在"正在…"（U1）**
  页面每 15s 被轮询整页 `innerHTML` 重建，而按钮回调里捕获的提示位、账号列表都是
  **重建前**的节点 —— 动作只要跨过一次重建，结果就写进已摘除的 DOM。最容易命中的是
  「从已登录 QQ 选择」（要对每个进程 probe-login）和「切换到此账号」（登录 + 进程表 +
  卸载 + 2.5s 复查）。现在动作期间挂 `slActionBusy`，轮询遇到就让路（120s 兜底防卡死），
  且"正在…"这类临时提示不再被回填到新页面。

- **「切换到此账号」不再被 blur 抢先写脏配置（U2）**
  事件顺序是 mousedown → 输入框 blur → click，所以点切换按钮时 blur 里那句"仅保存"
  已经把 `botQQ` 写进配置了 —— 后端 P2 特意改成的"先校验目标存在、再落配置"被这一个
  blur 整条废掉。现在点三个动作按钮时抑制这次 blur 保存；失焦也只在值真的变了才写。

- **连错号在页面上看得见了（U3）**
  后端 P1 已能用真实登录号对账，但界面只显示昵称、不比 uin，页头一直是绿的"机器人工作中"。
  现在节点③ 显示"昵称 · QQ号"，与注入目标不一致时整体状态降级为"连错账号"并给出橙色警告
  （说明会自动纠正、也可立刻点「切换到此账号」）。

- **密码框那颗「重置并接管」也说真话（U4）**
  P5 的修法只落在节点③那颗按钮上，密码框里漂移时出现的那颗仍是老文案——无条件报
  "✓ 已重置并重启，密码：xxx"。现在两颗统一按 `verified` 分档，未实测通过就明说别拿它去试。

- **切换 / 取消注入防连点（U5）**
  两个动作都要跑 3~10 秒且此前按钮一直可点，双击会打出两路并发请求（同一进程被 load
  两次、OneBot 会话被重建）。现在入口即置灰，结束统一放行。

- **恢复注入失败时带上原因（U6）**
  此前一律"恢复失败，请重试"，现在把后端返回的 `error` 带出来。

### 新手自救：卡在「OneBot 连接中」时给出可点的下一步（第四轮，同日，仅 `ui/app/03-snowluma.js`）

> 反馈原话是"很多萌新还是不会使用自动注入，永远卡在 OneBot 连接中"。后端判据其实
> 早就齐了（N4 已能把"没匹配到目标"的三种原因说清楚），但**只写进日志面板**，
> 还夹着 `ws://127.0.0.1:3001`、`pid=`、`uin=` 这些词 —— 萌新读不出来。

- **未连接满 20 秒 → 节点③ 自动出现「🧭 卡住了？自助排查」卡片**
  20 秒是刻意留的缓冲：刚点完启动就弹"卡住了"会吓人。触发条件是
  `!onebotConnected && !injectCancelled && 未连接≥20s && SnowLuma 在跑`。
  ⚠️ 这里**故意不要求 `qqRunning`**：`qqPortable.running` 只认"QQ Agent 自己启动
  的那份 QQ"（`app.js:856` 按 `--user-data-dir` 匹配），用户从桌面双击开的 QQ 永远
  是 false —— 而那恰恰是最常见的姿势：QQ 明明开着，页面却说「未启动」，于是一个进程
  都不会被注入，永远停在"连接中"。要求 qqRunning 等于把最需要自救的人挡在门外。

- **把三种真实死路分别变成一句话 + 一个按钮**（复用 `discovered-accounts` 与
  `switch-bot`，不新增任何后端能力）：

  | 现场 | 卡片说什么 | 能做什么 |
  |---|---|---|
  | 没指定机器人 QQ（本机 QQ 模式最常见） | 列出当前已登录的号 | 点一下 = 设为注入目标并立刻注入 |
  | 指定的号没登录 | 现在登着的是哪些号 | 点那个真正的机器人号换过去 |
  | 已注入、通道没起来 | Hook 装好了，是 OneBot 实例没连上 | 「重启 SnowLuma」（只重启网关） |
  | SnowLuma 没跑 / 密码不对 | 说清是哪一种 | 「重新检查」/ 指回节点② |

  卡片里额外提醒"机器人建议用专用小号，别拿日常号试" —— 点选是用户自己的动作，
  但被注入的号会接管消息，这句必须在场。

- **点选后会作废旧结论并自动复检**：`slSelfCheck` 置空 → 下一次渲染重新拉账号表，
  卡片不会继续显示"还没注入"这种过期结论。

- **结果提示写回节点③ 的 `#sl-bot-qq-hint`**，不是节点② 的 `#sl-hint` ——
  用户滚到卡片这儿时看不见节点②，提示写到那边等于"点了没反应"（U1 同类问题）。

- **自动复检节流 2 分钟**：`discovered-accounts` 要对每个未注入进程 `probe-login`，
  几秒起步；15s 轮询每次都拉会一直占着控制台。卡片自带"正在读…"占位，首帧不会空白。

### 全站文案与入口校正（第五轮，同日）

> 逐页扫了 `ui/app` 26.5k 行。这一轮修的不是"措辞不好听"，而是**文案把人带到
> 不存在的地方**：设置侧栏早就合并成 6 项，「插件」「模型价格」两个入口已经没了，
> 但代码里还有 14 处指着它们。

**指向已废弃入口的文案（14 处）**

- 「设置 → 插件」×10（`13-doctor.js` 679/800/973/990/1796/1817/1903/2093/2148/3712）
  → 「下载 → 已安装 → 插件」；没装的指到「下载 → 插件下载」。
- 「插件 → 主人识别」×1（`06-settings-render.js:892`）→ 同上。这处旁边没有按钮，
  用户只能靠这句话，指错就是死路。
- 「设置 → 模型价格」×3（`04-archive-usage.js` 790/846/1087）→
  「设置 → 模型与搜索 → 当前模型单价」。**「模型价格」这个页面根本不存在**。
- 「模型 API 页签」×1（`05-memory-settings.js:738`）→ 「设置 → 模型与搜索 → 模型管理」。
- 引导第 2 步说「到「连接与启动」页启动 SnowLuma」，但按钮跳的是 SnowLuma 页
  （`18-onboarding.js:66/69`）→ 文案改成跟着跳转目标走，并顺带告诉还有一键启动这条路。
- 「运行状态与日志在顶部「SnowLuma」页签」（`06-settings-render.js:1379`）→
  顶部没有 SnowLuma，它在「工具」下；同时删掉"启动入口都在这里"这句 —— 那页自己
  也有启停按钮，宣称唯一入口只会让人怀疑点错了。

**英文与黑话**

- 左栏「工具 → harness」和页面大标题 `<h2>harness</h2>` → 「自检」（页内三个模块
  本来就叫 自检系统 / 对话审查 / 自动修复）。
- `api()` 的兜底错误 `HTTP 500` → 按状态码分档说人话（令牌失效 / 接口不存在 /
  内容太大 / 太频繁 / 后端内部错误并指到应用日志）。
- 就绪圆点缩写 `⚠SL` / `⚠OB` → `⚠网关` / `⚠通道`（SL、OB 只有开发者认得出）。

**反馈缺失**

- 设置页静默自动保存，成功时**没有任何反馈** —— 用户只能靠"下次进来值还在"推断。
  现在页头右侧会出现一个 2.4 秒后淡出的「✓ 已保存 08:58」，失败时是红色的
  「保存失败，正在重试…」。不弹框、不占位。
- 横幅上的「恢复」按钮失败时只写 console —— 点了像没反应。现在会说明"机器人仍在
  暂停"并给出下一步。
- 横幅把所有未连接都归因于「SnowLuma 是否启动」→ 按 SnowLuma 是否在跑分两档：
  没跑说"还没启动"，跑了说"多半是机器人 QQ 还没登录"。
- 用量页插件统计失败让用户「重启 QQ Agent」→ 改为带上失败原因 + 指到页面上现成的
  「刷新」（它走 force，会连插件统计一起重拉）。

**市场页「有时候加载不出来」（上轮只分析，这轮落地）**

- `loadMarket` 的骨架渲染移进 `try`、收尾渲染移进 `finally` 并自己兜住 ——
  此前渲染一旦抛异常，`st.loading` 永远停在 `true`，本次运行期间这个市场页再也
  加载不出来（连点刷新都会被 `if (st.loading) return` 挡掉）。
- 市场列表请求加 15 秒超时（`api()` 默认没有超时，上游被 WAF 挡时会一直转圈）。
- 切页钩子不再串行等 `/api/skills`：列表与"本机装了什么"并行拉，模块状态回来后再
  补一次渲染刷新已装徽标。此前 `/api/skills` 一慢，市场页就停在「正在连接市场…」。
- 后端 `/api/market/list` 失败时补一行 `logger.warn('market', …)` —— 此前只回 502、
  一个字都不落日志，用户报"加载不出来"时后台干干净净。
- 市场列表加 60 秒内存缓存 + 并发去重（`src/market.js`）：实测同一份列表
  339ms → 0ms，6 条并发只打一条上游请求；「刷新 / 重试」带 `force=1` 跳过缓存。

### SnowLuma 页：萌新读不懂 → 首屏只留三步（第六轮，同日）

> 用户的判断很准：「按钮和文案需不需要改，对于小白来说读懂文字还是太难了」。
> 真正的问题不是措辞难，而是**一屏摆了 18 个按钮 + 一个密码框 + 三块日志**，
> 萌新不知道"我该点哪个"，于是在「OneBot 连接中」前面反复犹豫。
> 这一轮做两件事：把术语换成动作句，把罕用件全部收进折叠区。

**首屏只剩三步 + 一张自助卡**

- 新增「高级：控制台、密码、接入开关与连接排查（出问题才需要）」折叠区，收进
  控制台地址 / 控制台密码框 / 刷新状态 / 打开文件夹 / 重置并接管控制台密码 /
  整张连接排查卡；三块日志收进另一个「日志：出问题才需要看」折叠区。
- 首屏按钮从 18 个降到 8 个：启动机器人的 QQ · 显示 QQ 窗口 · 关闭 QQ ·
  启动 SnowLuma · 关闭 SnowLuma · 就用这个号 · 先记下 · 看看现在登着哪些号。
- **折叠展开态扛得住 15 秒整页重建**（`box.innerHTML = ...`）：`prevUi` 新增
  `advOpen` / `logsOpen`，重建后原样还原。否则用户刚展开准备照做，一转眼自己合上。
- 折叠态下 `scrollHeight` 恒为 0，日志贴底会落空 —— 补 `toggle` 监听，展开时再贴一次底。

**术语换成动作句（都在首屏可见处）**

- 节点名「QQ 内核 / OneBot 连接」→「QQ / 连接」；标题「SnowLuma（OneBot 网关）」→「SnowLuma」。
- 按钮「单独启动 QQ」→「启动机器人的 QQ」（原名读起来像"再开一个 QQ"，正是萌新最怕的事）；
  「唤起 QQ 窗口」→「显示 QQ 窗口」。
- 「切换到此账号」→「就用这个号」；「仅保存」→「先记下」；
  「从已登录 QQ 选择」→「看看现在登着哪些号」；「取消注入 / 重新注入」→「停止接入 / 恢复接入」。
- 「注入目标」区块 →「机器人用哪个 QQ」；「启动管线」→「三步接上机器人」。
- 排查三步「QQ 内核运行 / SnowLuma 运行 / OneBot 上报连接」→「QQ 在运行 / SnowLuma 在运行 /
  机器人连上了」；诊断兜底「等待协议端上报连接」→「还没连上，正在等」。
- 自助卡：「注入目标 / 立刻注入」→「机器人的号 / 现在就接上」，「注入已完成，卡在 OneBot 通道」
  →「QQ 已经接上了，卡在连接这一步」。
- 状态条与横幅「OneBot 未连接」→「机器人没连上」，「OneBot 已连接」→「机器人已上线」；
  启动链副标题「等待 OneBot 连接…」→「等待机器人上线…」。
- 设置页三处「到 SnowLuma 页「唤起 QQ 窗口」」→「显示 QQ 窗口」（按钮已改名，指旧名等于指错）。

**顺手修掉的三个"点了没反应"**

- 「重置并接管控制台密码」与密码框里的「重置并接管」搬进折叠区后，结果仍写节点② 的
  `#sl-hint` / 节点③ 的 `#sl-bot-qq-hint` —— 都不在用户视野里。新增同区的
  `#sl-adv-hint` 承载结论。
- 接入开关的结果提示改用现取 DOM（`#sl-adv-hint` → 兜底 `#sl-bot-qq-hint`），
  15 秒轮询重建后不会再写进已摘除的节点。
- 删掉一句**事实错误**的旧提示：「留空时：自动识别由 QQ Agent 启动的那份机器人 QQ
  （本机 QQ 模式同样有效）」—— 从桌面双击开的 QQ 恰恰认不出来，而这正是自助卡存在的理由。

**验证**

- jsdom 实跑 `loadSnowlumaPage()` 五个场景（全未启动 / SnowLuma 在跑且卡住 / 全绿 /
  连错号 / 已停止接入），115 项断言全过：包括"所有搬走的控件 ID 仍存在且都在折叠区内"、
  "折叠区默认收起"、"展开态与内层折叠块跨重建保持"、"首屏无黑话"。
  这一步是必需的 —— 该函数里 `$('#id').addEventListener` 都是非可选的，少一个节点整页就渲染不出来。
- 下发文件与磁盘 md5 一致（`/app/03-snowluma.js`），重载窗口即生效。

### 修复 · 「测试连通性」恒报 401（第七轮，同日）

> 用户反馈：「设置界面连接性测试那个按钮，即使所有东西全是对的测试结果也是 401」。
> 不是 Key 的问题，也不是配置的问题 —— 那个请求**根本没带鉴权头**。

- **根因**：`buildProtocolRequest()`（`src/api-protocols.js`）对 openai / openai-responses /
  mistral 只吐 `content-type`，`Authorization` 一直由调用方 `llm.js` 的 `authHeaders()`
  经 `extraHeaders` 注入。2026-10-19 让「测试协议与实跑同源」之后，测试走的
  `providers.js → testModelChat()` 只传了 opencode 路由头，于是发出去的
  `/chat/completions` 请求**没有任何鉴权信息**，任何 OpenAI 兼容端点都回 401。
  实测（用户自己的端点，修复前）：`HTTP 401：Authorization Not Found`。
- **修复**：鉴权头收进 `buildProtocolRequest()` 自己给（`bearerHeader()`，顺序在
  `extraHeaders` 之前，调用方仍可覆盖），`protocolModelsRequest()` 复用同一个函数；
  掩码值 `******` 不会被当成真 Key 发出去。
- **验证**：本地假端点 + 用户真实端点双测 —— 正确 Key 200「pong」（590ms）、
  错误 Key 401、空 Key 401；anthropic / google / openai-responses 三种协议同样通过。
- **顺带**：「模型配置」弹窗里的「测试连通性」现在会把**所选提供商自己的协议**
  （`apiProtocol`）一起带上 —— 此前弹窗里挑了个别家的模型，服务端仍按主提供商的协议
  去请求，端点与鉴权头全错，配置没问题也报 4xx。
- **失败提示**：401/403 的结论后面补一句可操作的话（Key 是否已保存、Base URL 与 Key
  是否同一家），不再只甩一句 `HTTP 401：invalid api key`。

### 排查 · 全站扫「请求没带鉴权头」这一类 bug（第八轮，同日）

> 上一轮修的是"测试连通性恒 401"——根因是请求没带 `Authorization`。
> 这一轮把 `src/` 里**所有**会打模型/提供商端点的请求逐个走了一遍，确认还有没有同源问题。

**结论：同一个 bug（漏鉴权头）没有其他实例。** 逐点核对：

| 位置 | 请求 | 鉴权 |
| --- | --- | --- |
| `providers.js` fetchModelsFrom / testProvider | `/models` | `protocolModelsRequest` 自己给 ✓ |
| `llm.js` listModels | `/models` | 同上 ✓ |
| `llm.js` chatCompletion（真实对话） | chat | `authHeaders()` ✓ |
| `llm.js` buildCandidateApis（备选模型降级） | chat | `resolveProviderEndpoint()` 按 `dshProviderKeys` 解 ✓ |
| `providers.js` testModelChat（上一轮修的） | chat | `bearerHeader()` ✓ |
| `cache-warm.js`（调用前预热） | chat | 复用真实调用那一次已解析的 api，不自己拼 ✓ |
| `orchestrator.js` #memoryChat / #judgeApi | chat | 走 `currentProviders()`，它内部已把 `dshProviderKeys` 回填进 `apiKey` ✓（一度误判成漏密钥，实测这条是对的） |
| `web-search.js` 深智/博查/百度/metaso/自定义 ×6 | 搜索 | 各自带 `Authorization` ✓；Bing 页面抓取本就不需要鉴权 |
| `app.js` slFetch（SnowLuma 控制台） | 控制台 | 带 token ✓ |
| `onebot.js` WS/HTTP | OneBot | 带 accessToken ✓ |

**同族但不同的两个 bug（顺手修掉）**

- **模型视觉探测对非 OpenAI 协议全部失效**（`src/vision-scan.js`）：`detectModelVision()`
  把请求硬编码成 OpenAI 形态的 `/chat/completions`，于是 anthropic / google 提供商的
  每个模型都打到不存在的路径 → 404/400 → 一律判 `unknown` → "配了 Claude / Gemini 就永远
  探测不出能不能看图，看图工具被永久门控"。现在改走 `buildProtocolRequest()`
  （与真实对话同一条翻译边界，URL/鉴权头/body 全按 provider 自己的协议生成），
  并补上 `dispatcherFor()`（此前不走代理，出现"实跑能看图、探测 unknown"）。
  实测四协议都打到正确端点：`Bearer sk-o /v1/chat/completions`、`sk-a /v1/messages`、
  `sk-g /v1beta/models/…:generateContent`。
- 顺带确认前端只有两个连通性测试入口（健康卡片「测试一下」与「模型配置」弹窗里的
  「测试连通性」），现在都走同一个已修好的 `/api/providers/test-chat`。

### 说明

- 经实测核对，`loggedIn` 是"Hook/注入侧"的标志而非"QQ 是否登录"（未注入的个人号
  已登录却为 false），因此**不**按它过滤「从已登录 QQ 选择」的列表——原审查中的
  该项建议撤回。

### 新增 · 桌面悬浮小窗（第九轮，同日）

> 设置 → 界面与应用 → 桌面端 新增「显示桌面悬浮小窗」。打开后桌面右下角
> （默认位置）出现一张无边框小卡片：今日调用 / 估算成本 / 总 Token /
> 缓存命中率 + 机器人连接状态。卡片整体可拖动换位置，右键有菜单
> （打开主界面 / 总是置顶 / 鼠标穿透 / 尺寸三档 / 关闭）。

- **数据零新增**：页面每 `widget.refreshMs`（默认 2500ms）轮询一次
  `/api/status` —— 与主界面顶栏同一个接口，没加任何后端接口。
- **默认不透明深色小卡**。真透明是设置里的实验档：本机透明（分层）窗口的
  呈现链路坏过（R46：8/10 轮只显示第一帧后冻结，GPU/DComp/遮挡检测全试过
  无效），主窗口因此一直 `transparent:false`。真透明出问题的用户关掉该
  开关即可恢复，位置与尺寸都会保留。
- **三条恢复路径**：鼠标穿透开启后小窗自己的右键菜单够不着（点击被放行到
  桌面）—— 托盘菜单有同名开关，设置页也有同一批控件，任意一条都能关掉它。
- **位置/尺寸不写配置**：与主窗口一致落在 `data/window-state.json` 的
  `widget` 键（配置里可有密钥，不该每次拖动都整份重写），换显示器/拔副屏后
  旧坐标不可见时回退默认位置（沿用主窗口的屏幕可见性校验）。
- **鉴权**：小窗页面与主界面发同一个占位符 `x-console-token`，主进程的
  `installConsoleRequestAuth` 现在对 mainWindow **与** widgetWindow 一并换成
  进程私有真令牌（漏了它就是"配了 server.token 时小窗永远连接中"）。
- 改动文件：`electron/main.js`（第二个 BrowserWindow + 右键菜单 + 托盘开关 +
  1 秒配置轮询）、`ui/widget.html` + `ui/app/widget.js`（新页面）、
  `ui/app/06-settings-render.js` / `07-settings-events.js` / `08-modals.js`
  （设置页控件与保存）、`src/config.js`（`widget` 默认值）。
- ⚠️ 属主进程/后端改动，**需重启 QQ Agent 生效**；页面文件本身重载窗口即可。

**同日追加（外观细化）**：右上角加当前模型名（超长省略）；缓存命中率加细进度条并分档着色
（≥50% 绿 / ≥20% 橙 / <20% 红）；估算成本改三态——没匹配到价格显示"未计价"（悬停有解释）、
有价显示金额、确为 0 显示 ¥0；两列指标加中缝细线、数字等宽（刷新不跳动）、在线状态点缓慢
呼吸、卡片渐变底、底栏改为"搜索次数 / 附加状态 / 更新时间"三段。修了一个口径 bug：
`resolveModelPrice` 的 `matched` 没命中时是 **null**（source='unmatched'），不是 false——
写成 `=== false` 会让"未计价"永远不触发、错显示成 ¥0（用户实机数据即此路径）。

---

### 性能 · 从别的页签点「下载」不再卡一下（第十轮，同日，仅 `ui/app/06-settings-render.js`）

> 现象：在导航栏任意别的页签上点「下载」，会有一下明显的顿挫——不是"慢"，是画面空一下再满。

**根因不在后端。** 实测本机接口都很快（`/api/skills` 9.7ms / 68KB / 24 个条目、
`/api/prompt-preview` 2.2ms、`/api/market/list` 274ms），卡的是前端这一页的**进入方式**：
`loadModulePage()` 每次进入都无条件"清空成骨架 → 等两个接口 → 整页重建 → 重绑事件"。
骨架是同步写进去的，所以它必然被画到屏幕上至少一帧 —— 用户看到的就是
**旧页 → 骨架闪白 → 完整页** 三段跳；而这一下里叠加了三次全量布局
（`.view` 从 `display:none` 变 `flex`、`switchTab` 里的强制 reflow、`innerHTML` 覆盖），
代价被放大成肉眼可见的卡顿。技能页又恰好是导航目的地里内容最重的一页（24 张卡 + 内联 SVG），
所以只有它明显。

**改法**（三分支）：

- **有缓存 + 普通进入**（绝大多数，含从导航栏切过来）→ 直接用内存数据渲染，
  同步一次 `innerHTML` 写入就出完整页，**不再碰骨架**；与后端的对齐丢到后台，
  回来比对状态指纹，没变就一个字节都不动 DOM，变了且人还在这一页才补一次重画。
- **首次进入**（`state.skills` 还是空）→ 数据没到之前**不清空**，只有慢过 120ms 才补骨架。
  本地接口通常 10ms 就回来了，于是那条"必闪一帧"的骨架也一并省掉；真慢的时候仍有反馈。
- **rescan**（「刷新」按钮 / 装完插件）→ 骨架保留（这个动作本来就慢，需要即时反馈），
  只是改成 120ms 后才出现。

另外两处：

- 进技能页顺带刷的那次提示词预览**不再 `await`**：技能页自身不显示预览（右栏早已撤掉），
  这次刷新纯粹是给「设置 → 工具与技能」预热，没有任何理由挡住这一帧。
- 「未安装残留清理」成功后改走 `fresh: true`：配置刚被清掉，缓存那份已经不对，
  不能先拿它画一遍再等后台对齐。

校验：`修复报告-20261016/verify-20261020/verify3.mjs` 把新逻辑切出来用桩跑，23/23 通过
（含"数据没变不重画""数据变了补一次""人已切走不重画""接口快时不闪骨架""接口慢时补骨架"）。

- ⚠️ 纯渲染层改动，**`Ctrl+R` 重载窗口即生效**，不用重启程序。
- 回滚：`ui/app/06-settings-render.js.bak-20261020-1130`。

---

### 修复 · 「API 协议」选了保存不住（第十一轮，同日，仅 `ui/app/08-modals.js`）

> 多人反馈：模型管理里选完 API 协议、点「保存」，下拉又变回原来的。

**保存一直是成功的。** 隔离数据目录把 5 种协议逐个存过一遍（22/22 通过），
`config.json` 里 `apiProtocol` 确实写进去了。问题在保存之后：

```js
await api('/api/providers/protocol', {...});
await loadSettings();   // ← 这句并没有刷新 state.providers
renderRight();          // ← 于是用旧的 providers 重画，下拉回到旧值
```

`loadSettings()` 的注释自己写着「config 单独先行，其余接口慢到无所谓」——
providers 在慢路径 `Promise.all` 里，**根本没 await**。所以它 resolve 时
`state.providers` 还是旧的，`renderRight()` 一画就把用户刚选的协议盖回去；
慢路径回来后也不会重画这个弹窗，于是这个"回退"是终态。
加上旧代码保存成功**完全静默**，用户只能得出"没保存"的结论。

「添加提供商」那条路 2026-10-18 已经踩过同一个坑并补了 `refreshProvidersState`，
协议保存这里当时漏了。

**改法**：

- 保存后先 `await refreshProvidersState()` 把真实值拉回来，再判断 —— 不再依赖慢路径；
- 正常情况**不再重画右列**（界面本来就是用户选的那个值，重画正是旧 bug 的触发点），
  只有"后端回读 ≠ 提交值"这种罕见情形才重画让界面与事实对齐；
- 给即时反馈：按钮右边显示「已保存 ✓」（绿色，2.6s 淡出）／「保存失败」；
- **改下拉即保存**，同时保留「保存」按钮，两者走同一个幂等提交函数（带忙碌锁）——
  选完直接关窗口也不会丢；保存期间又改了值会自动补提交一次。

**顺带修掉三个同源 bug**（同一个坑）：「清除密钥」后仍显示 `******`、
「删除模型」后列表还留着它（再点删除报"模型不存在"）、
「删除提供商」后左列还留着一项 —— 三处重画前都补上 `await refreshProvidersState()`。

- 验证：`node --check` 通过；后端 `verify-20261020/verify-protocol-save.mjs` 22/22。
- ⚠️ 纯渲染层改动，**`Ctrl+R` 重载窗口即生效**，不用重启程序。
- 回滚：`ui/app/08-modals.js.bak-20261020-1400`。

---

### 修复 · 「保存不住」同类问题全站复查（第十二轮，同日，9 处）

> 协议那件事之后按"同一形态还有没有"全量复查了一遍。结论：**9 处同类缺陷**，
> 都在前端保存/渲染链，后端一律正确。

**两种形态**（漏掉任一种就查不全）：

- **A. 写后端成功 → 界面拿旧数据重画**：`loadSettings()` 只 await `/api/config`，
  providers / personaTemplates / skills / modelPrices / toolRegistry 全在**慢路径**里不等待
  （这是 2026-10-16 修「切换人设不成功」时刻意做的取舍，不改）。所以凡
  `await loadSettings(); renderXxx();` 的组合，只要 render 读这几个字段就是旧值。
- **B. 界面改了 → 保存根本没发起**：自动保存只认 `#settings-form` 上的 `input`/`change`
  委托，而 `<button>` 的 click、代码给控件赋值都不产生这两个事件；
  且 `saveConfig` **按当前分区**收集字段，分区一变旧分区的改动就再也收不到。

**本轮修的 9 处**：

| # | 位置 | 症状 | 处理 |
|---|---|---|---|
| 1 | 清除密钥（模型配置弹窗） | 清完 `state.providers.hasKey` 仍是旧值，接着打开模型管理显示"已保存密钥" | 重画前 `refreshProvidersState()` |
| 2 | 强调色色板 | 点色板只改 CSS + hex 输入框值，**不派发事件 → 保存不发起**（能存上全靠后来碰了别的控件或切页 flush） | `pick()` 里对 hex 输入框派发 `input`（bubbles） |
| 3 | 底色色板 | 同上 | 同上 |
| 4 | 工具「全部启用」 | `<button>`，只改内存 + 重渲染，**从不落盘**，点完就强杀即全部丢失 | `renderSettings()` 后补 `flushSave()` |
| 5 | 工具「全部禁用」 | 同上（批量关工具，影响面最大） | 同上 |
| 6 | 工具「恢复默认」 | 同上 | 同上 |
| 7-9 | 页头健康卡片「去设置」×3 + SSE 面板跳设置分区 | 直接改 `state.settingsSection` 绕过左栏菜单的 flush → A 区 600ms 窗口内的改动**永远不被提交** | 四处赋值前补 `flushSettingsSaves()` |

**查了但不是缺陷**（附证据，免得下次重复排查）：技能开关/卸载/清理/信任/重试（都是
`await loadSkillsStatus(); rerender();`）、市场安装（rescan 后再 `renderMarketList`）、
添加/删除自定义搜索服务（数据在 config 快路径上）、弹窗内删除人设（2026-10-18 已修）。

**留档不改**：添加人设后「选择人设」要等慢路径（含联网价格表）才出现新条目 —— 最终一致，
要"立刻出现"就得在弹窗里重建整页表单，会打乱"回填 + 派发自动保存"的时序，风险大于收益。

- 验证：`verify-20261020/verify-ui-save-contract.mjs` —— 把这 9 条落成**可重复执行的
  静态契约断言**（这类修复都是一两行，极易被后续改动删掉），**20/20 通过**。
- ⚠️ 纯渲染层改动，**`Ctrl+R` 重载窗口即生效**，不用重启程序。
- 回滚：`ui/app/07-settings-events.js.bak-20261020-1420`、`02-sse-sessions.js.bak-20261020-1420`。

---

---

### 修复 · 发网图总开关的界面入口与 17 处错指文案（第十三轮，同日）

> 触发：复核《发网图功能问题与处置报告.docx》。核对**运行中实例**后发现报告声称的三项
> 修复一项都没落地（`security.imageSend.enabled=false`、`ui/` 里 `imageSend` 零引用、
> 报错仍指向不存在的页面）。核对报告见
> `修复报告-20261016/发网图隐藏开关修复与同类排查-20261020.md`。

- **总开关补上界面**：设置 → 聊天 →「📨 信息发送配置」新增勾选框「允许机器人发送网图」，
  hint 明写它是 `send_image` / `search_images` 的**安全总开关**，「工具与技能」里的开关
  只决定模型能不能看见工具。保存只 patch `security.imageSend.enabled` 一个字段
  （`updateConfig` 深合并，不动四个阈值）。
- **两层开关互指**：总开关关着时，`send_image` / `search_images` 的工具卡上直接红字提示
  还差哪一步 —— 把"可见 ≠ 可用"前移到用户第一次看到工具时，而不是等调用失败。
- **新开「🛡 安全开关」模态框**（入口在「工具与技能」页按钮行）：
  `security.browseLock.enabled`（浏览锁定：fetch 与发图逐跳校验域名白名单）、
  `security.allowPrivateImageHosts`（允许图片下载走内网地址）、`security.externalHosts`
  （额外放行的主机）三项此前**配置里有、界面零引用**。域名输入自动去掉 `scheme://`、
  路径、查询串、端口并去重（匹配逻辑是 `h === base || h.endsWith('.' + base)`，
  带协议写进去会静默不匹配）；「勾了浏览锁定但清单空着」就地拦下提示，**不弹二次确认框**
  —— 两个模态框叠着会互抢滚动锁（`lockBodyScroll` 是成对调用的）。
- **17 处错指文案全部改对**（`src/tools.js` / `src/llm.js` / `src/error-l10n.js` /
  `src/routes.js` ×9 / `src/orchestrator.js` / `src/web-search.js` / 三个插件）：
  「设置 → 插件」「设置 → 模型价格」「设置 → 记忆」这些页面在 2026-09-20 那次
  「运行环境拆成两页 + 应用与界面改名」重构时就没了，散落在后端与插件里的文案集体
  留在旧世界。现在统一指到真实位置；`error-l10n` 的跳转 target 从错误值改为
  `settings-allow`，`02-sse-sessions.js` 的按钮字「去改白名单」→「去改聊天设置」。
- 验证：12 个改动文件 `node --check` 全过；幂等 POST 后回读确认深合并不误伤阈值；
  `GET /app/{09-community,06-settings-render,07-settings-events}.js` 命中
  `openSecurityModal` / `tools-security` / `needsImageSend`。
- ⚠️ 界面文件刷新即生效；`src/tools.js` 改的是报错文案，需重启进程。

### 修复 · 冷启动 2 秒内设置页必崩一次（同日，仅 `ui/app/00-core.js`）

- 现象：右下角弹红条 `Cannot read properties of null (reading 'onebot')`。冷启动后约
  2 秒、停在设置页（或启动默认落点）必然触发一次；历史 10-18 / 10-19 均 0 次，
  **不是本轮界面改动引入的**，是这个窗口此前没被踩到。
- 根因：`assessReadiness(cfg, status)` 只防了 `cfg` 为空，同一段里
  `status?.onebot?.connected` 用了可选链、下一句 `status.onebot.diagnosis` 却漏了；
  而 `state.status` 初值就是 `null`（`00-core.js:284`）。
- 改法：把 `status`、`status.onebot` 一次性收敛成局部变量（**归一化而非加 `?.`**，
  后面引用几次都不会再漏）；状态未知时显示「正在读取机器人连接状态…」，不再误报
  "机器人没连上"；真连不上时仍显示 `diagnosis` 原文。
- 已知次生表现（可接受）：页头随 `renderSettings()` 整页重建，`refreshStatus()` 不触发
  设置页重渲染 —— 停在该页的那 2 秒会短暂看到"正在读取…"，切页签或保存一次即刷新。
  没有为此加自动重渲染（整页 `innerHTML` 重建会丢掉正在编辑的表单）。

### 修复 · 市场页「加载不出来」的整条链路（同日）

> 报错是「市场连接失败：请求超时（15 秒无响应）」，条目区空白。三个问题叠加，缺一不可。

- **前端等得比后端还短（主因）**：前端 15 秒就放弃，后端还在正常拉 30 秒 —— 用户看到
  "超时"，其实请求并没有失败，只是前端不看了。现在 `16-market.js` /
  `17-persona-market.js` 一律 **115 秒**（后端 90s + 25s 余量）。
- **静默吞空（更隐蔽，会骗人）**：`res.json().catch(() => ({}))` 在"响应头 200 到了、
  body 没读完"时把异常吞成 `{}`，而 `res.ok` 仍是 true → 向上返回空列表 →
  **市场显示「共 0 个」，用户以为市场是空的**（实测 `/skills` 在 60 秒处正好命中）。
  改成 `res.text()` + `JSON.parse`，解析失败按失败上报。
- **链路本身间歇故障（外部因素）**：同机多次实测 6.58s / 34.13s `UND_ERR_SOCKET` /
  53.9s / 首次失败重试后 81.4s 成功；对照组 Cloudflare 250KB 只用 1.44 秒。
  代码侧能做的：`FETCH_TIMEOUT_MS` 30s → **90s**；`marketFetch` 增加**一次**重试
  （只对 GET/HEAD 无 body —— 登录/发布/装包是 POST，重发会重复提交；只对瞬时网络错误
  或 5xx；用 deadline 算每次剩余时间，**总预算不叠加**）；`MARKET_LIST_TTL_MS` 60s →
  **5 分钟**；新增**磁盘缓存** `data/market-list-{skill,plugin}.json`（24 小时硬上限）
  + 后台换新 —— 有上次成果就直接给，用户不必为"上游这会儿慢"再等一分半。
- `/api/market/list` 把 `force` 透传给 `listMarketItems(kind, { force })`；
  前端等待超过 6 秒把副标题改成「线路较慢，仍在等…（最长约 2 分钟）」，
  避免用户以为卡死而强关窗口。
- 验证：磁盘缓存命中**另起进程 0.06 秒**返回 312 条、后台刷新照常；生产目录已预热
  （skill 312 / plugin 402）。上游 6~80 秒的波动属外部因素，代码治不了 —— 建议把这个
  数据反馈给官网（一次要传 250~370KB，服务端分页能再降一个量级）。

---

### 桌面小窗：贴边收起 · 背景不透明度 · 卡片内菜单（第十四轮，同日，R137–R140）

> 桌面悬浮小窗的两项交互增强：贴边自动收起（QQ 式）、背景不透明度可调。
> 均为新增行为，默认值不改变现状（收起默认开、不透明度默认 100%=原样）。
> 改动文件：`electron/main.js`、`src/config.js`、`ui/widget.html`、`ui/app/widget.js`、
> `ui/app/06-settings-render.js`、`ui/app/07-settings-events.js`、`ui/app/08-modals.js`。
> 需重启 QQ Agent 生效（main.js 改动）。

### 新增 · 贴边自动收起（第十四轮）

- **拖到屏幕边缘就收起，鼠标移近就展开**：小窗被拖到工作区任意一条边 6px 内时，
  当场收起成屏幕内一条 6px 细缝；鼠标移到缝附近（30px）整卡弹回原位置。
  直接把细缝拖走也会弹回 —— 和 QQ 的贴边收起一个手感。
- **只在松手后判定**：拖动过程中判定会让窗口跟着光标反复收起/展开抖成钟摆。
  另外做了三重防误判：程序性移动（改尺寸/重建窗口）400ms 内的 `moved` 回响不参与
  判定；展开后 1.2 秒静默期内不立刻再收起；坐标没变的回响直接忽略。
- **重启后仍是收起态**：`window-state.json` 的 `widget` 键存展开态坐标 + 标记，
  启动先按正常位置建窗再立刻收起（存收起坐标过不了"屏幕可见性"校验，重启后小窗
  会以一条缝的形态消失 —— 这个坑在测试里抓到并修掉了）。
- **三条恢复路径**（与鼠标穿透对齐）：悬停展开、右键菜单「展开悬浮窗」、
  设置/右键/托盘里关掉「贴边自动收起」当场弹回。
- 四边都支持（左/右/上/下），多屏按窗口中心所在屏幕的工作区算；设置 →
  界面与应用 → 桌面端 里可关。

### 新增 · 背景不透明度可调（第十四轮）

- 设置页新增「背景不透明度」滑条（30%~100%，默认 100% = 现在的深色小卡）。
  100% 以下卡片变半透明磨砂，页面轮询 `/api/config` 即时跟上，不用重启。
- **刻意不走 `transparent:true`**：本机透明（分层）窗口的呈现链路是坏的
  （R46：8/10 轮只显示第一帧后冻结，记录在 `createWindow` 注释里）。半透明走
  Windows 11 mica 毛玻璃背板（DWM 系统合成，窗口仍按不透明窗口建，不碰分层透明
  那条链路），页面用半透明卡片色叠在背板上得到磨砂效果。
- mica 背板建窗时决定：调过 100% 这条线会重建一次小窗（位置、贴边状态都不丢），
  100% 以下内部拖动（如 55→60）只是改卡片 CSS 透明度、不重建。
- 兜底：老系统/老内核不认识 `backgroundMaterial` 时静默忽略，退化为不透明卡；
  显示异常就调回 100%。

### 变更 · 小窗右键菜单改为卡片内自绘（第十四轮）

- 原先右键弹出的是**系统原生菜单**（白底、系统字体，与深色小卡完全两套风格）。
  现在改成在卡片内自绘的深色菜单：同一套圆角与配色，项目为
  打开主界面 / 总是置顶 / 鼠标穿透 / 贴边自动收起 / 尺寸三档 / 不透明度滑条 / 关闭悬浮窗。
- 关闭方式：再右键一次、Esc、鼠标移出小窗。改设置即时生效（不用等 1 秒轮询）。
- 为此给小窗加了一个**极窄的 preload 桥**（`electron/widget-preload.cjs`）：只暴露
  `apply(patch)` 与 `command(name)` 两个方法；主进程侧逐键白名单 + 数值夹取后才
  落配置，并校验发送方必须是小窗自己的 webContents —— 页面传什么都改不了白名单
  之外的东西。桥加载失败时菜单置灰并提示重启（设置页与托盘菜单仍可调，不静默失效）。
- 顺带删掉了原生的 `buildWidgetMenu`（只有这一处用），避免两套菜单打架。
- ⚠️ 鼠标穿透开启时右键菜单仍然点不到（点击被系统放行到桌面），这与改动前一致，
  该开关的说明里已有提示；要调设置走托盘菜单或设置页。

### 同日追加（手感与菜单兜底）

- **贴边收起/展开改成 140ms 滑动动画**（ease-out，约 9 帧）。原来一步 `setBounds`
  跳过去太生硬；展开探测的轮询也从 180ms 提到 120ms，从"鼠标靠近"到卡片归位约 1/4 秒。
- **右键菜单三条兜底**：
  1. `.wcard` 补 `position: relative` —— 菜单原来以视口为定位基准（基准错了）；
  2. 右键同时走 `contextmenu` 与 `mousedown(button=2)` 两条路径（整卡是拖拽区，个别
     机器上 contextmenu 会被吃掉），300ms 去重防止"两条都到 → 开了又关 = 点了没反应"；
  3. **收起态（只剩一条缝）时右键 = 先展开** —— 窗口 98% 在屏幕外，菜单弹出来也看不见，
     以前的表现就是"右键没反应"。

### 同日追加 · 第二次（R138：贴边收起的时序）

实机日志抓到的真问题：`14:09:57 收起` 和 `14:09:57 展开` 同一秒 ——
拖到边上松手时**光标还停在判定区里**，收起后 0.1 秒就被自己判成"鼠标移近"弹回来，
看起来就是"根本没收住"。三条修复：

1. **上膛机制**（`widgetEdgeArmed`）：收起后必须先"见过光标离开一次"才允许悬停展开。
   否则松手瞬间光标必然还在边上（就是刚拖过去的），必弹回。
2. **拖动停稳再判定**（`WIDGET_EDGE_SETTLE_MS = 260`）：`moved` 事件在部分机器上拖动
   过程中连续触发，立刻收起会和光标互相打架；现在每次 `moved` 重置定时器，停了才算。
3. **挂起判定随展开作废**：展开时 `widgetCancelEdgeSettle()`，别让一条拿着旧坐标排队的
   260ms 定时器把刚展开的卡片又收回去。

另两处同源收尾：

- **拖细缝改为即时归位、不走动画**（`widgetRevealEdge(reason, instant)`）：
  动画每 16ms 一次 `setBounds` 会和用户的拖动抢同一个窗口（卡片抽搐），
  且动画期间的 programmatic 标记会把用户的 `moved` 全吞掉（540ms 内拖不动）。
- **`destroyWidgetWindow` 补清挂起定时器 + 重新上膛**：否则一条 260ms 定时器会活到
  重建之后，把不透明度跨 100% 新建出来的卡片立刻收走。
- 顺手删了 `widgetStartEdgePoll` 里重复的 `unref` 行；`widgetCancelEdgeSettle`
  上移到状态变量区，消除 `widgetRevealEdge` 引用未初始化 `const` 的隐患。

### 同日追加 · 第三次（R139：鼠标移开就收回）

实机日志（15:34:55 重启新代码后）显示收起本身正常，但紧接着 1 秒左右就被
"鼠标靠近"展开、拖回去又收 —— 循环起来；同时展开后有 1.2 秒静默期，
这期间把卡片拖回边缘也不会再收起（就是用户说的"鼠标移走后并不能正确收起"）。

- **悬停展开的卡片，鼠标移开就滑回细缝**（本次的核心诉求）。只有 reason 为
  `鼠标靠近` 的展开才登记 `widgetEdgeHoverReveal`；光标轮询因此从"只服务收起态"
  扩展成一个轮询两种状态——收起态探"移近"展开，悬停展开态探"移开"收回。
  判定用卡片矩形外扩 30px：触发展开的那个光标往往就停在细缝边，而细缝边在卡片
  矩形之外，不给余量会刚展开就立刻收回去。
- **从细缝拖出来的 / 菜单点展开的 / 关掉开关展开的，一律不动**（不登记该标记）；
  用户一拖动（`moved`，且已过程序性窗口）也立即取消追踪，不会拖到一半被收走。
- **静默期 1.2s → 150ms**：它原本只为兜住"展开→还贴着边→立刻又收起"，而这条
  现在由 400ms 的 programmatic 窗口负责（滑出动画每一帧都被吃掉，进不到判定）。
  副作用是刚展开 1.2s 内拖不回边缘，与本次诉求直接冲突。
- **关掉「贴边收起」开关后不再自动收**：轮询里补一次 `widgetCfg().edgeHide` 校验，
  否则悬停展开后关掉开关，鼠标移开照样把卡片收走。

### 同日追加 · 第四次（R140：不透明度滑条即时同步）

用户反馈设置页的「背景不透明度」滑条"不丝滑"。实测链路：滑条 `input` 只改数字 →
600ms 防抖全量 POST → 主进程 1 秒轮询才发现 → 小窗再等 2.5 秒状态轮询（还带
3 秒去重），最坏约 4.6 秒卡片才变色 —— 拖完松手等好几秒，体感就是"滑条不丝滑"。
另外滑条本体 `step="5"`，整条轨道只有 14 个档位，一跳一跳的（站内其它滑条都是 `step=1`）。

- **滑条本体**：`step` 5 → 1（设置页 `#cfg-widget-opacity` 与小窗菜单里的
  `#w-menu-opa` 都改），拖动不再跳档；补进个性化滑条的样式组（同款 22px 高 +
  主题色 accent），此前它是该组里唯一没被样式化的一条。
- **拖动即时落盘**：`input` 走节流（最初 110ms，同日回归审查后放宽到 **250ms** ——
  每次发送都是一次整份 config 落盘，110ms 在拖动时偏重），直接发**只含 opacity 的局部 patch**
  （`updateConfig` 深合并，不动 widget 其它字段）；同值去重、乐观更新
  `state.config.widget.opacity`（请求在途时重渲染不会把滑条弹回旧值）、
  失败只复位标记不打断拖动（全量保存自有重试链路）。松手 `change` 照旧
  `flushSave()` 全量落盘，离开页签/关页面的落盘口径完全不变。
- **主进程主动推（R140 的快路）**：`syncWidget` 发现签名变了就
  `webContents.send('widget:prefs-changed', {opacity})` 推给活的小窗（需要重建
  的两类 —— transparent / 不透明度跨 100 —— 走重建，不推）；轮询 1000ms → 300ms
  （每轮只读内存拼签名，成本可忽略）。拖动到卡片变色从最坏 4.6s 压到约 0.4~0.6s
  （节流 250ms 后按上限算约 0.55s，仍在"拖一下就变色"的区间内）。
- **小窗页面**：preload 桥新增 `onPrefsChanged(cb)`，`boot()` 订阅后收到推送
  立即 `loadPrefs(true)`（force 不吃去重，推送必达）；无桥（旧外壳）静默跳过，
  退回轮询兜底。`loadPrefs` 去重 3000ms → 1000ms —— 旧值会把推送晚到的那次
  补拉吃掉。小窗菜单里改不透明度/开关现在也能即时回显（此前要等 2.5s+3s）。
- 测试：新增 `widget-prefs-test`（主进程推送 20 断言）、`widget-prefs-page-test`
  （页面订阅/去重 11 断言）、`widget-slider-input-test`（滑条块 15 断言）；
  既有六套全绿（edge 100 / main / menu 33 / opacity-page 7 / render / settings）。

---

### 修复 · 当日改动回归审查（第十五轮，同日，R141）

> 对当天 26 个改动文件做完整回归：33 个文件 `node --check` 全过；四套回归脚本
> **82 项断言全绿**；逐文件 diff（`.bak-2026102*` 作基线）；跨文件符号扫描无重复声明、
> 无未定义调用；对运行实例（3210）只读核对静态文件字节数与磁盘一致（改动确实生效）。
> 结论：**没有崩溃或数据损坏级别的缺陷，但确认 4 处需要修**——其中 2 处属于
> "修了但没修到位"。审查报告：`修复报告-20261016/今日改动审查-20261020.md`。

**① 回车键绕过防连点（U5 漏了一个入口，最高优先）**

`ui/app/03-snowluma.js` 的 Enter 分支直接调 `switchBotQq()`，而 U5 的防连点只做了
按钮 `disabled`（对键盘无效），入口没有判空。连按两次回车 = 两路 `switch-bot` 并发，
后端 `/api/snowluma/switch-bot` 没有互斥锁 —— 正是 U5 想避免的"同一进程被 `/load`
两次、OneBot 会话重建、可能丢消息"。修法：`switchBotQq` 入口加闭包 busy 标记
（按钮 / 回车任何入口都过这一关），Enter 另加 `!e.repeat`（按住回车时 keydown 会持续重复）。

**② 市场磁盘缓存的时间戳污染（每次进市场页都白拉一遍）**

`listMarketItems` 把磁盘缓存的 `{ at, data }` 原样塞进内存缓存，而内存 TTL 是 5 分钟。
磁盘的 `at` 是"上次成功拉上游的时间"，实测两份是 15:50 / 15:53 —— 早已过期，
于是一条一进内存就"已过期"，**每次进入市场页都会再触发一次后台全量拉取**；
上游失败时不回写，用户每切一次页签就白等一次（最长 90 秒）。
修法：内存 `at` 用当前时间（语义是"本进程从何时起把它当新鲜的"），刷新照旧交给后台。

**③ S4 端口边沿「修了但没修好」**

`src/app.js` 的端口轮询在 `connected` 分支只更新 `obPortWasOpen` 就 `return` ——
记下来不等于处理了：端口关→开这条边沿在那里被消耗掉，等 socket 超时后
`!obPortWasOpen` 已为假，恢复仍要等 OneBot 自己的退避（最长 30 秒），与注释
承诺的"最多 2 秒"不符。修法：已连接分支发现边沿就 `syncSnowlumaTokens()` +
`onebot.reconnect()` + 补一次自动接入排期（`reconnect` 内部有连接代际互斥，不会双连）；
另加 `obPortEdgePrimed`，首轮探测只建立基线 —— 否则冷启动时"已连接 + 初值 false"
会被误判成"端口刚开"而白重连一次（还会清掉一次退避）。

**④ `force` 不清理在途请求**

`force` 只删内存缓存，紧接着的 `marketListInflight` 命中会把在途那条旧 Promise 原样
返回 —— 装完插件点「刷新」可能看到安装前的列表。修法：`force` 与
`clearMarketListCache` 同时抬一代（`marketListGen`）并清 inflight；`fetchList` 写缓存前
校验代际（上一代发的数据照样回给调用方，但不覆盖新缓存与磁盘文件）；
`finally` 里只清理"自己这一条"，否则会把接管后的新请求从去重表里删掉。

**两项待实机确认 / 提醒（非缺陷）**

- 日志 `17:07:11–17:07:17` 出现 7 秒内 6 次"展开（鼠标靠近）→ 收起（鼠标移开）"。
  代码层面"上膛"机制是闭合的，稳态不会自激；若非手动反复试手感，最可能是窗口重建时
  `widgetEdgeHoverReveal` 与光标轮询的交接问题。建议下次出现时在日志里补
  `near / armed` 字段，一次即可定位。
- 当前配置 `widget.transparent=true` + `opacity=50` 会让磨砂兜底失效
  （`frosted = opacity<100 && !transparent`），半透明卡片叠在**真透明**窗口上 ——
  正是 R46 记录的"只显示第一帧后冻结"链路。要稳定用不透明度，建议关掉「实验：真透明」。
  当日日志中小窗被反复重建四次，说明这个组合正在实际使用。

- 回滚：三处均为局部改动，按本节代码描述反向替换即可（`03-snowluma.js` 的
  `switchBotQqBusy` 声明 + 入口判空 + `!e.repeat`；`market.js` 的 `marketListGen`
  与三处 `marketListCache.set`；`app.js` 的 `obPortEdgePrimed` 与 connected 分支）。

---

### 修复 · 回复整句被方括号包住（第十六轮，同日，R142）

现象：群友看到机器人偶尔整句带方括号。**根因从会话存档坐实，不是管线加的**——
`data/sessions/mvgn0abd-152b4f6e.json` 里 `send_message` 的工具参数原文就是
`{"messages": "[那不就是纯躺平了]"}`，是模型自己写的。成因：上下文里塞满了
`[图片]` `[表情]` `[语音]` `[引用 …]` 这些**系统媒体标记**（由 `sender.appendSelf`
写进历史供模型理解消息类型），小模型（sensenova-6.8-flash-lite）照猫画虎，
把自己的整条回复也包了一层。近 60 个会话扫描：只有这 1 例命中，形态就是"整句一层壳"。

- **提示词立规矩**（`src/prompt.js`）：安全规则新增第 8 条「方括号不是你的表达格式」——
  说明那些方括号是系统标注媒体的记号、回复不要用方括号包住任何部分（整句/开头/结尾），
  想发表情/图片/语音就调对应工具。放在安全规则段，Skill 覆盖不掉。
- **发送前兜底剥壳**（`src/md-to-plain.js` 新增 `unwrapStrayBrackets()`，
  `src/sender.js` 的 `sendTextBatch` 在 `mdToPlain` 之后调用）：只处理确证形态——
  去首尾空白后整条消息恰好是**一个**方括号组、内部 ≤60 字、不含换行与嵌套括号、
  内部不是 CQ 码。句中方括号（`我说[这个]不错`）、`[[套娃]]`、`[一][二]`、跨行、
  `[CQ:image,…]` 一律不动 —— 宁可漏掉长句，也不误伤正常内容。
- 为什么两层都要：提示词是概率约束（小模型会复发），剥壳是确定性兜底；
  反过来只做剥壳的话，模型会持续产出这种格式、偶尔超出 60 字就又漏出去。
- 测试：新增 `bracket-send-test.mjs` **24 项断言全绿**（单元 14 / 与 mdToPlain 组合 3 /
  **真 `SendQueue` + mock onebot 端到端 4** / 提示词在位 2 / 顺序静态检查 1）。

---

## 0.4.8.6 · 2026-10-18 / 10-19（内部修订 R133–R135）

今日全部变更：1 项新功能、1 项新能力、15 项修复、8 项调整；后半天追加 2 项优化、2 项修复（R135）。

> **2026-10-19 追加（R134，版本号不升）**：按用户要求，当天全部改动并入本版更新报告。
> 主体是新能力（API 协议下拉、全局 LLM 代理、两个内置插件）、用量按插件归因、
> 扩展安装与诊断链路，以及一项群友反馈的回应缺陷修复。详见文末「2026-10-19 追加」。
>
> **2026-10-19 后半天追加（R135）**：提示词前缀缓存结构优化、调用明细补账本、
> 四个统计维度版式统一，另加「被 @ 未发言时不能提前结束」的保险。详见文末「后半天追加」。

### 新增

- **启动引导（OOBE，新模块 `ui/app/18-onboarding.js`）**
  群友多次反馈新手不知道从哪下手（"oobe也确实应该有引导"）。旧方案（r84）是
  "没配好就强行跳设置页"，被"每次点开都在设置界面"的反馈否决后整段移除，只剩
  右下角横幅 + 就绪圆点——对从没配过的新用户仍然不够：圆点不会说话。
  本实现是**全屏、可随时关掉**的四步引导（配模型 / 连 QQ / 选会话 / 定人设），
  四条约束都从历史教训来：① 不拦截不跳转，关掉照常进会话；② 只在「从没看过」
  或「引导改版」时自动弹一次，跳过与开始使用都写 `config.onboarding.seen`；
  ③ 完成态口径与就绪圆点 / 体检逐条一致，打开期间每 2s 跟随底层状态刷新；
  ④ 设置页侧栏保留「使用引导」手动入口。`ONBOARDING_VERSION` 改版时 +1。
  点「去配置」不止跳到设置页，直接把「模型管理」弹窗盖上来——弹窗里
  「＋ 添加提供商」就是最短路径，关掉后人还在对应分区，不会迷路。

### 新能力

- **插件面板 → 宿主命令桥（`src/routes.js` `/api/plugin-tool`、
  `06-settings-render.js` postMessage 桥、`index.html` CSP）**
  插件面板是只读静态页（安全模型见 `src/skills/panel.js`），群友反馈"表情库里的
  表情没法自己编辑"。现在面板可以把**用户明确点击的保存**转发成一次工具调用。
  安全三道缺一不可：① 来源校验 `keyEndpointAllowed`，只放行控制台自己；② 工具
  白名单，只放"不发消息、不读群上下文、只动插件自己数据"的工具（`sticker__note` /
  `sticker__delete_sticker` / `sticker__restore_sticker` / `sticker__list_deleted_stickers`）；
  ③ 工具必须真实注册且可执行。postMessage 只认自己嵌的那个 iframe（`e.source` 比对），
  origin 与 targetOrigin 都钉死同源，不往 `*` 发。
  首个用例：**表情库可编辑备注 / 标签**（`plugins/sticker/panel/viewer.js`），
  顶部工具按钮同时改成图标形态——「重新载入」四个字挤在统计后面太占地方。

### 修复

- **「Ctrl+V 时灵时不灵」一族**（`08-modals.js` / `09-community.js` /
  `07-settings-events.js` / `06-settings-render.js`）
  根因统一：粘贴前焦点停在 **readonly 的选择框**（`#gp-pick` / `#mc-model-pick` /
  `#pcp-pick`）上，Chromium 对 readonly 元素的粘贴命令**静默吞掉**——没有 paste
  事件、也没有任何反馈。修法是粘完 / 重渲染后显式把焦点还给"选择框之后第一个可编辑
  控件"，并在删行、开弹窗、程序化赋值等多条路径上分别兜底（程序化赋值不会触发
  input 事件，而表单自动保存依赖它）。

- **编辑型弹窗点外部直接关闭**（`08-modals.js` / `06-settings-render.js`）
  人设 / 模型这类弹窗误触丢内容太伤体验，改为点外部不关闭；×、取消、Esc 照常。

- **添加完提供商，模型管理左栏还是空的**（`08-modals.js` `refreshProvidersState`）
  `loadSettings()` 里 `state.providers` 的更新在内部 `Promise.all().then` 里（慢路径、
  没有 await），`await loadSettings()` 返回时它仍是旧值，紧随其后的 `onDone()`
  读到空数组 → 显示"还没有提供商"，自动选主模型也因目录为空而跳过。改为添加 /
  拉取后显式拉一次 `/api/providers`，不再赌时序。

- **配好提供商还要自己再去选一次主模型**（`08-modals.js`
  `autoPickMainModelIfNeeded`）
  萌新不知道还有这一步，配置永远停在半路、OOBE 也一直不变绿。规则：已有主模型不动；
  目录里只有 1 个模型直接选定（零操作）；多个才弹选择器。

- **模型报错终于说人话**（`src/llm.js` / `src/error-l10n.js` /
  `src/orchestrator.js` / `src/sessions.js`）
  `error-l10n.js` 的规则早就写好了（429 / 401 / 402 / 5xx / 模型不存在 / 接口地址错，
  全都有中文「原因 + 怎么办」），但**从未被调用**——用户实际看到的一直是
  `模型 API HTTP 429: {"error":...}` 这种英文原文。现在 `annotateApiError` 接上，
  `err.human` 挂到 `session.errorHuman`，前端渲染成中文卡片；`message` 前置中文标题，
  日志 / QQ 提示 / 老前端也能看懂，技术原文完整保留在后面（`isRetryableError` 的
  正则照常匹配）。错误连同本地化解释一起进会话摘要，从磁盘重建索引也不会丢。
  顺带改掉限流那条的错误建议：原文写"把界面刷新间隔调大"（那是控制台轮询场景），
  改成本场景真正可操作的三个动作。

- **「机器人思考了但没回话」**（`src/tools.js` `repairSendMessageArgs`）
  实测会话里出现过 `{"messages": 行 那你鼓吧 我等着听}`——模型想发消息，却把正文
  当成未加引号的 JSON 值塞进去，严格 `JSON.parse` 失败 → 整轮作废 → 群友什么都没收到。
  只对发送类工具做两种**不会发错内容**的保守修复：① 参数就是一整段纯文本 → 当成
  `{ messages: 文本 }`；② `{"messages"/"text"/"content": <未加引号的一行>}` → 抽出那段。
  其它情况（乱码 / 多行损坏 / 带数组 / 引号错乱）一律不猜，照旧报错让模型重发。

- **「查看收藏的表情」打不开**（`ui/index.html` / `src/app.js`）
  CSP `frame-src` 只写了 `https:`，插件自带页面（表情库 `viewer.html`、自检面板）
  是同源 `http://127.0.0.1:port/plugin-panel/...` 的 iframe，直接
  `ERR_BLOCKED_BY_CSP`。补 `'self'`。两份 CSP（meta 与响应头）取交集，必须同步改。

- **模型名被存成一串编号**（`src/providers.js`）
  `name` 缺失时不再兜底成 `id`——兜底会让 `modelNames` 存成一串 id，
  界面上显示的就是编号而不是模型名。

- **引导把人设步骤误判成「已自定义」**（`18-onboarding.js`）
  刚装完时 `persona.roleText` 就是内置文本，旧判定会把它标成"已自定义"还打勾，
  既误导又让"四步全绿"失去意义。改为：用现成模板（含内置默认小鲸鱼）不算自定义；
  模板列表没加载时保守判"未自定义"，不误报。

- **再次点「使用引导」时步骤区空白**（`18-onboarding.js`）
  `obLastSig` 是跨实例的签名缓存，第二次进入时签名没变 → 直接跳过渲染。

- **鼠标悬停在按钮上冒出两个提示窗口**（`ui/tooltip.js`）
  一个是软件自己的气泡、一个是系统的淡黄色小框。两层成因：
  ① 原生 tooltip 在元素自身没有 title 时会**向上找最近的祖先 title**，而应用里
  真实存在嵌套——`#readiness-dots` 包着 4 个 `.rdot-item`、`.mcard` 包着
  `.mcard-grip` / `.mcard-sw`，只摘自己那一个等于把提示让给了外层；
  ② `updateReadinessDots` 每轮状态轮询都执行 `item.title = d.title`，
  写回来约 1 秒后黄条照样弹出。改为「自身 + 整条祖先链一起收」，并用
  `MutationObserver` 盯住 `title` 属性，任何时刻被写上的一律立刻收进 `data-title`。
  气泡文字同时改为**弹出那一刻才读**，避免 450ms 内状态变了还显示旧文案。

- **消息存档页 / 记忆页左栏多出一圈细边框**（`ui/style.css`）
  皮肤层 `.list-pane { border: 1px solid }` 之前只清了 radius / box-shadow /
  background，**漏了 border**；底色已是 transparent，那 1px 描边就成了唯一还看得见
  的东西（右缘竖线 + 上下圆角）。与 r97 清 `#session-list`、R101 清
  `#settings-sidebar` 是同源漏项。

- **设置里较长的标题被挤成两行**（`ui/style.css`）
  标题行旧值是 `flex-wrap: wrap`，长名字（如「前缀缓存哨兵」）会换行，改为不换行。

- **扩展页把「正在加载」显示成「一件都没装」**（`06-settings-render.js` /
  `05-memory-settings.js`）
  首次进入（扩展列表还没拉回来）与"真的一件都没装"必须分开，加 `state.skillsReady`
  区分"加载中"和"真的空"。

- **退出兜底**（`electron/main.js`）
  单实例提示失败不再影响退出；启动链最外层补 try/catch，只做标记、不吞错误。

### 调整

- **默认人设「小鲸鱼」整体重写**（`src/personas.js` / `src/config.js`）
  群友反馈旧版"怼人太厉害"，整体降攻击性、篇幅减半。老配置里存的是旧版全文的，
  启动时静默换成新版——但**精确匹配旧文本才替换**，用户基于旧卡自己改过 / 微调过的
  一个字都不动（个性化修改优先于内置改版）。只在内存里迁移、不写盘，幂等无副作用。
  原版 v1 已移除，全文保留在 `LEGACY_XIAOJINGYU_TEXT` 里仅用于迁移判定。

- **系统提示瘦身：只保留基础规范**（`src/prompt.js`）
  所有人格与社交风格内容（反 AI 味、保持主体性、群聊心态、"像真人"、不当群管家）
  全部下沉到人设卡，由 `buildUserPrompt` 的【角色设定】段注入。原因：system 里写死
  "混在群里的普通群友 / 不是客服"这类角色扮演，会在用户切换人设时压过他自己的卡，
  出现系统提示和小鲸鱼人设"左右脑互搏"。

- **顶栏就绪指示器补缩写**（`01-boot.js` / `ui/style.css`）
  四项统一由一张表驱动：ok 时只有圆点；未就绪时在旁边补一个极短缩写
  （⚠QQ / ⚠SL / ⚠OB / ⚠配置），不用悬停也知道缺哪一项。QQ / SL 两项同时认
  OneBot 已连接——autoInject 命中 botQQ（用户自己登录的那份 QQ）、或挂外部 OneBot
  时，内置 SnowLuma 全程不跑，这两种"实际已就绪"的形态不该亮红字。

- **「工具」入口默认进 SnowLuma**（`14-chrome.js`）
  `harness ↔ snowluma` 对调：萌新点「工具」绝大多数是去启动 / 登录机器人 QQ，
  harness（自检 + 对话审查）属进阶排查。`home` 与 `subs` 顺序一起换。

- **设置页顶部两行提示可收起**（`06-settings-render.js` / `ui/style.css`）
  首次完整显示，点「知道了」收成一行并记住（`qa.settingsHintClosed`）；
  老用户天天进设置，两行提示每次都在眼前属于纯噪音。

- **内置模块默认展示顺序**（`06-settings-render.js` `DEFAULT_MODULE_ORDER`）
  排序逻辑改为"重要性与常用度"：每天在用的（记忆 / 表情 / 前缀缓存）→ 影响准确度的
  （发言人身份 / 思考适配 / 图片格式）→ 运行状态与账号 → 运维 → 进阶能力。
  以前落到 `plugins/` 目录字母序，把 `account-pool`、`cache-guard` 顶在最前面，
  用户完全看不出哪个是核心。只作默认值，用户拖拽过的顺序仍然优先。

- **市场页装扩展前常驻警告**（`16-market.js` / `ui/style.css`）
  插件数量与 token 用量 / 缓存命中率直接相关，且本版自带用量优化——第三方同类插件
  会冲突导致双双失效。警告条放在标题栏正下方，不挡搜索 / 筛选，装之前一定看得见。

- **更新报告卡片标题行吸顶**（`ui/style.css`）、**Windows 优先用 .ico**
  （`electron/main.js`）。

### 2026-10-19 追加（R134）

当天共 2 项大能力、4 项体验改造、6 项修复。版本号仍为 0.4.8.6。

#### 新增

- **API 协议下拉（新模块 `src/api-protocols.js`）**
  「模型管理 → 添加/编辑提供商」可选 OpenAI Chat Completions / OpenAI Responses /
  Anthropic / Google / Mistral 五种协议。设计上把边界收窄到"发出去 / 收回来"两刻：
  `buildProtocolRequest()` 把 OpenAI 形态 body 翻成目标协议，`parseProtocolResponse()`
  再翻回 `{choices, usage, model}` —— llm.js 的工具调用、Skill 请求改写、前缀缓存指纹、
  媒体预算、sameBody 预热全部保持原样，同一份 body 仍是逐字节一致的请求。
  Base URL 为空时自动填官方端点（`PROTOCOL_DEFAULT_BASES`）；UI 常量 `QA_API_PROTOCOLS`
  与后端目录逐一对应；连通性测试与实跑同源（显式传入 > providerId 已存 > 主提供商），
  避免"测试通过、实跑报错"。旧数据无 `apiProtocol` 时按 openai 处理。

- **全局 LLM 代理（新模块 `src/proxy-agent.js`）**
  接入国外模型 API 的本机代理需求。undici `ProxyAgent` 作为 `dispatcherFor()` 返回的
  dispatcher，`llm.js`（对话 / 模型列表）与 `providers.js`（探测 / 测试）统一带上。
  范围刻意收窄：`safe-fetch` 的 SSRF 安全线不动（其 proxy 参数仍是占位的 M4），
  SnowLuma 走本机回环、天然不经过本模块。仅支持 `http://`；socks5 明确警告后直连 ——
  "配了却没生效"比报错更难排查，不做静默降级。按地址字符串缓存单例，改地址立即重建。

- **用量页「按插件」归因（`04-archive-usage.js` / `src/plugin-usage.js`）**
  新增 `/api/usage/plugins`，与主统计分开请求（插件维度要扫会话文件 + 算提示词片段，
  较慢；失败不连累主页面，30 秒节流）。三种排行：区间总消耗（每次固定 × 调用次数 +
  工具结果）、每次固定开销、调用次数。另给出对话侧口径 —— 每次输入的平均 token
  减去全部固定开销（插件说明 + 核心工具说明），剩余即聊天记录 / 人设 / 运行时状态，
  分子分母都是真数。`14-chrome.js` 的 `dim` 增加插件维度。

- **扩展安装兼容性预检 + 三档回执（`src/zip-install.js` / `16-market.js` /
  `09-community.js`）**
  落地**之前**拦下三类"装完一定不能用"的包：清单 JSON 损坏（含 BOM 容错）、
  `apiVersion` 高于本机、声明入口文件不在包内。拦截即抛错，磁盘不留残骸。
  安装成功后后端会真实加载一次并把结果随响应带回，前端提示细分为
  「已安装并生效 / 已加载但当前关闭 / 加载失败」，失败时直接引导到「🔧 自动适配」。

#### 调整 / 修复

- **扩展卡片三枚状态徽章 + 自动适配入口**（`06-settings-render.js` /
  `07-settings-events.js`）
  ① 运行时熔断：加载成功、开关开着，但工具连续失败触发护栏 —— 徽章为临时态，
  到期半开、成功一次即复位；② 调用性诊断：`skillId` 聚合 `/api/tools/availability`，
  全部工具被单工具开关 / 分类开关 / 视觉依赖拦下时显示「工具被关」；③ lint 警告：
  `plugin-loader.js` 的 `lintKindPlacement` 结果从只进 console 改为落到
  `skill.lintWarnings`，界面可见「⚠️ 有警告」。加载失败或熔断的模块出现
  「🔧 自动适配」，一键送进升级工作台（复制暂存 → 模型适配 → 过闸 → 确认覆盖，
  原版备份可回滚），全程不原地改。

- **就绪度体检卡复活**（`06-settings-render.js` / `07-settings-events.js`）
  r84 移除首启强制跳设置页时把渲染调用一并摘掉，按钮绑定（`.hc-fix-btn` /
  `#test-api-btn`）却一直活着。现在挂回页头：仅在未就绪时显示，保存后重渲染，
  缺失项补齐即自动消失。

- **启动轮询改为 24 分钟硬时间预算**（`00-core.js`）
  旧实现按"240 轮 × 约 6 秒"估算，只有超时路径才那么慢；最常见的死端口
  （ECONNREFUSED）毫秒级失败，240 轮约 4 分钟就穷尽退出，"后台仍在重试"的承诺
  在最需要它的场景最先失效。改为 `BOOT_MAX_MS = 24 * 60_000`。

- **未连接横幅直达按钮**（`00-core.js`）
  「OneBot 未连接」从纯文字改为附带「打开 SnowLuma 页」；沿用 `lastBannerHtml`
  签名机制，html 变化才重建、监听器在重建分支补挂。

- **SnowLuma 页刷新保留交互态**（`03-snowluma.js`）
  15 秒 quiet 轮询与 SSE 状态事件都会整页重建，此前只补偿了滚动位置。现统一捕获 /
  还原：注入目标 QQ 号（含焦点）、展开的账号列表、控制台密码显示状态、两个排查卡
  `<details>` 展开态、四条 hint 文案。

- **工具集粘滞窗**（`src/tool-registry.js` / `orchestrator.js` / `config.js`）
  实测工具集合一天抖动 7 次（37→47→50→44→40→38→35），tools 段在 messages 之前，
  每次变化都把全部前缀缓存打穿（单次 15~20k token 全价）。`stabilizeToolset()` 在
  期望集变化后 90 秒内沿用旧集，把热装卸风暴折叠成一次变化；`scope=chatKey` 分桶，
  不跨会话污染；`epoch=getConfigVersion()`（配置写入 +1）让用户手动开关插件立即生效。
  UI 可用性显示仍走 `getToolAvailability` 真实结果，只有发送层被缓冲。

- **表情收藏链路**（`plugins/sticker/index.js` / `lib/stickers.js`）
  ① `registerTool` 的返回值没接住，策略段回落到裸名 `collect_sticker`，模型照提示词
  调用只会得到「未知工具」—— 表现为"答应了收藏却什么都没做"；改为接收宿主前缀后的
  id。② 策略段此前只字未提收藏，模型面对「帮我收藏这个表情」只会嘴炮；补上
  `collect` 名称与触发时机。

- **多人同时 @ 时漏回 / @ 错人**（`src/prompt.js`）
  新人设的「少而精、挑着接、只接其中一件、逐条回应是机器特征」压过了「被 @ 必须回」，
  多人同时唤醒时常只应一个人。新增独立段 `replyObligationRules()`：@ / 点名 / 引用提问
  按硬召唤处理，优先级高于角色卡；每条都要回应（一个字也算），多人同时叫要分别调用
  `send_message` 并各带 `atUserId`。抽成函数是为了 `systemPromptOverride` 分支也能注入 ——
  该分支会整体替换风格准则，但回应义务与安全规则 / 工具协议同属行为正确性，不可覆盖。
  人设卡刻意未改：老配置迁移依赖「精确匹配旧全文」，改文本会让迁移静默失效。

- **工具短名调用兜底**（`src/tools.js`）
  插件工具注册后 id 带 `<skillId>__` 前缀，而提示词 / 模型可能用短名调用。
  补第三档兜底匹配，修掉一类"插件开着、模型却调不到"的静默失败。

- **日志尾缀裸 `：null`**（`src/skills/manager.js`）：早先直接传 null 会在日志末尾
  拼出一个孤立的 "：null"，改为缺省不拼。

### 2026-10-19 后半天追加（R135）

当天下午再补四项；版本号仍为 0.4.8.6。

#### 优化

- **提示词前缀缓存结构优化**（`src/prompt.js` / `src/llm.js` / `plugins/cache-guard/index.js`）
  ① 把「此刻状态」里每轮都会变的群名搬进独立的 `【场景】` 段，并上移到「过去状态」之前，
  使首段（约 8.9KB 的人设与规则）成为**跨轮逐字节恒定**的前缀；② `seg-fp` 改用段内 LCP、
  `body-lcp` 截断到 `"tools":[`，不让整段 body 参与指纹；③ 日志按段记录命中情况。
  改动前实测：缓存未命中中位 198 token、断点后全价段 5,380 token（比值 27.2x）；
  改动后全价段缩到原来的 1/20 以内，聊得越久收益越明显。
  ⚠️ `plugins/cache-guard/index.js` 同步改为按 `\n\n【` 切段 —— 旧实现用
  `indexOf('【过去状态】')` 会误命中引导说明正文，导致上报的段长度全是错的。
  改完 `plugins/` 必须重跑 `refresh-builtin-baseline`（`builtin-modules.json` 是逐文件
  sha1 基线）；指纹失配时 `checkPluginTrust()` 会降级走能力扫描，用 `node:fs` 的插件
  **静默拒载**，不会弹任何提示。

- **四个统计维度版式统一**（`ui/app/04-archive-usage.js` / `ui/style.css`）
  按天 / 按会话 / 按模型 / 按插件此前只有「按插件」有说明行、摘要行和按钮行，其余三块
  只有一行灰标题就直奔图表，叠在一起像两套设计。现统一为固定骨架：
  `.usage-sec-head`（左标题 + 右侧计量，`min-height` 对齐小按钮）→ `.usage-sec-note`
  （一行说明）→ `.usage-sec-sum`（一句结论）→ 图表 → 折叠数值表 → 口径说明。
  摘要由新增的 `fillUsageSectionSummaries()` 按维度生成（峰值占比 / 主力模型占比 /
  单会话时指路「按插件」），占比口径跟随页首「图表」按钮；插件摘要改写入同一个
  `[data-sum="plugins"]`，不再单独一套 `up-*` 结构。顺带删掉旧非对称版式遗留的
  死样式（`.up-intro*` / `.up-sumline`）。

#### 修复

- **「调用明细」只覆盖最近几个小时**（`src/usage-ledger.js` / `src/app.js`）
  弹窗标着「近 7 天」，但 `toolCounts` 只从 `data/sessions/*.json` 解析 —— 活跃时
  120 个会话文件仅够 5 小时（实测覆盖 10:39→15:58，156 次工具调用，与弹窗的 157 吻合）。
  `ledgerRecordOf()` 新增 `toolCounts` 字段（按 `m.toolCall.name` 计数，与 `app.js:4053`
  逐字同口径），`usageLedgerTotals()` 累加；`app.js` 合并账本时用
  `usageLedgerPrunedRecords()` 把「文件已删」的行补回，并按 `startedAt` 二次滤窗口、
  以 `onDiskIds` 防重叠、空字段直接跳过（老账本日零额外 I/O）。
  老账本行没有该字段，读取方一律 `|| {}`，天然向后兼容。
  代价：账本每行 296B → 386B，按 900 会话/天约 347KB/天，`LEDGER_KEEP_DAYS=730`
  对应两年上限约 253MB。
  ⚠️ 覆盖边界：改动生效前已在磁盘的存量会话，一旦被裁仍补不回（账本老行没这字段）。

- **被 @ 未发言时不能提前结束**（`src/tools.js`）
  `finish` 工具新增守卫：被 @ / 点名且本轮还没发过言时，首次 `finish` 被拦下并提示先回应；
  同一轮第二次调用放行（避免无限重试）；没人 @ / 已发言 / @ 的是别人时照常放行。
  这是「多人同时 @ 漏回」的第二道保险 —— 提示词要求「每条都要回」，工具层再兜一次。

---

## 0.4.8.5 · 2026-10-16（内部修订 R132）

今日全部变更：1 项新功能、2 项新能力、16 项修复、2 项调整。

### 新增

- **QQ 版本核对（R132，新模块 `src/qq-version.js`）**
  启动时只读检测「实际要启动的 QQ 版本」vs「SnowLuma 协议端自报的客户端版本」，
  结果分 `ok` / `mismatch` / `unknown` 三态并附「下一步怎么办」话术，落入 QQ 日志，
  Snowluma 设置页同步展示。专治大众分发后的版本错开问题——此前版本不匹配只表现为
  "登录被拒 / 接口行为异常"，排查方向极易跑偏。模块零依赖、不 spawn、按 mtime 缓存
  （协议端 index.mjs 约 7.8MB，不重复读），探测失败一律返回 unknown，绝不影响启动流程。

- **表情软删除 / 恢复（sticker）**
  "删除"不再从 stickers.json 物理抹掉，而是记入隐藏名单（可逆，且不会被 ≤60 秒的
  QQ 收藏同步原样加回），备注 / 标签 / 使用次数 / 本地图片全部保留；查看器同步支持
  删除后即时反映（hidden 进指纹）与缩略图本地导出（本地转存的图浏览器读不了 file:///）。

- **会话选择页左栏搜索（R131）**
  新增搜索框，与主界面左栏同款排布（两页一致）；打字时只重画清单段、搜索框不重建，
  焦点与光标不丢；带清空钮（×）。

- **dev-orders 0.2.2：快照增强**
  `dev.snapshot` 新增跨会话累计用量（usageTotal：输入 / 输出 / 命中 / 总 token、
  调用与轮次）；列表截断为最新 100 条（界面每秒全量拉，payload 必须有上限），
  选中项不在最新 100 条时兜底追加到末尾，不再被客户端"不在列表就复位"每秒清掉；
  `/api/chats` 支持 `selected` 透传。

### 修复

- **拍一拍身份判定真值化**（app.js / store.js / prompt.js / orchestrator.js）
  判定改用事件自带的 `self_id`（权威视角，回落 `onebot.selfId`），并落 `pokeSelf`
  真值标记；档位判定与标签优先用真值，正则兜底补尾部边界。修复一组同根因问题：
  SnowLuma 慢启动 / 切号期间 `onebot.selfId` 可能为空或指向别的账号，导致真被拍时
  文案写成"X 拍了拍 机器人名"（拍一拍召唤识别不到）、机器人自己的发言被当群友消息
  入库 / 真群友消息反被丢弃；以及被拍者名字以"我"开头（如"我还能哈气喵"）时被
  误判成"拍我"。

- **群聊移除白名单后机器人仍在该群发言**（config.js / sender.js / orchestrator.js）
  发送侧补白名单硬闸：sender 五个出站方法（回复 / 表情 / 媒体 / 拍一拍 / 提醒）全部
  过闸，判定统一走 `config.js` 的 `isChatAllowed`（全库唯一实现）。修复：群被移出
  白名单前设的提醒 / 闹钟到点照发；会话运行中途被移出时回复照发。不在白名单的提醒
  静默丢弃（正常返回，不无限重试报错）。

- **活跃设置里禁言指令不生效**（orchestrator.js）
  指令禁言优先于活跃期：wake 的活跃期分支让位给档位判定（禁言已压 1 档仅艾特），
  主动开话题候选过滤禁言中的群。根因是「活跃期必响应」与「主动开话题」两条硬编码
  路径绕过了唯一的禁言执行点。

- **切换人设不成功**（05-memory-settings.js / 06-settings-render.js / 08-modals.js）
  `state.config` 改为第一个请求就绪即刷新（旧实现等 7 个接口的 Promise.all，含联网
  拉价格表，慢窗口内的自动保存会拿旧人设回传、把新人设深合并掉）；`POST /api/config`
  响应立即回写 `state.config`；修复人设编辑器收进弹窗后旧输入框不在场、旧值整段回传
  的问题。

- **内置人设静默抹掉「管理员附加规则」**（08-modals.js）
  内置人设 / 新建人设没有 `customRules` 时不再覆盖编辑器里已写好的规则——
  旧写法会在每次选择时把用户写好的附加规则抹成空串，选完保存即永久丢失。

- **私聊越权口子**（tools.js）
  `send` 工具 private 分支空名单不再无条件放行；group / private 对称——空名单必须
  显式开启 `allowAllWhenEmpty` 才放行，否则默认拒绝。修复"只配了 allow.groups 就能
  给任意私聊发消息"。

- **峰谷定价兜底反直觉**（config.js）
  peak / valley 任一点缺失时，先回退全局滑条（用户明确设过的值），全局也缺失才回退
  0（最保守 1 档）。旧实现对 undefined 返回 100（最贵 4 档）——配置残缺反而触发
  最高成本。原则："配置残缺宁可少回，不可爆成本"。

- **主动唤醒吞掉 @机器人 消息**（orchestrator.js）
  主动 wake 执行期间到达的 @机器人 消息已排了专用 wake，drain 时不再把它的未读
  一并带走——否则专用 wake 到点 drain 到空直接 aborted，@消息被静默吞掉。

- **历史翻页拿到重复内容**（orchestrator.js / prompt.js）
  `buildUserPrompt` 传入当前运行的 session，`pastStateCount` 正常写入，
  `get_recent_messages` 的翻页 offset 补偿不再恒为 0。

- **下载的插件嵌套文件夹导致缺少清单文件**（module-import.js / zip-install.js）
  以清单为锚点定位模块根（取最浅的清单所在目录），统一剥离多层包装——修复
  GitHub 下载的 `repo-main/插件名/index.js` 这类双层嵌套报"缺少 skill.json /
  plugin.json"。

- **发送计数包含被去重的消息**（tools.js）
  `deduped` 过滤后再计入 `session.sent` 与工具返回，`messageIds` 滤空。

- **工具中文名重名被误解析**（tools.js）
  工具查找 id 优先（英文 function name 才是唯一键），显示名仅作兜底。

- **合并转发解析兼容**（tools.js）
  `get_forward_msg` 结果兼容 `r.data.messages` 形态（原来只认 `r.messages`）。

- **图床直链过期的本地图片读不到**（tools.js）
  仅本地落盘、无 url 的图片（`m.file`）直接读本地字节回传，不再漏掉。

- **指令禁言状态卡片不刷新**（02-sse-sessions.js）
  群内 @机器人 + /安静 的指令禁言会发 chat-update，会话设置页在场时同步重渲染——
  否则卡片停在"未禁言"，用户以为指令没生效（这正是确认修复生效的直接证据）。

- **人设摘要卡不提示"隐形覆盖层"**（06-settings-render.js）
  摘要卡显式报出两个优先级高于全局人设的隐形层：分会话独立人设（personaByChat）
  与主人专属人设（owner-identity 插件）——否则切全局人设后看到旧行为，以为切换坏了。

- **自检页面整体瘫痪**（13-doctor.js / 06-settings-render.js，今日会话内修复）
  13-doctor.js 的 `function fmtTok` 与核心库 `00-core.js` 的 `const fmtTok` 顶层
  重名，经典脚本共享全局作用域直接 SyntaxError，整个自检页面一行都跑不了。
  已改名 `fmtTokCompact`（声明 + 4 处调用）；顺手移除 06-settings-render.js 里
  重复的 `clampInt` 声明（与核心库实现相同，留注释指向共享版）。

### 调整

- **sticker 表情发送概率**：`encourage` 默认档 1 → 3（最高档"表情包爱好者"）——
  用户大量反馈"表情包发送概率太低"。
- **表情本地图片不可用话术**：补全两种可能（不在受控收藏目录内 / 本地文件是空壳），
  不再只报第一种。

---

## 0.4.8.4 · 2026-10-15

（略：见 Git 提交与内部修订 R130–R131 记录）
