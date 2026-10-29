'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const MAX_RECORDS=2000,MAX_BYTES=8*1024*1024;
// Electron owns a single application instance. Stores for the same directory in
// that process share one queue, including reads, so summary sees committed data.
const queues=new Map();
const statuses=new Set(['requested','ready','speaking','waiting','paused','stopped','cancelled','blocked','failed','completed','seeking','muted','unmuted']);
const fields=['request_id','character_id','profile_id','session_id','model','status','reason','first_playback_ms','first_audio_byte_ms','usage_characters','estimated_cost_usd','replayed','local_request_attempted','actual_audible_ms','recorded_at'];
const error=(code,message)=>Object.assign(new Error(message),{code});
const invalid=()=>error('INVALID_VOICE_RECEIPT','播放回执字段无效，未记录。');
const corrupt=()=>error('VOICE_EVIDENCE_CORRUPT','播放回执文件损坏或不兼容，原文件已保留。');
const unsafe=()=>error('VOICE_EVIDENCE_UNSAFE','播放回执路径不是普通本地文件，未读取或写入。');

function plain(value){return !!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));}
function own(value,key){
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(!descriptor)return undefined;
  if(!Object.hasOwn(descriptor,'value'))throw invalid();
  return descriptor.value;
}
function token(value,max,required=false){
  if(value===undefined||value===null){if(required)throw invalid();return null;}
  if(typeof value!=='string'||value.length>max||!new RegExp('^[A-Za-z0-9_.:-]'+(required?'+':'*')+'$').test(value))throw invalid();
  return value;
}
function number(value,max,integer=false){
  if(value===undefined||value===null)return null;
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>max||(integer&&!Number.isSafeInteger(value)))throw invalid();
  return value;
}
function boolean(value){if(value===undefined)return false;if(typeof value!=='boolean')throw invalid();return value;}
function sanitize(value){
  if(!plain(value))throw invalid();
  const status=own(value,'status');if(!statuses.has(status))throw invalid();
  // Deliberately do not traverse other fields: text, voice descriptions, keys,
  // images and memory never enter the stored object, even as nested payloads.
  return {
    request_id:token(own(value,'request_id'),200,true),
    character_id:token(own(value,'character_id'),200),
    profile_id:token(own(value,'profile_id'),200),
    session_id:token(own(value,'session_id'),200),
    model:token(own(value,'model'),80),status,
    reason:token(own(value,'reason'),120),
    first_playback_ms:number(own(value,'first_playback_ms'),3600000),
    first_audio_byte_ms:number(own(value,'first_audio_byte_ms'),3600000),
    usage_characters:number(own(value,'usage_characters'),1000000,true),
    estimated_cost_usd:number(own(value,'estimated_cost_usd'),10000),
    replayed:boolean(own(value,'replayed')),
    local_request_attempted:boolean(own(value,'local_request_attempted')),
    // A renderer playing event does not measure physical speaker output.
    actual_audible_ms:null
  };
}
function decode(raw){
  try{
    const envelope=JSON.parse(raw);
    if(!plain(envelope)||Object.keys(envelope).length!==2||envelope.version!==1||!Array.isArray(envelope.records)||envelope.records.length>MAX_RECORDS)throw corrupt();
    for(const record of envelope.records){
      if(!plain(record)||Object.keys(record).length!==fields.length||!fields.every(key=>Object.hasOwn(record,key)))throw corrupt();
      const clean=sanitize(record);
      if(Object.keys(clean).some(key=>clean[key]!==record[key]))throw corrupt();
      if(typeof record.recorded_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(record.recorded_at)||new Date(record.recorded_at).toISOString()!==record.recorded_at)throw corrupt();
    }
    return envelope.records;
  }catch{throw corrupt();}
}

