import fs from 'node:fs';
import path from 'node:path';

export type ContractAnalysisAction =
  | 'route_map'
  | 'api_impact'
  | 'tool_map'
  | 'tool_impact'
  | 'contract_health';

export interface ContractToolMetadata {
  name: string;
  description?: string;
}

export interface RouteContract {
  route: string;
  method: string;
  handlerFile: string;
  handlerName: string | null;
  responseKeys: string[];
  consumers: RouteConsumerContract[];
}

export interface RouteConsumerContract {
  filePath: string;
  accessPattern: string;
  accessedKeys: string[];
}

export interface ToolContract {
  name: string;
  handlerName: string | null;
  handlerFile: string | null;
  description: string;
}

export interface ContractHealthReport {
  status: 'ok' | 'degraded' | 'missing';
  routeCount: number;
  routeConsumerCount: number;
  toolCount: number;
  mappedToolCount: number;
  mismatchCount: number;
  issues: string[];
}

export interface ContractAnalysisReport {
  routes: RouteContract[];
  tools: ToolContract[];
  health: ContractHealthReport;
}

interface SourceFile {
  filePath: string;
  text: string;
}

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.contextatlas']);
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

export function analyzeContracts(
  repoRoot: string,
  options: { tools?: ContractToolMetadata[] } = {},
): ContractAnalysisReport {
  const files = readSourceFiles(repoRoot);
  const routes = extractRoutes(files);
  attachRouteConsumers(routes, files);
  const tools = extractToolContracts(files, options.tools ?? []);
  const health = buildContractHealth(routes, tools);

  return {
    routes,
    tools,
    health,
  };
}

export function filterContractReport(
  report: ContractAnalysisReport,
  input: { action: ContractAnalysisAction; route?: string; tool?: string },
): unknown {
  if (input.action === 'route_map') {
    return {
      action: input.action,
      routes: input.route ? report.routes.filter((route) => route.route === input.route) : report.routes,
    };
  }

  if (input.action === 'api_impact') {
    const routes = input.route ? report.routes.filter((route) => route.route === input.route) : report.routes;
    return {
      action: input.action,
      routes: routes.map((route) => ({
        ...route,
        mismatchKeys: findMismatchKeys(route),
        risk: route.consumers.length >= 10 || findMismatchKeys(route).length >= 4
          ? 'high'
          : route.consumers.length >= 4 || findMismatchKeys(route).length > 0
            ? 'medium'
            : 'low',
      })),
    };
  }

  if (input.action === 'tool_map') {
    return {
      action: input.action,
      tools: input.tool ? report.tools.filter((tool) => tool.name === input.tool) : report.tools,
    };
  }

  if (input.action === 'tool_impact') {
    const tools = input.tool ? report.tools.filter((tool) => tool.name === input.tool) : report.tools;
    return {
      action: input.action,
      tools: tools.map((tool) => ({
        ...tool,
        risk: tool.handlerFile ? 'low' : 'medium',
        issues: tool.handlerFile ? [] : ['handler-not-mapped'],
      })),
    };
  }

  return {
    action: input.action,
    health: report.health,
  };
}

