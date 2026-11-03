# QQAgent R124 · 0.4.8.2 打包记录

日期：2026-10-14
产物：`C:\Users\Administrator\Desktop\洛版QQagent 0.4.8.2.exe`（171,500,359 字节 / 163.6 MB）

## 一、打包源的选择（重要）

打包前对两份安装做了全树比对，**发现开发树落后于运行版**：

- 运行版 `G:\QQagent` = 权威源，含 r113 人设市场（`ui/app/17-persona-market.js`）、`personamarket` 子页与专属图标、`src/atomic-write.js`、`src/error-l10n.js`、`electron/external-link.js`，版本号已是 `0.4.8.1`
- 开发树 `C:\Users\Administrator\Desktop\洛版QQ-Agent-v0.4.8\resources\app` 仍是 `0.4.8`，**没有人设市场**，另有 15 个文件与运行版不同（`src/*` 7 个、`plugins/*` 5 个、`ui/index.html`、`ui/style.css`、`ui/app/14-chrome.js`、`package.json`）

因此本轮 `--src` 取 **运行版 `G:\QQagent`**（若用开发树打包会丢掉人设市场功能）。
R122 / R123 那两个文件（`15-chat-chrome.js`、`06-settings-render.js`）两份是逐字节一致的，所以两份都带着这两个修复。

命令：

```
cd C:\Users\Administrator\Desktop\打包器
python make-portable.py --src G:\QQagent --version 0.4.8.2
```

（`--ref` 取默认的最新参考包 `洛版QQagent 0.4.8.1.exe`，输出落在桌面）

## 二、软件内更新日志（本次顺手更新）

位置：`ui/app/14-chrome.js` 的 `STAGE_CHANGELOG`（会话首页那张「更新报告」卡片，本地数据、不联网）。

写法：**新增一条 0.4.8.2 放在最前，保留 0.4.8.1 记录**——卡片会同时显示两版，第 1 条带「最新」标记；version 顶到新号，所以**点过 × 关掉过的用户也会重新看到**。

0.4.8.2 的 5 条（面向用户口径，不写内部术语）：

1. 会话列表不再自己乱跳：你手动点开某条会话或往上翻记录时，自动滚动会先让一让，不会硬把你拽回底部
2. 追最新消息时右栏只更新有变化的那几张卡片，不再整块重刷，滚动位置也不会被顶回去
3. 已经展开的会话卡片不会被自动收起，切走再切回来仍然保持展开
4. 修掉了会话卡内容偶尔「张冠李戴」（A 会话的卡片显示成 B 会话的内容）的问题
5. 设置页切换分区时不再闪一下

对应内部轮次：R122（自动跟随暂停 / 右栏增量 reconcile / 卡体自愈 / 锚点补强 / 手风琴 park / collectSessionNodes 调包）、R123（设置页切分区动画改播在新内容上）。

## 三、打包链路（make-portable.py 五步，全绿）

| 步骤 | 结果 |
|---|---|
| ① 顶版本号 | `package.json` → 0.4.8.2；`14-chrome.js` 更新报告卡片 → 0.4.8.2 |
| ② payload.7z | 96,769,518 字节，464 个文件（按参考包清单挑选） |
| ③ 换 payload + 顶安装器界面版本 | `shell/resources/app.asar` → 0.4.8.2 |
| ④ app-64.7z | 171,121,390 字节 |
| ⑤ assemble.py 装配 + 自检 | 4 项全过 ✓ |

assemble.py 自检明细：

```
[1] firstheader 总长自洽: True（171,500,359 vs 171,500,359）
[2] 条目链闭合到 EOF: True（4 条）
[3] 全部 filedata 偏移有效: True（4 处偏移全部命中真实条目）
[4] 7z: 长度自洽 True, startHeaderCRC True, nextHeaderCRC True
```

## 四、投产前验证（我额外做的解包核对）

光看自检不够——payload 是**按 0.4.8.1 的清单挑的**，必须确认本次改动的文件真在包里。于是把新 EXE 剥两层（EXE → `resources/payload.7z` → 文件）逐字节核对：

- `resources/app/package.json` → `"version": "0.4.8.2"` ✓
- `resources/app/ui/app/14-chrome.js` → 首条 `0.4.8.2 / 2026-10-14`，第二条 `0.4.8.1`，5 条新内容都在 ✓
- `resources/app/ui/app/06-settings-render.js`（18:52，R123）→ 13 处 R123 标记 ✓
- `resources/app/ui/app/15-chat-chrome.js`（18:15，R122）→ 9 处 R122 标记 ✓
- `resources/app/ui/app/17-persona-market.js` → 在包内（没被旧清单漏掉）✓
- `shell/resources/app.asar` → 含 `0.4.8.2`（安装/卸载面板版本）✓
- `7za t` 完整性测试：75 文件、无报错 ✓

两处版本号都顶了：应用自报版本（payload 内 package.json）与安装/卸载面板版本（app.asar）。

## 五、待办

1. **双击试装**：应弹出「QQ Agent 安装程序」窗口；装完进设置页确认版本号显示 0.4.8.2，会话首页应出现带「最新」标记的更新报告卡片
2. **真机回归**（R122 / R123 全部修复此前都还没重启验证）：
   - 会话选择界面：有新会话到达时不抢选择、不弹回顶部、展开态保持、卡片内容不串
   - 设置页：切到「工具与技能」不再闪一下；打字后立刻切分区不丢输入
3. **开发树对齐**：开发树整体落后运行版约 17 处（含人设市场功能），下次若从开发树打包会丢功能——建议以运行版为准回灌，或明确废弃开发树
4. 仍排期：A 组（右栏增量 reconcile 根治，可让 R118~R121 大部分补丁退役）

## 六、备份

- `G:\QQagent\resources\app\ui\app\14-chrome.js.bak-R124-20261014`
- `G:\QQagent\resources\app\package.json.bak-R124-20261014`
- 开发树同名备份各一份（本轮未改开发树内容，仅备份）

语法校验：`node --check` 与 `node --input-type=module --check` 双方式通过。
