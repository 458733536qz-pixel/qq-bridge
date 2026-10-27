/* TTS page. Templates retain their original UTF-8 bytes until explicitly edited. */
(() => {
 const $=id=>document.getElementById(id),drafts=new Map();let currentModel='',snapshot=null,busy=false,objectUrl=null;
 const fields={kind:'ttsKind',voice:'ttsVoice',prompt:'ttsPrompt',cloneId:'ttsCloneId',responsePath:'ttsResponsePath'};
 const message=(text,error=false)=>{$('ttsMessage').textContent=text;$('ttsMessage').className='meta '+(error?'err':'ok')};
 async function call(route,method='GET',body){const r=await api('/api/tts/'+route,method,body);if(r.ok===false)throw Error(r.error || (r.errors||[]).join('；') || '操作失败');return r}
 function rawPart(part){const node=$('ttsRaw'+(part==='headers'?'Headers':'Body'));const original=snapshot?.templates?.[part];return original&&node.value===original.raw.replace(/\r\n|\r/g,'\n')?{base64:original.base64}:{raw:node.value}}
 function remember(){if(!currentModel||!snapshot)return;drafts.set(currentModel,{snapshot,profile:Object.fromEntries(Object.entries(fields).map(([k,id])=>[k,$(id).value])),headers:$('ttsRawHeaders').value,body:$('ttsRawBody').value})}
 function renderKind(){const raw=$('ttsKind').value==='design'||$('ttsProtocol').value==='custom';$('ttsRawPanel').hidden=!raw;$('ttsPresetPanel').hidden=raw||$('ttsKind').value!=='preset';$('ttsClonePanel').hidden=$('ttsKind').value!=='clone';$('ttsSing').disabled=!($('ttsProtocol').value==='mimo'&&currentModel==='mimo-v2.5-tts'&&$('ttsKind').value==='preset');if($('ttsSing').disabled)$('ttsSing').checked=false;}
 function renderVoices(voices){const selected=$('ttsVoice').value;const node=$('ttsOfficialVoices');node.replaceChildren();for(const v of voices||[]){const row=document.createElement('div');row.className='tts-voice-row';const b=document.createElement('button');b.type='button';b.textContent='使用 '+v.label;b.addEventListener('click',()=>{$('ttsVoice').value=v.id;message('已选择 '+v.label+'，点“保存配置”生效')});row.append(b);if(v.sampleUrl){const audio=document.createElement('audio');audio.controls=true;audio.preload='none';audio.src=v.sampleUrl;audio.setAttribute('aria-label',v.label+'官方试听');row.append(audio)}else{const n=document.createElement('span');n.className='meta';n.textContent='无独立官方样音，可用下方试合成';row.append(n)}node.append(row)}$('ttsVoice').value=selected;}
 function addModel(id){const select=$('ttsModels');if(![...select.options].some(o=>o.value===id))select.add(new Option(id,id));select.value=id;}
 async function loadModel(model,{initial=false}={}){
  if(!initial)remember();const r=await call('settings'+(model?'?model='+encodeURIComponent(model):''));snapshot=r;currentModel=r.selectedModel;addModel(currentModel);$('ttsModelId').value=currentModel;
  if(initial){$('ttsEndpoint').value=r.endpoint;$('ttsModelsEndpoint').value=r.modelsEndpoint;$('ttsProtocol').value=r.protocol;$('ttsEnabled').checked=r.enabled;$('ttsAiEnabled').checked=r.aiEnabled;$('ttsMaxChars').value=r.maxChars;$('ttsOutputVoice').value=r.outputVoice||'source';$('ttsOutputVoice').querySelector('[value="feiyu-rvc"]').disabled=!r.feiyu?.ready;$('ttsFeiyuState').textContent=r.feiyu?.ready?'肥鱼模型已安装。先合成语气，再在本机换声；耗时比原音色长。':'肥鱼本机引擎未就绪';$('ttsKeyState').textContent=r.hasApiKey?'密钥已保存；留空表示保留原密钥':'尚未填写密钥';for(const id of r.knownModels||[])addModel(id);$('ttsModels').value=currentModel;}
  for(const [k,id]of Object.entries(fields))$(id).value=r.profile[k]||'';
  $('ttsRawHeaders').value=r.templates.headers.raw;$('ttsRawBody').value=r.templates.body.raw;
  for(const part of ['headers','body'])$('tts'+(part==='headers'?'Headers':'Body')+'Info').textContent=`当前原文：${r.templates[part].bytes} 字节 · SHA256 ${r.templates[part].sha256}`;
  const draft=drafts.get(currentModel);if(draft){snapshot=draft.snapshot;for(const [k,id]of Object.entries(fields))$(id).value=draft.profile[k];$('ttsRawHeaders').value=draft.headers;$('ttsRawBody').value=draft.body;}
  $('ttsEndpointWarning').textContent=r.endpointWarning||'';renderVoices(r.voices);renderKind();
 }
 async function saveSettings(){
  const input={outputVoice:$('ttsOutputVoice').value,endpoint:$('ttsEndpoint').value,modelsEndpoint:$('ttsModelsEndpoint').value,protocol:$('ttsProtocol').value,model:currentModel,enabled:$('ttsEnabled').checked,aiEnabled:$('ttsAiEnabled').checked,maxChars:Number($('ttsMaxChars').value),profile:Object.fromEntries(Object.entries(fields).map(([k,id])=>[k,$(id).value]))};
  if($('ttsApiKey').value)input.apiKey=$('ttsApiKey').value;
  const r=await call('settings','POST',input);$('ttsApiKey').value='';$('ttsKeyState').textContent=r.hasApiKey?'密钥已保存；留空表示保留原密钥':'尚未填写密钥';$('ttsEndpointWarning').textContent=r.endpointWarning||'';renderVoices(r.voices);return r;
 }
 async function savePart(part){const r=await call('template','POST',{model:currentModel,part,...rawPart(part)});snapshot.templates[part]=r;$('tts'+(part==='headers'?'Headers':'Body')+'Info').textContent=`已按原文字节保存：${r.bytes} 字节 · SHA256 ${r.sha256}`;remember();message((part==='headers'?'请求头':'请求体')+'已独立保存，未改动另一模块');}
 const run=fn=>async()=>{if(busy)return;busy=true;document.querySelectorAll('#section-tts button').forEach(b=>b.disabled=true);message('处理中…');try{await fn()}catch(e){message(e.message,true)}finally{busy=false;document.querySelectorAll('#section-tts button').forEach(b=>b.disabled=false)}};
 $('ttsModels').addEventListener('change',run(async()=>{await loadModel($('ttsModels').value);message('模型选项已切换；各模型的原文分别保存')}));
 $('ttsUseModel').addEventListener('click',run(async()=>{await loadModel($('ttsModelId').value.trim());message('已切换到填写的模型')}));
 $('ttsNaturalVoice').addEventListener('click',()=>{
  const breath='【自然气息示例】保持当前角色语感与音色。清晰轻声，短暂停顿和少量自然换气；只按文字标签演绎叹气、轻笑，不念标签，不全程耳语、不夸张喘息。';
  if(!$('ttsPrompt').value.includes('【自然气息示例】'))$('ttsPrompt').value=[$('ttsPrompt').value.trim(),breath].filter(Boolean).join('\n');
  $('ttsTestText').value='（温柔，慵懒）[叹气]球球……在呢。[短暂停顿]今天有点累。[轻笑]不过，还是想听你说说话。';
  $('ttsSing').checked=false;message('已保留现有角色描述，并补入气息指导与表演标签。请用下方“保存配置并试合成”，官方固定样音不会改变。');
 });
 document.querySelectorAll('[data-tts-tag]').forEach(button=>button.addEventListener('click',()=>{const input=$('ttsTestText');input.setRangeText(button.dataset.ttsTag,input.selectionStart,input.selectionEnd,'end');input.focus();message('已插入'+button.dataset.ttsTag+'；点击试合成听实际效果。')}));
 $('ttsKind').addEventListener('change',renderKind);$('ttsProtocol').addEventListener('change',()=>{renderKind();message('协议已切换。按供应商填写完整接口和模型列表地址后保存。')});
 $('ttsOfficialEndpoint').addEventListener('click',()=>{$('ttsEndpoint').value='https://api.xiaomimimo.com/v1/chat/completions';$('ttsModelsEndpoint').value='https://api.xiaomimimo.com/v1/models';$('ttsEndpointWarning').textContent='已填写官方地址，保存后生效。'});
 $('ttsSave').addEventListener('click',run(async()=>{await saveSettings();message('配置已保存；请求头、请求体请分别点击各自的保存按钮')}));
 $('ttsSaveHeaders').addEventListener('click',run(()=>savePart('headers')));$('ttsSaveBody').addEventListener('click',run(()=>savePart('body')));
 $('ttsFetchModels').addEventListener('click',run(async()=>{await saveSettings();const r=await call('models','POST',{});const select=$('ttsModels');select.replaceChildren();for(const x of r.models)addModel(x.id);addModel(currentModel);message(`已从接口获取 ${r.models.length} 个模型；列表包含非语音模型，请选择TTS模型。`)}));
 $('ttsCheck').addEventListener('click',run(async()=>{await saveSettings();const r=await api('/api/tts/check','POST',{});message((r.ok?'本地检查通过':'检查未通过')+'；'+[...(r.errors||[]),...(r.warnings||[])].join('；')+'（此操作不调用合成接口）',!r.ok)}));
 $('ttsCloneUpload').addEventListener('click',run(async()=>{const f=$('ttsCloneFile').files[0];if(!f)throw Error('请先选择WAV或MP3参考音频');if(f.size>7.5*1024*1024)throw Error('参考音频过大，Base64编码后需小于10MB');const b64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(f)});const r=await call('clone','POST',{name:f.name,base64:b64});$('ttsCloneId').value=r.id;$('ttsCloneInfo').textContent=`已上传 ${r.name}（${r.bytes}字节），参考ID ${r.id}`;message('参考音频已存本机，保存配置后可合成克隆语音。')}));
 $('ttsSynthesize').addEventListener('click',run(async()=>{await saveSettings();const r=await call('synthesize','POST',{text:$('ttsTestText').value,sing:$('ttsSing').checked});const token=localStorage.getItem('consoleToken')||'';const response=await fetch('/api/tts/audio/'+r.id,{headers:{'x-console-token':token}});if(!response.ok)throw Error('合成完成，但获取试听音频失败');const blob=await response.blob();if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=URL.createObjectURL(blob);$('ttsPlayer').src=objectUrl;$('ttsPlayer').hidden=false;$('ttsAudioInfo').textContent=`已合成 ${r.bytes} 字节 · ${r.outputVoice==='feiyu-rvc'?'肥鱼 RVC':'接口原音色'}，已加入QQ语音库。此处只试听，不发送QQ。`;message('合成成功，点击播放器试听')}));
 window.loadTtsConfig=async()=>{if(snapshot)return;try{await loadModel('',{initial:true});message('已加载保存的配置')}catch(e){message(e.message,true)}};
 if(location.hash==='#tts')window.loadTtsConfig();
})();
