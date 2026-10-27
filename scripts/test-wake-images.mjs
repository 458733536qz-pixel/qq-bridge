import {test} from 'node:test';import assert from 'node:assert/strict';import {bridgeHarness} from './audit-bridge-harness.mjs';
const PNG=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001','hex');
for(const enabled of [true,false])test(`wake attaches only current offered conversation images; enabled=${enabled}`,async()=>{
 const h=await bridgeHarness({config:{socialV2:{context:{inlineWakeMessages:true,inlineWakeImages:enabled},wake:{maxWakePerMinute:0,maxWakePerHour:0},proactive:{enabled:false},sticker:{enabled:false}}},globals:{safeFetchBuffer:async()=>({buffer:PNG,mimeType:'image/png'})}});
 try{h.setMode('reserved2');h.appendSocialV2Message('group:456','user','看这张图','看这张图',false,false,'fixture-img',[{kind:'image',url:'https://public.invalid/current.png'}],'789',[]);
 h.appendSocialV2Message('private:123','owner','其他会话','其他会话',false,true,'other-img',[{kind:'image',url:'https://public.invalid/other.png'}],'123',[]);
 await h.sendWakePromptV2('group:456','question');const prompt=h.calls.prompts.at(-1);assert.ok(prompt);const images=prompt.content.filter(p=>p.type==='image');assert.equal(images.length,enabled?1:0);if(enabled){assert.equal(images[0].data,PNG.toString('base64'));assert.ok(prompt.content[0].text.includes('fixture-img'));assert.ok(!prompt.content[0].text.includes('other-img'));}
 }finally{await h.close()}
});
