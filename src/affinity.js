// 好感度（affinity）—— 二代仿真的私有扩展：把「关系温度」做成持久化状态。
//
// 为什么单独一份状态：
//   人格卡（roles/*.md）是静态文本，写不进「今天聊得多、她更亲近了」这种随时间变化的东西；
//   而模型的记忆工具擅长记话题，不适合记一个必须稳定、可比较、可展示的数值。
//   所以这里用一份独立 JSON：桥接在每次收到管理员私聊消息时推进它，再把当前值注入提示词，
//   人格卡只负责规定「每个等级该怎么表现」。
//
// 值的来源（刻意保持可解释，不猜情绪）：
//   +1  每收到一条管理员私聊（每天有上限，防刷）
//   +1  新的一天第一次开聊（不是机器人自己的功劳，但是"记挂"的理由）
//   -N  连续多天没出现（每天 -1，最多扣 5）—— 关系会变淡，回来聊几次能补回去
//   0~100，默认从 30 起步（"认识一段时间的朋友"该在的位置）。
//
// 说明：这是桥接侧的单向状态，不暴露给群友、也不能被模型直接改。人格卡里明确写了
// 「不要主动报数字，被问再给个大概」，避免聊天变成报分数。
import fs from 'node:fs';
import path from 'node:path';

export const AFFINITY_MIN = 0;
export const AFFINITY_MAX = 100;
export const AFFINITY_START = 42;

// 每天的上涨上限：防止「一口气发 200 条」把好感度刷满。
const DAILY_GAIN_CAP = 8;
const NEW_DAY_BONUS = 1;
const NEW_DAY_GAP_MS = 8 * 60 * 60 * 1000;
const DECAY_START_DAYS = 3;
const DECAY_MAX = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

export const AFFINITY_LEVELS = [
  { min: 0, name: '陌生', hint: '礼貌、简短，不主动展开话题，也不主动关心。' },
  { min: 20, name: '眼熟', hint: '能正常聊，回答简短；不主动示好，被搭话才接。' },
  { min: 40, name: '朋友', hint: '放松、会吐槽，偶尔主动分享自己的事，关心藏在细节里。' },
  { min: 60, name: '熟人', hint: '话变多，会主动找人，毒舌里明显带关心，愿意讲自己的情绪。' },
  { min: 75, name: '有点在意', hint: '会别扭地关心，久了没消息会问一句，偶尔吃味；开始有一点点暧昧的试探。' },
  { min: 90, name: '离不开', hint: '明显黏人，主动找话题、报备日常，会直白地说想你；嘴上依旧会别扭一下。' }
];

export function levelOf(score) {
  const value = clamp(score);
  let current = AFFINITY_LEVELS[0];
  for (const level of AFFINITY_LEVELS) if (value >= level.min) current = level;
  return current;
}

/** 等级下标（0~5），给控制台状态栏配色用。 */
export function levelIndexOf(score) {
  const value = clamp(score);
  let index = 0;
  AFFINITY_LEVELS.forEach((level, i) => {
    if (value >= level.min) index = i;
  });
  return index;
}

/** 十格文本状态栏：██████░░░░ —— 只在被明确要求时由角色发出。 */
export function affinityBarText(score) {
  const filled = Math.max(0, Math.min(10, Math.round(clamp(score) / 10)));
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

function clamp(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return AFFINITY_START;
  return Math.max(AFFINITY_MIN, Math.min(AFFINITY_MAX, Math.round(num)));
}

function dayKey(now) {
  const d = new Date(now);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function readStore(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.conversations && typeof parsed.conversations === 'object') {
      return parsed;
    }
  } catch {
    // 文件不存在/损坏都按空库处理：好感度丢一次可以接受，聊天不能因此报错。
  }
  return { version: 1, conversations: {} };
}

