'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
function sourceFiles(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{if(['node_modules','dist'].includes(e.name)||e.name.startsWith('.'))return [];const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('SOURCE_SYMLINK_NOT_ALLOWED');return e.isDirectory()?sourceFiles(p):[p];});}
const files=sourceFiles(root),p=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
if(p.main!=='main.cjs'||p.license!=='MIT'||p.devDependencies?.electron!=='45.0.0')throw Error('PACKAGE_CONTRACT_INVALID');
for(const file of files.filter(f=>f.endsWith('.cjs')))execFileSync(process.execPath,['--check',file],{stdio:'pipe'});
if(files.some(f=>/\.(mp4|mov|mp3|webp|png|jpeg)$/i.test(f)))throw Error('NO_BUNDLED_PERSONAL_MEDIA_ALLOWED');
console.log('Programme Host source syntax and package contract checked; no app or server started.');
