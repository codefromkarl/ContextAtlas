import { z } from 'zod';
import { closeDb, generateProjectId, initDb } from '../../db/index.js';
import { ChangeDetector, type ChangeDetectionScope } from '../../graph/ChangeDetector.js';
import { ExecutionTracer } from '../../graph/ExecutionTracer.js';
import { GraphStore } from '../../graph/GraphStore.js';
import type { GraphDirection } from '../../graph/types.js';
import { createTextResponse } from '../response.js';
import { logger } from '../../utils/logger.js';
import { responseFormatSchema } from './responseFormat.js';
import { resolveCurrentSnapshotId } from '../../storage/layout.js';

const graphDirectionSchema = z.enum(['upstream', 'downstream', 'both']);

export const graphImpactSchema = z.object({
  symbol: z.string().describe('Exact symbol name to inspect'),
  direction: graphDirectionSchema.optional().default('downstream'),
  max_depth: z.number().int().min(1).max(5).optional().default(2),
  format: responseFormatSchema.optional().default('text'),
});

export const graphContextSchema = z.object({
  symbol: z.string().describe('Exact symbol name to inspect'),
  format: responseFormatSchema.optional().default('text'),
});

export const detectChangesSchema = z.object({
  scope: z.enum(['working_tree', 'staged']).optional().default('working_tree'),
  format: responseFormatSchema.optional().default('text'),
});

export const graphQuerySchema = z.object({
  symbol: z.string().describe('Exact entry symbol name to trace'),
  direction: z.enum(['upstream', 'downstream']).optional().default('downstream'),
  max_depth: z.number().int().min(1).max(6).optional().default(3),
  format: responseFormatSchema.optional().default('text'),
});

export type GraphImpactInput = z.infer<typeof graphImpactSchema>;
export type GraphContextInput = z.infer<typeof graphContextSchema>;
export type DetectChangesInput = z.infer<typeof detectChangesSchema>;
export type GraphQueryInput = z.infer<typeof graphQuerySchema>;

function openGraphStore(projectRoot: string): { store: GraphStore; close: () => void } {
  const projectId = generateProjectId(projectRoot);
  const snapshotId = resolveCurrentSnapshotId(projectId);
  const db = initDb(projectId, snapshotId);
  return {
    store: new GraphStore(db),
    close: () => closeDb(db),
  };
}

function resolveSingleSymbol(store: GraphStore, symbolName: string) {
  const matches = store.findSymbolsByName(symbolName);
  if (matches.length === 0) {
    return { match: null, matches };
  }
  return { match: matches[0], matches };
}

export async function handleGraphImpact(
  args: GraphImpactInput,
  projectRoot: string,
) {
  const { symbol, direction, max_depth: maxDepth, format } = args;
  logger.info({ symbol, direction, maxDepth }, 'MCP graph_impact 调用开始');

  const { store, close } = openGraphStore(projectRoot);
  try {
    const { match, matches } = resolveSingleSymbol(store, symbol);
    if (!match) {
      return createTextResponse(`No graph symbol found for "${symbol}".`);
    }

    const directRelations = store.getDirectRelations(match.id, direction as GraphDirection);
    const resolvedImpact = store.getImpact(match.id, {
      direction: direction as GraphDirection,
      maxDepth,
    });

    if (format === 'json') {
      return createTextResponse(
        JSON.stringify(
          {
            tool: 'graph_impact',
            symbol: match,
            candidate_count: matches.length,
            direction,
            max_depth: maxDepth,
            direct_relations: directRelations,
            resolved_impact: resolvedImpact,
          },
          null,
          2,
        ),
      );
    }

    const lines = [
      `Symbol: ${match.name}`,
      `File: ${match.filePath}:${match.startLine}`,
      `Direction: ${direction}`,
      `Max Depth: ${maxDepth}`,
      '',
      'Direct Relations:',
    ];

    if (directRelations.length === 0) {
      lines.push('- none');
    } else {
      for (const relation of directRelations) {
        lines.push(
          `- [${relation.direction}] ${relation.relationType} -> ${relation.targetName}${relation.resolved ? '' : ' (unresolved)'}`,
        );
      }
    }

    lines.push('', 'Resolved Impact:');
    if (resolvedImpact.length === 0) {
      lines.push('- none');
    } else {
      for (const entry of resolvedImpact) {
        lines.push(
          `- depth=${entry.depth} [${entry.direction}] ${entry.viaRelationType ?? 'UNKNOWN'} -> ${entry.symbol.name}`,
        );
      }
    }

    return createTextResponse(lines.join('\n'));
  } finally {
    close();
  }
}

export async function handleGraphContext(
  args: GraphContextInput,
  projectRoot: string,
) {
  const { symbol, format } = args;
  logger.info({ symbol }, 'MCP graph_context 调用开始');

  const { store, close } = openGraphStore(projectRoot);
  try {
    const { match, matches } = resolveSingleSymbol(store, symbol);
    if (!match) {
      return createTextResponse(`No graph symbol found for "${symbol}".`);
    }

    const upstream = store.getDirectRelations(match.id, 'upstream');
    const downstream = store.getDirectRelations(match.id, 'downstream');
    const parent = match.parentId ? store.getSymbolById(match.parentId) : null;

    if (format === 'json') {
      return createTextResponse(
        JSON.stringify(
          {
            tool: 'graph_context',
            symbol: match,
            candidate_count: matches.length,
            parent,
            upstream,
            downstream,
          },
          null,
          2,
        ),
      );
    }

    const lines = [
      `Symbol: ${match.name}`,
      `Type: ${match.type}`,
      `File: ${match.filePath}:${match.startLine}`,
      `Parent: ${parent ? parent.name : '-'}`,
      '',
      'Upstream:',
    ];

    if (upstream.length === 0) {
      lines.push('- none');
    } else {
      for (const relation of upstream) {
        lines.push(`- ${relation.relationType} <- ${relation.targetName}${relation.resolved ? '' : ' (unresolved)'}`);
      }
    }

    lines.push('', 'Downstream:');
    if (downstream.length === 0) {
      lines.push('- none');
    } else {
      for (const relation of downstream) {
        lines.push(`- ${relation.relationType} -> ${relation.targetName}${relation.resolved ? '' : ' (unresolved)'}`);
      }
    }

    return createTextResponse(lines.join('\n'));
  } finally {
    close();
  }
}

