// 图片格式兼容：处理"模型不接受这种图片"的两种情况。
//
// ── 情况一：提前识别（避免把整轮打挂）─────────────────────────────────
// 部分本地/自建视觉接口（llama.cpp、vLLM 的某些版本）遇到 webp / avif 会直接 400。
// 一个 400 会让**整轮对话失败** —— 比"这轮看不到图"严重得多。
// 所以这里提供 `image.mime-support`：调用方在构造图片部分之前问一句，
// 不支持的格式就改成文字说明（"有 1 张 webp 图无法传给当前模型"），照常继续。
//
// 为什么不写死一张"哪些接口不支持"的表：
//   那种表必然滞后且不准（同一个 llama.cpp 不同版本行为都不同），猜错的代价是请求 400。
//   所以做成**格式白/黑名单 + 用户可配**：默认把 webp/avif 当作"可能不支持"，
//   真需要发的用户在设置里把这两个从名单里去掉即可。
//
// ── 情况二：事后降级（救回一整轮）─────────────────────────────────────
// 如果还是被拒了（比如 HTML 里嵌的 base64 编码不被接受），
// 识别出"这是图片导致的拒绝"，摘掉图片重发一次：
// 宁可这轮看不见图，也不要整轮报错什么都发不出去。
//
// ── 情况三：服务端回了一句「只支持文本」（2026-11-11 修）──────────────
// 真机日志 11-06/11-07 共 20 次**真实请求** 400：
//   "model only supports text input; image, video and audio is not supported"
// 旧正则只认 image_url / invalid image 这类**格式**措辞，一个字都匹配不上 →
// 顾问返回 null → 整轮对话直接失败，用户只看到英文 JSON、QQ 里什么都没发出去。
//
// ⚠️ 2026-11-11 结论更正：**别从这句错误反推「模型是纯文本模型」**。
//    用同一份真实配置实测：sensenova-6.8-flash-lite 是官方定义的原生多模态
//    智能体模型；合法 PNG(base64) 走 image_url 返回 HTTP 200，tool 消息里带图
//    （即日志那种 msgs=5 形态）也是 200。这句 400 当天已无法复现，更可能是
//    当时服务端策略，或请求里带了不被接受的部件 —— 实测 video_url 与公网 URL
//    形式的图片都会 400（inference request is invalid / image download failed）。
//
// 所以这里**只做兜底**：服务端既然明说这次不接受媒体，就摘掉重发一次救回整轮，
// 绝不拿它当模型能力结论，也不据此在设置页关掉看图。剥除范围含 video_url，
// 因为错误正文把 video 也列了，只摘图片会让重试再 400 一次。
//
// ── 边界 ──────────────────────────────────────────────────────────────
// 它只提供"判断"和"改写请求体"两个纯函数，**不自己发请求**（重试由 llm.js 执行），
// 这样超时预算、abort、计费口径都不变。

let cfg = () => ({});
let log = () => {};

