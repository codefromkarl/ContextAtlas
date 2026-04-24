import assert from 'node:assert/strict';
import test from 'node:test';
import { getParser } from '../src/chunking/index.ts';
import { SymbolExtractor } from '../src/graph/SymbolExtractor.ts';
import type { SymbolExtractionProvider } from '../src/graph/providers/types.ts';

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
  const passwordPort = payload.symbols.find((symbol) => symbol.name === 'PasswordPort');
  const updatePassword = payload.symbols.find((symbol) => symbol.name === 'updatePassword');
  const hashLocal = payload.symbols.find((symbol) => symbol.name === 'hashLocal');
  assert.ok(userService);
  assert.ok(passwordPort);
  assert.ok(updatePassword);
  assert.ok(hashLocal);
  assert.match(userService.id, /^typescript:src\/user\/UserService\.ts:root:UserService:0:5:9$/);
  assert.match(updatePassword.id, /^typescript:src\/user\/UserService\.ts:UserService:updatePassword:1:6:8$/);
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
        && relation.toId === passwordPort?.id
        && relation.reason === 'same-file',
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

test('SymbolExtractor emits minimal override and implements method relations', async () => {
  const parser = await getParser('typescript');
  assert.ok(parser);

  const code = `
interface PasswordPort {
  updatePassword(input: string): string;
}

class BaseService {
  updatePassword(input: string) {
    return input;
  }
}

class UserService extends BaseService implements PasswordPort {
  updatePassword(input: string) {
    return input.trim();
  }
}
  `.trim();

  const payload = new SymbolExtractor().extract(
    parser.parse(code),
    code,
    'src/user/UserService.ts',
    'typescript',
  );

  const userService = payload.symbols.find((symbol) => symbol.name === 'UserService');
  const baseService = payload.symbols.find((symbol) => symbol.name === 'BaseService');
  const passwordPort = payload.symbols.find((symbol) => symbol.name === 'PasswordPort');
  const userUpdate = payload.symbols.find((symbol) => symbol.name === 'updatePassword' && symbol.parentId === userService?.id);
  const baseUpdate = payload.symbols.find((symbol) => symbol.name === 'updatePassword' && symbol.parentId === baseService?.id);
  const portUpdate = payload.symbols.find((symbol) => symbol.name === 'updatePassword' && symbol.parentId === passwordPort?.id);

  assert.ok(userService);
  assert.ok(baseService);
  assert.ok(passwordPort);
  assert.ok(userUpdate);
  assert.ok(baseUpdate);
  assert.ok(portUpdate);
  assert.ok(
    payload.relations.some(
      (relation) =>
        relation.type === 'EXTENDS'
        && relation.fromId === userService.id
        && relation.toId === baseService.id
        && relation.reason === 'same-file',
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) =>
        relation.type === 'METHOD_OVERRIDES'
        && relation.fromId === userUpdate.id
        && relation.toId === baseUpdate.id,
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) =>
        relation.type === 'METHOD_IMPLEMENTS'
        && relation.fromId === userUpdate.id
        && relation.toId === portUpdate.id,
    ),
  );
});