export function formatContractAnalysis(payload: unknown): string {
  const value = payload as {
    action?: string;
    routes?: Array<RouteContract & { mismatchKeys?: string[]; risk?: string }>;
    tools?: Array<ToolContract & { risk?: string; issues?: string[] }>;
    health?: ContractHealthReport;
  };
  const lines = [`Contract Analysis: ${value.action ?? 'unknown'}`];

  if (value.health) {
    lines.push(`Status: ${value.health.status}`);
    lines.push(`Routes: ${value.health.routeCount}`);
    lines.push(`Route Consumers: ${value.health.routeConsumerCount}`);
    lines.push(`Tools: ${value.health.toolCount}`);
    lines.push(`Mapped Tools: ${value.health.mappedToolCount}`);
    lines.push(`Mismatches: ${value.health.mismatchCount}`);
    if (value.health.issues.length > 0) {
      lines.push('Issues:');
      value.health.issues.forEach((issue) => lines.push(`- ${issue}`));
    }
  }

  if (value.routes) {
    lines.push('Routes:');
    if (value.routes.length === 0) {
      lines.push('- none');
    }
    for (const route of value.routes) {
      lines.push(`- ${route.method.toUpperCase()} ${route.route} -> ${route.handlerFile}${route.handlerName ? `:${route.handlerName}` : ''}${route.risk ? ` risk=${route.risk}` : ''}`);
      lines.push(`  responseKeys: ${route.responseKeys.join(', ') || 'none'}`);
      lines.push(`  consumers: ${route.consumers.length}`);
      if (route.mismatchKeys && route.mismatchKeys.length > 0) {
        lines.push(`  mismatchKeys: ${route.mismatchKeys.join(', ')}`);
      }
    }
  }

  if (value.tools) {
    lines.push('Tools:');
    if (value.tools.length === 0) {
      lines.push('- none');
    }
    for (const tool of value.tools) {
      lines.push(`- ${tool.name} -> ${tool.handlerFile ?? 'unmapped'}${tool.handlerName ? `:${tool.handlerName}` : ''}${tool.risk ? ` risk=${tool.risk}` : ''}`);
      if (tool.issues && tool.issues.length > 0) {
        lines.push(`  issues: ${tool.issues.join(', ')}`);
      }
    }
  }

  return lines.join('\n');
}

function extractRoutes(files: SourceFile[]): RouteContract[] {
  const routes: RouteContract[] = [];

  for (const file of files) {
    const routeFromPath = routeFromFilePath(file.filePath);
    if (routeFromPath) {
      const methods = Array.from(file.text.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|handler)\b/g));
      if (methods.length === 0) {
        routes.push(buildRoute(routeFromPath, 'any', file, null));
      } else {
        for (const method of methods) {
          routes.push(buildRoute(routeFromPath, method[1]!.toLowerCase(), file, method[1] ?? null));
        }
      }
    }

    for (const match of file.text.matchAll(/\b(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*([A-Za-z0-9_$]+)/g)) {
      routes.push(buildRoute(match[2]!, match[1]!, file, match[3] ?? null));
    }
  }

  return dedupeRoutes(routes);
}

function buildRoute(route: string, method: string, file: SourceFile, handlerName: string | null): RouteContract {
  return {
    route,
    method,
    handlerFile: file.filePath,
    handlerName,
    responseKeys: extractResponseKeys(file.text),
    consumers: [],
  };
}

function attachRouteConsumers(routes: RouteContract[], files: SourceFile[]): void {
  for (const route of routes) {
    for (const file of files) {
      if (file.filePath === route.handlerFile) continue;
      const escaped = escapeRegExp(route.route);
      const fetchRegex = new RegExp(`\\b(?:fetch|axios\\.(?:get|post|put|patch|delete))\\s*\\(\\s*['"\`]${escaped}['"\`]`, 'g');
      if (!fetchRegex.test(file.text)) continue;

      route.consumers.push({
        filePath: file.filePath,
        accessPattern: route.route,
        accessedKeys: extractConsumerAccessKeys(file.text),
      });
    }
  }
}

