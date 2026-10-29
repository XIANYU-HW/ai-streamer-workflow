'use strict';
// System speech only: fixed executable paths, argv/stdin, no shell and no network.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const MAX_WAV=8*1024*1024;
function error(message,code='SPEECH_FAILED'){return Object.assign(new Error(message),{code});}
function cancelled(){return error('本机语音已取消。','CANCELLED');}
function inspectWav(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<44||bytes.length>MAX_WAV||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw error('本机语音没有返回有效 WAV。');
  const end=bytes.readUInt32LE(4)+8;if(end>bytes.length||end<44)throw error('WAV 音频不完整。');
  let format=null,data=null;
  for(let i=12;i+8<=end;){
    const type=bytes.toString('ascii',i,i+4),size=bytes.readUInt32LE(i+4),start=i+8;
    if(start+size>end)throw error('WAV 音频块不完整。');
    if(type==='fmt '){
      if(format||size<16)throw error('WAV 格式块无效。');
      format={encoding:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),sampleRate:bytes.readUInt32LE(start+4),byteRate:bytes.readUInt32LE(start+8),align:bytes.readUInt16LE(start+12),bits:bytes.readUInt16LE(start+14)};
    }
    if(type==='data'){if(data)throw error('WAV 数据块重复。');data={offset:start,length:size};}
    i=start+size+(size%2);
  }
  if(!format||!data||format.encoding!==1||![1,2].includes(format.channels)||![8,16,24,32].includes(format.bits)||format.sampleRate<8000||format.sampleRate>192000||!data.length)throw error('WAV 音频格式不受支持。');
  const width=format.bits/8;
  if(format.align!==width*format.channels||format.byteRate!==format.sampleRate*format.align||data.length%format.align)throw error('WAV 音频帧不完整。');
  let peak=0;for(let i=data.offset;i<data.offset+data.length;i+=width){const n=width===1?bytes[i]-128:bytes.readIntLE(i,width);peak=Math.max(peak,Math.abs(n));}
  if(peak===0)throw error('本机语音返回了静音音频。');
  return {...format,...data,frames:data.length/format.align,duration:data.length/format.align/format.sampleRate,peak};
}
function scaleWav(bytes,volume){
  if(typeof volume!=='number'||!Number.isFinite(volume)||volume<=0||volume>1)throw error('音量范围无效。','INVALID_REQUEST');
  const info=inspectWav(bytes),out=Buffer.from(bytes),width=info.bits/8;
  for(let i=info.offset;i<info.offset+info.length;i+=width){const n=width===1?out[i]-128:out.readIntLE(i,width),scaled=Math.round(n*volume);if(width===1)out[i]=scaled+128;else out.writeIntLE(scaled,i,width);}
  inspectWav(out);return out;
}
function parseMacVoices(text){
  const items=[],seen=new Set();
  for(const line of text.split(/\r?\n/)){
    const m=line.match(/^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#/);if(!m)continue;
    const name=m[1].trim(),language=m[2].replace('_','-'),voice_id='mac-'+crypto.createHash('sha256').update(name+'\0'+language).digest('hex').slice(0,24);
    if(seen.has(voice_id))continue;seen.add(voice_id);items.push({voice_id,name,language,gender:'unknown',engine:'macos_local'});
  }
  return items;
}
class NativeSpeech{
  constructor({root=path.join(__dirname,'renderer'),platform=process.platform,spawnImpl=spawn,timeoutMs=30000}={}){
    this.root=root;this.platform=platform;this.spawn=spawnImpl;this.timeoutMs=timeoutMs;this._generation=0;this._children=new Set();this._jobs=new Set();this._voices=null;this._voicePromise=null;this._synthBusy=false;
    this.engine=platform==='darwin'?'macos_local':platform==='win32'?'windows_local':null;
    this.capabilities=Object.freeze({supported:!!this.engine,rate:!!this.engine,pitch:platform==='win32',volume:!!this.engine,professional:false,streaming:false,cancel:true,rate_mapping:platform==='darwin'?'200_words_per_minute_times_rate':'native_relative_rate'});
  }
  _check(generation){if(generation!==this._generation)throw cancelled();}
  _run(executable,args,{input='',maxBytes=12*1024*1024,generation=this._generation}={}){
    this._check(generation);
    let proc;try{proc=this.spawn(executable,args,{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});}catch{throw error('无法启动本机语音服务。');}
    let doneResolve;const done=new Promise(resolve=>doneResolve=resolve),record={proc,done};this._children.add(record);
    return new Promise((resolve,reject)=>{
      let stdout=[],stderr=[],size=0,errSize=0,failure=null;
      const stop=(reason)=>{failure=failure||reason;try{proc.kill('SIGKILL');}catch{}};
      const timer=setTimeout(()=>stop(error('本机语音超过 30 秒未完成。','SPEECH_TIMEOUT')),this.timeoutMs);
      proc.stdout.on('data',chunk=>{size+=chunk.length;if(size>maxBytes)stop(error('本机语音响应过大。'));else stdout.push(chunk);});
      proc.stderr.on('data',chunk=>{errSize+=chunk.length;if(errSize<=4096)stderr.push(chunk);});
      proc.on('error',()=>{failure=error('无法启动本机语音服务。');});
      proc.on('close',code=>{
        clearTimeout(timer);this._children.delete(record);doneResolve();
        if(generation!==this._generation)return reject(cancelled());
        if(failure)return reject(failure);
        if(code!==0)return reject(error('本机语音服务未能完成，请检查已安装音色。'));
        resolve(Buffer.concat(stdout));
      });
      proc.stdin.on('error',()=>{});proc.stdin.end(input,'utf8');
    });
  }
  async _windows(request,generation){
    const temp=await fs.mkdtemp(path.join(os.tmpdir(),'character-studio-speech-'));
    try{
      this._check(generation);
      // Materialize the fixed packaged bridge, including when the source lives in ASAR.
      const script=path.join(temp,'local-speech.ps1');await fs.writeFile(script,await fs.readFile(path.join(this.root,'local-speech.ps1')),{mode:0o600});this._check(generation);
      const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
      const output=await this._run(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{input:JSON.stringify(request),generation});
      let parsed;try{parsed=JSON.parse(output.toString('utf8').replace(/^\uFEFF/,''));}catch{throw error('Windows 本机语音返回了无效响应。');}
      if(!parsed||parsed.ok!==true)throw error('Windows 本机语音生成失败。');return parsed;
    }finally{await fs.rm(temp,{recursive:true,force:true});}
  }
  async voices(){
    if(!this.engine)throw error('本机语音只支持 macOS 和 Windows。');
    if(this._voices)return this._voices.map(v=>({...v}));
    if(this._voicePromise)return this._voicePromise;
    const generation=this._generation;
    const task=(async()=>{
      let voices;
      if(this.platform==='darwin')voices=parseMacVoices((await this._run('/usr/bin/say',['-v','?'],{maxBytes:256*1024,generation})).toString('utf8'));
      else voices=(await this._windows({action:'voices'},generation)).voices;
      this._check(generation);
      if(!Array.isArray(voices)||!voices.length||voices.length>256)throw error('没有找到可用的本机音色。');
      const ids=new Set();for(const v of voices){if(!v||!new RegExp(this.platform==='darwin'?'^mac-[a-f0-9]{24}$':'^winrt-[a-f0-9]{24}$').test(v.voice_id)||ids.has(v.voice_id)||v.engine!==this.engine||!['name','language','gender'].every(k=>typeof v[k]==='string'&&v[k].length<=300)||!['female','male','unknown'].includes(v.gender))throw error('本机音色清单无效。');ids.add(v.voice_id);}
      this._voices=voices.map(v=>({voice_id:v.voice_id,name:v.name,language:v.language,gender:v.gender,engine:v.engine})).sort((a,b)=>Number(!a.language.startsWith('zh'))-Number(!b.language.startsWith('zh'))||a.language.localeCompare(b.language)||a.name.localeCompare(b.name));
      return this._voices.map(v=>({...v}));
    })();
    this._voicePromise=task;this._jobs.add(task);
    try{return await task;}finally{this._jobs.delete(task);if(this._voicePromise===task)this._voicePromise=null;}
  }
  _validate(request){
    const fields=['text','voice_id','rate','pitch','volume'];
    if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).length!==fields.length||!fields.every(k=>Object.hasOwn(request,k)))throw error('语音请求字段无效。','INVALID_REQUEST');
    if(typeof request.text!=='string'||!request.text.trim()||request.text.length>1000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(request.text)||typeof request.text.isWellFormed==='function'&&!request.text.isWellFormed())throw error('试读文本须为 1 至 1000 个字符。','INVALID_REQUEST');
    if(typeof request.voice_id!=='string'||!/^(mac|winrt)-[a-f0-9]{24}$/.test(request.voice_id))throw error('请选择真实本机音色。','INVALID_REQUEST');
    for(const [key,min,max] of [['rate',.5,2],['pitch',.5,2],['volume',Number.MIN_VALUE,1]])if(typeof request[key]!=='number'||!Number.isFinite(request[key])||request[key]<min||request[key]>max)throw error('语音参数范围无效。','INVALID_REQUEST');
    if(this.platform==='darwin'&&request.pitch!==1)throw error('Mac 本机声音不支持音高调整，请使用原始音高。','INVALID_REQUEST');
  }
  async synthesize(request){
    this._validate(request);if(!this.engine)throw error('本机语音只支持 macOS 和 Windows。');
    if(this._synthBusy)throw error('上一段本机音频仍在准备。','SPEECH_BUSY');
    this._synthBusy=true;const generation=this._generation;
    const task=(async()=>{
      const voices=await this.voices();this._check(generation);
      const voice=voices.find(v=>v.voice_id===request.voice_id);if(!voice)throw error('已绑定音色当前不可用，请重新选择。','INVALID_REQUEST');
      if(this.platform==='win32'){
        const result=await this._windows({action:'synthesize',...request},generation);this._check(generation);
        if(result.voice_id!==request.voice_id||result.engine!==this.engine||['rate','pitch','volume'].some(k=>typeof result[k]!=='number'||!Number.isFinite(result[k])||Math.abs(result[k]-request[k])>1e-6)||typeof result.wav_base64!=='string'||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.wav_base64)||result.wav_base64.length>Math.ceil(MAX_WAV/3)*4)throw error('Windows 音色或参数回执不一致。');
        const wav=Buffer.from(result.wav_base64,'base64');inspectWav(wav);return wav;
      }
      const temp=await fs.mkdtemp(path.join(os.tmpdir(),'character-studio-speech-'));
      try{
        this._check(generation);const input=path.join(temp,'speech.txt'),output=path.join(temp,'speech.wav');
        // Say's embedded [[commands]] must not override the selected voice/rate.
        await fs.writeFile(input,request.text.replaceAll('[[','［［'),{encoding:'utf8',mode:0o600});this._check(generation);
        await this._run('/usr/bin/say',['-v',voice.name,'-r',String(Math.round(200*request.rate)),'-f',input,'-o',output,'--file-format=WAVE','--data-format=LEI16@22050'],{generation,maxBytes:4096});this._check(generation);
        const stat=await fs.stat(output);if(stat.size>MAX_WAV)throw error('生成的音频超过 8 MiB。');
        const wav=scaleWav(await fs.readFile(output),request.volume);this._check(generation);return wav;
      }finally{await fs.rm(temp,{recursive:true,force:true});}
    })();this._jobs.add(task);
    try{return await task;}finally{this._jobs.delete(task);this._synthBusy=false;}
  }
  async cancel(){
    this._generation++;const children=[...this._children],jobs=[...this._jobs];
    for(const {proc}of children){try{proc.kill('SIGKILL');}catch{}}
    await Promise.allSettled(children.map(c=>c.done));await Promise.allSettled(jobs);
    return {cancelled:true};
  }
}
module.exports={NativeSpeech,inspectWav,scaleWav,parseMacVoices};
