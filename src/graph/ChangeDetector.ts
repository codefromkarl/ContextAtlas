import { spawnSync } from 'node:child_process';
import { closeDb, generateProjectId, initDb } from '../db/index.js';
import { resolveCurrentSnapshotId } from '../storage/layout.js';
import { GraphStore, type StoredSymbol } from './GraphStore.js';

export type ChangeDetectionScope = 'working_tree' | 'staged';

export interface ChangedSymbolMatch {
  filePath: string;
  changedLines: number[];
  symbols: StoredSymbol[];
}

export interface ChangeDetectionResult {
  scope: ChangeDetectionScope;
  changedFiles: string[];
  deletedFiles: string[];
  matches: ChangedSymbolMatch[];
}

interface ParsedDiff {
  changedLinesByFile: Map<string, number[]>;
  changedFiles: string[];
  deletedFiles: string[];
}

export class ChangeDetector {
  constructor(private readonly repoRoot: string) {}

  detect(scope: ChangeDetectionScope = 'working_tree'): ChangeDetectionResult {
    const parsed = this.parseDiff(scope);
    const projectId = generateProjectId(this.repoRoot);
    const snapshotId = resolveCurrentSnapshotId(projectId);
    const db = initDb(projectId, snapshotId);

    try {
      const store = new GraphStore(db);
      const matches: ChangedSymbolMatch[] = [];

      for (const [filePath, lines] of parsed.changedLinesByFile.entries()) {
        matches.push({
          filePath,
          changedLines: lines,
          symbols: store.findSymbolsByFileAndLines(filePath, lines),
        });
      }

      return {
        scope,
        changedFiles: parsed.changedFiles,
        deletedFiles: parsed.deletedFiles,
        matches,
      };
    } finally {
      closeDb(db);
    }
  }

  private parseDiff(scope: ChangeDetectionScope): ParsedDiff {
    const args = ['diff', '--no-color', '--unified=0'];
    if (scope === 'staged') {
      args.push('--cached');
    }

    const result = spawnSync('git', args, {
      cwd: this.repoRoot,
      encoding: 'utf8',
    });

    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `git diff failed with exit code ${result.status}`);
    }

    return parseUnifiedDiff(result.stdout);
  }
}

function parseUnifiedDiff(diffText: string): ParsedDiff {
  const changedLinesByFile = new Map<string, Set<number>>();
  const changedFiles = new Set<string>();
  const deletedFiles = new Set<string>();

  let currentFile: string | null = null;
  const lines = diffText.split('\n');

  for (const line of lines) {
    if (line.startsWith('+++ ')) {
      const rawPath = line.slice(4).trim();
      if (rawPath === '/dev/null') {
        currentFile = null;
        continue;
      }
      currentFile = normalizeDiffPath(rawPath);
      changedFiles.add(currentFile);
      if (!changedLinesByFile.has(currentFile)) {
        changedLinesByFile.set(currentFile, new Set());
      }
      continue;
    }

    if (line.startsWith('--- ')) {
      const rawPath = line.slice(4).trim();
      if (rawPath !== '/dev/null') {
        changedFiles.add(normalizeDiffPath(rawPath));
      }
      continue;
    }

    if (line.startsWith('deleted file mode ')) {
      if (currentFile) {
        deletedFiles.add(currentFile);
      }
      continue;
    }

    if (!currentFile || !line.startsWith('@@')) {
      continue;
    }

    const match = line.match(/^\@\@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? \@\@/);
    if (!match) continue;

    const startLine = Number(match[1]);
    const count = match[2] ? Number(match[2]) : 1;
    if (count === 0) {
      continue;
    }

    const fileLines = changedLinesByFile.get(currentFile);
    if (!fileLines) continue;

    for (let offset = 0; offset < count; offset++) {
      fileLines.add(startLine + offset);
    }
  }

  return {
    changedLinesByFile: new Map(
      Array.from(changedLinesByFile.entries()).map(([filePath, fileLines]) => [
        filePath,
        Array.from(fileLines).sort((a, b) => a - b),
      ]),
    ),
    changedFiles: Array.from(changedFiles).sort(),
    deletedFiles: Array.from(deletedFiles).sort(),
  };
}

function normalizeDiffPath(rawPath: string): string {
  return rawPath.replace(/^[ab]\//, '');
}
