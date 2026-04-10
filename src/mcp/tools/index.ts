/**
 * MCP 工具注册中心
 */

export {
  handleSessionEnd,
  handleSuggestMemory,
  sessionEndSchema,
  suggestMemorySchema,
} from './autoRecord.js';
export { codebaseRetrievalSchema, handleCodebaseRetrieval } from './codebaseRetrieval.js';
export {
  handleListMemoryCatalog,
  listMemoryCatalogSchema,
} from './listMemoryCatalog.js';
export {
  handleLoadModuleMemory,
  loadModuleMemorySchema,
} from './loadModuleMemory.js';
export {
  handleManageLongTermMemory,
  handleRecordLongTermMemory,
  manageLongTermMemorySchema,
  recordLongTermMemorySchema,
} from './longTermMemory.js';
export {
  findAgentDiarySchema,
  handleFindAgentDiary,
  handleReadAgentDiary,
  handleRecordAgentDiary,
  readAgentDiarySchema,
  recordAgentDiarySchema,
} from './agentDiary.js';
export {
  handleRecordResultFeedback,
  recordResultFeedbackSchema,
} from './feedbackLoop.js';
export {
  getDependencyChainSchema,
  handleGetDependencyChain,
  handleLinkMemories,
  handleManageProjects,
  handleQuerySharedMemories,
  linkMemoriesSchema,
  manageProjectsSchema,
  querySharedMemoriesSchema,
} from './memoryHub.js';
export {
  deleteMemorySchema,
  findMemorySchema,
  getProjectProfileSchema,
  handleDeleteMemory,
  handleFindMemory,
  handleGetProjectProfile,
  handleMaintainMemoryCatalog,
  handleRecordDecision,
  handleRecordMemory,
  maintainMemoryCatalogSchema,
  recordDecisionSchema,
  recordMemorySchema,
} from './projectMemory.js';

export {
  createCheckpointSchema,
  handleCreateCheckpoint,
  handleListCheckpoints,
  handleLoadCheckpoint,
  listCheckpointsSchema,
  loadCheckpointSchema,
} from './checkpoints.js';
export {
  assembleContextSchema,
  handleAssembleContext,
} from './assembleContext.js';
export {
  detectChangesSchema,
  graphContextSchema,
  graphImpactSchema,
  graphQuerySchema,
  handleDetectChanges,
  handleGraphContext,
  handleGraphImpact,
  handleGraphQuery,
} from './codeGraph.js';
export {
  handlePrepareHandoff,
  prepareHandoffSchema,
} from './prepareHandoff.js';
export {
  handleSuggestPhaseBoundary,
  suggestPhaseBoundarySchema,
} from './suggestPhaseBoundary.js';
