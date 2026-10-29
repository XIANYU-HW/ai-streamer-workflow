'use strict';
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const terminal=new Set(['completed','failed','cancelled','paused','blocked']);
const states=new Set([...terminal,'speaking','buffering']);
const reasons=new Set(['ended','playing','buffering','stopped','cancelled','native_pause','native_mute','playback_failed','playback_timeout','playback_context_changed','expired','renderer_unavailable']);
const error=message=>Object.assign(new Error(message),{code:'RENDERER_UNAVAILABLE',status:503});
function stopTarget(value){
 if(value===null)return null;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3||!Object.keys(value).every(k=>['session_id','generation','utterance_id'].includes(k))||!['session_id','utterance_id'].every(k=>typeof value[k]==='string'&&/^[A-Za-z0-9_.:-]{1,180}$/.test(value[k]))||!Number.isSafeInteger(value.generation)||value.generation<1)throw error('Invalid stop target');
 return Object.freeze({session_id:value.session_id,generation:value.generation,utterance_id:value.utterance_id});
}
const sameTarget=(a,b)=>a===b||!!a&&!!b&&a.session_id===b.session_id&&a.generation===b.generation&&a.utterance_id===b.utterance_id;
const terminationReasons=new Set(['clean-exit','abnormal-exit','killed','crashed','oom','launch-failed','integrity-failure','memory-eviction']);
function rendererIdentity(value){
 if(!value||Object.keys(value).length!==3||!['web_contents_id','process_id'].every(k=>Number.isSafeInteger(value[k])&&value[k]>0)||typeof value.incarnation_id!=='string'||!/^[a-f0-9-]{36}$/.test(value.incarnation_id))throw error('Invalid renderer identity');
 return Object.freeze({web_contents_id:value.web_contents_id,process_id:value.process_id,incarnation_id:value.incarnation_id});
}
const sameIdentity=(a,b)=>!!a&&!!b&&a.web_contents_id===b.web_contents_id&&a.process_id===b.process_id&&a.incarnation_id===b.incarnation_id;
class RuntimeBridge{
 constructor({send,cancelSpeech,isEditorLease,now=()=>Date.now(),monotonic=()=>performance.now(),heartbeatMs=2500,stopTimeoutMs=6000,playTimeoutMs=90000,minStartBudgetMs=2000}){
  if(!Number.isFinite(minStartBudgetMs)||minStartBudgetMs<0||minStartBudgetMs>15000)throw error('Invalid start budget');
  Object.assign(this,{send,cancelSpeech,isEditorLease,now,monotonic,heartbeatMs,stopTimeoutMs,playTimeoutMs,minStartBudgetMs});
  this.runtime=null;this.armed=false;this.lastBeat=0;this.editorLease='';this.pending=null;this.stopWait=null;this.stopTask=null;this.stopTarget=null;this.stopFault=false;this.playbackStatus='idle';this.lastError=null;this.closed=false;
  this.rendererIdentity=null;this.termination=null;this.terminationHistory=[];this.lastStop=null;this.cleanStopRequired=false;this.cleanStopAttempted=false;this.replacementBlocked=false;
  this.timer=setInterval(()=>this.sweep(),250);this.timer.unref?.();
 }
 attach(runtime){this.runtime=runtime;}
 // These identity methods are called only by the main process's native lifecycle
 // handlers, never by renderer IPC or the producer/control HTTP capabilities.
 observeRenderer(value){
  const identity=rendererIdentity(value);
  if(sameIdentity(identity,this.rendererIdentity))return true;
  if(this.rendererIdentity&&!this._terminationFor(this.rendererIdentity)){this.replacementBlocked=true;this.disarm();return false;}
  if(this.rendererIdentity){this.cleanStopRequired=true;this.cleanStopAttempted=false;}
  this.rendererIdentity=identity;this.replacementBlocked=false;return true;
 }
 _terminationFor(identity){return this.terminationHistory.find(t=>sameIdentity(t.identity,identity))||null;}
 rendererGone(value){
  if(!value||Object.keys(value).length!==3||!terminationReasons.has(value.reason)||!Number.isSafeInteger(value.exit_code)||!sameIdentity(value.identity,this.rendererIdentity))return false;
  if(this._terminationFor(value.identity))return false;
  const termination={identity:this.rendererIdentity,reason:value.reason,exit_code:value.exit_code,observed_at:this.now(),backend_cancelled:false};
  this.termination=termination;this.terminationHistory.push(termination);
  // Never discard unresolved proof while a later cancellation is outstanding.
  if(this.terminationHistory.length>16)this.terminationHistory=this.terminationHistory.filter(t=>!t.backend_cancelled||t===termination);
  this.stopWait?.confirmTermination?.();this.disarm();return true;
 }
 async _boundedCancel(){
  let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(error('Backend cancellation unconfirmed')),this.stopTimeoutMs);});
  try{const result=await Promise.race([Promise.resolve().then(()=>this.cancelSpeech()),timeout]);if(result?.cancelled!==true)throw error('Backend cancellation unconfirmed');return true;}
  finally{clearTimeout(timer);}
 }
 _confirmBackendTermination(){for(const t of this.terminationHistory)t.backend_cancelled=true;}
 _prepareReplacement(){
  if(this.cleanStopAttempted||this.replacementBlocked||!this.cleanStopRequired)return;
  this.cleanStopAttempted=true;
  const identity=this.rendererIdentity;
  this.cleanStopTask=(async()=>{
   // Settlement of the predecessor task is only ordering, never stop evidence.
   // Its rejected result still needs the independent checks below.
   const predecessor=this.stopTask;if(predecessor)await Promise.allSettled([predecessor]);
   // Close the old native-termination evidence first. A clean acknowledgement
   // from the new renderer cannot retroactively prove that its predecessor died.
   if(this.terminationHistory.some(t=>!t.backend_cancelled)){await this._boundedCancel();this._confirmBackendTermination();}
   const concurrent=this.stopTask;if(concurrent)await Promise.allSettled([concurrent]);
   if(this.stopTask||!sameIdentity(identity,this.rendererIdentity)||this._terminationFor(identity))throw error('Renderer changed during recovery');
   const receipt=await this.stop('renderer_unavailable');
   if(receipt.method!=='renderer_stop_ack'||!sameIdentity(identity,this.rendererIdentity)||this._terminationFor(identity))throw error('New renderer stop unconfirmed');
   this.cleanStopRequired=false;
  })().catch(()=>{this.stopFault=true;this.lastError='playback_failed';this.disarm();});
 }

 _readiness(value){if(this.armed===value)return this.readinessTask||Promise.resolve();this.armed=value;try{this.readinessTask=Promise.resolve(this.runtime?.setRendererReady(value)).catch(()=>{this.lastError='playback_failed';throw error('Renderer stop unconfirmed');});}catch{this.readinessTask=Promise.reject(error('Renderer stop unconfirmed'));}this.readinessTask.catch(()=>{});return this.readinessTask;}
 ready(value){
  if(!value||typeof value.ready!=='boolean'||typeof value.editor_lease!=='string'||Object.keys(value).some(k=>!['ready','editor_lease'].includes(k)))return {ok:false,armed:false};
  const editorValid=!this.closed&&value.ready&&this.isEditorLease(value.editor_lease)===true;
  if(editorValid&&this.cleanStopRequired)this._prepareReplacement();
  const valid=editorValid&&!!this.rendererIdentity&&!this.replacementBlocked&&!this.cleanStopRequired&&!this.stopFault&&!this._terminationFor(this.rendererIdentity);
  this.lastBeat=valid?this.monotonic():0;this.editorLease=valid?value.editor_lease:'';this._readiness(valid);return {ok:true,armed:valid};
 }
 disarm(){this.lastBeat=0;this.editorLease='';return this._readiness(false);}
 sweep(){if(this.armed&&(this.monotonic()-this.lastBeat>this.heartbeatMs||!this.isEditorLease(this.editorLease)))this.disarm();}
 status(){this.sweep();const p=this.pending?.job;return {ready:this.armed,playback_status:this.playbackStatus,active:p?{dispatch_id:p.dispatch_id,session_id:p.session_id,generation:p.generation,role_id:p.role_id,character_id:p.character.character_id}:null,last_error:this.lastError,renderer_identity:this.rendererIdentity,termination:this.termination?{...this.termination,identity:{...this.termination.identity}}:null,clean_stop_required:this.cleanStopRequired,last_stop:this.lastStop};}
 async play(job){
  this.sweep();if(this.pending||this.stopTask)throw error('Renderer busy');
  if(!this.armed||this.closed||this.stopFault)throw error('Renderer unavailable');
  if(!job||typeof job.dispatch_id!=='string'||typeof job.session_id!=='string'||!Number.isSafeInteger(job.generation))throw error('Renderer unavailable');
  const remaining=Math.min(job.deadline_at-this.now(),job.deadline_monotonic-this.monotonic());
  if(!Number.isFinite(remaining)||remaining>15000)throw error('Renderer unavailable');
  // Reject stale content before IPC or synthesis. This does not diagnose a dead renderer.
  if(remaining<=0||remaining<this.minStartBudgetMs)return {dispatch_id:job.dispatch_id,session_id:job.session_id,generation:job.generation,status:'failed',reason:'expired',not_dispatched:true};
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{if(this.pending?.job.dispatch_id===job.dispatch_id){this._finish({status:'failed',reason:'playback_timeout'});this.disarm();}},this.playTimeoutMs);timer.unref?.();
   const startTimer=setTimeout(()=>this._expireStart(job.dispatch_id),remaining);startTimer.unref?.();
   this.pending={job,resolve,reject,timer,startTimer,started:false};this.playbackStatus='dispatched';this.lastError=null;
   // Monotonic absolute timestamps belong to this process. The renderer receives
   // only a duration, while this independent timer also covers IPC transit time.
   const {deadline_monotonic,...command}=job;
   try{if(this.send({type:'play',...command,start_budget_ms:remaining})===false)throw error('Renderer unavailable');}catch{clearTimeout(timer);clearTimeout(startTimer);this.pending=null;this.disarm();reject(error('Renderer unavailable'));}
  });
 }
 _expireStart(dispatch){if(!this.pending||this.pending.job.dispatch_id!==dispatch||this.pending.started)return;const {session_id,generation,utterance_id}=this.pending.job;this._finish({status:'failed',reason:'expired'});void this.stop('expired',{session_id,generation,utterance_id}).catch(()=>{});}
 _finish(receipt){const p=this.pending;if(!p)return;clearTimeout(p.timer);clearTimeout(p.startTimer);this.pending=null;this.playbackStatus=receipt.status;if(receipt.status==='failed'||receipt.status==='blocked')this.lastError=receipt.reason;p.resolve({dispatch_id:p.job.dispatch_id,session_id:p.job.session_id,generation:p.job.generation,...receipt});}
 receipt(value){
  const p=this.pending?.job;if(!p||!value||Object.keys(value).some(k=>!['dispatch_id','session_id','generation','status','reason'].includes(k))||value.dispatch_id!==p.dispatch_id||value.session_id!==p.session_id||value.generation!==p.generation||!states.has(value.status))return {accepted:false};
  if(value.status==='speaking'&&!this.pending.started){if(this.now()>=p.deadline_at||this.monotonic()>=p.deadline_monotonic){this._expireStart(p.dispatch_id);return {accepted:false};}this.pending.started=true;clearTimeout(this.pending.startTimer);}
  const reason=reasons.has(value.reason)?value.reason:(value.status==='completed'?'ended':'playback_failed');
  this.playbackStatus=value.status;if(terminal.has(value.status))this._finish({status:value.status,reason});return {accepted:true};
 }
 stopped(value){if(!this.stopWait||!value||Object.keys(value).some(k=>!['stop_id','stopped'].includes(k))||value.stop_id!==this.stopWait.id||typeof value.stopped!=='boolean')return {accepted:false};this.stopWait.finish(value.stopped);return {accepted:true};}
 stop(reason='cancelled',target=null){
  target=stopTarget(target);
  // A disarm caused by a failed stop must reuse that failure, not silently retry it.
  if(this.stopTask&&(this.stopFault||this.stopTarget===null||sameTarget(this.stopTarget,target)))return this.stopTask;
  if(this.pending&&target&&!sameTarget(this.pending.job,target))return Promise.reject(error('Stop target mismatch'));
  this._finish({status:'cancelled',reason:'cancelled'});
  const previous=this.stopTask;
  // A later lifecycle stop is stronger than an utterance stop: send and acknowledge
  // it separately after the previous stop, while keeping all new plays blocked.
  const task=previous?previous.then(()=>this._performStop(reason,target)):this._performStop(reason,target);
  this.stopTask=task;this.stopTarget=target;
  task.finally(()=>{if(this.stopTask===task){this.stopTask=null;this.stopTarget=null;}}).catch(()=>{});return task;
 }
 _performStop(reason,target){
  const id=crypto.randomUUID(),identity=this.rendererIdentity;let timer,method='unconfirmed';
  const ack=new Promise((resolve,reject)=>{
   const finish=(ok,evidence='unconfirmed')=>{clearTimeout(timer);if(this.stopWait?.id===id)this.stopWait=null;if(ok){method=evidence;resolve();}else reject(error('Renderer stop unconfirmed'));};
   const confirmTermination=()=>{if(!this._terminationFor(identity))return false;finish(true,'renderer_process_terminated');return true;};
   this.stopWait={id,finish:ok=>finish(ok,ok?'renderer_stop_ack':'unconfirmed'),confirmTermination};timer=setTimeout(()=>finish(false),this.stopTimeoutMs);
   // A missing IPC target is never an acknowledgement. Only an exact native
   // termination event can substitute independent process-stop evidence.
   if(confirmTermination())return;
   try{if(this.send({type:'stop',stop_id:id,reason:reasons.has(reason)?reason:'cancelled',...(target?{target}:{})})===false)finish(false);}catch{finish(false);}
  });
  return Promise.allSettled([ack,this._boundedCancel()]).then(results=>{
   const backend=results[1].status==='fulfilled',confirmed=backend&&results[0].status==='fulfilled';
   if(backend)this._confirmBackendTermination();
   this.lastStop=Object.freeze({stop_id:id,method,confirmed,backend_cancelled:backend,renderer_identity:identity,at:this.now()});
   if(!confirmed){this.stopFault=true;this.lastError='playback_failed';this.disarm();throw error('Renderer stop unconfirmed');}
   this.stopFault=false;this.playbackStatus='idle';return {stopped:true,method};
  });
 }
 async close(){this.closed=true;clearInterval(this.timer);this.disarm();if(this.pending||this.stopTask)await this.stop('cancelled');}
}
module.exports={RuntimeBridge};
