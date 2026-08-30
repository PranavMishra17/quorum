import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { serverEnv } from '@/config';

/**
 * Envelope encryption for connector refresh tokens.
 *
 * A refresh token is a bearer credential for someone's entire mailbox, and it
 * sits in a database that gets backed up, replicated, and read by support
 * tooling. RLS defends against a *query*; it does nothing about any of those.
 * So the row is protected twice, by two controls with different failure modes.
 *
 * ---------------------------------------------------------------------------
 * AES-256-GCM, not AES-256-CBC
 *
 * GCM is authenticated: a modified ciphertext fails to decrypt rather than
 * decrypting to different bytes. That matters more than it might seem — without
 * it, an attacker with write access to the database could not read a token but
 * could still corrupt one into something that gets sent to Google, and the
 * failure would be silent.
 *
 * The nonce is 12 bytes from `randomBytes` and is stored alongside the
 * ciphertext. It is not a secret; it must simply never repeat under one key,
 * which random generation gives at this volume with room to spare.
 *
 * ---------------------------------------------------------------------------
 * THE KEY, AND WHAT HAPPENS WITHOUT ONE
 *
 * `CONNECTOR_ENCRYPTION_KEY` is 32 random bytes, base64. Without it the
 * connector is UNAVAILABLE — it does not fall back to storing the token in
 * plaintext. That fallback is the one everyone writes and nobody notices,
 * because everything keeps working; the only visible difference is that the
 * mailbox credentials are now readable in a backup.
 *
 * Rotation is not implemented, and pretending otherwise would be worse than
 * saying so: re-encrypting under a new key needs the old one, which means a
 * two-key window this schema has no column for. The honest v1 answer is that a
 * key change invalidates every stored token and users reconnect.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class ConnectorKeyMissingError extends Error {
  constructor() {
    super(
      'CONNECTOR_ENCRYPTION_KEY is not set, so external connectors are unavailable. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
    this.name = 'ConnectorKeyMissingError';
  }
}

/**
 * Whether connector encryption is configured.
 *
 * Read by the tool registry: a connector whose key is absent is NOT registered,
 * rather than registered-and-failing. A model retries a failing tool and burns
 * the per-turn budget; an absent capability it simply works around.
 */
export function connectorCryptoAvailable(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * Decode and validate a key.
 *
 * Exported and pure so the rules are testable WITHOUT a configured
 * environment. `serverEnv()` is a cached singleton over `process.env`, and a
 * cached singleton is effectively untestable — which is exactly how the blank
 * optional-key bug survived to production-like use earlier in this build. The
 * same mistake is not worth making twice on the module that holds mailbox
 * credentials.
 */
export function decodeKey(raw: string | undefined): Buffer {
  if (!raw) throw new ConnectorKeyMissingError();

  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    // A short key is the classic silent downgrade: it "works" while providing
    // far less than the algorithm's name implies.
    throw new Error(
      `CONNECTOR_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes, got ${key.length}`,
    );
  }
  return key;
}

function loadKey(): Buffer {
  return decodeKey(serverEnv().CONNECTOR_ENCRYPTION_KEY);
}

/** Encrypt under an explicit key. Returns base64 of nonce ‖ ciphertext ‖ tag. */
export function sealWithKey(key: Buffer, plaintext: string): string {
  if (plaintext.length === 0) throw new Error('refusing to seal an empty token');

  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64');
}

/**
 * Decrypt under an explicit key.
 *
 * Throws on any tampering, truncation, or wrong key — never returns partial or
 * best-effort plaintext. A caller that cannot decrypt should treat the
 * connection as broken and ask the user to reconnect.
 */
export function openWithKey(key: Buffer, sealed: string): string {
  const buf = Buffer.from(sealed, 'base64');

  if (buf.length <= NONCE_BYTES + TAG_BYTES) {
    throw new Error('stored connector token is malformed');
  }

  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const body = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** Encrypt a token under the configured key. */
export function sealToken(plaintext: string): string {
  return sealWithKey(loadKey(), plaintext);
}

/** Decrypt a token under the configured key. */
export function openToken(sealed: string): string {
  return openWithKey(loadKey(), sealed);
}
