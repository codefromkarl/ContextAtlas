import { z } from 'zod';
import { MemoryStore } from '../../memory/MemoryStore.js';
import { responseFormatSchema } from './responseFormat.js';

const diaryScopeSchema = z.enum(['project', 'global-user']);

export const recordAgentDiarySchema = z.object({
  agent_name: z.string().describe('Agent name'),
  entry: z.string().describe('Diary entry content'),
  topic: z.string().optional().default('general').describe('Diary topic'),
  scope: diaryScopeSchema.optional().default('project').describe('Diary scope'),
  tags: z.array(z.string()).optional().default([]).describe('Diary tags'),
  provenance: z.array(z.string()).optional().default([]).describe('Optional provenance refs'),
  format: responseFormatSchema,
});

export const readAgentDiarySchema = z.object({
  agent_name: z.string().describe('Agent name'),
  last_n: z.number().int().min(1).max(100).optional().default(10).describe('How many recent entries to read'),
  topic: z.string().optional().describe('Optional topic filter'),
  scope: diaryScopeSchema.optional().default('project').describe('Diary scope'),
  format: responseFormatSchema,
});

export const findAgentDiarySchema = z.object({
  query: z.string().describe('Search query'),
  agent_name: z.string().optional().describe('Optional agent name filter'),
  topic: z.string().optional().describe('Optional topic filter'),
  scope: diaryScopeSchema.optional().default('project').describe('Diary scope'),
  limit: z.number().int().min(1).max(50).optional().default(10).describe('Maximum results'),
  format: responseFormatSchema,
});

export type RecordAgentDiaryInput = z.infer<typeof recordAgentDiarySchema>;
export type ReadAgentDiaryInput = z.infer<typeof readAgentDiarySchema>;
export type FindAgentDiaryInput = z.infer<typeof findAgentDiarySchema>;

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

export async function handleRecordAgentDiary(
  args: RecordAgentDiaryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const store = new MemoryStore(projectRoot);
  const { memory, action } = await store.appendLongTermMemoryItem({
    type: 'journal',
    title: buildDiaryTitle(args.agent_name, args.topic),
    summary: args.entry,
    tags: buildDiaryTags(args.agent_name, args.topic, args.tags),
    scope: args.scope,
    source: 'agent-inferred',
    confidence: 0.7,
    provenance: args.provenance,
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

export async function handleReadAgentDiary(
  args: ReadAgentDiaryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
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

export async function handleFindAgentDiary(
  args: FindAgentDiaryInput,
  projectRoot: string,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
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
