import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { sha256Bytes, sha256Hex, sha256HexBytes } from '../src/sha256.js';

const nodeHash = bytes => createHash('sha256').update(bytes).digest('hex');
const enc = s => new TextEncoder().encode(s);

for (const [name, msg, want] of [
  ['empty string', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['fox', 'The quick brown fox jumps over the lazy dog',
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'],
  ['fox period', 'The quick brown fox jumps over the lazy dog.',
    'ef537f25c895bfa782526529a9b63d97aa631564d5d789c2b765448c8635fb6c'],
  ['two-block FIPS message', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ['million a', 'a'.repeat(1000000),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
]) {
  test(`FIPS 180-4 known answer: ${name}`, () => {
    assert.equal(sha256Hex(msg), want);
    assert.equal(sha256HexBytes(enc(msg)), want);
  });
}

// Every message-length class around the 56-byte block-boundary padding rule.
for (const len of [0, 1, 2, 3, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 191, 192, 255, 256, 1000]) {
  test(`padding boundary length ${len} matches Node`, () => {
    const bytes = enc('x'.repeat(len));
    assert.equal(sha256HexBytes(bytes), nodeHash(bytes));
  });
}

for (const len of [1, 7, 33, 64, 200, 517]) {
  test(`random binary ${len} bytes matches Node`, () => {
    const bytes = randomBytes(len);
    assert.equal(sha256HexBytes(new Uint8Array(bytes)), nodeHash(bytes));
    assert.deepEqual([...sha256Bytes(new Uint8Array(bytes))],
      [...createHash('sha256').update(bytes).digest()]);
  });
}

for (const s of [
  'réplica sísmica', 'quake\u0000sense', '日本語のテスト', '\ud83d\ude00 emoji and \u{1f30a} wave',
  'line\nbreaks\tand\ttabs', 'x'.repeat(7777), '{"json":"canonical","n":42}',
]) {
  test(`unicode and control text ${JSON.stringify(s.slice(0, 20))} matches Node`, () => {
    assert.equal(sha256Hex(s), nodeHash(enc(s)));
  });
}

test('high byte values inside the length field are handled', () => {
  const bytes = new Uint8Array(0x10000 + 3);
  assert.equal(sha256HexBytes(bytes), nodeHash(bytes));
});

test('input types are enforced, never silently coerced', () => {
  assert.throws(() => sha256Bytes('abc'), TypeError);
  assert.throws(() => sha256Bytes(null), TypeError);
  assert.throws(() => sha256HexBytes([1, 2, 3]), TypeError);
  assert.throws(() => sha256Hex(new Uint8Array([97])), TypeError);
  assert.throws(() => sha256Hex(42), TypeError);
});

test('output is always 32 bytes and 64 lowercase hex characters', () => {
  for (const msg of ['', 'q', 'much longer message to digest']) {
    const d = sha256Bytes(enc(msg));
    assert.equal(d.length, 32);
    assert.match(sha256Hex(msg), /^[0-9a-f]{64}$/);
  }
});
