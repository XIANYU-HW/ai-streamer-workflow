(function (root) {
  'use strict';
  const VERSION = '2.0';
  const STATES = ['平静', '专注', '疑惑', '惊讶', '得意', '懊恼'];
  const LIMITS = Object.freeze({ characters:12, scenes:20, sessions:100, memories:1000, events:1000, jsonBytes:16*1024*1024, imageBytes:2*1024*1024 });
  const CHARACTER_KEYS = ['character_id','revision','name','driver','backstory','bio','address','traits','appearance','voice'];
  const TRAIT_KEYS = ['calm','stubborn','humor','talkative'];
  const APPEARANCE_KEYS = ['primary','accent','image','size','emotion','mouth','motion'];
  const MOTION_KEYS = ['enabled','intensity','mouth_image','mouth'];
  const MOUTH_KEYS = ['x','y','width','height'];
  const VOICE_KEYS = ['profile_id','provider','service','voice_id','local_voice_id','language','description','style','rate','pitch','volume','stability','similarity','expressiveness','sample'];
  const SCENE_KEYS = ['scene_id','name','description','environment','accent','background_image','cast_ids','placements','layout'];
  const ROLES = ['主持','搭档','嘉宾','解说','玩家'];
  const DB_KEYS = ['schema_version','characters','scenes','sessions','memories','selected_character_id','selected_scene_id','active_session_id','assets'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const defaultMotion = () => ({enabled:false,intensity:0.65,mouth_image:null,mouth:{x:50,y:15,width:8,height:3}});
  function assert(ok,message) { if (!ok) throw new Error(message); }
  function object(value,keys,path,partial=false) {
    assert(value && typeof value === 'object' && !Array.isArray(value),path+'必须是对象');
    const proto=Object.getPrototypeOf(value);
    assert(proto===Object.prototype || proto===null,path+'必须是普通数据对象');
    const actual=Reflect.ownKeys(value);
    assert(actual.every(k=>typeof k==='string' && keys.includes(k)),path+'含有不支持的字段');
    assert(actual.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value')),path+'不能包含访问器');
    if (!partial) assert(keys.every(k=>Object.hasOwn(value,k)),path+'缺少字段');
  }
  function text(value,max,path,min=0) {
    assert(typeof value==='string' && value.length>=min && value.length<=max,path+'长度或类型无效');
    assert(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),path+'包含控制字符');
    assert(!/<\s*\/?\s*[A-Za-z][^>]*>|(?:https?|ftp|file|javascript|vbscript|data|wss?):|(?:api[_ -]?key|access[_ -]?token|authorization)\s*[:=]|Bearer\s+[A-Za-z0-9._-]{12,}|sk-[A-Za-z0-9_-]{16,}/i.test(value),path+'不能包含HTML、网址、脚本地址或凭据');
    if (min>0) assert(value.trim().length>0,path+'不能为空');
  }
  function num(value,min,max,path,integer=false) { assert(typeof value==='number' && Number.isFinite(value) && value>=min && value<=max && (!integer || Number.isInteger(value)),path+'范围或类型无效'); }
  function oneOf(value,values,path) { assert(values.includes(value),path+'选项无效'); }
  function id(value,path) { assert(typeof value==='string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value),path+'格式无效'); }
  function list(value,max,path,min=0) { assert(Array.isArray(value) && value.length>=min && value.length<=max,path+'数量或类型无效'); }
  function unique(values,path) { assert(new Set(values).size===values.length,path+'不能重复'); }
  function ids(values,max,path,min=0) { list(values,max,path,min);values.forEach(v=>id(v,path));unique(values,path); }
  function color(value,path) { assert(typeof value==='string' && /^#[0-9a-fA-F]{6}$/.test(value),path+'颜色无效'); }
  function date(value,path) { assert(typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value,path+'必须是UTC ISO时间');assert(Date.parse(value)<=Date.now()+60000,path+'不能位于未来（仅容许60秒本机操作时钟余量）'); }
  function utf8Bytes(value) {
    if (typeof TextEncoder!=='undefined') return new TextEncoder().encode(value).length;
    let n=0; for (const char of value) {const p=char.codePointAt(0);n+=p<=127?1:p<=2047?2:p<=65535?3:4;} return n;
  }
  function assetKey(reference) {
    return typeof reference==='string' && /^asset:asset-[A-Za-z0-9_-]{1,74}$/.test(reference)?reference.slice(6):null;
  }
  function imageData(value,path,allowReference=true) {
    if (value===null) return;
    if (allowReference && assetKey(value)) return;
    assert(typeof value==='string' && value.length<=Math.ceil(LIMITS.imageBytes/3)*4+32,path+'图片过大');
    const m=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    assert(m && m[2].length%4===0,path+'必须是PNG/JPEG/WebP base64数据');
    const data=m[2], padding=data.endsWith('==')?2:data.endsWith('=')?1:0;
    assert(data.length/4*3-padding>0 && data.length/4*3-padding<=LIMITS.imageBytes,path+'图片不能超过2MiB');
    const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', bytes=[];
    for(let i=0;i<Math.min(16,data.length);i+=4) {
      const a=alphabet.indexOf(data[i]),b=alphabet.indexOf(data[i+1]),c=alphabet.indexOf(data[i+2]),d=alphabet.indexOf(data[i+3]);
      bytes.push((a<<2)|(b>>4)); if(c>=0)bytes.push(((b&15)<<4)|(c>>2));if(d>=0)bytes.push(((c&3)<<6)|d);
    }
    const png=[137,80,78,71,13,10,26,10];
    assert(m[1]==='png'?png.every((v,i)=>bytes[i]===v):m[1]==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes[0]===82&&bytes[1]===73&&bytes[2]===70&&bytes[3]===70&&bytes[8]===87&&bytes[9]===69&&bytes[10]===66&&bytes[11]===80,path+'图片类型与内容不一致');
  }
  // This fingerprint only creates stable local names. Exact byte comparison resolves
  // collisions; it is not a cryptographic authenticity or integrity claim.
  function fingerprint(value) {
    let a=2166136261,b=2246822519;
    for(let i=0;i<value.length;i++){const n=value.charCodeAt(i);a=Math.imul(a^n,16777619);b=Math.imul(b^n,3266489917);}
    return (a>>>0).toString(16).padStart(8,'0')+(b>>>0).toString(16).padStart(8,'0');
  }
  function checkAssets(assets) {
    assert(assets && typeof assets==='object' && !Array.isArray(assets),'图片资源池必须是对象');
    const keys=Reflect.ownKeys(assets);assert(keys.length<=1024,'图片资源数量过多');
    object(assets,keys,'图片资源池');
    keys.forEach(key=>{assert(typeof key==='string' && /^asset-[A-Za-z0-9_-]{1,74}$/.test(key),'图片资源ID无效');imageData(assets[key],'图片资源',false);assert(assets[key]!==null,'图片资源不能为空');});
  }
  function internAssets(input) {
    const db=clone(input),source=db.assets||{},byData=new Map(),pool={},used=new Set();
    Object.keys(source).sort().forEach(key=>{if(!byData.has(source[key])){byData.set(source[key],key);pool[key]=source[key];}});
    function intern(value) {
      if(value===null)return null;
      const ref=assetKey(value),data=ref?(assert(Object.hasOwn(source,ref),'图片引用的资源不存在'),source[ref]):value;
      let key=byData.get(data);
      if(!key){const base='asset-'+fingerprint(data);key=base;let n=1;while(Object.hasOwn(pool,key)&&pool[key]!==data)key=base+'-'+n++;pool[key]=data;byData.set(data,key);}
      used.add(key);return 'asset:'+key;
    }
    const character=c=>{
      c.appearance.image=intern(c.appearance.image);
      // Only a wholly absent optional field is upgraded. Malformed supplied
      // motion is rejected by characterCheck before this normalization runs.
      if(!Object.hasOwn(c.appearance,'motion'))c.appearance.motion=defaultMotion();
      c.appearance.motion.mouth_image=intern(c.appearance.motion.mouth_image);
    };
    const scene=s=>{s.background_image=intern(s.background_image);};
    db.characters.forEach(character);db.scenes.forEach(scene);db.sessions.forEach(s=>{scene(s.scene_snapshot);s.character_snapshots.forEach(character);});
    db.assets={};[...used].sort().forEach(key=>{db.assets[key]=pool[key];});return db;
  }
  function resolveImage(db,reference) {
    if(reference===null)return null;
    const key=assetKey(reference);
    if(!key){imageData(reference,'图片预览',false);return reference;}
    assert(db && db.assets && Object.hasOwn(db.assets,key),'图片引用的资源不存在');const value=db.assets[key];imageData(value,'图片资源',false);assert(value!==null,'图片资源不能为空');return value;
  }
  function motionCheck(m,path) {
    object(m,MOTION_KEYS,path);assert(typeof m.enabled==='boolean',path+'启用状态必须为布尔值');
    num(m.intensity,0,1,path+'动作幅度');imageData(m.mouth_image,path+'嘴型图片');
    object(m.mouth,MOUTH_KEYS,path+'嘴型锚点');num(m.mouth.x,0,100,path+'嘴型中心横坐标');num(m.mouth.y,0,100,path+'嘴型中心纵坐标');
    num(m.mouth.width,1,30,path+'嘴型宽度');num(m.mouth.height,1,20,path+'嘴型高度');
  }
  function characterCheck(c,path='角色') {
    object(c,CHARACTER_KEYS,path);id(c.character_id,path+'ID');num(c.revision,1,Number.MAX_SAFE_INTEGER,path+'版本',true);
    text(c.name,30,path+'名称',1);text(c.driver,80,path+'模型绑定');assert(c.driver===''||/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(c.driver),path+'模型绑定格式无效');
    text(c.backstory,4000,path+'背景');text(c.bio,600,path+'简介');text(c.address,60,path+'称呼');
    object(c.traits,TRAIT_KEYS,path+'性格');TRAIT_KEYS.forEach(k=>num(c.traits[k],0,100,path+k));
    const a=c.appearance,hasMotion=Object.hasOwn(a||{},'motion');object(a,hasMotion?APPEARANCE_KEYS:APPEARANCE_KEYS.filter(k=>k!=='motion'),path+'形象');color(a.primary,path+'主色');color(a.accent,path+'点缀色');imageData(a.image,path+'形象');num(a.size,12,32,path+'大小');oneOf(a.emotion,STATES,path+'表情');assert(typeof a.mouth==='boolean',path+'嘴型必须为布尔值');
    if(hasMotion)motionCheck(a.motion,path+'动作');
    const v=c.voice;object(v,VOICE_KEYS,path+'声音');id(v.profile_id,path+'声音档案ID');
    oneOf(v.provider,['','browser_local','professional_pending'],path+'声音提供方式');oneOf(v.service,['','unselected','elevenlabs','azure','minimax','custom_pending'],path+'声音服务');
    assert(v.provider!=='browser_local' || ['','unselected'].includes(v.service),path+'本机声音不能绑定专业服务');
    text(v.voice_id,200,path+'专业音色ID');text(v.local_voice_id,200,path+'本机音色ID');assert(v.language==='zh-CN',path+'语言必须是zh-CN');
    text(v.description,600,path+'声音描述');text(v.style,120,path+'发声风格');text(v.sample,1000,path+'试读文本');
    num(v.rate,0.5,2,path+'语速');num(v.pitch,0,2,path+'音高');['volume','stability','similarity','expressiveness'].forEach(k=>num(v[k],0,1,path+k));
  }
  function sceneCheck(s,path='场景') {
    object(s,SCENE_KEYS,path);id(s.scene_id,path+'ID');text(s.name,60,path+'名称',1);text(s.description,2000,path+'描述');
    oneOf(s.environment,['observatory','lounge','arena'],path+'环境');color(s.accent,path+'颜色');imageData(s.background_image,path+'背景图');ids(s.cast_ids,4,path+'演员');oneOf(s.layout,['duo','roundtable'],path+'布局');
    list(s.placements,4,path+'站位');assert(s.placements.length===s.cast_ids.length,path+'站位数量必须与演员一致');
    s.placements.forEach((p,i)=>{object(p,['character_id','role','x','y'],path+'站位');assert(p.character_id===s.cast_ids[i],path+'站位ID/顺序必须与演员一致');oneOf(p.role,ROLES,path+'岗位');num(p.x,0,80,path+'横向站位');num(p.y,0,65,path+'纵向站位');});
  }
  function placements(cast,previous=[]) {
    const xs=cast.length===1?[40]:cast.length===2?[8,72]:[4,28,52,76];
    return cast.map((characterId,i)=>{const old=previous.find(p=>p.character_id===characterId);return old?clone(old):{character_id:characterId,role:ROLES[Math.min(i,3)],x:xs[i],y:52};});
  }
  function validate(db) {
    object(db,Object.hasOwn(db||{},'assets')?DB_KEYS:DB_KEYS.filter(k=>k!=='assets'),'数据库');
    if(Object.hasOwn(db,'assets'))checkAssets(db.assets);
    assert(db.schema_version===VERSION,'不支持的数据版本');list(db.characters,LIMITS.characters,'角色库');list(db.scenes,LIMITS.scenes,'场景库');list(db.sessions,LIMITS.sessions,'会话');list(db.memories,LIMITS.memories,'记忆');
    db.characters.forEach(c=>characterCheck(c));db.scenes.forEach(s=>sceneCheck(s));
    const characterIds=db.characters.map(c=>c.character_id), sceneIds=db.scenes.map(s=>s.scene_id), profileIds=db.characters.map(c=>c.voice.profile_id);
    unique(characterIds,'角色ID');unique(sceneIds,'场景ID');unique(profileIds,'声音档案ID');
    assert(characterIds.length?characterIds.includes(db.selected_character_id):db.selected_character_id===null,'所选角色不存在');assert(sceneIds.length?sceneIds.includes(db.selected_scene_id):db.selected_scene_id===null,'所选场景不存在');
    db.scenes.forEach(s=>assert(s.cast_ids.every(i=>characterIds.includes(i)),'场景演员不存在'));
    const allIds=[...characterIds,...sceneIds,...profileIds], sessionIds=[], eventIds=[];
    let running=0;
    db.sessions.forEach(s=>{
      object(s,['session_id','scene_id','scene_snapshot','participant_ids','character_snapshots','status','started_at','ended_at','events'],'会话');id(s.session_id,'会话ID');sessionIds.push(s.session_id);
      assert(sceneIds.includes(s.scene_id),'会话引用的场景不存在');sceneCheck(s.scene_snapshot,'场景快照');assert(s.scene_snapshot.scene_id===s.scene_id,'场景快照ID不一致');
      ids(s.participant_ids,4,'会话参加者',1);assert(s.participant_ids.every(i=>characterIds.includes(i)),'会话参加者不存在');
      assert(JSON.stringify(s.scene_snapshot.cast_ids)===JSON.stringify(s.participant_ids),'场景快照演员与参加者不一致');
      list(s.character_snapshots,4,'角色快照',1);assert(s.character_snapshots.length===s.participant_ids.length,'角色快照数量不一致');
      s.character_snapshots.forEach((c,index)=>{characterCheck(c,'角色快照');assert(c.character_id===s.participant_ids[index],'角色快照ID/顺序不一致');const current=db.characters.find(x=>x.character_id===c.character_id);assert(c.revision<=current.revision,'角色快照版本超前');assert(c.voice.profile_id===current.voice.profile_id,'角色快照声音档案身份不一致');});
      oneOf(s.status,['running','ended'],'会话状态');date(s.started_at,'会话开始时间');
      if(s.status==='running'){running++;assert(s.ended_at===null,'运行中的会话不能有结束时间');assert(db.active_session_id===s.session_id,'运行会话与活动ID不一致');}
      else {date(s.ended_at,'会话结束时间');assert(s.ended_at>=s.started_at,'会话结束早于开始');}
      list(s.events,LIMITS.events,'事件');let previous=s.started_at;
      s.events.forEach(e=>{
        object(e,['event_id','text','witness_ids','source','created_at'],'事件');id(e.event_id,'事件ID');eventIds.push(e.event_id);text(e.text,2000,'事件内容',1);ids(e.witness_ids,4,'事件见证者',1);
        assert(e.witness_ids.every(i=>s.participant_ids.includes(i)),'事件见证者不在会话中');assert(e.source==='manual_rehearsal','事件来源必须是手动排演');date(e.created_at,'事件时间');
        assert(e.created_at>=previous && (s.ended_at===null || e.created_at<=s.ended_at),'事件时间不在会话顺序内');previous=e.created_at;
      });
    });
    unique(sessionIds,'会话ID');unique(eventIds,'事件ID');assert(running<=1,'只能有一个运行中的会话');
    assert((running===0 && db.active_session_id===null)||(running===1 && sessionIds.includes(db.active_session_id)),'活动会话ID无效');
    const sorted=[...db.sessions].sort((a,b)=>a.started_at.localeCompare(b.started_at));
    sorted.forEach((s,i)=>{if(i>0)assert(sorted[i-1].status==='ended' && sorted[i-1].ended_at<s.started_at,'会话时间不能重叠');});
    const memoryIds=[], memoryPairs=[];
    db.memories.forEach(m=>{
      object(m,['memory_id','character_id','session_id','source_event_ids','text','status','created_at','reviewed_at'],'记忆');id(m.memory_id,'记忆ID');memoryIds.push(m.memory_id);
      assert(characterIds.includes(m.character_id),'记忆所属角色不存在');const s=db.sessions.find(x=>x.session_id===m.session_id);assert(s && s.status==='ended','记忆来源必须是已结束会话');
      assert(s.participant_ids.includes(m.character_id),'记忆所属角色未参加来源会话');ids(m.source_event_ids,LIMITS.events,'记忆来源事件',1);
      m.source_event_ids.forEach(i=>{const e=s.events.find(x=>x.event_id===i);assert(e && e.witness_ids.includes(m.character_id),'记忆包含角色未见证的事件');});
      text(m.text,12000,'记忆内容',1);oneOf(m.status,['draft','confirmed','rejected'],'记忆状态');date(m.created_at,'记忆创建时间');assert(m.created_at>=s.ended_at,'记忆创建早于会话结束');
      if(m.status==='draft')assert(m.reviewed_at===null,'待审核记忆不能有审核时间');else{date(m.reviewed_at,'记忆审核时间');assert(m.reviewed_at>=m.created_at,'记忆审核早于创建');}
      memoryPairs.push(m.session_id+'|'+m.character_id);
    });
    unique(memoryIds,'记忆ID');unique(memoryPairs,'同一会话的角色记忆');unique([...allIds,...sessionIds,...eventIds,...memoryIds],'跨记录ID');
    const canonical=internAssets(db);
    assert(utf8Bytes(JSON.stringify(canonical))<=LIMITS.jsonBytes,'数据库不能超过16MiB');
    // Validate the worst-case ending before accepting any active database, including
    // imported state and unrelated edits. A successful operation cannot strand it.
    if(canonical.active_session_id!==null)preflightEnd(canonical);
    return canonical;
  }
  function parse(source) { assert(typeof source==='string' && utf8Bytes(source)<=LIMITS.jsonBytes,'配置文件不能超过16MiB');return validate(JSON.parse(source)); }
  function uuid(prefix) { return prefix+'-'+(root.crypto && typeof root.crypto.randomUUID==='function'?root.crypto.randomUUID():Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'-'+Math.random().toString(36).slice(2)); }
  function createCharacter(name='新角色') {
    const c={character_id:uuid('char'),revision:1,name,driver:'',backstory:'',bio:'',address:'各位',traits:{calm:70,stubborn:40,humor:60,talkative:40},appearance:{primary:'#70dfbe',accent:'#ffe6a6',image:null,size:24,emotion:'平静',mouth:false},voice:{profile_id:uuid('voice'),provider:'',service:'',voice_id:'',local_voice_id:'',language:'zh-CN',description:'待选择正式语音服务与音色。',style:'自然、清楚',rate:1,pitch:1,volume:0.8,stability:0.5,similarity:0.75,expressiveness:0.5,sample:'你好，这是我的声音试听。'}};
    characterCheck(c);return c;
  }
  function createScene(name='新场景') {const s={scene_id:uuid('scene'),name,description:'',environment:'observatory',accent:'#70dfbe',background_image:null,cast_ids:[],placements:[],layout:'duo'};sceneCheck(s);return s;}
  function defaults() { return validate({schema_version:VERSION,characters:[],scenes:[],sessions:[],memories:[],selected_character_id:null,selected_scene_id:null,active_session_id:null,assets:{}}); }
  function findRecord(records,key,value,label) {const r=records.find(x=>x[key]===value);assert(r,label+'不存在');return r;}
  function latestTime(db) {
    let latest=Date.now();
    const take=t=>{if(t)latest=Math.max(latest,Date.parse(t)+1);};
    db.sessions.forEach(s=>{take(s.started_at);take(s.ended_at);s.events.forEach(e=>take(e.created_at));});db.memories.forEach(m=>{take(m.created_at);take(m.reviewed_at);});
    return new Date(latest).toISOString();
  }
  function addCharacter(db,c) {const next=validate(db);characterCheck(c);assert(next.characters.length<LIMITS.characters,'角色库已满');next.characters.push(clone(c));next.selected_character_id=c.character_id;return validate(next);}
  function updateCharacter(db,characterId,patch) {
    const next=validate(db),c=findRecord(next.characters,'character_id',characterId,'角色');
    const editable=CHARACTER_KEYS.filter(k=>!['character_id','revision'].includes(k));object(patch,editable,'角色修改',true);assert(Object.keys(patch).length>0,'角色修改不能为空');
    for(const key of Object.keys(patch)) {
      if(['traits','appearance','voice'].includes(key)) {
        const allowed=key==='traits'?TRAIT_KEYS:key==='appearance'?APPEARANCE_KEYS:VOICE_KEYS.filter(k=>k!=='profile_id');object(patch[key],allowed,'角色修改.'+key,true);
        // Motion is replaced as a complete inert object; validate its nested
        // descriptors before JSON cloning can invoke serialization hooks.
        if(key==='appearance' && Object.hasOwn(patch[key],'motion'))motionCheck(patch[key].motion,'角色修改.appearance.motion');
        Object.assign(c[key],clone(patch[key]));
      } else c[key]=clone(patch[key]);
    }
    c.revision++;return validate(next);
  }
  function duplicateCharacter(db,characterId) {
    const next=validate(db),c=clone(findRecord(next.characters,'character_id',characterId,'角色'));
    c.character_id=uuid('char');c.voice.profile_id=uuid('voice');c.revision=1;c.name=c.name.slice(0,27)+' 副本';return addCharacter(next,c);
  }
  function addScene(db,s) {const next=validate(db);sceneCheck(s);assert(next.scenes.length<LIMITS.scenes,'场景库已满');next.scenes.push(clone(s));next.selected_scene_id=s.scene_id;return validate(next);}
  function updateScene(db,sceneId,patch) {
    const next=validate(db),s=findRecord(next.scenes,'scene_id',sceneId,'场景');object(patch,SCENE_KEYS.filter(k=>k!=='scene_id'),'场景修改',true);assert(Object.keys(patch).length>0,'场景修改不能为空');
    if(Object.hasOwn(patch,'cast_ids')){ids(patch.cast_ids,4,'场景演员');if(!Object.hasOwn(patch,'placements'))s.placements=placements(patch.cast_ids,s.placements);}
    Object.assign(s,clone(patch));return validate(next);
  }
  function setCast(db,sceneId,castIds) {return updateScene(db,sceneId,{cast_ids:castIds});}
  function startSession(db,sceneId) {
    const next=validate(db);assert(next.active_session_id===null,'请先结束当前排演');assert(next.sessions.length<LIMITS.sessions,'会话数量已达上限');
    const scene=findRecord(next.scenes,'scene_id',sceneId,'场景');assert(scene.cast_ids.length>0,'请先选择至少一位角色');
    const s={session_id:uuid('session'),scene_id:sceneId,scene_snapshot:clone(scene),participant_ids:[...scene.cast_ids],character_snapshots:scene.cast_ids.map(i=>clone(findRecord(next.characters,'character_id',i,'角色'))),status:'running',started_at:latestTime(next),ended_at:null,events:[]};
    next.sessions.push(s);next.active_session_id=s.session_id;next.selected_scene_id=sceneId;return validate(next);
  }
  function active(next,sessionId) {const s=findRecord(next.sessions,'session_id',sessionId,'会话');assert(s.status==='running' && next.active_session_id===sessionId,'该会话不在排演中');return s;}
  function addEvent(db,sessionId,eventText,witnessIds) {
    const next=validate(db),s=active(next,sessionId);text(eventText,2000,'事件内容',1);ids(witnessIds,4,'见证者',1);assert(witnessIds.every(i=>s.participant_ids.includes(i)),'见证者必须是本次排演角色');assert(s.events.length<LIMITS.events,'事件数量已达上限');
    s.events.push({event_id:uuid('event'),text:eventText,witness_ids:[...witnessIds],source:'manual_rehearsal',created_at:latestTime(next)});return validate(next);
  }
  function projectEnd(next,sessionId,reserveIds=false) {
    const s=active(next,sessionId),at=latestTime(next);
    const used=new Set([...next.characters.map(c=>c.character_id),...next.characters.map(c=>c.voice.profile_id),...next.scenes.map(x=>x.scene_id),...next.sessions.map(x=>x.session_id),...next.sessions.flatMap(x=>x.events.map(e=>e.event_id)),...next.memories.map(m=>m.memory_id)]);
    let reserveIndex=0;
    const memoryId=()=>{
      if(!reserveIds)return uuid('memory');
      let candidate;do{candidate=('memory-reserved-'+reserveIndex+++'-').padEnd(80,'x');}while(used.has(candidate));used.add(candidate);return candidate;
    };
    const drafts=s.participant_ids.flatMap(characterId=>{
      const witnessed=s.events.filter(e=>e.witness_ids.includes(characterId));if(!witnessed.length)return [];
      // This is a bounded extractive note. It never infers a character's internal state.
      const prefix='来源：本地手动演练记录\n';let draft=prefix;
      for(let i=0;i<witnessed.length;i++) {const line=(i+1)+'. '+witnessed[i].text+'\n';if(draft.length+line.length>11800){draft+='其余已见证事件请查看本次排演原始记录。';break;}draft+=line;}
      return [{memory_id:memoryId(),character_id:characterId,session_id:sessionId,source_event_ids:witnessed.map(e=>e.event_id),text:draft.trim(),status:'draft',created_at:at,reviewed_at:null}];
    });
    assert(next.memories.length+drafts.length<=LIMITS.memories,'记忆数量达到上限，请先清理记忆');s.status='ended';s.ended_at=at;next.active_session_id=null;next.memories.push(...drafts);return next;
  }
  function preflightEnd(db) {
    try {validate(projectEnd(clone(db),db.active_session_id,true));}
    catch(e){throw new Error('当前修改未保存：需为结束排演及记忆草稿保留空间。'+e.message);}
  }
  function endSession(db,sessionId) {
    const next=validate(db);return validate(projectEnd(next,sessionId));
  }
  function reviewMemory(db,memoryId,action,replacement) {
    const next=validate(db),m=findRecord(next.memories,'memory_id',memoryId,'记忆');oneOf(action,['edit','confirm','reject','delete'],'审核操作');
    if(action==='delete'){assert(replacement===undefined,'删除不能附带文本');next.memories=next.memories.filter(x=>x.memory_id!==memoryId);return validate(next);}
    if(action==='confirm' && m.status==='confirmed'){assert(replacement===undefined || replacement===m.text,'已确认记忆不能覆盖文本');return next;}
    assert(m.status==='draft','仅待审核记忆可以编辑、确认或拒绝');
    if(action==='edit'){text(replacement,12000,'记忆内容',1);m.text=replacement;}
    if(action==='confirm'){if(replacement!==undefined){text(replacement,12000,'记忆内容',1);m.text=replacement;}m.status='confirmed';m.reviewed_at=latestTime(next);}
    if(action==='reject'){assert(replacement===undefined,'拒绝不能附带文本');m.status='rejected';m.reviewed_at=latestTime(next);}
    return validate(next);
  }
  function buildContext(db,sessionId,characterId) {
    const current=validate(db),s=findRecord(current.sessions,'session_id',sessionId,'会话');assert(s.participant_ids.includes(characterId),'角色不是该会话参加者');
    const profile=findRecord(s.character_snapshots,'character_id',characterId,'角色快照');
    const memories=current.memories.filter(m=>m.character_id===characterId && m.status==='confirmed' && m.reviewed_at<s.started_at && m.session_id!==s.session_id && current.sessions.find(x=>x.session_id===m.session_id).ended_at<s.started_at);
    return clone({session_id:sessionId,character:profile,memories,events:s.events.filter(e=>e.witness_ids.includes(characterId)),peers:s.character_snapshots.filter(c=>c.character_id!==characterId).map(c=>({character_id:c.character_id,name:c.name})),scene:{scene_id:s.scene_id,name:s.scene_snapshot.name,description:s.scene_snapshot.description,environment:s.scene_snapshot.environment,placements:s.scene_snapshot.placements}});
  }
  const api={VERSION,STATES:Object.freeze([...STATES]),LIMITS,defaults,validate,parse,createCharacter,addCharacter,updateCharacter,duplicateCharacter,createScene,addScene,updateScene,setCast,startSession,addEvent,endSession,reviewMemory,buildContext,resolveImage};
  if(typeof module!=='undefined' && module.exports)module.exports=api;root.StudioModel=api;
})(typeof globalThis!=='undefined'?globalThis:this);
