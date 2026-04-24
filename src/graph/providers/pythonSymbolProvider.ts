import type Parser from '@keqingmoe/tree-sitter';
import type { ExtractedInvocation, ExtractedRelation, ExtractedSymbol, GraphWritePayload } from '../types.js';
import type { SymbolExtractionInput, SymbolExtractionProvider } from './types.js';

interface SymbolNodeEntry {
  symbol: ExtractedSymbol;
  node: Parser.SyntaxNode;
}

const DECLARATION_TYPES = new Set(['class_definition', 'function_definition']);
const PROPERTY_TYPES = new Set(['assignment']);

export class PythonSymbolProvider implements SymbolExtractionProvider {
  readonly languages = ['python'] as const;

  extract(input: SymbolExtractionInput): GraphWritePayload {
    const { tree, filePath, language } = input;
    if (language !== 'python') {
      return { symbols: [], relations: [], unresolvedRefs: [] };
    }

    const symbols: ExtractedSymbol[] = [];
    const symbolNodes: SymbolNodeEntry[] = [];
    const relations: ExtractedRelation[] = [];
    const invocations: ExtractedInvocation[] = [];
    const unresolvedRefs = new Set<string>();
    const relationKeys = new Set<string>();
    const invocationKeys = new Set<string>();

    const pushRelation = (relation: ExtractedRelation, unresolvedRef?: string) => {
      const key = `${relation.fromId}|${relation.toId}|${relation.type}|${relation.reason ?? ''}`;
      if (relationKeys.has(key)) return;
      relationKeys.add(key);
      relations.push(relation);
      if (unresolvedRef) unresolvedRefs.add(unresolvedRef);
    };

    const pushInvocation = (invocation: ExtractedInvocation) => {
      if (invocationKeys.has(invocation.id)) return;
      invocationKeys.add(invocation.id);
      invocations.push(invocation);
    };

    const visit = (node: Parser.SyntaxNode, parentSymbol: ExtractedSymbol | null) => {
      let currentParent = parentSymbol;

      if (DECLARATION_TYPES.has(node.type)) {
        const symbol = this.createSymbol(node, filePath, language, parentSymbol);
        if (symbol) {
          symbols.push(symbol);
          symbolNodes.push({ symbol, node });
          currentParent = symbol;
          if (parentSymbol?.type === 'Class' && symbol.type === 'Method') {
            pushRelation({
              fromId: parentSymbol.id,
              toId: symbol.id,
              type: 'HAS_METHOD',
              confidence: 1,
            });
          }
        }
      } else if (PROPERTY_TYPES.has(node.type) && parentSymbol?.type === 'Class') {
        const symbol = this.createPropertySymbol(node, filePath, language, parentSymbol);
        if (symbol) {
          symbols.push(symbol);
          symbolNodes.push({ symbol, node });
          pushRelation({
            fromId: parentSymbol.id,
            toId: symbol.id,
            type: 'HAS_PROPERTY',
            confidence: 1,
          });
        }
      }

      for (const child of node.namedChildren) {
        visit(child, currentParent);
      }
    };

    visit(tree.rootNode, null);

    const symbolsByName = new Map<string, ExtractedSymbol>();
    const propertiesByOwnerAndName = new Map<string, ExtractedSymbol>();
    for (const symbol of symbols) {
      if (!symbolsByName.has(symbol.name)) {
        symbolsByName.set(symbol.name, symbol);
      }
      if (symbol.type === 'Variable' && symbol.parentId) {
        propertiesByOwnerAndName.set(`${symbol.parentId}:${symbol.name}`, symbol);
      }
    }

    const topLevelSymbols = symbols.filter((symbol) => symbol.parentId === null);
    for (const importEntry of this.extractImports(tree.rootNode)) {
      for (const binding of importEntry.bindings) {
        const targetId = this.makeExternalId(language, filePath, 'import', binding, importEntry.source);
        for (const symbol of topLevelSymbols) {
          pushRelation(
            {
              fromId: symbol.id,
              toId: targetId,
              type: 'IMPORTS',
              confidence: 0.6,
              reason: importEntry.source,
            },
            `${importEntry.source}:${binding}`,
          );
        }
      }
    }

    for (const entry of symbolNodes) {
      if (entry.symbol.type === 'Class') {
        for (const baseName of this.extractBaseClasses(entry.node)) {
          pushRelation(
            {
              fromId: entry.symbol.id,
              toId: this.makeExternalId(language, filePath, 'extends', baseName),
              type: 'EXTENDS',
              confidence: 0.7,
            },
            `extends:${baseName}`,
          );
        }
      }

      if (entry.symbol.type === 'Function' || entry.symbol.type === 'Method') {
        for (const access of this.collectPropertyAccesses(entry.node)) {
          const property = entry.symbol.parentId
            ? propertiesByOwnerAndName.get(`${entry.symbol.parentId}:${access.name}`)
            : undefined;
          if (!property) continue;
          pushRelation({
            fromId: entry.symbol.id,
            toId: property.id,
            type: 'ACCESSES',
            confidence: 0.8,
            reason: `${access.mode}:${access.name}`,
          });
        }

        for (const callSite of this.collectCalls(entry.node)) {
          const localTarget = symbolsByName.get(callSite.name);
          pushInvocation({
            id: `${entry.symbol.id}:call:${callSite.name}:${callSite.startLine}`,
            filePath,
            enclosingSymbolId: entry.symbol.id,
            calleeName: callSite.name,
            resolvedTargetId: localTarget?.id ?? null,
            startLine: callSite.startLine,
            endLine: callSite.endLine,
          });
          if (localTarget) {
            pushRelation({
              fromId: entry.symbol.id,
              toId: localTarget.id,
              type: 'CALLS',
              confidence: 1,
            });
            continue;
          }

          pushRelation(
            {
              fromId: entry.symbol.id,
              toId: this.makeExternalId(language, filePath, 'call', callSite.name),
              type: 'CALLS',
              confidence: 0.5,
            },
            `call:${callSite.name}`,
          );
        }
      }
    }

    return {
      symbols,
      relations,
      invocations,
      unresolvedRefs: Array.from(unresolvedRefs).sort(),
    };
  }

