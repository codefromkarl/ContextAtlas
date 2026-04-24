import type Parser from '@keqingmoe/tree-sitter';
import { getLanguageSpec, type LanguageSpecConfig } from '../../chunking/LanguageSpec.js';
import type { ExtractedInvocation, ExtractedRelation, ExtractedSymbol, GraphWritePayload } from '../types.js';
import type { SymbolExtractionInput, SymbolExtractionProvider } from './types.js';

type SupportedGraphLanguage = 'typescript' | 'javascript';

interface SymbolNodeEntry {
  symbol: ExtractedSymbol;
  node: Parser.SyntaxNode;
}

interface CallSite {
  name: string;
  startLine: number;
  endLine: number;
  receiverType?: string;
  receiverName?: string;
}

const SUPPORTED_LANGUAGES = new Set<SupportedGraphLanguage>(['typescript', 'javascript']);
const DECLARATION_TYPES = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'function_declaration',
  'generator_function_declaration',
  'method_definition',
  'method_signature',
]);
const PROPERTY_TYPES = new Set(['public_field_definition', 'field_definition', 'property_signature']);

export class TsJsSymbolProvider implements SymbolExtractionProvider {
  readonly languages = ['typescript', 'javascript'] as const;

  extract(input: SymbolExtractionInput): GraphWritePayload {
    const { tree, filePath, language } = input;
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
      } else if (PROPERTY_TYPES.has(node.type) && parentSymbol) {
        const symbol = this.createPropertySymbol(node, filePath, language, parentSymbol);
        if (symbol) {
          symbols.push(symbol);
          symbolNodes.push({ symbol, node });

          if (parentSymbol.type === 'Class' || parentSymbol.type === 'Interface') {
            pushRelation({
              fromId: parentSymbol.id,
              toId: symbol.id,
              type: 'HAS_PROPERTY',
              confidence: 1,
            });
          }
        }
      }

