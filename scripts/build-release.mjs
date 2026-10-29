import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, walk, json } from './lib.mjs';
import { checkRelease } from './check-release.mjs';

// ZIP STORE needs no external archiver and is readable on all supported systems.
const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(data){let c=0xffffffff;for(const b of data)c=table[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function zip(entries){
  let offset=0;const local=[],central=[];
  for(const [name,data] of entries){
    const file=Buffer.from(name),crc=crc32(data),header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x800,6);header.writeUInt16LE(33,12);
    header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(file.length,26);
    local.push(header,file,data);
    const item=Buffer.alloc(46);item.writeUInt32LE(0x02014b50,0);item.writeUInt16LE(20,4);item.writeUInt16LE(20,6);item.writeUInt16LE(0x800,8);item.writeUInt16LE(33,14);
    item.writeUInt32LE(crc,16);item.writeUInt32LE(data.length,20);item.writeUInt32LE(data.length,24);item.writeUInt16LE(file.length,28);item.writeUInt32LE(offset,42);
    central.push(item,file);offset+=header.length+file.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
const scan=checkRelease();
if(!scan.ok)throw new Error(`源包检查失败：${scan.issues.join('\n')}`);
const manifest=walk(ROOT).filter(file=>file!=='SOURCE_MANIFEST.json').map(file=>{const data=fs.readFileSync(path.join(ROOT,file));return{file,bytes:data.length,sha256:crypto.createHash('sha256').update(data).digest('hex')};});
const version=json(path.join(ROOT,'package.json')).version,folder=`ai-streamer-workflow-${version}`;
const entries=manifest.map(m=>[`${folder}/${m.file}`,fs.readFileSync(path.join(ROOT,m.file))]);
const manifestData=Buffer.from(JSON.stringify({version,files:manifest},null,2)+'\n');
entries.push([`${folder}/SOURCE_MANIFEST.json`,manifestData]);
const output=path.join(ROOT,'artifacts');fs.mkdirSync(output,{recursive:true});
const data=zip(entries),archive=path.join(output,`${folder}-source.zip`),digest=crypto.createHash('sha256').update(data).digest('hex');
fs.writeFileSync(archive,data);fs.writeFileSync(path.join(output,'SOURCE_MANIFEST.json'),manifestData);
fs.writeFileSync(`${archive}.sha256`,`${digest}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({archive,files:manifest.length,bytes:data.length,sha256:digest},null,2));
