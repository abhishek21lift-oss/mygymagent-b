import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export function encryptWhatsAppToken(token: string, secret: string): string {
  if (!secret) throw new Error('WHATSAPP_ENCRYPTION_KEY is required');
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decryptWhatsAppToken(payload: string, secret: string): string {
  const [ivB64, tagB64, ciphertextB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !ciphertextB64) throw new Error('Invalid encrypted WhatsApp token');
  const key = createHash('sha256').update(secret).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64url')), decipher.final()]).toString('utf8');
}
