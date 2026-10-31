export const MAX_BYTES = 256 * 1024 * 1024;
export const MAX_FILES = 100;
export const CHUNK_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const toBase64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));
export function makeSecret() {
  return toBase64(crypto.getRandomValues(new Uint8Array(32))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export async function importSecret(secret) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('This link is missing its private key. Ask for the complete link, including everything after #.');
  return crypto.subtle.importKey('raw', fromBase64(secret.replaceAll('-', '+').replaceAll('_', '/') + '='), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(key, bytes, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, key, bytes));
  const packet = new Uint8Array(12 + cipher.length); packet.set(iv); packet.set(cipher, 12); return packet;
}
export async function decrypt(key, packet, context) {
  const data = new Uint8Array(packet);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12), additionalData: encoder.encode(context) }, key, data.slice(12)));
}
export const encodeJSON = value => encoder.encode(JSON.stringify(value));
export const decodeJSON = value => JSON.parse(decoder.decode(value));
export async function digest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
export function validateManifest(value, previous = []) {
  if (!Array.isArray(value) || value.length > MAX_FILES) throw new Error('This handoff contains too many files.');
  const seen = new Set(); let total = 0;
  for (const file of value) {
    if (!file || typeof file.id !== 'string' || !/^[a-f0-9-]{36}$/.test(file.id) || seen.has(file.id) || typeof file.name !== 'string' || !file.name || file.name.length > 512 || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('The sender provided an invalid file list.');
    seen.add(file.id); total += file.size;
  }
  if (total > MAX_BYTES) throw new Error('This prototype supports up to 256 MB per handoff.');
  for (const old of previous) {
    const next = value.find(file => file.id === old.id);
    if (!next || next.size !== old.size || next.name !== old.name || next.sha256 !== old.sha256) throw new Error('The sender changed an existing file during this handoff.');
  }
  return value;
}
