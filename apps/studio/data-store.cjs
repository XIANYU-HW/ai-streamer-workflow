'use strict';

const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');

const MAX_DATA_BYTES=16*1024*1024;
const MAX_FILE_BYTES=MAX_DATA_BYTES+65536;
const FORMAT='ai-streamer-studio-public';
const BACKUP_NAME=/^before-import-\d{8}T\d{9}Z-r\d+-[0-9a-f-]{36}\.json$/;
// Electron owns one application instance. This also serializes independent store
// objects within that process; revision checks remain the authority for callers.
const queues=new Map();
const hash=data=>crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
const timestamp=()=>new Date().toISOString().replace(/[-:.]/g,'');
const error=(code,message,cause)=>Object.assign(new Error(message,{cause}),{code});

class WorkspaceStore {
  constructor({directory,model}={}) {
    if(typeof directory!=='string'||!path.isAbsolute(directory))throw new TypeError('资料目录必须是绝对路径。');
    if(!model||typeof model.validate!=='function')throw new TypeError('缺少资料校验器。');
    this.directory=path.resolve(directory);
    this.model=model;
    this.file=path.join(this.directory,'workspace.json');
    this.previous=path.join(this.directory,'workspace.previous.json');
    this.backups=path.join(this.directory,'backups');
  }

  _run(fn) {
    const task=(queues.get(this.directory)||Promise.resolve()).then(fn);
    const settled=task.catch(()=>{});
    queues.set(this.directory,settled);
    settled.then(()=>{if(queues.get(this.directory)===settled)queues.delete(this.directory);});
    return task;
  }

  _expected(value) {
    if(!Number.isSafeInteger(value)||value<0)throw error('INVALID_REVISION','资料版本无效，请重新打开工作室。');
  }

  _input(input,allowLegacy=false) {
    let data=input;
    if(typeof data==='string') {
      if(Buffer.byteLength(data,'utf8')>MAX_DATA_BYTES)throw error('WORKSPACE_TOO_LARGE','导入资料不能超过 16 MiB。');
      try{data=JSON.parse(data.replace(/^\uFEFF/,''));}
      catch(cause){throw error('INVALID_WORKSPACE','资料不是有效的 JSON，原资料未改变。',cause);}
    }
    try {
      const valid=this.model.validate(data);
      if(Buffer.byteLength(JSON.stringify(data),'utf8')>MAX_DATA_BYTES||Buffer.byteLength(JSON.stringify(valid),'utf8')>MAX_DATA_BYTES)throw error('WORKSPACE_TOO_LARGE','资料不能超过 16 MiB。');
      return valid;
    } catch(cause) {
      if(cause.code==='WORKSPACE_TOO_LARGE')throw cause;
      throw error('INVALID_WORKSPACE','资料校验失败：'+cause.message,cause);
    }
  }

  async _directory(directory,create=true) {
    if(create)await fs.mkdir(directory,{recursive:true,mode:0o700});
    try {
      const stat=await fs.lstat(directory);
      if(stat.isSymbolicLink()||!stat.isDirectory())throw error('WORKSPACE_UNSAFE','资料目录不是普通文件夹，未写入。');
      return true;
    } catch(cause) {
      if(cause.code==='ENOENT'&&!create)return false;
      throw cause;
    }
  }

  async _regular(file) {
    try {
      const stat=await fs.lstat(file);
      if(stat.isSymbolicLink()||!stat.isFile())throw error('WORKSPACE_UNSAFE','资料路径不是普通文件，未读取或写入。');
      return stat;
    } catch(cause) {
      if(cause.code==='ENOENT')return null;
      throw cause;
    }
  }

  async _syncDirectory(directory) {
    let handle;
    try{handle=await fs.open(directory,'r');await handle.sync();}
    catch(cause){
      // Windows does not generally allow opening directory handles via Node fs.
      // File fsync and atomic same-volume rename still run on every platform.
      if(process.platform!=='win32'||!['EPERM','EACCES','EINVAL','ENOTSUP','EISDIR'].includes(cause.code))throw cause;
    }finally{await handle?.close();}
  }

