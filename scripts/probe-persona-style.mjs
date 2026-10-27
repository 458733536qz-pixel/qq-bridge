// 人设「自然度」探针：只用人设文本 + 一句用户话，看她的真实输出。
//
// 为什么不用生产会话：生产会话要发到球球的 QQ 上，测试不该打扰他；这里建临时会话
// （preset=qq-chat，一代模式文本即回复），把 core 人设贴进去，逐条场景跑一遍，
// 只看她的语气/长度/复读/追问/虚构。跑完归档会话、删工作区。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { probeCookie, probeRpc, probeMuxSocket, probeWorkspaceDir } from './probe-auth.mjs';

const core = fs.readFileSync(path.join(os.homedir(), '.bili-ai', 'persona-core.md'), 'utf8');
const cookie = probeCookie();
const rpc = probeRpc(cookie);
const dir = probeWorkspaceDir('persona-style');

const SCENARIOS = [
  ['普通闲聊', '在干嘛'],
  ['废话', '我发现一件事情，人睡觉的时候会闭眼'],
  ['互怼', '你是不是傻'],
  ['冷笑话', '讲个笑话'],
  ['情绪低落', '今天特别烦，什么都不想做'],
  ['认真办事', '帮我查一下这个插件怎么装，我一直装不上'],
  ['身份询问', '你是不是AI啊'],
];

const ws = await rpc('workspace/create', { request: { path: dir } });
const wsId = ws.value.workspace.workspaceId;
const results = [];

for (const [label, text] of SCENARIOS) {
  const sc = await rpc('session/create', { request: { workspaceId: wsId, agentPreset: 'qq-chat' } });
  if (!sc.ok) { results.push({ label, error: JSON.stringify(sc.error).slice(0, 120) }); continue; }
  const sessionId = sc.value.sessionId;
  await rpc('session/selectModel', { request: { sessionId, provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' } });

  const socket = probeMuxSocket(cookie);
  const streamId = randomUUID();
  let out = '';
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 60_000);
    const finish = (why) => { clearTimeout(timer); resolve(why); };
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId } } } } }));
      setTimeout(() => {
        rpc('session/prompt', {
          request: {
            sessionId, requestId: randomUUID(), mode: 'queue',
            content: [{ type: 'text', text: `${core}\n\n【当前消息】球球：${text}\n直接回他一句/几句，不要调用工具。` }]
          }
        }).catch(() => {});
      }, 600);
    });
    socket.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type !== 'item' || m.streamId !== streamId) return;
      const e = m.value?.event;
      if (!e) return;
      if (e.type === 'assistant/message') for (const b of e.data?.message?.content ?? []) if (b?.type === 'text') out += b.text;
      if (e.type === 'turn/end') finish('done');
    });
    socket.addEventListener('error', () => finish('error'));
  });
  const why = await done;
  try { socket.close(); } catch {}
  results.push({ label, why, out: out.trim() });
  try { await rpc('workspace/archiveSession', { request: { sessionId } }); } catch {}
  console.log(`\n=== ${label}（${text}）→ ${why} ===\n${out.trim() || '（无文本输出）'}`);
}

try { await rpc('workspace/delete', { request: { workspaceId: wsId } }); } catch {}
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
fs.writeFileSync('/tmp/persona-style.json', JSON.stringify(results, null, 2));
console.log('\n[cleanup] 临时会话已归档、工作区已删除');
process.exit(0);
