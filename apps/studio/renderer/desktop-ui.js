'use strict';
const desktop=window.studioDesktop;
if(desktop){
 const badge=document.createElement('div');badge.className='desktop-banner';badge.textContent='桌面工作室 · 资料自动保存 · 最小化继续运行 · 退出会停止声音与动作';document.querySelector('main').prepend(badge);
 async function transfer(kind){
  if(busy){notice('正在保存，请稍后再操作。');return;}
  if(profileDirty){notice('请先保存角色修改，再导入或导出资料。',true);return;}
  if(['import','recover'].includes(kind)&&running()){notice('请先结束本场，再导入资料。',true);return;}
  try{const result=await (kind==='import'?desktop.importWorkspace():kind==='recover'?desktop.recover():desktop.exportWorkspace());if(!result.cancelled)notice(kind==='import'?'资料已完整导入。':kind==='recover'?'资料已从备份恢复。':'完整资料已导出。自动备份也保存在软件资料目录中。');}catch(e){notice(e.message,true);}
 }
 $('exportAll').onclick=()=>transfer('export');
 const old=$('importAll').parentElement,nativeImport=document.createElement('button');nativeImport.className='ghost';nativeImport.textContent='导入资料';nativeImport.onclick=()=>transfer('import');old.replaceWith(nativeImport);
 desktop.onCommand(command=>{if(command==='stop')stopAudio('已停止声音与动作');else if(['import','export','recover'].includes(command))void transfer(command);});
 desktop.onSuspend(()=>{lastPublicJson='';paused=!!running();stopAudio('电脑进入睡眠，演练已暂停；唤醒后请主动恢复。');if(db)renderStage();});
 desktop.onResume(async()=>{
  lastPublicJson='';paused=!!running();stopAudio('电脑已唤醒；演练保持暂停，请主动恢复。');
  if(!await ensureLease()||!db)return;
  document.querySelectorAll('button,input,select,textarea').forEach(e=>e.disabled=false);
  // Refresh stage controls without rebuilding character or memory editors:
  // their unsaved values and draft object must survive a sleep/wake cycle.
  renderStage();renderCast();renderRoster();
  $('voice_pitch').disabled=(voiceBus.capabilitiesFor?.(draft)||voiceBus.capabilities)?.pitch===false;
  $('localVoice').disabled=!!running()?.participant_ids.includes(draft?.character_id);
  window.StudioVoiceStudio?.refresh();syncPublic();
 });
 desktop.onPrepareClose(async({force})=>{
  if(profileDirty&&!force)return {ready:false,reason:'unsaved'};
  const deadline=Date.now()+4500;while(busy&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
  if(busy)return {ready:false,reason:'资料仍在保存，请稍候再退出。'};
  stopAudio('正在退出，已停止声音与动作');
  await voiceBus._cancelBarrier.catch(()=>{});
  const owner=leaseOwner;leaseValid=false;
  try{await fetch('/api/release',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner}),signal:AbortSignal.timeout(1000)});}catch{}
  return {ready:true};
 });
}
