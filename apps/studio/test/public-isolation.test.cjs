'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const C=require('../public-config.cjs'),{WorkspaceStore}=require('../data-store.cjs'),M=require('../renderer/model.js');
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-isolation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return fs.realpathSync(root);}
test('default public directory is independent and creates only its marker',t=>{
 const root=temporary(t),dir=C.resolveDataDirectory({appData:root});assert.equal(path.basename(dir),'AiStreamerStudioPublic');C.prepareDataDirectory(dir);assert.deepEqual(fs.readdirSync(dir),[C.MARKER]);assert.equal(C.prepareDataDirectory(dir),dir);
});
test('legacy location, its aliases and unmarked existing databases are never adopted',t=>{
 const root=temporary(t),old=path.join(root,'CharacterStudio');fs.mkdirSync(old);fs.writeFileSync(path.join(old,'workspace.json'),'PRIVATE_FIXTURE');
 assert.throws(()=>C.resolveDataDirectory({appData:root,override:old}));
 const alias=path.join(root,'AiStreamerStudioPublic-alias');fs.symlinkSync(old,alias,process.platform==='win32'?'junction':'dir');assert.throws(()=>C.resolveDataDirectory({appData:root,override:alias}));
 const unmarked=path.join(root,'AiStreamerStudioPublic-import');fs.mkdirSync(unmarked);fs.writeFileSync(path.join(unmarked,'workspace.json'),'PRIVATE_FIXTURE');assert.throws(()=>C.prepareDataDirectory(unmarked));assert.equal(fs.readFileSync(path.join(unmarked,'workspace.json'),'utf8'),'PRIVATE_FIXTURE');
});
test('fresh store stays empty across save and reopen without touching a sibling database',async t=>{
 const root=temporary(t),dir=C.prepareDataDirectory(path.join(root,'AiStreamerStudioPublic-test')),old=path.join(root,'CharacterStudio');fs.mkdirSync(old);fs.writeFileSync(path.join(old,'workspace.json'),'PRIVATE_FIXTURE');
 const store=new WorkspaceStore({directory:dir,model:M});assert.equal((await store.load()).data,null);await store.save(M.defaults(),0);const loaded=await new WorkspaceStore({directory:dir,model:M}).load();assert.deepEqual(loaded.data,M.defaults());assert.equal(fs.readFileSync(path.join(old,'workspace.json'),'utf8'),'PRIVATE_FIXTURE');
});
