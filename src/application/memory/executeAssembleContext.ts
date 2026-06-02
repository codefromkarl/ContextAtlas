/**
 * AssembleContext Application Layer — 薄编排层
 *
 * CLI 和 MCP adapter 统一通过此入口调用上下文装配业务逻辑。
 * 策略执行委托给 assembleContextStrategy，格式化委托给 assembleContextFormatter。
 */

import type { AssembleContextPhase } from './assembleContextStrategy.js';
import type { AssemblyProfileName } from '../../memory/MemoryRouter.js';
import type { ResponseFormat, MemoryToolResponse } from './memoryTypes.js';
import { executeAssemblyStrategy } from './assembleContextStrategy.js';
import { buildAssembledPayload, formatAssembleContextText } from './assembleContextFormatter.js';

// ===========================================
// Input 类型
// ===========================================

export interface AssembleContextInput {
  repo_path: string;
  phase?: AssembleContextPhase;
  profile?: AssemblyProfileName;
  query?: string;
  moduleName?: string;
  filePaths?: string[];
  checkpoint_id?: string;
  includeDiary?: boolean;
  agentName?: string;
  diaryTopic?: string;
  diaryLimit?: number;
  format: ResponseFormat;
}

// ===========================================
// Handler
// ===========================================

export async function executeAssembleContext(
  args: AssembleContextInput,
): Promise<MemoryToolResponse> {
  const result = await executeAssemblyStrategy(args);

  if (result.isError || !result.data) {
    return {
      isError: true,
      content: [{ type: 'text', text: result.errorMessage ?? 'Assembly strategy failed' }],
    };
  }

  const payload = buildAssembledPayload(args, result.data);

  if (args.format === 'json') {
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  }

  return {
    content: [{ type: 'text', text: formatAssembleContextText(payload) }],
  };
}
