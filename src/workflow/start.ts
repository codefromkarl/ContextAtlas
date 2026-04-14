import path from 'node:path';
import { exposureMode } from '../config.js';
import { generateProjectId } from '../db/index.js';
import { getActiveTask } from '../indexing/queue.js';
import { hasIndexedData } from '../storage/layout.js';

export function shouldRunDefaultStart(cliArgs: string[], isMcpMode: boolean): boolean {
  return cliArgs.length === 0 && !isMcpMode;
}

export async function buildStartGuide(repoPath: string): Promise<string> {
  const resolvedRepoPath = path.resolve(repoPath);
  const projectId = generateProjectId(resolvedRepoPath);
  const hasIndex = hasIndexedData(projectId);
  const activeTask = getActiveTask(projectId);

  const status = hasIndex
    ? 'Ready'
    : activeTask
      ? 'Indexing'
      : 'Not Indexed';

  const introLines = [
    '## ContextAtlas Start',
    '',
    `- Repo: ${resolvedRepoPath}`,
    `- Project ID: ${projectId}`,
    `- Index Status: ${status}`,
    `- Exposure Mode: ${exposureMode}`,
  ];

  if (activeTask) {
    introLines.push(`- Active Task: ${activeTask.taskId} (${activeTask.status})`);
  }

  if (hasIndex) {
    introLines.push('- Current Mode: Full hybrid retrieval is ready');
  } else if (activeTask) {
    introLines.push('- Current Mode: Partial lexical answers are available while indexing runs');
  } else {
    introLines.push('- Current Mode: Partial lexical answers are available before first indexing');
  }

  const nextLines = hasIndex
    ? ['- Next Action: Ask directly with `contextatlas search`']
    : activeTask
      ? [
          '- Next Action: Keep daemon running with `contextatlas daemon start`',
          `- Queue View: \`contextatlas task:status --project-id ${projectId}\``,
          `- Task Detail: \`contextatlas task:inspect ${activeTask.taskId}\``,
          '- 完整模式会在索引完成后自动可用',
        ]
      : [
          `- Next Action: Start indexing with \`contextatlas index ${resolvedRepoPath}\``,
          '- 未完成索引前，`contextatlas search` 会返回部分词法结果',
        ];

  const flowLines = [
    '### Default Flow',
    '1. Connect Repo',
    `   \`contextatlas start ${resolvedRepoPath}\``,
    '2. Check Index Status',
    `   \`contextatlas health:check --project-id ${projectId}\``,
    '3. Ask',
    `   \`contextatlas search --repo-path ${resolvedRepoPath} --information-request "你的问题"\``,
    '4. Review Result',
    '   结果卡片会固定展示代码命中、模块记忆、决策记录和命中原因',
    '5. Give Feedback / Save Memory',
    '   `contextatlas feedback:record --outcome helpful --target-type code --query "你的问题"`',
  ];

  const resultCardPromiseLines = [
    '### Result Card Promise',
    '- 固定展示代码命中、模块记忆、决策记录和命中原因',
    '- 明确标注 Source、freshness、conflict 和 confidence',
    '- 冲突或过期记忆不会静默覆盖代码结果',
  ];

  const quickActionLines = [
    '### Quick Actions',
    `- Ask now: \`contextatlas search --repo-path ${resolvedRepoPath} --information-request "你的问题"\``,
    '- Mark result helpful: `contextatlas feedback:record --outcome helpful --target-type code --query "你的问题"`',
    '- Save a module memory: `contextatlas memory:record <module> --desc "<职责>" --dir "src/..."`',
    '- Save a decision: `contextatlas decision:record <id> --title "<标题>" --context "<背景>" --decision "<决策>" --rationale "<原因>"`',
    '- Save a reference: `contextatlas memory:record-long-term --type reference --title "<标题>" --summary "<摘要>"`',
    '- Save project state: `contextatlas memory:record-long-term --type project-state --title "<标题>" --summary "<当前状态>"`',
  ];

  const modeHintLines = exposureMode === 'cli-skill'
    ? [
        '### Mode: cli-skill',
        '当前使用 CLI + skills 接入模式。所有操作通过 `contextatlas` 命令完成。',
        '切换到 MCP 模式：`contextatlas setup:local --mode mcp`',
      ]
    : [
        '### Mode: mcp',
        '当前使用 MCP 接入模式。通过 MCP 客户端（Claude Desktop、Cursor 等）调用工具。',
        '在 MCP 客户端中使用 `find_memory`、`codebase-retrieval`、`record_memory` 等工具。',
        '切换到 CLI 模式：`contextatlas setup:local --mode cli-skill`',
      ];

  return [
    ...introLines,
    ...nextLines,
    '',
    ...modeHintLines,
    '',
    ...flowLines,
    '',
    ...resultCardPromiseLines,
    '',
    ...quickActionLines,
  ].join('\n');
}
