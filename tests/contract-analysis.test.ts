import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeContracts, filterContractReport } from '../src/analysis/contractAnalysis.ts';
import { handleContractAnalysis } from '../src/mcp/tools/contractAnalysis.ts';

function makeTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-contract-analysis-'));
}

test('analyzeContracts extracts route handlers, consumers, response keys, and tool handlers', () => {
  const repoRoot = makeTempRepo();
  try {
    fs.mkdirSync(path.join(repoRoot, 'app/api/users'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src/client'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src/mcp/registry'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src/mcp/tools'), { recursive: true });

    fs.writeFileSync(
      path.join(repoRoot, 'app/api/users/route.ts'),
      [
        'export async function GET() {',
        '  return Response.json({ data: [], pagination: {}, error: null });',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src/client/users.ts'),
      [
        "const response = await fetch('/api/users');",
        'const data = await response.json();',
        'return data.missing;',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src/mcp/registry/dispatcher.ts'),
      "case 'codebase-retrieval': return handleCodebaseRetrieval(args);",
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src/mcp/tools/codebaseRetrieval.ts'),
      'export async function handleCodebaseRetrieval() {}',
    );

    const report = analyzeContracts(repoRoot, {
      tools: [{ name: 'codebase-retrieval', description: 'Search the codebase' }],
    });
    assert.equal(report.routes[0]?.route, '/api/users');
    assert.deepEqual(report.routes[0]?.responseKeys, ['data', 'error', 'pagination']);
    assert.equal(report.routes[0]?.consumers[0]?.filePath, 'src/client/users.ts');
    assert.equal(report.tools[0]?.handlerName, 'handleCodebaseRetrieval');
    assert.equal(report.tools[0]?.handlerFile, 'src/mcp/tools/codebaseRetrieval.ts');

    const impact = filterContractReport(report, { action: 'api_impact', route: '/api/users' }) as {
      routes: Array<{ mismatchKeys: string[]; risk: string }>;
    };
    assert.deepEqual(impact.routes[0]?.mismatchKeys, ['missing']);
    assert.equal(impact.routes[0]?.risk, 'medium');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('contract_analysis MCP tool returns tool map json', async () => {
  const repoRoot = makeTempRepo();
  try {
    fs.mkdirSync(path.join(repoRoot, 'src/mcp/registry'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src/mcp/tools'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'src/mcp/registry/dispatcher.ts'),
      "case 'contract_analysis': return handleContractAnalysis(args);",
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src/mcp/tools/contractAnalysis.ts'),
      'export async function handleContractAnalysis() {}',
    );

    const response = await handleContractAnalysis(
      { action: 'tool_map', tool: 'contract_analysis', format: 'json' },
      repoRoot,
    );
    const payload = JSON.parse(response.content[0]?.text ?? '{}');
    assert.equal(payload.action, 'tool_map');
    assert.equal(payload.tools[0].name, 'contract_analysis');
    assert.equal(payload.tools[0].handlerName, 'handleContractAnalysis');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});
