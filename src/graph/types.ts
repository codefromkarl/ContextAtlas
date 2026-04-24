export type GraphSymbolType =
  | 'Function'
  | 'Class'
  | 'Method'
  | 'Interface'
  | 'Variable'
  | 'Enum'
  | 'Struct'
  | 'Trait';

export type GraphEdgeType =
  | 'CALLS'
  | 'IMPORTS'
  | 'EXTENDS'
  | 'IMPLEMENTS'
  | 'METHOD_OVERRIDES'
  | 'METHOD_IMPLEMENTS'
  | 'HAS_METHOD'
  | 'HAS_PROPERTY'
  | 'ACCESSES';

export type GraphDirection = 'upstream' | 'downstream' | 'both';

export interface ExtractedSymbol {
  id: string;
  name: string;
  type: GraphSymbolType;
  filePath: string;
  language: string;
  startLine: number;
  endLine: number;
  modifiers: string[];
  parentId: string | null;
  exported: boolean;
}

export interface ExtractedRelation {
  fromId: string;
  toId: string;
  type: GraphEdgeType;
  confidence: number;
  reason?: string;
}

export interface ExtractedInvocation {
  id: string;
  filePath: string;
  enclosingSymbolId: string | null;
  calleeName: string;
  resolvedTargetId: string | null;
  startLine: number;
  endLine: number;
}

export interface GraphWritePayload {
  symbols: ExtractedSymbol[];
  relations: ExtractedRelation[];
  invocations?: ExtractedInvocation[];
  unresolvedRefs?: string[];
}

export interface ExtractedFileSkeleton {
  path: string;
  language: string;
  summary: string;
  imports: string[];
  exports: string[];
  topSymbols: string[];
}

export interface ExtractedSymbolSkeleton {
  symbolId: string;
  filePath: string;
  name: string;
  type: GraphSymbolType;
  signature: string;
  parentName: string | null;
  exported: boolean;
  startLine: number;
  endLine: number;
}

export interface SkeletonWritePayload {
  file: ExtractedFileSkeleton;
  symbols: ExtractedSymbolSkeleton[];
}