function writeStore(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function normalizeRecord(raw) {
  const rec = raw && typeof raw === 'object' ? raw : {};
  return {
    score: clamp(rec.score),
    day: typeof rec.day === 'string' ? rec.day : '',
    gainedToday: Math.max(0, Number(rec.gainedToday) || 0),
    totalMessages: Math.max(0, Number(rec.totalMessages) || 0),
    firstAt: Number(rec.firstAt) || 0,
    lastAt: Number(rec.lastAt) || 0,
    lastDelta: Number(rec.lastDelta) || 0,
    lastReason: typeof rec.lastReason === 'string' ? rec.lastReason : ''
  };
}

/** 读取某个会话的好感度（不推进）。没有记录时返回初始值，不落盘。 */
export function readAffinity(file, key) {
  const store = readStore(file);
  const rec = normalizeRecord(store.conversations?.[key]);
  const level = levelOf(rec.score);
  return {
    key,
    score: rec.score,
    level: level.name,
    levelIndex: levelIndexOf(rec.score),
    bar: affinityBarText(rec.score),
    hint: level.hint,
    day: rec.day,
    gainedToday: rec.gainedToday,
    totalMessages: rec.totalMessages,
    firstAt: rec.firstAt,
    lastAt: rec.lastAt,
    lastDelta: rec.lastDelta,
    lastReason: rec.lastReason
  };
}

/**
 * 收到一条（非自己的）消息时推进好感度。
 * @returns {{score:number, delta:number, reason:string, level:string}}
 */
export function tickAffinity(file, key, { now = Date.now(), weight = 1 } = {}) {
  const store = readStore(file);
  const rec = normalizeRecord(store.conversations?.[key]);
  if (!rec.firstAt) rec.firstAt = now;

  let delta = 0;
  const reasons = [];

  // 关系变淡：几天没出现，每天掉 1 点（最多 5 点），只结算一次。
  if (rec.lastAt) {
    const gapDays = Math.floor((now - rec.lastAt) / DAY_MS);
    if (gapDays >= DECAY_START_DAYS) {
      const decay = Math.min(DECAY_MAX, gapDays - (DECAY_START_DAYS - 1));
      if (decay > 0) {
        delta -= decay;
        reasons.push(`久没联系 -${decay}`);
      }
    }
  }

  const today = dayKey(now);
  if (rec.day !== today) {
    rec.day = today;
    rec.gainedToday = 0;
    // 隔了大半天再出现，算「惦记」的一次小加分。
    if (rec.lastAt && now - rec.lastAt >= NEW_DAY_GAP_MS) {
      delta += NEW_DAY_BONUS;
      reasons.push(`隔了一阵回来 +${NEW_DAY_BONUS}`);
    }
  }

  if (rec.gainedToday < DAILY_GAIN_CAP) {
    const gain = Math.max(1, Math.min(2, Math.round(weight || 1)));
    delta += gain;
    rec.gainedToday += gain;
    if (!reasons.length) reasons.push(`聊天 +${gain}`);
  }

  rec.score = clamp(rec.score + delta);
  rec.lastAt = now;
  rec.totalMessages += 1;
  rec.lastDelta = delta;
  rec.lastReason = reasons.join('、') || '聊天';

  store.conversations = store.conversations || {};
  store.conversations[key] = rec;
  writeStore(file, store);

  return { key, score: rec.score, delta, reason: rec.lastReason, level: levelOf(rec.score).name };
}

function describeAgo(ts, now) {
  if (!ts) return '';
  const minutes = Math.max(0, Math.round((now - ts) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  return `${days} 天前`;
}

/**
 * 注入提示词的那一段。
 * 设计原则：只给"状态 + 该怎么表现"，不写死台词，避免每条消息都变成报分数。
 */
export function affinityPromptSection(file, key, { now = Date.now() } = {}) {
  const info = readAffinity(file, key);
  const ago = describeAgo(info.lastAt, now);
  const bits = [`${info.score}/100（${info.level}）`];
  if (info.gainedToday > 0) bits.push(`今天 +${info.gainedToday}`);
  if (ago) bits.push(`上次聊 ${ago}`);
  const lines = [
    `【好感度】她对你的好感度：${bits.join(' · ')}。`,
    `当前该有的温度：${info.hint}`,
    '（这是系统给的状态，不用主动报数字，也别把聊天变成报分数；被直接问「好感度多少」时可以别扭一下，再给个大概。数值高低就按上面的温度自然表现，不要刻意说出来。）'
  ];
  return `${lines.join('\n')}\n\n`;
}
