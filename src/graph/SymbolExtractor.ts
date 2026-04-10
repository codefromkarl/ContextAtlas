import type Parser from '@keqingmoe/tree-sitter';
import { getLanguageSpec, type LanguageSpecConfig } from '../chunking/LanguageSpec.js';
import type { ExtractedRelation, ExtractedSymbol, GraphWritePayload } from './types.js';

type SupportedGraphLanguage = 'typescript' | 'javascript';

interface SymbolNodeEntry {
  symbol: ExtractedSymbol;
  node: Parser.SyntaxNode;
}

const SUPPORTED_LANGUAGES = new Set<SupportedGraphLanguage>(['typescript', 'javascript']);
const DECLARATION_TYPES = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'function_declaration',
  'generator_function_declaration',
  'method_definition',
]);

export class SymbolExtractor {
  extract(
    tree: Parser.Tree,
    _code: string,
    filePath: string,
    language: string,
  ): GraphWritePayload {
    if (!SUPPORTED_LANGUAGES.has(language as SupportedGraphLanguage)) {
      return { symbols: [], relations: [], unresolvedRefs: [] };
    }

    const spec = getLanguageSpec(language);
    if (!spec) {
      return { symbols: [], relations: [], unresolvedRefs: [] };
    }

    const symbols: ExtractedSymbol[] = [];
    const symbolNodes: SymbolNodeEntry[] = [];
    const relations: ExtractedRelation[] = [];
    const unresolvedRefs = new Set<string>();
    const relationKeys = new Set<string>();

    const pushRelation = (relation: ExtractedRelation, unresolvedRef?: string) => {
      const key = `${relation.fromId}|${relation.toId}|${relation.type}|${relation.reason ?? ''}`;
      if (relationKeys.has(key)) return;
      relationKeys.add(key);
      relations.push(relation);
      if (unresolvedRef) unresolvedRefs.add(unresolvedRef);
    };

    const visit = (node: Parser.SyntaxNode, parentSymbol: ExtractedSymbol | null) => {
      let currentParent = parentSymbol;

      if (DECLARATION_TYPES.has(node.type)) {
        const symbol = this.createSymbol(node, filePath, language, spec, parentSymbol);
        if (symbol) {
          symbols.push(symbol);
          symbolNodes.push({ symbol, node });
          currentParent = symbol;

          if (parentSymbol && parentSymbol.type === 'Class' && symbol.type === 'Method') {
            pushRelation({
              fromId: parentSymbol.id,
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
    for (const symbol of symbols) {
      if (!symbolsByName.has(symbol.name)) {
        symbolsByName.set(symbol.name, symbol);
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
        const heritage = entry.node.namedChildren.find((child) => child.type === 'class_heritage');
        if (heritage) {
          const extendsClause = heritage.namedChildren.find((child) => child.type === 'extends_clause');
          const baseName = this.extractFirstIdentifier(extendsClause);
          if (baseName) {
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

          const implementsClause = heritage.namedChildren.find((child) => child.type === 'implements_clause');
          for (const implementedName of this.extractTypeNames(implementsClause)) {
            pushRelation(
              {
                fromId: entry.symbol.id,
                toId: this.makeExternalId(language, filePath, 'implements', implementedName),
                type: 'IMPLEMENTS',
                confidence: 0.7,
              },
              `implements:${implementedName}`,
            );
          }
        }
      }

      if (entry.symbol.type === 'Function' || entry.symbol.type === 'Method') {
        for (const calledName of this.collectCalls(entry.node)) {
          const localTarget = symbolsByName.get(calledName);
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
              toId: this.makeExternalId(language, filePath, 'call', calledName),
              type: 'CALLS',
              confidence: 0.5,
            },
            `call:${calledName}`,
          );
        }
      }
    }

    return {
      symbols,
      relations,
      unresolvedRefs: Array.from(unresolvedRefs).sort(),
    };
  }

  private createSymbol(
    node: Parser.SyntaxNode,
    filePath: string,
    language: string,
    spec: LanguageSpecConfig,
    parentSymbol: ExtractedSymbol | null,
  ): ExtractedSymbol | null {
    const name = this.extractNodeName(node, spec);
    if (!name) return null;

    const type = this.mapNodeType(node.type);
    if (!type) return null;

    return {
      id: `${language}:${filePath}:${name}:${node.startPosition.row + 1}`,
      name,
      type,
      filePath,
      language,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      modifiers: this.extractModifiers(node),
      parentId: parentSymbol?.id ?? null,
      exported: this.isExported(node),
    };
  }

  private mapNodeType(nodeType: string): ExtractedSymbol['type'] | null {
    switch (nodeType) {
      case 'class_declaration':
      case 'abstract_class_declaration':
        return 'Class';
      case 'interface_declaration':
        return 'Interface';
      case 'method_definition':
        return 'Method';
      case 'function_declaration':
      case 'generator_function_declaration':
        return 'Function';
      default:
        return null;
    }
  }

  private extractNodeName(node: Parser.SyntaxNode, spec: LanguageSpecConfig): string | null {
    for (const child of node.namedChildren) {
      if (spec.nameNodeTypes.has(child.type)) {
        return child.text;
      }
    }

    const firstChild = node.firstNamedChild;
    if (firstChild && firstChild.text.length <= 100 && !firstChild.text.includes('\n')) {
      return firstChild.text;
    }

    return null;
  }

  private extractModifiers(node: Parser.SyntaxNode): string[] {
    const modifiers = new Set<string>();
    for (const child of node.children) {
      if (
        child.type === 'async'
        || child.type === 'static'
        || child.type === 'public'
        || child.type === 'private'
        || child.type === 'protected'
        || child.type === 'abstract'
        || child.type === 'readonly'
      ) {
        modifiers.add(child.type);
      }
    }
    return Array.from(modifiers);
  }

  private isExported(node: Parser.SyntaxNode): boolean {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
      if (current.type === 'export_statement') {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  private extractImports(root: Parser.SyntaxNode): Array<{ source: string; bindings: string[] }> {
    const imports: Array<{ source: string; bindings: string[] }> = [];

    for (const child of root.namedChildren) {
      if (child.type !== 'import_statement') continue;

      const sourceNode = child.namedChildren.find((node) => node.type === 'string');
      const source = sourceNode?.text.replace(/^['"]|['"]$/g, '');
      if (!source) continue;

      const clause = child.namedChildren.find((node) => node.type === 'import_clause');
      const bindings = new Set<string>();

      if (clause) {
        for (const node of clause.namedChildren) {
          if (node.type === 'identifier') {
            bindings.add(node.text);
          } else if (node.type === 'named_imports') {
            for (const specifier of node.namedChildren) {
              if (specifier.type !== 'import_specifier') continue;
              const imported = specifier.namedChildren[0];
              if (imported?.text) bindings.add(imported.text);
            }
          }
        }
      }

      imports.push({ source, bindings: Array.from(bindings) });
    }

    return imports;
  }

  private extractFirstIdentifier(node: Parser.SyntaxNode | undefined): string | null {
    if (!node) return null;
    for (const child of node.namedChildren) {
      if (child.type === 'identifier' || child.type === 'type_identifier') {
        return child.text;
      }
    }
    return null;
  }

  private extractTypeNames(node: Parser.SyntaxNode | undefined): string[] {
    if (!node) return [];
    const names: string[] = [];

    const visit = (current: Parser.SyntaxNode) => {
      if (current.type === 'identifier' || current.type === 'type_identifier') {
        names.push(current.text);
        return;
      }
      for (const child of current.namedChildren) {
        visit(child);
      }
    };

    visit(node);
    return names;
  }

  private collectCalls(node: Parser.SyntaxNode): string[] {
    const names: string[] = [];

    const visit = (current: Parser.SyntaxNode) => {
      if (current.type === 'call_expression') {
        const callee = current.namedChildren[0];
        if (callee && (callee.type === 'identifier' || callee.type === 'property_identifier')) {
          names.push(callee.text);
        }
      }
      for (const child of current.namedChildren) {
        visit(child);
      }
    };

    for (const child of node.namedChildren) {
      visit(child);
    }

    return names;
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
