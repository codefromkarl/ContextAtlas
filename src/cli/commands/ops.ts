import { registerOpsAlertCommands } from './opsAlerts.js';
import { registerOpsHealthCommands } from './opsHealth.js';
import { registerOpsUsageCommands } from './opsUsage.js';
import { registerOpsWorkbenchCommands } from './opsWorkbench.js';
import type { CommandRegistrar } from '../types.js';

export function registerOpsCommands(cli: CommandRegistrar): void {
  registerOpsUsageCommands(cli);
  registerOpsHealthCommands(cli);
  registerOpsAlertCommands(cli);
  registerOpsWorkbenchCommands(cli);
}
