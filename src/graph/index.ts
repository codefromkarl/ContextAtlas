export { ChangeDetector } from './ChangeDetector.js';
export { ExecutionTracer } from './ExecutionTracer.js';
export { GraphStore } from './GraphStore.js';
export { SymbolExtractor } from './SymbolExtractor.js';

export type {
  ChangedSymbolMatch,
  ChangeDetectionResult,
  ChangeDetectionScope,
} from './ChangeDetector.js';
export type { ExecutionTracePath, ExecutionTraceResult } from './ExecutionTracer.js';
export type {
  GraphImpactEntry,
  GraphRelationEntry,
  StoredRelation,
  StoredSymbol,
} from './GraphStore.js';
export type {
  ExtractedRelation,
  ExtractedSymbol,
  GraphDirection,
  GraphEdgeType,
  GraphSymbolType,
  GraphWritePayload,
} from './types.js';
