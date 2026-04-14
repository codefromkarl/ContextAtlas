/**
 * Re-export from application layer for backward compatibility.
 * Business logic has been moved to src/application/retrieval/indexPolicy.ts
 */
export {
  getMcpIndexPolicy,
  resolveAutoIndexScope,
  parseBooleanFlag,
  shouldContinueQueryWithExistingIndexOnLockConflict,
  type McpIndexPolicy,
  type AutoIndexScope,
} from '../../application/retrieval/indexPolicy.js';
