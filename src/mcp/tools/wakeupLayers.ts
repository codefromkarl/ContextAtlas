/**
 * Re-export from application layer for backward compatibility.
 * Business logic has been moved to src/application/memory/wakeupLayers.ts
 */
export {
  buildWakeupLayers,
  formatWakeupLayersText,
  type WakeupLayersBundle,
} from '../../application/memory/wakeupLayers.js';
