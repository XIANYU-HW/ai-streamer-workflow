import fs from 'node:fs';
import path from 'node:path';
import { ROOT, json, nodeRequirement, npmCLI } from './lib.mjs';
function dependency(app) {
  const folder=path.join(ROOT,'apps',app,'node_modules/electron'),marker=path.join(folder,'path.txt');
  if(!fs.existsSync(marker))return 'MISSING';
  const executable=path.join(folder,'dist',fs.readFileSync(marker,'utf8').trim());
  return fs.existsSync(executable)?'INSTALLED':'BINARY_MISSING';
}
try {
  nodeRequirement();
  const args=process.argv.slice(2);
  if (args.length && (args.length!==2 || args[0]!=='--directory' || !args[1])) throw new Error('用法：doctor [--directory 配置目录]');
  const directory=args.length ? path.resolve(args[1]) : ROOT;
  const file = path.join(directory,'.local/workflow.json');
  const config = fs.existsSync(file) ? json(file) : null;
  const result = {
    node: process.versions.node,
    npmAvailable: Boolean(npmCLI()),
    config: config ? 'PRESENT_NOT_RUNTIME_PROOF' : 'MISSING_RUN_SETUP',
    studioDependency: dependency('studio'),
    programmeDependency: dependency('programme-host'),
    agents: fs.existsSync(path.join(directory,'.local/agent-plan/manifest.json')) ? json(path.join(directory,'.local/agent-plan/manifest.json')).status : 'NOT_PLANNED',
    paidCallsEnabled: Boolean(config?.cost?.paidEnabled),
    adapters: Object.fromEntries(Object.entries(config?.adapters || {}).map(([name,value])=>[name,value ? 'CONFIGURED_NOT_VERIFIED':'UNCONFIGURED'])),
    realGame: 'NOT_TESTED_BY_DOCTOR', realAudio: 'NOT_TESTED_BY_DOCTOR', publicBroadcast:'NOT_STARTED_BY_DOCTOR'
  };
  console.log(JSON.stringify(result,null,2));
  if (!config || result.studioDependency!=='INSTALLED' || result.programmeDependency!=='INSTALLED') process.exitCode=1;
} catch(e) { console.error(e.message);process.exitCode=1; }
