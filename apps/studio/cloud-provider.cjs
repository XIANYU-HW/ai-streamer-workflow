'use strict';

// Official MiniMax synchronous TTS and Voice Design contracts are saved in
// Credentials are obtained per request; neither credentials nor provider bodies
// are attached to errors, persisted, or logged by this module.
const BASE='https://api.minimax.io';
const MODELS=new Set(['speech-2.8-turbo','speech-2.8-hd']);
const MAX_EVENT=2*1024*1024,MAX_JSON=8*1024*1024;
const MAX_AUDIO=64*1024*1024,MAX_WIRE=160*1024*1024;
const MESSAGES={INVALID_REQUEST:'云语音参数无效。',MISSING_KEY:'请先设置云语音密钥。',KEYCHAIN_TIMEOUT:'系统密钥授权仍未完成；请本人处理 macOS 钥匙串授权，或在声音设置中重新保存密钥。未发送语音请求。',CANCELLED:'云语音请求已取消。',NETWORK_ERROR:'无法连接云语音服务。',HTTP_ERROR:'云语音服务未能接受请求。',PROVIDER_ERROR:'云语音服务返回错误，请检查账户与设置。',MALFORMED_RESPONSE:'云语音服务返回了无法识别的数据。',RESPONSE_TOO_LARGE:'云语音服务返回的数据超过本地限制。',INCOMPLETE_STREAM:'云语音连接提前结束，未确认合成完成。',CALLBACK_ERROR:'无法处理云语音播放数据。'};
class ProviderError extends Error{constructor(code){super(MESSAGES[code]);this.name='ProviderError';this.code=code;}}
const fail=code=>new ProviderError(code);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function string(value,max){return typeof value==='string'&&value.trim().length>0&&[...value].length<=max;}
function voice(value){return string(value,256)&&!/[\x00-\x1f\x7f]/.test(value);}
function number(value,min,max){return typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;}
function streamBody(input){
  if(!object(input)||!string(input.text,9999)||!voice(input.voice_id))throw fail('INVALID_REQUEST');
  const {text,voice_id,model,rate=1,pitch=1,volume=1}=input;
  if(!MODELS.has(model)||!number(rate,.5,2)||!number(pitch,.5,2)||!number(volume,Number.MIN_VALUE,1))throw fail('INVALID_REQUEST');
  return {model,text,stream:true,stream_options:{exclude_aggregated_audio:true},language_boost:'Chinese',output_format:'hex',voice_setting:{voice_id,speed:rate,vol:volume,pitch:Math.round(12*Math.log2(pitch))},audio_setting:{sample_rate:32000,bitrate:128000,format:'mp3',channel:1}};
}
function designBody(input){
  // The service does not document a prompt maximum; 4,000 code points is a
  // deliberate local input limit. Its preview_text maximum is 500.
  if(!object(input)||!string(input.prompt,4000)||!string(input.preview_text,500)||(input.voice_id!==undefined&&!voice(input.voice_id)))throw fail('INVALID_REQUEST');
  return {prompt:input.prompt,preview_text:input.preview_text,...(input.voice_id===undefined?{}:{voice_id:input.voice_id})};
}
function operation(signal){
  const controller=new AbortController();let rejectAbort;
  const aborted=new Promise((_,reject)=>rejectAbort=reject);aborted.catch(()=>{});
  const cancel=()=>{controller.abort();rejectAbort(fail('CANCELLED'));};
  if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  return {signal:controller.signal,check(){if(controller.signal.aborted)throw fail('CANCELLED');},async wait(promise){this.check();const value=await Promise.race([Promise.resolve(promise),aborted]);this.check();return value;},dispose(){signal?.removeEventListener('abort',cancel);controller.abort();}};
}
function discardBody(body){try{const pending=body?.cancel?.();pending?.catch?.(()=>{});}catch{}}
function closeReader(reader){try{const pending=reader?.cancel?.();pending?.catch?.(()=>{});}catch{}try{reader?.releaseLock?.();}catch{}}
function decodeJSON(text){try{return JSON.parse(text);}catch{throw fail('MALFORMED_RESPONSE');}}
function baseStatus(value){
  if(!object(value)||!object(value.base_resp)||!Number.isSafeInteger(value.base_resp.status_code))throw fail('MALFORMED_RESPONSE');
  if(value.base_resp.status_code!==0){const error=fail('PROVIDER_ERROR');error.provider_status=value.base_resp.status_code;throw error;}
}
function hex(value){if(typeof value!=='string'||value.length%2!==0||!/^[\da-f]*$/i.test(value))throw fail('MALFORMED_RESPONSE');return Buffer.from(value,'hex');}
function audioFormat(bytes){
  if(bytes.length>=3&&(bytes.subarray(0,3).toString('ascii')==='ID3'||(bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0)))return 'mp3';
  if(bytes.length>=12&&bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WAVE')return 'wav';
  if(bytes.subarray(0,4).toString('ascii')==='fLaC')return 'flac';
  if(bytes.subarray(0,4).toString('ascii')==='OggS')return 'ogg';
  throw fail('MALFORMED_RESPONSE');
}
async function readJSON(response,op){
  let reader;try{
    if(!response.body?.getReader)throw fail('MALFORMED_RESPONSE');reader=response.body.getReader();
    const chunks=[];let total=0;
    while(true){const part=await op.wait(reader.read());if(part.done)break;if(!(part.value instanceof Uint8Array))throw fail('MALFORMED_RESPONSE');total+=part.value.byteLength;if(total>MAX_JSON)throw fail('RESPONSE_TOO_LARGE');chunks.push(Buffer.from(part.value));}
    return decodeJSON(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
  }catch(error){if(error instanceof ProviderError)throw error;if(op.signal.aborted)throw fail('CANCELLED');throw fail('MALFORMED_RESPONSE');}finally{closeReader(reader);}
}
class MiniMaxProvider{
  constructor({getKey,fetchImpl=globalThis.fetch,keyTimeoutMs=15000}={}){if(typeof getKey!=='function'||typeof fetchImpl!=='function')throw fail('INVALID_REQUEST');this.getKey=getKey;this.fetchImpl=fetchImpl;this.keyTimeoutMs=keyTimeoutMs;}
  async _request(endpoint,body,op,credential){
    op.check();let key=credential,timer;const timeoutError=fail('KEYCHAIN_TIMEOUT');
    try{
      // A successful manager preflight supplies a credential for this operation
      // only. It is never serialized into the request body or cached on us.
      if(key===undefined)key=await op.wait(Promise.race([Promise.resolve().then(()=>{op.check();return this.getKey();}),new Promise((_,reject)=>timer=setTimeout(()=>reject(timeoutError),this.keyTimeoutMs))]));
      op.check();
    }catch(error){if(op.signal.aborted)throw fail('CANCELLED');if(error===timeoutError)throw timeoutError;throw fail('MISSING_KEY');}finally{clearTimeout(timer);}
    if(typeof key!=='string'||!key.trim()||key.length>16384||/[\r\n]/.test(key))throw fail('MISSING_KEY');
    let response;try{
      const pending=Promise.resolve(this.fetchImpl(BASE+endpoint,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json',Accept:endpoint==='/v1/t2a_v2'?'text/event-stream':'application/json'},body:JSON.stringify(body),signal:op.signal})).then(value=>{if(op.signal.aborted)discardBody(value?.body);return value;});
      response=await op.wait(pending);
    }catch(error){if(op.signal.aborted)throw fail('CANCELLED');throw fail('NETWORK_ERROR');}
    finally{key=undefined;}
    if(!response?.ok){discardBody(response?.body);const error=fail('HTTP_ERROR');if(Number.isSafeInteger(response?.status))error.http_status=response.status;throw error;}
    return response;
  }
  async stream(input,{signal,onEvent,credential,allowMissingUsage=false}={}){
    const body=streamBody(input);if(typeof onEvent!=='function')throw fail('INVALID_REQUEST');
    const started=performance.now(),op=operation(signal);let reader,response;
    try{
      response=await this._request('/v1/t2a_v2',body,op,credential);
      const type=response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase();
      if(type==='application/json'){baseStatus(await readJSON(response,op));throw fail('MALFORMED_RESPONSE');}
      if(type!=='text/event-stream'||!response.body?.getReader)throw fail('MALFORMED_RESPONSE');
      reader=response.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});
      let line='',skipLF=false,data=[],eventBytes=0,wireBytes=0,audioBytes=0,firstAudio=null,done=null;
      const emit=async event=>{op.check();try{await op.wait(onEvent(event));}catch(error){if(op.signal.aborted)throw fail('CANCELLED');throw fail('CALLBACK_ERROR');}};
      const packet=async raw=>{
        op.check();if(raw==='[DONE]'){if(!done)throw fail('INCOMPLETE_STREAM');return;}
        const value=decodeJSON(raw);baseStatus(value);
        if(!object(value.data)||![1,2].includes(value.data.status))throw fail('MALFORMED_RESPONSE');
        const terminal=value.data.status===2,bytes=hex(value.data.audio??'');
        const usage=value.extra_info?.usage_characters,missingUsage=usage===undefined||usage===null;
        if(terminal){
          if(value.extra_info!==undefined&&!object(value.extra_info))throw fail('MALFORMED_RESPONSE');
          if(missingUsage?allowMissingUsage!==true:!Number.isSafeInteger(usage)||usage<0)throw fail('MALFORMED_RESPONSE');
        }
        if(value.extra_info?.audio_format!==undefined&&value.extra_info.audio_format!=='mp3')throw fail('MALFORMED_RESPONSE');
        // A status=2 audio field is the full aggregate per the official schema.
        // Even if the service ignores exclude_aggregated_audio, play it only
        // when no incremental audio has already been delivered.
        if(bytes.length&&(!terminal||audioBytes===0)){
          audioBytes+=bytes.length;if(audioBytes>MAX_AUDIO)throw fail('RESPONSE_TOO_LARGE');
          if(firstAudio===null)firstAudio=Math.max(0,Math.round(performance.now()-started));
          await emit({type:'audio',audio:bytes.toString('base64'),format:'mp3'});
        }
        if(terminal){if(!audioBytes)throw fail('MALFORMED_RESPONSE');done={type:'done',usage_characters:missingUsage?null:usage,first_audio_byte_ms:firstAudio,format:'mp3'};await emit(done);}
      };
      const consumeLine=async()=>{
        const current=line;line='';
        if(current===''){
          if(data.length){const raw=data.join('\n');data=[];eventBytes=0;await packet(raw);}return;
        }
        if(current.startsWith(':'))return;
        const colon=current.indexOf(':'),field=colon<0?current:current.slice(0,colon);let value=colon<0?'':current.slice(colon+1);if(value.startsWith(' '))value=value.slice(1);
        if(field==='data'){eventBytes+=Buffer.byteLength(value)+1;if(eventBytes>MAX_EVENT)throw fail('RESPONSE_TOO_LARGE');data.push(value);}
      };
      const append=piece=>{line+=piece;if(Buffer.byteLength(line)+eventBytes>MAX_EVENT)throw fail('RESPONSE_TOO_LARGE');};
      const feed=async text=>{
        if(!text.length)return;
        if(skipLF){skipLF=false;if(text.startsWith('\n'))text=text.slice(1);}
        const delimiters=/[\r\n]/g;let match,start=0;
        while((match=delimiters.exec(text))){
          append(text.slice(start,match.index));let end=match.index+1;
          if(match[0]==='\r'){if(text[end]==='\n'){end++;delimiters.lastIndex=end;}else if(end===text.length)skipLF=true;}
          start=end;await consumeLine();if(done)return;
        }
        append(text.slice(start));
      };
      while(!done){
        const part=await op.wait(reader.read());if(part.done){await feed(decoder.decode());if(!done)throw fail('INCOMPLETE_STREAM');break;}
        if(!(part.value instanceof Uint8Array))throw fail('MALFORMED_RESPONSE');wireBytes+=part.value.byteLength;if(wireBytes>MAX_WIRE)throw fail('RESPONSE_TOO_LARGE');
        await feed(decoder.decode(part.value,{stream:true}));
      }
      op.check();return done;
    }catch(error){if(op.signal.aborted)throw fail('CANCELLED');if(error instanceof ProviderError)throw error;throw fail('MALFORMED_RESPONSE');}
    finally{closeReader(reader);if(!reader)discardBody(response?.body);op.dispose();}
  }
  async design(input,{signal,credential}={}){
    const body=designBody(input),op=operation(signal);let response;
    try{
      response=await this._request('/v1/voice_design',body,op,credential);
      if(response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw fail('MALFORMED_RESPONSE');
      const value=await readJSON(response,op);baseStatus(value);if(!voice(value.voice_id))throw fail('MALFORMED_RESPONSE');
      const audio=hex(value.trial_audio),format=audioFormat(audio);op.check();return {voice_id:value.voice_id,audio:audio.toString('base64'),format};
    }catch(error){if(op.signal.aborted)throw fail('CANCELLED');if(error instanceof ProviderError)throw error;throw fail('MALFORMED_RESPONSE');}
    finally{discardBody(response?.body);op.dispose();}
  }
}
module.exports={MiniMaxProvider};