test('SymbolExtractor uses stable identity fields and extracts properties/accesses/import bindings', async () => {
  const parser = await getParser('typescript');
  assert.ok(parser);

  const code = `
import defaultHash, { hashPassword as hash, Salt } from './crypto';
import * as crypto from './crypto2';

export class UserService {
  private repo: UserRepo;
  token = 'x';

  updatePassword(input: string) {
    this.repo.save(input);
    const explicit: UserRepo = createRepo();
    const returned = createRepo();
    explicit.save(input);
    returned.save(input);
    const local = this.token;
    this.token = hash(input);
    return defaultHash(local, crypto.salt, Salt);
  }
}

function createRepo(): UserRepo {
  return new UserRepo();
}
  `.trim();

  const payload = new SymbolExtractor().extract(
    parser.parse(code),
    code,
    'src/user/UserService.ts',
    'typescript',
  );

  const userService = payload.symbols.find((symbol) => symbol.name === 'UserService');
  const updatePassword = payload.symbols.find((symbol) => symbol.name === 'updatePassword');
  const repo = payload.symbols.find((symbol) => symbol.name === 'repo');
  const token = payload.symbols.find((symbol) => symbol.name === 'token');
  assert.ok(userService);
  assert.ok(updatePassword);
  assert.ok(repo);
  assert.ok(token);
  assert.equal(repo.type, 'Variable');
  assert.equal(repo.parentId, userService.id);
  assert.match(repo.id, /^typescript:src\/user\/UserService\.ts:UserService:repo:0:5:5$/);
  assert.match(updatePassword.id, /^typescript:src\/user\/UserService\.ts:UserService:updatePassword:1:8:17$/);

  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'HAS_PROPERTY' && relation.fromId === userService.id && relation.toId === repo.id,
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'ACCESSES' && relation.fromId === updatePassword.id && relation.toId === repo.id && relation.reason === 'read:repo',
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'ACCESSES' && relation.fromId === updatePassword.id && relation.toId === token.id && relation.reason === 'read:token',
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'ACCESSES' && relation.fromId === updatePassword.id && relation.toId === token.id && relation.reason === 'write:token',
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) =>
        relation.type === 'CALLS'
        && relation.fromId === updatePassword.id
        && relation.toId.endsWith(':call:save')
        && relation.reason?.includes('receiver=this.repo')
        && relation.reason?.includes('receiverType=UserRepo')
        && relation.confidence === 0.75,
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) =>
        relation.type === 'CALLS'
        && relation.fromId === updatePassword.id
        && relation.toId.endsWith(':call:save')
        && relation.reason?.includes('receiver=explicit')
        && relation.reason?.includes('receiverType=UserRepo'),
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) =>
        relation.type === 'CALLS'
        && relation.fromId === updatePassword.id
        && relation.toId.endsWith(':call:save')
        && relation.reason?.includes('receiver=returned')
        && relation.reason?.includes('receiverType=UserRepo'),
    ),
  );
  assert.ok(payload.unresolvedRefs?.includes('./crypto:defaultHash'));
  assert.ok(payload.unresolvedRefs?.includes('./crypto:hash'));
  assert.ok(payload.unresolvedRefs?.includes('./crypto:Salt'));
  assert.ok(payload.unresolvedRefs?.includes('./crypto2:crypto'));
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

test('SymbolExtractor extracts Python symbols, imports, calls, and accesses', async () => {
  const parser = await getParser('python');
  assert.ok(parser);

  const code = `
import os
from crypto import hash_password as hash_password_alias, Salt

class UserService(BaseService):
    repo = None

    def __init__(self, repo):
        self.repo = repo

    def update_password(self, input):
        self.repo.save(input)
        local = self.repo
        return hash_local(hash_password_alias(input))

def hash_local(value):
    return value.strip()
  `.trim();

  const payload = new SymbolExtractor().extract(
    parser.parse(code),
    code,
    'src/user/user_service.py',
    'python',
  );

  const userService = payload.symbols.find((symbol) => symbol.name === 'UserService');
  const updatePassword = payload.symbols.find((symbol) => symbol.name === 'update_password');
  const repo = payload.symbols.find((symbol) => symbol.name === 'repo');
  const hashLocal = payload.symbols.find((symbol) => symbol.name === 'hash_local');
  assert.ok(userService);
  assert.ok(updatePassword);
  assert.ok(repo);
  assert.ok(hashLocal);
  assert.equal(updatePassword.type, 'Method');
  assert.equal(repo.type, 'Variable');
  assert.equal(updatePassword.parentId, userService.id);
  assert.match(updatePassword.id, /^python:src\/user\/user_service\.py:UserService:update_password:1:10:13$/);

  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'HAS_METHOD' && relation.fromId === userService.id && relation.toId === updatePassword.id,
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'HAS_PROPERTY' && relation.fromId === userService.id && relation.toId === repo.id,
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'EXTENDS' && relation.fromId === userService.id && relation.toId.includes('extends:BaseService'),
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'ACCESSES' && relation.fromId === updatePassword.id && relation.toId === repo.id && relation.reason === 'read:repo',
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'CALLS' && relation.fromId === updatePassword.id && relation.toId === hashLocal.id,
    ),
  );
  assert.ok(payload.unresolvedRefs?.includes('crypto:hash_password_alias'));
  assert.ok(payload.unresolvedRefs?.includes('crypto:Salt'));
  assert.ok(payload.unresolvedRefs?.includes('os:os'));
});

