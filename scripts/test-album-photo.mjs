// 相册发照片（qq_list_self_photos / qq_send_self_photo）的回归。
//
// 为什么要有：人设写着「要照片就从相册挑一张」，而在这之前工具面里根本没有发照片的路，
// 她只能说「我发你一张」然后什么也发不出来（真实对话里他被晾了 5 次）。
// 这里守住三件事：只读相册白名单目录、名字不能穿越、发出去的段确实是那张图。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

// 夹具现在把 os.homedir() 指到临时目录（GPT 的隔离改动），所以**不能**再读真相册：
// 在临时 HOME 里造三张图 + 一份 index.md，测的仍是同一条代码路径，但完全不碰她的相册。
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da63000100000500010d0a2db40000000049454e44ae426082', 'hex');

let failed = 0;
const check = async (label, fn) => {
  try { await fn(); console.log(`  ✅ ${label}`); }
  catch (error) { console.log(`  ❌ ${label}：${error?.message ?? error}`); failed += 1; }
};

const request = (server, { method, path: urlPath, token, body, timeoutMs = 8000 }) => new Promise((resolve, reject) => {
  const req = http.request({
    host: '127.0.0.1',
    port: server.address().port,
    path: urlPath,
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-agent-token': token } : {})
    }
  }, (res) => {
    let raw = '';
    res.on('data', (chunk) => { raw += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(raw); } catch { return raw; } })() }));
  });
  req.on('error', reject);
  req.setTimeout(timeoutMs, () => req.destroy(new Error('request hung')));
  req.end(body ? JSON.stringify(body) : undefined);
});

console.log('相册发照片：\n');

const h = await bridgeHarness({ files: { 'state/mode.json': { mode: 'reserved2' } } });
h.refreshMode?.();
const ALBUM = path.join(h.temp, '.bili-ai', 'album-real', 'self');
fs.mkdirSync(ALBUM, { recursive: true });
for (const name of ['01-测试-看镜头.jpg', '02-测试-侧头.jpg', '03-测试-笑.jpg']) {
  fs.writeFileSync(path.join(ALBUM, name), PNG);
}
fs.writeFileSync(path.join(h.temp, '.bili-ai', 'album-real', 'index.md'), [
  '# 我的相册',
  '',
  '- `01-测试-看镜头.jpg` — 测试用图，看镜头',
  '- `02-测试-侧头.jpg` — 测试用图，侧头',
  '',
].join('\n'));

await check('相册列表：文件名 + 一句话说明都读得到', () => {
  const list = h.albumPhotos('self');
  assert.ok(list.length >= 1, '相册里应有照片');
  assert.ok(list.every((item) => item.name && item.bytes > 0), '每张都要有名字和大小');
  assert.ok(list.some((item) => item.caption), 'index.md 里的说明应被读出来');
});

await check('挑照片：可以按文件名/序号/标题片段挑，挑不到要报可用清单', () => {
  const list = h.albumPhotos('self');
  assert.equal(h.resolveAlbumPhoto(list[0].name).name, list[0].name);
  assert.equal(h.resolveAlbumPhoto('1').name, list[0].name, '序号从 1 开始');
  const noExt = list[0].name.replace(/\.[A-Za-z0-9]+$/, '');
  assert.equal(h.resolveAlbumPhoto(noExt).name, list[0].name);
  assert.throws(() => h.resolveAlbumPhoto('这张不存在.jpg'), /相册里没有/);
});

await check('目录穿越被拦住（不给读相册外的文件）', async () => {
  for (const bad of ['../../../etc/passwd', '../index.md', '..', '/etc/passwd']) {
    assert.throws(() => h.resolveAlbumPhoto(bad), /相册里没有|不合法/, `${bad} 应该被拒`);
  }
});

