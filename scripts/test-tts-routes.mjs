import {test} from 'node:test';import assert from 'node:assert/strict';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {createTtsService as makeService} from '../src/tts-api.js';
const wave=()=>{const b=Buffer.alloc(44+4800);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(4800,40);return b};
test('真实控制台路由：配置保密、模板独立保存、试听返回音频、AI隔离和幂等发送',async()=>{
 let generationCalls=0;const h=await bridgeHarness({config:{socialV2:{voice:{enabled:true},tools:{sendVoice:true}}},globals:{createTtsService:o=>makeService({...o,request:async()=>{generationCalls++;return {status:200,body:Buffer.from(JSON.stringify({choices:[{message:{audio:{data:wave().toString('base64')}}}]}))}}})}});
 h.setMode('reserved2');const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const call=async(route,body,headers={})=>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'x-console-token':'fixture-console-token','Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()}};
 try{
  let r=await call('/api/tts/settings',{enabled:true,aiEnabled:true,endpoint:'https://provider.invalid/v1/chat/completions',apiKey:'TEST-KEY-PRIVATE'});assert.equal(r.status,200);assert.equal(r.data.hasApiKey,true);assert.ok(!JSON.stringify(r.data).includes('TEST-KEY-PRIVATE'));
  const raw=Buffer.from('\uFEFF{  "input": {{text_json}} }\r\n\r\n');r=await call('/api/tts/template',{model:'design-fixture',part:'body',base64:raw.toString('base64')});assert.equal(r.data.base64,raw.toString('base64'));r=await call('/api/tts/settings?model=design-fixture');assert.equal(r.data.templates.body.base64,raw.toString('base64'));
  r=await call('/api/tts/synthesize',{text:'只试听'});assert.equal(r.data.ok,true);const a=await fetch(base+'/api/tts/audio/'+r.data.id,{headers:{'x-console-token':'fixture-console-token'}});assert.equal(a.status,200);assert.deepEqual(Buffer.from(await a.arrayBuffer()),wave());assert.equal(h.calls.http.filter(x=>x.url.endsWith('send_private_msg')).length,0);
  const st=h.getSocialV2State('private:123'),token=st.agentToken,headers={'x-agent-token':token,'x-agent-call':'1'};
  r=await call('/api/tts/settings',undefined,headers);assert.equal(r.status,403);
  r=await call('/api/tts/template',{model:'a',part:'body',raw:'x'},headers);assert.equal(r.status,403);
  const before=generationCalls;r=await call('/api/socialV2/tts-send',{key:'group:456',text:'跨会话不得合成',requestId:'wrong-session-test'},headers);assert.equal(r.status,403);assert.equal(generationCalls,before);
  r=await call('/api/socialV2/tts-send',{key:'private:123',text:'这是合成语音',requestId:'unique-voice-job-1'},headers);assert.equal(r.data.ok,true,JSON.stringify(r.data));assert.equal(r.data.verified,true);const after=generationCalls;
  const again=await call('/api/socialV2/tts-send',{key:'private:123',text:'这是合成语音',requestId:'unique-voice-job-1'},headers);assert.equal(again.data.messageId,r.data.messageId);assert.equal(generationCalls,after);
  r=await call('/api/socialV2/tts-send',{key:'private:123',text:'api_key: PRIVATE',requestId:'sensitive-job-test'},headers);assert.equal(r.status,403);assert.equal(generationCalls,after);
 }finally{await new Promise(r=>server.close(r));await h.close()}
});

test('合成期间管理员关掉AI语音，会取消发送',async()=>{
 let h;h=await bridgeHarness({config:{socialV2:{voice:{enabled:true},tools:{sendVoice:true}}},globals:{createTtsService:o=>makeService({...o,request:async()=>{h.tts.save({aiEnabled:false});return {status:200,body:wave()}}})}});
 h.setMode('reserved2');h.tts.save({enabled:true,aiEnabled:true});const token=h.getSocialV2State('private:123').agentToken;const server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));
 try{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/socialV2/tts-send',{method:'POST',headers:{'Content-Type':'application/json','x-console-token':'fixture-console-token','x-agent-token':token,'x-agent-call':'1'},body:JSON.stringify({key:'private:123',text:'测试语音',requestId:'disable-during-request'})});const j=await r.json();assert.equal(j.ok,false);assert.match(j.error,/权限已变化/);assert.equal(h.calls.http.filter(x=>x.url.endsWith('send_private_msg')).length,0)}finally{await new Promise(r=>server.close(r));await h.close()}
});
