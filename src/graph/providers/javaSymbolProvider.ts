import type Parser from '@keqingmoe/tree-sitter';
import type { ExtractedInvocation, ExtractedRelation, ExtractedSymbol, GraphWritePayload } from '../types.js';
import type { SymbolExtractionInput, SymbolExtractionProvider } from './types.js';

interface SymbolNodeEntry {
  symbol: ExtractedSymbol;
  node: Parser.SyntaxNode;
}

export class JavaSymbolProvider implements SymbolExtractionProvider {
  readonly languages = ['java'] as const;

  extract(input: SymbolExtractionInput): GraphWritePayload {
    const { tree, filePath, language } = input;
    if (language !== 'java') return { symbols: [], relations: [], unresolvedRefs: [] };

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
      if (node.type === 'class_declaration' || node.type === 'interface_declaration') {
        const symbol = this.createClassLikeSymbol(node, filePath, language);
        if (symbol) {
          symbols.push(symbol);
          symbolNodes.push({ symbol, node });
          currentParent = symbol;
        }
      } else if (node.type === 'field_declaration' && parentSymbol) {
        const symbol = this.createPropertySymbol(node, filePath, language, parentSymbol);
        if (symbol) {
          symbols.push(symbol);
          symbolNodes.push({ symbol, node });
          pushRelation({ fromId: parentSymbol.id, toId: symbol.id, type: 'HAS_PROPERTY', confidence: 1 });
        }
      } else if (node.type === 'method_declaration' && parentSymbol) {
        const symbol = this.createMethodSymbol(node, filePath, language, parentSymbol);
        if (symbol) {
          symbols.push(symbol);
          symbolNodes.push({ symbol, node });
          currentParent = symbol;
          pushRelation({ fromId: parentSymbol.id, toId: symbol.id, type: 'HAS_METHOD', confidence: 1 });
        }
      }

      for (const child of node.namedChildren) visit(child, currentParent);
    };

    visit(tree.rootNode, null);

