// 人格卡（roles/<名称>.md）的解析与「按仿真模式取用」。
//
// 为什么要分模式：
//   一代仿真（reserved）用空格分条、用 [SILENT] 表示沉默；
//   二代仿真（reserved2）必须用工具发言（qq_send_message 的数组分条），没有 [SILENT]。
//   同一张人格卡被两种模式共用时，一代专属指令会与二代工具协议冲突。
// 以前靠 currentRoleHintV2() 对正文做「逐行猜测 + 正则过滤」，既容易误伤又说不清边界。
//
// 现在改为显式标记：在标题里写模式，桥接只取当前模式适用的小节。
//   ## 表情包体系 〔二代〕      → 只在 reserved2 注入
//   ## 分条方式 〔一代〕        → 只在 reserved/chat 注入
//   ## 你是谁                   → 两种模式都注入
// 标记会在注入前从标题里去掉，模型看到的始终是干净的小节标题。
export const ROLE_INJECT_MODES = ['v1', 'v2'];

// 模式标记：`〔二代〕` / `[v2]` / `（reserved2）` 等写法都认。
const MODE_TAGS = [
  { mode: 'v2', re: /[\[〔（(]\s*(?:二代|2\s*代|v2|reserved2)\s*[\]〕）)]/gi },
  { mode: 'v1', re: /[\[〔（(]\s*(?:一代|1\s*代|v1|reserved)\s*[\]〕）)]/gi },
];

function detectMode(heading) {
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    if (tag.re.test(heading)) return tag.mode;
  }
  return 'all';
}

function stripModeTags(heading) {
  let out = String(heading);
  for (const tag of MODE_TAGS) {
    tag.re.lastIndex = 0;
    out = out.replace(tag.re, '');
  }
  return out.replace(/[ \t]+$/, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * 按标题把人格卡拆成小节。
 * @returns {{mode: 'all'|'v1'|'v2', heading: string|null, lines: string[]}[]}
 */
export function parseRoleSections(text) {
  const sections = [];
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!heading) {
      if (!current) {
        current = { mode: 'all', heading: null, lines: [] };
        sections.push(current);
      }
      current.lines.push(line);
      continue;
    }
    const title = stripModeTags(heading[2]);
    current = { mode: detectMode(heading[2]), heading: title, lines: [`${heading[1]} ${title}`] };
    sections.push(current);
  }
  return sections;
}

/**
 * 取出某次仿真真正要注入的人格文本（已去掉模式标记）。
 * @param {'v1'|'v2'} mode
 */
