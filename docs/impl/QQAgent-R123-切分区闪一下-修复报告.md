# QQAgent R123 修复报告：设置页切到「工具与技能」时界面闪一下

- 日期：2026-10-14
- 现象：设置页点左侧「工具与技能」，右栏会闪一下（旧分区短暂回来、再被整体换掉）。
- 改动文件（唯一）：`ui/app/06-settings-render.js`（两份安装同步：`G:\QQagent\resources\app` 运行版 + `C:\Users\Administrator\Desktop\洛版QQ-Agent-v0.4.8\resources\app` 开发树，md5 一致 `752cbd69…`）
- 备份 tag：`R123-20261014-185157`；补丁：`r123-fixes.patch`（134 行）
- 校验：两份 `node --input-type=module --check < ui/app/06-settings-render.js` 通过

---

## 一、怎么复现与取证（本轮新增能力）

控制台服务（`http://127.0.0.1:3210/`，`data/console-port`）提供**真实 UI + 真实 API**，无需起第二套后端。用零依赖脚本驱动它取证（脚本保留在 `tools-flash/`）：

- `cdp-flash.cjs / .cjs2 / .cjs3 / .cjs5`：Node 22 内置 `WebSocket` + `fetch`，走 Chrome DevTools Protocol 驱动无头 Edge（`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`），做 `Page.startScreencast` 录屏 + 页面内 `Runtime.evaluate` 插桩（rAF 逐帧采样 DOM/opacity/动画、`PerformanceObserver longtask`、函数栈追踪）。
- ⚠️ 两个坑：① 从 Node `spawn` Edge 时 `--user-data-dir` 必须给**绝对路径**（相对路径会 exit 21 秒退）；② 控制台在**应用启动时缓存静态文件**——改完必须重启应用才生效。

## 二、实测时间线（点击「工具与技能」）

```
+  0ms renderSettings 进入  guard=1  kids=6     ← 被守卫挡下（保存在途），DOM 未动
+  0ms renderSettings 退出  kids=6              ← 早退：右栏还是旧分区
+  0ms form.animate  dur=320                    ← 入场动画已开始播
+  1ms raf kids=6 op=0.000                      ← 旧内容，不可见
+  9ms raf kids=6 op=0.106                      ← 旧内容被淡入…
+ 14ms raf kids=6 op=0.206                      ← …到 20%
+ 19ms renderSettings 进入 guard=0              ← POST 返回 → endSettingsGuard 补放
+ 23ms renderSettings 退出 kids=2               ← DOM 这才掉包成新分区
+ 24ms raf kids=2 op=0.298                      ← 新内容从 30% 接着淡入
+181ms raf op=1.000                             ← 中间 157ms 主线程空档（掉帧）
```

## 三、根因

1. **换区被守卫推迟到网络往返之后。** 菜单项 click 处理第一步是 `flushSettingsSaves()`，而 `flushSave()`（07:294）**无条件**调 `doSave()` → `beginSettingsGuard()` → POST `/api/config`。守卫 `pending>0`，紧跟其后的 `renderSettings()`（06:187）被挡下并记为「待重绘」，真正的重建要等 POST 返回（`endSettingsGuard` 补放）。实测当地 23ms，真机后端忙时更长。
2. **动画不等它。** `form.animate(...)`（原 06:205）紧跟 `renderSettings()` 无条件播放 —— 于是动画播在**旧分区**上：旧内容被从 0 淡入到 20%~50%，再被整体换掉。**这就是"闪一下"。**
3. **还会再来一次重建。** 保存返回后 `endSettingsGuard` 因 `needRerender` 又重建一遍（20ms 内两次全量 `innerHTML` 换血）= 又闪一下。
4. 附带：掉包后有一次 ~157ms 主线程空档（无头软件渲染下测得；GPU 机器上应更小），让淡入从 30% 直接跳到 100%，加剧"闪"的观感。

## 四、修复（三处，都在 06-settings-render.js）

1. **切分区越过守卫**（`settingsSwitchBypass`）：守卫判断改 `if (settingsGuard.pending > 0 && !settingsSwitchBypass)`。
   安全性依据：`saveConfig`（08:1639）是**同步把表单读完**再 POST 的 —— `flushSettingsSaves()` 返回时值已被读走并发出请求，此后重建 DOM 不会丢数据；且新分区的字段不属于这次保存要写回的范围，不会被陈旧 `state.config` 覆盖。
2. **入场动画改挂在"真正完成重建"的那一次**（`pendingSwitchAnim` 欠条）：click 里只挂欠条，由 `renderSettings()` 在 `innerHTML` 换完、`bindSettingsEvents()` 之后兑现并播放（动画内容抽成 `playSwitchAnim()`，R107 两段式弹出参数原样保留）。无论重建是当场完成还是将来被补放，动画覆盖的都必然是新内容。
3. **撤掉多余的一次重建**：click 处理末尾 `settingsGuard.needRerender = false`，避免保存返回后二次全量重建。

## 五、验证状态

- 静态：两份语法检查 + md5 一致 + 补丁已生成。
- 动态：**待重启回归**（改完时控制台已随应用关闭，无法在线复测；且控制台缓存静态文件，必须重启生效）。
- 建议回归动作：设置页连点各分区（尤其 → 工具与技能），确认① 不再出现旧分区残影；② 换区不再"等网络"（点击即换）；③ 不再二次重建；④ 在输入框里打字后立刻切分区，确认输入没有被吹掉（守卫语义仍是保护这一条）。

## 六、遗留与观察

- 仍保留 R107 设计的两段式弹出（新内容从 opacity 0 淡入 + 20px 位移 + 缩放 .94）。若你觉得连这个淡入也算"闪"，可以再调：缩短时长 / 改小位移 / 只淡入不缩放 —— 说一声即可。
- 掉包后 ~157ms 的主线程空档（软件渲染环境测得）未处理，怀疑与工具页右栏 9K 字符的 `<pre>` 排版 + 46 张工具卡的布局/绘制有关；真机 GPU 下应明显更小。若重启后仍觉得切换"顿"，再针对这一项优化。
