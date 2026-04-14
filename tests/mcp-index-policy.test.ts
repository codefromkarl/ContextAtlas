import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getMcpIndexPolicy,
  parseBooleanFlag,
  resolveAutoIndexScope,
  shouldContinueQueryWithExistingIndexOnLockConflict,
} from '../src/application/retrieval/indexPolicy.ts';

test('parseBooleanFlag 支持常见真假值', () => {
  assert.equal(parseBooleanFlag(undefined, true), true);
  assert.equal(parseBooleanFlag('true', false), true);
  assert.equal(parseBooleanFlag('1', false), true);
  assert.equal(parseBooleanFlag('yes', false), true);
  assert.equal(parseBooleanFlag('false', true), false);
  assert.equal(parseBooleanFlag('0', true), false);
  assert.equal(parseBooleanFlag('off', true), false);
  assert.equal(parseBooleanFlag('unexpected', true), true);
});

test('getMcpIndexPolicy 默认开启自动索引并启用锁快速失败', () => {
  const policy = getMcpIndexPolicy({});
  assert.equal(policy.autoIndex, true);
  assert.equal(policy.failFastOnLock, true);
  assert.equal(policy.lockTimeoutMs, 10 * 60 * 1000);
});

test('getMcpIndexPolicy 支持通过环境变量关闭自动索引并自定义锁等待', () => {
  const policy = getMcpIndexPolicy({
    MCP_AUTO_INDEX: 'false',
    MCP_FAIL_FAST_ON_LOCK: '0',
    MCP_INDEX_LOCK_TIMEOUT_MS: '1234',
  });

  assert.equal(policy.autoIndex, false);
  assert.equal(policy.failFastOnLock, false);
  assert.equal(policy.lockTimeoutMs, 1234);
});

test('锁冲突时：已有索引则继续查询旧快照，无索引才返回 busy', () => {
  assert.equal(shouldContinueQueryWithExistingIndexOnLockConflict(true, true), true);
  assert.equal(shouldContinueQueryWithExistingIndexOnLockConflict(true, false), false);
  assert.equal(shouldContinueQueryWithExistingIndexOnLockConflict(false, true), false);
});

test('自动索引任务范围：有索引走 incremental，无索引走 full', () => {
  assert.equal(resolveAutoIndexScope(true), 'incremental');
  assert.equal(resolveAutoIndexScope(false), 'full');
});
