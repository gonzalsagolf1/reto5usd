// Mismo cifrado que la app de la PC (src/main/bridge.js), con WebCrypto:
//   kEnc = HMAC-SHA256(clave, "enc"), kMac = HMAC-SHA256(clave, "mac")
//   flujo_i = HMAC-SHA256(kEnc, nonce || i en 4 bytes)
//   cifrado = gzip(texto) XOR flujo ; etiqueta = HMAC-SHA256(kMac, nonce || cifrado)
//   mensaje = base64url(nonce) "." base64url(cifrado) "." base64url(etiqueta)
const enc = new TextEncoder();
const dec = new TextDecoder();

export function fromB64(s) {
  const t = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function toB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_');
}

const hmacKey = (raw) => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const sign = async (key, data) => new Uint8Array(await crypto.subtle.sign('HMAC', key, data));

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function keys(keyB64) {
  const base = await hmacKey(fromB64(keyB64));
  const [e, m] = await Promise.all([sign(base, enc.encode('enc')), sign(base, enc.encode('mac'))]);
  return { kEnc: await hmacKey(e), kMac: await hmacKey(m) };
}

async function keystream(kEnc, nonce, length) {
  const blocks = [];
  for (let i = 0; i * 32 < length; i++) {
    const counter = new Uint8Array(4);
    new DataView(counter.buffer).setUint32(0, i);
    blocks.push(sign(kEnc, concat(nonce, counter)));
  }
  return concat(...(await Promise.all(blocks))).subarray(0, length);
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Descifra un mensaje. Devuelve el texto, o null si no es auténtico. */
export async function decrypt(message, keyB64) {
  try {
    const parts = String(message || '')
      .trim()
      .split('.');
    if (parts.length !== 3) return null;
    const [nonce, ct, tag] = parts.map(fromB64);
    if (!nonce.length || !ct.length || tag.length !== 32) return null;
    const { kEnc, kMac } = await keys(keyB64);
    const expected = await sign(kMac, concat(nonce, ct));
    let diff = 0;
    for (let i = 0; i < 32; i++) diff |= expected[i] ^ tag[i];
    if (diff) return null;
    const ks = await keystream(kEnc, nonce, ct.length);
    const plain = ct.map((b, i) => b ^ ks[i]);
    return dec.decode(await pipe(plain, new DecompressionStream('gzip')));
  } catch {
    return null;
  }
}

/** Cifra un texto para mandarlo a la PC. */
export async function encrypt(text, keyB64) {
  const { kEnc, kMac } = await keys(keyB64);
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const plain = await pipe(enc.encode(text), new CompressionStream('gzip'));
  const ks = await keystream(kEnc, nonce, plain.length);
  const ct = plain.map((b, i) => b ^ ks[i]);
  const tag = await sign(kMac, concat(nonce, ct));
  return [nonce, ct, tag].map(toB64).join('.');
}
