import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  decodeKey,
  sealWithKey,
  openWithKey,
  ConnectorKeyMissingError,
} from '@/lib/connectors/crypto';

/**
 * Encryption of connector refresh tokens.
 *
 * A refresh token is a bearer credential for someone's entire mailbox — the
 * most dangerous single value this system holds. RLS keeps it out of a query;
 * this keeps it out of a backup, a replica, and a support engineer's console.
 * Two controls with different failure modes, which is the point of having both.
 */

const key = () => randomBytes(32);
const base64Key = () => randomBytes(32).toString('base64');

describe('the key', () => {
  it('accepts 32 bytes, base64', () => {
    expect(decodeKey(base64Key())).toHaveLength(32);
  });

  it('refuses a missing key rather than defaulting to something', () => {
    // The alternative — falling back to plaintext storage — is the one everyone
    // writes and nobody notices, because everything keeps working. The only
    // visible difference is that mailbox credentials become readable at rest.
    expect(() => decodeKey(undefined)).toThrow(ConnectorKeyMissingError);
    expect(() => decodeKey('')).toThrow(ConnectorKeyMissingError);
  });

  it('REFUSES a short key instead of silently downgrading', () => {
    // A 16-byte key "works" in the sense that nothing errors, while providing
    // far less than the algorithm's name implies.
    expect(() => decodeKey(randomBytes(16).toString('base64'))).toThrow(/exactly 32 bytes/);
  });

  it('refuses an over-long key too', () => {
    expect(() => decodeKey(randomBytes(64).toString('base64'))).toThrow(/exactly 32 bytes/);
  });
});

describe('sealing and opening', () => {
  it('round-trips a token', () => {
    const k = key();
    const token = '1//0gRefreshTokenLookingThing-abcdefg';
    expect(openWithKey(k, sealWithKey(k, token))).toBe(token);
  });

  it('round-trips non-ASCII without mangling it', () => {
    const k = key();
    const value = 'refresh–token–with–en–dashes–✓';
    expect(openWithKey(k, sealWithKey(k, value))).toBe(value);
  });

  it('produces different ciphertext each time, so equal tokens are not linkable', () => {
    // A deterministic scheme would let anyone with read access tell that two
    // rows hold the same credential without decrypting either.
    const k = key();
    expect(sealWithKey(k, 'same')).not.toBe(sealWithKey(k, 'same'));
  });

  it('refuses to seal an empty token', () => {
    expect(() => sealWithKey(key(), '')).toThrow(/empty/);
  });
});

/**
 * GCM is authenticated, and this is what that buys. Without it, someone with
 * write access to the database could not READ a token but could still corrupt
 * one into different bytes that then get sent to Google — and the failure
 * would be silent.
 */
describe('tampering is detected, not tolerated', () => {
  it('a flipped byte in the ciphertext fails to decrypt', () => {
    const k = key();
    const sealed = Buffer.from(sealWithKey(k, 'the-real-token'), 'base64');
    sealed[20] ^= 0xff;
    expect(() => openWithKey(k, sealed.toString('base64'))).toThrow();
  });

  it('a flipped byte in the auth tag fails to decrypt', () => {
    const k = key();
    const sealed = Buffer.from(sealWithKey(k, 'the-real-token'), 'base64');
    sealed[sealed.length - 1] ^= 0xff;
    expect(() => openWithKey(k, sealed.toString('base64'))).toThrow();
  });

  it('a different key fails rather than returning best-effort plaintext', () => {
    const sealed = sealWithKey(key(), 'the-real-token');
    expect(() => openWithKey(key(), sealed)).toThrow();
  });

  it('a truncated blob is rejected on its length, before any crypto runs', () => {
    expect(() => openWithKey(key(), Buffer.alloc(8).toString('base64'))).toThrow(/malformed/);
  });

  it('garbage is rejected', () => {
    expect(() => openWithKey(key(), 'not-base64-at-all!!!')).toThrow();
  });
});
