import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuredSecret, GatewayError, requireBearer, SerialQueue } from '../src/common.js';
import { withTemp } from './oauth/helpers.js';
const fixtureKey = 'offline-fixture-service-key-never-a-user-secret';

test('missing credential is fail closed and admin/data bearer checks do not echo values', () => {
  assert.equal(configuredSecret({}, 'LLM_API_KEY'), undefined);
  assert.throws(() => requireBearer(undefined, undefined), (error: unknown) => error instanceof GatewayError && error.status === 503);
  assert.throws(() => requireBearer('Bearer PRIVATE_BAD_VALUE', fixtureKey), (error: unknown) => error instanceof GatewayError && error.status === 401 && !error.message.includes('PRIVATE_BAD_VALUE'));
  requireBearer(`Bearer ${fixtureKey}`, fixtureKey);
});
test('explicit credential files use safe descriptor and strict private permissions', async () => {
  await withTemp(async (directory) => {
    const path = join(directory, 'fixture.key');
    await writeFile(path, fixtureKey, { mode: 0o600 });
    assert.equal(configuredSecret({ LLM_API_KEY_FILE: path }, 'LLM_API_KEY'), fixtureKey);
    assert.throws(() => configuredSecret({ LLM_API_KEY_FILE: path, LLM_API_KEY: fixtureKey }, 'LLM_API_KEY'));
    await chmod(path, 0o644);
    assert.throws(() => configuredSecret({ LLM_API_KEY_FILE: path }, 'LLM_API_KEY'));
  });
});
test('credential file symlink is not followed', async () => {
  await withTemp(async (directory) => {
    const path = join(directory, 'fixture.key'); const link = join(directory, 'link.key');
    await writeFile(path, fixtureKey, { mode: 0o600 }); await symlink(path, link);
    assert.throws(() => configuredSecret({ LLM_API_KEY_FILE: link }, 'LLM_API_KEY'));
  });
});
test('queue is bounded, abort removes waiting entry, and future work still proceeds', async () => {
  const queue = new SerialQueue(1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = queue.run(async () => { await gate; return 1; });
  const controller = new AbortController();
  const second = queue.run(async () => 2, controller.signal);
  await assert.rejects(queue.run(async () => 3), (error: unknown) => error instanceof GatewayError && error.status === 429);
  controller.abort(); await assert.rejects(second);
  release(); assert.equal(await first, 1);
  assert.equal(await queue.run(async () => 4), 4);
});