export function selectRoleText(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text)
    .filter((section) => section.mode === 'all' || section.mode === want)
    .map((section) => section.lines.join('\n'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 报告每个小节在当前模式下是否会被注入，供控制台预览。
 * @param {'v1'|'v2'} mode
 */
export function roleSectionReport(text, mode) {
  const want = mode === 'v1' ? 'v1' : 'v2';
  return parseRoleSections(text).map((section) => ({
    heading: section.heading ?? '(开头部分)',
    mode: section.mode,
    injected: section.mode === 'all' || section.mode === want,
    chars: section.lines.join('\n').trim().length,
  }));
}

/** 统计各模式的字符数，用于控制台提示「去掉另一模式的专属小节后还剩多少」。 */
export function roleCharStats(text) {
  const source = String(text ?? '');
  const sections = parseRoleSections(source);
  const sum = (list) => list.reduce((total, section) => total + section.lines.join('\n').trim().length, 0);
  return {
    total: source.length,
    common: sum(sections.filter((section) => section.mode === 'all')),
    v1Only: sum(sections.filter((section) => section.mode === 'v1')),
    v2Only: sum(sections.filter((section) => section.mode === 'v2')),
    v1: selectRoleText(source, 'v1').length,
    v2: selectRoleText(source, 'v2').length,
  };
}

// 一代仿真遗留指令：未加模式标记时，这些行在二代下会被兜底过滤。
// 正确做法是给所在小节加上 〔一代〕 标记。
export const GEN1_ROLE_LINE_RE = /\[SILENT\]|空格分隔|按空格|用空格|空格分句|空格代表|自动转发|回复会自动|输出\s*\[SILENT\]/i;

// ── 按需召回小节（「核心约束 + 按需召回」的召回那一半）────────────────────
// 背景：完整人格卡约 7.5k 字，每轮全量注入 ≈ 4.7k token，而每一轮真正必需的只有
// 「核心约束」（roles/<名称>.core.md）。细节（外形、性格层次、生气详解、好感度、
// 小秘书、生活、示例）拆到 roles/<名称>.recall.md，按他这句话里的关键词带一段出来。
//
// 召回文件的写法（触发词用 | 分隔，标题里可以带空格）：
//   ## 〔触发: 照片|长相|自拍〕 外形与样子
//   - 冷白皮，脸很小……
//
// 没有触发标记的 `##` 小节不参与召回（留在文件里当人类可读的分隔即可）。
const RECALL_HEADING_RE = /^##\s*[〔（(]\s*(?:触发|触发词|recall)\s*[:：]?\s*([^〕）)]+)[〕）)]\s*(.*)$/i;
const RECALL_TRIGGER_SPLIT_RE = /[|｜,，、;；]/;

/**
 * 把召回文件拆成小节。
 * @returns {{title: string, triggers: string[], body: string}[]}
 */
export function parseRecallSections(text) {
  const sections = [];
  let current = null;
  for (const line of String(text ?? '').split('\n')) {
    const matched = RECALL_HEADING_RE.exec(line);
    if (matched) {
      current = {
        title: matched[2].trim(),
        triggers: matched[1].split(RECALL_TRIGGER_SPLIT_RE).map((s) => s.trim()).filter(Boolean),
        lines: [],
      };
      sections.push(current);
      continue;
    }
    // 普通标题（含一级标题/别的二级标题）结束当前召回小节
    if (/^#{1,6}\s/.test(line)) {
      current = null;
      continue;
    }
    if (current) current.lines.push(line);
  }
  return sections
    .map((section) => ({
      title: section.title,
      triggers: section.triggers,
      body: section.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    }))
    .filter((section) => section.body);
}

/**
 * 按他这句话里的关键词挑召回小节。更长的触发词优先（更具体）。
 *
 * 返回的 text 直接可以拼进提示词；被截断时末尾会留一句「用 section= 看全」的提示，
 * 这比悄悄截掉一半更诚实——模型至少知道自己没看全。
 *
 * @param {string} text 召回文件全文
 * @param {string} message 他刚说的那句话
 * @param {{limit?: number, maxChars?: number, minTrigger?: number}} [opts]
 * @returns {{text: string, picked: string[]}}
 */
export function pickRecallSections(text, message, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? Math.max(1, opts.limit) : 1;
  const maxChars = Number.isFinite(opts.maxChars) ? Math.max(200, opts.maxChars) : 900;
  const minTrigger = Number.isFinite(opts.minTrigger) ? Math.max(1, opts.minTrigger) : 2;
  const message_ = String(message ?? '');
  if (!message_.trim()) return { text: '', picked: [] };

  const hits = [];
  for (const section of parseRecallSections(text)) {
    let score = 0;
    for (const trigger of section.triggers) {
      if (trigger.length >= minTrigger && message_.includes(trigger)) {
        score = Math.max(score, trigger.length);
      }
    }
    if (score > 0) hits.push({ section, score });
  }
  hits.sort((a, b) => b.score - a.score);

  const parts = [];
  const picked = [];
  let used = 0;
  for (const { section } of hits) {
    if (picked.length >= limit) break;
    const room = maxChars - used;
    if (room < 200) continue; // 剩的空间连一段都不够，别硬塞半句
    if (section.body.length <= room) {
      parts.push(`## ${section.title}\n${section.body}`);
      used += section.body.length;
    } else {
      parts.push(`## ${section.title}\n${section.body.slice(0, room)}…（后面还有，需要看全就用 qq_get_prompt 带 section="${section.title}"）`);
      used += room;
    }
    picked.push(section.title);
  }
  return { text: parts.join('\n\n'), picked };
}

/**
 * 召回小节的目录：只给标题 + 触发词，供 qq_get_prompt 列出「还能查什么」。
 * 故意不含正文，这样它每次醒来的成本是几十个 token 而不是整卡。
 */
export function recallSectionIndex(text) {
  return parseRecallSections(text).map((section) => ({
    title: section.title,
    triggers: section.triggers.slice(0, 4), // 只给 4 个示例词：目录是「有什么」，不是「怎么匹配」
    chars: section.body.length,
  }));
}

/**
 * 按名字取一节召回内容（`qq_get_prompt section="…"` 用）。
 * 先精确匹配标题，再退到「标题包含他写的词」或「触发词精确命中」，都没有返回 null。
 */
export function findRecallSection(text, name) {
  const want = String(name ?? '').trim();
  if (!want) return null;
  const sections = parseRecallSections(text);
  return sections.find((section) => section.title === want)
    ?? sections.find((section) => section.title.includes(want) || want.includes(section.title))
    ?? sections.find((section) => section.triggers.includes(want))
    ?? null;
}
