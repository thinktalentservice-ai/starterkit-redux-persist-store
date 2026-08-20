/**
 * SecureLS-backed driver — AES-encrypted, LZ-String-compressed localStorage.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS IS OBFUSCATION, NOT CONFIDENTIALITY. READ BEFORE USING.
 *
 * The AES key is a string your application holds at runtime, which means it is
 * in the JavaScript bundle you shipped to the browser. Anyone with DevTools can
 * read the key and decrypt every value. In a Next.js app the key almost always
 * arrives via a NEXT_PUBLIC_* variable, which is inlined into client JS by
 * design — so this is not a misconfiguration you can fix, it is the nature of
 * client-side encryption.
 *
 * What this driver genuinely buys you:
 *   - values are not casually readable in the Application tab
 *   - a browser extension or bookmarklet doing a naive localStorage sweep gets
 *     ciphertext instead of a bearer token
 *   - compression, which matters if a slice is large
 *
 * What it does NOT buy you: protection from anyone running code on the page, or
 * from anyone who opened the bundle. If a value must be secret from the user's
 * own browser, it does not belong in web storage under any encryption.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Lives in its own entry point (`.../secure`) rather than the barrel so that
 * `secure-ls` — and the crypto-js + lz-string it drags in — is only bundled by
 * apps that actually ask for it.
 */

import SecureLS from "secure-ls";
import { createNoopDriver, type PersistDriver } from "./drivers.js";

export type SecureDriverOptions = {
  /** AES passphrase. Required; without it SecureLS silently stores plaintext. */
  secret: string;
  /** LZ-String compression. SecureLS defaults this to true; kept explicit. */
  compression?: boolean;
  /**
   * Passed through to SecureLS. Namespaces its INTERNAL METADATA INDEX, not the
   * data keys — two drivers with different namespaces still address the same
   * storage keys. Separating slices is the persistor's `prefix` + per-slice
   * `key`, one level up.
   */
  encryptionNamespace?: string;
  /** Passed through to SecureLS — its own index key, default `_secure__ls__metadata`. */
  metaKey?: string;
};

export function createSecureDriver(options: SecureDriverOptions): PersistDriver {
  // Same reason as the plain driver, and the same reason ApiUtils in the
  // consuming app constructs SecureLS lazily: this factory is called at module
  // scope, which on Next.js means it is called during SSR.
  if (typeof window === "undefined") return createNoopDriver();

  if (!options.secret) {
    throw new Error(
      "[starterkit-redux-persist-store] createSecureDriver requires a non-empty `secret`. "
        + "SecureLS accepts an empty secret and writes effectively-plaintext values, so this "
        + "fails loudly instead.",
    );
  }

  // Lazily constructed on first use, not here. Constructing SecureLS reads and
  // rewrites its metadata key, and doing that as a side effect of importing a
  // module is how you get storage writes during a render that was only ever
  // meant to read.
  let ls: SecureLS | null = null;
  const client = (): SecureLS | null => {
    if (ls) return ls;
    try {
      ls = new SecureLS({
        encodingType: "aes",
        encryptionSecret: options.secret,
        isCompression: options.compression ?? true,
        ...(options.encryptionNamespace ? { encryptionNamespace: options.encryptionNamespace } : {}),
        ...(options.metaKey ? { metaKey: options.metaKey } : {}),
      });
      return ls;
    } catch {
      return null;
    }
  };

  return {
    getItem(key) {
      try {
        const value = client()?.get(key);

        // SECURELS RETURNS '' FOR A MISSING KEY, NOT null OR undefined.
        // Every layer above reads null as "nothing stored yet" and a non-null
        // string as "stored data, parse it". Without this normalisation a cold
        // start hands the persistor an empty string, which fails JSON.parse and
        // is indistinguishable from genuine corruption. `?? null` does not help
        // — '' is not nullish.
        if (value === "" || value === undefined || value === null) return null;

        // We only ever hand it strings, so anything else means the key was
        // written by other code (the app's own ApiUtils, say) with a different
        // shape. Refuse it rather than stringify something we did not persist.
        return typeof value === "string" ? value : null;
      } catch {
        // Wrong secret, corrupt ciphertext, or unreadable storage. All three
        // mean "no usable persisted value", which is what null says.
        return null;
      }
    },
    setItem(key, value) {
      try {
        client()?.set(key, value);
      } catch {
        /* quota, private mode, crypto failure */
      }
    },
    removeItem(key) {
      try {
        client()?.remove(key);
      } catch {
        /* as above */
      }
    },
  };
}
