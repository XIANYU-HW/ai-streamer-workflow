'use strict';
// Installation only checks source; it never launches Electron or a local service.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
for(const dir of [root,path.join(root,'renderer'),__dirname])for(const name of fs.readdirSync(dir))if(/\.(cjs|js)$/.test(name))new vm.Script(fs.readFileSync(path.join(dir,name),'utf8'),{filename:name});
for(const html of fs.readdirSync(path.join(root,'renderer')).filter(n=>n.endsWith('.html'))){const s=fs.readFileSync(path.join(root,'renderer',html),'utf8');for(const match of s.matchAll(/(?:src|href)="([^"#]+\.(?:js|css))"/g))if(!fs.existsSync(path.join(root,'renderer',match[1])))throw Error('Missing local asset: '+match[1]);}
console.log('Studio source and local assets checked; no application was started.');
