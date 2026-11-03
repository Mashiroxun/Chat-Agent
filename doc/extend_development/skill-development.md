# 技能开发规范（LLM 型）

> 「什么时候该动」要**看懂内容才知道**的扩展，就写成技能。
> 完整字段与 API 表见 [skill-reference.md](skill-reference.md)（**必读**）；
> 整体结构见 [skill-system.md](skill-system.md)。

---

## §0 先判断：该做技能还是插件

**大多数人分不清这两型，所以先花两分钟回答三个问题。** 选错的后果不是报错，
是**功能静默失效**——装上了、开关也是开的、就是不干活（原因见 §0.4）。

### 第一问：触发时机能不能写成一条规则？

| 你的功能 | 答案 |
|---|---|
| "用户问天气的时候帮他查一下" | ❌ 不能，得**看懂**这句话是不是在问天气 → **技能** |
| "每条消息都看一眼，命中关键词就回一句" | ✅ 能 → 插件 |
| "有人撤回消息时，跟着发一句" | ✅ 能 → 插件 |

### 第二问：需要模型"理解内容"才能决定吗？

- **需要**（判断这句话是不是在接梗、要不要查资料、该用哪个工具）→ **技能**
- **不需要**（机械地记个数、加个字段、按时间轮换）→ **插件**

### 第三问：你希望它是"必然发生"还是"模型自己看着办"？

- **必然发生**：安全规则、缓存守卫、协议方言适配、撤回反应 → **插件**
- **看着办**：一个可以查资料 / 算数 / 发表情的工具 → **技能**

### §0.4 选错了会怎样

`src/plugin-loader.js` 对两型走**同一条加载路径**，所以两型都"能装上"。
区别只在 `lintKindPlacement` 的一条**告警**（不阻断加载）：

| 放错的情况 | 实际后果 |
|---|---|
| 该做技能，却放进 `plugins/` 并且**没有 providers/hooks** | 没有任何核心代码会调它 → **永远不触发** |
| 该做技能，放进 `skills/` 但**忘了注册工具** | 模型看不到它 → **永远不触发** |
| 工具 `description` 没写清"什么时候用" | 模型不知道何时该调 → **基本不触发**（最常见的静默失效） |

所以：**判据一句话 —— 规则能写死 → 插件；要理解人话 → 技能。**

> 补充：两型技术上可以混用。一个模块完全可以既 `registerTool` 又提供 `hooks`
> （`plugins/sticker` 就是：5 个工具 + 1 个 hook + 1 段提示词）。
> 目录只决定它在控制台归到哪一页。所以"三问"是在问**主要用法**。

---

## §1 技能的本质：模型来找你

技能不"监听"什么。它做两件事：

1. **注册工具**：`api.registerTool({...})` —— 工具进模型的 function 列表；
2. **给提示词**：`manifest.prompt` 或 `promptSections()` —— 告诉模型"什么时候该用"。

模型看到的是**工具列表**，不是技能本身（控制台技能页尾注原话）：

> 这些工具会被放进发给模型的 function 列表 —— 模型只能看到工具，看不到技能本身。

所以技能的成败，八成取决于 **工具描述写得够不够清楚**。

---

## §2 最小可运行技能

`skills/my-weather/skill.json`：

```jsonc
{
  "id": "my-weather",
  "name": "天气查询",
  "version": "1.0.0",
  "apiVersion": 1,
  "category": "query",
  "description": "群友问天气时查一下并回答。",
  "enabledByDefault": false,          // 自创扩展建议 false，装完由用户亲自开
  "permissions": ["web_fetch"],        // 要联网就必须声明，否则 api.fetch 永远 reject
  "settings": { "city": "北京", "timeoutMs": 8000 },
  "configSchema": {
    "city": { "type": "string", "label": "默认城市", "description": "不带城市名时的默认值。", "default": "北京" },
    "timeoutMs": { "type": "number", "label": "超时（毫秒）", "description": "接口超时上限。", "default": 8000 }
  },
  "prompt": {
    "when": "当群友询问天气、会不会下雨、要不要带伞，或问气温/风力时",
    "examples": ["今天天气怎么样", "明天会下雨吗", "北京现在多少度"],
    "instruction": "调用 get_weather 工具，city 参数填城市名。查不到就直说查不到，不要编。"
  }
}
```

