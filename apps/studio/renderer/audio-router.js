(function(root,factory){
  'use strict';const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.StudioAudioRouter=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const copy=value=>JSON.parse(JSON.stringify(value));
  class AudioRouter{
    constructor(options={}){
      const Local=root.StudioLocalAudio?.LocalAudioBus||(typeof require==='function'?require('./local-audio.js').LocalAudioBus:null);
      const Cloud=root.StudioCloudAudio?.CloudAudioBus||(typeof require==='function'?require('./cloud-audio.js').CloudAudioBus:null);
      if(!Local||!Cloud)throw new Error('请先加载本机与专业语音播放器。');
      this._onStatus=typeof options.onStatus==='function'?options.onStatus:()=>{};this._onFrame=typeof options.onFrame==='function'?options.onFrame:()=>{};
      this._getLeaseOwner=typeof options.getLeaseOwner==='function'?options.getLeaseOwner:()=>'';this._active=null;this._lastEngine=null;this._epoch=0;this.muted=false;
      const wrap=name=>({...options,onStatus:event=>{
        if(this._active!==name)return;if(event.has_audio)this._lastEngine=name;
        try{this._onStatus(name==='local'?{...event,audio_mime:'audio/wav'}:event);}catch{}
      },onFrame:frame=>{if(this._active===name)try{this._onFrame(frame);}catch{}}});
      this.local=new Local(wrap('local'));this.cloud=new Cloud(wrap('cloud'));
    }
    get engine(){return this._active==='cloud'?this.cloud.engine:this.local.engine;}
    get capabilities(){return this._active==='cloud'?this.cloud.capabilities:this.local.capabilities;}
    capabilitiesFor(character){return this._choice(character)==='cloud'?this.cloud.capabilities:this.local.capabilities;}
    get _cancelBarrier(){return Promise.all([this.local._cancelBarrier,this.cloud._cancelBarrier]);}
    _choice(character){return character?.voice?.provider==='browser_local'?'local':'cloud';}
    _event(character,sessionId,status,reason,message){
      const event={request_id:null,character_id:character?.character_id||null,character_name:character?.name||'',session_id:sessionId||'',profile_id:character?.voice?.profile_id||null,text:'',status,reason,message,talking:false,has_audio:false,audio_verified:false};
      try{this._onStatus(event);}catch{}return event;
    }
    _stopEngines(reason){
      const active=this._active;let event;
      // Stop the active engine first so its final zero frame is observed. The
      // inactive engine's callbacks are filtered, including old native listeners.
      for(const name of active==='cloud'?['cloud','local']:['local','cloud']){const result=this[name].stop(reason);if(name===active)event=result;}
      this._active=null;return event;
    }
    stop(reason='已停止全部声音与动作'){this._epoch++;return this._stopEngines(reason)||this._event(null,'','stopped','stopped',reason);}
    async _waitStops(epoch){
      await Promise.allSettled([this.local._cancelBarrier,this.cloud._cancelBarrier]);if(epoch!==this._epoch)return false;
      // Both bundled buses retain a failed cancellation as required. Confirm it
      // before crossing engines; a local failure must not let a cloud call start.
      for(const name of ['local','cloud']){
        const bus=this[name];if(bus._cancelRequired){const owner=this._getLeaseOwner();if(!owner)throw new Error('没有有效的编辑连接。');await bus._queueCancellation(owner);}
        if(epoch!==this._epoch)return false;
      }
      return true;
    }
    async _route(character,text,options,epoch,replayEngine=null){
      this._stopEngines('切换音频，停止上一段');
      try{if(!await this._waitStops(epoch))return {status:'cancelled',reason:'replaced',talking:false,has_audio:false};}
      catch{if(epoch!==this._epoch)return {status:'cancelled',reason:'replaced'};return this._event(character,options.sessionId,'blocked','cancel_unconfirmed','旧音频的服务端取消尚未确认，未开始新请求；请稍后重试。');}
      if(epoch!==this._epoch)return {status:'cancelled',reason:'replaced'};
      const name=replayEngine||this._choice(character);this._active=name;
      return replayEngine?this[name].replay():this[name].speak(character,text,options);
    }
    speak(character,text,options={}){
      this.stop('新的试听替换上一段');const epoch=this._epoch;let captured;
      try{captured=copy(character);}catch{return Promise.resolve(this._event(character,options.sessionId,'blocked','invalid_character','角色资料格式无效。'));}
      return this._route(captured,text,{sessionId:options.sessionId||'',preview:options.preview===true},epoch);
    }
    async playSequence(lines,sessionId=''){
      this.stop('新的对白替换上一段');const epoch=this._epoch;let captured;
      try{if(!Array.isArray(lines)||!lines.length)throw new Error();captured=copy(lines);}catch{return {status:'blocked',reason:'empty_sequence',receipts:[],unplayed:0,session_id:sessionId};}
      const receipts=[];let status='completed';
      for(const line of captured){
        if(epoch!==this._epoch){status='cancelled';break;}
        const receipt=await this._route(line.character,line.text,{sessionId,preview:line.preview===true},epoch);receipts.push(receipt);
        if(receipt.status!=='completed'){status=receipt.status;break;}
      }
      if(status==='completed'&&epoch!==this._epoch)status='cancelled';return {status,session_id:sessionId,receipts,unplayed:captured.length-receipts.length};
    }
    replay(){const engine=this._lastEngine;this.stop('主动重播已生成的完整音频');if(!engine)return Promise.resolve(this._event(null,'','blocked','no_audio','尚无完整音频可重播。'));return this._route(null,'',{},this._epoch,engine);}
    setMuted(value){this.muted=!!value;if(this.muted)this.stop('已静音，所有音频与后续对白已取消');this.local.setMuted(this.muted);this.cloud.setMuted(this.muted);if(!this.muted)return this._event(null,'','unmuted','unmuted','已解除静音；请主动播放或重播。');}
    refreshVoices(){return this.local.refreshVoices();}
    setVoices(voices){return this.local.setVoices(voices);}
  }
  return Object.freeze({AudioRouter});
});
