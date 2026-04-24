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
  const report = analyzeContracts(projectRoot, {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
  });
  const payload = filterContractReport(report, {
    action: args.action as ContractAnalysisAction,
    route: args.route,
    tool: args.tool,
  });

  if (args.format === 'json') {
    return createTextResponse(JSON.stringify(payload, null, 2));
  }

  return createTextResponse(formatContractAnalysis(payload));
}
