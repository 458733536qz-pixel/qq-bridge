// Administrator-configured TTS. Raw templates never pass through JSON serialization.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { deliveryPrompt } from './tts-delivery.js';
import { feiyuStatus, convertFeiyu } from './tts-feiyu.js';
export const DEFAULT_ENDPOINT='https://api.xiaomimimo.com/v1/chat/completionsts';
export const OFFICIAL_ENDPOINT='https://api.xiaomimimo.com/v1/chat/completions';
export const MIMO_MODELS=['mimo-v2.5-tts','mimo-v2.5-tts-voicedesign','mimo-v2.5-tts-voiceclone'];
const CDN='https://aistudio-cdn.xiaomimimo.com/xiaomimimo-static/blog/tts-2-5/';
export const MIMO_VOICES=[
 ['mimo_default','默认音色','',null],['冰糖','冰糖 · 中文女声','中文女声','voice-preview-1-bingtang.wav'],['茉莉','茉莉 · 中文女声','中文女声','voice-preview-2-moli.wav'],['苏打','苏打 · 中文男声','中文男声','voice-preview-3-suda.wav'],['白桦','白桦 · 中文男声','中文男声','voice-preview-4-baihua.wav'],['Mia','米娅 · 英文女声','英文女声','voice-preview-5-mia.wav'],['Chloe','克洛伊 · 英文女声','英文女声','voice-preview-6-chloe.wav'],['Milo','米洛 · 英文男声','英文男声','voice-preview-7-milo.wav'],['Dean','迪恩 · 英文男声','英文男声','voice-preview-8-dean.wav']
].map(([id,label,language,file])=>({id,label,language,sampleUrl:file?CDN+file:null}));
const OPENAI_VOICES=['alloy','ash','ballad','coral','echo','fable','nova','onyx','sage','shimmer','verse','marin','cedar'].map(id=>({id,label:({alloy:'合金',ash:'白蜡',ballad:'民谣',coral:'珊瑚',echo:'回声',fable:'寓言',nova:'新星',onyx:'缟玛瑙',sage:'鼠尾草',shimmer:'微光',verse:'诗句',marin:'马林',cedar:'雪松'})[id]+'（'+id+'）',sampleUrl:null}));
export function modelKind(id){return /voiceclone/i.test(id)?'clone':/voicedesign/i.test(id)?'design':'preset'}
export function endpointUrl(value){const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hash)throw Error('接口地址仅支持无凭据、无片段的 HTTP(S) URL');return u}
export function modelsUrl(endpoint){const u=endpointUrl(endpoint);u.pathname=u.pathname.replace(/\/(chat\/completions(?:ts)?|audio\/speech)\/?$/,'').replace(/\/$/,'')+'/models';u.search='';return u.href}
export function replacePlaceholders(raw,vars){
 return String(raw).replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}|\$\{([A-Za-z][A-Za-z0-9_]*)\}/g,(all,a,b)=>{const k=a||b;if(!Object.hasOwn(vars,k))throw Error('未定义占位符：'+k);return String(vars[k])});
}
export function parseHeaders(raw,vars={}){
 const source=String(raw).replace(/^\uFEFF/,'');let entries;
 if(source.trim().startsWith('{')){const v=JSON.parse(source);if(!v||Array.isArray(v)||typeof v!=='object')throw Error('请求头须为键值对象');entries=Object.entries(v);}
 else entries=source.split(/\r\n|\n|\r/).filter(l=>l.trim()).map(l=>{const i=l.indexOf(':');if(i<1)throw Error('请求头每行应为名称: 值');return [l.slice(0,i).trim(),l.slice(i+1).replace(/^ /,'')]});
 const headers={};const seen=new Set();for(const [name,val]of entries){if(typeof val!=='string')throw Error('请求头值必须为字符串');http.validateHeaderName(name);const value=replacePlaceholders(val,vars);http.validateHeaderValue(name,value);if(seen.has(name.toLowerCase()))throw Error('请求头名称重复：'+name);seen.add(name.toLowerCase());headers[name]=value}return headers;
}
export function rawRequest(endpoint,{method='POST',headers={},body=Buffer.alloc(0),timeoutMs=90000,maxBytes=32*1024*1024}={}){
 const url=endpointUrl(endpoint);return new Promise((resolve,reject)=>{
  let done=false;let res;const finish=(err,v)=>{if(done)return;done=true;clearTimeout(timer);err?reject(err):resolve(v)};
  const req=(url.protocol==='https:'?https:http).request(url,{method,headers},r=>{res=r;const chunks=[];let size=0;r.on('data',c=>{size+=c.length;if(size>maxBytes){const e=Error('响应超过大小上限');r.destroy(e);finish(e)}else chunks.push(c)});r.on('end',()=>finish(null,{status:r.statusCode,headers:r.headers,body:Buffer.concat(chunks)}));r.on('error',e=>finish(e));r.on('aborted',()=>finish(Error('响应中断，结果未确认；不自动重试')))});
  const timer=setTimeout(()=>{const e=Error('TTS请求超时，结果未确认；不自动重试');req.destroy(e);res?.destroy(e);finish(e)},timeoutMs);
  req.on('error',e=>finish(e));req.end(body);
 });
}
const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const jsonRead=(f,fallback)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw Error('TTS配置损坏，请先恢复备份')}};
function writeAtomic(file,bytes){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,bytes,{mode:0o600});fs.renameSync(tmp,file);fs.chmodSync(file,0o600)}
export function templateDefaults(model,protocol='mimo'){
 const h=protocol==='mimo'?'Content-Type: application/json\napi-key: {{apiKey}}':'Content-Type: application/json\nAuthorization: Bearer {{apiKey}}';
 const b=protocol==='openai'?'{"model":{{model_json}},"input":{{text_json}},"voice":{{voice_json}},"response_format":"wav"}':
  '{\n  "model": {{model_json}},\n  "messages": [{"role":"user","content":{{prompt_json}}},{"role":"assistant","content":{{text_json}}}],\n  "audio": {"format":"wav"}\n}';
 return {headers:h,body:b};
}
export function createTtsService({root,libraryDir=()=>path.join(root,'audio'),request=rawRequest,convertVoice=convertFeiyu}={}){
 const dir=path.join(root,'state','tts');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const settingsFile=path.join(dir,'settings.json'),keyFile=path.join(dir,'api-key.txt');
 const initial={endpoint:DEFAULT_ENDPOINT,modelsEndpoint:'https://api.xiaomimimo.com/v1/models',model:MIMO_MODELS[0],enabled:false,aiEnabled:false,protocol:'mimo',maxChars:800,outputVoice:'source',profiles:{}};
 const read=()=>({...initial,...jsonRead(settingsFile,{})});
 let synthesizing=false;const synthesisTimes=[];
 const key=()=>{try{return fs.readFileSync(keyFile,'utf8')}catch{return ''}};
 const profile=(model=read().model)=>{const s=read();return {kind:modelKind(model),voice:s.protocol==='openai'?'coral':'冰糖',prompt:'年轻成年女性，清冷柔和、自然随性的聊天语气，语速适中，避免播音腔。',cloneId:'',responsePath:'choices.0.message.audio.data',...s.profiles[model]}};
 const templates=model=>{const base=path.join(dir,'templates',hash(model)),d=templateDefaults(model,read().protocol);const get=(name,fallback)=>{try{return fs.readFileSync(path.join(base,name+'.raw'))}catch(e){if(e.code!=='ENOENT')throw e;return Buffer.from(fallback)}};return {headers:get('headers',d.headers),body:get('body',d.body)}};
 const rawView=b=>({raw:b.toString('utf8'),base64:b.toString('base64'),bytes:b.length,sha256:hash(b)});
 const view=(model)=>{const s=read(),id=model||s.model,t=templates(id);return {...s,profiles:undefined,hasApiKey:!!key(),feiyu:feiyuStatus(root),profile:profile(id),selectedModel:id,templates:{headers:rawView(t.headers),body:rawView(t.body)},voices:s.protocol==='mimo'?MIMO_VOICES:OPENAI_VOICES,officialEndpoint:OFFICIAL_ENDPOINT,endpointWarning:s.endpoint.endsWith('/completionsts')?'当前地址以 completionsts 结尾，官方路径为 chat/completions。地址未被自动改写。':''}};
 const redact=s=>{const k=key();return k?String(s).split(k).join('[密钥已隐藏]'):String(s)};
 const cleanError=e=>Error(redact(e?.message||e).replace(/data:audio\/[^\s]+/g,'[音频数据已隐藏]'));
 function save(input){const s=read();for(const k of ['endpoint','modelsEndpoint','model','protocol'])if(typeof input[k]==='string')s[k]=input[k];endpointUrl(s.endpoint);endpointUrl(s.modelsEndpoint||modelsUrl(s.endpoint));if(!['mimo','openai','custom'].includes(s.protocol))throw Error('未知接口协议');if(s.model.length>150||!s.model)throw Error('模型ID无效');for(const k of ['enabled','aiEnabled'])if(typeof input[k]==='boolean')s[k]=input[k];if(input.maxChars!==undefined)s.maxChars=Math.max(1,Math.min(3000,Number(input.maxChars)||800));if(input.profile){const prev=profile(s.model),p={...prev};for(const k of ['kind','voice','prompt','cloneId','responsePath'])if(typeof input.profile[k]==='string')p[k]=input.profile[k];if(!['preset','design','clone'].includes(p.kind))throw Error('模型类型无效');s.profiles[s.model]=p;}if(input.outputVoice!==undefined){if(!['source','feiyu-rvc'].includes(input.outputVoice))throw Error('未知输出音色');if(input.outputVoice==='feiyu-rvc'&&!feiyuStatus(root).ready)throw Error('肥鱼本机引擎尚未安装完成');s.outputVoice=input.outputVoice;}if(input.apiKey!==undefined){if(typeof input.apiKey!=='string'||/[\r\n]/.test(input.apiKey))throw Error('密钥格式无效');writeAtomic(keyFile,input.apiKey)}writeAtomic(settingsFile,JSON.stringify(s,null,2));return view()}
 function saveRaw(model,part,{base64,raw}={}){if(!['headers','body'].includes(part))throw Error('未知模板模块');const bytes=base64!==undefined?(base64===''?Buffer.alloc(0):strictBase64(base64)):Buffer.from(String(raw??''),'utf8');if(bytes.length>256*1024)throw Error('模板超过256KB');if(!Buffer.from(bytes.toString('utf8'),'utf8').equals(bytes))throw Error('模板必须是UTF-8原文');writeAtomic(path.join(dir,'templates',hash(model),part+'.raw'),bytes);return rawView(fs.readFileSync(path.join(dir,'templates',hash(model),part+'.raw')))}
 function cloneUpload({name,base64}){const b=strictBase64(base64);if(Buffer.byteLength(base64)>10*1024*1024)throw Error('克隆参考音频Base64超过MiMo的10MB上限');const ext=audioFormat(b);if(!['wav','mp3'].includes(ext))throw Error('克隆参考只支持有效WAV或MP3音频');const id=crypto.randomUUID();writeAtomic(path.join(dir,'clones',id+'.'+ext),b);writeAtomic(path.join(dir,'clones',id+'.json'),JSON.stringify({id,ext,name:path.basename(String(name||'参考音频')),bytes:b.length}));return {id,ext,name:path.basename(String(name||'参考音频')),bytes:b.length}}
 function cloneData(id){if(!/^[0-9a-f-]{36}$/.test(id))throw Error('请选择已上传的克隆参考音频');const meta=jsonRead(path.join(dir,'clones',id+'.json'),null);if(!meta)throw Error('克隆参考音频不存在');const b=fs.readFileSync(path.join(dir,'clones',id+'.'+meta.ext));return `data:audio/${meta.ext==='mp3'?'mpeg':'wav'};base64,${b.toString('base64')}`}
 function prepare(text,{sing=false,delivery}={}){
  const s=read(),p=profile();if(!s.enabled)throw Error('TTS尚未启用，请先填写密钥并保存配置');if(!text||typeof text!=='string'||text.length>s.maxChars)throw Error('合成文字为空或超过字数上限');
  if(p.kind==='clone'&&s.protocol==='openai')throw Error('OpenAI标准语音接口没有克隆上传契约；请用MiMo克隆模型，或自定义协议在原文中引用audio_data_uri');
  if(sing&&!(s.protocol==='mimo'&&p.kind==='preset'&&s.model==='mimo-v2.5-tts'))throw Error('当前模型不支持MiMo唱歌模式');
  const target=sing?'(唱歌)'+text:text;const ref=p.kind==='clone'?cloneData(p.cloneId):'';
  const vars={text:target,model:s.model,apiKey:key(),voice:p.voice,prompt:p.prompt,audio_data_uri:ref,audio_base64:ref.split(',')[1]||''};for(const [k,v]of Object.entries({...vars}))vars[k+'_json']=JSON.stringify(v);
  if(p.kind==='design'||s.protocol==='custom'){const t=templates(s.model);return {endpoint:s.endpoint,headers:parseHeaders(t.headers.toString('utf8'),vars),body:Buffer.from(replacePlaceholders(t.body.toString('utf8'),vars),'utf8'),responsePath:p.responsePath}}
  let body;if(s.protocol==='mimo'){body={model:s.model,messages:[{role:'user',content:deliveryPrompt(p.prompt,delivery)},{role:'assistant',content:target}],audio:{format:'wav',voice:ref||p.voice}}}else{body={model:s.model,input:text,voice:p.voice,response_format:'wav'};if(p.prompt&&/^gpt-.*tts/.test(s.model))body.instructions=p.prompt}
  return {endpoint:s.endpoint,headers:s.protocol==='mimo'?{'Content-Type':'application/json','api-key':key()}:{'Content-Type':'application/json',Authorization:'Bearer '+key()},body:Buffer.from(JSON.stringify(body)),responsePath:p.responsePath};
 }
 async function models(){const s=read();const headers=s.protocol==='mimo'?{'api-key':key()}:{Authorization:'Bearer '+key()};const r=await request(s.modelsEndpoint||modelsUrl(s.endpoint),{method:'GET',headers,maxBytes:2*1024*1024,timeoutMs:20000});if(r.status<200||r.status>=300)throw Error('模型获取失败 HTTP '+r.status+'：'+redact(r.body.toString().slice(0,400)));const j=JSON.parse(r.body);const ids=(j.data||j.models||[]).map(v=>typeof v==='string'?v:v.id).filter(v=>typeof v==='string');if(!ids.length)throw Error('接口未返回可识别的模型列表');return {models:ids.map(id=>({id,kind:modelKind(id)})),source:'live'}}
 async function synthesize(text,options={}){
  if(synthesizing)throw Error('已有语音正在合成，请等它完成；未重复提交');
  const now=Date.now();while(synthesisTimes[0]<now-3600000)synthesisTimes.shift();
  if(synthesisTimes.length>=30)throw Error('TTS本地每小时30次合成上限已到');
  const outputVoice=read().outputVoice;const r=prepare(text,options);synthesizing=true;synthesisTimes.push(now);
  try{
   let response;try{response=await request(r.endpoint,r)}catch(e){throw cleanError(e)}
   if(response.status<200||response.status>=300)throw cleanError(Error('合成失败 HTTP '+response.status+'：'+response.body.toString('utf8').slice(0,500)));
   let bytes=response.body;
   if(!audioFormat(bytes)){
    let j;try{j=JSON.parse(bytes.toString('utf8'))}catch{throw Error('响应不是可识别音频或JSON')}
    const value=r.responsePath.split('.').reduce((v,k)=>v?.[k],j);
    if(typeof value!=='string')throw Error('响应中没有配置的音频Base64字段：'+r.responsePath);
    bytes=strictBase64(value);
   }
   if(!audioFormat(bytes))throw Error('返回音频格式不受支持；请使用WAV或MP3');
   let conversion=null;if(outputVoice==='feiyu-rvc'){const result=await convertVoice({root,bytes});bytes=result.bytes;conversion=result.receipt;}
   const ext=audioFormat(bytes);if(!ext)throw Error('返回音频格式不受支持；请使用WAV或MP3');
   const id=crypto.randomUUID(),library=libraryDir(),dest=path.join(library,'tts-generated',id+'.'+ext);
   writeAtomic(dest,bytes);writeAtomic(path.join(dir,'generated',id+'.json'),JSON.stringify({id,ext,bytes:bytes.length,createdAt:new Date().toISOString(),outputVoice,conversion}));
   return {id,outputVoice,conversion,voice:'tts-generated/'+id+'.'+ext,bytes:bytes.length,mime:ext==='wav'?'audio/wav':'audio/mpeg'};
  }finally{synthesizing=false}
 }
 function audio(id){if(!/^[0-9a-f-]{36}$/.test(id))throw Error('音频ID无效');const m=jsonRead(path.join(dir,'generated',id+'.json'),null);if(!m)throw Error('音频不存在');return {bytes:fs.readFileSync(path.join(libraryDir(),'tts-generated',id+'.'+m.ext)),mime:m.ext==='wav'?'audio/wav':'audio/mpeg'}}
 function check(){const s=read(),warnings=[];if(s.endpoint.endsWith('completionsts'))warnings.push('接口路径与官方chat/completions不同，请确认');if(!key())warnings.push('未填写密钥；匿名本地服务可忽略此项');const errors=[];if(s.outputVoice==='feiyu-rvc'&&!feiyuStatus(root).ready)errors.push('肥鱼本机引擎配置不可用');try{prepare('接口检查用文本')}catch(e){errors.push(redact(e.message))}return {ok:!errors.length,localOnly:true,errors,warnings,hasApiKey:!!key(),endpoint:s.endpoint,model:s.model,kind:profile().kind}}
 return {view,read,profile,save,saveRaw,templates,cloneUpload,prepare,synthesize,audio,models,check,redact};
}
export function strictBase64(s){if(typeof s!=='string'||!s.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(s)||s.length%4!==0)throw Error('Base64格式无效');const b=Buffer.from(s,'base64');if(b.toString('base64')!==s)throw Error('Base64编码不规范');return b}
export function audioFormat(b){if(b.length>12&&b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WAVE')return 'wav';if(b.length>3&&(b.subarray(0,3).toString()==='ID3'||b[0]===0xff&&(b[1]&0xe0)===0xe0))return 'mp3';return null}