function extractToolContracts(files: SourceFile[], tools: ContractToolMetadata[]): ToolContract[] {
  const dispatcher = files.find((file) => file.filePath.endsWith('src/mcp/registry/dispatcher.ts'));
  const handlerByTool = new Map<string, string>();
  if (dispatcher) {
    for (const match of dispatcher.text.matchAll(/case\s+['"`]([^'"`]+)['"`]\s*:\s*return\s+(handle[A-Za-z0-9_]+)/g)) {
      handlerByTool.set(match[1]!, match[2]!);
    }
  }

  return tools.map((tool) => {
    const handlerName = handlerByTool.get(tool.name) ?? null;
    const handlerFile = handlerName ? findHandlerFile(files, handlerName) : null;
    return {
      name: tool.name,
      handlerName,
      handlerFile,
      description: normalizeDescription(tool.description ?? ''),
    };
  });
}

function findHandlerFile(files: SourceFile[], handlerName: string): string | null {
  const needle = new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegExp(handlerName)}\\b|\\bconst\\s+${escapeRegExp(handlerName)}\\b`);
  return files.find((file) => needle.test(file.text))?.filePath ?? null;
}

function buildContractHealth(routes: RouteContract[], tools: ToolContract[]): ContractHealthReport {
  const mismatchCount = routes.reduce((count, route) => count + findMismatchKeys(route).length, 0);
  const mappedToolCount = tools.filter((tool) => tool.handlerFile).length;
  const issues: string[] = [];
  if (tools.length > 0 && mappedToolCount < tools.length) {
    issues.push(`unmapped-tools:${tools.length - mappedToolCount}`);
  }
  if (mismatchCount > 0) {
    issues.push(`response-shape-mismatches:${mismatchCount}`);
  }

  return {
    status: routes.length === 0 && tools.length === 0 ? 'missing' : issues.length > 0 ? 'degraded' : 'ok',
    routeCount: routes.length,
    routeConsumerCount: routes.reduce((count, route) => count + route.consumers.length, 0),
    toolCount: tools.length,
    mappedToolCount,
    mismatchCount,
    issues,
  };
}

function findMismatchKeys(route: RouteContract): string[] {
  if (route.responseKeys.length === 0) return [];
  const responseKeys = new Set(route.responseKeys);
  const keys = new Set<string>();
  for (const consumer of route.consumers) {
    for (const key of consumer.accessedKeys) {
      if (!responseKeys.has(key)) keys.add(key);
    }
  }
  return Array.from(keys).sort();
}

function routeFromFilePath(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  const appApi = normalized.match(/(?:^|\/)app\/api\/(.+)\/route\.[cm]?[tj]sx?$/);
  if (appApi) return `/api/${appApi[1]}`;
  const pagesApi = normalized.match(/(?:^|\/)pages\/api\/(.+)\.[cm]?[tj]sx?$/);
  if (pagesApi) return `/api/${pagesApi[1]}`.replace(/\/index$/, '');
  return null;
}

function extractResponseKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const body of extractJsonObjectBodies(text)) {
    for (const key of body.matchAll(/(?:^|[,{\s])([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g)) {
      keys.add(key[1]!);
    }
  }
  return Array.from(keys).sort();
}

function extractJsonObjectBodies(text: string): string[] {
  const bodies: string[] = [];
  const jsonCall = /\b(?:json|NextResponse\.json)\s*\(\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = jsonCall.exec(text)) !== null) {
    const openBrace = jsonCall.lastIndex - 1;
    let depth = 0;
    for (let index = openBrace; index < text.length; index += 1) {
      const char = text[index];
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      if (depth === 0) {
        bodies.push(text.slice(openBrace + 1, index));
        jsonCall.lastIndex = index + 1;
        break;
      }
    }
  }

  return bodies;
}

function extractConsumerAccessKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const match of text.matchAll(/\b(?:data|json|result)\.([A-Za-z_$][A-Za-z0-9_$]*)\b/g)) {
    keys.add(match[1]!);
  }
  return Array.from(keys).sort();
}

function readSourceFiles(repoRoot: string): SourceFile[] {
  const files: SourceFile[] = [];

  const visit = (absoluteDir: string, relativeDir: string) => {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          visit(path.join(absoluteDir, entry.name), path.posix.join(relativeDir, entry.name));
        }
        continue;
      }
      if (!entry.isFile()) continue;
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
      const filePath = path.posix.join(relativeDir, entry.name);
      files.push({
        filePath,
        text: fs.readFileSync(path.join(absoluteDir, entry.name), 'utf8'),
      });
    }
  };

  visit(repoRoot, '');
  return files;
}

function dedupeRoutes(routes: RouteContract[]): RouteContract[] {
  const byKey = new Map<string, RouteContract>();
  for (const route of routes) {
    if (!HTTP_METHODS.has(route.method) && route.method !== 'any' && route.method !== 'handler') continue;
    byKey.set(`${route.method}:${route.route}:${route.handlerFile}`, route);
  }
  return Array.from(byKey.values()).sort((a, b) => a.route.localeCompare(b.route) || a.method.localeCompare(b.method));
}

function normalizeDescription(description: string): string {
  return description.trim().replace(/\s+/g, ' ').slice(0, 180);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
