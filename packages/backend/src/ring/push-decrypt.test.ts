/**
 * Ring's doorbell and motion alerts arrive as encrypted web pushes, read by
 * @eneris/push-receiver inside ring-client-api. Ring's crypto-key header now carries
 * a second value ("dh=…; p256ecdsa=…"); version 4.3.0 read that whole header as the
 * key, so every alert was dropped with ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY. package.json
 * overrides it to 4.4.0. This fails if a reinstall brings the old version back.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';

const receiverDir = path.dirname(require.resolve('@eneris/push-receiver/package.json'));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const decrypt = require(path.join(receiverDir, 'dist/utils/decrypt')).default as (o: unknown, k: unknown) => unknown;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ece = require(require.resolve('http_ece', { paths: [receiverDir] })) as {
  encrypt(data: Buffer, params: Record<string, unknown>): Buffer;
};

const b64url = (b: Buffer) => b.toString('base64url');

/** An alert encrypted for HomeHub's keys, with headers as Ring sends them. */
function ringPush(payload: object, cryptoKeyHeader: (dh: string) => string) {
  const receiver = crypto.createECDH('prime256v1');
  receiver.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const sender = crypto.createECDH('prime256v1');
  sender.generateKeys();
  const salt = crypto.randomBytes(16);
  const rawData = ece.encrypt(Buffer.from(JSON.stringify(payload)), {
    version: 'aesgcm',
    dh: b64url(receiver.getPublicKey()),
    privateKey: sender,
    salt: b64url(salt),
    authSecret: b64url(authSecret),
  });
  return {
    object: {
      rawData,
      appData: [
        { key: 'crypto-key', value: cryptoKeyHeader(b64url(sender.getPublicKey())) },
        { key: 'encryption', value: `salt=${b64url(salt)}` },
      ],
    },
    keys: { privateKey: receiver.getPrivateKey('base64'), authSecret: b64url(authSecret) },
  };
}

describe('Ring push alerts', () => {
  const alert = { data: { event: { ding: { id: '7', created_at: '2026-11-27T14:34:19Z' } } } };

  it('reads an alert whose crypto-key also names a signing key', () => {
    const { object, keys } = ringPush(alert, (dh) => `dh=${dh}; p256ecdsa=BPZ3kq2fH8sQzQ2C`);
    assert.deepEqual(decrypt(object, keys), alert);
  });

  it('still reads an alert with only the key', () => {
    const { object, keys } = ringPush(alert, (dh) => `dh=${dh}`);
    assert.deepEqual(decrypt(object, keys), alert);
  });
});
