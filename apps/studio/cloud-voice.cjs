'use strict';
const crypto=require('node:crypto');
// Adapter estimates, not a billing guarantee. No model is selected implicitly.
const prices={'speech-2.8-turbo':60/1e6,'speech-2.8-hd':100/1e6};
const error=(code,message)=>Object.assign(new Error(message),{code});
const rejected=e=>e?.code==='PROVIDER_ERROR'&&[1004,1008].includes(e.provider_status)||e?.code==='HTTP_ERROR'&&[401,403].includes(e.http_status);
function actionable(e){if(e?.provider_status===1008)return error('INSUFFICIENT_BALANCE','MiniMax账户余额不足；软件不会自动充值。');if(e?.provider_status===1004||[401,403].includes(e?.http_status))return error('MISSING_KEY','服务未接受密钥，请检查服务和账户设置。');return e;}
class CloudVoice{
 constructor({vault,provider,getWorkspace,keyTimeoutMs=15000,assertCanStart=()=>{}}){this.vault=vault;this.provider=provider;this.getWorkspace=getWorkspace;this.keyTimeoutMs=keyTimeoutMs;this.assertCanStart=assertCanStart;this.active=null;}
 async cancel(){this.active?.controller.abort();}
 async _run(fn,signal){this.assertCanStart();if(this.active)throw error('BUSY','上一项声音任务仍在处理。');const controller=new AbortController(),op={controller};this.active=op;const timeout=setTimeout(()=>controller.abort(),120000);timeout.unref?.();const combined=signal?AbortSignal.any([controller.signal,signal]):controller.signal;try{if(combined.aborted)throw error('CANCELLED','声音任务已取消。');return await fn(combined);}finally{clearTimeout(timeout);if(this.active===op)this.active=null;}}
 async _key(signal){
  if(signal?.aborted)throw error('CANCELLED','声音任务已取消。');let timer,abort;
  const timeoutError=error('KEYCHAIN_TIMEOUT','本机密钥授权未完成；没有发送语音请求。');
  const interrupted=new Promise((_,reject)=>{timer=setTimeout(()=>reject(timeoutError),this.keyTimeoutMs);abort=()=>reject(error('CANCELLED','声音任务已取消。'));signal?.addEventListener('abort',abort,{once:true});});
  try{const key=await Promise.race([Promise.resolve().then(()=>{if(signal?.aborted)throw error('CANCELLED','声音任务已取消。');return this.vault.getKey();}),interrupted]);if(signal?.aborted)throw error('CANCELLED','声音任务已取消。');return key;}
  catch(e){if(signal?.aborted)throw error('CANCELLED','声音任务已取消。');if(e===timeoutError)throw timeoutError;throw error('MISSING_KEY','请先配置所选语音服务的密钥。');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
 }
 async _reserve(input){try{return await this.vault.reserve(input);}catch(e){if(['BUDGET_EXCEEDED','SPENDING_LOCKED','BUDGET_STATE_UNKNOWN','INVALID_REQUEST'].includes(e?.code))throw error(e.code,e.message);throw error('BUDGET_STATE_UNKNOWN','费用记录暂不可用，未发送新请求。');}}
 async design(v){
  if(!v||Object.keys(v).sort().join(',')!=='character_id,service,variant'||v.service!=='minimax'||typeof v.character_id!=='string'||!['A','B'].includes(v.variant))throw error('INVALID_REQUEST','请明确选择设计服务、角色和候选方向。');
  return this._run(async signal=>{
   const {data}=await this.getWorkspace(),c=data?.characters?.find(x=>x.character_id===v.character_id);if(!c)throw error('INVALID_REQUEST','请先创建并保存这位角色。');
   if(data.active_session_id)throw error('BUSY','请先结束本场，再设计声音。');
   const existing=(await this.vault.candidates()).find(x=>x.character_id===v.character_id&&x.profile_id===c.voice.profile_id&&x.variant===v.variant);
   if(existing){if(existing.expires_at&&Date.parse(existing.expires_at)<=Date.now())throw error('VOICE_NOT_READY','临时音色已过期；不会自动重新生成收费。');return existing;}
   if(typeof c.voice.description!=='string'||!c.voice.description.trim()||typeof c.voice.sample!=='string'||!c.voice.sample.trim())throw error('INVALID_REQUEST','请先保存声音描述和试读文本。');
   const prompt=c.voice.description.slice(0,1800)+'\n发声风格：'+String(c.voice.style||'').slice(0,120)+'\n候选变化：'+(v.variant==='A'?'自然清楚，忠实于所填声音描述。':'保持所填声音特征，轻微变化语气与节奏。');
   const preview_text=Array.from(c.voice.sample).slice(0,500).join('');
   const estimate=3+Buffer.byteLength(preview_text,'utf8')*prices['speech-2.8-hd'];
   const job=await this._reserve({kind:'design',estimate_usd:estimate});let dispatched=false;
   try{const credential=await this._key(signal);if(signal.aborted)throw error('CANCELLED','声音任务已取消。');dispatched=true;
    const result=await this.provider.design({prompt,preview_text},{signal,credential});if(signal.aborted)throw error('CANCELLED','声音任务已取消。');
    const candidate={candidate_id:'candidate-'+crypto.randomUUID(),character_id:c.character_id,profile_id:c.voice.profile_id,variant:v.variant,label:c.name+' · '+v.variant,voice_id:result.voice_id,format:result.format,design_job_id:job,preview_text,description:prompt,estimated_allowance_usd:Math.round(estimate*1e6)/1e6,human_rating:null,activation_status:'temporary',activated_at:null,expires_at:new Date(Date.now()+168*60*60*1000).toISOString()};
    const saved=await this.vault.addCandidate(candidate,Buffer.from(result.audio,'base64'));await this.vault.settle(job,{estimated_cost_usd:estimate});return saved;
   }catch(e){await this.vault.settle(job,dispatched&&!rejected(e)?{unknown:true}:{estimated_cost_usd:0});if(signal.aborted)throw error('CANCELLED','声音任务已取消；已发送请求保留预留费用。');throw actionable(e);}
  });
 }
 async stream(v,{signal,onEvent=async()=>{}}={}){
  const keys='character_id,model,pitch,profile_id,rate,text,voice_id,volume';
  if(!v||Object.keys(v).sort().join(',')!==keys||typeof v.text!=='string'||!v.text.trim()||Array.from(v.text).length>2000||!Object.hasOwn(prices,v.model)||typeof v.voice_id!=='string'||typeof v.profile_id!=='string'||typeof v.character_id!=='string'||!Number.isFinite(v.rate)||v.rate<.5||v.rate>2||!Number.isFinite(v.pitch)||v.pitch<.5||v.pitch>2||!Number.isFinite(v.volume)||v.volume<=0||v.volume>1)throw error('INVALID_REQUEST','请明确选择已支持的声音模型，并检查声音档案。');
  return this._run(async liveSignal=>{
   const {data}=await this.getWorkspace(),character=data?.characters?.find(c=>c.character_id===v.character_id&&c.voice?.profile_id===v.profile_id);
   if(!character)throw error('VOICE_NOT_READY','当前角色和声音档案不存在。');
   const candidate=(await this.vault.candidates()).find(c=>c.voice_id===v.voice_id&&c.character_id===v.character_id&&c.profile_id===v.profile_id);
   const savedBinding=character.voice.service==='minimax'&&character.voice.voice_id===v.voice_id&&!!v.voice_id;
   if(!candidate&&!savedBinding)throw error('VOICE_NOT_READY','请先保存此角色的音色，或选用属于它的设计候选。');
   if(candidate?.expires_at&&Date.parse(candidate.expires_at)<=Date.now())throw error('VOICE_NOT_READY','临时音色已过期，不会自动重新设计收费。');
   const job=await this._reserve({kind:'speech',estimate_usd:Buffer.byteLength(v.text,'utf8')*prices[v.model],voice_id:v.voice_id});let dispatched=false,receipt=null;
   try{const credential=await this._key(liveSignal);if(liveSignal.aborted)throw error('CANCELLED','声音任务已取消。');dispatched=true;
    const done=await this.provider.stream({text:v.text,voice_id:v.voice_id,model:v.model,rate:v.rate,pitch:v.pitch,volume:v.volume},{signal:liveSignal,credential,allowMissingUsage:false,onEvent:async e=>{if(liveSignal.aborted)throw error('CANCELLED','声音任务已取消。');if(e.type==='done'){receipt=e;return;}await onEvent(e);}});
    receipt=receipt||done;if(!Number.isSafeInteger(receipt?.usage_characters)||receipt.usage_characters<0)throw error('PROVIDER_ERROR','服务未返回完整用量，费用保留待核对。');
    const estimated_cost_usd=Math.round(receipt.usage_characters*prices[v.model]*1e6)/1e6;
    await this.vault.settle(job,{estimated_cost_usd,usage_characters:receipt.usage_characters});if(candidate)await this.vault.markActivated?.(candidate.candidate_id);
    if(liveSignal.aborted)throw error('CANCELLED','声音任务已取消。');const result={...receipt,estimated_cost_usd};await onEvent(result);return result;
   }catch(e){await this.vault.settle(job,dispatched&&!rejected(e)?{unknown:true}:{estimated_cost_usd:0});if(liveSignal.aborted)throw error('CANCELLED','声音任务已取消。');throw actionable(e);}
  },signal);
 }
}
module.exports={CloudVoice};
