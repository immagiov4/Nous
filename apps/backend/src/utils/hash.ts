import crypto from 'node:crypto';

const SHA_256_ALGORITHM = 'sha256';
const HEX_DIGEST_ENCODING = 'hex';

export const buildSha256HexDigest = (data: Buffer | Uint8Array): string =>
  crypto.createHash(SHA_256_ALGORITHM).update(data).digest(HEX_DIGEST_ENCODING);
