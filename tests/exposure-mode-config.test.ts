import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { shouldRunDefaultStart } from '../src/workflow/start.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Unit tests for shouldRunDefaultStart ──

test('shouldRunDefaultStart returns true when no args and not MCP mode', () => {
  assert.equal(shouldRunDefaultStart([], false), true);
});

test('shouldRunDefaultStart returns false when no args but MCP mode', () => {
  assert.equal(shouldRunDefaultStart([], true), false);
});

test('shouldRunDefaultStart returns false when args present and not MCP mode', () => {
  assert.equal(shouldRunDefaultStart(['search'], false), false);
});

test('shouldRunDefaultStart returns false when args present and MCP mode', () => {
  assert.equal(shouldRunDefaultStart(['search'], true), false);
});

// ── Source-level gate verification ──

test('implicit MCP stdio is gated by exposure mode in source', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'config.ts'), 'utf8');

  assert.match(source, /CONTEXTATLAS_EXPOSURE_MODE/);
  assert.match(source, /exposureMode === 'mcp'/);
});

// ── Integration tests: child-process mode isolation ──

function createTempEnv(): { baseDir: string; projectDir: string; homeDir: string } {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-exposure-mode-'));
  const projectDir = path.join(baseDir, 'project');
  const homeDir = path.join(baseDir, 'home');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(homeDir, '.contextatlas'), { recursive: true });
  return { baseDir, projectDir, homeDir };
}

function runCli(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  timeoutMs = 5000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [path.join(REPO_ROOT, 'dist', 'index.js'), ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ stdout, stderr, exitCode: null });
    }, timeoutMs);

    proc.once('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });

    proc.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('cli-skill mode: no args + non-TTY exits with start guide, not MCP stdio', async () => {
  const { baseDir, projectDir, homeDir } = createTempEnv();

  try {
    const result = await runCli([], {
      HOME: homeDir,
      CONTEXTATLAS_BASE_DIR: path.join(homeDir, '.contextatlas'),
      CONTEXTATLAS_EXPOSURE_MODE: 'cli-skill',
    }, projectDir);

    // Should output the start guide with exposure mode hint and exit cleanly
    assert.match(result.stdout, /Exposure Mode: cli-skill/);
    assert.equal(result.exitCode, 0);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('mcp mode: explicit "mcp" subcommand starts MCP server', async () => {
  const { baseDir, projectDir, homeDir } = createTempEnv();

  try {
    const proc = spawn('node', [path.join(REPO_ROOT, 'dist', 'index.js'), 'mcp'], {
      cwd: projectDir,
      env: {
        ...process.env,
        HOME: homeDir,
        CONTEXTATLAS_BASE_DIR: path.join(homeDir, '.contextatlas'),
        CONTEXTATLAS_EXPOSURE_MODE: 'mcp',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Send initialize request to trigger JSON-RPC response
    proc.stdin.write(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'exposure-mode-test', version: '1.0' },
      },
    }) + '\n');

    let buffer = '';
    let settled = false;

    const response = await new Promise<{ stdout: string; exited: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        settled = true;
        proc.kill('SIGTERM');
        resolve({ stdout: buffer, exited: false });
      }, 8000);

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.includes('"jsonrpc"')) {
          clearTimeout(timer);
          settled = true;
          proc.kill('SIGTERM');
          resolve({ stdout: buffer, exited: false });
        }
      });

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', () => {});

      proc.once('close', () => {
        if (!settled) {
          clearTimeout(timer);
          resolve({ stdout: buffer, exited: true });
        }
      });
    });

    assert.match(response.stdout, /jsonrpc/);

    proc.stdin.end();
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('setup:local without --mode exits with error', async () => {
  const { baseDir, projectDir, homeDir } = createTempEnv();

  try {
    const result = await runCli(['setup:local'], {
      HOME: homeDir,
      CONTEXTATLAS_BASE_DIR: path.join(homeDir, '.contextatlas'),
    }, projectDir);

    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.stderr + result.stdout,
      /缺少或不支持的 --mode/,
    );
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('setup:local --mode cli-skill succeeds and outputs mode info', async () => {
  const { baseDir, projectDir, homeDir } = createTempEnv();

  try {
    const result = await runCli(['setup:local', '--mode', 'cli-skill', '--dry-run'], {
      HOME: homeDir,
      CONTEXTATLAS_BASE_DIR: path.join(homeDir, '.contextatlas'),
    }, projectDir);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Exposure Mode: cli-skill/);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('setup:local --mode mcp succeeds and outputs mode info', async () => {
  const { baseDir, projectDir, homeDir } = createTempEnv();

  try {
    const result = await runCli(['setup:local', '--mode', 'mcp', '--dry-run'], {
      HOME: homeDir,
      CONTEXTATLAS_BASE_DIR: path.join(homeDir, '.contextatlas'),
    }, projectDir);

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /Exposure Mode: mcp/);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
