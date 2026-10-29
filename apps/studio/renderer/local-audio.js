(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.StudioLocalAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';
  const REFERENCE = '本机参考试听，非专业音色';
  const VOICE_FIELDS = ['profile_id','provider','service','voice_id','local_voice_id','language','description','style','rate','pitch','volume','stability','similarity','expressiveness','sample'];
  const clamp = n => Math.max(0, Math.min(1, n));
  const finite = (n, lo, hi) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
  const string = value => typeof value === 'string' ? value : '';
  const freeze = value => { if(value && typeof value === 'object' && !Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value; };

  async function decodeOnly(bytes) {
    const Context = root.OfflineAudioContext || root.webkitOfflineAudioContext;
    if (!Context) throw new Error('当前浏览器不能分析本机音频。');
    // Decoding only. The visible HTML media element is the sole playback device.
    const context = new Context(1, 1, 16000);
    return context.decodeAudioData(bytes.slice(0));
  }

  function envelope(buffer) {
    if (!buffer || !finite(buffer.sampleRate,1,384000) || !Number.isInteger(buffer.length) || buffer.length < 1 || !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 32 || typeof buffer.getChannelData !== 'function') throw new Error('PCM 数据无效');
    const channels = Array.from({length:buffer.numberOfChannels},(_,i)=>buffer.getChannelData(i));
    if (channels.some(c=>!c || c.length < buffer.length)) throw new Error('PCM 声道不完整');
    const hop = Math.max(1, Math.round(buffer.sampleRate / 20)), values = new Float32Array(Math.ceil(buffer.length / hop));
    let peak = 0;
    for(let index=0;index<values.length;index++){
      const start=index*hop,end=Math.min(buffer.length,start+hop);let sum=0;
      for(const channel of channels)for(let i=start;i<end;i++){
        const value=channel[i];if(!Number.isFinite(value))throw new Error('PCM 包含非法样本');
        const bounded=Math.max(-1,Math.min(1,value));sum+=bounded*bounded;
      }
      values[index]=Math.sqrt(sum/((end-start)*channels.length));peak=Math.max(peak,values[index]);
    }
    return {values,peak,step:hop/buffer.sampleRate,duration:buffer.length/buffer.sampleRate};
  }

  class LocalAudioBus {
    constructor({audio,onStatus,onFrame,getLeaseOwner,canPlay,fetchImpl,decode,timers,urlFactory}={}) {
      if(!audio || typeof audio.addEventListener!=='function' || typeof audio.play!=='function' || typeof audio.pause!=='function') throw new Error('需要可见的 HTML 音频播放器。');
      this.audio=audio;this.onStatus=typeof onStatus==='function'?onStatus:()=>{};this.onFrame=typeof onFrame==='function'?onFrame:()=>{};
      this.getLeaseOwner=typeof getLeaseOwner==='function'?getLeaseOwner:()=>'';
      this.canPlay=typeof canPlay==='function'?canPlay:()=>true;
      this.fetchImpl=fetchImpl || (typeof root.fetch==='function'?root.fetch.bind(root):null);this.decode=decode || decodeOnly;
      this.timers=timers || {setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id),now:()=>Date.now()};
      this.urls=urlFactory || root.URL;this._voices=[];this._generation=0;this._queueEpoch=0;this._serial=0;this._current=null;this._last=null;this.muted=false;this.engine=null;this.capabilities={};this._cancelBarrier=Promise.resolve();this._cancelRequired=false;this._cancelSerial=0;
    }
    _now(){return typeof this.timers.now==='function'?this.timers.now():Date.now();}
    _capture(character,text,sessionId,preview){
      const c=character && typeof character==='object'?character:{},source=c.voice && typeof c.voice==='object'?c.voice:{},voice={};
      for(const field of VOICE_FIELDS){const value=source[field];voice[field]=typeof value==='string'||typeof value==='number'||value===null?value:null;}
      return freeze({request_id:'local-audio-'+(++this._serial),character_id:string(c.character_id),character_name:string(c.name),character_revision:typeof c.revision==='number'&&Number.isFinite(c.revision)?c.revision:0,
        session_id:string(sessionId),profile_id:string(voice.profile_id),requested_provider:string(voice.provider),preview:preview===true,text:string(text),voice,captured_at:this._now()});
    }
    _event(record,status,reason,message,extra={}){
      const snapshot=record?.snapshot || {request_id:null,character_id:null,session_id:''};
      const prefix=snapshot.requested_provider==='professional_pending'&&snapshot.preview?REFERENCE+' · ':'';
      return freeze({...snapshot,status,reason,message:prefix+message,talking:status==='speaking',audio_verified:false,
        effective_provider:record?.clip?this.engine:null,has_audio:!!record?.clip,professional_parameters_applied:false,
        ...(record?.clip?{duration:record.clip.duration}:{}),...extra});
    }
    _notify(event){try{this.onStatus(event);}catch(_){/* UI failures cannot hold audio or promises open. */}return event;}
    _frame(record,mouth=0,energy=0){try{this.onFrame(freeze({character_id:record?.snapshot.character_id??null,session_id:record?.snapshot.session_id??'',request_id:record?.snapshot.request_id??null,mouth:clamp(mouth),energy:clamp(energy)}));}catch(_){} }
    _valid(record){return this._current===record && record.generation===this._generation;}
    _source(record){const src=this.audio.currentSrc || this.audio.src;return !!record.clip && src===record.clip.url;}
    _record(snapshot,clip=null){return {snapshot,clip,generation:this._generation,state:clip?'ready':'requested',listeners:[],acceptAsync:false,controller:null,fetchTimer:null,startTimer:null,playbackTimer:null,frameTimer:null,promise:null,resolve:null,playAttempt:0,programmaticPlay:false,playAllowed:false,started:false,seeking:false,lastMediaTime:null,lastAdvanceAt:0};}
    _wait(record){if(!record.promise)record.promise=new Promise(resolve=>{record.resolve=resolve;});return record.promise;}
    _settle(record,event){const resolve=record.resolve;record.resolve=null;record.promise=null;if(resolve)resolve(event);return event;}
    _timerClear(record,key){if(record[key]!==null){this.timers.clearTimeout(record[key]);record[key]=null;}}
    _stopFrames(record){this._timerClear(record,'frameTimer');this._frame(record);}
    _unbind(record){for(const [name,fn]of record.listeners)this.audio.removeEventListener(name,fn);record.listeners=[];}
    _unload(){try{if(typeof this.audio.removeAttribute==='function')this.audio.removeAttribute('src');else this.audio.src='';this.audio.load?.();}catch(_){} }
    _queueCancellation(owner){
      const serial=++this._cancelSerial;this._cancelRequired=true;
      const task=this._cancelBarrier.catch(()=>{}).then(async()=>{
        const controller=new AbortController();let timer;
        const deadline=new Promise((_,reject)=>{timer=this.timers.setTimeout(()=>{controller.abort();reject(new Error('取消请求超时，尚未确认。'));},5000);});
        try{
          const request=(async()=>{
            const response=await this.fetchImpl('/api/local-audio/cancel',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Lease':owner},body:'{}',signal:controller.signal});
            if(!response.ok)throw new Error('取消尚未确认。');
            const receipt=await response.json();if(receipt?.ok!==true||receipt.cancelled!==true)throw new Error('没有收到服务端取消回执。');
          })();
          await Promise.race([request,deadline]);
          if(serial===this._cancelSerial)this._cancelRequired=false;
        }finally{this.timers.clearTimeout(timer);}
      });
      this._cancelBarrier=task;
      // stop() remains synchronous. A failed acknowledgement stays required, but
      // must not become an unhandled rejection or poison all future attempts.
      task.catch(()=>{});return task;
    }
    async _confirmCancellation(record,owner){
      const active=()=>this._valid(record)&&record.acceptAsync;let barrier;
      do{barrier=this._cancelBarrier;try{await barrier;}catch(_){}}while(active()&&barrier!==this._cancelBarrier);
      if(!active())return false;
      // Retry once for this explicit synthesis request. Only an acknowledged
      // cancellation opens the gate; another failure requires a new user attempt.
      if(this._cancelRequired)await this._queueCancellation(owner);
      return active();
    }
    _cancel(reason,{queue=true,park=true,notify=true}={}){
      this._generation++;if(queue)this._queueEpoch++;
      const record=this._current;const generating=record?.acceptAsync;this._current=null;
      if(generating&&root.studioDesktop&&this.fetchImpl){this._cancelRequired=true;let owner;try{owner=string(this.getLeaseOwner());}catch(_){}if(owner)this._queueCancellation(owner);}
      if(record){record.acceptAsync=false;record.controller?.abort();this._timerClear(record,'fetchTimer');this._timerClear(record,'startTimer');this._timerClear(record,'playbackTimer');this._timerClear(record,'frameTimer');this._unbind(record);}
      try{this.audio.pause();this.audio.currentTime=0;}catch(_){}
      const event=this._event(record,record?.resolve?'cancelled':'stopped','stopped',string(reason)||'已停止本机播放');
      if(record)this._settle(record,event);
      if(park&&this._last){const parked=this._record(this._last.snapshot,this._last);parked.state='stopped';this._current=parked;this._bind(parked);}else this._unload();
      this._frame(record);if(notify)this._notify(event);
      return event;
    }
    stop(reason='已停止本机播放'){return this._cancel(reason);}
    setMuted(value){
      this.muted=Boolean(value);
      if(this.muted){const event=this.stop('已静音，当前音频与后续队列均已停止');this.audio.muted=true;return event;}
      this.audio.muted=false;return this._notify(this._event(this._current,'unmuted','unmuted','已解除静音；请主动播放或重播。'));
    }
    setVoices(voices){
      this._voices=Array.isArray(voices)?voices.filter(v=>v&&['windows_local','macos_local'].includes(v.engine)&&typeof v.voice_id==='string'&&(v.voice_id.startsWith('winrt-')||v.voice_id.startsWith('mac-'))).map(v=>freeze({voice_id:v.voice_id,name:string(v.name),language:string(v.language),gender:string(v.gender),engine:v.engine})):[];
      return this._voices.length;
    }
    async refreshVoices(){
      if(!this.fetchImpl)throw new Error('浏览器无法连接本机语音服务。');
      const owner=string(this.getLeaseOwner());if(!owner)throw new Error('尚未取得工作室编辑权。');
      const controller=new AbortController();let timer;
      const deadline=new Promise((_,reject)=>{timer=this.timers.setTimeout(()=>{controller.abort();reject(new Error('本机音色列表读取超时。'));},40000);});
      try{
        const result=await Promise.race([(async()=>{const r=await this.fetchImpl('/api/local-voices',{method:'GET',headers:{'X-Studio-Lease':owner},signal:controller.signal});if(!r.ok)throw new Error('本机音色列表读取失败（HTTP '+r.status+'）。');return r.json();})(),deadline]);
        if(!result||!Array.isArray(result.voices))throw new Error('本机音色列表格式无效。');this.engine=result.engine;this.capabilities=result.capabilities||{};this.setVoices(result.voices);return this._voices.map(v=>({...v}));
      }finally{this.timers.clearTimeout(timer);}
    }
    _problem(snapshot){
      if(this.muted)return ['muted','当前已静音，请先解除后主动播放。'];
      if(!snapshot.character_id||!snapshot.profile_id)return ['invalid_character','人物或声音档案绑定无效。'];
      if(!snapshot.text.trim())return ['empty_text','请填写试读文本。'];
      if(!finite(snapshot.voice.rate,0.5,2)||!finite(snapshot.voice.pitch,0,2)||!finite(snapshot.voice.volume,0,1))return ['invalid_parameters','语速、音高或音量超出本机范围。'];
      if(snapshot.voice.volume===0)return ['zero_volume','当前人物音量为零。'];
      if(snapshot.requested_provider!=='browser_local'&&!(snapshot.requested_provider==='professional_pending'&&snapshot.preview))return ['provider_unconnected','专业服务尚未接入；请明确选择本机参考试听。'];
      if(!this._voices.some(v=>v.voice_id===snapshot.voice.local_voice_id))return ['local_voice_unavailable','已绑定音色当前不可用，请重新选择真实本机音色；不会自动换声。'];
      if(!this.fetchImpl||!this.urls?.createObjectURL)return ['playback_unavailable','当前环境不能生成或播放本机音频。'];
      return null;
    }
    _contextProblem(snapshot){
      let owner;try{owner=string(this.getLeaseOwner()).trim();}catch(_){}
      if(!owner)return ['lease_missing','工作室编辑权已失效，声音已停止。恢复连接后请主动重播。'];
      let allowed=false;try{allowed=this.canPlay(snapshot)===true;}catch(_){}
      return allowed?null:['playback_context_changed','当前场次或试听状态已改变，声音已停止。请回到可播放的状态后主动试听。'];
    }
    _allowPlayback(record){
      if(!this._valid(record))return false;
      const problem=this._contextProblem(record.snapshot);
      if(problem){this._failure(record,...problem,'blocked');return false;}
      return true;
    }
    _begin(snapshot){
      const record=this._record(snapshot);this._current=record;const promise=this._wait(record),problem=this._problem(snapshot)||this._contextProblem(snapshot);
      if(problem){this._frame(record);this._settle(record,this._notify(this._event(record,'blocked',...problem)));return promise;}
      let owner;try{owner=string(this.getLeaseOwner());}catch(_){}
      if(!owner){this._settle(record,this._notify(this._event(record,'blocked','lease_missing','尚未取得工作室编辑权，未请求音频。')));return promise;}
      record.controller=new AbortController();record.acceptAsync=true;
      this._notify(this._event(record,'requested','generating','正在生成本机音频，尚未播放。'));
      if(!this._valid(record)||!record.acceptAsync)return promise;
      record.fetchTimer=this.timers.setTimeout(()=>{if(this._valid(record)&&record.acceptAsync){record.controller.abort();this._failure(record,'generation_timeout','本机音频生成超过40秒，已取消。');}},40000);
      this._generate(record,owner);return promise;
    }
    async _generate(record,owner){
      const active=()=>this._valid(record)&&record.acceptAsync;
      try{
        try{if(!await this._confirmCancellation(record,owner))return;}
        catch(_){if(active())this._failure(record,'cancel_unconfirmed','旧语音的服务端取消尚未确认，未生成新音频。连接恢复后请再次点击试听。');return;}
        if(!active())return;
        const v=record.snapshot.voice,r=await this.fetchImpl('/api/local-audio',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Lease':owner},signal:record.controller.signal,
          body:JSON.stringify({text:record.snapshot.text,voice_id:v.local_voice_id,rate:v.rate,pitch:v.pitch,volume:v.volume})});
        if(!active())return;if(!r.ok){this._failure(record,'http_error','本机音频生成失败（HTTP '+r.status+'）。');return;}
        const bytes=await r.arrayBuffer();if(!active())return;
        const head=new Uint8Array(bytes,0,Math.min(12,bytes.byteLength));
        if(bytes.byteLength<12||String.fromCharCode(...head.slice(0,4))!=='RIFF'||String.fromCharCode(...head.slice(8,12))!=='WAVE'){this._failure(record,'invalid_wav','本机服务未返回有效WAV音频。');return;}
        let pcm;try{pcm=envelope(await this.decode(bytes.slice(0)));}catch(_){if(active())this._failure(record,'decode_failed','音频无法解码，未播放。');return;}
        if(!active())return;record.acceptAsync=false;this._timerClear(record,'fetchTimer');
        const url=this.urls.createObjectURL(new Blob([bytes],{type:'audio/wav'}));
        const clip={snapshot:record.snapshot,url,...pcm};if(this._last&&this._last.url!==url)this.urls.revokeObjectURL?.(this._last.url);this._last=clip;record.clip=clip;
        this._attach(record);this._requestPlay(record);
      }catch(_){if(active())this._failure(record,'generation_failed','本机音频生成或连接失败，未播放。');}
    }
    _failure(record,reason,message,status='failed'){
      if(!this._valid(record))return;
      record.acceptAsync=false;record.controller?.abort();this._timerClear(record,'fetchTimer');this._timerClear(record,'startTimer');this._timerClear(record,'playbackTimer');this._stopFrames(record);record.playAttempt++;record.programmaticPlay=false;record.playAllowed=false;record.state=record.clip?'ready':'failed';this._queueEpoch++;
      try{this.audio.pause();}catch(_){}
      const event=this._event(record,status,reason,message);this._settle(record,event);this._notify(event);
    }
    _attach(record){
      record.state='ready';this.audio.src=record.clip.url;this.audio.muted=this.muted;this.audio.load?.();this._bind(record);
      this._notify(this._event(record,'ready','audio_ready','本机音频已生成；实际听感尚未验证。'));
    }
    _listen(record,name,fn){const wrapped=event=>{if(this._valid(record)&&this._source(record))fn(event);};record.listeners.push([name,wrapped]);this.audio.addEventListener(name,wrapped);}
    _bind(record){
      this._listen(record,'play',()=>{
        if(this.audio.paused)return;
        if(!this._allowPlayback(record))return;
        if(this.muted||this.audio.muted||this.audio.volume===0){this.audio.pause();this._stopFrames(record);return;}
        if(!record.programmaticPlay){this._queueEpoch++;record.playAttempt++;}record.programmaticPlay=false;record.playAllowed=true;record.state='starting';
        this._notify(this._event(record,'requested','native_play','播放器正在开始播放；尚未验证听感。'));
      });
      this._listen(record,'playing',()=>this._playing(record));
      this._listen(record,'pause',()=>{if(this.audio.paused&&!this.audio.ended&&['speaking','starting','waiting','seeking'].includes(record.state))this._pauseRecord(record,'播放器已暂停，后续队列已取消。');});
      this._listen(record,'ended',()=>{
        if(!this.audio.ended)return;this._timerClear(record,'startTimer');this._timerClear(record,'playbackTimer');this._stopFrames(record);record.state='completed';record.playAllowed=false;
        const event=this._event(record,'completed','ended','播放器已结束；实际听感请人工确认。');this._settle(record,event);this._notify(event);
      });
      this._listen(record,'error',()=>{if(this.audio.error)this._failure(record,'playback_error','本机音频播放器报告错误，请手动重播或重新生成。');});
      this._listen(record,'seeking',()=>{this._queueEpoch++;record.seeking=true;this._stopFrames(record);this._notify(this._event(record,'seeking','seeking','正在调整播放位置，后续队列已取消。'));});
      this._listen(record,'seeked',()=>{record.seeking=false;record.lastMediaTime=null;if(!this.audio.paused&&record.playAllowed)this._playing(record);else this._frame(record);});
      for(const name of ['waiting','stalled'])this._listen(record,name,()=>{if(['speaking','starting'].includes(record.state)){record.state='waiting';this._stopFrames(record);this._notify(this._event(record,'requested','buffering','播放器正在等待音频，嘴型已暂停。'));}});
      this._listen(record,'ratechange',()=>{if(['speaking','waiting'].includes(record.state))this._armPlaybackDeadline(record);});
      this._listen(record,'volumechange',()=>{
        if(this.muted&&!this.audio.muted)this.audio.muted=true;
        if(this.audio.muted||this.audio.volume===0){if(['speaking','starting','waiting'].includes(record.state))this._pauseRecord(record,'播放器已静音，后续队列已取消。');this.audio.pause();this._stopFrames(record);}
      });
    }
    _playing(record){
      if(!this._valid(record)||!this._source(record)||!record.playAllowed||this.audio.paused)return;
      if(!this._allowPlayback(record))return;
      if(this.muted||this.audio.muted||this.audio.volume===0){this._pauseRecord(record,'当前已静音。');this.audio.pause();return;}
      this._timerClear(record,'startTimer');record.state='speaking';record.started=true;record.seeking=false;record.lastMediaTime=null;record.lastAdvanceAt=this._now();this._armPlaybackDeadline(record);
      this._notify(this._event(record,'speaking','playing','本机播放器播放中 · '+record.snapshot.character_name));this._tick(record);
    }
    _armPlaybackDeadline(record){
      this._timerClear(record,'playbackTimer');
      const rate=finite(this.audio.playbackRate,0.05,16)?this.audio.playbackRate:1,remaining=Math.max(0,record.clip.duration-(Number(this.audio.currentTime)||0));
      record.playbackTimer=this.timers.setTimeout(()=>{if(this._valid(record)&&['speaking','waiting','seeking'].includes(record.state))this._failure(record,'playback_timeout','未收到播放器结束回执，已停止；音频保留供手动重播。');},remaining/rate*1000+15000);
    }
    _tick(record){
      this._timerClear(record,'frameTimer');
      if(!this._valid(record)||record.state!=='speaking'||this.audio.paused||record.seeking||this.muted||this.audio.muted){this._frame(record);return;}
      if(!this._allowPlayback(record))return;
      const time=Number(this.audio.currentTime),now=this._now();
      if(record.lastMediaTime===null||Math.abs(time-record.lastMediaTime)>0.0001){record.lastMediaTime=time;record.lastAdvanceAt=now;}
      let energy=0,mouth=0;
      if(Number.isFinite(time)&&time>=0&&time<record.clip.duration&&now-record.lastAdvanceAt<=250){
        const index=Math.min(record.clip.values.length-1,Math.floor(time/record.clip.step));energy=clamp(record.clip.values[index]*clamp(Number(this.audio.volume)));
        mouth=energy<=0.006?0:clamp((energy-0.006)/Math.max(0.04,record.clip.peak*0.8));
      }
      this._frame(record,mouth,energy);record.frameTimer=this.timers.setTimeout(()=>this._tick(record),50);
    }
    _requestPlay(record){
      if(!this._valid(record))return;
      if(!this._allowPlayback(record))return;
      if(this.muted||this.audio.muted||this.audio.volume===0){this._failure(record,'muted','当前播放器已静音，请解除后主动播放。','blocked');return;}
      const attempt=++record.playAttempt;record.programmaticPlay=true;record.playAllowed=true;record.started=false;record.state='starting';
      this._timerClear(record,'startTimer');record.startTimer=this.timers.setTimeout(()=>{if(this._valid(record)&&attempt===record.playAttempt&&!record.started&&['starting','waiting'].includes(record.state))this._failure(record,'play_start_timeout','未收到播放器开始回执，可使用可见播放器手动播放。');},10000);
      try{Promise.resolve(this.audio.play()).catch(error=>{
        if(!this._valid(record)||attempt!==record.playAttempt||!['starting','ready'].includes(record.state))return;
        const blocked=error?.name==='NotAllowedError';this._failure(record,blocked?'autoplay_blocked':'playback_start_failed',blocked?'浏览器阻止自动播放；音频已保留，请点击可见播放器播放。':'播放器未能开始；音频已保留，可手动重播。',blocked?'blocked':'failed');
      });}catch(error){const blocked=error?.name==='NotAllowedError';this._failure(record,blocked?'autoplay_blocked':'playback_start_failed','播放器未能开始；音频已保留，请手动播放。',blocked?'blocked':'failed');}
    }
    _pauseRecord(record,message){
      if(!this._valid(record))return null;this._queueEpoch++;this._timerClear(record,'startTimer');this._timerClear(record,'playbackTimer');this._stopFrames(record);record.playAttempt++;record.state='paused';record.programmaticPlay=false;record.playAllowed=false;
      const event=this._event(record,'paused','paused',message);this._settle(record,event);this._notify(event);return event;
    }
    pause(){const record=this._current;if(!record?.clip)return this.stop('生成已取消，没有待继续播放的音频。');const result=this._pauseRecord(record,'已暂停当前音频，后续队列已取消。');this.audio.pause();return result;}
    resume(){
      const record=this._current;this._queueEpoch++;
      if(!record?.clip||!['paused','ready'].includes(record.state))return Promise.resolve(this._notify(this._event(record,'blocked','resume_unavailable','当前没有暂停的音频；停止后请使用重播。')));
      const promise=this._wait(record);this._requestPlay(record);return promise;
    }
    replay(){
      const clip=this._last;this._cancel('主动重播当前音频',{park:false});
      if(!clip)return Promise.resolve(this._notify(this._event(null,'blocked','no_audio','尚无已生成的本机音频可重播。')));
      const snapshot=freeze({...clip.snapshot,request_id:'local-audio-'+(++this._serial),replay_of:clip.snapshot.request_id,captured_at:this._now()});
      const nextClip={...clip,snapshot},record=this._record(snapshot,nextClip);this._last=nextClip;this._current=record;const promise=this._wait(record);this._attach(record);this._requestPlay(record);return promise;
    }
    speak(character,text,{sessionId='',preview=false}={}){
      this._cancel('新的试听替换上一段',{park:false});return this._begin(this._capture(character,text,sessionId,preview));
    }
    async playSequence(lines,sessionId=''){
      this._cancel('新的对白替换上一段',{park:false});
      if(!Array.isArray(lines)||lines.length===0)return freeze({status:'blocked',reason:'empty_sequence',session_id:string(sessionId),receipts:[],unplayed:0});
      const epoch=this._queueEpoch,snapshots=lines.map(line=>this._capture(line?.character,line?.text,sessionId,line?.preview===true)),receipts=[];let status='completed';
      for(const snapshot of snapshots){
        if(epoch!==this._queueEpoch){status='cancelled';break;}
        this._cancel('下一段对白',{queue:false,park:false,notify:false});const receipt=await this._begin(snapshot);receipts.push(receipt);
        if(receipt.status!=='completed'){status=receipt.status;break;}
      }
      if(status==='completed'&&epoch!==this._queueEpoch)status='cancelled';
      return freeze({status,session_id:string(sessionId),receipts,unplayed:snapshots.length-receipts.length});
    }
  }
  return Object.freeze({LocalAudioBus});
});
