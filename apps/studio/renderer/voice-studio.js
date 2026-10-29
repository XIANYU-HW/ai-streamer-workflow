(function(root){
  'use strict';
  const plain=(value,max=240)=>typeof value==='string'?value.slice(0,max):'';
  const finite=value=>Number.isFinite(value)&&value>=0?value:null;
  const iso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
  const expired=c=>c.activation_status!=='activated'&&c.expires_at!==null&&Date.parse(c.expires_at)<=Date.now();
  const activationLabel=c=>c.activation_status==='activated'?'已首次合成保留':expired(c)?'临时音色已过期，本轮不自动重建收费':
    '待首次合成保留'+(c.expires_at?' · '+c.expires_at.slice(0,10)+'前':' · 期限待核对');
  const spendingLockMessage='付费已关闭、额度已用完或有费用待核对；仍可播放已保存音频。';
  const designLockMessage=spendingLockMessage;
  const speechBudgetBlocked=s=>!s||s.spending_locked||s.unconfirmed_requests>0||s.remaining_usd<=0;
  function readStatus(next){
    if(!next||next.budget_mode!=='capped'||[next.budget_usd,next.committed_usd,next.remaining_usd].some(n=>finite(n)===null))throw Error('声音费用状态不完整。');
    return {enabled:next.enabled===true,has_key:next.has_key===true,credential_mode:next.credential_mode==='session'?'session':'saved',budget_mode:'capped',budget_scope:[],budget_authorization_id:null,usage_mode:'local_user',
      budget_usd:next.budget_usd,committed_usd:next.committed_usd,remaining_usd:next.remaining_usd,spending_locked:next.spending_locked===true,
      design_budget_usd:next.budget_usd,design_remaining_usd:next.remaining_usd,design_spending_locked:next.spending_locked===true,
      unconfirmed_requests:Number.isSafeInteger(next.unconfirmed_requests)&&next.unconfirmed_requests>=0?next.unconfirmed_requests:1};
  }
  function createController({api,getApp,media,getField,makeEvent,timers=root,onChange=()=>{},onMessage=()=>{}}){
    let status=null,candidates=[],systemVoices=[],busy=false,ready=false,refreshEpoch=0,playEpoch=0,player=null,audioURL=null,playingId=null,playGuard=null,cloudCandidateId=null;
    const app=()=>getApp?.()||{};
    const appState=()=>{try{return app().getVoiceStudioState?.()||{};}catch{return{};}};
    const canPlay=()=>{try{return app().canPlayVoicePreview?.()===true;}catch{return false;}};
    const characters=()=>Array.isArray(appState().characters)?appState().characters:[];
    const findCharacter=characterId=>characters().find(c=>c.character_id===characterId)||null;
    const snapshot=()=>({status:status?{...status,budget_scope:[]}:null,candidates:candidates.map(c=>({...c,expired:expired(c),activation_label:activationLabel(c)})),systemVoices:[],busy,ready,playingId,cloudCandidateId,
      roles:characters().map(c=>({character_id:c.character_id,name:c.name})),canPlay:canPlay()});
    const emit=()=>onChange(snapshot());
    const say=(message,error=false)=>onMessage(plain(message,400),error);
    const failure=(error,fallback)=>say(plain(error?.message,300)||fallback,true);
    function stopPreview(reason){
      ++playEpoch;const old=player,url=audioURL;player=null;audioURL=null;playingId=null;
      if(playGuard!==null){timers.clearInterval(playGuard);playGuard=null;}
      if(old){old.onended=null;old.onerror=null;try{old.pause();old.currentTime=0;old.removeAttribute('src');old.load();}catch{}}
      if(url)media.revokeURL(url);
      if(reason)say(reason);emit();
    }
    async function refresh(){
      const epoch=++refreshEpoch;
      try{
        const [next,list,systems]=await Promise.all([api.voiceStatus(),api.voiceCandidates(),typeof api.voiceSystemOptions==='function'?api.voiceSystemOptions():[]]);
        if(epoch!==refreshEpoch)return false;
        if(!Array.isArray(list))throw Error('声音服务状态不完整，请刷新后再试。');
        status=readStatus(next);
        candidates=list.filter(c=>c&&typeof c.candidate_id==='string'&&typeof c.character_id==='string'&&typeof c.voice_id==='string').slice(0,128).map(c=>({
          candidate_id:c.candidate_id,character_id:c.character_id,label:plain(c.label)||'已保存候选',voice_id:c.voice_id,format:c.format,variant:c.variant,
          profile_id:c.profile_id,sample:plain(c.preview_text||c.sample,1000),activation_status:c.activation_status==='activated'?'activated':'temporary',expires_at:iso(c.expires_at),activated_at:iso(c.activated_at)}));
        systemVoices=[];
        ready=true;emit();return true;
      }catch(error){if(epoch===refreshEpoch){ready=false;emit();failure(error,'声音状态读取失败，请稍后刷新。');}return false;}
    }
    async function configureKey(input,sessionOnly){
      // Clear the only editable copy before crossing the asynchronous IPC boundary.
      const key=typeof input?.value==='string'?input.value.trim():'';if(input)input.value='';
      if(busy){say('上一项仍在处理，请完成后重新填写密钥。',true);return false;}
      if(!key){say('请先填写 MiniMax 国际站 API Key。',true);return false;}
      busy=true;emit();stopPreview();app().stopAudio?.('切换声音密钥，停止旧试听');
      try{if(sessionOnly)await api.useVoiceSessionKey(key);else await api.saveVoiceKey(key);await refresh();say(sessionOnly?'密钥仅供本次运行使用，应用不持久保存；完整退出后失效。输入框已清空。':'密钥已加密保存到这台电脑，输入框已清空。');return true;}
      catch{say(sessionOnly?'本次密钥未能启用，输入框已清空。未自动改用已保存密钥。':'密钥未能保存，输入框已清空。请检查密钥和本机加密设置后重新填写。',true);return false;}
      finally{busy=false;emit();}
    }
    const saveKey=input=>configureKey(input,false),useSessionKey=input=>configureKey(input,true);
    async function clearSessionKey(){
      if(busy)return false;busy=true;stopPreview();app().stopAudio?.('清除本次声音密钥，停止旧试听');emit();
      try{await api.clearVoiceSessionKey();await refresh();say('本次密钥已清除；没有改用本机已保存密钥。');return true;}
      catch{say('清除状态尚未确认，请完整退出工作室结束本次使用。',true);return false;}
      finally{busy=false;emit();}
    }
    async function design(characterId,variant,service){
      if(busy)return false;
      if(!canPlay()){say('请先结束当前场次，取消静音并等待保存完成，再设计声音。',true);return false;}
      const character=findCharacter(characterId);
      if(!ready||!status?.has_key){say('请先保存密钥并刷新声音状态。',true);return false;}
      if(status.design_spending_locked){say(designLockMessage,true);return false;}
      if(!character||!['A','B'].includes(variant)||service!=='minimax'){say('请明确选择设计服务与已保存的角色。',true);return false;}
      if(candidates.length>=128){say('候选库达到上限，请先整理。');return false;}
      if(candidates.some(c=>c.character_id===character.character_id&&c.variant===variant)){say('这个候选已经生成，可直接试听。');return false;}
      if(status.unconfirmed_requests){say('有请求费用尚待核对，先保留预算；本面板不会重复生成。',true);return false;}
      if(status.design_remaining_usd<=3){say('候选设计的剩余预算不足以预留音色设计与试听费用。',true);return false;}
      app().stopAudio?.('开始设计声音，停止旧试听');
      if(!canPlay())return false;
      busy=true;stopPreview();emit();say('正在设计 '+character.name+' '+variant+'，请稍候；不会自动重试。');
      try{
        // The main process resolves the saved character description. No biography,
        // memory, current script, or credential is sent by this renderer action.
        await api.designVoice({character_id:character.character_id,variant,service});
        await refresh();say('候选已保存。点击“试听”播放已保存音频，不再生成或收费。');return true;
      }catch(error){await refresh();failure(error,'本次设计未完成，请先核对状态；没有自动重试。');return false;}
      finally{busy=false;emit();}
    }
    async function preview(id){
      const candidate=candidates.find(c=>c.candidate_id===id);
      if(!candidate||busy)return false;
      if(!canPlay()){say('请先结束当前场次，取消静音并等待保存完成，再试听候选。',true);return false;}
      stopPreview();app().stopAudio?.('开始候选试听，停止其他声音');
      if(!canPlay())return false;
      const epoch=++playEpoch;playingId=id;emit();say('正在读取已保存的试听音频…');
      try{
        const result=await api.voicePreview(id);
        if(epoch!==playEpoch)return false;
        if(!canPlay()){stopPreview();return false;}
        const mime={mp3:'audio/mpeg',wav:'audio/wav',flac:'audio/flac',ogg:'audio/ogg'}[result?.format];
        if(!mime||typeof result.audio!=='string'||result.audio.length<4||result.audio.length>16*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(result.audio))throw Error('保存的试听音频格式无效。');
        const bytes=media.decodeBase64(result.audio);if(!bytes.length)throw Error('保存的试听音频为空。');
        audioURL=media.createURL(bytes,mime);player=media.createAudio();const current=player;current.src=audioURL;
        current.onended=()=>{if(epoch===playEpoch)stopPreview('试听结束。可再次试听，或填入角色声音档案。');};
        current.onerror=()=>{if(epoch===playEpoch){stopPreview();say('这段音频未能播放，请检查声音输出后重试试听。',true);}};
        playGuard=timers.setInterval(()=>{if(epoch===playEpoch&&!canPlay())stopPreview('工作室状态已改变，候选试听已停止。');},100);
        playGuard?.unref?.();
        await current.play();
        if(epoch!==playEpoch){try{current.pause();}catch{}return false;}
        if(!canPlay()){stopPreview();return false;}
        say('正在试听 '+candidate.label+' · 已保存音频，不再收费');emit();return true;
      }catch(error){if(epoch===playEpoch){stopPreview();failure(error,'试听未能播放。');}return false;}
    }
    async function streamPreview(id){
      const candidate=candidates.find(c=>c.candidate_id===id);if(!candidate||busy)return false;
      if(!ready||!status?.has_key){say('请先保存密钥并刷新声音状态。',true);return false;}
      if(status.spending_locked){say(spendingLockMessage,true);return false;}
      if(expired(candidate)){say('临时音色已过期，本轮不自动重建收费；仍可试听已保存音频。',true);emit();return false;}
      if(!canPlay()){say('请先结束当前场次，取消静音并等待保存完成，再流式试播。',true);return false;}
      if(speechBudgetBlocked(status)){say('费用尚待核对或当前语音可用预算不足，未发起新的试播。',true);return false;}
      const chosenModel=getField?.('cloudVoiceModel')?.value;if(!['speech-2.8-turbo','speech-2.8-hd'].includes(chosenModel)){say('请先明确选择声音模型。',true);return false;}
      const host=app();if(typeof host.previewCloudCandidate!=='function'){say('流式试播尚未就绪，请稍后刷新。',true);return false;}
      stopPreview();busy=true;cloudCandidateId=id;emit();say('正在流式试播 '+candidate.label+'；使用你所选的声音模型与当前有限预算，不会自动重试。');
      try{
        // The host owns the one shared voice bus and stops old playback before
        // generating this saved sample. No form, character, or memory is saved.
        const result=await host.previewCloudCandidate({...candidate});
        await refresh();
        if(result?.status!=='completed'){say('流式试播未完整结束，请查看音色保留状态；没有自动重试。',result?.status==='failed');return false;}
        const activated=candidates.find(c=>c.candidate_id===id)?.activation_status==='activated';
        say(activated?'流式试播已完成，音色已首次合成保留。尚未修改角色选择。':'流式试播已完成，音色保留状态待核对。尚未修改角色选择。');return true;
      }catch(error){await refresh();failure(error,'本次流式试播未完成，没有自动重试。');return false;}
      finally{busy=false;cloudCandidateId=null;emit();}
    }
    async function setBudget(input){
      if(busy||typeof api.setSpendingPolicy!=='function')return false;
      busy=true;stopPreview();emit();
      try{await api.setSpendingPolicy(input);await refresh();say('本机累计费用设置已保存；没有发送语音请求。');return true;}
      catch(error){failure(error,'费用设置未保存。');return false;}
      finally{busy=false;emit();}
    }
    async function stop(){stopPreview('已停止候选试听。');app().stopAudio?.('已停止候选试听与流式试播');try{await api.cancelVoice();}catch{say('本机已静音，服务端取消状态未确认。',true);}await refresh();}
    async function applyCandidate(id){
      const candidate=candidates.find(c=>c.candidate_id===id)||systemVoices.find(c=>c.candidate_id===id);if(!candidate||busy||!ready)return false;
      if(expired(candidate)){say('临时音色已过期，本轮不自动重建收费；仍可试听已保存音频。',true);emit();return false;}
      stopPreview();const host=app();
      try{
        if(typeof host.selectCharacterForVoice==='function'&&await host.selectCharacterForVoice(candidate.character_id)===false)return false;
        if(expired(candidate)){say('临时音色已过期，本轮不自动重建收费；仍可试听已保存音频。',true);emit();return false;}
        if(appState().selected_character_id!==candidate.character_id){say('请先在角色档案中选中这条候选所属的角色。',true);return false;}
        const entries=[['voiceProvider','professional_pending'],['voiceService','minimax'],['voiceId',candidate.voice_id]];
        const fields=entries.map(([id,value])=>({field:getField(id),value}));
        if(fields.some(({field})=>!field)){say('角色声音表单尚未就绪，请打开角色档案后再选。',true);return false;}
        for(const {field,value}of fields)field.value=value;
        for(const {field}of fields){field.dispatchEvent(makeEvent('input'));field.dispatchEvent(makeEvent('change'));}
        say('已填入这位角色的声音档案，请点击“保存角色”确认。');emit();return true;
      }catch(error){failure(error,'未能选择角色声音，请检查当前角色。');return false;}
    }
    return{refresh,saveKey,useSessionKey,clearSessionKey,design,preview,streamPreview,setBudget,stop,stopPreview,applyCandidate,snapshot};
  }
  function mount(){
    if(!root.document||!root.studioDesktop||root.document.getElementById('voiceStudioPanel'))return null;
    const doc=root.document,api=root.studioDesktop;
    if(!['voiceStatus','voiceCandidates','saveVoiceKey','designVoice','voicePreview','cancelVoice'].every(name=>typeof api[name]==='function'))return null;
    const node=(tag,text,className)=>{const el=doc.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
    const btn=(label,action)=>{const b=node('button',label);b.type='button';b.addEventListener('click',action);return b;};
    const panel=node('details',undefined,'voice-studio');panel.id='voiceStudioPanel';panel.open=false;
    panel.append(node('summary','声音服务与候选'),node('p','新安装不启用付费。先选择服务、设置有限的累计费用上限并配置自己的密钥；每次生成都由你点击发起。'));
    const service=node('select');service.setAttribute('aria-label','声音设计服务');
    for(const [value,label] of [['','请选择服务'],['minimax','MiniMax']]){const option=node('option',label);option.value=value;service.append(option);}
    panel.append(service,node('p','当前内置 MiniMax 适配器；声音设计端点不接受模型参数。流式试播前请在声音试听台明确选择已支持的声音模型。','small muted'));
    const modelLabel=node('label','流式声音模型'),model=doc.getElementById('cloudVoiceModel')||node('select');model.id='cloudVoiceModel';
    if(!model.options.length){for(const [value,label] of [['','请选择声音模型'],['speech-2.8-turbo','MiniMax speech-2.8-turbo'],['speech-2.8-hd','MiniMax speech-2.8-hd']]){const option=node('option',label);option.value=value;model.append(option);}}
    modelLabel.append(model);panel.append(modelLabel);
    const budget=node('p','尚未读取费用状态'),enabled=node('input');enabled.type='checkbox';enabled.setAttribute('aria-label','允许付费请求');
    const enableLabel=node('label','允许付费请求 ');enableLabel.append(enabled);
    const amount=node('input');amount.type='number';amount.min='0';amount.max='1000000';amount.step='0.01';amount.value='0';amount.setAttribute('aria-label','累计费用上限美元');
    const amountLabel=node('label','累计费用上限（美元）');amountLabel.append(amount);
    const saveBudget=btn('保存费用设置',()=>void controller.setBudget({enabled:enabled.checked,budget_usd:Number(amount.value)}));
    panel.append(budget,enableLabel,amountLabel,saveBudget,node('p','上限包含本机已有累计估算。估算与预留并非供应商最终账单；不会自动充值，导入资料不会启用费用权限。候选设计预留费用按适配器估算，使用前请核对官方定价。','small muted'));
    const keyLabel=node('label','所选服务 API Key'),key=node('input');key.type='password';key.autocomplete='off';key.spellcheck=false;key.maxLength=8192;keyLabel.append(key);
    const useSession=btn('仅本次使用',()=>void controller.useSessionKey(key)),save=btn('加密保存到本机',()=>void controller.saveKey(key)),clearSession=btn('清除本次密钥',()=>void controller.clearSessionKey());
    panel.append(keyLabel,useSession,save,clearSession);const keyStatus=node('p','','small muted');panel.append(keyStatus);
    const role=node('select');role.setAttribute('aria-label','声音候选所属角色');const designA=btn('生成候选 A',()=>void controller.design(role.value,'A',service.value)),designB=btn('生成候选 B',()=>void controller.design(role.value,'B',service.value));
    panel.append(node('h3','从已保存的角色设计声音'),role,designA,designB,node('p','只发送该角色的声音描述、发声风格与试读文本。已保存音频可反复试听，不再次合成。','small muted'));
    const refresh=btn('刷新状态',()=>void controller.refresh()),stop=btn('停止试听',()=>void controller.stop());panel.append(refresh,stop);
    const message=node('p');message.setAttribute('role','status');message.setAttribute('aria-live','polite');const list=node('div');panel.append(message,list);
    let latest=null;
    const updateDesign=()=>{const state=latest,blocked=!state||state.busy||!state.ready||!state.canPlay||!state.status?.has_key||speechBudgetBlocked(state.status)||service.value!=='minimax'||!role.value;designA.disabled=blocked;designB.disabled=blocked;};
    service.addEventListener('change',updateDesign);role.addEventListener('change',updateDesign);
    const controller=createController({api,getApp:()=>root.StudioApp,getField:id=>doc.getElementById(id),makeEvent:type=>new root.Event(type,{bubbles:true}),
      media:{decodeBase64:value=>Uint8Array.from(root.atob(value),c=>c.charCodeAt(0)),createURL:(bytes,mime)=>root.URL.createObjectURL(new root.Blob([bytes],{type:mime})),revokeURL:url=>root.URL.revokeObjectURL(url),createAudio:()=>new root.Audio()},
      onMessage:(text,error)=>{message.textContent=text;message.style.color=error?'var(--danger)':'';},
      onChange:state=>{latest=state;const s=state.status;
        budget.textContent=s?`累计上限 US$${s.budget_usd.toFixed(2)}；累计估算 US$${s.committed_usd.toFixed(3)}；剩余 US$${s.remaining_usd.toFixed(3)}；未确认 ${s.unconfirmed_requests} 项`:'声音状态未就绪';
        if(doc.activeElement!==amount&&doc.activeElement!==enabled&&s){enabled.checked=s.enabled;amount.value=String(s.budget_usd);}
        keyStatus.textContent=s?.credential_mode==='session'?(s.has_key?'密钥仅本次运行可用。':'本次密钥为空；不自动读取已保存密钥。'):(s?.has_key?'此公开版资料目录有加密密钥；使用时再验证。':'尚未保存密钥。');
        save.disabled=useSession.disabled=key.disabled=refresh.disabled=state.busy;clearSession.disabled=state.busy||s?.credential_mode!=='session'||!s?.has_key;saveBudget.disabled=state.busy||typeof api.setSpendingPolicy!=='function';
        const selected=role.value;role.replaceChildren();const blank=node('option',state.roles.length?'请选择角色':'请先创建角色');blank.value='';role.append(blank);for(const r of state.roles){const opt=node('option',r.name);opt.value=r.character_id;role.append(opt);}if(state.roles.some(r=>r.character_id===selected))role.value=selected;updateDesign();
        list.replaceChildren();if(!state.candidates.length)list.append(node('p','候选库为空。'));
        for(const c of state.candidates){const row=node('section'),label=node('b',c.label),note=node('p',c.activation_label,'small muted'),play=btn('播放已保存音频',()=>void controller.preview(c.candidate_id)),stream=btn('流式试播（计费）',()=>void controller.streamPreview(c.candidate_id)),apply=btn('填入角色声音档案',()=>void controller.applyCandidate(c.candidate_id));
          play.disabled=state.busy||!state.canPlay;stream.disabled=state.busy||!state.canPlay||!s?.has_key||speechBudgetBlocked(s)||c.expired;apply.disabled=state.busy||c.expired;row.append(label,note,play,stream,apply);list.append(row);}
      }});
    (doc.querySelector('main')||doc.body).append(panel);const clearKey=()=>{key.value='';};
    root.addEventListener('beforeunload',()=>{clearKey();controller.stopPreview();});root.addEventListener('pagehide',()=>{clearKey();controller.stopPreview();});
    panel.addEventListener('toggle',()=>{if(panel.open)void controller.refresh();else controller.stopPreview();});
    const publicAPI={stopPreview:reason=>controller.stopPreview(reason),refresh:()=>controller.refresh(),show:()=>{panel.open=true;panel.scrollIntoView({block:'start',behavior:'auto'});void controller.refresh();},clearKey};
    Object.assign(root.StudioVoiceStudio,publicAPI);void controller.refresh();return publicAPI;
  }
  const exported={createController,mount};
  if(typeof module==='object'&&module.exports)module.exports=exported;
  else{root.StudioVoiceStudio={stopPreview:()=>{},refresh:async()=>false,mount};if(root.document.readyState==='loading')root.document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();}
})(typeof globalThis!=='undefined'?globalThis:this);
