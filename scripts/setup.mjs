import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, json, writeOnce, nodeRequirement, npm } from './lib.mjs';

export function setup({ directory = ROOT, install = true, skill = true } = {}) {
  nodeRequirement();
  const target = path.resolve(directory);
  fs.mkdirSync(target, { recursive: true });
  const local = path.join(target, '.local');
  const configPath = path.join(local, 'workflow.json');
  writeOnce(configPath, fs.readFileSync(path.join(ROOT, 'config/workflow.defaults.json')));
  const config = json(configPath);
  if (config.schemaVersion !== 1 || !Array.isArray(config.roles)) throw new Error('本地配置格式不兼容；保留原文件，请先处理配置错误。');
  const roleText = fs.readFileSync(path.join(ROOT, 'skills/ai-streamer-workflow/references/roles.md'),'utf8');
  const plan = { status: 'PLANNED_NOT_CREATED', roles: [] };
  for (const role of config.roles) {
    if (!/^[a-z][a-z-]+$/.test(role.id)) throw new Error('无效的岗位 ID');
    const skillPath = skill ? path.join(target,'.agents/skills/ai-streamer-workflow/SKILL.md') : path.join(ROOT,'skills/ai-streamer-workflow/SKILL.md');
    const prompt = `你负责“${role.name}”岗位（${role.id}）。项目目标：将游戏实况、互动、舞台、声音和节目输出接成可验证的工作流。\n应用源码仓库：${ROOT}\n本次项目配置目录：${target}\n先读取 Skill：${skillPath}\n本地配置：${configPath}\n只读取本岗及当前运行所需资料。岗位能力要求如下：\n\n${roleText}\n\n当前只完成配置与本岗准备，不自动开始游戏、声音、录制或公开直播。模型由使用者自行选择，没有预设模型或档位。交接记录存本次配置目录的 .local/，禁止放进发布源。`;
    writeOnce(path.join(local, 'agent-plan', `${role.id}.md`), prompt);
    plan.roles.push({ id: role.id, model: role.model ?? null, provider: role.provider ?? null, reasoning: role.reasoning ?? null, sessionId: null, status: 'PLANNED_NOT_CREATED' });
  }
  writeOnce(path.join(local, 'agent-plan/manifest.json'), JSON.stringify(plan,null,2)+'\n');
  if (skill) {
    const source = path.join(ROOT, 'skills/ai-streamer-workflow');
    const destination = path.join(target, '.agents/skills/ai-streamer-workflow');
    // Never merge over an existing user-edited skill; source remains available for a manual update.
    if (!fs.existsSync(destination)) fs.cpSync(source,destination,{recursive:true,errorOnExist:true,force:false});
  }
  writeOnce(path.join(target,'.gitignore'),'.local/\n.agents/\nnode_modules/\n.env*\n');
  if (install) {
    for (const app of ['studio','programme-host']) {
      const appRoot = path.join(ROOT,'apps',app);
      if (!fs.existsSync(path.join(appRoot,'package.json'))) continue;
      if (!fs.existsSync(path.join(appRoot,'package-lock.json'))) throw new Error(`${app} 缺 package-lock.json，当前源包不完整。`);
      npm(['ci','--no-audit','--no-fund'],appRoot);
      // Electron can defer its binary download until first require. Resolve it now,
      // without launching the application, so setup is complete when it reports success.
      const binary=spawnSync(process.execPath,['-e',"require('node:fs').accessSync(require('electron')); console.log('Electron runtime ready; application not started.');"],{cwd:appRoot,stdio:'inherit'});
      if(binary.error || binary.status!==0) throw new Error(`${app} 运行库下载/检查未完成，可修复网络后重跑 setup。`);
    }
  }
  return { configuration: configPath, agentPlan: path.join(local,'agent-plan'), agentStatus:'PLANNED_NOT_CREATED', installed:install, started:false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT,'scripts/setup.mjs')) {
  try {
    const args = process.argv.slice(2), at = args.indexOf('--directory');
    if (at >= 0 && (!args[at+1] || args[at+1].startsWith('--'))) throw new Error('--directory 需要路径');
    const unknown = args.filter((arg,i)=> !['--skip-install','--skip-skill','--directory'].includes(arg) && !(at >= 0 && i === at+1));
    if (unknown.length) throw new Error(`未知参数：${unknown.join(' ')}`);
    console.log(JSON.stringify(setup({directory: at < 0 ? ROOT : args[at+1], install:!args.includes('--skip-install'), skill:!args.includes('--skip-skill')}),null,2));
    console.log('本地配置与岗位提示词已准备。实际 Agent 会话仍需由你的 AI 客户端创建。运行 npm run doctor 查看待配置项；若指定了 --directory，doctor 使用相同参数。');
  } catch (e) { console.error(e.message); process.exitCode=1; }
}
