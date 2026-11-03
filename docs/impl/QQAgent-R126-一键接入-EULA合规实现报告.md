# QQAgent R126 · 「一键接入」：在 EULA 允许的范围内把注入做到最傻瓜

> 版本：0.4.9.1（运行目录 `G:\QQagent\resources\app`）
> 日期：2026-10-27
> 前提：SnowLuma EULA v1.1（生效 2026-07-21），中文版为准

---

## 一、EULA 到底禁止了什么

通读全文，与"能不能自动化"直接相关的只有三处：

**第 2.2 条（源码许可）**
> 任何商业使用，以及公开发布修改版或衍生版，均须事先取得著作权人的书面授权。

**第 5.3 条（专有组件）**
> 不得对专有组件进行逆向工程、反编译或反汇编，亦不得规避、破解或绕过其授权或激活机制。

**第 5.4 条（专有组件，关键）**
> 除事先取得著作权人的书面授权外，您仅可为 LICENSE 允许的非商业用途，**以专有组件随本软件
> 提供的形式运行该组件**；不得复制、修改、单独再分发或再许可该组件。**将其并入第三方安装包
> 或 Docker 镜像、通过自动化脚本部署，或者将其用于任何商业用途，均须事先取得书面授权。**

第 5.4 条其实同时划了两条线：

- **禁止的是**：复制 / 修改 / 单独再分发 / 再许可；并入第三方安装包或 Docker；**通过自动化脚本部署**；商业使用。
- **允许的是**：以发行包原样**运行**该组件（非商业用途）。

第 4 条（可接受使用）与自动化无关，管的是违法、攻击、垃圾信息、侵权。

> ⚠️ 我不是律师，以下是基于文本的产品判断，不构成法律意见。真要对外分发，建议找
> SnowLumaDevs 拿一份书面授权（EULA 里给了联系方式 motricseven@foxmail.com）。

## 二、据此划出的红线

判断标准是"**这是在使用软件，还是在部署软件**"。EULA 禁的是后者。

| 做法 | 判定 | 理由 |
|---|---|---|
| 用户点一下，软件代为启动它（`windowsHide`） | ✅ | 以发行包原样运行；不是安装、不是配置 |
| 读它的 stdout（含它自己打印的初始密码） | ✅ | 那是它**主动展示给用户**的信息 |
| 调 `/api/login`、`/api/processes`、`/api/processes/:pid/load` | ✅ | 等价于用户在它的网页上点"登录 / 注入" |
| 写它的 `config/webui.json`、接管控制台密码 | ❌ | 属于"修改"它的文件 |
| 注入 `SNOWLUMA_ACCEPT_EULA=1` 跳过同意页 | ❌ | 代用户表态 |
| 调 `/api/agreements/record-consent` | ❌ | 同上 |
| 调 `/api/auth/change-password` 替它设密码 | ❌ | 同上（用户不知道密码是什么，等于代管） |
| 复制 `native/*.node`、打进安装包 / Docker | ❌ | 5.4 条明确禁止 |
| 脚本替用户下载、解压、安装 | ❌ | "通过自动化脚本部署" |

**0.4.8.x 时代踩过的两个坑**（本次没有恢复）：

1. `prepareSnowlumaWebuiAuth()` 直接改写 `config/webui.json` 接管控制台密码 —— 修改它的文件；
2. 启动时注入 `SNOWLUMA_ACCEPT_EULA=1` / `SNOWLUMA_ACCEPT_PRIVACY=1` —— 代签协议。

## 三、那么"傻瓜化"能做到哪一步

把用户原本要在 SnowLuma 网页上做的五步，拆成"能自动"和"必须人做"：

| 原步骤 | 现在 |
|---|---|
| 1. 启动 SnowLuma | 自动（点一次，无窗口） |
| 2. 打开 5099 控制台 | 自动（后台直接调 API，不弹浏览器） |
| 3. 登录（密码在启动日志里） | **首次可自动**：从日志里捞 `initial credentials: user=admin password=…`；改过密码后需用户填一次 |
| 4. 在进程表里挑机器人 QQ | 单号自动；多号让用户选（安全起见不能猜） |
| 5. 点「注入」 | 自动，并记住这个号 |

需要用户本人做的三件事（界面会停下来引导，不代劳）：

- 同意用户协议 / 隐私政策（`consent`）
- 改掉初始密码（`must-change`）
- 开过两步验证时输动态码（`need-totp`）

