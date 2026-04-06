import { registerMemoryCatalogCommands } from './memoryCatalog.js';
import { registerMemoryFeatureCommands } from './memoryFeatures.js';
import { registerMemoryKnowledgeCommands } from './memoryKnowledge.js';
import type { CommandRegistrar } from '../types.js';

export function registerMemoryCommands(cli: CommandRegistrar): void {
  registerMemoryFeatureCommands(cli);
  registerMemoryCatalogCommands(cli);
  registerMemoryKnowledgeCommands(cli);
}