/** 解析配置里的格式名单（逗号/空白分隔 → 规范化数组）。 */
export function unsupportedList(raw) {
  return String(raw ?? '')
    .split(/[,，;；\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

/** 某个 mime 是否属于"不要喂给模型"的格式。 */
export function isUnsupportedMime(mime, list = null) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (!m) return false;
  const set = list || unsupportedList(cfg().unsupportedMimes);
  return set.includes(m);
}

/**
 * 接口是因为"图片格式/编码"拒绝的这次请求吗？
 * 只在 400 / 415 / 422 上判定，且错误文本要真的提到图片相关字段 ——
 * 否则会把"模型名写错""Key 无效"这类无关错误也重试一遍，白白多花一次调用。
 */
// 图片"格式/编码"被拒：原有措辞。
const FORMAT_REJECTION = /base64 encoded image|image_url|invalid image|unsupported (image|media)|must be a base64/i;
// 模型"能力"不支持多模态：措辞与上面完全不同，且各家写法不一。
// 故意不用反斜杠类（\s 等），也不绑具体厂商；只认语义明确的说法，
// 避免把 "model not found" / "context length" 这类无关 400 也重试一遍。
const TEXT_ONLY_REJECTION =
  /only supports text|text[- ]only|仅支持文本|不支持(?:图片|图像|视频|音频|多模态)|(?:image|video|audio|vision|multimodal)[^.;]{0,60}(?:is|are)[ ]not[ ]supported|(?:does not|doesn't|cannot|can't|do not)[ ]support[^.;]{0,40}(?:image|video|audio|vision|multimodal)/i;

export function isImageRejection(status, text) {
  if (![400, 415, 422].includes(Number(status))) return false;
  const s = String(text || '');
  return FORMAT_REJECTION.test(s) || TEXT_ONLY_REJECTION.test(s);
}

/**
 * 把所有图片部分换成一句文字说明，返回新 messages；没有图片则返回 null。
 *
 * 返回 null 而不是原数组，是为了让调用方清楚区分"没改动"和"改动后恰好相同"——
 * 调用方据此决定要不要真的重试（返回 null 就别重试了）。
 */
export function stripImageParts(messages) {
  let touched = false;
  const out = (messages || []).map((m) => {
    if (!Array.isArray(m?.content)) return m;
    const kept = [];
    let images = 0;
    let videos = 0;
    for (const part of m.content) {
      // 错误正文明确写了 image/video/audio 都不支持：只摘 image_url 的话，
      // 剩下的 video_url 会让重试**再 400 一次**，白花一次调用。
      if (part?.type === 'image_url') { images += 1; continue; }
      if (part?.type === 'video_url') { videos += 1; continue; }
      kept.push(part);
    }
    if (!images && !videos) return m;
    touched = true;
    const bits = [];
    if (images) bits.push(`${images} 张图片`);
    if (videos) bits.push(`${videos} 段视频`);
    // 说明里明确要求"别假装看过图"：否则模型容易照着配文编一段画面出来。
    kept.push({
      type: 'text',
      text: `[此处有 ${bits.join('、')}，当前模型不接受图片/视频输入，已省略。请按文字内容回应，不要假装看过图]`
    });
    return { ...m, content: kept };
  });
  return touched ? out : null;
}

/** 请求体里有没有多模态部分（用于判断值不值得降级重试）。 */
export function hasMediaParts(messages) {
  for (const m of (messages || [])) {
    if (!Array.isArray(m?.content)) continue;
    if (m.content.some((p) => p?.type === 'image_url' || p?.type === 'video_url')) return true;
  }
  return false;
}

/** 历史导出名，保留兼容；现在也认 video_url。 */
export function hasImageParts(messages) { return hasMediaParts(messages); }

// ── Skill 生命周期 ────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;
}

export const providers = {
  /** 调用方在构造图片部分之前问：这个格式能发吗？ */
  'image.mime-support': ({ mime } = {}) => {
    const unsupported = isUnsupportedMime(mime);
    return { supported: !unsupported, unsupported, mime: String(mime || '').toLowerCase() };
  },

  /**
   * 被拒时给出降级建议。
   * 返回 { body, reason } 让核心去重试；返回 null 表示"这个错误不该由我处理"。
   *
   * GIF 降级（2026-09-19，用户定稿规则 2）："图片输入开、视频输入没开"时 GIF 按
   * 原样发，模型读不了会报错 —— 此时取**首帧**（静态 PNG）替换后重试，
   * 而不是整张摘掉：首帧至少保住"看得见图"，比完全省略强。
   * 首帧提取在代码里完成（gifFirstFrameDataUrl），不依赖模型自己重试。
   */
  'llm.retry-advisor': async ({ body, errorText, status } = {}) => {
    if (cfg().stripOnReject === false) return null;
    if (!isImageRejection(status, errorText)) return null;
    if (!hasMediaParts(body?.messages)) return null;   // 没有图片/视频就别瞎重试
    // 第一优先：GIF 换首帧（只换 GIF 图，普通图不动）
    const firstFrame = await replaceGifWithFirstFrame(body.messages);
    if (firstFrame) {
      log('接口拒绝图片输入：GIF 已换成首帧静态图，重试一次');
      return {
        body: { ...body, messages: firstFrame },
        reason: '接口不接受 GIF 动图，已换成首帧静态图重试（画面只取第一帧）'
      };
    }
    // 第二优先：没有 GIF（或首帧提取失败）→ 摘掉全部图片
    const next = stripImageParts(body.messages);
    if (!next) return null;
    log('接口拒绝了图片部分，摘掉后重试一次');
    return {
      body: { ...body, messages: next },
      reason: '接口不接受图片输入，已摘掉图片重试（这轮看不见图，但文字部分照常处理）'
    };
  }
};

/**
 * 把 messages 里 GIF 形态的 image_url 换成首帧静态图。
 * data URL 的 MIME 是 image/gif 才替换；http(s) URL 的 GIF 判不了字节（内容
 * 已在核心侧下载过，这里拿不到）—— 这类留给"摘掉图片"的兜底分支。
 * 返回新的 messages 数组（没有任何 GIF 时返回 null）。
 */
async function replaceGifWithFirstFrame(messages) {
  let gifFirstFrameDataUrl;
  try {
    ({ gifFirstFrameDataUrl } = await import('../../src/gif-to-video.js'));
  } catch {
    return null;   // 模块不可加载（理论上不会）→ 走摘图兜底
  }
  if (typeof gifFirstFrameDataUrl !== 'function') return null;
  let touched = false;
  const out = [];
  for (const m of (messages || [])) {
    if (!Array.isArray(m?.content)) { out.push(m); continue; }
    let gifCount = 0;
    const parts = [];
    for (const part of m.content) {
      const url = String(part?.image_url?.url || '');
      const isGif = /^data:image\/gif;base64,/i.test(url);
      if (isGif) {
        gifCount += 1;
        const frame = await gifFirstFrameDataUrl(Buffer.from(url.split(',')[1] || '', 'base64'));
        if (frame) {
          parts.push({ type: 'image_url', image_url: { url: frame } });
        } else {
          // 首帧提取失败：留占位说明，别发原始 GIF（发了还会再报错）
          parts.push({ type: 'text', text: '（1 张 GIF 动图无法传给当前模型，首帧提取失败，已省略）' });
        }
      } else {
        parts.push(part);
      }
    }
    if (gifCount) {
      touched = true;
      out.push({ ...m, content: parts });
    } else {
      out.push(m);
    }
  }
  return touched ? out : null;
}

export function available() { return { ok: true }; }

export const internals = {
  isUnsupportedMime, isImageRejection, stripImageParts, hasImageParts, hasMediaParts, unsupportedList
};
