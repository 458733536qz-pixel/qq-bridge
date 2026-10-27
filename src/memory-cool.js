// 冷热记忆（按 Companion-AI-Memory-Context-Token-Optimization 的思路做的最小实现）
//
// 思路：全部原话留底（冷库），只有「最近的」和「本轮线索命中的」才进上下文（热区）。
//   · 冷库：~/.bili-ai/archive/YYYY-MM-DD.jsonl，一行一条 {t, key, self, text}
//   · 召回：从用户这句话里抠线索（人名/地名/物品/时间/专有词），去冷库找最像的几条
//   · 热区：召回结果 ≤3 条 / ≤480 字，注入唤醒提示；找不到就什么都不加
//
// 只做"用户主动提起"的召回：定时唤醒、工具输出不触发（由调用方保证）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ARCHIVE_DIR = path.join(os.homedir(), '.bili-ai', 'archive');

const CJK = /[\u4e00-\u9fa5]/;
const STOP = new Set('的 了 是 在 我 你 他 她 它 们 这 那 有 没 不 就 也 都 和 跟 吗 呢 吧 啊 呀 哦 嗯 好 对 说 要 想 会 能 一个 什么 怎么 为什么 可以 我们 你们 他们'.split(' '));

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* ignore */ }
}

/** 归档一条消息（全量留底） */
export function archiveMessage({ key, self, text, time }) {
  const t = typeof time === 'number' ? time : Date.now();
  const body = String(text ?? '').trim();
  if (!body) return;
  // 桥接自己拼的唤醒提示不是"对话"，归档进去会污染召回（以前的教训）
  if (/^【当前时间】|^【会话令牌】|【反AI味】|【分条】/.test(body)) return;
  if (body.length > 1200) return;
  ensureDir(ARCHIVE_DIR);
  const d = new Date(t);
  const file = path.join(ARCHIVE_DIR, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`);
  try {
    fs.appendFileSync(file, JSON.stringify({ t, key, self: !!self, text: body.slice(0, 2000) }) + '\n');
  } catch { /* 归档失败不影响聊天 */ }
}

/** 从一句话里抠线索词：英文/数字词、2 字以上的中文片段 */
export function extractCues(text) {
  const s = String(text || '');
  const cues = new Set();
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_\-]{1,20}|[0-9]{2,4}/g)) {
    const w = m[0].toLowerCase();
    if (!STOP.has(w)) cues.add(w);
  }
  const chunks = s.match(/[\u4e00-\u9fa5]{2,8}/g) || [];
  for (const c of chunks) {
    if (STOP.has(c)) continue;
    cues.add(c);
    if (c.length >= 4) {
      for (let i = 0; i + 2 <= c.length; i += 2) {
        const g = c.slice(i, i + 2);
        if (!STOP.has(g)) cues.add(g);
      }
    }
  }
  return [...cues].slice(0, 12);
}

function recentFiles(daysBack = 30) {
  const out = [];
  for (let i = 0; i < daysBack; i++) {
    const d = new Date(Date.now() - i * 86400000);
    const f = path.join(ARCHIVE_DIR, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.jsonl`);
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

/**
 * 按线索召回：返回 { text, hits }。
 * text 为空表示没命中（调用方不要注入空段落）。
 */
export function recallByCue(cueText, { limit = 3, maxChars = 480, minScore = 2, skipToday = false } = {}) {
  const cues = extractCues(cueText);
  if (!cues.length) return { text: '', hits: 0, cues: [] };
  const today = new Date();
  const todayFile = path.join(ARCHIVE_DIR, `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.jsonl`);
  const files = recentFiles(30).filter((f) => !(skipToday && f === todayFile));
  if (!files.length) return { text: '', hits: 0, cues };
  // 粗 TF-IDF：只在很少的对话里出现过的词，才算「线索」（这样"之前""那个"这类口水词不会乱召回）
  const all = [];
  for (const f of files) {
    let lines = [];
    try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { continue; }
    for (const line of lines) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const t = String(o.text || '');
      if (t) all.push({ t, time: o.t, self: !!o.self });
    }
  }
  if (!all.length) return { text: '', hits: 0, cues };
  const df = new Map();
  for (const c of cues) {
    let n = 0;
    for (const it of all) if (it.t.includes(c)) n++;
    df.set(c, n);
  }
  const total = all.length;
  const weightOf = (c) => {
    const n = df.get(c) || 0;
    if (n === 0) return 0;
    if (n > total * 0.35) return 0; // 太常见，不算线索
    return 1 + Math.log(total / n);
  };
  const scored = [];
  for (const it of all) {
    let score = 0;
    let strong = false;
    for (const c of cues) {
      if (!it.t.includes(c)) continue;
      const w = weightOf(c);
      if (!w) continue;
      score += w;
      if (c.length >= 2 && w >= 2) strong = true;
    }
    if (score >= minScore && strong) scored.push({ score, t: it.t, time: it.time, self: it.self });
  }
  if (!scored.length) return { text: '', hits: 0, cues };
  scored.sort((a, b) => b.score - a.score || (b.time || 0) - (a.time || 0));
  const picked = [];
  let chars = 0;
  const seen = new Set();
  for (const s of scored) {
    if (picked.length >= limit) break;
    const snip = s.t.slice(0, 140);
    const norm = snip.slice(0, 40);
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (picked.length && chars + snip.length > maxChars) break;
    picked.push({ ...s, snip });
    chars += snip.length;
  }
  if (!picked.length) return { text: '', hits: 0, cues };
  const lines = picked.map((s) => {
    const d = new Date(s.time || Date.now());
    const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `- ${stamp} ${s.self ? '我' : '他'}：${s.snip}`;
  });
  return { text: lines.join('\n'), hits: picked.length, cues };
}

/** 冷库统计（给控制台/自检用） */
export function archiveStats() {
  const files = recentFiles(60);
  let lines = 0;
  for (const f of files) {
    try { lines += fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length; } catch { /* ignore */ }
  }
  return { files: files.length, messages: lines, dir: ARCHIVE_DIR };
}
