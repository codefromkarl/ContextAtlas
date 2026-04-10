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

export interface GraphWritePayload {
  symbols: ExtractedSymbol[];
  relations: ExtractedRelation[];
  unresolvedRefs?: string[];
}
