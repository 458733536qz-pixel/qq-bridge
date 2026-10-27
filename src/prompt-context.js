// Read-only, deterministic prompt views. The original memories/logs stay intact.
const clip=(text,n)=>n<=0?'':text.length<=n?text:text.slice(0,Math.max(0,n-1))+'…';
const clean=text=>String(text||'').replace(/\s+/g,' ').trim();
function memoryEntries(text){
 const entries=[],topics=[];let section='',current=null;
 const flush=()=>{if(current?.text)entries.push(current);current=null};
 for(const raw of String(text||'').split(/\r?\n/)){
  const line=raw.trim();
  if(/^#+\s/.test(line)){flush();section=line.replace(/^#+\s*/, '');if(/^##\s/.test(line))topics.push(section);continue;}
  if(!line||line.startsWith('>')){flush();continue;}
  if(/^[-*]\s|^\d+[.、)]\s*/.test(line)){flush();current={section,text:line.replace(/^[-*]\s*/, '')};}
  else if(current)current.text+=' '+line;
  else current={section,text:line};
 }
 flush();return {entries,topics};
}
function cueTerms(cue){
 const query=String(cue||'').toLowerCase().replace(/你还记得|还记得|你记得|以前|之前|那时候|上次|那个|这个|什么|事情|说过|我的|我们|你们|是不是/g,' ');
 const terms=new Set(query.match(/[a-z][a-z0-9_-]{2,30}/g)||[]);
 const stop=new Set(['记得','以前','之前','那个','这个','什么','事情','时候','说过','喜欢','知道','今天','一下','说的','的事','记忆','回忆','东西']);
 for(const chunk of query.match(/[\u4e00-\u9fff]{2,}/g)||[])
  for(let n=2;n<=Math.min(4,chunk.length);n++)for(let i=0;i+n<=chunk.length;i++){const t=chunk.slice(i,i+n);if(!stop.has(t))terms.add(t);}
 return [...terms].sort((a,b)=>b.length-a.length).slice(0,160);
}
function excerpt(text,terms,max){
 if(text.length<=max)return text;
 const term=terms.filter(t=>text.toLowerCase().includes(t)).sort((a,b)=>b.length-a.length)[0];
 if(!term)return clip(text,max);
 const at=text.toLowerCase().indexOf(term),start=Math.max(0,at-40);
 return clip((start?'…':'')+text.slice(start),max);
}
export function compactSharedMemory(text,{cue='',maxChars=1100,recentLimit=12}={}){
 const max=Math.max(0,Math.min(1200,Math.floor(maxChars)));if(!max||!String(text||'').trim())return '';
 const {entries,topics}=memoryEntries(text),terms=cueTerms(cue);
 const lower=entries.map(e=>e.text.toLowerCase());
 const frequency=new Map(terms.map(t=>[t,lower.reduce((n,line)=>n+(line.includes(t)?1:0),0)]));
 const scored=entries.map((entry,index)=>{
  const hits=terms.filter(t=>lower[index].includes(t));
  const score=hits.reduce((s,t)=>s+t.length*t.length/(1+frequency.get(t)),0);
  return {...entry,index,score};
 }).filter(e=>e.score>0).sort((a,b)=>b.score-a.score||b.index-a.index);
 const used=new Set();let output=clip('主题摘要：'+(topics.length?[...new Set(topics)].join('、'):'共同经历与长期事实')+'；旧事按本句线索找原文。',180);
 const append=(label,list,budget)=>{
  const lines=[];let remaining=Math.min(budget,max-output.length-label.length-2);
  for(const e of list){if(used.has(e.index)||remaining<30)continue;const line='- '+excerpt(e.text,terms,Math.min(200,remaining-1));if(line.length+1>remaining)continue;lines.push(line);used.add(e.index);remaining-=line.length+1;}
  if(lines.length)output+='\n'+label+'\n'+lines.join('\n');
 };
 append('线索命中的原记忆：',scored.slice(0,3),430);
 append('长期要点：',entries.map((e,index)=>({...e,index})).filter(e=>/长期事实/.test(e.section)).slice(0,2),190);
 // Newest first for selection; render chronologically after the budget is assigned.
 const recent=entries.map((e,index)=>({...e,index})).slice(-Math.max(1,recentLimit)).filter(e=>!used.has(e.index));
 const label='最近记录：';let remaining=max-output.length-label.length-2,lines=[];
 for(const e of recent.reverse()){
  if(remaining<30)break;const line='- '+clip(e.text,Math.min(160,remaining-1));if(line.length+1<=remaining){lines.unshift(line);remaining-=line.length+1;}
 }
 if(lines.length)output+='\n'+label+'\n'+lines.join('\n');
 return clip(output,max);
}
export function compactCrossLog(text,{limit=12,maxChars=250}={}){
 const max=Math.max(0,Math.floor(maxChars));if(!max)return '';
 const rows=String(text||'').split(/\r?\n/).filter(l=>l.trim()).slice(-limit).map(line=>{
  const m=line.match(/^\s*-?\s*(\d{2}-\d{2})\s+(\d{2}:\d{2})\s+\[([^\]]+)\]\s*(.*)$/);
  return m?{day:m[1],time:m[2],source:m[3],body:m[4]}:{raw:clean(line)};
 });
 const body=(value,n)=>clip(clean(value).replace(/https?:\/\/[^\s]+/g,url=>{const bv=url.match(/BV[A-Za-z0-9]+/);return bv?'[视频:'+bv[0]+']':'[链接]';}),n);
 const render=(list,n)=>{
  const lines=[];let day='',source='';
  for(const row of list){
   if(row.raw){lines.push(body(row.raw,n));source='';continue;}
   if(row.day!==day){lines.push(row.day);day=row.day;source='';}
   const item=row.time+' '+body(row.body,n);
   if(source===row.source)lines[lines.length-1]+=' / '+item;
   else{lines.push('['+row.source+'] '+item);source=row.source;}
  }
  return lines.join('\n');
 };
 let width=32,result=render(rows,width);
 while(result.length>max&&width>12){width-=4;result=render(rows,width);}
 let omitted=0;
 while(result.length>max&&rows.length>1){rows.shift();omitted++;result='…略前'+omitted+'条\n'+render(rows,width);}
 return clip(result,max);
}