      for (const child of node.namedChildren) {
        visit(child, currentParent);
      }
    };

    const pushInvocation = (invocation: ExtractedInvocation) => {
      const key = invocation.id;
      if (invocationKeys.has(key)) return;
      invocationKeys.add(key);
      invocations.push(invocation);
    };

    visit(tree.rootNode, null);

    const symbolsByName = new Map<string, ExtractedSymbol>();
    const symbolsByParent = new Map<string, ExtractedSymbol[]>();
    const propertiesByOwnerAndName = new Map<string, ExtractedSymbol>();
    const propertyTypesByOwnerAndName = new Map<string, string>();
    const returnTypesByFunctionName = new Map<string, string>();
    for (const symbol of symbols) {
      if (!symbolsByName.has(symbol.name)) {
        symbolsByName.set(symbol.name, symbol);
      }
      if (symbol.parentId) {
        const siblings = symbolsByParent.get(symbol.parentId) ?? [];
        siblings.push(symbol);
        symbolsByParent.set(symbol.parentId, siblings);
      }
      if (symbol.type === 'Variable' && symbol.parentId) {
        propertiesByOwnerAndName.set(`${symbol.parentId}:${symbol.name}`, symbol);
      }
    }
    for (const entry of symbolNodes) {
      if (entry.symbol.type !== 'Variable' || !entry.symbol.parentId) continue;
      const declaredType = this.extractDeclaredType(entry.node);
      if (declaredType) {
        propertyTypesByOwnerAndName.set(`${entry.symbol.parentId}:${entry.symbol.name}`, declaredType);
      }
    }
    for (const entry of symbolNodes) {
      if (entry.symbol.type === 'Function' || entry.symbol.type === 'Method') {
        const returnType = this.extractDeclaredReturnType(entry.node);
        if (returnType && !returnTypesByFunctionName.has(entry.symbol.name)) {
          returnTypesByFunctionName.set(entry.symbol.name, returnType);
        }
      }
    }
    for (const entry of symbolNodes) {
      if (entry.symbol.type !== 'Method' || entry.symbol.name !== 'constructor' || !entry.symbol.parentId) {
        continue;
      }
      for (const inferred of this.inferConstructorPropertyTypes(entry.node)) {
        propertyTypesByOwnerAndName.set(`${entry.symbol.parentId}:${inferred.propertyName}`, inferred.typeName);
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
            const localBase = symbolsByName.get(baseName);
            pushRelation(
              {
                fromId: entry.symbol.id,
                toId: localBase?.id ?? this.makeExternalId(language, filePath, 'extends', baseName),
                type: 'EXTENDS',
                confidence: localBase ? 0.95 : 0.7,
                reason: localBase ? 'same-file' : undefined,
              },
              `extends:${baseName}`,
            );
            if (localBase) {
              this.pushMethodMatchRelations({
                owner: entry.symbol,
                targetOwner: localBase,
                relationType: 'METHOD_OVERRIDES',
                symbolsByParent,
                pushRelation,
              });
            }
          }

          const implementsClause = heritage.namedChildren.find((child) => child.type === 'implements_clause');
          for (const implementedName of this.extractTypeNames(implementsClause)) {
            const localInterface = symbolsByName.get(implementedName);
            pushRelation(
              {
                fromId: entry.symbol.id,
                toId: localInterface?.id ?? this.makeExternalId(language, filePath, 'implements', implementedName),
                type: 'IMPLEMENTS',
                confidence: localInterface ? 0.95 : 0.7,
                reason: localInterface ? 'same-file' : undefined,
              },
              `implements:${implementedName}`,
            );
            if (localInterface) {
              this.pushMethodMatchRelations({
                owner: entry.symbol,
                targetOwner: localInterface,
                relationType: 'METHOD_IMPLEMENTS',
                symbolsByParent,
                pushRelation,
              });
            }
          }
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

        const receiverTypes = this.buildReceiverTypeMap(
          entry.node,
          entry.symbol,
          propertyTypesByOwnerAndName,
          returnTypesByFunctionName,
        );
        for (const callSite of this.collectCalls(entry.node, receiverTypes)) {
          const calledName = callSite.name;
          const localTarget = symbolsByName.get(calledName);
          pushInvocation({
            id: `${entry.symbol.id}:call:${calledName}:${callSite.startLine}`,
            filePath,
            enclosingSymbolId: entry.symbol.id,
            calleeName: calledName,
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
              toId: this.makeExternalId(language, filePath, 'call', calledName),
              type: 'CALLS',
              confidence: callSite.receiverType ? 0.75 : 0.5,
              reason: this.formatCallReason(callSite),
            },
            `call:${calledName}`,
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
    spec: LanguageSpecConfig,
    parentSymbol: ExtractedSymbol | null,
  ): ExtractedSymbol | null {
    const name = this.extractNodeName(node, spec);
    if (!name) return null;

    const type = this.mapNodeType(node.type);
    if (!type) return null;

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
      modifiers: this.extractModifiers(node),
      parentId: parentSymbol?.id ?? null,
      exported: this.isExported(node),
    };
  }

  private createPropertySymbol(
    node: Parser.SyntaxNode,
    filePath: string,
    language: string,
    parentSymbol: ExtractedSymbol,
  ): ExtractedSymbol | null {
    const name = this.extractPropertyName(node);
    if (!name) return null;

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
      modifiers: this.extractModifiers(node),
      parentId: parentSymbol.id,
      exported: parentSymbol.exported,
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
      case 'method_signature':
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

  private extractPropertyName(node: Parser.SyntaxNode): string | null {
    for (const child of node.namedChildren) {
      if (child.type === 'property_identifier' || child.type === 'identifier') {
        return child.text;
      }
    }
    return null;
  }

  private extractDeclaredType(node: Parser.SyntaxNode): string | null {
    const typeNode = node.namedChildren.find((child) => child.type === 'type_annotation');
    if (!typeNode) return null;
    return this.extractFirstTypeName(typeNode);
  }

  private extractDeclaredReturnType(node: Parser.SyntaxNode): string | null {
    const parameters = node.namedChildren.find((child) => child.type === 'formal_parameters');
    const typeNode = node.namedChildren.find((child) => child.type === 'type_annotation' && child !== parameters);
    if (!typeNode) return null;
    return this.extractFirstTypeName(typeNode);
  }

  private countParameters(node: Parser.SyntaxNode): number {
    const parameters = node.namedChildren.find((child) => child.type === 'formal_parameters');
    if (!parameters) return 0;
    return parameters.namedChildren.filter((child) =>
      child.type === 'required_parameter'
      || child.type === 'optional_parameter'
      || child.type === 'rest_pattern'
      || child.type === 'identifier',
    ).length;
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
          } else if (node.type === 'namespace_import') {
            const localName = node.namedChildren.find((child) => child.type === 'identifier')?.text;
            if (localName) bindings.add(localName);
          } else if (node.type === 'named_imports') {
            for (const specifier of node.namedChildren) {
              if (specifier.type !== 'import_specifier') continue;
              const imported = specifier.namedChildren[0];
              const alias = specifier.namedChildren[1];
              const binding = alias?.text ?? imported?.text;
              if (binding) bindings.add(binding);
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

  private collectCalls(node: Parser.SyntaxNode, receiverTypes: Map<string, string>): CallSite[] {
    const calls: CallSite[] = [];

    const visit = (current: Parser.SyntaxNode) => {
      if (current.type === 'call_expression') {
        const callee = current.namedChildren[0];
        if (callee && (callee.type === 'identifier' || callee.type === 'property_identifier')) {
          calls.push({
            name: callee.text,
            startLine: current.startPosition.row + 1,
            endLine: current.endPosition.row + 1,
          });
        } else if (callee?.type === 'member_expression') {
          const memberCall = this.extractMemberCall(callee, receiverTypes);
          if (memberCall) {
            calls.push({
              ...memberCall,
              startLine: current.startPosition.row + 1,
              endLine: current.endPosition.row + 1,
            });
          }
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

  private extractMemberCall(
    callee: Parser.SyntaxNode,
    receiverTypes: Map<string, string>,
  ): Pick<CallSite, 'name' | 'receiverName' | 'receiverType'> | null {
    const property = callee.namedChildren[callee.namedChildren.length - 1];
    if (!property || (property.type !== 'property_identifier' && property.type !== 'identifier')) {
      return null;
    }

    const receiverKey = this.extractReceiverKey(callee.namedChildren[0]);
    if (!receiverKey) {
      return { name: property.text };
    }

    return {
      name: property.text,
      receiverName: receiverKey,
      receiverType: receiverTypes.get(receiverKey),
    };
  }

  private extractReceiverKey(node: Parser.SyntaxNode | undefined): string | null {
    if (!node) return null;
    if (node.type === 'identifier') return node.text;
    if (node.type !== 'member_expression') return null;

    const object = node.namedChildren[0];
    const property = node.namedChildren[node.namedChildren.length - 1];
    if (!object || !property) return null;
    if (property.type !== 'property_identifier' && property.type !== 'identifier') return null;
    if (object.type === 'this') return `this.${property.text}`;
    if (object.type === 'identifier') return `${object.text}.${property.text}`;
    return null;
  }

  private buildReceiverTypeMap(
    node: Parser.SyntaxNode,
    symbol: ExtractedSymbol,
    propertyTypesByOwnerAndName: Map<string, string>,
    returnTypesByFunctionName: Map<string, string>,
  ): Map<string, string> {
    const receiverTypes = new Map<string, string>();

    if (symbol.parentId) {
      for (const [key, value] of propertyTypesByOwnerAndName) {
        if (!key.startsWith(`${symbol.parentId}:`)) continue;
        receiverTypes.set(`this.${key.slice(symbol.parentId.length + 1)}`, value);
      }
    }

    for (const parameter of this.extractTypedParameters(node)) {
      receiverTypes.set(parameter.name, parameter.typeName);
    }

    const visit = (current: Parser.SyntaxNode) => {
      if (current.type === 'variable_declarator' || current.type === 'required_parameter' || current.type === 'optional_parameter') {
        const name = current.namedChildren.find((child) => child.type === 'identifier')?.text;
        const typeName = this.extractDeclaredType(current) ?? this.extractInitializerReturnType(current, returnTypesByFunctionName);
        if (name && typeName) {
          receiverTypes.set(name, typeName);
        }
      }

      if (current.type === 'assignment_expression') {
        const target = current.namedChildren[0];
        const value = current.namedChildren[1];
        const targetKey = this.extractReceiverKey(target);
        if (targetKey && value?.type === 'identifier') {
          const valueType = receiverTypes.get(value.text);
          if (valueType) {
            receiverTypes.set(targetKey, valueType);
          }
        }
      }

      for (const child of current.namedChildren) {
        visit(child);
      }
    };

    for (const child of node.namedChildren) {
      visit(child);
    }

    return receiverTypes;
  }

  private extractInitializerReturnType(
    node: Parser.SyntaxNode,
    returnTypesByFunctionName: Map<string, string>,
  ): string | null {
    const callExpression = node.namedChildren.find((child) => child.type === 'call_expression');
    const callee = callExpression?.namedChildren[0];
    if (!callee || callee.type !== 'identifier') return null;
    return returnTypesByFunctionName.get(callee.text) ?? null;
  }

  private inferConstructorPropertyTypes(node: Parser.SyntaxNode): Array<{ propertyName: string; typeName: string }> {
    const parameterTypes = new Map(
      this.extractTypedParameters(node).map((parameter) => [parameter.name, parameter.typeName] as const),
    );
    const inferred: Array<{ propertyName: string; typeName: string }> = [];

    const visit = (current: Parser.SyntaxNode) => {
      if (current.type === 'assignment_expression') {
        const target = current.namedChildren[0];
        const value = current.namedChildren[1];
        const targetKey = this.extractReceiverKey(target);
        if (targetKey?.startsWith('this.') && value?.type === 'identifier') {
          const typeName = parameterTypes.get(value.text);
          if (typeName) {
            inferred.push({ propertyName: targetKey.slice('this.'.length), typeName });
          }
        }
      }
      for (const child of current.namedChildren) {
        visit(child);
      }
    };

    for (const child of node.namedChildren) {
      visit(child);
    }

    return inferred;
  }

  private extractTypedParameters(node: Parser.SyntaxNode): Array<{ name: string; typeName: string }> {
    const parameters = node.namedChildren.find((child) => child.type === 'formal_parameters');
    if (!parameters) return [];

    return parameters.namedChildren.flatMap((parameter) => {
      const name = parameter.namedChildren.find((child) => child.type === 'identifier')?.text;
      const typeName = this.extractDeclaredType(parameter);
      return name && typeName ? [{ name, typeName }] : [];
    });
  }

  private extractFirstTypeName(node: Parser.SyntaxNode): string | null {
    if (node.type === 'type_identifier' || node.type === 'identifier') {
      return node.text;
    }
    for (const child of node.namedChildren) {
      const name = this.extractFirstTypeName(child);
      if (name) return name;
    }
    return null;
  }

  private formatCallReason(callSite: CallSite): string | undefined {
    const details: string[] = [];
    if (callSite.receiverName) details.push(`receiver=${callSite.receiverName}`);
    if (callSite.receiverType) details.push(`receiverType=${callSite.receiverType}`);
    return details.length > 0 ? details.join(';') : undefined;
  }

  private collectPropertyAccesses(node: Parser.SyntaxNode): Array<{
    name: string;
    mode: 'read' | 'write';
  }> {
    const accesses: Array<{ name: string; mode: 'read' | 'write' }> = [];

    const extractThisProperty = (current: Parser.SyntaxNode): string | null => {
      if (current.type !== 'member_expression') return null;
      const object = current.namedChildren[0];
      const property = current.namedChildren[current.namedChildren.length - 1];
      if (object?.type !== 'this') return null;
      if (property?.type !== 'property_identifier' && property?.type !== 'identifier') return null;
      return property.text;
    };

    const visit = (current: Parser.SyntaxNode, writeTarget: Parser.SyntaxNode | null) => {
      if (current.type === 'assignment_expression') {
        const target = current.namedChildren[0] ?? null;
        for (const child of current.namedChildren) {
          visit(child, child === target ? target : null);
        }
        return;
      }

      const name = extractThisProperty(current);
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

  private pushMethodMatchRelations(input: {
    owner: ExtractedSymbol;
    targetOwner: ExtractedSymbol;
    relationType: 'METHOD_OVERRIDES' | 'METHOD_IMPLEMENTS';
    symbolsByParent: Map<string, ExtractedSymbol[]>;
    pushRelation: (relation: ExtractedRelation, unresolvedRef?: string) => void;
  }): void {
    const ownerMethods = (input.symbolsByParent.get(input.owner.id) ?? []).filter((symbol) => symbol.type === 'Method');
    const targetMethods = new Map(
      (input.symbolsByParent.get(input.targetOwner.id) ?? [])
        .filter((symbol) => symbol.type === 'Method')
        .map((symbol) => [symbol.name, symbol]),
    );

    for (const method of ownerMethods) {
      const target = targetMethods.get(method.name);
      if (!target) continue;
      input.pushRelation({
        fromId: method.id,
        toId: target.id,
        type: input.relationType,
        confidence: 0.9,
        reason: 'same-file:name-match',
      });
    }
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
    kind: 'import' | 'extends' | 'implements' | 'call',
    name: string,
    source?: string,
  ): string {
    const tail = source ? `${source}:${name}` : name;
    return `external:${language}:${filePath}:${kind}:${tail}`;
  }
}
