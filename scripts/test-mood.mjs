// 心情系统的回归：他的「我讨厌你」是逗人，不是骂人。
//
// 2026-10-27 晚上的真实事故：他连发「我讨厌你/超级讨厌/无敌讨厌/特别讨厌/非常讨厌」，
// 每条都命中 /讨厌/ → 每条 -4 → 心情被打到 0/100（低落），而低落档的提示词是
// 「话少、不想解释、别求安慰」—— 于是她真的冷淡了一整晚，他还来问“怎么这么冷淡”。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-mood-test-'));
process.env.BILI_MOOD_FILE = path.join(tmp, 'mood.json');
const mood = await import(`../src/mood.js?t=${Date.now()}`);

let failed = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  ✅ ${label}`); }
  catch (error) { console.log(`  ❌ ${label}：${error?.message ?? error}`); failed += 1; }
};
const write = (score, reason, at) => fs.writeFileSync(process.env.BILI_MOOD_FILE, JSON.stringify({ score, reason, updatedAt: at }));
const now = Date.now();

console.log('心情：\n');

check('「我讨厌你」是逗人，不再当被骂', () => {
  assertOk(mood.moodDeltaFromText('我讨厌你').delta > 0, '不该扣分');
  assertOk(mood.moodDeltaFromText('超级讨厌').delta >= 0, '连续版也不该扣分');
  assertOk(mood.moodDeltaFromText('滚').delta < 0, '真骂人才扣分');
});

check('连着五句「我讨厌你」不会把心情打到地板', () => {
  write(62, '', now);
  for (let i = 0; i < 5; i += 1) mood.nudgeMood(-4, '被怼', now + i * 3000);
  const cur = mood.currentMood(now + 30000);
  assertOk(cur.score >= 50, `五连击后还有 ${cur.score}/100`);
});

check('心情会自己缓过来：3 小时后从 0 回到一半以上', () => {
  write(0, '被怼', now - 3 * 3600000);
  const cur = mood.currentMood(now);
  assertOk(cur.score >= 40, `3 小时后只有 ${cur.score}/100`);
});

check('理由会过期，不会挂一整晚', () => {
  write(20, '连发太多有点累', now - 2 * 3600000);
  const line = mood.moodPromptLine(now);
  assertOk(!line.includes('连发太多'), `旧理由还在：${line}`);
});

check('低落档不再教她「别求安慰/把人推开」', () => {
  write(3, '', now);
  const line = mood.moodPromptLine(now);
  assertOk(!line.includes('别求安慰'), line);
  assertOk(line.includes('缓过来') || line.includes('哄'), '要给她一个能软下来的出口');
});

function assertOk(ok, message) { if (!ok) throw new Error(message); }

fs.rmSync(tmp, { recursive: true, force: true });
const bad = failed > 0;
console.log(bad ? `\n❌ ${failed} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
