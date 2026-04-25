import { z } from 'zod';
import {
  analyzeContracts,
  filterContractReport,
  formatContractAnalysis,
  type ContractAnalysisAction,
} from '../../analysis/contractAnalysis.js';
import { TOOLS } from '../registry/tools.js';
import { createTextResponse } from '../response.js';
import { responseFormatSchema } from './responseFormat.js';

export const contractAnalysisSchema = z.object({
  action: z.enum(['route_map', 'api_impact', 'tool_map', 'tool_impact', 'contract_health']),
  route: z.string().optional(),
  tool: z.string().optional(),
  format: responseFormatSchema.optional().default('text'),
});

export type ContractAnalysisInput = z.infer<typeof contractAnalysisSchema>;

export async function handleContractAnalysis(
  args: ContractAnalysisInput,
  projectRoot: string,
) {
  let payload: unknown;

  try {
    const report = analyzeContracts(projectRoot, {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
    });
    payload = filterContractReport(report, {
      action: args.action as ContractAnalysisAction,
      route: args.route,
      tool: args.tool,
    });
  } catch (error) {
    payload = {
      action: args.action,
      health: {
        status: 'missing',
        routeCount: 0,
        routeConsumerCount: 0,
        toolCount: 0,
        mappedToolCount: 0,
        mismatchCount: 0,
        issues: [`analysis-error:${formatHandlerError(error)}`],
      },
    };
  }

  if (args.format === 'json') {
    return createTextResponse(JSON.stringify(payload, null, 2));
  }

  return createTextResponse(formatContractAnalysis(payload));
}

function formatHandlerError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(/\s+/g, ' ').slice(0, 180);
  }
  return String(error).replace(/\s+/g, ' ').slice(0, 180);
}
