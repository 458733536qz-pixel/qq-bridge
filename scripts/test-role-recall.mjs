// 「核心约束 + 按需召回」的桥接侧回归：核心卡常驻、细节按需、编号可收尾。
//
// 为什么要有这份测试：这三条都只在**提示词层面**生效，不会抛错也不会让功能不可用，
// 一旦悄悄退化（召回不触发 / 整卡又回来了 / 【待跟进】丢了编号），
// 表现只有「她变得不像她」和「成本悄悄涨回去」，没有报错可看。
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const core = read('../roles/鱼小冷.core.md');
const recall = read('../roles/鱼小冷.recall.md');
const full = read('../roles/鱼小冷.md');

const bridge = await bridgeHarness({
  files: {
    'roles/鱼小冷.md': full,
    'roles/鱼小冷.core.md': core,
    'roles/鱼小冷.recall.md': recall,
    'state/current-role.json': { role: '鱼小冷', mode: 'active' },
  },
});
let failed = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✅ ${label}`); }
  catch (error) { console.log(`  ❌ ${label}：${error?.message ?? error}`); failed += 1; }
};

const key = 'private:456';
let seq = 0;
const say = (text) => {
  seq += 1;
  bridge.appendSocialV2Message(key, '球球', text, text, false, true, `r-${seq}`, [], '456');
};
const clearRecent = () => { bridge.getSocialV2State(key).recentMessages = []; };

console.log('角色注入与按需召回：\n');

await check('每轮注入的是核心卡（≤ 整卡一半），不是整卡', () => {
  const hint = bridge.roleHintForMode('v2');
  assert.ok(hint.length > 800, '核心卡不应为空');
  assert.ok(hint.length < full.length * 0.45, `注入 ${hint.length} 字符，整卡 ${full.length}`);
  assert.match(hint, /球球/);
});

await check('召回细节文件可读，且小节都有触发词', () => {
  assert.ok(bridge.roleRecallContent().length > 1500);
  const payload = bridge.buildRolePayload();
  assert.ok(payload.sections.length >= 6);
  for (const section of payload.sections) assert.ok(section.triggers.length > 0, `${section.title} 缺触发词`);
});

await check('他提到长相时，唤醒提示里带上外形细节', async () => {
  clearRecent();
  say('你长什么样，发张照片呗');
  const prompt = await bridge.buildWakePromptV2(key, 'private');
  assert.match(prompt, /【人设细节】/);
  assert.match(prompt, /冷白皮/, '应带上外形小节正文');
  assert.ok(prompt.length < 12000, `提示词没暴涨（${prompt.length}）`);
});

await check('闲聊不带无关细节（没命中就一个字都不加）', async () => {
  clearRecent();
  say('今天天气不错');
  const prompt = await bridge.buildWakePromptV2(key, 'private');
  assert.doesNotMatch(prompt, /【人设细节】/);
});

await check('点名要某一节：只回那一节，不夹带整卡', () => {
  const payload = bridge.buildRolePayload('生气');
  assert.equal(payload.section.title, '生气详解与收场');
  assert.match(payload.section.body, /台词参考|收场规则/);
  assert.equal(payload.hint, undefined, '按节返回时不该再带核心全文');
  const missing = bridge.buildRolePayload('不存在的一节');
  assert.equal(missing.section, null);
  assert.match(missing.sectionError, /没有/);
  assert.match(missing.sectionError, /外形与样子/, '报错要列出可用的节');
});

await check('事件话术：教她按编号收尾，并说明怎么自然地提', async () => {
  clearRecent();
  say('在吗');
  const prompt = await bridge.buildWakePromptV2(key, 'private');
  assert.match(prompt, /\[事件完\] 编号/, '必须告诉她按编号收尾');
  assert.match(prompt, /顺着当下的话题提|别单独开一句/, '到期事件要有可执行的提法');
});

await bridge.close();
const bad = failed > 0;
console.log(bad ? `\n❌ ${failed} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