`skills/my-weather/index.js`：

```js
export function register(api) {
  api.registerTool({
    id: 'get_weather',                 // 最终 id = my_weather__get_weather
    name: '查天气',
    description: '查询指定城市的当前天气（天气状况、气温、风力）。适用：群友问"今天天气怎么样"、'
      + '"明天会下雨吗"、"北京现在多少度"。',
    category: 'query',
    icon: '🌤️',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，如"北京"。不带时填默认值。' }
      },
      required: ['city']
    },
    async execute(ctx, args) {
      const city = String(args?.city || '').trim() || (api.config()?.city || '');
      if (!city) return { content: '请告诉我城市名', isError: true };
      try {
        const r = await api.fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
        const d = await r.json();
        const cur = d?.current_condition?.[0];
        if (!cur) return { content: `没查到 ${city} 的天气`, isError: true };
        return { content: `${city}：${cur.weatherDesc?.[0]?.value ?? '未知'}，${cur.temp_C}℃，湿度 ${cur.humidity}%` };
      } catch (e) {
        return { content: `天气查询失败：${e?.message ?? e}`, isError: true };
      }
    }
  });
}
```

---

## §3 工具描述怎么写（这是技能成败的关键）

模型只看到三样东西：`name`、`description`、`parameters`。
其中 **`description` 决定了它会不会被调用于正确时机**。

### 3.1 三段式写法（项目内的一致做法）

```
<这个工具做什么>（<支持哪些用法>）。适用：<什么时候该用，带 2~3 个原话例子>。
```

对照 `skills/calculator` 的真实写法：

```js
description: '计算一个数学表达式（支持 + - * / % 括号，以及 ^ 幂运算和 sqrt() 平方根）。'
  + '适用：群友问"1+1等于几"、"帮我算一下 123*456"、"2的10次方"、"sqrt(144)"。',
```

- **前半段**：能力边界（支持什么、不支持什么）
- **"适用：" 后半段**：触发时机，直接贴群友的原话

### 3.2 三条硬性要求

1. **必须写"什么时候用"**。只写"能查天气"，模型在"今天热吗"这种问法上会犹豫不决或乱调。
2. **必须写"什么时候别用"的反面信息**（进 `instruction`）。比如"查不到就直说查不到，不要编"。
3. **贴真实问法**，不要写抽象描述。"北京现在多少度" 比 "查询气温" 有效得多。

### 3.3 `parameters` 的写法

标准 OpenAI function schema。每个 property 都要写 `description`——**模型是照它填参数的**：

```js
parameters: {
  type: 'object',
  properties: {
    city: { type: 'string', description: '城市名，如"北京"。不带时填默认值。' },
    days: { type: 'integer', description: '查几天，1~3，默认 1', enum: [1, 2, 3] }
  },
  required: ['city']
}
```

⚠️ **工具 id 只允许 `[a-zA-Z0-9_-]`**。用 `:` 或 `.` 会被严格端点（DeepSeek / OpenAI）
以 `400 invalid function name` **拒掉整个请求**——不是这个工具失败，是整轮对话失败。
最终 id 会变成 `<skillId>__<toolId>`，总长 ≤ 64。

---

## §4 提示词片段：告诉模型"什么时候用"

两条路，可以都用：

### 4.1 静态（清单里）

推荐写法（新形态）：

```jsonc
"prompt": {
  "sections": [
    { "id": "weather-rules", "title": "天气", "content": "…什么时候该调用…", "priority": 40 }
  ]
}
```

旧写法也支持（会被自动适配成一段，顺序为「何时使用 → 示例 → 说明」）：

```jsonc
"prompt": {
  "when": "当群友询问天气…时",
  "examples": ["今天天气怎么样", "明天会下雨吗"],
  "instruction": "调用 get_weather 工具…"
}
```

⚠️ 写了 `sections` 就以 `sections` 为准，`when`/`examples` 会被忽略。别两种混写。

### 4.2 动态（代码里）

```js
export function promptSections(ctx) {    // ⚠️ 必须是同步函数，不能是 async
  const c = api.config();
  if (!c.city) return [];
  return [{ id: 'weather-rules', title: '天气', content: `默认城市：${c.city}`, priority: 40 }];
}
```

