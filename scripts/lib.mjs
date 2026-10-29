import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function writeOnce(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.writeFileSync(file, value, { flag: 'wx', mode: 0o600 }); return true; }
  catch (e) { if (e.code !== 'EEXIST') throw e; return false; }
}
export function nodeRequirement() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 12) throw new Error('需要 Node.js 22.12 或更新版本：https://nodejs.org/en/download');
}
export function npmCLI() {
  const candidates = [process.env.npm_execpath, process.env.AI_STREAMER_NPM_CLI,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const folder of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of ['npm', 'npm-cli.js']) {
      try { candidates.push(fs.realpathSync(path.join(folder, name))); } catch {}
    }
  }
  return candidates.find(p => p && /npm-cli\.js$/.test(p) && fs.existsSync(p)) || null;
}
export function npm(args, cwd) {
  const cli = npmCLI();
  if (!cli) throw new Error('未找到 npm。请安装包含 npm 的 Node.js，然后重试。');
  const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` };
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} 失败（${result.status}），修复后可直接重跑 setup。`);
}
export function walk(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).flatMap(e => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (['node_modules', '.local', '.agents', '.git', 'dist', 'artifacts', 'coverage'].includes(e.name) || e.name === '.DS_Store') return [];
    if (e.isSymbolicLink()) throw new Error(`发布源不允许符号链接：${rel}`);
    return e.isDirectory() ? walk(path.join(dir,e.name), rel) : [rel];
  });
}
