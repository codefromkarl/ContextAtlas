export interface CommandRegistration {
  option(name: string, description: string, config?: Record<string, unknown>): CommandRegistration;
  action(handler: (...args: any[]) => unknown): CommandRegistration;
}

export interface CommandRegistrar {
  command(name: string, description: string): CommandRegistration;
}
