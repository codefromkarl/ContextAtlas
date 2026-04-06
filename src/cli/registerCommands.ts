import { registerBootstrapCommands } from './commands/bootstrap.js';
import { registerIndexingCommands } from './commands/indexing.js';
import { registerMemoryCommands } from './commands/memory.js';
import { registerHubCommands } from './commands/hub.js';
import { registerOpsCommands } from './commands/ops.js';
import { registerProfileCommands } from './commands/profile.js';
import { registerSearchCommands } from './commands/search.js';
import type { CommandRegistrar } from './types.js';

export function registerCliCommands(cli: CommandRegistrar): void {
  registerBootstrapCommands(cli);
  registerIndexingCommands(cli);
  registerSearchCommands(cli);
  registerMemoryCommands(cli);
  registerProfileCommands(cli);
  registerHubCommands(cli);
  registerOpsCommands(cli);
}
