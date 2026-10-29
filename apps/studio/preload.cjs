'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const invoke=async(channel,...args)=>{try{return await ipcRenderer.invoke(channel,...args);}catch(e){throw new Error(String(e?.message||'操作未完成，请稍后再试。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'').slice(0,600));}};
contextBridge.exposeInMainWorld('studioDesktop',Object.freeze({
 version:'0.1.0',platform:process.platform,background:true,
 runtimeReady:value=>invoke('runtime:ready',value),runtimeReceipt:value=>invoke('runtime:receipt',value),
 runtimeStopped:value=>invoke('runtime:stopped',value),runtimeCancel:value=>invoke('runtime:cancel',value),runtimeStatus:()=>invoke('runtime:status'),
 onRuntimeCommand:callback=>ipcRenderer.on('runtime:command',(_event,value)=>callback(value)),
 recordVoiceReceipt:value=>invoke('voice:receipt',value),voiceMeasurements:()=>invoke('voice:measurements'),
 voiceStatus:()=>invoke('voice:status'),getSpendingPolicy:()=>invoke('voice:spending-policy'),setSpendingPolicy:value=>invoke('voice:set-spending-policy',value),saveVoiceKey:key=>invoke('voice:save-key',key),
 useVoiceSessionKey:key=>invoke('voice:use-session-key',key),clearVoiceSessionKey:()=>invoke('voice:clear-session-key'),
 voiceCandidates:()=>invoke('voice:candidates'),voicePreview:id=>invoke('voice:preview',id),
 voiceSystemOptions:()=>invoke('voice:system-options'),
 designVoice:request=>invoke('voice:design',request),cancelVoice:()=>invoke('voice:cancel'),
 load:()=>invoke('workspace:load'),save:(data,revision)=>invoke('workspace:save',data,revision),
 importWorkspace:()=>invoke('workspace:import'),exportWorkspace:()=>invoke('workspace:export'),
 startFresh:()=>invoke('workspace:fresh'),getInfo:()=>invoke('desktop:info'),
 getVoiceBindings:()=>invoke('desktop:voice-bindings'),bindVoice:(profile,id)=>invoke('desktop:bind-voice',profile,id),
 showDataDirectory:()=>invoke('desktop:show-data'),recover:()=>invoke('workspace:recover'),
 onPrepareClose:callback=>{ipcRenderer.on('desktop:prepare-close',async(_event,message)=>{let result;try{result=await callback(message);}catch{result={ready:false,reason:'保存状态未能确认'};}ipcRenderer.send('desktop:close-result',{id:message.id,...result});});},
 onSuspend:callback=>ipcRenderer.on('desktop:suspend',()=>callback()),
 onResume:callback=>ipcRenderer.on('desktop:resume',()=>callback()),
 onCommand:callback=>ipcRenderer.on('desktop:command',(_event,command)=>callback(command))
}));