同 `id` 时**动态覆盖静态**。⚠️ 写成 `async` 会返回 Promise，`for...of` 抛错被吞 → **片段静默消失**。

### 4.3 priority 与位置

- 范围 0~99，默认 50。**再大也压不过核心安全规则**（强制钳到 99，且一律渲染在核心规则之后）。
- 显式 `0` 是合法值（排最末），不会被当成 falsy。
- 排序：`priority` 降序 → 同优先级按 `id` 字典序（防字节漂移击穿前缀缓存）。

---

## §5 状态与配置

| 场景 | 用什么 |
|---|---|
| 读设置 | `api.config()` —— 已是 `manifest.settings` 被 `config.skills[id]` 覆盖后的结果 |
| 存状态 / 缓存 / 计数 | `api.storage.get/set/remove`（`plugin-data/<id>/storage.json`，**1MB 上限**） |
| 要不要联网 | 必须声明 `permissions: ["web_fetch"]`，否则 `api.fetch` 永远 reject |
| 要不要操作 QQ | 声明 `permissions: ["qq_sticker"]`，见 [onebot-capabilities.md](onebot-capabilities.md) |

⚠️ `api.storage` 是**同步、整文件读写**，别在高频路径里反复 `set`。
也别把大对象（比如图片 base64）塞进去——1MB 是硬上限，超了 `set` 直接抛错。

---

## §6 常见的坑

| 坑 | 症状 | 正确做法 |
|---|---|---|
| 工具 `description` 没写"什么时候用" | **模型基本不调用**（最常见的静默失效） | 贴真实问法，见 §3 |
| `permissions` 没声明或拼错 | `api.fetch` / `api.qqCall` 一直 reject，无其它线索 | 只有 `web_fetch` / `qq_sticker` 有效 |
| 工具 id 用了 `.` 或 `:` | 整轮对话 400 `invalid function name` | 只用 `[a-zA-Z0-9_-]` |
| `promptSections` 写成 `async` | 提示词片段**静默消失** | 同步函数 |
| `prompt` 写对象但既无 `sections` 也无 `instruction` | 提示词静默消失 | 用 `{sections:[...]}` |
| 清单里写了 `tools[]` 以为会注册工具 | 工具没出现，只有一条告警 | `tools[]` 只是元数据，必须 `api.registerTool()` |
| 工具"用着用着就不工作了" | 连续失败 5 次触发**熔断 5 分钟** | 看日志，别急着改代码 |
| `execute` 返回纯字符串以外的东西 | 模型收到空/怪内容 | 返回 `{content, isError?}` |
| 依赖别的技能但用了 `requires` | 那个技能没装 → 本技能整个不可用 | 能用 `api.capability()` 软依赖就别用硬依赖 |

---

## §7 自查清单

- [ ] 三个问题都答过，确认**主要用法**是"模型看着办"
- [ ] 目录在 `skills/`，`skill.json` 的 `id` 与目录名一致
- [ ] 每个工具都有完整 `description`，**含"适用："和 2~3 条真实问法**
- [ ] 每个 `parameters` 的 property 都有 `description`
- [ ] 工具 id 只用 `[a-zA-Z0-9_-]`
- [ ] `execute` 返回 `{content}`；出错返回 `{content, isError:true}`
- [ ] 需要联网 → 声明 `permissions: ["web_fetch"]`
- [ ] `prompt` 写了"sections"或"when/examples/instruction"，**没有两种混写**
- [ ] `promptSections` 不是 `async`
- [ ] `enabledByDefault` 自创扩展建议 `false`（装完由用户亲自开启，这是刻意的安全默认）
- [ ] 控制台「技能」页签里显示"生效中"，工具列表里能看到 `my_weather__get_weather`

---

## 相关文档

- [plugin-development.md](plugin-development.md) —— 确定性型（插件）开发规范
- [skill-reference.md](skill-reference.md) —— 完整 API 参考（**必读**）
- [skill-system.md](skill-system.md) —— 架构总览、加载流水线、安全边界
- [onebot-capabilities.md](onebot-capabilities.md) —— 操作 QQ 本身
- [panel-ui-contract.md](panel-ui-contract.md) —— 让技能在控制台里拥有自己的界面