class VoiceEvidence {
  constructor({directory}={}){
    if(typeof directory!=='string'||!path.isAbsolute(directory))throw new TypeError('播放回执目录必须是绝对路径。');
    this.directory=path.resolve(directory);this.file=path.join(this.directory,'voice-playback-evidence.json');
  }
  _run(fn){
    const task=(queues.get(this.directory)||Promise.resolve()).then(fn),settled=task.catch(()=>{});
    queues.set(this.directory,settled);settled.then(()=>{if(queues.get(this.directory)===settled)queues.delete(this.directory);});return task;
  }
  async _directory(create=false){
    if(create)await fs.mkdir(this.directory,{recursive:true,mode:0o700});
    try{const stat=await fs.lstat(this.directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw unsafe();return true;}
    catch(cause){if(cause.code==='ENOENT'&&!create)return false;throw cause;}
  }
  async _read(){
    if(!await this._directory())return{raw:null,records:[]};
    let stat;
    try{stat=await fs.lstat(this.file);}catch(cause){if(cause.code==='ENOENT')return{raw:null,records:[]};throw cause;}
    if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1)throw unsafe();
    if(stat.size>MAX_BYTES)throw corrupt();
    let handle;
    try{
      handle=await fs.open(this.file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
      const opened=await handle.stat();
      if(!opened.isFile()||opened.nlink!==1||opened.dev!==stat.dev||opened.ino!==stat.ino)throw unsafe();
      if(opened.size>MAX_BYTES)throw corrupt();
      const raw=await handle.readFile('utf8');if(Buffer.byteLength(raw,'utf8')>MAX_BYTES)throw corrupt();
      return{raw,records:decode(raw)};
    }finally{await handle?.close();}
  }
  async _syncDirectory(){
    let handle;
    try{handle=await fs.open(this.directory,'r');await handle.sync();}
    catch(cause){
      // Windows does not generally allow directory fsync through Node. The file
      // is still fsynced and replaced with a same-directory atomic rename.
      if(process.platform!=='win32'||!['EPERM','EACCES','EINVAL','ENOTSUP','EISDIR'].includes(cause.code))throw cause;
    }finally{await handle?.close();}
  }
  async _write(records,expected){
    const serialized=JSON.stringify({version:1,records});if(Buffer.byteLength(serialized,'utf8')>MAX_BYTES)throw invalid();
    await this._directory(true);
    const temporary=path.join(this.directory,'.voice-evidence-'+crypto.randomUUID()+'.tmp');let handle,created=false;
    try{
      handle=await fs.open(temporary,'wx',0o600);created=true;await handle.writeFile(serialized,'utf8');await handle.sync();await handle.close();handle=null;
      // Catch external deletion, edits or corruption while the temp file was
      // being written. No reset or repair occurs through this audit writer.
      const current=await this._read();
      if(current.raw!==expected)throw error('VOICE_EVIDENCE_CONFLICT','播放回执文件已改变，未覆盖。');
      await fs.rename(temporary,this.file);await this._syncDirectory();
    }finally{await handle?.close();if(created)await fs.unlink(temporary).catch(cause=>{if(cause.code!=='ENOENT')throw cause;});}
  }
  async append(value){
    // Capture before joining the queue, so later renderer-object mutation cannot
    // change the receipt. Caller-provided recorded_at and audible times ignored.
    const captured=sanitize(value);
    return this._run(async()=>{
      const current=await this._read(),record=Object.freeze({...captured,recorded_at:new Date().toISOString()});
      const records=current.records.concat(record).slice(-MAX_RECORDS);await this._write(records,current.raw);return record;
    });
  }
  async summary(){
    return this._run(async()=>{
      const {records}=await this._read(),completed=records.filter(record=>record.status==='completed'&&!record.replayed);
      const values=completed.map(record=>record.first_playback_ms).filter(value=>value!==null).sort((a,b)=>a-b);
      // Nearest-rank percentiles, over time-to-playing only. Callers submit one
      // terminal receipt per playback; request IDs can repeat across app starts.
      const percentile=p=>values.length?values[Math.ceil(values.length*p)-1]:null;
      // Attempts at the local endpoint are not provider dispatches or paid calls.
      return {count:records.length,cloud_request_attempts:records.filter(record=>record.local_request_attempted&&!record.replayed).length,completed:completed.length,measurement:'only_local_request_attempt',durations:{count:values.length,p50:percentile(.5),p95:percentile(.95),unit:'ms',measurement:'playing_event',actual_audible_ms:null}};
    });
  }
}
module.exports={VoiceEvidence};
