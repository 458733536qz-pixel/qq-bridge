// 出错时给球球看的那句话：**只遮敏感片段**，不要整条变成「（含敏感信息，已隐藏）」。
//
// 背景：2026-10-27 15:24，provider 配错导致每条消息都失败，他收到的三行全是
// 「agent 处理出错：(含敏感信息，已隐藏)」——真实原因 "session/model-unavailable"
// 被整条吞掉，白白多挂了 40 分钟。这里钉住：错误类型要能看见，敏感路径/凭据要遮住。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const h = await bridgeHarness({});
let failed = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✅ ${label}`); }
  catch (error) { console.log(`  ❌ ${label}：${error?.message ?? error}`); failed += 1; }
};

console.log('错误红action：\n');

await check('模型错误保留错误类型，只遮路径', () => {
  const out = h.redactSensitiveHints('session/model-unavailable: Select an available model before sending a message. path=/Users/qiuzhan/secret/x');
  assert.match(out, /model-unavailable/);
  assert.ok(!out.includes('/Users/qiuzhan/secret'));
});

await check('普通错误原样透出（不误伤）', () => {
  assert.equal(h.redactSensitiveHints('网络超时：fetch failed'), '网络超时：fetch failed');
});

await check('超长错误截断到 500 字，不刷屏', () => {
  const out = h.redactSensitiveHints('x'.repeat(2000));
  assert.ok(out.length <= 500);
});

await check('整条都被遮时给一句可读的兜底', () => {
  const out = h.redactSensitiveHints('/Users/qiuzhan/secret/key.txt');
  assert.ok(out.trim().length > 0);
});

await h.close();
const bad = failed > 0;
console.log(bad ? `\n❌ ${failed} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