## 四、实现

### 4.1 新增 `src/protocol-webui.js`（控制台客户端）

- `login(password, {totp})` → 把 SnowLuma 的响应归成 7 种：`ok / rejected / locked /
  needs-totp / consent / must-change / unreachable`。
  **"连不上"绝不归成"密码错"** —— 后者会让用户去重置密码，而真实原因只是服务卡了一下。
- `processes / load / unload`，字段归一成 `{pid, uin, nickname, injected, loggedIn}`。
- `extractInitialCredentials(lines)`：从日志里捞初始凭据。

### 4.2 新增 `src/protocol-onboard.js`（状态机）

`status()` 给出 13 个阶段之一，UI 只认这些字符串：

```
no-dir → stopped → booting → need-password → locked / need-totp / consent / must-change
                                     ↓
                              no-qq → pick → wrong-target → can-inject → ready
```

`decideStage()` 是纯函数，单独可测 —— 它决定"会不会把个人号注入成机器人"：

- 配过机器人号（`protocol.lastUin`）→ 只认这个号；
- 已经注入了别的号 → `wrong-target`（**不能**当成 ready）；
- 没配过号 + 只有 1 个 QQ → 直接注入；多个 → `pick`。

### 4.3 登录退避（必须有，不然会把用户锁死）

SnowLuma 连续 5 次密码错误锁 15 分钟。而 `status()` 会被页面反复调用，如果每次都拿存着的
错密码去试，用户什么都没干就被锁了。所以：

- 密码错 → 30 秒内不再真的发登录请求；
- 被锁 → 15 分钟内不再试；
- 要同意 / 要改密码 / 要动态码 → 不退避（不消耗尝试次数）。

### 4.4 密码怎么存

`protocol.webui.password`，只在本机 `data/config.json` 里。`sanitizeConfig` 的正则里有
`password`，所以 `/api/config` 返回给前端时会被脱敏成 `hasPassword: true`，接口永不回明文。

## 五、实测（2026-10-27 08:53，真实 SnowLuma 2.1.1）

```
1) launch: {"ok":true,"launched":true,"pid":5480,"hasOwnNode":true}
2) ping:   {"reachable":true,"status":401}          ← 服务活着（401 = 要登录）
3) login(故意错的密码): {"ok":false,"kind":"rejected","message":"密码错误"}
4) onboard: stage=need-password, hasPassword=false  ← 停在"要密码"，没有瞎试
5) 日志: [WebUI] listening http://127.0.0.1:5099
6) stop:  {"ok":true,"stopped":true}
```

这验证了三件事：API 路径与响应格式对得上 2.1.1、错误分类准确、"没密码时绝不乱试"。

## 六、用户视角：从下载到机器人上线

| # | 用户动作 | 说明 |
|---|---|---|
| 1 | 去 github.com/SnowLuma/SnowLuma 下载 zip，解压到任意目录 | 必须自己做（EULA：不能由我们部署） |
| 2 | QQ Agent → 连接 → 协议端进程 → 填目录 → 「无窗口启动」 | 没有黑窗口 |
| 3 | 首次启动时去它的控制台同意条款（若需要） | 必须本人点，界面给按钮直达 |
| 4 | 登录机器人 QQ（QQ 客户端） | 必须自己做 |
| 5 | 连接 → 一键接入 → 填一次控制台密码（若改过） | 之后记住 |
| 6 | 点「接入」 | 完事 |

首次启动、没改过密码的情况下，第 5 步会被自动跳过（密码从日志里读）。

## 七、风险与后续

- **密码错了会消耗尝试次数**：已用退避把影响降到最低，但用户在别处（浏览器）反复试仍会被锁。
  界面在 `locked` 阶段会明确说"等几分钟，别反复点"。
- **SnowLuma 升级改了 API**：客户端把所有异常归到 `unreachable` / `error`，不会误判成密码错；
  真改了路径的话表现为"一直停在 booting"，届时按它的 `index.mjs` 重新核对路径即可。
- **多号场景仍可能选错**：`pick` 列表里显示昵称 + QQ 号 + 是否已注入，选错后在 `wrong-target`
  阶段还能一键切回来。
- **未做**：TOTP 自动填（需要用户提供密钥，属于保管用户凭据，暂不做）；自动改密码（红线）。
