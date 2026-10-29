'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parseOptions,createPolicy}=require('../policy.cjs');
const offline='file:///safe/programme/offline.html',origin='http://127.0.0.1:19100';
test('default startup is offline with no remote target',()=>{
 const c=parseOptions([],{}),p=createPolicy(c,offline);
 assert.equal(c.url,null);assert.equal(c.standbyUrl,null);
 assert.equal(p.allowRequest({url:offline,method:'GET',resourceType:'mainFrame'}),true);
 assert.equal(p.allowRequest({url:origin+'/overlay.html',method:'GET'}),false);
});
test('explicit loopback output serves only exact public resources',()=>{
 const c=parseOptions(['--url',origin+'/overlay.html'],{}),p=createPolicy(c,offline);
 for(const route of ['/overlay.html','/scene-output.html','/style.css','/motion.css','/avatar.js','/stage-render.js','/overlay.js','/api/public','/api/public-meta','/api/motion','/state.json'])assert.equal(p.allowRequest({url:origin+route,method:'GET'}),true,route);
 assert.equal(p.allowNavigation(origin+'/overlay.html'),true);
 assert.equal(p.allowNavigation(origin+'/scene-output.html'),false);
});
test('unknown private pages, remote hosts and tokens are rejected at configuration',()=>{
 for(const url of ['https://example.com/overlay.html','http://localhost:19100/overlay.html','http://127.0.0.1:19100/index.html','http://user:secret@127.0.0.1:19100/overlay.html','http://127.0.0.1:19100/overlay.html?token=secret','http://127.0.0.1:19100/overlay.html#x','http://127.0.0.1:19100/%6fverlay.html','file:///etc/passwd'])assert.throws(()=>parseOptions(['--url',url],{}),undefined,url);
 assert.throws(()=>parseOptions(['--standby-url',origin+'/standby.html'],{}));
 assert.throws(()=>parseOptions(['--url',origin+'/overlay.html','--standby-url','http://127.0.0.1:19200/standby.html'],{}));
});
test('no modifying request, private API, websocket, child window or media',()=>{
 const p=createPolicy(parseOptions(['--url',origin+'/overlay.html'],{}),offline);
 for(const route of ['/api/cloud-audio','/api/private','/v1/status','/index.html','/app.js','/runtime-access.json','/api/public?token=x'])assert.equal(p.allowRequest({url:origin+route,method:'GET'}),false,route);
 for(const method of ['POST','PUT','PATCH','DELETE','HEAD'])assert.equal(p.allowRequest({url:origin+'/api/public',method}),false);
 for(const resourceType of ['media','webSocket','subFrame'])assert.equal(p.allowRequest({url:origin+'/overlay.html',method:'GET',resourceType}),false);
 assert.equal(p.allowRequest({url:'http://127.0.0.1:19200/api/public',method:'GET'}),false);
 assert.equal(p.allowRequest({url:'data:text/html,script',method:'GET',resourceType:'mainFrame'}),false);
 assert.equal(p.allowRequest({url:'data:image/png;base64,aGVsbG8=',method:'GET',resourceType:'image'}),true);
});
test('only explicit standby may navigate and errors cannot become programme',()=>{
 const p=createPolicy(parseOptions(['--url',origin+'/overlay.html','--standby-url',origin+'/standby.html'],{}),offline);
 assert.equal(p.allowNavigation(origin+'/standby.html'),true);
 assert.equal(p.allowResponse({url:origin+'/overlay.html',resourceType:'mainFrame',statusCode:200}),true);
 for(const statusCode of [204,301,302,401,404,500])assert.equal(p.allowResponse({url:origin+'/overlay.html',resourceType:'mainFrame',statusCode}),false);
});