  private createSymbol(
    node: Parser.SyntaxNode,
    filePath: string,
    language: string,
    parentSymbol: ExtractedSymbol | null,
  ): ExtractedSymbol | null {
    const name = this.extractName(node);
    if (!name) return null;
    const type = node.type === 'class_definition' ? 'Class' : parentSymbol?.type === 'Class' ? 'Method' : 'Function';

    return {
      id: this.makeSymbolId({
        language,
        filePath,
        ownerName: parentSymbol?.name ?? 'root',
        name,
        parameterCount: this.countParameters(node),
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      }),
      name,
      type,
      filePath,
      language,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      modifiers: [],
      parentId: parentSymbol?.id ?? null,
      exported: !name.startsWith('_'),
    };
  }

  private createPropertySymbol(
    node: Parser.SyntaxNode,
    filePath: string,
    language: string,
    parentSymbol: ExtractedSymbol,
  ): ExtractedSymbol | null {
    const left = node.namedChildren[0];
    if (left?.type !== 'identifier') return null;
    const name = left.text;

    return {
      id: this.makeSymbolId({
        language,
        filePath,
        ownerName: parentSymbol.name,
        name,
        parameterCount: 0,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      }),
      name,
      type: 'Variable',
      filePath,
      language,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      modifiers: [],
      parentId: parentSymbol.id,
      exported: parentSymbol.exported,
    };
  }

  private extractName(node: Parser.SyntaxNode): string | null {
    return node.namedChildren.find((child) => child.type === 'identifier')?.text ?? null;
  }

  private countParameters(node: Parser.SyntaxNode): number {
    const parameters = node.namedChildren.find((child) => child.type === 'parameters');
    if (!parameters) return 0;
    return parameters.namedChildren.filter((child) =>
      child.type === 'identifier' && child.text !== 'self' && child.text !== 'cls',
    ).length;
  }

