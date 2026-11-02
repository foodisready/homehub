import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { keepSecrets, withoutSecrets } from './secrets';

describe('device secrets', () => {
  it('removes passwords and keys, and lists which are saved', () => {
    assert.deepEqual(withoutSecrets({ gen: 1, auth: { user: 'admin', pass: 'pw' }, channel: 1 }),
      { config: { gen: 1, auth: { user: 'admin' }, channel: 1 }, savedSecrets: ['auth.pass'] });
    assert.deepEqual(withoutSecrets({ version: '3.3', deviceId: 'abc', key: 'k' }),
      { config: { version: '3.3', deviceId: 'abc' }, savedSecrets: ['key'] });
    assert.deepEqual(withoutSecrets({ channel: 0, uuid: 'u' }), { config: { channel: 0, uuid: 'u' }, savedSecrets: [] });
    assert.deepEqual(withoutSecrets(null), { config: null, savedSecrets: [] });
  });

  it('keeps a saved password when an edit leaves it out or blank', () => {
    const saved = { gen: 1, auth: { user: 'admin', pass: 'pw' } };
    assert.deepEqual(keepSecrets({ gen: 1, auth: { user: 'admin' } }, saved), saved);
    assert.deepEqual(keepSecrets({ gen: 1, auth: { user: 'new', pass: '' } }, saved), { gen: 1, auth: { user: 'new', pass: 'pw' } });
  });

  it('uses a new password when one is given', () => {
    assert.deepEqual(keepSecrets({ auth: { user: 'admin', pass: 'new' } }, { auth: { user: 'admin', pass: 'old' } }),
      { auth: { user: 'admin', pass: 'new' } });
  });

  it('removes the login when auth is removed', () => {
    assert.deepEqual(keepSecrets({ gen: 1 }, { gen: 1, auth: { user: 'admin', pass: 'pw' } }), { gen: 1 });
  });

  it('keeps a Tuya key', () => {
    assert.deepEqual(keepSecrets({ version: '3.4', deviceId: 'abc' }, { version: '3.3', deviceId: 'abc', key: 'k' }),
      { version: '3.4', deviceId: 'abc', key: 'k' });
  });
});
