import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {compactSharedMemory,compactCrossLog} from '../src/prompt-context.js';import {buildStickerStrategyHint,buildStickerContext} from '../src/sticker-lib.js';import {bridgeHarness} from './audit-bridge-harness.mjs';
const old='- 2026-08-01 [QQ] 水杉计划：约好每周三晨跑，碰到下雨就改成室内拉伸。';
const recent=Array.from({length:80},(_,i)=>`- 2026-10-27 [QQ] 新近记录${i}：今天买了编号${i}的书，晚上再看。`);
const memory='# 共同记忆\n\n## 长期事实\n- 他叫小球，我们喜欢互相分享日常。\n\n## 记忆流\n'+old+'\n'+recent.join('\n');
test('recalls a specific fact older than 30 days directly from the full original memory',()=>{const s=compactSharedMemory(memory,{cue:'你还记得八月那个水杉计划周三晨跑吗'});assert.ok(s.includes('水杉计划：约好每周三晨跑'));assert.ok(s.includes('新近记录79'));assert.ok(s.length<=1100);});
test('vague remember prompts do not inject an arbitrary old event',()=>{const s=compactSharedMemory(memory,{cue:'你还记得吗'});assert.ok(!s.includes('水杉计划'));assert.ok(s.includes('新近记录79'));});
test('English cues match case-insensitively and long old facts expose the matching excerpt',()=>{const m='# 记忆\n## 旧事\n- '+ '无关叙述'.repeat(80)+' Artemis 计划约好周五出发。\n\n## 最近\n'+recent.join('\n');const s=compactSharedMemory(m,{cue:'还记得 ARTEMIS 吗'});assert.ok(s.includes('Artemis 计划约好周五出发'));});
test('memory budgets are hard limits and the thematic summary stays below 200 chars',()=>{for(const maxChars of [0,50,200,600,1100,1200]){const s=compactSharedMemory(memory,{cue:'水杉计划',maxChars});assert.ok(s.length<=maxChars);assert.ok(s.split('\n')[0].length<=200);}assert.equal(compactSharedMemory(''),'');});
test('cross-platform compaction keeps chronological order, explicit speakers, dates and platform switches',()=>{const log='- 10-26 23:59 [QQ] 我：晚安\n- 10-27 08:00 [B站私信] 他：早上好\n- 10-27 08:02 [B站私信] 我：今天晨跑吗\n- 10-27 08:04 [QQ] 他：已经出门了';const s=compactCrossLog(log);assert.equal(s.split('10-27').length-1,1);assert.ok(s.includes('[B站私信] 08:00 他：早上好 / 08:02 我：今天晨跑吗'));assert.ok(s.indexOf('23:59')<s.indexOf('08:00'));assert.ok(s.includes('[QQ] 08:04 他：已经出门了'));});
test('long logs remain within budget with explicit truncation and no partial URL',()=>{const log=Array.from({length:12},(_,i)=>`- 10-27 10:${String(i).padStart(2,'0')} [${i%2?'QQ':'B站私信'}] 我：`+'很长的原文'.repeat(25)+' https://example.com/a?secret=fixture').join('\n');const s=compactCrossLog(log);assert.ok(s.length<=250);assert.ok(s.includes('10:11'));assert.ok(s.includes('…'));assert.ok(!s.includes('https:'));});
test('sticker strategy retains eight rules and 12 selectable stickers',()=>{const s=buildStickerStrategyHint();assert.ok(s.length<=350);for(const label of ['时机','回图','斗图','频率','选图','发送','学习','禁止'])assert.ok(s.includes(label+'：'));assert.ok(s.includes('不能在同一气泡里附带文字'));for(const name of ['qq_send_sticker','qq_get_sticker_image','qq_sticker_note','qq_collect_sticker'])assert.ok(s.includes(name));const entries=Array.from({length:14},(_,i)=>({id:String(i),desc:'测试贴纸'+i}));const list=buildStickerContext(entries,12);for(let i=0;i<12;i++)assert.ok(list.includes('测试贴纸'+i));assert.ok(!list.includes('测试贴纸12'));});
test('real wake builder recalls old shared facts without cold archive and does not write the original source',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-context-home-'));const dir=path.join(home,'.bili-ai');fs.mkdirSync(dir);const source=path.join(dir,'memory.md');fs.writeFileSync(source,memory);fs.writeFileSync(path.join(dir,'cross-log.md'),'- 10-27 08:00 [QQ] 我：去晨跑了');
 const h=await bridgeHarness({globals:{os:{...os,homedir:()=>home},recallByCue:()=>({text:'',hits:0})}});
 try{h.setMode('reserved2');h.appendSocialV2Message('private:123','小球','你还记得水杉计划吗','你还记得水杉计划吗',false,true,'old-fact',[],'123',[]);const s=h.buildWakePromptV2('private:123','private');assert.ok(s.includes('水杉计划：约好每周三晨跑'));assert.equal(fs.readFileSync(source,'utf8'),memory);const start=s.indexOf('【你和球球的共同记忆】');const end=s.indexOf('想记住新东西就用 qq_memory_append，会自动同步进这份记忆。',start)+'想记住新东西就用 qq_memory_append，会自动同步进这份记忆。'.length;assert.ok(end-start<=1200);}
 finally{await h.close();fs.rmSync(home,{recursive:true,force:true});}
});

test('default bridge fixture confines shared-home writes to its temporary directory',async()=>{
 const attempts=[];const protectedRoot=path.join(os.homedir(),'.bili-ai')+path.sep;
 const guardedFs={...fs,writeFileSync:(file,...args)=>{if(String(file).startsWith(protectedRoot)){attempts.push(String(file));throw Error('fixture may not write real companion data');}return fs.writeFileSync(file,...args);},appendFileSync:(file,...args)=>{if(String(file).startsWith(protectedRoot)){attempts.push(String(file));throw Error('fixture may not append real companion data');}return fs.appendFileSync(file,...args);}};
 const h=await bridgeHarness({globals:{fs:guardedFs}});
 try{h.appendCrossLog('QQ','fixture shared-home check');assert.equal(attempts.length,0);assert.ok(fs.readFileSync(path.join(h.temp,'.bili-ai/cross-log.md'),'utf8').includes('fixture shared-home check'));}
 finally{await h.close()}
});

test('a repeated two-character place cue still retrieves its original facts',()=>{
 const source='# 记忆\n## 旧事\n'+Array.from({length:5},(_,i)=>`- 2026-08-0${i+1} 杭州那次约好了去湖边走走。`).join('\n')+'\n## 最近\n'+recent.join('\n');
 const s=compactSharedMemory(source,{cue:'你还记得杭州吗'});assert.ok(s.includes('杭州那次约好了去湖边走走'));
});
