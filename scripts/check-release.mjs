import fs from 'node:fs';
import path from 'node:path';
import { ROOT, walk, json } from './lib.mjs';

export function checkRelease(root = ROOT) {
  const files=walk(root), issues=[];
  const roots=new Set(['apps','packages','scripts','config','docs','skills','tests','.github']);
  const topFiles=new Set(['README.md','LICENSE','THIRD_PARTY_NOTICES.md','package.json','package-lock.json','.gitignore','setup.sh','Setup-Windows.cmd','SOURCE_MANIFEST.json']);
  for (const rel of files) {
    if (!roots.has(rel.split('/')[0]) && !topFiles.has(rel)) issues.push(`${rel}: outside source allowlist`);
    if (/(^|\/)\.env(?:\.|$)|\.(?:log|jsonl|sqlite\w*|db|pem|key|pfx|mp4|mov|wav|mp3|webm)$/i.test(rel)) issues.push(`${rel}: private/runtime/media file type`);
    const file=path.join(root,rel), buffer=fs.readFileSync(file);
    if (/\.(?:m?js|cjs|json|md|html|css|yml|yaml|txt|sh|cmd|ps1)$/.test(rel) || /(?:^|\/)LICENSE(?:\.[^/]+)?$/.test(rel)) {
      const text=buffer.toString('utf8');
      // Deliberately check concrete private-path patterns, not ordinary credential field names.
      if (/\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(text) || /[A-Za-z]:\\Users\\[A-Za-z0-9._ -]+\\/.test(text)) issues.push(`${rel}: absolute home path`);
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) issues.push(`${rel}: private key material`);
      if (/(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_\-]{20,}/.test(text)) issues.push(`${rel}: possible access token`);
      if (/\b01[a-f0-9]{6}-[a-f0-9]{4}-7[a-f0-9]{3}-[a-f0-9]{4}-[a-f0-9]{12}\b/i.test(text)) issues.push(`${rel}: persistent conversation identifier`);
    }
  }
  for (const required of ['LICENSE','package-lock.json','apps/studio/package-lock.json','skills/ai-streamer-workflow/SKILL.md','packages/runtime/index.mjs']) {
    if (!files.includes(required)) issues.push(`${required}: missing`);
  }
  for (const manifest of files.filter(f=>/(^|\/)package\.json$/.test(f))) {
    const packageData=json(path.join(root,manifest));
    for (const [name,command] of Object.entries(packageData.scripts || {})) {
      const match=String(command).match(/^node\s+([A-Za-z0-9_./-]+\.(?:mjs|cjs|js))(?:\s|$)/);
      if (match && !fs.existsSync(path.resolve(root,path.dirname(manifest),match[1]))) issues.push(`${manifest}: script ${name} points to a missing file`);
    }
  }
  const defaults=json(path.join(root,'config/workflow.defaults.json'));
  if (defaults.roles.some(r=>r.model!==null || r.provider!==null || r.reasoning!==null)) issues.push('config: role model/tier is preselected');
  if (defaults.hosts.some(h=>h.profile || h.model!==null || h.voice!==null)) issues.push('config: character/model/voice seeded');
  if (defaults.cost.paidEnabled || defaults.broadcast.enabled || defaults.run.autoStart) issues.push('config: external output/cost enabled by default');
  return {ok:issues.length===0,files:files.length,issues};
}
if (process.argv[1] && path.resolve(process.argv[1])===path.join(ROOT,'scripts/check-release.mjs')) {
  const result=checkRelease();console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;
}
