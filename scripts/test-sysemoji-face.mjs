// 系统表情（sysemoji）验收：QQ 给的是 zip 包，不是图片。
//
// 真实 payload（2026-10-27 从本机 OneBot 现取）：
//   face 5 /流泪 → url .../sysemoji/v1/singleres/5_base_1712825561.zip
//   face 9 /大哭 → url .../sysemoji/v1/singleres/9_base_1712825561.zip
// 以前这里会去 safeFetchBuffer 下 zip，然后判「不是有效图片」，她那一轮只能盲回。
// 现在的约定：系统表情只给文字标签（[表情:大哭]），市场/超级表情才下图片。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const SYSEMOJI = {
  5: { q_sid: '5', q_des: '/流泪', em_code: '105', ani_sticker_type: 1, ani_sticker_pack_id: 1, ani_sticker_id: 16, url: 'https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres/5_base_1712825561.zip', is_super: false },
  9: { q_sid: '9', q_des: '/大哭', em_code: '109', ani_sticker_type: null, ani_sticker_pack_id: null, ani_sticker_id: null, url: 'https://wa.qq.com/qgif-web-permanent/sysemoji/v1/singleres/9_base_1712825561.zip', is_super: false },
  // 市场/超级表情：真图片，应该照常下载
  999: { q_sid: '999', q_des: '/给你糖吃', ani_sticker_type: 2, ani_sticker_pack_id: 3, ani_sticker_id: 77, url: 'https://p.qpic.cn/qq_expression/999/abc/0', is_super: true },
};

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da63000100000500010d0a2db40000000049454e44ae426082', 'hex');
let downloads = 0;
const h = await bridgeHarness({
  faceEntities: SYSEMOJI,
  globals: {
    // 真下载就记一次；市场表情那条要求它被调用，系统表情那条要求它没被调用。
    safeFetchBuffer: async () => { downloads += 1; return { url: 'x', statusCode: 200, buffer: PNG }; },
  },
});

let failed = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✅ ${label}`); }
  catch (error) { console.log(`  ❌ ${label}：${error?.message ?? error}`); failed += 1; }
};

console.log('系统表情验收：\n');

await check('face 9 /大哭 → 文字标签，不下载', async () => {
  downloads = 0;
  const out = await h.fetchFaceMedia({ kind: 'face', faceId: '9' });
  assert.equal(out.text, '[表情:大哭]');
  assert.ok(!out.buffer, '系统表情不该有图片字节');
  assert.equal(downloads, 0, '不该去下载 zip');
});

await check('face 5 /流泪 → 文字标签，不下载（它的 ani_sticker_* 非空也不能误判成图片）', async () => {
  downloads = 0;
  const out = await h.fetchFaceMedia({ kind: 'face', faceId: '5' });
  assert.equal(out.text, '[表情:流泪]');
  assert.ok(!out.buffer);
  assert.equal(downloads, 0);
});

await check('超级/市场表情 → 仍然下载图片并带上说明', async () => {
  downloads = 0;
  const out = await h.fetchFaceMedia({ kind: 'face', faceId: '999' });
  assert.equal(downloads, 1, '市场表情要真的抓图');
  assert.ok(out.buffer && out.buffer.length > 0);
  assert.match(String(out.text), /给你糖吃/);
});

await check('拿不到实体时退回 summary 文案（不炸）', async () => {
  const out = await h.fetchFaceMedia({ kind: 'face', faceId: '424242', summary: '/无语' });
  assert.equal(out.text, '[表情:无语]');
});

await h.close();
const bad = failed > 0;
console.log(bad ? `\n❌ ${failed} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