  private extractImports(root: Parser.SyntaxNode): Array<{ source: string; bindings: string[] }> {
    const imports: Array<{ source: string; bindings: string[] }> = [];
    for (const child of root.namedChildren) {
      if (child.type === 'import_statement') {
        for (const node of child.namedChildren) {
          const binding = this.extractImportBinding(node);
          if (binding) {
            imports.push({ source: binding.source, bindings: [binding.binding] });
          }
        }
      }
      if (child.type === 'import_from_statement') {
        const source = child.namedChildren.find((node) => node.type === 'dotted_name')?.text;
        if (!source) continue;
        const bindings = child.namedChildren
          .slice(1)
          .map((node) => this.extractImportBinding(node)?.binding)
          .filter((binding): binding is string => Boolean(binding));
        imports.push({ source, bindings });
      }
    }
    return imports;
  }

  private extractImportBinding(node: Parser.SyntaxNode): { source: string; binding: string } | null {
    if (node.type === 'aliased_import') {
      const sourceNode = node.namedChildren[0];
      const aliasNode = node.namedChildren[1];
      const source = sourceNode?.text;
      const binding = aliasNode?.text ?? source?.split('.').at(-1);
      return source && binding ? { source, binding } : null;
    }
    if (node.type === 'dotted_name') {
      const source = node.text;
      const binding = source.split('.').at(-1);
      return binding ? { source, binding } : null;
    }
    return null;
  }

  private extractBaseClasses(node: Parser.SyntaxNode): string[] {
    const argumentList = node.namedChildren.find((child) => child.type === 'argument_list');
    if (!argumentList) return [];
    return argumentList.namedChildren
      .filter((child) => child.type === 'identifier')
      .map((child) => child.text);
  }

  private collectCalls(node: Parser.SyntaxNode): Array<{ name: string; startLine: number; endLine: number }> {
    const calls: Array<{ name: string; startLine: number; endLine: number }> = [];
    const visit = (current: Parser.SyntaxNode) => {
      if (current.type === 'call') {
        const callee = current.namedChildren[0];
        const name = this.extractCalleeName(callee);
        if (name) {
          calls.push({
            name,
            startLine: current.startPosition.row + 1,
            endLine: current.endPosition.row + 1,
          });
        }
      }
      for (const child of current.namedChildren) {
        visit(child);
      }
    };
    for (const child of node.namedChildren) {
      visit(child);
    }
    return calls;
  }

  private extractCalleeName(node: Parser.SyntaxNode | undefined): string | null {
    if (!node) return null;
    if (node.type === 'identifier') return node.text;
    if (node.type !== 'attribute') return null;
    const property = node.namedChildren[node.namedChildren.length - 1];
    return property?.type === 'identifier' ? property.text : null;
  }

  private collectPropertyAccesses(node: Parser.SyntaxNode): Array<{ name: string; mode: 'read' | 'write' }> {
    const accesses: Array<{ name: string; mode: 'read' | 'write' }> = [];
    const extractSelfProperty = (current: Parser.SyntaxNode): string | null => {
      if (current.type !== 'attribute') return null;
      const object = current.namedChildren[0];
      const property = current.namedChildren[current.namedChildren.length - 1];
      if (object?.type !== 'identifier' || object.text !== 'self') return null;
      if (property?.type !== 'identifier') return null;
      return property.text;
    };
    const visit = (current: Parser.SyntaxNode, writeTarget: Parser.SyntaxNode | null) => {
      if (current.type === 'assignment') {
        const target = current.namedChildren[0] ?? null;
        for (const child of current.namedChildren) {
          visit(child, child === target ? target : null);
        }
        return;
      }
      const name = extractSelfProperty(current);
      if (name) {
        accesses.push({ name, mode: current === writeTarget ? 'write' : 'read' });
      }
      for (const child of current.namedChildren) {
        visit(child, writeTarget);
      }
    };
    for (const child of node.namedChildren) {
      visit(child, null);
    }
    return accesses;
  }

  private makeSymbolId(input: {
    language: string;
    filePath: string;
    ownerName: string;
    name: string;
    parameterCount: number;
    startLine: number;
    endLine: number;
  }): string {
    return `${input.language}:${input.filePath}:${input.ownerName}:${input.name}:${input.parameterCount}:${input.startLine}:${input.endLine}`;
  }

  private makeExternalId(
    language: string,
    filePath: string,
    kind: 'import' | 'extends' | 'call',
    name: string,
    source?: string,
  ): string {
    const tail = source ? `${source}:${name}` : name;
    return `external:${language}:${filePath}:${kind}:${tail}`;
  }
}
