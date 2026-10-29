'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {resolveDataDirectory,ensureDataDirectory,writeStatus}=require('../data-directory.cjs');
function temporary(t){const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'programme-public-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('new default directory is isolated and marked',t=>{
 const root=temporary(t),dir=resolveDataDirectory(root);
 assert.equal(path.basename(dir),'AiStreamerProgrammePublic');ensureDataDirectory(dir);ensureDataDirectory(dir);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'.public-programme-owner.json'))).app,'AiStreamerProgrammePublic');
});
test('legacy paths are refused before any old directory contents are read',t=>{
 const root=temporary(t);
 for(const name of ['ProgrammeHost','CharacterStudio','characterstudio','ProgrammeHost/child','AiStreamerStudioPublic'])assert.throws(()=>resolveDataDirectory(root,path.join(root,name)));
 assert.throws(()=>resolveDataDirectory(root,'relative/data'));
});
test('foreign nonempty directory and symbolic links are rejected',t=>{
 const root=temporary(t),foreign=path.join(root,'foreign');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'workspace.json'),'keep');
 assert.throws(()=>ensureDataDirectory(foreign));assert.equal(fs.readFileSync(path.join(foreign,'workspace.json'),'utf8'),'keep');
 const link=path.join(root,'alias');fs.symlinkSync(foreign,link,'dir');assert.throws(()=>ensureDataDirectory(link));
});
test('Windows path comparison rejects case and trailing-dot legacy aliases',()=>{
 for(const candidate of ['C:\\Users\\User\\AppData\\ProgrammeHost','C:\\Users\\User\\AppData\\CHARACTERSTUDIO. ','C:\\Users\\User\\AppData\\ProgrammeHost\\next'])assert.throws(()=>resolveDataDirectory('C:\\Users\\User\\AppData',candidate,path.win32));
 assert.equal(resolveDataDirectory('C:\\Users\\User\\AppData',undefined,path.win32),'C:\\Users\\User\\AppData\\AiStreamerProgrammePublic');
});
test('an owned profile cannot redirect its Session directory outside the profile',t=>{
 const root=temporary(t),dir=path.join(root,'owned'),outside=path.join(root,'outside');ensureDataDirectory(dir);fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(dir,'Session'),'dir');
 assert.throws(()=>ensureDataDirectory(dir));assert.equal(fs.readdirSync(outside).length,0);
});
test('status writes do not follow a planted fixed temporary-file link',t=>{
 const root=temporary(t),dir=path.join(root,'owned'),outside=path.join(root,'outside.txt');ensureDataDirectory(dir);fs.writeFileSync(outside,'keep');fs.symlinkSync(outside,path.join(dir,'status.json.tmp'));
 writeStatus(dir,{state:'empty'});
 assert.equal(fs.readFileSync(outside,'utf8'),'keep');assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'status.json'))).state,'empty');
});