await check('真发一张：走 send_private_msg，图片段是那张图的字节', async () => {
  const list = h.albumPhotos('self');
  const target = list[0];
  h.calls.http.length = 0;
  const sent = await h.sendPhotoV2('private:123', target.name);
  assert.equal(sent.photo.name, target.name);
  const call = h.calls.http.find((item) => /send_private_msg$/.test(item.url));
  assert.ok(call, '应调用 OneBot send_private_msg');
  const imageSeg = (call.body.message || []).find((seg) => seg.type === 'image');
  assert.ok(imageSeg, '消息里应有 image 段');
  assert.match(imageSeg.data.file, /^base64:\/\//);
  const sentBytes = Buffer.from(imageSeg.data.file.slice('base64://'.length), 'base64');
  const fileBytes = fs.readFileSync(path.join(ALBUM, target.name));
  assert.equal(sentBytes.length, fileBytes.length, '发出去的就是相册里那张图');
  assert.ok(sentBytes.equals(fileBytes));
});

await check('路由：带 agent token 发照片 → 记录 [照片:…]，且不能在同一气泡附文字', async () => {
  const key = 'private:123';
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const token = h.getSocialV2State(key).agentToken;
    const list = h.albumPhotos('self');
    const withCaption = await request(server, {
      method: 'POST',
      path: '/api/socialV2/send-photo?token=fixture-console-token',
      token,
      body: { key, photo: list[0].name, message: '看我' }
    });
    assert.equal(withCaption.status, 400);
    assert.match(String(withCaption.body.error), /不能附带文字/);

    h.calls.http.length = 0;
    const ok = await request(server, {
      method: 'POST',
      path: '/api/socialV2/send-photo?token=fixture-console-token',
      token,
      body: { key, photo: list[0].name }
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.photo.name, list[0].name);
    const st = h.getSocialV2State(key);
    const last = st.recentMessages[st.recentMessages.length - 1];
    assert.equal(last.isSelf, true);
    assert.match(last.text, /^\[照片:/, '要记成 [照片:…]，她才记得自己发过');
    assert.equal(last.photo.name, list[0].name);
    assert.ok(h.calls.http.some((item) => /send_private_msg$/.test(item.url)), '应真的发出去');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


await check('[照片] 标记：从文字里摘掉，空标记表示让她自己挑', () => {
  // 注意：vm 里造出来的数组是另一个 realm 的 Array，deepEqual 会因原型不同而失败，
  // 所以这里用 join 比较内容。
  const one = h.extractPhotoMarkers('给你看 [照片] 3');
  assert.equal(one.text, '给你看');
  assert.equal(one.items.join('|'), '3');
  const blank = h.extractPhotoMarkers('[照片]');
  assert.equal(blank.items.length, 1);
  assert.equal(blank.items[0], '');
  assert.equal(blank.text, '');
  const named = h.extractPhotoMarkers('等下 [照片] 01-灰色针织开衫 [照片] 4');
  assert.equal(named.items.join('|'), '01-灰色针织开衫|4');
  assert.equal(named.text, '等下');
});

await check('她说「[照片] 1」时：文字照发，照片作为单独一条真发出去', async () => {
  const key = 'private:123';
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const token = h.getSocialV2State(key).agentToken;
    const list = h.albumPhotos('self');
    h.calls.http.length = 0;
    const res = await request(server, {
      method: 'POST',
      path: '/api/socialV2/send-message?token=fixture-console-token',
      token,
      body: { key, messages: [`给你看 [照片] 1`] }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.photos) && res.body.photos.length === 1, '应回报发了一张照片');
    assert.equal(res.body.photos[0].name, list[0].name);
    const textCall = h.calls.http.find((item) => /send_private_msg$/.test(item.url)
      && (item.body.message || []).some((seg) => /给你看/.test(seg.data?.text || '')));
    assert.ok(textCall, '文字要照发出去');
    assert.doesNotMatch(JSON.stringify(textCall.body), /\[照片\]/, '文字里不能残留 [照片] 标记');
    const imageCall = h.calls.http.find((item) => /send_private_msg$/.test(item.url)
      && (item.body.message || []).some((seg) => seg.type === 'image'));
    assert.ok(imageCall, '照片要作为单独一条发出去');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


await check('分条发送（qq_send_burst）也会摘掉 [照片]，不会把标记发给球球', async () => {
  const key = 'private:123';
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const token = h.getSocialV2State(key).agentToken;
    h.calls.http.length = 0;
    const res = await request(server, {
      method: 'POST',
      path: '/api/socialV2/send-burst?token=fixture-console-token',
      token,
      body: { key, messages: ['等我翻一下 [照片] 2', '就这张'] },
      timeoutMs: 25000
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok((res.body.photos || []).some((one) => one.ok), '应把照片发出去');
    const texts = h.calls.http
      .filter((item) => /send_private_msg$/.test(item.url))
      .flatMap((item) => (item.body.message || []))
      .filter((seg) => seg.type === 'text')
      .map((seg) => String(seg.data?.text || ''));
    assert.ok(texts.some((t) => /等我翻一下/.test(t)), '文字照发');
    assert.ok(!texts.some((t) => /\[照片\]/.test(t)), '任何一条文字里都不能残留 [照片]');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


await check('兜底：别的发送路径（qq_reply 等）漏摘的标记也不会发到 QQ', async () => {
  // 文本走 fake bot（calls.sent），不是 HTTP 网关，所以看 calls.sent。
  h.calls.sent.length = 0;
  await h.sendToQQ('private:123', '刚拍的 [照片] 5');
  const texts = h.calls.sent.map((item) => String(item.text ?? ''));
  assert.ok(texts.length >= 1, '应发出文字');
  assert.ok(texts.every((t) => !/\[照片\]/.test(t)), '最后一道网必须摘掉标记');
  assert.ok(texts.some((t) => /刚拍的/.test(t)), '正常文字要保留');
  // 整条都是标记时不发空消息
  h.calls.sent.length = 0;
  await h.sendToQQ('private:123', '[照片] 5');
  assert.equal(h.calls.sent.length, 0, '只有标记时不该发任何消息');
});

await h.close();
const bad = failed > 0;
console.log(bad ? `\n❌ ${failed} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