test('SymbolExtractor extracts Go symbols, imports, calls, and accesses', async () => {
  const parser = await getParser('go');
  assert.ok(parser);

  const code = `
package user

import (
  "strings"
  crypto "app/crypto"
)

type UserService struct {
  Repo UserRepo
  token string
}

func (s *UserService) UpdatePassword(input string) string {
  s.Repo.Save(input)
  s.token = crypto.Hash(input)
  return hashLocal(strings.TrimSpace(input))
}

func hashLocal(value string) string {
  return value
}
  `.trim();

  const payload = new SymbolExtractor().extract(
    parser.parse(code),
    code,
    'src/user/user_service.go',
    'go',
  );

  const userService = payload.symbols.find((symbol) => symbol.name === 'UserService');
  const updatePassword = payload.symbols.find((symbol) => symbol.name === 'UpdatePassword');
  const repo = payload.symbols.find((symbol) => symbol.name === 'Repo');
  const token = payload.symbols.find((symbol) => symbol.name === 'token');
  const hashLocal = payload.symbols.find((symbol) => symbol.name === 'hashLocal');
  assert.ok(userService);
  assert.ok(updatePassword);
  assert.ok(repo);
  assert.ok(token);
  assert.ok(hashLocal);
  assert.equal(updatePassword.type, 'Method');
  assert.equal(updatePassword.parentId, userService.id);
  assert.match(updatePassword.id, /^go:src\/user\/user_service\.go:UserService:UpdatePassword:1:13:17$/);

  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'HAS_METHOD' && relation.fromId === userService.id && relation.toId === updatePassword.id,
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'HAS_PROPERTY' && relation.fromId === userService.id && relation.toId === repo.id,
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'ACCESSES' && relation.fromId === updatePassword.id && relation.toId === repo.id && relation.reason === 'read:Repo',
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'ACCESSES' && relation.fromId === updatePassword.id && relation.toId === token.id && relation.reason === 'write:token',
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'CALLS' && relation.fromId === updatePassword.id && relation.toId === hashLocal.id,
    ),
  );
  assert.ok(payload.unresolvedRefs?.includes('strings:strings'));
  assert.ok(payload.unresolvedRefs?.includes('app/crypto:crypto'));
});

test('SymbolExtractor extracts Java symbols, imports, calls, and accesses', async () => {
  const parser = await getParser('java');
  assert.ok(parser);

  const code = `
package user;
import app.crypto.Hash;

class UserService extends BaseService implements PasswordPort {
  private UserRepo repo;
  String token;

  void updatePassword(String input) {
    this.repo.save(input);
    this.token = Hash.hash(input);
    hashLocal(input);
  }

  String hashLocal(String value) { return value.trim(); }
}
  `.trim();

  const payload = new SymbolExtractor().extract(
    parser.parse(code),
    code,
    'src/user/UserService.java',
    'java',
  );

  const userService = payload.symbols.find((symbol) => symbol.name === 'UserService');
  const updatePassword = payload.symbols.find((symbol) => symbol.name === 'updatePassword');
  const repo = payload.symbols.find((symbol) => symbol.name === 'repo');
  const token = payload.symbols.find((symbol) => symbol.name === 'token');
  const hashLocal = payload.symbols.find((symbol) => symbol.name === 'hashLocal');
  assert.ok(userService);
  assert.ok(updatePassword);
  assert.ok(repo);
  assert.ok(token);
  assert.ok(hashLocal);
  assert.equal(updatePassword.type, 'Method');
  assert.equal(updatePassword.parentId, userService.id);
  assert.match(updatePassword.id, /^java:src\/user\/UserService\.java:UserService:updatePassword:1:8:12$/);

  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'HAS_METHOD' && relation.fromId === userService.id && relation.toId === updatePassword.id,
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'HAS_PROPERTY' && relation.fromId === userService.id && relation.toId === repo.id,
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'EXTENDS' && relation.fromId === userService.id && relation.toId.includes('extends:BaseService'),
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'IMPLEMENTS' && relation.fromId === userService.id && relation.toId.includes('implements:PasswordPort'),
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'ACCESSES' && relation.fromId === updatePassword.id && relation.toId === repo.id && relation.reason === 'read:repo',
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'ACCESSES' && relation.fromId === updatePassword.id && relation.toId === token.id && relation.reason === 'write:token',
    ),
  );
  assert.ok(
    payload.relations.some(
      (relation) => relation.type === 'CALLS' && relation.fromId === updatePassword.id && relation.toId === hashLocal.id,
    ),
  );
  assert.ok(payload.unresolvedRefs?.includes('app.crypto.Hash:Hash'));
});

test('SymbolExtractor returns the legacy empty payload for unsupported languages', async () => {
  const parser = await getParser('typescript');
  assert.ok(parser);

  const payload = new SymbolExtractor().extract(
    parser.parse('function ignored() {}'),
    'function ignored() {}',
    'src/ignored.rb',
    'ruby',
  );

  assert.deepEqual(payload, { symbols: [], relations: [], unresolvedRefs: [] });
});

test('SymbolExtractor rejects duplicate provider language registrations', () => {
  const provider: SymbolExtractionProvider = {
    languages: ['typescript'],
    extract: () => ({ symbols: [], relations: [], unresolvedRefs: [] }),
  };

  assert.throws(
    () => new SymbolExtractor([provider, provider]),
    /Duplicate symbol extraction provider/,
  );
});
