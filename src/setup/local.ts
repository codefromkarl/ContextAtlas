import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildDefaultEnvContent } from './defaultEnv.js';

const PROMPT_BLOCK_START = '<!-- BEGIN CONTEXTATLAS MANAGED BLOCK -->';
const PROMPT_BLOCK_END = '<!-- END CONTEXTATLAS MANAGED BLOCK -->';
const CODEX_BLOCK_START = '# BEGIN CONTEXTATLAS MANAGED BLOCK';
const CODEX_BLOCK_END = '# END CONTEXTATLAS MANAGED BLOCK';

export type LocalSetupToolset = 'full' | 'retrieval-only';
type FileAction = 'create' | 'update' | 'unchanged';

export interface LocalSetupOptions {
  homeDir: string;
  repoRoot: string;
  nodeCommand: string;
  toolset: LocalSetupToolset;
  dryRun: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

export interface LocalSetupOperation {
  path: string;
  action: FileAction;
  description: string;
}

export interface LocalSetupReport {
  changed: boolean;
  dryRun: boolean;
  platform: NodeJS.Platform;
  operations: LocalSetupOperation[];
}

export function isLocalSetupToolset(value: string): value is LocalSetupToolset {
  return value === 'full' || value === 'retrieval-only';
}

export function buildPromptManagedBlock(): string {
  return [
    PROMPT_BLOCK_START,
    '## ContextAtlas',
    '',
    '- 代码搜索优先使用 ContextAtlas MCP；普通 Grep/Glob 仅作为补充。',
    '- 处理新任务时先 `find_memory`，再 `codebase-retrieval`，确认现有实现后再修改代码。',
    '- 完成稳定功能或重构后，优先使用 `record_memory` / `session_end` 回写项目知识。',
    '- ContextAtlas 配置文件位于 `~/.contextatlas/.env`，MCP server 名称为 `contextatlas`。',
    '- 这个区块由 `contextatlas setup:local` 自动维护。',
    PROMPT_BLOCK_END,
    '',
  ].join('\n');
}

export function upsertManagedMarkdownBlock(existing: string, block: string): string {
  const pattern = new RegExp(
    `${escapeRegExp(PROMPT_BLOCK_START)}[\\s\\S]*?${escapeRegExp(PROMPT_BLOCK_END)}\\n?`,
    'm',
  );

  if (!existing.trim()) {
    return block;
  }

  if (pattern.test(existing)) {
    return existing.replace(pattern, block);
  }

  return `${existing.replace(/\s*$/, '\n\n')}${block}`;
}

export function upsertContextAtlasMcpJson(
  existing: string | undefined,
  input: {
    nodeCommand: string;
    entryScript: string;
    toolset: LocalSetupToolset;
  },
): string {
  const parsed = existing?.trim()
    ? parseObjectJson(existing, 'MCP JSON config')
    : {};
  const root = { ...parsed };
  const mcpServers = isRecord(root.mcpServers) ? { ...root.mcpServers } : {};

  mcpServers.contextatlas = {
    command: input.nodeCommand,
    args: [input.entryScript, 'mcp'],
    env: {
      CONTEXTATLAS_MCP_TOOLSET: input.toolset,
    },
  };

  root.mcpServers = mcpServers;
  return `${JSON.stringify(root, null, 2)}\n`;
}

export function upsertContextAtlasCodexConfig(
  existing: string | undefined,
  input: {
    nodeCommand: string;
    entryScript: string;
  },
): string {
  const block = buildCodexContextAtlasBlock(input);
  const managedPattern = new RegExp(
    `${escapeRegExp(CODEX_BLOCK_START)}[\\s\\S]*?${escapeRegExp(CODEX_BLOCK_END)}\\n?`,
    'm',
  );
  const rawPattern =
    /^\[mcp_servers\.contextatlas\]\n(?:.*\n)*?(?=^\[|\s*$)/m;

  if (!existing?.trim()) {
    return block;
  }

  if (managedPattern.test(existing)) {
    return existing.replace(managedPattern, block);
  }

  if (rawPattern.test(existing)) {
    return existing.replace(rawPattern, block);
  }

  return `${existing.replace(/\s*$/, '\n\n')}${block}`;
}

export function buildCodexSkillContent(): string {
  return [
    '---',
    'name: contextatlas-mcp',
    'description: "Use ContextAtlas MCP for semantic code retrieval and project memory before editing code."',
    'allowed-tools:',
    '  - mcp__contextatlas__find_memory',
    '  - mcp__contextatlas__codebase_retrieval',
    '  - mcp__contextatlas__record_memory',
    '  - mcp__contextatlas__session_end',
    '---',
    '',
    '# ContextAtlas MCP',
    '',
    '优先用 ContextAtlas 做代码理解，而不是猜文件路径。',
    '',
    '1. 新任务先 `find_memory` 看是否已有项目/模块记忆。',
    '2. 再用 `codebase-retrieval` 做语义检索，理解实现边界。',
    '3. 修改完成后，用 `record_memory` 或 `session_end` 回写稳定知识。',
    '4. `~/.contextatlas/.env` 管理 embeddings 与 rerank 配置。',
    '',
    '如果项目里已经启用了 `project-memory-hub`，优先配合它一起使用。',
    '',
  ].join('\n');
}

export function resolveClaudeDesktopConfigPath(input: {
  homeDir: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}): string {
  if (input.platform === 'darwin') {
    return path.join(
      input.homeDir,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  }

  if (input.platform === 'win32') {
    const appData = input.env.APPDATA?.trim()
      ? input.env.APPDATA.trim()
      : path.join(input.homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }

  const xdgConfigHome = input.env.XDG_CONFIG_HOME?.trim()
    ? input.env.XDG_CONFIG_HOME.trim()
    : path.join(input.homeDir, '.config');
  return path.join(xdgConfigHome, 'Claude', 'claude_desktop_config.json');
}

export async function applyLocalSetup(options: LocalSetupOptions): Promise<LocalSetupReport> {
  const entryScript = path.join(options.repoRoot, 'dist', 'index.js');
  const promptBlock = buildPromptManagedBlock();
  const operations: LocalSetupOperation[] = [];
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  await queueCreateIfMissing(
    operations,
    path.join(options.homeDir, '.contextatlas', '.env'),
    'ContextAtlas env template',
    buildDefaultEnvContent(),
    options.dryRun,
  );

  const jsonTargets = [
    {
      path: path.join(options.homeDir, '.claude', 'mcp.json'),
      description: 'Claude Code MCP config',
    },
    {
      path: resolveClaudeDesktopConfigPath({
        homeDir: options.homeDir,
        platform,
        env,
      }),
      description: 'Claude Desktop MCP config',
    },
    {
      path: path.join(options.homeDir, '.gemini', 'settings.json'),
      description: 'Gemini MCP config',
    },
  ];

  for (const target of jsonTargets) {
    const current = await readOptionalFile(target.path);
    const next = upsertContextAtlasMcpJson(current, {
      nodeCommand: options.nodeCommand,
      entryScript,
      toolset: options.toolset,
    });
    await queueWrite(operations, target.path, target.description, next, options.dryRun, current);
  }

  const codexConfigPath = path.join(options.homeDir, '.codex', 'config.toml');
  const codexConfig = await readOptionalFile(codexConfigPath);
  await queueWrite(
    operations,
    codexConfigPath,
    'Codex MCP config',
    upsertContextAtlasCodexConfig(codexConfig, {
      nodeCommand: options.nodeCommand,
      entryScript,
    }),
    options.dryRun,
    codexConfig,
  );

  const promptTargets = [
    {
      path: await resolveClaudePromptPath(options.homeDir),
      description: 'Claude prompt doc',
    },
    {
      path: await resolveCodexPromptPath(options.homeDir),
      description: 'Codex prompt doc',
    },
    {
      path: path.join(options.homeDir, '.gemini', 'GEMINI.md'),
      description: 'Gemini prompt doc',
    },
  ];

  for (const target of promptTargets) {
    const current = await readOptionalFile(target.path);
    const next = upsertManagedMarkdownBlock(current ?? '', promptBlock);
    await queueWrite(operations, target.path, target.description, next, options.dryRun, current);
  }

  await queueWrite(
    operations,
    path.join(options.homeDir, '.codex', 'skills', 'contextatlas-mcp', 'SKILL.md'),
    'Codex ContextAtlas skill',
    buildCodexSkillContent(),
    options.dryRun,
  );

  return {
    changed: operations.some((operation) => operation.action !== 'unchanged'),
    dryRun: options.dryRun,
    platform,
    operations,
  };
}

export function formatLocalSetupReport(report: LocalSetupReport): string {
  const lines = [
    'ContextAtlas Local Setup',
    `Mode: ${report.dryRun ? 'DRY-RUN' : 'APPLY'}`,
    `Detected Platform: ${report.platform}`,
    '',
    'Resolved Paths:',
    '',
  ];

  for (const operation of report.operations) {
    lines.push(`- ${operation.action}: ${operation.description}`);
    lines.push(`  ${operation.path}`);
  }

  return lines.join('\n');
}

function buildCodexContextAtlasBlock(input: {
  nodeCommand: string;
  entryScript: string;
}): string {
  return [
    CODEX_BLOCK_START,
    '[mcp_servers.contextatlas]',
    `command = ${toTomlString(input.nodeCommand)}`,
    `args = [${toTomlString(input.entryScript)}, "mcp"]`,
    'startup_timeout_sec = 30.0',
    CODEX_BLOCK_END,
    '',
  ].join('\n');
}

async function queueWrite(
  operations: LocalSetupOperation[],
  targetPath: string,
  description: string,
  nextContent: string,
  dryRun: boolean,
  existingContent?: string | null,
): Promise<void> {
  const current = existingContent === undefined ? await readOptionalFile(targetPath) : existingContent;
  const action: FileAction =
    current == null ? 'create' : current === nextContent ? 'unchanged' : 'update';

  operations.push({
    path: targetPath,
    action,
    description,
  });

  if (dryRun || action === 'unchanged') {
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, nextContent, 'utf8');
}

async function queueCreateIfMissing(
  operations: LocalSetupOperation[],
  targetPath: string,
  description: string,
  nextContent: string,
  dryRun: boolean,
): Promise<void> {
  const current = await readOptionalFile(targetPath);
  const action: FileAction = current == null ? 'create' : 'unchanged';

  operations.push({
    path: targetPath,
    action,
    description,
  });

  if (dryRun || current != null) {
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, nextContent, 'utf8');
}

async function readOptionalFile(targetPath: string): Promise<string | null> {
  try {
    return await fs.readFile(targetPath, 'utf8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function resolveClaudePromptPath(homeDir: string): Promise<string> {
  return resolveFirstExistingPath(
    [
      path.join(homeDir, 'Claude.md'),
      path.join(homeDir, '.claude', 'CLAUDE.md'),
    ],
    path.join(homeDir, '.claude', 'CLAUDE.md'),
  );
}

async function resolveCodexPromptPath(homeDir: string): Promise<string> {
  return resolveFirstExistingPath(
    [
      path.join(homeDir, '.codex', 'AGENTS.md'),
      path.join(homeDir, '.codex', 'AGENT.md'),
    ],
    path.join(homeDir, '.codex', 'AGENTS.md'),
  );
}

async function resolveFirstExistingPath(candidates: string[], fallback: string): Promise<string> {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return fallback;
}

function parseObjectJson(raw: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
