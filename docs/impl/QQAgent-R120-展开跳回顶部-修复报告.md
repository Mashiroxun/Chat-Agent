# QQAgent R120 修复报告：展开卡片后直接弹回最上面

- 日期：2026-10-14
- 备份 tag：`R120-20261014-173940`（两份安装同 tag）
- 改动文件：`ui/app/15-chat-chrome.js`（两份安装，改后 md5 一致）
- 补丁：`r120-fixes.patch`
- 状态：代码完成、语法校验通过，**待重启后真机验证**

## 症状

R119 重启（17:37:14）后实测：**点开折叠的会话卡，展开后右栏直接弹到最上面**。（R118/R119 治的是"新消息到达时跳顶"，这条是"展开这个动作本身跳顶"——两条不同路径。）

## 根因（R114 时代就埋下的顺序错误）

详情包裹层正常分支（选中卡的卡已存在时走这条）的旧代码：

```js
// ① 摘骨架进 HOLD；顺手记滚动快照
chrome.forEach(n => HOLD.appendChild(n));        // ← 先把 #cc-cards 整体摘出 DETAIL
var snaps = [DETAIL, selCard.querySelector('.bs-cb')].map(el => ({
  top: el.scrollTop,                             // ← 此刻 DETAIL 内容已被摘空，
  bottom: ...                                    //   scrollHeight 塌到 ≈clientHeight，
}));                                             //   scrollTop 被浏览器钳成 0！
...
snaps.forEach(sn => { sn.el.scrollTop = (run && sn.bottom) ? sn.el.scrollHeight : sn.top; });
//                                          ↑ 非运行中会话走这里 = 恢复成 0 = 弹回顶部
```

`#cc-cards` 是 DETAIL 的全部滚动内容，摘走后 scrollTop 立即被钳到 0——**快照记下的是 0，重建后把 0"恢复"回去**。于是每次选中卡详情重渲染（点开折叠卡、SSE patch、切会话）都弹顶。运行中的会话被「贴底跟随」分支（`run && sn.bottom` → scrollHeight）掩盖着，所以一直没暴露；读历史卡（非运行态）必现。

## 修复（一行顺序）

**先记滚动快照，再把骨架摘进 HOLD**：`snaps` 在 `HOLD.appendChild` 之前计算，记下的是摘骨架前的真实 scrollTop / bottom；重建后照常恢复。`bottom`（贴底判断）同样以摘骨架前的真实状态为准，运行中会话的跟随行为不受影响。

## 与 R118/R119 的分层（三层互补，都在位）

| 路径 | 跳顶原因 | 负责修复 |
|---|---|---|
| 选中卡已存在（点开折叠卡 / SSE patch） | HOLD 摘骨架后 scrollTop 钳 0，snaps 抓到 0 | **R120：快照先行** |
| 新会话自动跟随（卡不存在 → 回退全量重建） | 02 的 `rd.apply` 先清空 DETAIL，锚点抓晚 | R119：回退分支 rd.apply 前抓锚 |
| 慢接口（>200ms 占位清空）/ 失败直写 | 02 的 hintTimer / 错误写入清空 DETAIL | R119 入口② + R117 落地重建 |

## 验证与回滚

- `node --check` 两份通过；`md5sum` 两份一致（`6a496b36…`）。
- 回滚：`cp 15-chat-chrome.js.bak-R120-20261014-173940 15-chat-chrome.js`（两份同 tag），或 `patch -R` 应用 `r120-fixes.patch`。
- **待重启验证**：① 点开靠下的折叠卡，展开后视野停在原地（卡片就地展开，不跳顶）；② 运行中的会话照常贴底跟随；③ 新消息到达（R119）同样不跳。
