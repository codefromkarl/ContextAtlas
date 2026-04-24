import type Parser from '@keqingmoe/tree-sitter';
import type { GraphWritePayload } from '../types.js';

export interface SymbolExtractionInput {
  tree: Parser.Tree;
  code: string;
  filePath: string;
  language: string;
}

export interface SymbolExtractionProvider {
  readonly languages: readonly string[];
  extract(input: SymbolExtractionInput): GraphWritePayload;
}
