import type {
  ExtractedFileSkeleton,
  ExtractedSymbol,
  ExtractedSymbolSkeleton,
  GraphWritePayload,
  SkeletonWritePayload,
} from './types.js';

function splitIdentifierParts(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function extractImportsFromContent(content: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /import[\s\S]*?from\s+['"]([^'"]+)['"]/g,
    /export[\s\S]*?from\s+['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const source = match[1]?.trim();
      if (source) imports.add(source);
    }
  }
  return Array.from(imports).sort();
}

function inferRoleHints(input: { filePath: string; content: string; symbolNames: string[] }): string[] {
  const hints = new Set<string>();
  const lowerPath = input.filePath.toLowerCase();
  const lowerContent = input.content.toLowerCase();

  if (/\/index\.(ts|tsx|js|jsx|mts|mjs|cts|cjs)$/.test(lowerPath) || lowerPath === 'src/index.ts') {
    hints.add('entrypoint');
  }
  if (lowerPath.includes('/cli/')) hints.add('cli');
  if (lowerPath.includes('/mcp/')) hints.add('mcp');
  if (lowerPath.includes('registercommands')) hints.add('command registration');
  if (lowerPath.includes('/commands/')) hints.add('command handler');
  if (lowerContent.includes('registerclicommands')) hints.add('command registration');
  if (lowerContent.includes('cli.parse')) hints.add('cli startup');
  if (lowerContent.includes('ismcpmode') || lowerContent.includes("process.argv.push('mcp')")) hints.add('mcp mode');
  if (lowerContent.includes('handlecodebaseretrieval')) hints.add('tool handler');
  if (lowerContent.includes('executeretrieval')) hints.add('adapter layer');

  for (const symbolName of input.symbolNames) {
    if (/service$/i.test(symbolName)) hints.add('core service');
    if (/store$/i.test(symbolName)) hints.add('core service');
  }

  return Array.from(hints).sort();
}

function buildSummary(input: {
  filePath: string;
  imports: string[];
  exports: string[];
  topSymbols: string[];
  callNames?: string[];
  pathTokens?: string[];
  roleHints?: string[];
}): string {
  const lines = [`file ${input.filePath}`];
  if (input.pathTokens && input.pathTokens.length > 0) {
    lines.push(`path tokens ${input.pathTokens.join(', ')}`);
  }
  if (input.roleHints && input.roleHints.length > 0) {
    lines.push(`role hints ${input.roleHints.join(', ')}`);
  }
  if (input.exports.length > 0) {
    lines.push(`exports ${input.exports.join(', ')}`);
  }
  if (input.imports.length > 0) {
    lines.push(`imports ${input.imports.join(', ')}`);
  }
  if (input.callNames && input.callNames.length > 0) {
    lines.push(`call names ${input.callNames.join(', ')}`);
  }
  if (input.topSymbols.length > 0) {
    lines.push(`top symbols ${input.topSymbols.join(', ')}`);
  }
  return lines.join('\n');
}

function buildSymbolSignature(symbol: ExtractedSymbol, parentName: string | null): string {
  const prefix = symbol.type === 'Method' && parentName ? `${parentName}.` : '';
  return `${symbol.type} ${prefix}${symbol.name}`;
}

export function buildSkeletonPayload(input: {
  filePath: string;
  language: string;
  graph: GraphWritePayload;
  content?: string;
}): SkeletonWritePayload {
  const symbolsById = new Map(input.graph.symbols.map((symbol) => [symbol.id, symbol]));
  const symbolNames = input.graph.symbols.map((symbol) => symbol.name);
  const graphImports = Array.from(
    new Set(
      input.graph.relations
        .filter((relation) => relation.type === 'IMPORTS')
        .map((relation) => relation.reason?.trim())
        .filter((reason): reason is string => Boolean(reason)),
    ),
  );
  const contentImports = input.content ? extractImportsFromContent(input.content) : [];
  const imports = Array.from(new Set([...graphImports, ...contentImports])).sort();
  const exportedSymbols = input.graph.symbols
    .filter((symbol) => symbol.exported)
    .map((symbol) => symbol.name)
    .sort();
  const topSymbols = input.graph.symbols
    .filter((symbol) => symbol.parentId === null)
    .map((symbol) => `${symbol.type} ${symbol.name}`)
    .sort();
  const callNames = Array.from(
    new Set((input.graph.invocations ?? []).map((invocation) => invocation.calleeName)),
  ).sort();
  const pathTokens = Array.from(new Set(splitIdentifierParts(input.filePath)));
  const roleHints = inferRoleHints({
    filePath: input.filePath,
    content: input.content ?? '',
    symbolNames,
  });

  const file: ExtractedFileSkeleton = {
    path: input.filePath,
    language: input.language,
    summary: buildSummary({
      filePath: input.filePath,
      imports,
      exports: exportedSymbols,
      callNames,
      topSymbols,
      pathTokens,
      roleHints,
    }),
    imports,
    exports: exportedSymbols,
    topSymbols,
  };

  const symbols: ExtractedSymbolSkeleton[] = input.graph.symbols.map((symbol) => {
    const parentName = symbol.parentId ? symbolsById.get(symbol.parentId)?.name ?? null : null;
    return {
      symbolId: symbol.id,
      filePath: input.filePath,
      name: symbol.name,
      type: symbol.type,
      signature: buildSymbolSignature(symbol, parentName),
      parentName,
      exported: symbol.exported,
      startLine: symbol.startLine,
      endLine: symbol.endLine,
    };
  });

  return { file, symbols };
}

export function buildFallbackFileSkeleton(input: {
  filePath: string;
  language: string;
  content: string;
}): SkeletonWritePayload {
  const imports = extractImportsFromContent(input.content);
  const pathTokens = Array.from(new Set(splitIdentifierParts(input.filePath)));
  const roleHints = inferRoleHints({
    filePath: input.filePath,
    content: input.content,
    symbolNames: [],
  });

  return {
    file: {
      path: input.filePath,
      language: input.language,
      summary: buildSummary({
        filePath: input.filePath,
        imports,
        exports: [],
        callNames: [],
        topSymbols: [],
        pathTokens,
        roleHints,
      }),
      imports,
      exports: [],
      topSymbols: [],
    },
    symbols: [],
  };
}
