/**
 * Git post-commit hook handler for automatic incremental indexing
 *
 * Usage in .git/hooks/post-commit:
 *   #!/bin/sh
 *   contextatlas hook post-commit
 *
 * Parses `git diff-tree --name-status -r HEAD` output to identify
 * changed code files, then triggers incremental re-indexing.
 */

import { logger } from '../utils/logger.js';

export interface ChangedFiles {
  added: string[];
  modified: string[];
  deleted: string[];
  renamed: Record<string, string>;
}

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.hpp',
  '.cs', '.rb', '.swift', '.kt', '.scala',
  '.vue', '.svelte', '.astro',
]);

const IGNORED_NAMES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'poetry.lock', 'Gemfile.lock', 'Cargo.lock', 'composer.lock',
]);

function isCodeFile(path: string): boolean {
  const filename = path.split('/').pop() || '';
  if (IGNORED_NAMES.has(filename)) return false;
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const ext = filename.slice(dotIndex).toLowerCase();
  return CODE_EXTENSIONS.has(ext);
}

/**
 * Extract changed file paths from `git diff --name-status` output
 *
 * Format: STATUS\\tPATH  or  STATUS\\tOLD_PATH\\tNEW_PATH (for renames)
 * Status codes: A (added), M (modified), D (deleted), R (renamed)
 */
export function extractChangedFilesFromDiff(diffOutput: string): ChangedFiles {
  const result: ChangedFiles = {
    added: [],
    modified: [],
    deleted: [],
    renamed: {},
  };

  for (const line of diffOutput.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Parse name-status format: STATUS\tPATH or STATUS\tOLD\tNEW
    const parts = trimmed.split('\t');
    const status = parts[0];

    if (!status || parts.length < 2) continue;

    switch (status[0]) {
      case 'A':
        if (isCodeFile(parts[1])) result.added.push(parts[1]);
        break;
      case 'M':
        if (isCodeFile(parts[1])) result.modified.push(parts[1]);
        break;
      case 'D':
        if (isCodeFile(parts[1])) result.deleted.push(parts[1]);
        break;
      case 'R': {
        const from = parts[1];
        const to = parts[2] || parts[1];
        if (isCodeFile(from) || isCodeFile(to)) {
          result.renamed[from] = to;
          if (isCodeFile(to)) {
            result.modified.push(to);
          }
        }
        break;
      }
    }
  }

  return result;
}

/**
 * Get git diff for the last commit
 */
export async function getLastCommitDiff(cwd?: string): Promise<string> {
  const { execSync } = await import('node:child_process');
  try {
    return execSync('git diff-tree --no-commit-id --name-status -r HEAD', {
      cwd: cwd || process.cwd(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    logger.warn({ error: err }, 'Failed to get git diff for last commit');
    return '';
  }
}

/**
 * Main entry point for post-commit hook
 *
 * Parses the last commit's diff and returns categorized file changes.
 * The caller is responsible for triggering re-indexing via the scanner.
 */
export async function getPostCommitChanges(cwd?: string): Promise<ChangedFiles> {
  const diff = await getLastCommitDiff(cwd);
  return extractChangedFilesFromDiff(diff);
}
