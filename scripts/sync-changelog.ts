#!/usr/bin/env node
/**
 * sync-changelog.ts — Single source of truth for changelog entries.
 *
 * Reads YAML frontmatter from docs/changelog/YYYY-MM-DD.md files and
 * auto-generates the changelog sections in README.md, README_ZH.md,
 * and docs/README.md.
 *
 * Usage: node --import tsx scripts/sync-changelog.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChangelogEntry {
  date: string;
  summaryEn: string;
  summaryZh: string;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = path.resolve(import.meta.dirname, "..");
const CHANGELOG_DIR = path.join(ROOT, "docs", "changelog");

const TARGETS = [
  {
    file: path.join(ROOT, "README.md"),
    tagStart: "<!-- AUTO:changelog-en-start -->",
    tagEnd: "<!-- AUTO:changelog-en-end -->",
    build: (entries: ChangelogEntry[]) =>
      entries
        .map((e) => `- \`${e.date}\`: ${e.summaryEn}`)
        .join("\n"),
  },
  {
    file: path.join(ROOT, "README_ZH.md"),
    tagStart: "<!-- AUTO:changelog-zh-start -->",
    tagEnd: "<!-- AUTO:changelog-zh-end -->",
    build: (entries: ChangelogEntry[]) =>
      entries
        .map((e) => `- \`${e.date}\`：${e.summaryZh}`)
        .join("\n"),
  },
  {
    file: path.join(ROOT, "docs", "README.md"),
    tagStart: "<!-- AUTO:changelog-index-start -->",
    tagEnd: "<!-- AUTO:changelog-index-end -->",
    build: (entries: ChangelogEntry[]) =>
      entries
        .map((e) => `- [${e.date}](./changelog/${e.date}.md)`)
        .join("\n"),
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple regex-based YAML frontmatter parser (no external deps). */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const body = match[1];
  const result: Record<string, string> = {};
  for (const line of body.split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*"(.*)"/);
    if (kv) {
      result[kv[1]] = kv[2];
      continue;
    }
    // Handle unquoted values
    const kv2 = line.match(/^(\w+):\s*(.+)/);
    if (kv2) {
      result[kv2[1]] = kv2[2].trim();
    }
  }
  return result;
}

/** Collect and validate changelog entries from docs/changelog/*.md. */
function collectEntries(): ChangelogEntry[] {
  const files = fs
    .readdirSync(CHANGELOG_DIR)
    .filter((f) => /^20\d{2}-\d{2}-\d{2}\.md$/.test(f))
    .sort()
    .reverse(); // descending by date

  const entries: ChangelogEntry[] = [];

  for (const file of files) {
    const filePath = path.join(CHANGELOG_DIR, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const fm = parseFrontmatter(content);

    if (!fm.date || !fm.summary_en || !fm.summary_zh) {
      console.error(
        `ERROR: ${file} is missing required frontmatter fields (date, summary_en, summary_zh). Found: ${JSON.stringify(fm)}`,
      );
      process.exit(1);
    }

    entries.push({
      date: fm.date,
      summaryEn: fm.summary_en,
      summaryZh: fm.summary_zh,
    });
  }

  return entries;
}

/** Replace content between marker comments in a file. */
function syncTarget(
  filePath: string,
  tagStart: string,
  tagEnd: string,
  generated: string,
): boolean {
  const content = fs.readFileSync(filePath, "utf-8");

  const startIdx = content.indexOf(tagStart);
  const endIdx = content.indexOf(tagEnd);

  if (startIdx === -1 || endIdx === -1) {
    console.error(
      `ERROR: ${path.relative(ROOT, filePath)} is missing marker comments (${tagStart} / ${tagEnd}).`,
    );
    process.exit(1);
  }

  const newContent =
    content.slice(0, startIdx + tagStart.length) +
    "\n" +
    generated +
    "\n" +
    content.slice(endIdx);

  if (newContent === content) {
    console.log(`  ✓ ${path.relative(ROOT, filePath)} (no changes)`);
    return false;
  }

  fs.writeFileSync(filePath, newContent, "utf-8");
  console.log(`  ✓ ${path.relative(ROOT, filePath)} (updated)`);
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  console.log("Syncing changelog entries...\n");

  const entries = collectEntries();
  console.log(`  Found ${entries.length} changelog entries.\n`);

  let changed = 0;
  for (const target of TARGETS) {
    const generated = target.build(entries);
    if (syncTarget(target.file, target.tagStart, target.tagEnd, generated)) {
      changed++;
    }
  }

  console.log(`\nDone. ${changed} file(s) updated.`);
}

main();
