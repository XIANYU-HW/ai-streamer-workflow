import path from 'node:path';
import fs from 'node:fs';
import { ROOT, npm } from './lib.mjs';
const app = process.argv[2];
if (!['studio','programme-host'].includes(app)) throw new Error('未知应用');
if (!fs.existsSync(path.join(ROOT,'apps',app,'package.json'))) throw new Error('源包缺少该应用');
npm(['start','--',...process.argv.slice(3)],path.join(ROOT,'apps',app));
