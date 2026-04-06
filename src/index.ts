#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cac from 'cac';
import { isMcpMode } from './config.js';
import { registerCliCommands } from './cli/registerCommands.js';
import { buildStartGuide, shouldRunDefaultStart } from './workflow/start.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.resolve(__dirname, '../package.json');
const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));

const cli = cac('contextatlas');

if (process.argv.includes('-v') || process.argv.includes('--version')) {
  console.log(pkg.version);
  process.exit(0);
}

registerCliCommands(cli);

if (shouldRunDefaultStart(process.argv.slice(2), isMcpMode)) {
  try {
    const guide = await buildStartGuide(process.cwd());
    process.stdout.write(`${guide}\n`);
    process.exit(0);
  } catch (err) {
    const error = err as Error;
    console.error(`[contextatlas] 生成默认主路径入口失败: ${error.message}`);
    process.exit(1);
  }
}

cli.help();
cli.parse();
