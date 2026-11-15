import { expect, test } from "bun:test";

import type { EncryptedValue, WrappedDek } from "./index";
import {
  decryptValue,
  encryptValue,
  generateDek,
  IntegrityError,
  MasterKeyError,
  parseMasterKey,
  unwrapDek,
  wrapDek,
} from "./index";

const INTEGRITY_MESSAGE =
  "Decryption failed: the data or key is invalid or has been tampered with";
const PLAINTEXT = "a secret value";
const VALID_MASTER_KEY = btoa("m".repeat(32));

const base64 = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes));

const flip = (bytes: Uint8Array, offset = 0): Uint8Array =>
  bytes.map((byte, index) => (index === offset ? (byte + 1) % 256 : byte));

test("values round trip, including empty bytes, with fresh IVs and ciphertext", async () => {
  const dek = generateDek();
  await Promise.all(
    [new TextEncoder().encode(PLAINTEXT), new Uint8Array()].map(
      async (plaintext) => {
        const first = await encryptValue(plaintext, dek);
        const second = await encryptValue(plaintext, dek);
        expect(await decryptValue(first, dek)).toEqual(plaintext);
        expect(await decryptValue(second, dek)).toEqual(plaintext);
        expect(first.iv).toHaveLength(12);
        expect(first.ciphertext).toHaveLength(plaintext.length + 16);
        expect(first.iv).not.toEqual(second.iv);
        expect(first.ciphertext).not.toEqual(second.ciphertext);
      }
    )
  );
});

test("generated DEKs wrap and unwrap with fresh IVs", async () => {
  const dek = generateDek();
  const masterKey = generateDek();
  const first = await wrapDek(dek, masterKey);
  const second = await wrapDek(dek, masterKey);
  expect(dek).toHaveLength(32);
  expect(first.wrappedDek).toHaveLength(48);
  expect(first.iv).toHaveLength(12);
  expect(await unwrapDek(first, masterKey)).toEqual(dek);
  expect(await unwrapDek(second, masterKey)).toEqual(dek);
  expect(first.iv).not.toEqual(second.iv);
  expect(first.wrappedDek).not.toEqual(second.wrappedDek);
});

interface TamperFixture {
  encrypted: EncryptedValue;
  wrapped: WrappedDek;
  dek: Uint8Array;
  masterKey: Uint8Array;
}

const tamperCases: {
  name: string;
  decrypt: (fixture: TamperFixture) => Promise<Uint8Array>;
}[] = [
  {
    name: "changed ciphertext byte",
    decrypt: ({ encrypted, dek }) =>
      decryptValue(
        { ...encrypted, ciphertext: flip(encrypted.ciphertext) },
        dek
      ),
  },
  {
    name: "changed authentication tag",
    decrypt: ({ encrypted, dek }) =>
      decryptValue(
        {
          ...encrypted,
          ciphertext: flip(
            encrypted.ciphertext,
            encrypted.ciphertext.length - 1
          ),
        },
        dek
      ),
  },
  {
    name: "changed value IV",
    decrypt: ({ encrypted, dek }) =>
      decryptValue({ ...encrypted, iv: flip(encrypted.iv) }, dek),
  },
  {
    name: "truncated ciphertext",
    decrypt: ({ encrypted, dek }) =>
      decryptValue(
        { ...encrypted, ciphertext: encrypted.ciphertext.slice(0, 15) },
        dek
      ),
  },
  {
    name: "empty ciphertext",
    decrypt: ({ encrypted, dek }) =>
      decryptValue({ ...encrypted, ciphertext: new Uint8Array() }, dek),
  },
  {
    name: "changed wrapped DEK",
    decrypt: ({ wrapped, masterKey }) =>
      unwrapDek(
        { ...wrapped, wrappedDek: flip(wrapped.wrappedDek) },
        masterKey
      ),
  },
  {
    name: "changed wrap IV",
    decrypt: ({ wrapped, masterKey }) =>
      unwrapDek({ ...wrapped, iv: flip(wrapped.iv) }, masterKey),
  },
  {
    name: "wrong DEK",
    decrypt: ({ encrypted, dek }) => decryptValue(encrypted, flip(dek)),
  },
  {
    name: "wrong master key",
    decrypt: ({ wrapped, masterKey }) => unwrapDek(wrapped, flip(masterKey)),
  },
];

