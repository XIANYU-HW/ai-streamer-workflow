'use strict';
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');

const ERRORS=Object.freeze({
 INVALID_REQUEST:[400,'运行请求格式无效。'],CLOSED:[503,'运行接口已关闭。'],
 LEASE_BUSY:[409,'发声控制权已被占用。'],LEASE_INVALID:[409,'发声控制租约已失效。'],
 STALE_GENERATION:[409,'此轮消息已失效，请使用新的会话代次。'],SESSION_NOT_READY:[409,'运行会话尚未就绪。'],
 ROLE_NOT_FOUND:[404,'本场没有指定岗位。'],SCENE_NOT_FOUND:[404,'指定舞台不存在。'],
 CHARACTER_NOT_FOUND:[404,'指定角色不存在。'],VOICE_NOT_READY:[409,'角色尚未保存正式音色。'],
 QUEUE_FULL:[429,'待播短句已满，请稍后提交新的有效事件。'],BUSY:[409,'上一条回答尚未结束。'],DEADLINE_EXPIRED:[409,'这条短句已过期。'],PERSONA_MISMATCH:[409,'角色版本与本场固定资料不一致。'],
 DUPLICATE_CONFLICT:[409,'相同事件标识对应了不同内容。'],UTTERANCE_NOT_FOUND:[404,'本场没有指定的连续发言。'],
 HISTORY_FULL:[429,'本场事件记录已满，请建立新的会话代次。'],STOP_UNCONFIRMED:[503,'尚未确认旧声音已停止。'],
 RENDERER_UNAVAILABLE:[503,'工作室播放器尚未就绪。'],WORKSPACE_UNAVAILABLE:[503,'角色资料暂时无法读取。'],
 PLAYBACK_FAILED:[502,'播放器未能完成这条短句。']
});
function error(code){const [status,message]=ERRORS[code]||ERRORS.INVALID_REQUEST;return Object.assign(new Error(message),{code:Object.hasOwn(ERRORS,code)?code:'INVALID_REQUEST',status});}
function exact(value,fields){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw error('INVALID_REQUEST');
 const keys=Reflect.ownKeys(value),allowed=fields.split(' ');
 if(keys.length!==allowed.length||!keys.every(k=>typeof k==='string'&&allowed.includes(k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value')))throw error('INVALID_REQUEST');
}
function id(value,max=128){if(typeof value!=='string'||value.length>max||!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value))throw error('INVALID_REQUEST');}
function integer(value,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)throw error('INVALID_REQUEST');}
function clone(value){return JSON.parse(JSON.stringify(value));}
function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;}
const CONTEXT='lease_id session_id generation';
const MESSAGE=CONTEXT+' role_id persona_revision source_event_id received_at deadline_at priority text segment_index final';
const terminalStatuses=new Set(['completed','failed','blocked','cancelled','paused','stopped']);

/** One bounded voice owner. This class never reads credentials, writes a library,
 * creates a model reply or synthesizes speech itself. play/stop are the only
 * injected output boundary and stop's acknowledgement is mandatory. */
