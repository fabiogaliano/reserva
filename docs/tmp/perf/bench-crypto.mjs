// Rough cost of the per-request crypto the admin does in production: token key import + AES-GCM
// decrypts, CSRF HMAC, and the Access RS256 verify with a JWK import.
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
const enc = new TextEncoder();
async function run(label, fn) {
  let t = cpu(); await fn(); const first = cpu() - t;
  t = cpu(); for (let i = 0; i < 10; i++) await fn(); console.log(`${label.padEnd(40)} first ${first.toFixed(2)} ms  warm ${((cpu() - t) / 10).toFixed(2)} ms`);
}
const digest = await crypto.subtle.digest('SHA-256', enc.encode('x'.repeat(48)));
const aes = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
const blobs = await Promise.all(Array.from({ length: 100 }, async () => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, ct: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, enc.encode('t'.repeat(43))) };
}));
await run('token key import (digest+importKey)', async () => {
  const d = await crypto.subtle.digest('SHA-256', enc.encode('x'.repeat(48)));
  await crypto.subtle.importKey('raw', d, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
});
await run('100 AES-GCM decrypts (50 bookings)', async () => { await Promise.all(blobs.map((b) => crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.iv }, aes, b.ct))); });
await run('CSRF HMAC import+sign', async () => {
  const k = await crypto.subtle.importKey('raw', enc.encode('s'.repeat(48)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  await crypto.subtle.sign('HMAC', k, enc.encode('payload'));
});
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, enc.encode('a.b'));
await run('Access RS256 JWK import+verify', async () => {
  const k = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  await crypto.subtle.verify('RSASSA-PKCS1-v1_5', k, sig, enc.encode('a.b'));
});
