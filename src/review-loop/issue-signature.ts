import { createHash, createPublicKey, verify } from 'node:crypto';

type Reason = 'format' | 'limit' | 'subject_invalid' | 'subject_mismatch'
  | 'key_invalid' | 'signature_invalid' | 'crypto_failed';
type NonAuthority = { authority: 'unproven'; automaticMerge: false };
export type IssueSignatureInspection = NonAuthority & (
  | { kind: 'refused'; reason: Reason }
  | { kind: 'signature_matches'; envelopeSha256: string; payloadSha256: string;
      publicKeySha256: string; unproven: string[] }
);
const DOMAIN = 'anima-issue-authority/v1';
// Ed25519 8-torsion y coordinates plus p/p+1 aliases; both sign bits are refused.
// libsodium 1.0.18 ed25519_ref10.c ge25519_has_small_order (not X25519).
const SMALL_ORDER_Y = new Set([
  '00'.repeat(32), '01' + '00'.repeat(31),
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ec' + 'ff'.repeat(30) + '7f', 'ed' + 'ff'.repeat(30) + '7f',
  'ee' + 'ff'.repeat(30) + '7f',
]);
function smallOrder(key: Buffer): boolean {
  const y = Buffer.from(key);
  y[31] = y[31]! & 0x7f;
  return SMALL_ORDER_Y.has(y.toString('hex'));
}
const FIELDS = ['repoId', 'issueId', 'repo', 'number', 'bodySha256', 'issueType',
  'decision', 'issuerId', 'keyId', 'policyEpoch'] as const;
const refuse = (reason: Reason): IssueSignatureInspection =>
  ({ kind: 'refused', reason, authority: 'unproven', automaticMerge: false });
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown, pattern: RegExp): v is string => typeof v === 'string' && pattern.test(v);
const id = (v: unknown) => text(v, /^[a-z0-9][a-z0-9_-]{0,127}$/);
function validPayload(p: unknown): p is unknown[] {
  if (!Array.isArray(p) || p.length !== 14 || p[0] !== DOMAIN) return false;
  return text(p[1], /^[1-9][0-9]{0,19}$/) && text(p[2], /^[1-9][0-9]{0,19}$/)
    && text(p[3], /^rfcclub\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
    && integer(p[4]) && p[4] > 0 && text(p[5], /^[a-f0-9]{64}$/)
    && ((p[6] === 'enhancement' && p[7] === 'approve-enhancement')
      || (p[6] === 'bug' && p[7] === 'classify-bug'))
    && id(p[8]) && id(p[9]) && integer(p[10]) && p[10] > 0 && id(p[11])
    && integer(p[12]) && integer(p[13]) && p[13] > p[12];
}
function captureSubject(input: unknown): unknown[] | null {
  try {
    if (input === null || typeof input !== 'object') return null;
    const proto = Object.getPrototypeOf(input);
    if (proto !== null && proto !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(descriptors);
    if (keys.length !== FIELDS.length || keys.some(k => typeof k !== 'string' || !FIELDS.includes(k as typeof FIELDS[number]))) return null;
    const values: unknown[] = [];
    for (const field of FIELDS) {
      const descriptor = descriptors[field];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      values.push(descriptor.value);
    }
    return validPayload([DOMAIN, ...values, 'shape-check', 0, 1]) ? values : null;
  } catch { return null; }
}
function base64(input: unknown, bytes: number): Buffer | null {
  if (typeof input !== 'string' || input.length !== Math.ceil(bytes / 3) * 4) return null;
  const decoded = Buffer.from(input, 'base64');
  return decoded.length === bytes && decoded.toString('base64') === input ? decoded : null;
}
const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Signature math with a supplied key/subject proves no issuer, custody or acceptance policy. */
export function inspectSignedIssueReceipt(encoded: unknown, subject: unknown, publicKey: unknown): IssueSignatureInspection {
  if (typeof encoded !== 'string') return refuse('format');
  if (encoded.length > 8192 || Buffer.byteLength(encoded, 'utf8') > 8192) return refuse('limit');
  if (!/^[\x00-\x7f]*$/.test(encoded)) return refuse('format');
  let envelope: unknown;
  try { envelope = JSON.parse(encoded); } catch { return refuse('format'); }
  if (JSON.stringify(envelope) !== encoded || !Array.isArray(envelope)
    || envelope.length !== 2 || !validPayload(envelope[0])) return refuse('format');
  const payload = envelope[0], captured = captureSubject(subject);
  if (!captured) return refuse('subject_invalid');
  if (captured.some((value, i) => value !== payload[i + 1])) return refuse('subject_mismatch');
  const keyBytes = base64(publicKey, 32);
  if (!keyBytes || smallOrder(keyBytes)) return refuse('key_invalid');
  const signature = base64(envelope[1], 64);
  if (!signature) return refuse('signature_invalid');
  const signed = JSON.stringify(payload);
  try {
    const key = createPublicKey({ key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'), keyBytes,
    ]), type: 'spki', format: 'der' });
    if (!verify(null, Buffer.from(signed, 'utf8'), key, signature)) return refuse('signature_invalid');
    return { kind: 'signature_matches', authority: 'unproven', automaticMerge: false,
      envelopeSha256: sha256(encoded), payloadSha256: sha256(signed), publicKeySha256: sha256(keyBytes),
      unproven: ['issuer', 'custody', 'classification', 'clock', 'lifetime', 'revocation', 'subject'] };
  } catch { return refuse('crypto_failed'); }
}
