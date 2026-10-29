import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './lib.mjs';
let failed=false;
for (const dir of ['tests','packages/runtime/test','packages/runtime/tests','apps/studio/tests','apps/studio/test','apps/programme-host/tests','apps/programme-host/test']) {
  const full=path.join(ROOT,dir);
  if (!fs.existsSync(full)) continue;
  const files=fs.readdirSync(full).filter(n=>/\.test\.(mjs|cjs|js)$/.test(n)).map(n=>path.join(full,n));
  if (!files.length) continue;
  const r=spawnSync(process.execPath,['--test',...files],{cwd:ROOT,stdio:'inherit'});
  if(r.error || r.status!==0) failed=true;
}
process.exitCode=failed?1:0;
