(function(root,factory){
  'use strict';const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.StudioCloudAudio=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const graphs=new WeakMap(),MIME='audio/mpeg',MAX_AUDIO=32*1024*1024,MAX_LINE=4*1024*1024;
  const text=value=>typeof value==='string'?value:'';
  const clamp=n=>Math.max(0,Math.min(1,n));
  const finite=(n,min,max)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max;
  function freeze(value){if(value&&typeof value==='object'&&!Object.isFrozen(value)){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
  function fault(reason,message){return Object.assign(new Error(message),{reason});}
  function graphFor(audio,factory){
    let graph=graphs.get(audio);if(graph)return graph;
    const context=factory(),analyser=context.createAnalyser();analyser.fftSize=256;
    const source=context.createMediaElementSource(audio);
    // The media element remains the sole playback device. Never add a parallel
    // source-to-destination edge or an AudioBufferSource for the same audio.
    source.connect(analyser);analyser.connect(context.destination);
    graph={context,source,analyser,samples:new Float32Array(analyser.fftSize)};graphs.set(audio,graph);return graph;
  }
  class CloudAudioBus{
    constructor({audio,onStatus,onFrame,getLeaseOwner,canPlay,fetchImpl,timers,urlFactory,mediaSourceFactory,isTypeSupported,audioContextFactory,getModel,requestTimeoutMs=45000,maxStreamMs=180000}={}){
      if(!audio||typeof audio.play!=='function'||typeof audio.pause!=='function'||typeof audio.addEventListener!=='function')throw new Error('需要可见的 HTML 音频播放器。');
      this.audio=audio;this.onStatus=typeof onStatus==='function'?onStatus:()=>{};this.onFrame=typeof onFrame==='function'?onFrame:()=>{};
      this.getLeaseOwner=typeof getLeaseOwner==='function'?getLeaseOwner:()=>'';this.canPlay=typeof canPlay==='function'?canPlay:()=>true;
      this.fetchImpl=fetchImpl||(typeof root.fetch==='function'?root.fetch.bind(root):null);
      this.timers=timers||{setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id),now:()=>performance.now()};this.urls=urlFactory||root.URL;
      this.mediaSourceFactory=mediaSourceFactory||(()=>new root.MediaSource());this.isTypeSupported=isTypeSupported||((mime)=>!!root.MediaSource?.isTypeSupported(mime));
      this.audioContextFactory=audioContextFactory||(()=>new(root.AudioContext||root.webkitAudioContext)());
      this.getModel=typeof getModel==='function'?getModel:()=> '';this.requestTimeoutMs=requestTimeoutMs;this.maxStreamMs=maxStreamMs;
      this.engine='minimax';this.capabilities=Object.freeze({supported:true,rate:true,pitch:true,volume:true,professional:true,streaming:true,cancel:true,stability:false,similarity:false,expressiveness:false});
      this._current=null;this._last=null;this._generation=0;this._serial=0;this._queueEpoch=0;this.muted=false;this._cancelBarrier=Promise.resolve();this._cancelRequired=false;this._cancelSerial=0;
    }
    _now(){return this.timers.now();}
    _snapshot(character,words,sessionId,preview){
      const c=character||{},v=c.voice||{};let model='';try{model=text(this.getModel());}catch{}
      return freeze({request_id:'cloud-audio-'+(++this._serial),character_id:text(c.character_id),character_name:text(c.name),character_revision:c.revision,profile_id:text(v.profile_id),session_id:text(sessionId),preview:preview===true,text:text(words),requested_provider:text(v.provider),model,captured_at:this._now(),voice:{service:text(v.service),voice_id:text(v.voice_id),rate:v.rate,pitch:v.pitch,volume:v.volume}});
    }
    _event(record,status,reason,message){
      const snapshot=record?.snapshot||{request_id:null,character_id:null,character_name:'',session_id:'',text:''},cache=record?.cache;
      return freeze({...snapshot,status,reason,message,talking:status==='speaking',has_audio:!!cache,audio_verified:false,effective_provider:record?.requestSent||cache?'minimax':null,audio_mime:MIME,download_url:cache?.url||null,replayed:record?.replayed===true,
        first_playback_ms:record?.firstPlayback??null,first_audio_byte_ms:record?.receipt?.first_audio_byte_ms??null,
        usage_characters:record?.receipt?.cost_unknown?null:record?.replayed?0:record?.receipt?.usage_characters??null,estimated_cost_usd:record?.receipt?.cost_unknown?null:record?.replayed?0:record?.receipt?.estimated_cost_usd??null,
        ...(record?.receipt?.cost_unknown?{cost_unknown:true}:{}),
        // This only proves an attempt at the local HTTP endpoint. Credentials,
        // budget or other server checks can reject it before provider dispatch.
        cached_usage_characters:record?.replayed?record?.receipt?.usage_characters??null:null,local_request_attempted:record?.requestSent===true&&!record?.replayed,
        requested_parameters:snapshot.voice?{rate:snapshot.voice.rate,pitch:snapshot.voice.pitch,volume:snapshot.voice.volume}:null,
        professional_parameters_applied:!!record?.applied,applied_parameters:record?.applied||null,
        unapplied_design_parameters:['stability','similarity','expressiveness']});
    }
    _notify(event){try{this.onStatus(event);}catch{}return event;}
    _frame(record,mouth=0,energy=0){try{this.onFrame(freeze({request_id:record?.snapshot.request_id??null,character_id:record?.snapshot.character_id??null,session_id:record?.snapshot.session_id??'',mouth:clamp(mouth),energy:clamp(energy),media_time:Number(this.audio.currentTime)||0}));}catch{}}
    _valid(record){return this._current===record&&record.generation===this._generation;}
    _context(snapshot,owner){try{return !!owner&&text(this.getLeaseOwner())===owner&&this.canPlay(snapshot)===true;}catch{return false;}}
    _problem(snapshot){
      if(this.muted)return ['muted','当前已静音，请解除后主动播放。'];
      if(!snapshot.character_id||!snapshot.profile_id)return ['invalid_character','人物或声音档案绑定无效。'];
      if(snapshot.requested_provider!=='professional_pending'||snapshot.voice.service!=='minimax'||!snapshot.voice.voice_id.trim())return ['cloud_voice_unbound','请明确选择 MiniMax 并绑定专业音色；未使用本机声音替代。'];
      if(snapshot.voice.voice_id.length>200||!snapshot.text.trim()||snapshot.text.length>1000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(snapshot.text))return ['invalid_request','试读内容或音色编号无效。'];
      if(!/^[A-Za-z0-9_.-]{1,80}$/.test(snapshot.model))return ['invalid_model','请选择支持的语音模型。'];
      if(!finite(snapshot.voice.rate,.5,2)||!finite(snapshot.voice.pitch,.5,2)||!finite(snapshot.voice.volume,Number.MIN_VALUE,1))return ['invalid_parameters','语速、音高或音量超出支持范围。'];
      let supported=false;try{supported=this.isTypeSupported(MIME)===true;}catch{}
      if(!this.fetchImpl||!this.urls?.createObjectURL||!supported)return ['streaming_unavailable','此环境不支持 MP3 流式播放，未请求付费音频。'];
      return null;
    }
    _timer(record,key,fn,ms){this._clearTimer(record,key);record.timers.set(key,this.timers.setTimeout(()=>{record.timers.delete(key);if(this._valid(record))fn();},ms));}
    _clearTimer(record,key){if(record.timers.has(key)){this.timers.clearTimeout(record.timers.get(key));record.timers.delete(key);}}
    _listen(record,target,name,fn){const wrapped=()=>{if(this._valid(record))fn();};target.addEventListener(name,wrapped);record.listeners.push([target,name,wrapped]);}
    _settle(record,event){if(record.resolve){const resolve=record.resolve;record.resolve=null;resolve(event);}return event;}
    async _wait(record,promise){return Promise.race([promise,record.interrupted.then(()=>{throw fault('cancelled','请求已取消。');})]);}
    _queueCancellation(owner){
      const serial=++this._cancelSerial;this._cancelRequired=true;
      const task=this._cancelBarrier.catch(()=>{}).then(async()=>{
        const controller=new AbortController();let timer;
        const deadline=new Promise((_,reject)=>{timer=this.timers.setTimeout(()=>{controller.abort();reject(fault('cancel_unconfirmed','取消尚未确认。'));},5000);});
        try{
          const request=(async()=>{const r=await this.fetchImpl('/api/local-audio/cancel',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Lease':owner},body:'{}',signal:controller.signal});if(!r.ok)throw new Error('cancel failed');const result=await r.json();if(result?.ok!==true||result.cancelled!==true)throw new Error('cancel unconfirmed');})();
          await Promise.race([request,deadline]);if(serial===this._cancelSerial)this._cancelRequired=false;
        }finally{this.timers.clearTimeout(timer);}
      });this._cancelBarrier=task;task.catch(()=>{});return task;
    }
    async _confirmCancellation(record){
      let barrier;do{barrier=this._cancelBarrier;try{await this._wait(record,barrier);}catch{}}while(this._valid(record)&&barrier!==this._cancelBarrier);
      if(!this._valid(record))return false;
      if(this._cancelRequired)await this._wait(record,this._queueCancellation(record.owner));return this._valid(record);
    }
    _cleanup(record){
      record.interrupt();record.controller.abort();try{Promise.resolve(record.reader?.cancel()).catch(()=>{});}catch{}
      for(const [target,name,listener]of record.listeners)target.removeEventListener(name,listener);record.listeners=[];
      for(const timer of record.timers.values())this.timers.clearTimeout(timer);record.timers.clear();record.openReject?.(fault('cancelled','请求已取消。'));record.openReject=null;
      try{if(record.sourceBuffer&&record.mediaSource?.readyState==='open')record.sourceBuffer.abort();}catch{}
      try{this.audio.pause();this.audio.currentTime=0;this.audio.removeAttribute('src');this.audio.load?.();}catch{}
      if(record.sourceURL)this.urls.revokeObjectURL(record.sourceURL);record.sourceURL=null;record.pending=[];record.chunks=[];
    }
    _terminate(record,status,reason,message,{discardCache=false}={}){
      if(!this._valid(record))return null;
      if(discardCache&&record.cache&&this._last===record.cache){this.urls.revokeObjectURL(record.cache.url);this._last=null;record.cache=null;}
      const event=this._event(record,status,reason,message);this._current=null;this._generation++;this._queueEpoch++;
      if(record.requestSent&&!record.networkFinished)this._queueCancellation(record.owner);
      this._cleanup(record);this._frame(record);this._settle(record,event);return this._notify(event);
    }
    _fail(record,reason,message,status='failed'){return this._terminate(record,status,reason,message,{discardCache:['media_error','append_failed'].includes(reason)});}
    stop(reason='已停止专业语音与动作'){
      const record=this._current;if(record)return this._terminate(record,'cancelled','stopped',text(reason)||'已停止专业语音');
      return this._notify(this._event(null,'stopped','stopped',text(reason)||'已停止专业语音'));
    }
    setMuted(value){this.muted=!!value;if(this.muted){const event=this.stop('已静音，流式请求与后续对白已取消');this.audio.muted=true;return event;}this.audio.muted=false;return this._notify(this._event(this._current,'unmuted','unmuted','已解除静音；请主动播放或重播。'));}
    _newRecord(snapshot){
      let resolve,interrupt,owner='';try{owner=text(this.getLeaseOwner());}catch{}
      const record={snapshot,generation:this._generation,owner,controller:new AbortController(),timers:new Map(),listeners:[],pending:[],chunks:[],bytes:0,state:'requested',requestSent:false,networkFinished:false,protocolDone:false,eos:false,playingRequested:false,firstPlayback:null,lastTime:null,lastAdvance:0,advanced:false,cache:null,receipt:null,applied:null,replayed:false};
      record.promise=new Promise(r=>resolve=r);record.resolve=resolve;record.interrupted=new Promise(r=>interrupt=r);record.interrupt=interrupt;this._current=record;return record;
    }
    _begin(snapshot,cache=null){
      const record=this._newRecord(snapshot),problem=this._problem(snapshot);
      if(problem){this._fail(record,...problem,'blocked');return record.promise;}
      if(!this._context(snapshot,record.owner)){this._fail(record,'playback_context_changed','当前场次或编辑连接已改变，未请求音频。','blocked');return record.promise;}
      this._notify(this._event(record,'requested',cache?'replaying':'connecting',cache?'正在重播完整缓存，不再请求付费音频。':'正在连接专业语音，等待流式音频。'));
      this._guard(record);
      if(cache){record.cache=cache;record.receipt=cache.receipt;record.applied=cache.applied;record.replayed=true;record.networkFinished=true;this._runReplay(record,cache).catch(e=>{if(this._valid(record))this._fail(record,e.reason||'replay_failed','缓存音频无法播放。');});}
      else this._stream(record).catch(e=>{if(this._valid(record))this._fail(record,e.reason||'stream_failed',e.reason?e.message:'专业语音连接或播放失败，未保留不完整片段。');});
      return record.promise;
    }
    _guard(record){
      if(!this._valid(record))return;
      if(!this._context(record.snapshot,record.owner)){this._fail(record,'playback_context_changed','当前场次或编辑连接已改变，语音已停止。','blocked');return;}
      let energy=0,mouth=0;const time=Number(this.audio.currentTime),now=this._now();
      if(record.state==='speaking'&&!this.audio.paused&&!this.audio.ended&&!this.audio.seeking&&!this.muted&&!this.audio.muted&&this.audio.volume!==0){
        if(record.lastTime!==null&&Number.isFinite(time)&&Math.abs(time-record.lastTime)>.0001){record.advanced=true;record.lastAdvance=now;}
        record.lastTime=time;
        if(record.advanced&&now-record.lastAdvance<=250&&record.graph){
          try{const {analyser,samples}=record.graph;analyser.getFloatTimeDomainData(samples);let sum=0;for(const sample of samples)sum+=Number.isFinite(sample)?sample*sample:0;energy=clamp(Math.sqrt(sum/samples.length));mouth=clamp((energy-.006)/.15);}catch{}
        }
      }
      this._frame(record,mouth,energy);this._timer(record,'guard',()=>this._guard(record),50);
    }
    async _prepareGraph(record){
      try{record.graph=graphFor(this.audio,this.audioContextFactory);if(record.graph.context.state==='suspended')await this._wait(record,record.graph.context.resume());if(record.graph.context.state==='closed')throw new Error('closed');}
      catch{throw fault('audio_graph_unavailable','音频播放通道无法启动，未请求付费音频。');}
    }
    _bindAudio(record){
      const source=()=>this.audio.currentSrc===record.sourceURL||this.audio.src===record.sourceURL;
      const usable=()=>{if(!source())return false;if(!this._context(record.snapshot,record.owner)||this.muted||this.audio.muted||this.audio.volume===0){this._fail(record,'playback_context_changed','当前播放条件已改变，语音已停止。','blocked');return false;}return true;};
      this._listen(record,this.audio,'play',()=>{if(!usable())return;if(record.state==='completed')record.replayed=true;record.state='starting';});
      this._listen(record,this.audio,'playing',()=>{
        if(!usable()||this.audio.paused)return;this._clearTimer(record,'start');record.state='speaking';record.lastTime=Number(this.audio.currentTime);record.advanced=false;
        if(record.firstPlayback===null)record.firstPlayback=Math.max(0,this._now()-record.snapshot.captured_at);
        this._notify(this._event(record,'speaking','playing','专业语音播放器播放中 · '+record.snapshot.character_name));this._guard(record);
      });
      for(const event of ['waiting','stalled','seeking'])this._listen(record,this.audio,event,()=>{if(!source())return;if(event==='seeking')this._queueEpoch++;record.state='buffering';record.advanced=false;this._frame(record);this._notify(this._event(record,'requested','buffering','播放器正在等待音频，嘴型已暂停。'));});
      this._listen(record,this.audio,'seeked',()=>{if(!usable()||this.audio.paused)return;record.state='speaking';record.lastTime=Number(this.audio.currentTime);record.advanced=false;this._guard(record);});
      this._listen(record,this.audio,'pause',()=>{if(source()&&!this.audio.ended&&this.audio.paused&&record.playingRequested)this._terminate(record,'paused','native_pause','播放器已暂停，未完成的流式请求已取消；完整片段可主动重播。');});
      this._listen(record,this.audio,'ended',()=>{
        if(!source()||!this.audio.ended)return;if(!record.cache){this._fail(record,'incomplete_audio','音频在完成回执之前结束，未保留不完整片段。');return;}
        record.state='completed';this._clearTimer(record,'playback');this._clearTimer(record,'guard');this._frame(record);const event=this._event(record,'completed','ended','播放器已结束；首播放时间来自 playing 事件，不代表声卡可听延迟。');this._settle(record,event);this._notify(event);
      });
      this._listen(record,this.audio,'error',()=>{if(source())this._fail(record,'media_error','播放器无法解码此音频，已停止并移除无效片段。');});
      this._listen(record,this.audio,'volumechange',()=>{if(source()&&(this.audio.muted||this.audio.volume===0))this._terminate(record,'paused','native_mute','播放器已静音，流式请求已取消。');});
    }
    _requestPlay(record){
      if(!this._valid(record)||record.playingRequested)return;record.playingRequested=true;
      if(!this._context(record.snapshot,record.owner)){this._fail(record,'playback_context_changed','当前场次已改变，未播放音频。','blocked');return;}
      this._timer(record,'start',()=>this._fail(record,'play_start_timeout','未收到播放器开始回执，流式请求已取消。'),10000);
      this._timer(record,'playback',()=>this._fail(record,'playback_timeout','未收到播放器结束回执，已停止音频。'),600000);
      try{Promise.resolve(this.audio.play()).catch(e=>{if(this._valid(record))this._fail(record,e?.name==='NotAllowedError'?'autoplay_blocked':'play_failed','播放器未能开始，流式请求已取消。','blocked');});}catch{this._fail(record,'play_failed','播放器未能开始，流式请求已取消。');}
    }
    async _openMedia(record){
      record.mediaSource=this.mediaSourceFactory();record.sourceURL=this.urls.createObjectURL(record.mediaSource);this._bindAudio(record);
      const opened=new Promise((resolve,reject)=>{
        record.openReject=reject;
        this._listen(record,record.mediaSource,'sourceopen',()=>{
          try{
            record.sourceBuffer=record.mediaSource.addSourceBuffer(MIME);
            this._listen(record,record.sourceBuffer,'error',()=>this._fail(record,'append_failed','流式音频无法解码，已停止请求。'));
            this._listen(record,record.sourceBuffer,'updateend',()=>{if(record.appendInFlight){record.appendInFlight=false;this._requestPlay(record);}this._pump(record);});
            this._clearTimer(record,'open');record.openReject=null;resolve();
          }catch{reject(fault('streaming_unavailable','无法创建 MP3 流式缓冲，未请求付费音频。'));}
        });
        this._timer(record,'open',()=>reject(fault('streaming_unavailable','流式播放器启动超时，未请求付费音频。')),10000);
      });
      this.audio.src=record.sourceURL;this.audio.muted=this.muted;this.audio.load?.();await this._wait(record,opened);
    }
    _pump(record){
      if(!this._valid(record)||!record.sourceBuffer||record.sourceBuffer.updating||record.eos)return;
      if(record.pending.length){try{record.appendInFlight=true;record.sourceBuffer.appendBuffer(record.pending.shift());}catch{this._fail(record,'append_failed','音频缓冲写入失败，已停止请求。');}return;}
      if(record.networkFinished&&record.protocolDone){
        try{
          record.mediaSource.endOfStream();record.eos=true;
          const blob=new Blob(record.chunks,{type:MIME}),url=this.urls.createObjectURL(blob),cache={snapshot:record.snapshot,blob,url,receipt:record.receipt,applied:record.applied};
          if(this._last)this.urls.revokeObjectURL(this._last.url);this._last=cache;record.cache=cache;record.chunks=[];
          this._notify(this._event(record,record.state==='speaking'?'speaking':'ready','stream_complete','完整专业音频已接收；可免费重播缓存。'));
        }catch{this._fail(record,'append_failed','完整音频未能完成缓冲，未保留不完整片段。');}
      }
    }
    _applied(record,value){
      if(value===undefined)return;
      if(!value||typeof value!=='object'||!['rate','pitch','volume'].every(k=>finite(value[k],0,100)))throw fault('invalid_stream','参数回执无效。');
      record.applied=freeze({rate:value.rate,pitch:value.pitch,volume:value.volume});
    }
    _line(record,line){
      if(!line.trim())return;let event;try{event=JSON.parse(line);}catch{throw fault('invalid_stream','流式响应包含无效 JSON。');}
      if(!event||typeof event!=='object'||Array.isArray(event))throw fault('invalid_stream','流式响应格式无效。');
      if(record.protocolDone)throw fault('invalid_stream','完成回执之后出现额外数据，未保留此片段。');
      if(event.type==='start'){if(record.sawStart||record.bytes)throw fault('invalid_stream','流式开始回执顺序无效。');record.sawStart=true;this._applied(record,event.applied_parameters);return;}
      if(event.type==='error')throw fault('provider_error',text(event.error).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,300)||'专业语音服务未能完成请求。');
      if(event.type==='audio'){
        const base64=event.audio;if(typeof base64!=='string'||!base64.length||base64.length>MAX_LINE||base64.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))throw fault('invalid_stream','流式音频编码无效。');
        const binary=root.atob(base64),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));record.bytes+=bytes.length;
        if(!bytes.length||record.bytes>MAX_AUDIO)throw fault('audio_too_large','流式音频为空或超过大小限制。');
        record.chunks.push(bytes);record.pending.push(bytes);this._pump(record);return;
      }
      if(event.type==='done'){
        const unknown=event.cost_unknown===true;
        const validUsage=unknown?event.format==='mp3'&&event.usage_characters===null&&event.estimated_cost_usd===null:Number.isSafeInteger(event.usage_characters)&&event.usage_characters>=0&&(event.estimated_cost_usd===undefined||finite(event.estimated_cost_usd,0,10000));
        if(!validUsage||event.cost_unknown!==undefined&&typeof event.cost_unknown!=='boolean'||!finite(event.first_audio_byte_ms,0,unknown?Number.MAX_VALUE:3600000))throw fault('invalid_stream','流式完成回执无效。');
        record.protocolDone=true;record.receipt=freeze({usage_characters:event.usage_characters,first_audio_byte_ms:event.first_audio_byte_ms,...(event.estimated_cost_usd===undefined?{}:{estimated_cost_usd:event.estimated_cost_usd}),...(unknown?{cost_unknown:true}:{})});this._applied(record,event.applied_parameters);return;
      }
      throw fault('invalid_stream','流式响应含有不支持的事件。');
    }
    async _httpFailure(record,response){
      const message='专业语音连接未成功，未保留音频。',fallback=()=>fault('http_error',message);
      if(!response.body?.getReader)return fallback();
      let reader;
      // Never use response.json()/text(): the error body is untrusted and must
      // have a byte limit, a fixed deadline, and the same cancellation as audio.
      this._timer(record,'httpError',()=>this._fail(record,'http_error',message),5000);
      try{
        reader=record.reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let body='',received=0;
        for(;;){
          const part=await this._wait(record,reader.read());if(!this._valid(record))return fallback();if(part.done)break;
          if(!(part.value instanceof Uint8Array))return fallback();
          received+=Math.max(part.value.byteLength,1);if(received>4096)return fallback();
          body+=decoder.decode(part.value,{stream:true});
        }
        const value=JSON.parse(body+decoder.decode());
        // Fixed local instructions only; never display arbitrary server text.
        const known={KEYCHAIN_TIMEOUT:['keychain_timeout','请本人完成macOS钥匙串授权，或重新保存密钥；本次未发送语音请求。'],BUDGET_STATE_UNKNOWN:['budget_state_unknown','费用记录暂不可用，未发送新的语音请求；累计记录没有清零。'],INSUFFICIENT_BALANCE:['insufficient_balance','MiniMax账户余额不足，请在官方控制台检查；软件不会自动充值。'],SPENDING_LOCKED:['spending_locked','当前费用模式受原试听设备限制；请检查演练或直播费用配置。']};
        if(value&&value.type==='error'&&Object.hasOwn(known,value.code))return fault(...known[value.code]);
        return fallback();
      }catch{return fallback();}
      finally{
        this._clearTimer(record,'httpError');try{Promise.resolve(reader?.cancel()).catch(()=>{});}catch{}
        try{reader?.releaseLock();}catch{}if(record.reader===reader)record.reader=null;
      }
    }
    async _stream(record){
      try{if(!await this._confirmCancellation(record))return;}catch{throw fault('cancel_unconfirmed','旧语音取消尚未确认，未请求新音频；请稍后主动重试。');}
      await this._prepareGraph(record);if(!this._valid(record))return;await this._openMedia(record);if(!this._valid(record))return;
      if(!this._context(record.snapshot,record.owner))throw fault('playback_context_changed','当前场次已改变，未请求音频。');
      const s=record.snapshot,v=s.voice;record.requestSent=true;
      const watchdog=()=>this._timer(record,'network',()=>this._fail(record,'stream_timeout','专业语音响应超时，已取消请求。'),this.requestTimeoutMs);
      watchdog();this._timer(record,'total',()=>this._fail(record,'stream_timeout','专业语音流超过等待上限，已取消。'),this.maxStreamMs);
      const response=await this._wait(record,this.fetchImpl('/api/cloud-audio',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Lease':record.owner},body:JSON.stringify({text:s.text,voice_id:v.voice_id,model:s.model,rate:v.rate,pitch:v.pitch,volume:v.volume,character_id:s.character_id,profile_id:s.profile_id}),signal:record.controller.signal}));
      if(!this._valid(record))return;if(!response.ok)throw await this._httpFailure(record,response);
      if(!response.body?.getReader)throw fault('http_error','专业语音连接未成功，未保留音频。');
      record.reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let pending='',received=0;
      try{
        for(;;){
          const part=await this._wait(record,record.reader.read());if(!this._valid(record))return;if(part.done)break;watchdog();
          received+=part.value.byteLength;if(received>MAX_AUDIO*1.5+1024*1024)throw fault('audio_too_large','流式响应超过大小限制。');
          pending+=decoder.decode(part.value,{stream:true});let newline;
          while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(line.length>MAX_LINE)throw fault('audio_too_large','单个音频块过大。');this._line(record,line);if(!this._valid(record))return;}
          if(pending.length>MAX_LINE)throw fault('audio_too_large','单个音频块过大。');
        }
        pending+=decoder.decode();if(pending.trim())this._line(record,pending);
        if(!record.protocolDone||!record.bytes)throw fault('incomplete_audio','未收到完整音频与完成回执，已停止并拒绝缓存。');
        record.networkFinished=true;this._clearTimer(record,'network');this._clearTimer(record,'total');this._pump(record);
      }finally{try{record.reader.releaseLock();}catch{}}
    }
    async _runReplay(record,cache){
      if(!await this._confirmCancellation(record))return;await this._prepareGraph(record);if(!this._valid(record))return;
      record.sourceURL=this.urls.createObjectURL(cache.blob);this._bindAudio(record);this.audio.src=record.sourceURL;this.audio.muted=this.muted;this.audio.load?.();this._requestPlay(record);
    }
    speak(character,words,{sessionId='',preview=false}={}){this.stop('新的试听替换上一段');return this._begin(this._snapshot(character,words,sessionId,preview));}
    replay(){
      const cache=this._last;this.stop('主动重播完整缓存');if(!cache)return Promise.resolve(this._notify(this._event(null,'blocked','no_audio','尚无完整的专业音频可重播。')));
      const snapshot=freeze({...cache.snapshot,request_id:'cloud-audio-'+(++this._serial),replay_of:cache.snapshot.request_id,captured_at:this._now()});return this._begin(snapshot,cache);
    }
    async playSequence(lines,sessionId=''){
      this.stop('新的对白替换上一段');const epoch=++this._queueEpoch;
      if(!Array.isArray(lines)||!lines.length)return freeze({status:'blocked',reason:'empty_sequence',receipts:[],unplayed:0,session_id:text(sessionId)});
      const snapshots=lines.map(line=>this._snapshot(line?.character,line?.text,sessionId,line?.preview)),receipts=[];let status='completed';
      for(const snapshot of snapshots){if(epoch!==this._queueEpoch){status='cancelled';break;}if(this._current){const prior=this._current;this._current=null;this._generation++;this._cleanup(prior);}const result=await this._begin(snapshot);receipts.push(result);if(result.status!=='completed'){status=result.status;break;}}
      if(status==='completed'&&epoch!==this._queueEpoch)status='cancelled';return freeze({status,session_id:text(sessionId),receipts,unplayed:snapshots.length-receipts.length});
    }
  }
  return Object.freeze({CloudAudioBus});
});
