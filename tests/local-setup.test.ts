import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyLocalSetup,
  buildCodexCliSkillContent,
  buildCodexSkillContent,
  buildPromptManagedBlock,
  formatLocalSetupReport,
  isLocalSetupMode,
  resolveClaudeDesktopConfigPath,
  upsertContextAtlasCodexConfig,
  upsertContextAtlasMcpJson,
  upsertManagedMarkdownBlock,
} from '../src/setup/local.ts';

test('upsertManagedMarkdownBlock appends and updates the managed ContextAtlas block idempotently', () => {
  const original = '# Existing\n';
  const first = upsertManagedMarkdownBlock(original, buildPromptManagedBlock());
  const second = upsertManagedMarkdownBlock(first, buildPromptManagedBlock());

  assert.match(first, /BEGIN CONTEXTATLAS MANAGED BLOCK/);
  assert.equal(first, second);
  assert.match(second, /find_memory/);
});

test('upsertContextAtlasMcpJson preserves existing servers and injects contextatlas config', () => {
  const updated = upsertContextAtlasMcpJson(
    JSON.stringify(
      {
        mcpServers: {
          context7: {
            type: 'http',
            url: 'https://mcp.context7.com/mcp',
          },
        },
      },
      null,
      2,
    ),
    {
      nodeCommand: '/usr/bin/node',
      entryScript: '/repo/dist/index.js',
      toolset: 'full',
    },
  );

  const parsed = JSON.parse(updated) as {
    mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>;
  };

  assert.ok(parsed.mcpServers.context7);
  assert.equal(parsed.mcpServers.contextatlas?.command, '/usr/bin/node');
  assert.deepEqual(parsed.mcpServers.contextatlas?.args, ['/repo/dist/index.js', 'mcp']);
  assert.equal(parsed.mcpServers.contextatlas?.env?.CONTEXTATLAS_MCP_TOOLSET, 'full');
});

test('upsertContextAtlasCodexConfig replaces an existing contextatlas mcp section', () => {
  const updated = upsertContextAtlasCodexConfig(
    [
      'model = "gpt-5.4"',
      '',
      '[mcp_servers.contextatlas]',
      'command = "/old/node"',
      'args = ["/old/dist/index.js", "mcp"]',
      'startup_timeout_sec = 15.0',
      '',
      '[notice]',
      'hide_rate_limit_model_nudge = true',
      '',
    ].join('\n'),
    {
      nodeCommand: '/usr/bin/node',
      entryScript: '/repo/dist/index.js',
    },
  );

  assert.match(updated, /\[mcp_servers\.contextatlas\]/);
  assert.match(updated, /command = "\/usr\/bin\/node"/);
  assert.match(updated, /args = \["\/repo\/dist\/index\.js", "mcp"\]/);
  assert.doesNotMatch(updated, /\/old\/dist\/index\.js/);
  assert.match(updated, /\[notice\]/);
});

test('buildCodexSkillContent documents the ContextAtlas workflow for Codex skills', () => {
  const text = buildCodexSkillContent();

  assert.match(text, /name: contextatlas-mcp/);
  assert.match(text, /codebase-retrieval/);
  assert.match(text, /record_memory/);
});

test('buildCodexCliSkillContent documents the CLI-first ContextAtlas workflow for Codex skills', () => {
  const text = buildCodexCliSkillContent();

  assert.match(text, /name: contextatlas-cli/);
  assert.match(text, /contextatlas search --repo-path <repo>/);
  assert.doesNotMatch(text, /mcp__contextatlas__/);
});

test('isLocalSetupMode accepts only supported exposure modes', () => {
  assert.equal(isLocalSetupMode('cli-skill'), true);
  assert.equal(isLocalSetupMode('mcp'), true);
  assert.equal(isLocalSetupMode('hybrid'), false);
});

test('formatLocalSetupReport shows detected platform and resolved target paths', () => {
  const text = formatLocalSetupReport({
    changed: true,
    dryRun: true,
    mode: 'mcp',
    platform: 'darwin',
    operations: [
      {
        action: 'create',
        description: 'Claude Desktop MCP config',
        path: '/Users/alice/Library/Application Support/Claude/claude_desktop_config.json',
      },
      {
        action: 'update',
        description: 'Codex prompt doc',
        path: '/Users/alice/.codex/AGENTS.md',
      },
    ],
  });

  assert.match(text, /Detected Platform: darwin/);
  assert.match(text, /Resolved Paths:/);
  assert.match(text, /Claude Desktop MCP config/);
  assert.match(text, /\/Users\/alice\/Library\/Application Support\/Claude\/claude_desktop_config\.json/);
  assert.match(text, /Codex prompt doc/);
});

test('resolveClaudeDesktopConfigPath selects the correct path for linux, macOS, and Windows', () => {
  assert.equal(
    resolveClaudeDesktopConfigPath({
      homeDir: '/home/alice',
      platform: 'linux',
      env: {},
    }),
    '/home/alice/.config/Claude/claude_desktop_config.json',
  );

  assert.equal(
    resolveClaudeDesktopConfigPath({
      homeDir: '/Users/alice',
      platform: 'darwin',
      env: {},
    }),
    '/Users/alice/Library/Application Support/Claude/claude_desktop_config.json',
  );

  assert.equal(
    resolveClaudeDesktopConfigPath({
      homeDir: 'C:\\Users\\alice',
      platform: 'win32',
      env: {
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
      },
    }),
    path.join('C:\\Users\\alice\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'),
  );
});

