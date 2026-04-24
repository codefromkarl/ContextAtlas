import type Parser from '@keqingmoe/tree-sitter';
import { GoSymbolProvider } from './providers/goSymbolProvider.js';
import { JavaSymbolProvider } from './providers/javaSymbolProvider.js';
import { PythonSymbolProvider } from './providers/pythonSymbolProvider.js';
import { TsJsSymbolProvider } from './providers/tsJsSymbolProvider.js';
import type { SymbolExtractionProvider } from './providers/types.js';
import type { GraphWritePayload } from './types.js';

function emptyGraphPayload(): GraphWritePayload {
  return { symbols: [], relations: [], unresolvedRefs: [] };
}

function assertUniqueProviderLanguages(providers: readonly SymbolExtractionProvider[]): void {
  const seen = new Map<string, string>();
  for (const provider of providers) {
    for (const language of provider.languages) {
      const previous = seen.get(language);
      if (previous) {
        throw new Error(`Duplicate symbol extraction provider for language "${language}": ${previous}, ${provider.constructor.name}`);
      }
      seen.set(language, provider.constructor.name);
    }
  }
}

export class SymbolExtractor {
  private readonly providers: readonly SymbolExtractionProvider[];

  constructor(providers: readonly SymbolExtractionProvider[] = [
    new TsJsSymbolProvider(),
    new PythonSymbolProvider(),
    new GoSymbolProvider(),
    new JavaSymbolProvider(),
  ]) {
    assertUniqueProviderLanguages(providers);
    this.providers = providers;
  }

  extract(
    tree: Parser.Tree,
    code: string,
    filePath: string,
    language: string,
  ): GraphWritePayload {
    const provider = this.providers.find((candidate) => candidate.languages.includes(language));
    if (!provider) {
      return emptyGraphPayload();
    }

    return provider.extract({ tree, code, filePath, language });
  }
}
