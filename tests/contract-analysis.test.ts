import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyzeContracts, filterContractReport, formatContractAnalysis } from '../src/analysis/contractAnalysis.ts';
import { handleContractAnalysis } from '../src/mcp/tools/contractAnalysis.ts';

function makeTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cw-contract-analysis-'));
}

test('analyzeContracts extracts route handlers, consumers, response keys, and tool handlers', () => {
  const repoRoot = makeTempRepo();
  try {
    fs.mkdirSync(path.join(repoRoot, 'app/api/users'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'pages/api'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src/client'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src/mcp/registry'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src/mcp/tools'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src/server'), { recursive: true });

    fs.writeFileSync(
      path.join(repoRoot, 'app/api/users/route.ts'),
      [
        'export async function GET() {',
        '  return Response.json({ data: [], pagination: {}, error: null });',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(repoRoot, 'pages/api/orders.ts'),
      [
        'export default function handler(req, res) {',
        '  res.status(200).json({ items: [], total: 0 });',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src/server/routes.ts'),
      [
        "app.get('/api/widgets', listWidgets);",
        'function listWidgets(req, res) {',
        '  res.json({ widgets: [], cursor: null });',
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
      path.join(repoRoot, 'src/client/orders.ts'),
      [
        "const response = await fetch('/api/orders');",
        'const payload = await response.json();',
        'return payload.total + payload.deleted;',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(repoRoot, 'src/client/widgets.ts'),
      [
        "const response = await fetch('/api/widgets');",
        'const result = await response.json();',
        'return result.widgets.length + result.extra;',
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
      tools: [
        { name: 'codebase-retrieval', description: 'Search the codebase' },
        { name: 'unmapped-tool', description: 'Missing handler' },
      ],
    });
    const usersRoute = report.routes.find((route) => route.route === '/api/users');
    const ordersRoute = report.routes.find((route) => route.route === '/api/orders');
    const widgetsRoute = report.routes.find((route) => route.route === '/api/widgets');
    assert.deepEqual(usersRoute?.responseKeys, ['data', 'error', 'pagination']);
    assert.deepEqual(ordersRoute?.responseKeys, ['items', 'total']);
    assert.deepEqual(widgetsRoute?.responseKeys, ['cursor', 'widgets']);
    assert.equal(usersRoute?.consumers[0]?.filePath, 'src/client/users.ts');
    assert.equal(report.tools[0]?.handlerName, 'handleCodebaseRetrieval');
    assert.equal(report.tools[0]?.handlerFile, 'src/mcp/tools/codebaseRetrieval.ts');

    const impact = filterContractReport(report, { action: 'api_impact', route: '/api/users' }) as {
      routes: Array<{
        mismatchKeys: string[];
        risk: string;
        issues: string[];
        consumers: Array<{ filePath: string; accessedKeys: string[]; mismatchKeys: string[] }>;
      }>;
    };
    assert.deepEqual(impact.routes[0]?.mismatchKeys, ['missing']);
    assert.equal(impact.routes[0]?.risk, 'medium');
    assert.deepEqual(impact.routes[0]?.issues, ['response-shape-mismatch:missing']);
    assert.deepEqual(impact.routes[0]?.consumers[0]?.accessedKeys, ['missing']);
    assert.deepEqual(impact.routes[0]?.consumers[0]?.mismatchKeys, ['missing']);
    assert.match(formatContractAnalysis(impact), /consumer src\/client\/users\.ts accessed=missing mismatch=missing/);
    assert.match(formatContractAnalysis(impact), /issues: response-shape-mismatch:missing/);

    const allImpact = filterContractReport(report, { action: 'api_impact' }) as {
      routes: Array<{ route: string; mismatchKeys: string[]; risk: string }>;
    };
    assert.deepEqual(
      allImpact.routes.map((route) => [route.route, route.mismatchKeys, route.risk]),
      [
        ['/api/orders', ['deleted'], 'medium'],
        ['/api/users', ['missing'], 'medium'],
        ['/api/widgets', ['extra'], 'medium'],
      ],
    );
    assert.equal(report.health.status, 'degraded');
    assert.equal(report.health.mismatchCount, 3);

    const toolImpact = filterContractReport(report, { action: 'tool_impact' }) as {
      tools: Array<{ name: string; handlerFile: string | null; risk: string; issues: string[] }>;
    };
    assert.deepEqual(
      toolImpact.tools.map((tool) => [tool.name, tool.risk, tool.issues]),
      [
        ['codebase-retrieval', 'low', []],
        ['unmapped-tool', 'medium', ['handler-not-mapped']],
      ],
    );
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

test('contract analysis degrades to health issues instead of throwing when source scan fails', () => {
  const missingRepoRoot = path.join(os.tmpdir(), `cw-contract-analysis-missing-${Date.now()}`);
  const report = analyzeContracts(missingRepoRoot, {
    tools: [{ name: 'contract_analysis', description: 'contract check' }],
  });

  assert.equal(report.health.status, 'missing');
  assert.equal(report.routes.length, 0);
  assert.equal(report.tools.length, 1);
  assert.equal(report.tools[0]?.handlerFile, null);
  assert.ok(report.health.issues.some((issue) => issue.startsWith('analysis-error:')));
});
