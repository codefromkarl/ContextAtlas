import assert from 'node:assert/strict';
import test from 'node:test';

import { registerSearchCommands } from '../src/cli/commands/search.js';

class FakeCommand {
  readonly options: string[] = [];
  option(name: string): this {
    this.options.push(name);
    return this;
  }
  action(): this {
    return this;
  }
}

class FakeCli {
  readonly commands = new Map<string, FakeCommand>();
  command(name: string): FakeCommand {
    const command = new FakeCommand();
    this.commands.set(name, command);
    return command;
  }
}

test('benchmark:retrieval CLI 注册 JSON 与 fixture 选项', () => {
  const cli = new FakeCli();

  registerSearchCommands(cli as never);

  const command = cli.commands.get('benchmark:retrieval');
  assert.ok(command);
  assert.ok(command.options.includes('--json'));
  assert.ok(command.options.includes('--fixture <path>'));
  assert.ok(command.options.includes('--top-k <n>'));
});