class LiveRuntime{
 constructor({getWorkspace,play,stop,now=()=>Date.now(),monotonic=()=>performance.now()}={}){
  if(typeof getWorkspace!=='function'||typeof play!=='function'||typeof stop!=='function'||typeof now!=='function'||typeof monotonic!=='function')throw error('INVALID_REQUEST');
  this._getWorkspace=getWorkspace;this._play=play;this._stop=stop;this._nowSource=now;this._lastNow=0;this._monoSource=monotonic;this._lastMono=0;
  this._lease=null;this._session=null;this._pendingSession=null;this._highestGeneration=new Map();
  this._queue=[];this._active=null;this._events=new Map();this._utterance=null;this._pendingStops=new Map();this._receipts=[];this._sequence=0;
  this._epoch=0;this._rendererReady=false;this._closed=false;this._blocked=false;this._lastError=null;
  this._barrier=Promise.resolve();this._pumping=false;
  this._sweep=setInterval(()=>{this._expire();this._expireAnswer();},100);this._sweep.unref?.();
 }
 _now(){const value=this._nowSource();if(!Number.isFinite(value)||value<0)throw error('INVALID_REQUEST');this._lastNow=Math.max(this._lastNow,value);return this._lastNow;}
 _mono(){const value=this._monoSource();if(!Number.isFinite(value)||value<0)throw error('INVALID_REQUEST');this._lastMono=Math.max(this._lastMono,value);return this._lastMono;}
 _open(){if(this._closed)throw error('CLOSED');}
 _setError(code){this._lastError=freeze({code});}
 _hasContext(){return !!(this._session||this._pendingSession||this._active||this._queue.length||this._utterance||this._pendingStops.size||this._blocked);}
 _receipt(answer,status,reason){
  const receipt=freeze({session_id:answer.session_id,generation:answer.generation,role_id:answer.role_id,source_event_id:answer.source_event_id,utterance_id:answer.utterance_id,persona_revision:answer.persona_revision,status,reason,final_segment_index:answer.final_segment_index??null,completed_segments:answer.completed_segments||0});
  const prior=this._receipts.find(r=>r.utterance_id===receipt.utterance_id&&r.session_id===receipt.session_id&&r.generation===receipt.generation&&r.role_id===receipt.role_id&&r.source_event_id===receipt.source_event_id&&r.status===status&&r.reason===reason&&r.completed_segments===receipt.completed_segments);
  if(prior)return prior;this._receipts.push(receipt);if(this._receipts.length>64)this._receipts.shift();return receipt;
 }
 _rejection(request,code){
  // A rejected continuation is not a terminal receipt for an accepted answer.
  // Otherwise a bad segment could incorrectly release an adapter's inflight slot.
  try{
   id(request.session_id);integer(request.generation,1,Number.MAX_SAFE_INTEGER);id(request.role_id,64);id(request.source_event_id);integer(request.persona_revision,1,Number.MAX_SAFE_INTEGER);
   const accepted=[...this._events.values()].some(v=>v.receipt.session_id===request.session_id&&v.receipt.generation===request.generation&&v.receipt.role_id===request.role_id&&v.receipt.source_event_id===request.source_event_id);
   if(accepted)return;
   this._receipt({...request,utterance_id:null,final_segment_index:request.final===true?0:null,completed_segments:0},'rejected',Object.hasOwn(ERRORS,code)?code:'INVALID_REQUEST');
  }catch{}
 }
 _captureStop(answer,reason){
  if(!answer)return;
  if(!this._pendingStops.has(answer.utterance_id))this._pendingStops.set(answer.utterance_id,{answer,reason});
 }
 _expire(){
  if(this._closed)return;
  if(this._lease&&(this._lease.expires_at<=this._now()||this._lease.expires_monotonic<=this._mono())){
   const physical=this._hasContext();this._lease=null;this._setError('LEASE_INVALID');this._invalidate('LEASE_INVALID',physical).catch(()=>{});
  }
 }
 _invalidate(reason,physical=true){
  ++this._epoch;this._captureStop(this._utterance,reason);this._session=null;this._pendingSession=null;this._queue=[];this._active=null;this._events.clear();this._utterance=null;
  return this._stopBarrier(reason,physical);
 }
 _stopBarrier(reason,physical,target=null){
  const epoch=this._epoch,entries=[...this._pendingStops.values()];
  let stopped;if(physical){try{stopped=Promise.resolve(this._stop(reason,target));}catch{stopped=Promise.reject(error('STOP_UNCONFIRMED'));}}
  // Begin the physical stop immediately, then await both it and any preceding
  // cancellation. A failed previous stop can only be recovered by a new explicit
  // lifecycle operation whose stop acknowledgement succeeds.
  const previous=this._barrier;
  const barrier=(physical?Promise.all([previous.catch(()=>{}),stopped]):previous).then(()=>{
   const receipts=[];for(const entry of entries){receipts.push(this._receipt(entry.answer,'cancel_ack',entry.reason));if(this._pendingStops.get(entry.answer.utterance_id)===entry)this._pendingStops.delete(entry.answer.utterance_id);}
   if(epoch===this._epoch)this._blocked=false;
   return receipts;
  },()=>{
   for(const entry of entries)this._receipt(entry.answer,'unknown','STOP_UNCONFIRMED');
   if(epoch===this._epoch){this._blocked=true;this._setError('STOP_UNCONFIRMED');this._queue=[];this._active=null;this._session=null;this._pendingSession=null;}
   throw error('STOP_UNCONFIRMED');
  });
  this._barrier=barrier;barrier.catch(()=>{});return barrier;
 }
 _stopAnswer(reason,physical=true){
  if(!this._utterance)return this._barrier;
  const {session_id,generation,utterance_id}=this._utterance,target=freeze({session_id,generation,utterance_id});
  this._captureStop(this._utterance,reason);this._utterance=null;this._queue=[];this._active=null;
  return this._stopBarrier(reason,physical,target);
 }
 _expireAnswer(){
  const answer=this._utterance;
  // The original deadline is the latest start of any segment. A segment already
  // playing may finish, but an unfinished answer cannot wait forever for append.
  if(answer&&(answer.deadline_at<=this._now()||answer.deadline_monotonic<=this._mono())&&!this._active){
   // A first segment still queued has never owned renderer audio. A waiting
   // continuation can own prior audio and still requires a physical stop.
   const firstQueued=this._queue.some(job=>job.utterance_id===answer.utterance_id&&job.segment_index===0);
   this._stopAnswer('DEADLINE_EXPIRED',!firstQueued).catch(()=>{});
  }
 }
 _leaseFor(value){this._open();this._expire();id(value);if(!this._lease||value!==this._lease.lease_id)throw error('LEASE_INVALID');return this._lease;}
 _context(value){id(value.session_id);integer(value.generation,1,Number.MAX_SAFE_INTEGER);this._leaseFor(value.lease_id);}
 _assertSession(value){
  this._open();this._expire();id(value.session_id);integer(value.generation,1,Number.MAX_SAFE_INTEGER);
  if(this._blocked)throw error('STOP_UNCONFIRMED');
  if(!this._session){if((this._highestGeneration.get(value.session_id)||0)>=value.generation)throw error('STALE_GENERATION');throw error('SESSION_NOT_READY');}
  if(value.session_id!==this._session.session_id||value.generation!==this._session.generation)throw error('STALE_GENERATION');
  return this._session;
 }
 acquireLease(request){
  exact(request,'owner ttl_ms');id(request.owner,64);integer(request.ttl_ms,1000,8000);this._open();this._expire();
  if(this._lease)throw error('LEASE_BUSY');
  const lease={lease_id:crypto.randomUUID(),owner:request.owner,expires_at:this._now()+request.ttl_ms,expires_monotonic:this._mono()+request.ttl_ms};this._lease=lease;
  return freeze({lease_id:lease.lease_id,owner:lease.owner,expires_at:lease.expires_at,ttl_ms:request.ttl_ms});
 }
 renewLease(request){
  exact(request,CONTEXT+' ttl_ms');this._context(request);integer(request.ttl_ms,1000,8000);this._assertSession(request);
  this._lease.expires_at=this._now()+request.ttl_ms;this._lease.expires_monotonic=this._mono()+request.ttl_ms;return freeze({lease_id:this._lease.lease_id,expires_at:this._lease.expires_at,session_id:request.session_id,generation:request.generation});
 }
 async openSession(request){
  exact(request,CONTEXT+' scene_id roles mode');this._context(request);id(request.scene_id);
  if(request.mode!=='simulation'||!Array.isArray(request.roles)||request.roles.length<1||request.roles.length>4)throw error('INVALID_REQUEST');
  for(const role of request.roles){exact(role,'role_id character_id');id(role.role_id,64);id(role.character_id);}
  request=clone(request);const roles=request.roles;
  if(new Set(roles.map(r=>r.role_id)).size!==roles.length||new Set(roles.map(r=>r.character_id)).size!==roles.length)throw error('INVALID_REQUEST');
  if((this._highestGeneration.get(request.session_id)||0)>=request.generation)throw error('STALE_GENERATION');
  if(!this._highestGeneration.has(request.session_id)&&this._highestGeneration.size>=256)throw error('HISTORY_FULL');
  this._highestGeneration.set(request.session_id,request.generation);
  const stopped=this._invalidate('SESSION_REPLACED',this._hasContext()),epoch=this._epoch;
  this._pendingSession={session_id:request.session_id,generation:request.generation};
  let raw;
  try{[raw]=await Promise.all([this._getWorkspace(),stopped]);}catch(cause){if(cause?.code==='STOP_UNCONFIRMED')throw cause;throw error('WORKSPACE_UNAVAILABLE');}
  this._expire();if(this._closed||epoch!==this._epoch)throw error('STALE_GENERATION');this._leaseFor(request.lease_id);
  let workspace;try{workspace=clone(raw?.data||raw);}catch{throw error('WORKSPACE_UNAVAILABLE');}
  if(!workspace||!Array.isArray(workspace.characters)||!Array.isArray(workspace.scenes))throw error('WORKSPACE_UNAVAILABLE');
  const scene=workspace.scenes.find(s=>s.scene_id===request.scene_id);if(!scene)throw error('SCENE_NOT_FOUND');
  const characters=roles.map(role=>{const character=workspace.characters.find(c=>c.character_id===role.character_id);if(!character)throw error('CHARACTER_NOT_FOUND');if(!character.voice?.profile_id||character.voice.service!=='minimax'||!character.voice.voice_id)throw error('VOICE_NOT_READY');return character;});
  if(!Array.isArray(scene.cast_ids)||scene.cast_ids.length!==roles.length||!scene.cast_ids.every(value=>roles.some(r=>r.character_id===value)))throw error('INVALID_REQUEST');
  const session=freeze({session_id:request.session_id,generation:request.generation,scene_id:request.scene_id,mode:'simulation',roles,scene_snapshot:scene,character_snapshots:characters,assets:workspace.assets||{}});
  this._session=session;this._pendingSession=null;this._lastError=null;
  return freeze({session_id:session.session_id,generation:session.generation,scene_id:session.scene_id,roles:roles.map(r=>({...r})),renderer_ready:this._rendererReady});
 }
 _message(request,append){
  exact(request,MESSAGE+(append?' utterance_id':''));this._context(request);const session=this._assertSession(request);
  if(!this._rendererReady)throw error('RENDERER_UNAVAILABLE');
  id(request.role_id,64);id(request.source_event_id);integer(request.persona_revision,1,Number.MAX_SAFE_INTEGER);integer(request.segment_index,append?1:0,append?7:0);if(typeof request.final!=='boolean')throw error('INVALID_REQUEST');
  integer(request.received_at,0,Number.MAX_SAFE_INTEGER);integer(request.deadline_at,0,Number.MAX_SAFE_INTEGER);integer(request.priority,0,100);
  const now=this._now();
  if(typeof request.text!=='string'||!request.text.trim()||request.text.length>280||/[\u0000-\u001f\u007f]/.test(request.text)||/(?:api[_ -]?key|access[_ -]?token|authorization)\s*[:=]|Bearer\s+[A-Za-z0-9._-]{12,}|sk-[A-Za-z0-9_-]{16,}/i.test(request.text))throw error('INVALID_REQUEST');
  const role=session.roles.find(r=>r.role_id===request.role_id);if(!role)throw error('ROLE_NOT_FOUND');
  const character=session.character_snapshots.find(c=>c.character_id===role.character_id);if(request.persona_revision!==character.revision)throw error('PERSONA_MISMATCH');
  if(append)id(request.utterance_id);
  const key=JSON.stringify([role.role_id,request.source_event_id,request.segment_index]);
  const digest=crypto.createHash('sha256').update(JSON.stringify({session_id:request.session_id,generation:request.generation,role_id:role.role_id,persona_revision:request.persona_revision,text:request.text,received_at:request.received_at,deadline_at:request.deadline_at,priority:request.priority,segment_index:request.segment_index,final:request.final,utterance_id:append?request.utterance_id:null})).digest('hex');
  const prior=this._events.get(key);if(prior){if(prior.digest!==digest)throw error('DUPLICATE_CONFLICT');return freeze({...prior.receipt,duplicate:true});}
  if(request.deadline_at<=now)throw error('DEADLINE_EXPIRED');
  if(request.received_at>now+1000||request.received_at<now-15000||request.deadline_at<=request.received_at||request.deadline_at>request.received_at+15000||request.deadline_at>now+15000)throw error('INVALID_REQUEST');
  this._expireAnswer();if(this._pendingStops.size)throw error('BUSY');
  let utterance=this._utterance;
  if(append){
   if(!utterance||utterance.utterance_id!==request.utterance_id)throw error('UTTERANCE_NOT_FOUND');
   if(['role_id','persona_revision','source_event_id','received_at','deadline_at','priority'].some(k=>utterance[k]!==request[k])||utterance.final||request.segment_index!==utterance.next_segment)throw error('INVALID_REQUEST');
  }else if(utterance)throw error('BUSY');
  if(this._queue.length>=2)throw error('QUEUE_FULL');if(this._events.size>=1024)throw error('HISTORY_FULL');
  if(!utterance){utterance={utterance_id:crypto.randomUUID(),session_id:session.session_id,generation:session.generation,role_id:role.role_id,persona_revision:request.persona_revision,source_event_id:request.source_event_id,received_at:request.received_at,deadline_at:request.deadline_at,deadline_monotonic:this._mono()+Math.max(0,request.deadline_at-now),priority:request.priority,next_segment:0,character,final:false,final_segment_index:null,completed_segments:0};this._utterance=utterance;}
  if(utterance.deadline_monotonic<=this._mono())throw error('DEADLINE_EXPIRED');
  utterance.next_segment++;utterance.final=request.final;if(request.final)utterance.final_segment_index=request.segment_index;
  const job=freeze({dispatch_id:crypto.randomUUID(),utterance_id:utterance.utterance_id,segment_index:request.segment_index,final:request.final,persona_revision:request.persona_revision,session_id:session.session_id,generation:session.generation,role_id:role.role_id,source_event_id:request.source_event_id,received_at:request.received_at,deadline_at:request.deadline_at,deadline_monotonic:utterance.deadline_monotonic,priority:request.priority,text:request.text,character:utterance.character,scene_snapshot:session.scene_snapshot,character_snapshots:session.character_snapshots,assets:session.assets,sequence:++this._sequence});
  const receipt=freeze({accepted:true,duplicate:false,dispatch_id:job.dispatch_id,utterance_id:job.utterance_id,segment_index:job.segment_index,final:job.final,session_id:job.session_id,generation:job.generation,role_id:job.role_id,source_event_id:job.source_event_id,persona_revision:job.persona_revision});
  this._events.set(key,{digest,receipt});this._queue.push(job);this._kick();return receipt;
 }
 enqueue(request){try{return this._message(request,false);}catch(cause){this._rejection(request,cause?.code);throw cause;}}
 append(request){return this._message(request,true);}
 _next(){
  this._expireAnswer();return this._queue.shift();
 }
 _kick(){if(!this._pumping)void this._pump();}
 async _pump(){
  if(this._pumping)return;this._pumping=true;const epoch=this._epoch;
  try{
   await this._barrier;this._expire();
   if(this._closed||this._blocked||epoch!==this._epoch||!this._session||!this._rendererReady||this._active)return;
   const job=this._next();if(!job)return;this._active=job;
   Promise.resolve().then(()=>{
    this._expire();if(epoch!==this._epoch||this._active!==job||this._closed||!this._rendererReady)return {status:'cancelled'};
    if(job.deadline_at<=this._now()||job.deadline_monotonic<=this._mono())return {status:'failed',reason:'expired',not_dispatched:true};
    return this._play(job);
   }).then(receipt=>this._finished(job,epoch,receipt),()=>this._finished(job,epoch,{status:'failed'}));
  }catch{if(epoch===this._epoch){this._blocked=true;this._setError('STOP_UNCONFIRMED');}}
  finally{this._pumping=false;if(this._queue.length&&!this._active&&this._session&&this._rendererReady&&!this._blocked&&!this._closed)queueMicrotask(()=>this._kick());}
 }
 _finished(job,epoch,receipt){
  if(this._closed||epoch!==this._epoch||this._active!==job)return;this._active=null;
  if(!receipt||!terminalStatuses.has(receipt.status)||receipt.status!=='completed'){
   const expired=receipt?.status==='failed'&&receipt.reason==='expired',reason=expired?'DEADLINE_EXPIRED':'PLAYBACK_FAILED';
   this._setError(reason);this._stopAnswer(reason,!(expired&&receipt.not_dispatched===true)).catch(()=>{});return;
  }
  const answer=this._utterance;if(!answer||answer.utterance_id!==job.utterance_id)return;
  answer.completed_segments++;
  if(job.final){this._receipt(answer,'end','COMPLETED');this._utterance=null;this._queue=[];return;}
  this._expireAnswer();
  this._kick();
 }
 async cancel(request){
  exact(request,CONTEXT+' reason');this._context(request);id(request.reason,64);
  const current=this._session||this._pendingSession;
  if(!current||current.session_id!==request.session_id||current.generation!==request.generation)throw error('STALE_GENERATION');
  request=clone(request);const answer=this._utterance||this._pendingStops.values().next().value?.answer;const receipts=await this._invalidate('CANCELLED');
  return freeze({cancel_ack:true,cancelled:true,session_id:request.session_id,generation:request.generation,invalidated_generation:request.generation,next_generation:request.generation+1,requires_open:true,utterance_id:answer?.utterance_id||null,receipt:receipts.find(r=>r.utterance_id===answer?.utterance_id)||null});
 }
 invalidate(reason='CANCELLED'){
  id(reason,64);const fixed=['CANCELLED','LEASE_INVALID','RENDERER_UNAVAILABLE','CLOSED','SESSION_REPLACED'].includes(reason)?reason:'CANCELLED';
  return this._invalidate(fixed,this._hasContext());
 }
 setRendererReady(value){
  if(typeof value!=='boolean')throw error('INVALID_REQUEST');if(this._closed)return this._closePromise||Promise.resolve();
  if(this._rendererReady&&!value){const physical=this._hasContext();this._rendererReady=false;this._setError('RENDERER_UNAVAILABLE');return this._invalidate('RENDERER_UNAVAILABLE',physical);}
  this._rendererReady=value;return Promise.resolve();
 }
 status(){
  this._expire();this._expireAnswer();const s=this._session,u=this._utterance||this._pendingStops.values().next().value?.answer;
  const utterance=u?{session_id:u.session_id,generation:u.generation,role_id:u.role_id,source_event_id:u.source_event_id,utterance_id:u.utterance_id,persona_revision:u.persona_revision,received_at:u.received_at,deadline_at:u.deadline_at,priority:u.priority,final:u.final,final_segment_index:u.final_segment_index,accepted_segments:u.next_segment,completed_segments:u.completed_segments,next_segment_index:u.next_segment,status:this._blocked?'unknown':this._pendingStops.has(u.utterance_id)?'cancelling':this._active?'dispatching':this._queue.length?'queued':'awaiting_append'}:null;
  return freeze({schema_version:1,protocol_version:'1.1',lease:this._lease?{owner:this._lease.owner,expires_at:this._lease.expires_at}:null,session:s?{session_id:s.session_id,generation:s.generation,scene_id:s.scene_id,mode:s.mode,roles:s.roles.map(role=>{const c=s.character_snapshots.find(c=>c.character_id===role.character_id);return {...role,name:c.name,revision:c.revision,profile_id:c.voice.profile_id,voice_id:c.voice.voice_id};})}:null,renderer_ready:this._rendererReady,queue_depth:this._queue.length,active:this._active?{dispatch_id:this._active.dispatch_id,utterance_id:this._active.utterance_id,session_id:this._active.session_id,generation:this._active.generation,role_id:this._active.role_id,character_id:this._active.character.character_id,source_event_id:this._active.source_event_id,persona_revision:this._active.persona_revision,segment_index:this._active.segment_index,status:'dispatching'}:null,utterance,receipts:[...this._receipts],last_error:this._lastError,closed:this._closed});
 }
 personas(request){
  exact(request,'session_id generation');const s=this._assertSession(request);
  return freeze({session_id:s.session_id,generation:s.generation,scene_id:s.scene_id,roles:s.roles.map(role=>{const c=s.character_snapshots.find(c=>c.character_id===role.character_id);return clone({role_id:role.role_id,character_id:c.character_id,revision:c.revision,name:c.name,driver:c.driver,backstory:c.backstory,bio:c.bio,address:c.address,traits:c.traits,voice:c.voice});})});
 }
 close(){
  if(this._closePromise)return this._closePromise;const physical=this._hasContext();this._closed=true;clearInterval(this._sweep);this._lease=null;this._rendererReady=false;
  const pending=this._invalidate('CLOSED',physical).catch(cause=>{if(this._closePromise===pending)this._closePromise=null;throw cause;});this._closePromise=pending;return pending;
 }
}
module.exports={LiveRuntime,ERRORS};
