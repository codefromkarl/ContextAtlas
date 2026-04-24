import type Parser from '@keqingmoe/tree-sitter';
import type { ExtractedInvocation, ExtractedRelation, ExtractedSymbol, GraphWritePayload } from '../types.js';
import type { SymbolExtractionInput, SymbolExtractionProvider } from './types.js';

interface SymbolNodeEntry {
  symbol: ExtractedSymbol;
  node: Parser.SyntaxNode;
  receiverName: string | null;
}

export class GoSymbolProvider implements SymbolExtractionProvider {
  readonly languages = ['go'] as const;

  extract(input: SymbolExtractionInput): GraphWritePayload {
    const { tree, filePath, language } = input;
    if (language !== 'go') {
      return { symbols: [], relations: [], unresolvedRefs: [] };
    }

    const symbols: ExtractedSymbol[] = [];
    const symbolNodes: SymbolNodeEntry[] = [];
    const relations: ExtractedRelation[] = [];
    const invocations: ExtractedInvocation[] = [];
    const unresolvedRefs = new Set<string>();
    const relationKeys = new Set<string>();
    const invocationKeys = new Set<string>();
    const classesByName = new Map<string, ExtractedSymbol>();

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

      if (node.type === 'type_spec' && node.namedChildren.some((child) => child.type === 'struct_type')) {
        const symbol = this.createClassSymbol(node, filePath, language);
        if (symbol) {
          symbols.push(symbol);
          symbolNodes.push({ symbol, node, receiverName: null });
          classesByName.set(symbol.name, symbol);
          currentParent = symbol;
        }
      } else if (node.type === 'field_declaration' && parentSymbol?.type === 'Class') {
        const symbol = this.createPropertySymbol(node, filePath, language, parentSymbol);
        if (symbol) {
          symbols.push(symbol);
          symbolNodes.push({ symbol, node, receiverName: null });
          pushRelation({
            fromId: parentSymbol.id,
            toId: symbol.id,
            type: 'HAS_PROPERTY',
            confidence: 1,
          });
        }
      } else if (node.type === 'function_declaration') {
        const symbol = this.createFunctionSymbol(node, filePath, language);
        if (symbol) {
          symbols.push(symbol);
          symbolNodes.push({ symbol, node, receiverName: null });
          currentParent = symbol;
        }
      } else if (node.type === 'method_declaration') {
        const receiver = this.extractReceiver(node);
        const owner = receiver.typeName ? classesByName.get(receiver.typeName) ?? null : null;
        const symbol = this.createMethodSymbol(node, filePath, language, receiver.typeName ?? 'root', owner);
        if (symbol) {
          symbols.push(symbol);
          symbolNodes.push({ symbol, node, receiverName: receiver.variableName });
          currentParent = symbol;
          if (owner) {
            pushRelation({
              fromId: owner.id,
              toId: symbol.id,
              type: 'HAS_METHOD',
              confidence: 1,
            });
          }
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
      if (entry.symbol.type === 'Function' || entry.symbol.type === 'Method') {
        for (const access of this.collectPropertyAccesses(entry.node, entry.receiverName)) {
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

  private createClassSymbol(node: Parser.SyntaxNode, filePath: string, language: string): ExtractedSymbol | null {
    const name = node.namedChildren.find((child) => child.type === 'type_identifier')?.text
      ?? node.namedChildren.find((child) => child.type === 'identifier')?.text;
    if (!name) return null;
    return this.makeSymbol({
      language,
      filePath,
      ownerName: 'root',
      name,
      type: 'Class',
      parameterCount: 0,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      parentId: null,
      exported: /^[A-Z]/.test(name),
    });
  }

  private createPropertySymbol(
    node: Parser.SyntaxNode,
    filePath: string,
    language: string,
    parentSymbol: ExtractedSymbol,
  ): ExtractedSymbol | null {
    const name = node.namedChildren.find((child) => child.type === 'field_identifier')?.text;
    if (!name) return null;
    return this.makeSymbol({
      language,
      filePath,
      ownerName: parentSymbol.name,
      name,
      type: 'Variable',
      parameterCount: 0,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      parentId: parentSymbol.id,
      exported: /^[A-Z]/.test(name),
    });
  }

  private createFunctionSymbol(node: Parser.SyntaxNode, filePath: string, language: string): ExtractedSymbol | null {
    const name = node.namedChildren.find((child) => child.type === 'identifier')?.text;
    if (!name) return null;
    return this.makeSymbol({
      language,
      filePath,
      ownerName: 'root',
      name,
      type: 'Function',
      parameterCount: this.countParameters(node),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      parentId: null,
      exported: /^[A-Z]/.test(name),
    });
  }

  private createMethodSymbol(
    node: Parser.SyntaxNode,
    filePath: string,
    language: string,
    ownerName: string,
    owner: ExtractedSymbol | null,
  ): ExtractedSymbol | null {
    const name = node.namedChildren.find((child) => child.type === 'field_identifier')?.text;
    if (!name) return null;
    return this.makeSymbol({
      language,
      filePath,
      ownerName,
      name,
      type: 'Method',
      parameterCount: this.countParameters(node, { skipFirst: true }),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      parentId: owner?.id ?? null,
      exported: /^[A-Z]/.test(name),
    });
  }

  private makeSymbol(input: {
    language: string;
    filePath: string;
    ownerName: string;
    name: string;
    type: ExtractedSymbol['type'];
    parameterCount: number;
    startLine: number;
    endLine: number;
    parentId: string | null;
    exported: boolean;
  }): ExtractedSymbol {
    return {
      id: `${input.language}:${input.filePath}:${input.ownerName}:${input.name}:${input.parameterCount}:${input.startLine}:${input.endLine}`,
      name: input.name,
      type: input.type,
      filePath: input.filePath,
      language: input.language,
      startLine: input.startLine,
      endLine: input.endLine,
      modifiers: [],
      parentId: input.parentId,
      exported: input.exported,
    };
  }

  private countParameters(node: Parser.SyntaxNode, options: { skipFirst?: boolean } = {}): number {
    const parameterLists = node.namedChildren.filter((child) => child.type === 'parameter_list');
    const params = (options.skipFirst ? parameterLists.slice(1) : parameterLists).flatMap((list) =>
      list.namedChildren.filter((child) => child.type === 'parameter_declaration'),
    );
    return params.length;
  }

  private extractReceiver(node: Parser.SyntaxNode): { variableName: string | null; typeName: string | null } {
    const receiverList = node.namedChildren.find((child) => child.type === 'parameter_list');
    const receiver = receiverList?.namedChildren.find((child) => child.type === 'parameter_declaration');
    const identifiers = receiver?.namedChildren.filter((child) => child.type === 'identifier') ?? [];
    const typeName = this.findFirstNodeText(receiver, 'type_identifier')
      ?? identifiers[1]?.text
      ?? null;
    return {
      variableName: identifiers[0]?.text ?? null,
      typeName,
    };
  }

  private findFirstNodeText(node: Parser.SyntaxNode | undefined, type: string): string | null {
    if (!node) return null;
    if (node.type === type) return node.text;
    for (const child of node.namedChildren) {
      const found = this.findFirstNodeText(child, type);
      if (found) return found;
    }
    return null;
  }

  private extractImports(root: Parser.SyntaxNode): Array<{ source: string; bindings: string[] }> {
    const imports: Array<{ source: string; bindings: string[] }> = [];
    const specs: Parser.SyntaxNode[] = [];
    const visit = (node: Parser.SyntaxNode) => {
      if (node.type === 'import_spec') specs.push(node);
      for (const child of node.namedChildren) visit(child);
    };
    visit(root);

    for (const spec of specs) {
      const source = spec.namedChildren.find((child) => child.type === 'interpreted_string_literal')?.text.replace(/^"|"$/g, '');
      if (!source) continue;
      const alias = spec.namedChildren.find((child) => child.type === 'package_identifier')?.text;
      const binding = alias ?? source.split('/').at(-1);
      if (binding) imports.push({ source, bindings: [binding] });
    }
    return imports;
  }

  private collectCalls(node: Parser.SyntaxNode): Array<{ name: string; startLine: number; endLine: number }> {
    const calls: Array<{ name: string; startLine: number; endLine: number }> = [];
    const visit = (current: Parser.SyntaxNode) => {
      if (current.type === 'call_expression') {
        const name = this.extractSelectorName(current.namedChildren[0]);
        if (name) {
          calls.push({
            name,
            startLine: current.startPosition.row + 1,
            endLine: current.endPosition.row + 1,
          });
        }
      }
      for (const child of current.namedChildren) visit(child);
    };
    for (const child of node.namedChildren) visit(child);
    return calls;
  }

  private collectPropertyAccesses(
    node: Parser.SyntaxNode,
    receiverName: string | null,
  ): Array<{ name: string; mode: 'read' | 'write' }> {
    if (!receiverName) return [];
    const accesses: Array<{ name: string; mode: 'read' | 'write' }> = [];
    const extractReceiverProperty = (current: Parser.SyntaxNode): string | null => {
      if (current.type !== 'selector_expression') return null;
      const object = current.namedChildren[0];
      const property = current.namedChildren[current.namedChildren.length - 1];
      if (object?.type !== 'identifier' || object.text !== receiverName) return null;
      if (property?.type !== 'field_identifier') return null;
      return property.text;
    };
    const visit = (current: Parser.SyntaxNode, writeMode: boolean) => {
      if (current.type === 'assignment_statement') {
        const target = current.namedChildren[0] ?? null;
        for (const child of current.namedChildren) {
          visit(child, child === target);
        }
        return;
      }
      const name = extractReceiverProperty(current);
      if (name) accesses.push({ name, mode: writeMode ? 'write' : 'read' });
      for (const child of current.namedChildren) visit(child, writeMode);
    };
    for (const child of node.namedChildren) visit(child, false);
    return accesses;
  }

  private extractSelectorName(node: Parser.SyntaxNode | undefined): string | null {
    if (!node) return null;
    if (node.type === 'identifier') return node.text;
    if (node.type !== 'selector_expression') return null;
    const property = node.namedChildren[node.namedChildren.length - 1];
    return property?.type === 'field_identifier' ? property.text : null;
  }

  private makeExternalId(
    language: string,
    filePath: string,
    kind: 'import' | 'call',
    name: string,
    source?: string,
  ): string {
    const tail = source ? `${source}:${name}` : name;
    return `external:${language}:${filePath}:${kind}:${tail}`;
  }
}
