import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Password hashing with Node's built-in scrypt.
//
// Why not bcryptjs: it hashes in JavaScript on the main thread, so every
// login blocks every other request: 3 logins a second, with a 2.5-second
// median, at cost 12 (docs/benchmarks). scrypt runs on libuv's thread pool,
// off the event loop, and needs no native dependency.
//
// Stored as: scrypt$<log2 N>$<r>$<p>$<salt base64>$<hash base64>, so the cost
// can be raised later and old hashes still verify.

const R = 8;
const P = 1;
const KEY_LEN = 32;

function derive(
  password: string,
  salt: Buffer,
  logN: number,
  r: number,
  p: number,
): Promise<Buffer> {
  const N = 2 ** logN;
  return new Promise((resolve, reject) =>
    scrypt(
      password,
      salt,
      KEY_LEN,
      { N, r, p, maxmem: 256 * N * r },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

export async function hashPassword(
  password: string,
  logN: number,
): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, logN, R, P);
  return [
    'scrypt',
    logN,
    R,
    P,
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, logN, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(
    password,
    Buffer.from(salt, 'base64'),
    Number(logN),
    Number(r),
    Number(p),
  );
  // Constant-time comparison: no early exit that leaks how much matched.
  return key.length === expected.length && timingSafeEqual(key, expected);
}
