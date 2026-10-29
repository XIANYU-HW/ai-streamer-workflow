'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../renderer/model.js');
test('new workspace is empty and has no automatic role, scene, history or image',()=>{
 const d=M.defaults();for(const field of ['characters','scenes','sessions','memories'])assert.deepEqual(d[field],[],field);
 assert.deepEqual(d.assets,{});assert.equal(d.selected_character_id,null);assert.equal(d.selected_scene_id,null);assert.equal(d.active_session_id,null);assert.deepEqual(M.validate(d),d);
});
test('new character does not select an AI driver or paid voice service',()=>{
 const c=M.createCharacter();assert.equal(c.driver,'');assert.equal(c.voice.provider,'');assert.equal(c.voice.service,'');assert.equal(c.voice.voice_id,'');assert.equal(c.voice.local_voice_id,'');assert.equal(c.appearance.image,null);
});
test('users can build either characters or scenes first and choose their own model binding label',()=>{
 const c=M.createCharacter('角色一');c.driver='my-provider-role';let d=M.addCharacter(M.defaults(),c);assert.equal(d.scenes.length,0);assert.equal(d.selected_scene_id,null);
 const scene=M.createScene('我的舞台');d=M.addScene(d,scene);d=M.setCast(d,scene.scene_id,[c.character_id]);d=M.startSession(d,scene.scene_id);assert.equal(d.sessions[0].character_snapshots[0].driver,'my-provider-role');
 const alone=M.addScene(M.defaults(),M.createScene());assert.equal(alone.characters.length,0);assert.equal(alone.selected_character_id,null);
});
test('new memories must come from user-recorded events, never a shipped story',()=>{
 const c=M.createCharacter('角色一'),s=M.createScene();let d=M.addScene(M.addCharacter(M.defaults(),c),s);d=M.setCast(d,s.scene_id,[c.character_id]);d=M.startSession(d,s.scene_id);
 d=M.addEvent(d,d.active_session_id,'使用者录入的一次事件',[c.character_id]);d=M.endSession(d,d.active_session_id);
 assert.equal(d.memories.length,1);assert.equal(d.memories[0].status,'draft');assert.match(d.memories[0].text,/使用者录入/);
});
