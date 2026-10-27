import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * RankHub 令牌的静态加密（AES-256-GCM）。
 *
 * 密文格式：`v1.<ivB64url>.<tagB64url>.<ctB64url>`
 *
 * - 密钥：`Buffer.from(config.TOKEN_ENC_KEY, 'base64')`，必须 32 字节；
 * - 每条密文独立随机 12 字节 IV（GCM 的 96-bit nonce）；
 * - AAD = `${bindingId}:${field}` —— 把密文绑到「哪条 binding 的哪个字段」。
 *   这样把 A 用户的 refresh 密文抄到 B 用户行、或把 access 密文当 refresh 用，
 *   都会在解密时因 tag 校验失败而抛错，而不是静默串号；
 * - GCM tag 16 字节。
 *
 * 密钥不匹配 / 密文被篡改 / 格式不对都抛 `TokenCipherError`，绝不返回半截明文。
 */

export type TokenField = 'access_token' | 'refresh_token';

export const TOKEN_SEALED_PREFIX = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type TokenCipherErrorReason = 'invalid_key' | 'malformed' | 'auth_failed';

export class TokenCipherError extends Error {
  constructor(
    readonly reason: TokenCipherErrorReason,
    message: string,
  ) {
    super(message);
    this.name = 'TokenCipherError';
  }
}

export interface TokenCipher {
  /** 用随机 IV 加密并返回 `v1.<iv>.<tag>.<ct>`。 */
  encrypt(bindingId: string, field: TokenField, plaintext: string): string;
  /** 解密；任何失败都抛 `TokenCipherError`（不会回退成明文）。 */
  decrypt(bindingId: string, field: TokenField, sealed: string): string;
}

function decodeKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new TokenCipherError(
      'invalid_key',
      `TOKEN_ENC_KEY 必须是 32 字节的 base64（当前解出 ${key.length} 字节）`,
    );
  }
  return key;
}

function associatedData(bindingId: string, field: TokenField): Buffer {
  return Buffer.from(`${bindingId}:${field}`, 'utf8');
}

function decodePart(segment: string, expectedBytes: number, label: string): Buffer {
  const buf = Buffer.from(segment, 'base64url');
  if (buf.length !== expectedBytes) {
    throw new TokenCipherError(
      'malformed',
      `密文 ${label} 长度异常：期望 ${expectedBytes} 字节，实际 ${buf.length} 字节`,
    );
  }
  return buf;
}

/** 由 base64 密钥构造加解密器；密钥不合法时立刻抛错（fail fast，别等到运行期）。 */
export function createTokenCipher(base64Key: string): TokenCipher {
  const key = decodeKey(base64Key);
  return {
    encrypt(bindingId: string, field: TokenField, plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(associatedData(bindingId, field));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        TOKEN_SEALED_PREFIX,
        iv.toString('base64url'),
        tag.toString('base64url'),
        ciphertext.toString('base64url'),
      ].join('.');
    },
    decrypt(bindingId: string, field: TokenField, sealed: string): string {
      const parts = sealed.split('.');
      if (parts.length !== 4 || parts[0] !== TOKEN_SEALED_PREFIX) {
        throw new TokenCipherError('malformed', '密文格式不是 v1.<iv>.<tag>.<ct>');
      }
      const ivSegment = parts[1];
      const tagSegment = parts[2];
      const ciphertextSegment = parts[3];
      if (
        ivSegment === undefined ||
        tagSegment === undefined ||
        ciphertextSegment === undefined ||
        ivSegment === '' ||
        tagSegment === '' ||
        ciphertextSegment === ''
      ) {
        throw new TokenCipherError('malformed', '密文缺少 iv / tag / ciphertext 段');
      }
      const iv = decodePart(ivSegment, IV_BYTES, 'iv');
      const tag = decodePart(tagSegment, TAG_BYTES, 'tag');
      const ciphertext = Buffer.from(ciphertextSegment, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(associatedData(bindingId, field));
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        // GCM 认证失败 ⇒ 密钥不符、AAD 不符或密文被改。绝不回退成明文。
        throw new TokenCipherError('auth_failed', '令牌解密失败（密钥不匹配、AAD 不匹配或密文被篡改）');
      }
    },
  };
}