    const symbolsByName = new Map<string, ExtractedSymbol>();
    const propertiesByOwnerAndName = new Map<string, ExtractedSymbol>();
    for (const symbol of symbols) {
      if (!symbolsByName.has(symbol.name)) symbolsByName.set(symbol.name, symbol);
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
            { fromId: symbol.id, toId: targetId, type: 'IMPORTS', confidence: 0.6, reason: importEntry.source },
            `${importEntry.source}:${binding}`,
          );
        }
      }
    }

    for (const entry of symbolNodes) {
      if (entry.symbol.type === 'Class' || entry.symbol.type === 'Interface') {
        for (const baseName of this.extractHeritage(entry.node)) {
          pushRelation(
            {
              fromId: entry.symbol.id,
              toId: this.makeExternalId(language, filePath, baseName.kind, baseName.name),
              type: baseName.kind === 'extends' ? 'EXTENDS' : 'IMPLEMENTS',
              confidence: 0.7,
            },
            `${baseName.kind}:${baseName.name}`,
          );
        }
      }

      if (entry.symbol.type === 'Method') {
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
            pushRelation({ fromId: entry.symbol.id, toId: localTarget.id, type: 'CALLS', confidence: 1 });
          } else {
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
    }

    return { symbols, relations, invocations, unresolvedRefs: Array.from(unresolvedRefs).sort() };
  }

  private createClassLikeSymbol(node: Parser.SyntaxNode, filePath: string, language: string): ExtractedSymbol | null {
    const name = node.namedChildren.find((child) => child.type === 'identifier')?.text;
    if (!name) return null;
    const type = node.type === 'interface_declaration' ? 'Interface' : 'Class';
    return this.makeSymbol(language, filePath, 'root', name, type, 0, node, null, /^[A-Z]/.test(name));
  }

  private createPropertySymbol(
    node: Parser.SyntaxNode,
    filePath: string,
    language: string,
    parentSymbol: ExtractedSymbol,
  ): ExtractedSymbol | null {
    const declarator = node.namedChildren.find((child) => child.type === 'variable_declarator');
    const name = declarator?.namedChildren.find((child) => child.type === 'identifier')?.text;
    if (!name) return null;
    return this.makeSymbol(language, filePath, parentSymbol.name, name, 'Variable', 0, node, parentSymbol.id, /^[A-Z]/.test(name));
  }

  private createMethodSymbol(
    node: Parser.SyntaxNode,
    filePath: string,
    language: string,
    parentSymbol: ExtractedSymbol,
  ): ExtractedSymbol | null {
    const name = node.namedChildren.find((child) => child.type === 'identifier')?.text;
    if (!name) return null;
    return this.makeSymbol(
      language,
      filePath,
      parentSymbol.name,
      name,
      'Method',
      this.countParameters(node),
      node,
      parentSymbol.id,
      /^[A-Z]/.test(name),
    );
  }

  private makeSymbol(
    language: string,
    filePath: string,
    ownerName: string,
    name: string,
    type: ExtractedSymbol['type'],
    parameterCount: number,
    node: Parser.SyntaxNode,
    parentId: string | null,
    exported: boolean,
  ): ExtractedSymbol {
    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    return {
      id: `${language}:${filePath}:${ownerName}:${name}:${parameterCount}:${startLine}:${endLine}`,
      name,
      type,
      filePath,
      language,
      startLine,
      endLine,
      modifiers: [],
      parentId,
      exported,
    };
  }

  private countParameters(node: Parser.SyntaxNode): number {
    const parameters = node.namedChildren.find((child) => child.type === 'formal_parameters');
    if (!parameters) return 0;
    return parameters.namedChildren.filter((child) => child.type === 'formal_parameter').length;
  }

  private extractImports(root: Parser.SyntaxNode): Array<{ source: string; bindings: string[] }> {
    return root.namedChildren
      .filter((child) => child.type === 'import_declaration')
      .map((node) => node.namedChildren.find((child) => child.type === 'scoped_identifier')?.text)
      .filter((source): source is string => Boolean(source))
      .map((source) => ({ source, bindings: [source.split('.').at(-1) ?? source] }));
  }

  private extractHeritage(node: Parser.SyntaxNode): Array<{ kind: 'extends' | 'implements'; name: string }> {
    const results: Array<{ kind: 'extends' | 'implements'; name: string }> = [];
    for (const child of node.namedChildren) {
      if (child.type === 'superclass') {
        const name = child.namedChildren.find((entry) => entry.type === 'identifier' || entry.type === 'type_identifier')?.text;
        if (name) results.push({ kind: 'extends', name });
      }
      if (child.type === 'super_interfaces') {
        for (const nameNode of child.namedChildren.flatMap((entry) => entry.namedChildren)) {
          if (nameNode.type === 'identifier' || nameNode.type === 'type_identifier') {
            results.push({ kind: 'implements', name: nameNode.text });
          }
        }
      }
    }
    return results;
  }

  private collectCalls(node: Parser.SyntaxNode): Array<{ name: string; startLine: number; endLine: number }> {
    const calls: Array<{ name: string; startLine: number; endLine: number }> = [];
    const visit = (current: Parser.SyntaxNode) => {
      if (current.type === 'method_invocation') {
        const name = current.namedChildren.findLast((child) => child.type === 'identifier')?.text;
        if (name) calls.push({ name, startLine: current.startPosition.row + 1, endLine: current.endPosition.row + 1 });
      }
      for (const child of current.namedChildren) visit(child);
    };
    for (const child of node.namedChildren) visit(child);
    return calls;
  }

  private collectPropertyAccesses(node: Parser.SyntaxNode): Array<{ name: string; mode: 'read' | 'write' }> {
    const accesses: Array<{ name: string; mode: 'read' | 'write' }> = [];
    const extractThisProperty = (current: Parser.SyntaxNode): string | null => {
      if (current.type !== 'field_access') return null;
      const object = current.namedChildren[0];
      const property = current.namedChildren[current.namedChildren.length - 1];
      if (object?.type !== 'this') return null;
      if (property?.type !== 'identifier') return null;
      return property.text;
    };
    const visit = (current: Parser.SyntaxNode, writeMode: boolean) => {
      if (current.type === 'assignment_expression') {
        const target = current.namedChildren[0] ?? null;
        for (const child of current.namedChildren) visit(child, child === target);
        return;
      }
      const name = extractThisProperty(current);
      if (name) accesses.push({ name, mode: writeMode ? 'write' : 'read' });
      for (const child of current.namedChildren) visit(child, writeMode);
    };
    for (const child of node.namedChildren) visit(child, false);
    return accesses;
  }

  private makeExternalId(
    language: string,
    filePath: string,
    kind: 'import' | 'extends' | 'implements' | 'call',
    name: string,
    source?: string,
  ): string {
    const tail = source ? `${source}:${name}` : name;
    return `external:${language}:${filePath}:${kind}:${tail}`;
  }
}