function summarizeRisk(
  deletedFiles: string[],
  totalSymbols: number,
  totalRelations: number,
): { level: 'LOW' | 'MEDIUM' | 'HIGH'; details: string } {
  if (deletedFiles.length > 0 || totalRelations >= 8 || totalSymbols >= 4) {
    return {
      level: 'HIGH',
      details: 'deleted files or broad symbol impact detected',
    };
  }
  if (totalSymbols >= 2 || totalRelations >= 3) {
    return {
      level: 'MEDIUM',
      details: 'multiple symbols or relations affected',
    };
  }
  return {
    level: 'LOW',
    details: 'impact is currently narrow',
  };
}

export async function handleDetectChanges(
  args: DetectChangesInput,
  projectRoot: string,
) {
  const { scope, format } = args;
  logger.info({ scope }, 'MCP detect_changes 调用开始');

  const detector = new ChangeDetector(projectRoot);
  const detection = detector.detect(scope as ChangeDetectionScope);
  const { store, close } = openGraphStore(projectRoot);

  try {
    const matches = detection.matches.map((match) => ({
      filePath: match.filePath,
      changedLines: match.changedLines,
      symbols: match.symbols.map((symbol) => ({
        symbol,
        upstream: store.getDirectRelations(symbol.id, 'upstream'),
        downstream: store.getDirectRelations(symbol.id, 'downstream'),
      })),
    }));

    const totalSymbols = matches.reduce((sum, match) => sum + match.symbols.length, 0);
    const totalRelations = matches.reduce(
      (sum, match) =>
        sum
        + match.symbols.reduce(
          (symbolSum, symbolMatch) =>
            symbolSum + symbolMatch.upstream.length + symbolMatch.downstream.length,
          0,
        ),
      0,
    );
    const riskSummary = summarizeRisk(detection.deletedFiles, totalSymbols, totalRelations);

    if (format === 'json') {
      return createTextResponse(
        JSON.stringify(
          {
            tool: 'detect_changes',
            scope,
            changed_files: detection.changedFiles,
            deleted_files: detection.deletedFiles,
            matches,
            risk_summary: riskSummary,
          },
          null,
          2,
        ),
      );
    }

    const lines = [
      `Scope: ${scope}`,
      `Changed Files: ${detection.changedFiles.length}`,
      `Deleted Files: ${detection.deletedFiles.length}`,
      `Risk: ${riskSummary.level} (${riskSummary.details})`,
      '',
    ];

    for (const match of matches) {
      lines.push(`File: ${match.filePath}`);
      lines.push(`Changed Lines: ${match.changedLines.join(', ') || '-'}`);
      if (match.symbols.length === 0) {
        lines.push('- Symbols: none');
        lines.push('');
        continue;
      }
      for (const symbolMatch of match.symbols) {
        lines.push(`- Symbol: ${symbolMatch.symbol.name}`);
        lines.push(`  Upstream: ${symbolMatch.upstream.length}`);
        lines.push(`  Downstream: ${symbolMatch.downstream.length}`);
      }
      lines.push('');
    }

    return createTextResponse(lines.join('\n').trimEnd());
  } finally {
    close();
  }
}

export async function handleGraphQuery(
  args: GraphQueryInput,
  projectRoot: string,
) {
  const { symbol, direction, max_depth: maxDepth, format } = args;
  logger.info({ symbol, direction, maxDepth }, 'MCP graph_query 调用开始');

  const { store, close } = openGraphStore(projectRoot);
  try {
    const tracer = new ExecutionTracer(store);
    const traced = tracer.traceFromSymbol(symbol, {
      direction,
      maxDepth,
    });

    if (!traced) {
      return createTextResponse(`No graph symbol found for "${symbol}".`);
    }

    if (format === 'json') {
      return createTextResponse(
        JSON.stringify(
          {
            tool: 'graph_query',
            entry: traced.entry,
            direction: traced.direction,
            max_depth: traced.maxDepth,
            path_count: traced.paths.length,
            paths: traced.paths,
          },
          null,
          2,
        ),
      );
    }

    const lines = [
      `Entry: ${traced.entry.name}`,
      `Direction: ${traced.direction}`,
      `Max Depth: ${traced.maxDepth}`,
      `Path Count: ${traced.paths.length}`,
      '',
      'Paths:',
    ];

    if (traced.paths.length === 0) {
      lines.push('- none');
    } else {
      traced.paths.forEach((path, index) => {
        const rendered = path.symbols
          .map((item, pathIndex) =>
            pathIndex === 0 ? item.name : `${path.relationTypes[pathIndex - 1]} -> ${item.name}`,
          )
          .join(' ');
        lines.push(`${index + 1}. ${rendered}`);
      });
    }

    return createTextResponse(lines.join('\n'));
  } finally {
    close();
  }
}
