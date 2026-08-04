import { Injectable } from '@nestjs/common';
import { randomBytes, scrypt as scryptCallback, ScryptOptions, timingSafeEqual } from 'node:crypto';

/**
 * ALGORITHM: **scrypt** (N=16384, r=8, p=1, 64-byte key, 16-byte random salt) —
 * NOT Argon2id.
 *
 * This is stated bluntly because several places have claimed otherwise:
 * `docs/specifications/security/SECURITY_ENGINEERING_SPECIFICATION.md` §203
 * requires Argon2id, and the perf harness comments attribute login latency to
 * "argon2". The implemented and shipped algorithm is scrypt, and the stored
 * encoding is self-describing (`scrypt$N$r$p$salt$hash`), so nothing here is
 * ambiguous at rest.
 *
 * Why it has not been switched: every stored credential is a scrypt hash, and
 * `argon2` is not a dependency of this project (it is a native module). A
 * correct migration is verify-against-stored-algorithm plus rehash-on-successful
 * -login plus a forced reset for accounts that never log in again — a change
 * that must land complete or not at all. It is therefore recorded as an
 * OUTSTANDING DECISION (see project/SYSTEM_IMPROVEMENT_PROPOSALS.md item 20)
 * rather than half-done here.
 *
 * scrypt at N=16384 is itself a memory-hard, credible password KDF; the gap is a
 * compliance/claims gap, not a "passwords are weakly hashed" gap.
 */
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const KEY_LENGTH = 64;

function derive(
  password: string,
  salt: Buffer,
  length: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

@Injectable()
export class PasswordHasher {
  async hash(password: string): Promise<string> {
    if (password.length < 12) throw new Error('Password must contain at least 12 characters');
    const salt = randomBytes(16);
    const derived = await derive(password, salt, KEY_LENGTH, {
      N: COST,
      r: BLOCK_SIZE,
      p: PARALLELIZATION,
      maxmem: 64 * 1024 * 1024,
    });
    return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELIZATION}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }

  /**
   * Verify against the algorithm named in the stored encoding. Only `scrypt` is
   * recognised today; an unknown prefix returns false rather than throwing, so
   * introducing a second algorithm later is an additive change here plus a
   * rehash-on-login hook in AuthService.
   */
  async verify(password: string, encoded: string): Promise<boolean> {
    const [algorithm, cost, blockSize, parallelization, saltText, hashText] = encoded.split('$');
    if (algorithm !== 'scrypt' || !saltText || !hashText) return false;
    const expected = Buffer.from(hashText, 'base64url');
    if (expected.length !== KEY_LENGTH) return false;
    try {
      const actual = await derive(password, Buffer.from(saltText, 'base64url'), expected.length, {
        N: Number(cost),
        r: Number(blockSize),
        p: Number(parallelization),
        maxmem: 64 * 1024 * 1024,
      });
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }
}
