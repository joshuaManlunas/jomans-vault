// oxlint-disable-next-line max-classes-per-file -- The specified single-file API exports both error classes.
const KEY_BYTES = 32;
const IV_BYTES = 12;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export interface WrappedDek {
  wrappedDek: Uint8Array;
  iv: Uint8Array;
}

export interface EncryptedValue {
  ciphertext: Uint8Array;
  iv: Uint8Array;
}

export class IntegrityError extends Error {
  constructor() {
    super(
      "Decryption failed: the data or key is invalid or has been tampered with"
    );
    this.name = "IntegrityError";
  }
}

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyError";
  }
}

const validateKey = (key: Uint8Array): void => {
  if (key.byteLength !== KEY_BYTES) {
    throw new RangeError("Key must be 32 bytes");
  }
};

export const generateDek = (): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(KEY_BYTES));

export const encryptValue = async (
  plaintext: Uint8Array,
  dek: Uint8Array
): Promise<EncryptedValue> => {
  validateKey(dek);
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(dek),
    "AES-GCM",
    false,
    ["encrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: 128 },
    key,
    new Uint8Array(plaintext)
  );
  return { ciphertext: new Uint8Array(ciphertext), iv };
};

export const decryptValue = async (
  encrypted: EncryptedValue,
  dek: Uint8Array
): Promise<Uint8Array> => {
  validateKey(dek);
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(dek),
    "AES-GCM",
    false,
    ["decrypt"]
  );
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: new Uint8Array(encrypted.iv), tagLength: 128 },
      key,
      new Uint8Array(encrypted.ciphertext)
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new IntegrityError();
  }
};

export const wrapDek = async (
  dek: Uint8Array,
  masterKey: Uint8Array
): Promise<WrappedDek> => {
  validateKey(dek);
  const encrypted = await encryptValue(dek, masterKey);
  return { wrappedDek: encrypted.ciphertext, iv: encrypted.iv };
};

export const unwrapDek = async (
  wrapped: WrappedDek,
  masterKey: Uint8Array
): Promise<Uint8Array> => {
  const dek = await decryptValue(
    { ciphertext: wrapped.wrappedDek, iv: wrapped.iv },
    masterKey
  );
  if (dek.byteLength !== KEY_BYTES) {
    throw new IntegrityError();
  }
  return dek;
};

export const parseMasterKey = (value: string | undefined): Uint8Array => {
  if (value === undefined || value === "") {
    throw new MasterKeyError("Master key is missing");
  }
  if (!BASE64_PATTERN.test(value)) {
    throw new MasterKeyError("Master key is not valid base64");
  }
  const decoded = atob(value);
  if (btoa(decoded) !== value) {
    throw new MasterKeyError("Master key is not valid base64");
  }
  if (decoded.length !== KEY_BYTES) {
    throw new MasterKeyError(
      `Master key must decode to 32 bytes, got ${decoded.length} bytes`
    );
  }
  // oxlint-disable-next-line unicorn/prefer-code-point -- atob returns byte characters, not Unicode text.
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};
