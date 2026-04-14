/**
 * AgentDiary Application Layer
 *
 * CLI 和 MCP adapter 统一通过此入口调用 agent diary 业务逻辑。
 */

import { MemoryStore } from '../../memory/MemoryStore.js';
import type { ResponseFormat, MemoryToolResponse } from './memoryTypes.js';

// ===========================================
// Input 类型
// ===========================================

export interface RecordAgentDiaryInput {
  agent_name: string;
  entry: string;
  topic: string;
  scope: 'project' | 'global-user';
  tags: string[];
  provenance?: string[];
  format: ResponseFormat;
}

export interface ReadAgentDiaryInput {
  agent_name: string;
  last_n: number;
  topic?: string;
  scope: 'project' | 'global-user';
  format: ResponseFormat;
}

export interface FindAgentDiaryInput {
  query: string;
  agent_name?: string;
  topic?: string;
  scope: 'project' | 'global-user';
  limit: number;
  format: ResponseFormat;
}

// ===========================================
// Helpers
// ===========================================

function buildDiaryTitle(agentName: string, topic: string): string {
  return `${agentName} · ${topic}`;
}

function buildDiaryTags(agentName: string, topic: string, tags: string[]): string[] {
  return [...new Set(['agent-diary', `agent:${agentName}`, `topic:${topic}`, ...tags])];
}

function matchesTopic(tags: string[], topic?: string): boolean {
  if (!topic) return true;
  return tags.includes(`topic:${topic}`);
}

function matchesAgent(tags: string[], agentName?: string): boolean {
  if (!agentName) return true;
  return tags.includes(`agent:${agentName}`);
}

// ===========================================
// Handlers
// ===========================================

export async function executeRecordAgentDiary(
  args: RecordAgentDiaryInput,
  projectRoot: string,
): Promise<MemoryToolResponse> {
  const store = new MemoryStore(projectRoot);
  const { memory, action } = await store.appendLongTermMemoryItem({
    type: 'journal',
    title: buildDiaryTitle(args.agent_name, args.topic),
    summary: args.entry,
    tags: buildDiaryTags(args.agent_name, args.topic, args.tags),
    scope: args.scope,
    source: 'agent-inferred',
    confidence: 0.7,
    provenance: args.provenance ?? [],
  });

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { tool: 'record_agent_diary', write_action: action, memory },
            null,
            2,
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: `## Agent Diary Recorded\n\n- **Agent**: ${args.agent_name}\n- **Topic**: ${args.topic}\n- **ID**: ${memory.id}`,
      },
    ],
  };
}

export async function executeReadAgentDiary(
  args: ReadAgentDiaryInput,
  projectRoot: string,
): Promise<MemoryToolResponse> {
  const store = new MemoryStore(projectRoot);
  const results = (await store.listLongTermMemories({
    types: ['journal'],
    scope: args.scope,
    includeExpired: true,
  }))
    .filter((item) => matchesAgent(item.tags, args.agent_name))
    .filter((item) => matchesTopic(item.tags, args.topic))
    .slice(0, args.last_n);

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { tool: 'read_agent_diary', result_count: results.length, results },
            null,
            2,
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text:
          results.length === 0
            ? 'No diary entries found.'
            : `## Agent Diary\n\n${results.map((item) => `- ${item.title}: ${item.summary}`).join('\n')}`,
      },
    ],
  };
}

export async function executeFindAgentDiary(
  args: FindAgentDiaryInput,
  projectRoot: string,
): Promise<MemoryToolResponse> {
  const store = new MemoryStore(projectRoot);
  const results = (await store.findLongTermMemories(args.query, {
    types: ['journal'],
    scope: args.scope,
    limit: args.limit,
    includeExpired: true,
  }))
    .map((entry) => entry.memory)
    .filter((item) => matchesAgent(item.tags, args.agent_name))
    .filter((item) => matchesTopic(item.tags, args.topic))
    .slice(0, args.limit);

  if (args.format === 'json') {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { tool: 'find_agent_diary', result_count: results.length, results },
            null,
            2,
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text',
        text:
          results.length === 0
            ? `No diary entries found for "${args.query}".`
            : `## Agent Diary Matches\n\n${results.map((item) => `- ${item.title}: ${item.summary}`).join('\n')}`,
      },
    ],
  };
}
