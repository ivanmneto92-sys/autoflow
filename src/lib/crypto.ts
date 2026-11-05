import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** AES-256-GCM. Formato: base64(iv).base64(tag).base64(ciphertext) */
export function encrypt(plain: string, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY precisa ter 32 bytes (base64)');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload: string, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64');
  const [ivB, tagB, encB] = payload.split('.');
  if (!ivB || !tagB || !encB) throw new Error('Payload criptografado inválido');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf8');
}

export function hmacSha256Hex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Token assinado e com expiração (usado no `state` do OAuth). */
export function signState(data: Record<string, unknown>, secret: string, ttlSec = 600): string {
  const body = Buffer.from(
    JSON.stringify({ ...data, exp: Math.floor(Date.now() / 1000) + ttlSec, n: randomBytes(8).toString('hex') }),
  ).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function verifyState<T = Record<string, unknown>>(token: string, secret: string): T | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp: number };
  if (data.exp < Math.floor(Date.now() / 1000)) return null;
  return data;
}
