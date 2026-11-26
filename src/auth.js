// Hash password (PBKDF2) dan token sesi (JWT HS256) memakai WebCrypto,
// sehingga jalan di Cloudflare Workers maupun Node 20+.
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 100000 adalah batas iterasi PBKDF2 di Cloudflare Workers.
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100000;
  return `pbkdf2$${iterations}$${b64u(salt)}$${b64u(await pbkdf2(password, salt, iterations))}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iter, salt, hash] = String(stored).split('$');
  if (scheme !== 'pbkdf2') return false;
  return sameString(b64u(await pbkdf2(password, unb64u(salt), Number(iter))), hash);
}

const hmacKey = (secret, usage) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

export async function signToken(payload, secret) {
  const head = b64u(enc.encode('{"alg":"HS256","typ":"JWT"}'));
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = b64u(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${sig}`;
}

export async function verifyToken(token, secret) {
  try {
    const [head, body, sig] = String(token).split('.');
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), unb64u(sig), enc.encode(`${head}.${body}`));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(unb64u(body)));
    return payload.exp > Date.now() / 1000 ? payload : null;
  } catch {
    return null;
  }
}
