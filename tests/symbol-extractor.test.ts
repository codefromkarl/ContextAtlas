import assert from 'node:assert/strict';
import test from 'node:test';
import { getParser } from '../src/chunking/index.ts';
import { SymbolExtractor } from '../src/graph/SymbolExtractor.ts';

test('SymbolExtractor extracts TS symbols and core relations', async () => {
  const parser = await getParser('typescript');
  assert.ok(parser);

  const code = `
import { hashPassword } from './crypto';

export interface PasswordPort {}

export class UserService extends BaseService implements PasswordPort {
  async updatePassword(input: string) {
    return hashLocal(hashPassword(input));
  }
}

function hashLocal(value: string) {
  return value.trim();
}
  `.trim();

  const payload = new SymbolExtractor().extract(
    parser.parse(code),
    code,
    'src/user/UserService.ts',
    'typescript',
  );

  const symbolNames = payload.symbols.map((symbol) => symbol.name).sort();
  assert.deepEqual(symbolNames, ['PasswordPort', 'UserService', 'hashLocal', 'updatePassword']);

  const userService = payload.symbols.find((symbol) => symbol.name === 'UserService');
  const updatePassword = payload.symbols.find((symbol) => symbol.name === 'updatePassword');
  const hashLocal = payload.symbols.find((symbol) => symbol.name === 'hashLocal');
  assert.ok(userService);
  assert.ok(updatePassword);
  assert.ok(hashLocal);
  assert.equal(updatePassword?.parentId, userService?.id);
  assert.deepEqual(updatePassword?.modifiers, ['async']);

  assert.ok(
    payload.relations.some(
      (relation) =>
        relation.type === 'HAS_METHOD'
        && relation.fromId === userService?.id
        && relation.toId === updatePassword?.id,
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) =>
        relation.type === 'EXTENDS'
        && relation.fromId === userService?.id
        && relation.toId.includes('extends:BaseService'),
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) =>
        relation.type === 'IMPLEMENTS'
        && relation.fromId === userService?.id
        && relation.toId.includes('implements:PasswordPort'),
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) =>
        relation.type === 'CALLS'
        && relation.fromId === updatePassword?.id
        && relation.toId === hashLocal?.id,
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) =>
        relation.type === 'CALLS'
        && relation.fromId === updatePassword?.id
        && relation.toId.includes('call:hashPassword'),
    ),
  );
  assert.ok(
    payload.invocations?.some(
      (invocation) =>
        invocation.enclosingSymbolId === updatePassword?.id
        && invocation.calleeName === 'hashPassword'
        && invocation.resolvedTargetId === null,
    ),
  );
  assert.ok(payload.unresolvedRefs?.includes('./crypto:hashPassword'));
});

test('SymbolExtractor extracts JS class and function symbols', async () => {
  const parser = await getParser('javascript');
  assert.ok(parser);

  const code = `
class UserService extends BaseService {
  updatePassword(input) {
    return hashPassword(input);
  }
}

function hashPassword(value) {
  return value;
}
  `.trim();

  const payload = new SymbolExtractor().extract(
    parser.parse(code),
    code,
    'src/user/UserService.js',
    'javascript',
  );

  assert.deepEqual(
    payload.symbols.map((symbol) => symbol.name).sort(),
    ['UserService', 'hashPassword', 'updatePassword'],
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'HAS_METHOD' && relation.toId.includes('updatePassword'),
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'CALLS' && relation.toId.includes('hashPassword'),
    ),
  );
  assert.ok(
    payload.invocations?.some(
      (invocation) => invocation.calleeName === 'hashPassword' && invocation.startLine >= 1,
    ),
  );
});
