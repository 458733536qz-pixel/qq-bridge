// 她的心情 —— 和「好感度」分开：好感度是长期关系，心情是这几个小时的状态。
// 存在 ~/.bili-ai/mood.json，和记忆/相册放在一起（换机器拷一个目录就带走）。
//
// 设计原则（按"像个人"来）：
//   · 有基线：默认 62（不亢不丧）
//   · 会受时间影响：凌晨会困，下午偏低，晚上偏高
//   · 会受聊天影响：被夸会好一点，被怼会差一点，连发太多会有点累
//   · 会自己回落：几小时没聊，慢慢回到基线（不是一直停在最高/最低）
//   · 只影响语气的一个侧面，不覆盖人设
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MOOD_FILE = path.join(os.homedir(), '.bili-ai', 'mood.json');
const BASELINE = 62;
const MIN = 0;
const MAX = 100;

const clamp = (n) => Math.max(MIN, Math.min(MAX, Math.round(n)));

const LABELS = [
  { min: 0, label: '低落', hint: '话少、不想解释、容易被戳到，但别演，也别求安慰' },
  { min: 25, label: '有点闷', hint: '句子更短，懒得接梗，被问就说"没事"' },
  { min: 45, label: '平常', hint: '正常说话，不特别热也不特别冷' },
  { min: 65, label: '还行', hint: '愿意多聊两句，会接梗，会主动问一句' },
  { min: 82, label: '心情不错', hint: '话多一点，会分享、会逗人、会主动找他' }
];

export function labelOf(score) {
  let current = LABELS[0];
  for (const l of LABELS) if (score >= l.min) current = l;
  return current;
}

// 时段基线：凌晨困、下午低谷、晚上回升
function timeBias(now = new Date()) {
  const h = now.getHours();
  if (h >= 0 && h < 6) return -14;
  if (h >= 6 && h < 9) return -4;
  if (h >= 9 && h < 12) return 2;
  if (h >= 12 && h < 15) return -3;
  if (h >= 15 && h < 19) return 0;
  if (h >= 19 && h < 24) return 6;
  return 0;
}

function readStore() {
  try {
    const d = JSON.parse(fs.readFileSync(MOOD_FILE, 'utf8'));
    if (d && typeof d.score === 'number') return d;
  } catch { /* 没有就新建 */ }
  return { score: BASELINE, reason: '刚睡醒', updatedAt: Date.now() };
}

function save(store) {
  try {
    fs.mkdirSync(path.dirname(MOOD_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(MOOD_FILE, JSON.stringify(store, null, 2));
  } catch { /* 写不进去不影响聊天 */ }
}

/** 当前心情（会按时间自然回落） */
export function currentMood(now = Date.now()) {
  const store = readStore();
  const hours = Math.max(0, (now - (store.updatedAt || now)) / 3600000);
  // 每 3 小时向「基线 + 时段偏差」回落一半
  const target = BASELINE + timeBias(new Date(now));
  const decayed = store.score + (target - store.score) * Math.min(1, hours / 3) * 0.5;
  const score = clamp(decayed);
  return { score, ...labelOf(score), reason: store.reason || '' };
}

/** 聊了几句之后，心情被推一下 */
export function nudgeMood(delta, reason, now = Date.now()) {
  const cur = currentMood(now);
  const score = clamp(cur.score + delta);
  save({ score, reason, updatedAt: now });
  return { score, ...labelOf(score), reason };
}

/** 从一句话里读味道：正向 / 负向 / 连发太密 */
export function moodDeltaFromText(text, { streak = 0 } = {}) {
  const s = String(text || '');
  let delta = 0;
  const reasons = [];
  if (/(喜欢你|想你|可爱|好看|乖|抱抱|辛苦了|开心)/.test(s)) { delta += 3; reasons.push('被夸'); }
  if (/(滚|烦|闭嘴|别烦|讨厌|傻|丑|无聊)/.test(s)) { delta -= 4; reasons.push('被怼'); }
  if (/(晚安|睡了|不聊了|去忙|先这样)/.test(s)) { delta += 1; reasons.push('好好收尾'); }
  if (/(对不起|抱歉|我错了)/.test(s)) { delta += 2; reasons.push('他道歉了'); }
  if (streak >= 5) { delta -= 2; reasons.push('连发太多有点累'); }
  if (!delta) return null;
  return { delta, reason: reasons.join('、') };
}

/** 注入提示词的一行（很便宜，别写长） */
export function moodPromptLine(now = Date.now()) {
  const m = currentMood(now);
  return `【此刻的心情】${m.score}/100（${m.label}）${m.reason ? `· ${m.reason}` : ''}。表现：${m.hint}。心情只影响语气，不改变你是谁；不用报分数。\n\n`;
}
