import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createTtsService,parseHeaders,replacePlaceholders,rawRequest,modelsUrl,OFFICIAL_ENDPOINT,MIMO_VOICES} from '../src/tts-api.js';
function wav(){const b=Buffer.alloc(44+4800);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(4800,40);return b}
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'qq-tts-test-'));
test('请求头与请求体独立保存，BOM/CRLF/中文/空白经重开后字节完全一致',()=>{
 const root=temp();try{let s=createTtsService({root});const headers=Buffer.from('\uFEFFX-Test: {{text}}\r\nX-Spaces:   z  \r\n');const body=Buffer.from('\uFEFF{\r\n "中文":  "空格  ",  "input": {{text_json}}\r\n}\r\n\r\n');s.saveRaw('mimo-v2.5-tts-voicedesign','headers',{base64:headers.toString('base64')});s.saveRaw('mimo-v2.5-tts-voicedesign','body',{base64:body.toString('base64')});s=createTtsService({root});assert.deepEqual(s.templates('mimo-v2.5-tts-voicedesign'),{headers,body});s.saveRaw('mimo-v2.5-tts-voicedesign','headers',{raw:'X-Changed: yes\n'});assert.deepEqual(s.templates('mimo-v2.5-tts-voicedesign').body,body);assert.notDeepEqual(s.templates('other').body,body);}finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('真实HTTP接收字节等于替换后的原文；不自动补Content-Type或Authorization',async()=>{
 const root=temp(),seen=[];const server=http.createServer((req,res)=>{const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{seen.push({headers:req.headers,body:Buffer.concat(chunks)});res.writeHead(200,{'Content-Type':'audio/wav'});res.end(wav())})});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const s=createTtsService({root});s.save({enabled:true,apiKey:'NEVER_AUTOFILL',model:'mimo-v2.5-tts-voicedesign',endpoint:`http://127.0.0.1:${server.address().port}/tts`});s.saveRaw(s.read().model,'headers',{raw:'X-Custom: {{model}}\r\n'});const raw='\uFEFF{\r\n  "text":{{text_json}} ,"verbatim": [ 1,2 ]\r\n}\r\n';s.saveRaw(s.read().model,'body',{raw});const out=await s.synthesize('你好"球球"\n第二行');assert.deepEqual(seen[0].body,Buffer.from(replacePlaceholders(raw,{text_json:JSON.stringify('你好"球球"\n第二行')})));assert.equal(seen[0].headers['content-type'],undefined);assert.equal(seen[0].headers.authorization,undefined);assert.equal(seen[0].headers['api-key'],undefined);assert.equal(out.bytes,wav().length);assert.deepEqual(s.audio(out.id).bytes,wav());}finally{await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true})}
});
test('JSON请求头仅解析键值并替换；拒绝换行注入与未知占位符',()=>{assert.deepEqual(parseHeaders('{"X-Exact":"  {{apiKey}}  "}',{apiKey:'abc'}),{'X-Exact':'  abc  '});assert.throws(()=>parseHeaders('X-Test: {{text}}',{text:'a\r\nAuthorization: secret'}));assert.throws(()=>replacePlaceholders('{{unknown}}',{}));assert.equal(modelsUrl(OFFICIAL_ENDPOINT),'https://api.xiaomimimo.com/v1/models');});
test('MiMo角色、中文预设音色、唱歌限制和克隆音频真实进入audio.voice',async()=>{
 const root=temp();let captured;try{const s=createTtsService({root,request:async(u,r)=>{captured=JSON.parse(r.body);return {status:200,body:Buffer.from(JSON.stringify({choices:[{message:{audio:{data:wav().toString('base64')}}}]}))}}});s.save({enabled:true,endpoint:OFFICIAL_ENDPOINT,apiKey:'test-key',profile:{voice:'茉莉'}});await s.synthesize('这是测试',{sing:true});assert.equal(captured.audio.voice,'茉莉');assert.equal(captured.messages[1].role,'assistant');assert.equal(captured.messages[1].content,'(唱歌)这是测试');const clone=s.cloneUpload({name:'声音.wav',base64:wav().toString('base64')});s.save({model:'mimo-v2.5-tts-voiceclone',profile:{cloneId:clone.id}});await s.synthesize('克隆文字');assert.equal(captured.audio.voice,'data:audio/wav;base64,'+wav().toString('base64'));await assert.rejects(()=>s.synthesize('唱歌',{sing:true}),/不支持/);assert.ok(MIMO_VOICES.every(v=>/[\u4e00-\u9fff]/.test(v.label)));}finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('模型列表真实解析；上游错误隐藏密钥；超时不自动重试',async()=>{
 const root=temp();let calls=0;try{const s=createTtsService({root,request:async(u,r)=>{calls++;if(r.method==='GET')return {status:200,body:Buffer.from('{"data":[{"id":"live-model"}]}')};return {status:401,body:Buffer.from('bad TEST_SECRET')}}});s.save({enabled:true,apiKey:'TEST_SECRET'});assert.equal((await s.models()).models[0].id,'live-model');await assert.rejects(()=>s.synthesize('测试'),e=>!e.message.includes('TEST_SECRET'));assert.equal(calls,2);assert.equal(s.view().apiKey,undefined);assert.equal(s.view().hasApiKey,true);const failing=createTtsService({root,request:async()=>{calls++;throw Error('timeout')}});await assert.rejects(()=>failing.synthesize('测试'),/timeout/);assert.equal(calls,3);}finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('关闭时拒绝合成；OpenAI协议收到二进制音频，不添加MiMo字段',async()=>{
 const root=temp();try{const s=createTtsService({root,request:async(u,r)=>{const b=JSON.parse(r.body);assert.equal(b.input,'测试');assert.equal(b.voice,'coral');assert.equal(b.messages,undefined);assert.equal(r.headers.Authorization,'Bearer api-test');return {status:200,body:wav()}}});await assert.rejects(()=>s.synthesize('测试'),/未启用/);s.save({enabled:true,protocol:'openai',endpoint:'http://localhost/v1/audio/speech',model:'gpt-4o-mini-tts',apiKey:'api-test',profile:{voice:'coral'}});assert.equal((await s.synthesize('测试')).bytes,wav().length);}finally{fs.rmSync(root,{recursive:true,force:true})}
});

test('空请求头与空请求体也可保存、往返和渲染',()=>{const root=temp();try{const s=createTtsService({root});s.saveRaw('empty','headers',{base64:''});s.saveRaw('empty','body',{raw:''});const t=s.templates('empty');assert.equal(t.headers.length,0);assert.equal(t.body.length,0);assert.deepEqual(parseHeaders(''),{});}finally{fs.rmSync(root,{recursive:true,force:true})}});

test('本句演绎只改变MiMo指导，不改变冰糖音色和原始说话文字',()=>{
 const root=temp();try{const s=createTtsService({root});s.save({enabled:true,model:'mimo-v2.5-tts',profile:{voice:'冰糖',prompt:'基础指导'}});const text='球球，在呢。';const r=s.prepare(text,{delivery:'comfort'});const b=JSON.parse(r.body);assert.equal(b.audio.voice,'冰糖');assert.equal(b.messages[1].content,text);assert.ok(b.messages[0].content.startsWith('基础指导'));assert.ok(b.messages[0].content.includes('【本句演绎】'));assert.ok(b.messages[0].content.includes('不说教'));assert.throws(()=>s.prepare(text,{delivery:'unknown'}),/不支持/);}finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('自定义原文模式不会因演绎选项被添加前后缀或重新序列化',()=>{
 const root=temp();try{const s=createTtsService({root});s.save({enabled:true,protocol:'custom',model:'raw-model'});const raw='\uFEFF  payload={{text}}\r\n\r\n';s.saveRaw('raw-model','headers',{raw:''});s.saveRaw('raw-model','body',{raw});const r=s.prepare('原文',{delivery:'quiet'});assert.deepEqual(r.body,Buffer.from('\uFEFF  payload=原文\r\n\r\n'));assert.deepEqual(r.headers,{});}finally{fs.rmSync(root,{recursive:true,force:true})}
});

test('肥鱼输出使用转换后的字节和回执，失败时不以原音色冒充；原文请求不变',async()=>{
 const root=temp();try{
  const source=wav(),converted=Buffer.from(wav());converted[converted.length-1]=1;let calls=0;
  const s=createTtsService({root,request:async(u,r)=>{assert.deepEqual(r.body,Buffer.from('\uFEFF  text=原文\r\n'));assert.deepEqual(r.headers,{});return {status:200,body:source}},convertVoice:async v=>{calls++;assert.deepEqual(v.bytes,source);return {bytes:converted,receipt:{status:'success',model_sha256:'verified-test'}}}});
  s.save({enabled:true,protocol:'custom',model:'raw'});assert.throws(()=>s.save({outputVoice:'feiyu-rvc'}),/尚未安装/);
  const settings=path.join(root,'state/tts/settings.json');const data=JSON.parse(fs.readFileSync(settings));data.outputVoice='feiyu-rvc';fs.writeFileSync(settings,JSON.stringify(data));
  s.saveRaw('raw','headers',{raw:''});s.saveRaw('raw','body',{raw:'\uFEFF  text={{text}}\r\n'});
  const result=await s.synthesize('原文');assert.equal(calls,1);assert.equal(result.outputVoice,'feiyu-rvc');assert.deepEqual(s.audio(result.id).bytes,converted);assert.equal(result.conversion.status,'success');
  const failing=createTtsService({root,request:async()=>({status:200,body:source}),convertVoice:async()=>{throw Error('conversion failed')}});
  await assert.rejects(()=>failing.synthesize('原文'),/conversion failed/);assert.equal(fs.readdirSync(path.join(root,'state/tts/generated')).length,1);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
