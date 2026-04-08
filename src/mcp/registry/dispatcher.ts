import type { ToolTextResponse } from '../response.js';
import {
  assembleContextSchema,
  codebaseRetrievalSchema,
  createCheckpointSchema,
  deleteMemorySchema,
  handleAssembleContext,
  handleCreateCheckpoint,
  handleListCheckpoints,
  handleLoadCheckpoint,
  handlePrepareHandoff,
  findMemorySchema,
  getDependencyChainSchema,
  getProjectProfileSchema,
  handleCodebaseRetrieval,
  handleDeleteMemory,
  handleFindMemory,
  handleGetDependencyChain,
  handleGetProjectProfile,
  handleLinkMemories,
  handleListMemoryCatalog,
  handleLoadModuleMemory,
  handleMaintainMemoryCatalog,
  handleManageLongTermMemory,
  handleManageProjects,
  handleQuerySharedMemories,
  handleRecordDecision,
  handleRecordLongTermMemory,
  handleRecordMemory,
  handleRecordResultFeedback,
  handleSessionEnd,
  handleSuggestMemory,
  linkMemoriesSchema,
  listCheckpointsSchema,
  listMemoryCatalogSchema,
  loadCheckpointSchema,
  loadModuleMemorySchema,
  maintainMemoryCatalogSchema,
  manageLongTermMemorySchema,
  manageProjectsSchema,
  querySharedMemoriesSchema,
  recordDecisionSchema,
  recordLongTermMemorySchema,
  recordMemorySchema,
  recordResultFeedbackSchema,
  sessionEndSchema,
  suggestPhaseBoundarySchema,
  suggestMemorySchema,
  prepareHandoffSchema,
  handleSuggestPhaseBoundary,
} from '../tools/index.js';

export type DispatcherProgressCallback = (
  current: number,
  total?: number,
  message?: string,
) => void | Promise<void>;

export function createToolDispatcher(cwd: string) {
  return async (
    name: string,
    args: unknown,
    onProgress?: DispatcherProgressCallback,
  ): Promise<ToolTextResponse> => {
    switch (name) {
      case 'codebase-retrieval':
        return handleCodebaseRetrieval(codebaseRetrievalSchema.parse(args), onProgress);
      case 'create_checkpoint':
        return handleCreateCheckpoint(createCheckpointSchema.parse(args));
      case 'load_checkpoint':
        return handleLoadCheckpoint(loadCheckpointSchema.parse(args));
      case 'list_checkpoints':
        return handleListCheckpoints(listCheckpointsSchema.parse(args));
      case 'prepare_handoff':
        return handlePrepareHandoff(prepareHandoffSchema.parse(args));
      case 'assemble_context':
        return handleAssembleContext(assembleContextSchema.parse(args));
      case 'suggest_phase_boundary':
        return handleSuggestPhaseBoundary(suggestPhaseBoundarySchema.parse(args));
      case 'find_memory':
        return handleFindMemory(findMemorySchema.parse(args), cwd);
      case 'record_memory':
        return handleRecordMemory(recordMemorySchema.parse(args), cwd);
      case 'record_decision':
        return handleRecordDecision(recordDecisionSchema.parse(args), cwd);
      case 'record_long_term_memory':
        return handleRecordLongTermMemory(recordLongTermMemorySchema.parse(args), cwd);
      case 'record_result_feedback':
        return handleRecordResultFeedback(recordResultFeedbackSchema.parse(args), cwd);
      case 'manage_long_term_memory':
        return handleManageLongTermMemory(manageLongTermMemorySchema.parse(args), cwd);
      case 'get_project_profile':
        return handleGetProjectProfile(getProjectProfileSchema.parse(args), cwd);
      case 'delete_memory':
        return handleDeleteMemory(deleteMemorySchema.parse(args), cwd);
      case 'maintain_memory_catalog':
        return handleMaintainMemoryCatalog(maintainMemoryCatalogSchema.parse(args), cwd);
      case 'load_module_memory':
        return handleLoadModuleMemory(loadModuleMemorySchema.parse(args), cwd);
      case 'list_memory_catalog':
        return handleListMemoryCatalog(listMemoryCatalogSchema.parse(args), cwd);
      case 'query_shared_memories':
        return handleQuerySharedMemories(querySharedMemoriesSchema.parse(args));
      case 'link_memories':
        return handleLinkMemories(linkMemoriesSchema.parse(args));
      case 'get_dependency_chain':
        return handleGetDependencyChain(getDependencyChainSchema.parse(args));
      case 'manage_projects':
        return handleManageProjects(manageProjectsSchema.parse(args));
      case 'session_end':
        return handleSessionEnd(sessionEndSchema.parse(args));
      case 'suggest_memory':
        return handleSuggestMemory(suggestMemorySchema.parse(args));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}
