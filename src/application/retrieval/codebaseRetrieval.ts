import type { ToolTextResponse } from '../../mcp/response.js';

export interface ExecuteCodebaseRetrievalInput {
  repo_path: string;
  information_request: string;
  technical_terms?: string[];
}

export async function executeCodebaseRetrieval(
  input: ExecuteCodebaseRetrievalInput,
): Promise<ToolTextResponse> {
  const { handleCodebaseRetrieval } = await import('../../mcp/tools/codebaseRetrieval.js');
  return handleCodebaseRetrieval(input);
}
