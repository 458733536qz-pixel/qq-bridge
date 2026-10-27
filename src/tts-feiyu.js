// Local, administrator-installed Feiyu RVC; the AI cannot supply commands or paths.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile);
function config(root){
 const p=path.join(root,'state/tts/feiyu-runtime.json');
 const c=JSON.parse(fs.readFileSync(p,'utf8'));
 for(const k of ['python','worker','package','profile'])if(typeof c[k]!=='string'||!path.isAbsolute(c[k])||!fs.existsSync(c[k]))throw Error('肥鱼本机引擎配置不可用');
 if(!/^[a-f0-9]{64}$/.test(c.modelSha256))throw Error('肥鱼模型校验信息缺失');
 return c;
}
export function feiyuStatus(root){try{config(root);return {ready:true,engine:'feiyu-rvc',label:'肥鱼 RVC v1 · 本机 CPU'}}catch{return {ready:false,engine:'feiyu-rvc'}}}
export async function convertFeiyu({root,bytes}){
 const c=config(root),id=crypto.randomUUID(),dir=path.join(root,'state/tts/rvc-jobs',id);
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const input=path.join(dir,'input.audio'),out=path.join(dir,'result');
 fs.writeFileSync(input,bytes,{mode:0o600});const start=Date.now();
 try{
  await run(c.python,[c.worker,'--kind','rvc','--package',c.package,'--profile',c.profile,'--input',input,'--output-dir',out],{timeout:240000,maxBuffer:4*1024*1024,env:{...process.env,PATH:'/opt/homebrew/bin:'+process.env.PATH,PYTHONDONTWRITEBYTECODE:'1',FEIYU_FORCE_CPU:'1'}});
  const receipt=JSON.parse(fs.readFileSync(path.join(out,'cover_result.json'),'utf8'));
  const audio=fs.readFileSync(path.join(out,'rvc_native.wav'));
  const digest=crypto.createHash('sha256').update(audio).digest('hex');
  if(receipt.status!=='success'||receipt.model_sha256!==c.modelSha256||receipt.native_sha256!==digest||receipt.sample_rate!==40000||!receipt.actual_model_loads?.length||!receipt.actual_synth_calls?.length)throw Error('肥鱼模型转换回执校验失败');
  receipt.elapsedMs=Date.now()-start;
  fs.writeFileSync(path.join(dir,'conversion.json'),JSON.stringify(receipt,null,2),{mode:0o600});
  return {bytes:audio,receipt};
 }catch(e){
  // Keep local diagnostics, never send provider credentials or process environment to the client.
  fs.writeFileSync(path.join(dir,'error.log'),String(e.stderr||e.message||e).slice(-20000),{mode:0o600});
  throw Error(e.killed?'肥鱼换声超过4分钟，已停止；未发送原音色替代':'肥鱼本机换声失败；未发送原音色替代，请查看本机转换日志');
 }finally{fs.rmSync(input,{force:true})}
}
