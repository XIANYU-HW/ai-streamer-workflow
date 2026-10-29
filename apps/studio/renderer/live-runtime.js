(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.StudioLiveRuntime=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const copy=v=>JSON.parse(JSON.stringify(v));
 const freeze=v=>{if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
 const id=v=>typeof v==='string'&&v.length>0&&v.length<=180&&/^[A-Za-z0-9_.:-]+$/.test(v);
 const terminal=new Set(['completed','failed','cancelled','paused','blocked']);
 class RuntimeRenderer{
  constructor({desktop,player,getState,onContext,now=()=>Date.now(),monotonic=()=>performance.now(),timers={setTimeout:(...args)=>setTimeout(...args),clearTimeout:token=>clearTimeout(token)}}={}){
   if(!desktop||!player||typeof player.speak!=='function'||typeof player.stop!=='function')throw new Error('Runtime renderer requires the existing player.');
   this.desktop=desktop;this.player=player;this.getState=getState||(()=>({ready:false,editor_lease:''}));this.onContext=onContext||(()=>{});this.now=now;this.monotonic=monotonic;this.timers=timers;
   this.ready=false;this.context=null;this.active=null;this.stoppedGeneration=null;this.closed=false;this.lastAck=0;this.owner='';this.serial=0;this.heartbeatSerial=0;this.revoked=new Map();this.seen=new Set();this.poll=null;this.stopping=0;
  }
  _state(){try{return this.getState()||{};}catch{return {};}}
  _available(){const s=this._state();return !this.closed&&!this.stopping&&this.ready&&s.ready===true&&!!s.editor_lease&&s.editor_lease===this.owner&&this.monotonic()-this.lastAck<=2500;}
  _notify(context,idle=false){try{this.onContext(context,idle);}catch{}}
  _retire(context){if(!context)return;this.revoked.set(context.session_id,Math.max(this.revoked.get(context.session_id)||0,context.generation));/* A session id cannot be reused after eviction. */if(this.revoked.size>256){this.closed=true;this.ready=false;}}
  _clear(reason,forceStop=false,retireGeneration=true){
   const ownsContext=!!(this.context||this.active),ownsPlayer=forceStop||ownsContext||!!this.stopping;
   const context=this.context;if(retireGeneration){this._retire(context);this._retire(this.stoppedGeneration);this.stoppedGeneration=null;}this.serial++;this.active=null;this.context=null;
   // Invalidate first. Synchronous audio callbacks during stop cannot revive the
   // old caption, portrait or motion after its generation was retired.
   // An idle runtime does not own the shared player's manual preview or caption.
   if(ownsPlayer)this.player.stop(reason);
   if(ownsContext)this._notify(null);
  }
  async _sendReceipt(command,status,reason){
   if(!id(command?.dispatch_id)||!id(command?.session_id)||!Number.isSafeInteger(command.generation))return;
   try{await this.desktop.runtimeReceipt({dispatch_id:command.dispatch_id,session_id:command.session_id,generation:command.generation,status,reason:String(reason||status).slice(0,80)});}catch{if(this.context?.dispatch_id===command.dispatch_id){this.ready=false;this._clear('运行时回执失联，停止声音');}}
  }
  async heartbeat(){
   if(this.closed)return false;const ticket=++this.heartbeatSerial,s=this._state();
   if(s.ready!==true||!s.editor_lease){this.ready=false;if(this.context){this._clear('运行时编辑连接失效');try{await this.desktop.runtimeCancel({reason:'renderer_unavailable'});}catch{}}}
   let timer;
   try{
    const response=await Promise.race([Promise.resolve().then(()=>this.desktop.runtimeReady({ready:s.ready===true,editor_lease:s.editor_lease||''})),new Promise((_,reject)=>timer=this.timers.setTimeout(()=>reject(new Error('timeout')),2000))]);
    if(this.closed||ticket!==this.heartbeatSerial)return false;
    const current=this._state();this.ready=s.ready===true&&current.ready===true&&s.editor_lease===current.editor_lease&&response?.ok===true&&response.armed!==false;
    if(this.ready){this.lastAck=this.monotonic();this.owner=s.editor_lease;}else if(this.context)this._clear('运行时未获播放许可');
    return this.ready;
   }catch{
    if(ticket===this.heartbeatSerial&&!this.closed){this.ready=false;this._clear('运行时连接失效，停止声音');try{await this.desktop.runtimeCancel({reason:'renderer_heartbeat_failed'});}catch{}}
    return false;
   }finally{this.timers.clearTimeout(timer);}
  }
  start(){
   if(this.closed||this.poll!==null)return;
   this.desktop.onRuntimeCommand(command=>{void this.command(command);});
   const tick=async()=>{await this.heartbeat();if(!this.closed)this.poll=this.timers.setTimeout(tick,1000);};void tick();
  }
  _validate(command){
   if(!id(command.dispatch_id)||!id(command.session_id)||!id(command.role_id)||!Number.isSafeInteger(command.generation)||command.generation<1||!Number.isFinite(command.deadline_at)||command.deadline_at<=this.now())return false;
   if(!Number.isFinite(command.start_budget_ms)||command.start_budget_ms<=0||command.start_budget_ms>15000)return false;
   if(typeof command.text!=='string'||!command.text.trim()||command.text.length>280||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command.text))return false;
   const c=command.character,cast=command.character_snapshots,scene=command.scene_snapshot;
   if(!c||!id(c.character_id)||!Number.isSafeInteger(c.revision)||!c.voice||!id(c.voice.profile_id)||!Array.isArray(cast)||cast.length<1||cast.length>4||!scene||!Array.isArray(scene.cast_ids))return false;
   if(new Set(cast.map(c=>c.character_id)).size!==cast.length||cast.some(c=>!scene.cast_ids.includes(c.character_id)))return false;
   const own=cast.find(x=>x.character_id===c.character_id);return !!own&&JSON.stringify(own)===JSON.stringify(c);
  }
  async command(command){
   if(!command||typeof command!=='object')return;
   if(command.type==='stop'){
    const target=command.target;
    if(target!==undefined){
     const valid=target&&typeof target==='object'&&!Array.isArray(target)&&Object.keys(target).length===3&&Object.keys(target).every(k=>['session_id','generation','utterance_id'].includes(k))&&id(target.session_id)&&id(target.utterance_id)&&Number.isSafeInteger(target.generation)&&target.generation>0;
     const matches=context=>!context||['session_id','generation','utterance_id'].every(k=>context[k]===target[k]);
     if(!valid||!matches(this.context)||!matches(this.active?.context)){
      if(id(command.stop_id))try{await this.desktop.runtimeStopped({stop_id:command.stop_id,stopped:false});}catch{this.ready=false;}
      return;
     }
     this.stoppedGeneration={session_id:target.session_id,generation:target.generation};
    }
    // A confirmed stop of one answer does not revoke its entire session. The
    // dispatch serial/seen guards still prevent old callbacks from restarting it.
    this._clear('运行时已停止',false,target===undefined);this.stopping++;let stopped=true;
    try{await this.player._cancelBarrier;}catch{stopped=false;this.ready=false;}finally{this.stopping--;}
    if(!this._available())this.ready=false;
    if(id(command.stop_id))try{await this.desktop.runtimeStopped({stop_id:command.stop_id,stopped});}catch{this.ready=false;}
    return;
   }
   if(command.type!=='play')return;
   const receivedMono=this.monotonic();
   if(!this._available()||!this._validate(command)||command.generation<=(this.revoked.get(command.session_id)||0)||this.seen.has(command.dispatch_id))return this._sendReceipt(command,'blocked','stale_or_unavailable');
   if(this.active)return this._sendReceipt(command,'blocked','player_busy');
   if(this.context&&(this.context.session_id!==command.session_id||this.context.generation!==command.generation))this._retire(this.context);
   let captured;try{captured=freeze(copy(command));}catch{return this._sendReceipt(command,'blocked','invalid_snapshot');}
   const audioSession='runtime:'+captured.session_id+':'+captured.generation+':'+captured.dispatch_id;
   const context=freeze({...captured,audio_session_id:audioSession});const record={serial:++this.serial,command:captured,context,startDeadline:receivedMono+captured.start_budget_ms};
   this.seen.add(command.dispatch_id);if(this.seen.size>10000){this.closed=true;this.ready=false;return this._sendReceipt(command,'blocked','renderer_dispatch_limit');}
   this.context=context;this.active=record;this._notify(context);
   try{
    const receipt=await this.player.speak(context.character,context.text,{sessionId:audioSession,preview:false});
    if(this.active!==record||record.serial!==this.serial)return;
    this.active=null;const status=terminal.has(receipt?.status)?receipt.status:'failed';this._notify(context,true);
    await this._sendReceipt(captured,status,typeof receipt?.reason==='string'&&/^[a-z_]{1,80}$/.test(receipt.reason)?receipt.reason:status);
   }catch{
    if(this.active!==record)return;this.active=null;this._notify(context,true);await this._sendReceipt(captured,'failed','player_failed');
   }
  }
  _startAllowed(){const a=this.active;return !!a&&(a.started||this.now()<a.context.deadline_at&&this.monotonic()<a.startDeadline);}
  canPlay(snapshot){const c=this.active?.context;return !!c&&this._available()&&this._startAllowed()&&snapshot?.session_id===c.audio_session_id&&snapshot.character_id===c.character.character_id&&snapshot.character_revision===c.character.revision&&snapshot.profile_id===c.character.voice.profile_id;}
  acceptsEvent(event){const c=this.active?.context;return !!c&&this._available()&&event?.session_id===c.audio_session_id&&event.character_id===c.character.character_id;}
  audioStatus(event){
   if(!this.acceptsEvent(event))return;const status=event.status==='speaking'?'speaking':event.status==='requested'&&event.reason==='buffering'?'buffering':null;
   if(status==='speaking'&&!this._startAllowed())return;
   if(!status||this.active.lastStatus===status)return;if(status==='speaking')this.active.started=true;this.active.lastStatus=status;void this._sendReceipt(this.active.command,status,status==='speaking'?'playing':'buffering');
  }
  isRuntimeEvent(event){return typeof event?.session_id==='string'&&event.session_id.startsWith('runtime:');}
  async manualStop(reason='manual_control'){
   this.ready=false;this.heartbeatSerial++;this._clear(reason,true);
   try{await this.desktop.runtimeCancel({reason:'manual_control'});}catch{/* Remain unarmed; next accepted heartbeat cannot restore a retired generation. */}
  }
  async close(){
   if(this.closed)return;this.closed=true;this.ready=false;this.heartbeatSerial++;this.timers.clearTimeout(this.poll);this.poll=null;this._clear('运行时播放器关闭');
   try{await this.desktop.runtimeCancel({reason:'renderer_closed'});}catch{}
  }
 }
 return Object.freeze({RuntimeRenderer});
});