test.each(tamperCases)(
  "tamper rejects with a safe IntegrityError: $name",
  async ({ decrypt }) => {
    const dek = generateDek();
    const masterKey = generateDek();
    const encrypted = await encryptValue(
      new TextEncoder().encode(PLAINTEXT),
      dek
    );
    const wrapped = await wrapDek(dek, masterKey);
    const result = decrypt({ encrypted, wrapped, dek, masterKey });
    await expect(result).rejects.toBeInstanceOf(IntegrityError);
    await expect(result).rejects.toMatchObject({
      name: "IntegrityError",
      message: INTEGRITY_MESSAGE,
    });
    const error = await result.catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(IntegrityError);
    if (!(error instanceof IntegrityError)) {
      throw new TypeError("Expected an integrity error");
    }
    expect(error).not.toHaveProperty("cause");
    expect(Object.keys(error).toSorted()).toEqual(["name"]);
    for (const material of [
      PLAINTEXT,
      base64(dek),
      base64(masterKey),
      base64(encrypted.ciphertext),
      base64(encrypted.iv),
      base64(wrapped.wrappedDek),
      base64(wrapped.iv),
    ]) {
      expect(error.message).not.toContain(material);
    }
  }
);

const masterKeyCases = [
  { name: "valid padded base64", value: VALID_MASTER_KEY },
  { name: "missing", value: undefined, message: "Master key is missing" },
  { name: "empty", value: "", message: "Master key is missing" },
  { name: "non-alphabet character", value: `${"A".repeat(42)}!=` },
  { name: "trailing newline", value: `${VALID_MASTER_KEY}\n` },
  { name: "whitespace", value: ` ${VALID_MASTER_KEY}` },
  { name: "base64url dash", value: `${"A".repeat(42)}-=` },
  { name: "base64url underscore", value: `${"A".repeat(42)}_=` },
  { name: "missing padding", value: VALID_MASTER_KEY.slice(0, -1) },
  { name: "bad padding", value: `${VALID_MASTER_KEY}=` },
  { name: "noncanonical padding bits", value: `${"A".repeat(42)}B=` },
  {
    name: "16 decoded bytes",
    value: btoa("m".repeat(16)),
    message: "Master key must decode to 32 bytes, got 16 bytes",
  },
  {
    name: "33 decoded bytes",
    value: btoa("m".repeat(33)),
    message: "Master key must decode to 32 bytes, got 33 bytes",
  },
  { name: "16-byte encryption key", value: new Uint8Array(16) },
  { name: "24-byte encryption key", value: new Uint8Array(24) },
];

test.each(masterKeyCases)(
  "master key validation: $name",
  async ({ value, message }) => {
    if (value instanceof Uint8Array) {
      const dek = generateDek();
      const encrypted = await encryptValue(new Uint8Array(), dek);
      const wrapped = await wrapDek(dek, dek);
      await Promise.all(
        [
          () => encryptValue(new Uint8Array(), value),
          () => decryptValue(encrypted, value),
          () => wrapDek(value, dek),
          () => wrapDek(dek, value),
          () => unwrapDek(wrapped, value),
        ].map(async (operation) => {
          const error = await operation().catch((error_: unknown) => error_);
          expect(error).toBeInstanceOf(RangeError);
          expect(error).toMatchObject({ message: "Key must be 32 bytes" });
        })
      );
      return;
    }
    if (value === VALID_MASTER_KEY) {
      expect(parseMasterKey(value)).toEqual(
        new TextEncoder().encode("m".repeat(32))
      );
      expect(parseMasterKey(value)).toHaveLength(32);
      return;
    }
    expect(() => parseMasterKey(value)).toThrow(MasterKeyError);
    expect(() => parseMasterKey(value)).toThrow(
      message ?? "Master key is not valid base64"
    );
    try {
      parseMasterKey(value);
    } catch (error) {
      expect(error).toBeInstanceOf(MasterKeyError);
      if (error instanceof MasterKeyError && value) {
        expect(error.name).toBe("MasterKeyError");
        expect(error.message).not.toContain(value);
      }
    }
  }
);
