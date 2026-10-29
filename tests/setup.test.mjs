import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setup } from '../scripts/setup.mjs';

test('fresh setup has seven uncreated capability roles, blank models, disabled output and paid calls', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'streamer-setup-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const result=setup({directory:dir,install:false});
  const config=JSON.parse(fs.readFileSync(result.configuration));
  const plan=JSON.parse(fs.readFileSync(path.join(result.agentPlan,'manifest.json')));
  assert.equal(plan.roles.length,7);
  assert.ok(plan.roles.some(r=>r.id==='game-adaptation-engineer'));
  assert.ok(plan.roles.every(r=>r.model===null && r.provider===null && r.reasoning===null && r.sessionId===null));
  assert.ok(config.hosts.every(h=>h.profile==='' && h.voice===null));
  assert.equal(config.cost.paidEnabled,false); assert.equal(config.cost.limitUSD,0);
  assert.equal(config.broadcast.enabled,false); assert.equal(config.run.autoStart,false); assert.equal(result.started,false);
  const prompt=fs.readFileSync(path.join(result.agentPlan,'coordinator.md'),'utf8');
  assert.ok(prompt.includes(path.join(dir,'.agents/skills/ai-streamer-workflow/SKILL.md')));
  assert.ok(fs.existsSync(path.join(dir,'.agents/skills/ai-streamer-workflow/SKILL.md')));
  assert.ok(prompt.includes(result.configuration));
});
test('repeat setup preserves user choices, role receipts and edited installed skill',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'streamer-repeat-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const first=setup({directory:dir,install:false});
  const config=JSON.parse(fs.readFileSync(first.configuration)); config.hosts[0].displayName='User Choice';
  fs.writeFileSync(first.configuration,JSON.stringify(config));
  const skill=path.join(dir,'.agents/skills/ai-streamer-workflow/SKILL.md');fs.writeFileSync(skill,'user edit');
  const manifest=path.join(first.agentPlan,'manifest.json');fs.writeFileSync(manifest,'{"status":"CREATED_WITH_RECEIPTS"}');
  setup({directory:dir,install:false});
  assert.equal(JSON.parse(fs.readFileSync(first.configuration)).hosts[0].displayName,'User Choice');
  assert.equal(fs.readFileSync(skill,'utf8'),'user edit');
  assert.equal(JSON.parse(fs.readFileSync(manifest)).status,'CREATED_WITH_RECEIPTS');
});
