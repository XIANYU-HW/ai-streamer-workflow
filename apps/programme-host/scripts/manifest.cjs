'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),pkg=require('../package.json');
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>{if(['node_modules','dist','SOURCE_MANIFEST.json'].includes(e.name)||e.name.endsWith('.log'))return [];const p=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('SOURCE_SYMLINK_NOT_ALLOWED');return e.isDirectory()?files(p):[p];});}
const manifest={schema_version:1,package:pkg.name,version:pkg.version,license:pkg.license,electron_version:pkg.devDependencies.electron,files:files(root).sort().map(file=>({path:path.relative(root,file).split(path.sep).join('/'),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}))};
fs.writeFileSync(path.join(root,'SOURCE_MANIFEST.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(`Source manifest contains ${manifest.files.length} relative paths; no runtime data.`);
