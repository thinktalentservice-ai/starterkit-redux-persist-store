import { beforeEach, describe, expect, it } from "vitest";
import { createSecureDriver } from "./secure.js";

const SECRET = "test-secret-passphrase";

describe("createSecureDriver", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips a value", () => {
    const driver = createSecureDriver({ secret: SECRET });
    driver.setItem("k", '{"v":1,"s":{"theme":"dark"}}');
    expect(driver.getItem("k")).toBe('{"v":1,"s":{"theme":"dark"}}');
  });

  it("REGRESSION: reports a missing key as null, not as an empty string", () => {
    // SecureLS.get() returns '' for an absent key rather than null or
    // undefined. Every layer above reads a non-null string as "there is stored
    // data, parse it", so an unnormalised '' fails JSON.parse and is
    // indistinguishable from genuine corruption - which would then delete a key
    // that never existed and, worse, look identical to a decryption failure.
    // `?? null` does not fix this: '' is not nullish.
    const driver = createSecureDriver({ secret: SECRET });
    expect(driver.getItem("never-written")).toBeNull();
  });

  it("stores ciphertext, not the plaintext value", () => {
    const driver = createSecureDriver({ secret: SECRET });
    driver.setItem("k", "sentinel-plaintext");

    const raw = Object.keys(window.localStorage)
      .map((key) => window.localStorage.getItem(key) ?? "")
      .join("|");

    expect(raw).not.toContain("sentinel-plaintext");
    expect(raw.length).toBeGreaterThan(0);
  });

  it("returns null rather than throwing when the secret does not match", () => {
    createSecureDriver({ secret: SECRET }).setItem("k", "value");
    const wrong = createSecureDriver({ secret: "a-completely-different-secret" });
    expect(wrong.getItem("k")).toBeNull();
  });

  it("returns null for a key written as plain localStorage by other code", () => {
    // The consuming app writes unencrypted keys next to these. Handing back
    // undecryptable garbage would be worse than reporting nothing stored.
    window.localStorage.setItem("k", "not-encrypted-at-all");
    expect(createSecureDriver({ secret: SECRET }).getItem("k")).toBeNull();
  });

  it("removes a key", () => {
    const driver = createSecureDriver({ secret: SECRET });
    driver.setItem("k", "value");
    expect(driver.getItem("k")).toBe("value");
    driver.removeItem("k");
    expect(driver.getItem("k")).toBeNull();
  });

  it("throws on an empty secret instead of silently storing plaintext", () => {
    expect(() => createSecureDriver({ secret: "" })).toThrow(/non-empty/);
  });

  it("interoperates between instances sharing a secret", () => {
    // Two drivers with the same secret address the same keys. Key isolation is
    // NOT what `encryptionNamespace` gives you - that option namespaces
    // SecureLS's own metadata index, not the data keys. Separating slices is
    // the persistor's `prefix` + per-slice `key`, one level up.
    const writer = createSecureDriver({ secret: SECRET });
    const reader = createSecureDriver({ secret: SECRET });
    writer.setItem("shared", "value");
    expect(reader.getItem("shared")).toBe("value");
  });

  it("does not persist across a storage clear", () => {
    const driver = createSecureDriver({ secret: SECRET });
    driver.setItem("k", "value");
    // The consuming app calls localStorage.clear() on logout. Nothing written
    // through this driver survives that, metadata index included.
    window.localStorage.clear();
    expect(driver.getItem("k")).toBeNull();
  });
});