test('applyLocalSetup in mcp mode writes env, mcp configs, and prompt docs without CLI skill', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextatlas-local-setup-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextatlas-local-repo-'));
  fs.mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'dist', 'index.js'), 'console.log("ok");\n');

  try {
    const report = await applyLocalSetup({
      homeDir,
      repoRoot,
      nodeCommand: '/usr/bin/node',
      mode: 'mcp',
      toolset: 'retrieval-only',
      dryRun: false,
      platform: 'linux',
      env: {},
    });

    assert.equal(report.changed, true);

    const claudeDesktop = JSON.parse(
      fs.readFileSync(path.join(homeDir, '.config', 'Claude', 'claude_desktop_config.json'), 'utf8'),
    ) as { mcpServers: Record<string, { args?: string[]; env?: Record<string, string> }> };
    assert.deepEqual(claudeDesktop.mcpServers.contextatlas?.args, [
      path.join(repoRoot, 'dist', 'index.js'),
      'mcp',
    ]);
    assert.equal(
      claudeDesktop.mcpServers.contextatlas?.env?.CONTEXTATLAS_MCP_TOOLSET,
      'retrieval-only',
    );
    assert.equal(
      claudeDesktop.mcpServers.contextatlas?.env?.CONTEXTATLAS_EXPOSURE_MODE,
      'mcp',
    );

    const codexConfig = fs.readFileSync(path.join(homeDir, '.codex', 'config.toml'), 'utf8');
    assert.match(codexConfig, /\[mcp_servers\.contextatlas\]/);

    const codexPrompt = fs.readFileSync(path.join(homeDir, '.codex', 'AGENTS.md'), 'utf8');
    assert.match(codexPrompt, /BEGIN CONTEXTATLAS MANAGED BLOCK/);

    const geminiPrompt = fs.readFileSync(path.join(homeDir, '.gemini', 'GEMINI.md'), 'utf8');
    assert.match(geminiPrompt, /ContextAtlas/);

    const claudePrompt = fs.readFileSync(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf8');
    assert.match(claudePrompt, /codebase-retrieval/);

    assert.equal(
      fs.existsSync(path.join(homeDir, '.codex', 'skills', 'contextatlas-cli', 'SKILL.md')),
      false,
    );

    const envFile = fs.readFileSync(path.join(homeDir, '.contextatlas', '.env'), 'utf8');
    assert.match(envFile, /EMBEDDINGS_BASE_URL=https:\/\/api\.siliconflow\.cn\/v1\/embeddings/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('applyLocalSetup in cli-skill mode writes env, prompts, and CLI skill without MCP configs', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextatlas-local-setup-cli-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextatlas-local-repo-cli-'));
  fs.mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'dist', 'index.js'), 'console.log("ok");\n');

  try {
    const report = await applyLocalSetup({
      homeDir,
      repoRoot,
      nodeCommand: '/usr/bin/node',
      mode: 'cli-skill',
      toolset: 'full',
      dryRun: false,
      platform: 'linux',
      env: {},
    });

    assert.equal(report.changed, true);

    const skill = fs.readFileSync(
      path.join(homeDir, '.codex', 'skills', 'contextatlas-cli', 'SKILL.md'),
      'utf8',
    );
    assert.match(skill, /contextatlas search --repo-path <repo>/);

    const codexPrompt = fs.readFileSync(path.join(homeDir, '.codex', 'AGENTS.md'), 'utf8');
    assert.match(codexPrompt, /ContextAtlas CLI/);

    assert.equal(fs.existsSync(path.join(homeDir, '.codex', 'config.toml')), false);
    assert.equal(fs.existsSync(path.join(homeDir, '.claude', 'mcp.json')), false);
    assert.equal(
      fs.existsSync(path.join(homeDir, '.config', 'Claude', 'claude_desktop_config.json')),
      false,
    );
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('applyLocalSetup keeps an existing env file untouched', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextatlas-local-setup-existing-env-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextatlas-local-repo-existing-env-'));
  fs.mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'dist', 'index.js'), 'console.log("ok");\n');
  fs.mkdirSync(path.join(homeDir, '.contextatlas'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.contextatlas', '.env'), 'EMBEDDINGS_API_KEY=existing\n');

  try {
    await applyLocalSetup({
      homeDir,
      repoRoot,
      nodeCommand: '/usr/bin/node',
      mode: 'mcp',
      toolset: 'full',
      dryRun: false,
      platform: 'linux',
      env: {},
    });

    const envFile = fs.readFileSync(path.join(homeDir, '.contextatlas', '.env'), 'utf8');
    assert.equal(envFile, 'EMBEDDINGS_API_KEY=existing\n');
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('applyLocalSetup writes Claude Desktop config to platform-specific macOS and Windows paths', async () => {
  const macHome = fs.mkdtempSync(path.join(os.tmpdir(), 'contextatlas-local-setup-mac-'));
  const winHome = fs.mkdtempSync(path.join(os.tmpdir(), 'contextatlas-local-setup-win-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextatlas-local-repo-platform-'));
  fs.mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'dist', 'index.js'), 'console.log("ok");\n');

  try {
    await applyLocalSetup({
      homeDir: macHome,
      repoRoot,
      nodeCommand: '/usr/bin/node',
      mode: 'mcp',
      toolset: 'full',
      dryRun: false,
      platform: 'darwin',
      env: {},
    });
    assert.ok(
      fs.existsSync(
        path.join(macHome, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      ),
    );

    await applyLocalSetup({
      homeDir: winHome,
      repoRoot,
      nodeCommand: 'C:\\node.exe',
      mode: 'mcp',
      toolset: 'full',
      dryRun: false,
      platform: 'win32',
      env: {
        APPDATA: path.join(winHome, 'AppData', 'Roaming'),
      },
    });
    assert.ok(
      fs.existsSync(
        path.join(winHome, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
      ),
    );
  } finally {
    fs.rmSync(macHome, { recursive: true, force: true });
    fs.rmSync(winHome, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