  async _atomicWrite(file,contents) {
    const directory=path.dirname(file);
    await this._directory(directory);
    await this._regular(file);
    const temporary=path.join(directory,'.workspace-'+crypto.randomUUID()+'.tmp');
    let handle;
    try {
      handle=await fs.open(temporary,'wx',0o600);
      await handle.writeFile(contents,'utf8');
      await handle.sync();await handle.close();handle=null;
      await fs.rename(temporary,file);
      await this._syncDirectory(directory);
    } finally {
      await handle?.close();
      await fs.unlink(temporary).catch(()=>{});
    }
  }

  _decode(raw) {
    try {
      const value=JSON.parse(raw);
      const keys=['format','version','revision','updated_at','sha256','data'];
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k))||value.format!==FORMAT||value.version!==1||!Number.isSafeInteger(value.revision)||value.revision<1||typeof value.updated_at!=='string'||!Number.isFinite(Date.parse(value.updated_at))||typeof value.sha256!=='string'||!/^[0-9a-f]{64}$/.test(value.sha256)||hash(value.data)!==value.sha256)throw new Error('资料封装或校验值不匹配。');
      const data=this._input(value.data);
      return {revision:value.revision,data,updated_at:value.updated_at,raw};
    } catch(cause) {
      throw error('WORKSPACE_CORRUPT','资料文件损坏或不兼容。原文件保留，请从备份恢复；不会创建示例资料覆盖它。',cause);
    }
  }

  async _readEnvelope(file) {
    const stat=await this._regular(file);
    if(!stat)return null;
    if(stat.size>MAX_FILE_BYTES)throw error('WORKSPACE_TOO_LARGE','资料文件超过大小限制，原文件保留。');
    let handle;
    try {
      handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
      const opened=await handle.stat();
      if(!opened.isFile())throw error('WORKSPACE_UNSAFE','资料路径不是普通文件。');
      if(opened.size>MAX_FILE_BYTES)throw error('WORKSPACE_TOO_LARGE','资料文件超过大小限制，原文件保留。');
      const raw=await handle.readFile('utf8');
      if(Buffer.byteLength(raw,'utf8')>MAX_FILE_BYTES)throw error('WORKSPACE_TOO_LARGE','资料文件超过大小限制，原文件保留。');
      return this._decode(raw);
    } finally {await handle?.close();}
  }

  async _backupNames() {
    if(!await this._directory(this.backups,false))return [];
    return (await fs.readdir(this.backups)).filter(name=>BACKUP_NAME.test(name)).sort().reverse();
  }

  async _readCurrent() {
    await this._directory(this.directory);
    const current=await this._readEnvelope(this.file);
    if(current)return current;
    if(await this._regular(this.previous)||(await this._backupNames()).length)throw error('WORKSPACE_MISSING','主资料文件缺失，但发现历史备份。请明确选择恢复，未创建空资料库。');
    return {revision:0,data:null,raw:null};
  }

  _envelope(data,revision) {
    if(!Number.isSafeInteger(revision)||revision<1)throw error('INVALID_REVISION','资料版本已达到上限。');
    const value={format:FORMAT,version:1,revision,updated_at:new Date().toISOString(),sha256:hash(data),data};
    const text=JSON.stringify(value);
    if(Buffer.byteLength(text,'utf8')>MAX_FILE_BYTES)throw error('WORKSPACE_TOO_LARGE','资料文件超过大小限制。');
    return text;
  }

  _match(current,expectedRevision) {
    if(current.revision!==expectedRevision)throw error('REVISION_CONFLICT','资料已有新版本。请重新打开后再操作，未覆盖现有资料。');
  }

  async _commit(data,current) {
    const revision=current.revision+1,serialized=this._envelope(data,revision);
    if(current.raw!==null)await this._atomicWrite(this.previous,current.raw);
    await this._atomicWrite(this.file,serialized);
    return revision;
  }

  async _importCaptured(captured,current) {
    // Called only while holding this directory's queue. Both file import and an
    // explicitly selected rollback retain the state they replace independently.
    let backupPath=null;
    if(current.raw!==null){backupPath=path.join(this.backups,'before-import-'+timestamp()+'-r'+current.revision+'-'+crypto.randomUUID()+'.json');await this._atomicWrite(backupPath,current.raw);}
    const revision=await this._commit(captured,current);
    return {revision,data:captured,backupPath};
  }

  async load() {
    return this._run(async()=>{const {revision,data}=await this._readCurrent();return {revision,data};});
  }

  async save(data,expectedRevision) {
    this._expected(expectedRevision);
    const captured=this._input(data);
    return this._run(async()=>{const current=await this._readCurrent();this._match(current,expectedRevision);return this._commit(captured,current);});
  }

  async importData(data,expectedRevision) {
    this._expected(expectedRevision);
    const captured=this._input(data,true);
    return this._run(async()=>{
      const current=await this._readCurrent();this._match(current,expectedRevision);
      return this._importCaptured(captured,current);
    });
  }

  async exportData() {
    return this._run(async()=>{const current=await this._readCurrent();return current.data;});
  }

  _backupPath(id) {
    if(id==='previous')return this.previous;
    if(typeof id!=='string'||!BACKUP_NAME.test(id))throw error('INVALID_BACKUP','请选择列表中的有效备份。');
    return path.join(this.backups,id);
  }

  async listRecoveryPoints() {
    return this._run(async()=>{
      await this._directory(this.directory);
      const points=[];
      for(const id of ['previous',...await this._backupNames()]) {
        try {
          const value=await this._readEnvelope(this._backupPath(id));
          if(value)points.push({id,revision:value.revision,updated_at:value.updated_at,characters:value.data.characters.length,scenes:value.data.scenes.length,memories:value.data.memories.length});
        }catch(cause){if(!['WORKSPACE_CORRUPT','WORKSPACE_TOO_LARGE','WORKSPACE_UNSAFE','ENOENT'].includes(cause.code))throw cause;}
      }
      return points;
    });
  }

  async restoreFromBackup(id,expectedRevision) {
    this._expected(expectedRevision);
    const backupPath=this._backupPath(id);
    return this._run(async()=>{
      const current=await this._readCurrent();this._match(current,expectedRevision);
      if(id!=='previous')await this._directory(this.backups,false);
      const backup=await this._readEnvelope(backupPath);
      if(!backup)throw error('INVALID_BACKUP','所选备份不存在，原资料未改变。');
      // Reuse the import transaction, not the public queued importData method.
      // The restored content receives current revision + 1; old revisions never
      // become valid again, and the pre-restore library remains recoverable.
      return this._importCaptured(backup.data,current);
    });
  }

  async recoverFromBackup(id) {
    const backupPath=this._backupPath(id);
    return this._run(async()=>{
      let unreadable=false;
      try{await this._readCurrent();}
      catch(cause){if(!['WORKSPACE_CORRUPT','WORKSPACE_TOO_LARGE','WORKSPACE_MISSING'].includes(cause.code))throw cause;unreadable=true;}
      if(!unreadable)throw error('RECOVERY_NOT_NEEDED','当前资料可正常读取，未用旧备份覆盖。需要替换时请使用明确的备份还原或导入功能。');
      if(id!=='previous')await this._directory(this.backups,false);
      const backup=await this._readEnvelope(backupPath);
      if(!backup)throw error('INVALID_BACKUP','所选备份不存在，原资料未改变。');
      let archivedPath=null;
      if(await this._regular(this.file)){
        const archive=path.join(this.directory,'recovery');await this._directory(archive);
        archivedPath=path.join(archive,'corrupt-'+timestamp()+'-'+crypto.randomUUID()+'.json');
        await fs.copyFile(this.file,archivedPath,constants.COPYFILE_EXCL);
        const handle=await fs.open(archivedPath,'r');try{await handle.sync();}finally{await handle.close();}
        await this._syncDirectory(archive);
      }
      const revision=backup.revision+1;
      await this._atomicWrite(this.file,this._envelope(backup.data,revision));
      return {revision,data:backup.data,archivedPath};
    });
  }
}

module.exports={WorkspaceStore};
