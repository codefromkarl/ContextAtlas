import { registerHubExploreCommands } from './hubExplore.js';
import { registerHubProjectCommands } from './hubProjects.js';
import { registerSharedMemoryCommands } from './hubShared.js';
import type { CommandRegistrar } from '../types.js';

export function registerHubCommands(cli: CommandRegistrar): void {
  registerHubProjectCommands(cli);
  registerSharedMemoryCommands(cli);
  registerHubExploreCommands(cli);
}
