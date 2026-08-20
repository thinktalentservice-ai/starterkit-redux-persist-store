# @devopsnext/starterkit-redux-persist-store

Per-slice Redux persistence. **One storage key per slice**, a **storage driver chosen per slice** (plain or encrypted), and no gate component.

```
localStorage
├── starterkit:customizer   {"v":1,"s":{"isRTL":false,"isMiniSidebar":true}}
├── starterkit:cart         {"v":1,"s":{"items":[…]}}
└── starterkit:auth         (AES ciphertext)
```

Not one `persist:root` blob.

---

## Why this exists

`redux-persist` produces one key per slice only through nested `persistReducer`, and its last release was in 2019. The Redux team does not maintain a persistence library and [points elsewhere](https://github.com/reduxjs/redux-toolkit/discussions/4125). This package covers the case the starterkit actually has: a handful of slices, some of which want encryption and some of which do not, in an SSR framework.

Differences that matter:

| | redux-persist | this |
| --- | --- | --- |
| Key layout | one blob, per-slice needs nesting | one key per slice, always |
| Storage driver | one per `persistReducer` | one **per slice**, mix freely |
| Storage API | Promise-based (for AsyncStorage) | synchronous |
| Gate | `PersistGate` blocks the tree | none; rehydrate in an effect |
| Store touchpoints | reducer + middleware + persistor | one enhancer |

The synchronous driver interface is the reason no gate is needed: rehydration is a single dispatch, so there is no pending state for a gate to wait on.

---

## Install

```bash
pnpm add @devopsnext/starterkit-redux-persist-store
```

Peers, all optional except `redux`: `react` and `react-redux` (only for the `/react` entry), `secure-ls` (only for the `/secure` entry).

---

## Usage

### 1. Configure

```js
import { createPersistor, createPlainDriver } from '@devopsnext/starterkit-redux-persist-store';
import { createSecureDriver } from '@devopsnext/starterkit-redux-persist-store/secure';

export const persistor = createPersistor({
  prefix: 'starterkit:',
  slices: {
    // Plain localStorage, only two fields.
    customizer: {
      driver: createPlainDriver(),
      pick: ['isRTL', 'isMiniSidebar'],
    },
    // Encrypted, whole slice, cross-tab.
    auth: {
      driver: createSecureDriver({ secret: process.env.NEXT_PUBLIC_STORAGE_SECRET }),
      syncTabs: true,
      version: 2,
      migrate: (persisted, from) => (from === 1 ? { token: persisted.accessToken } : undefined),
    },
  },
});
```

### 2. Attach the enhancer

```js
export const store = configureStore({
  reducer: { customizer, brandPreview },
  middleware: (getDefault) => getDefault({
    serializableCheck: { ignoredActions: [persistor.REHYDRATE] },
  }),
  enhancers: (getDefault) => getDefault().concat(persistor.enhancer),
});
```

### 3. Rehydrate after mount

```jsx
import { PersistRehydrator } from '@devopsnext/starterkit-redux-persist-store/react';

<Provider store={store}>
  <PersistRehydrator persistor={persistor} />
  {children}
</Provider>
```

`PersistRehydrator` renders `null`. It reads storage in an effect and flushes pending writes on `pagehide` and on unmount.

---

## Slice options

| Option | Default | Notes |
| --- | --- | --- |
| `key` | the slice name | Storage key is `prefix + key`. |
| `driver` | `createPlainDriver()` | Per slice. Mix plain and encrypted freely. |
| `pick` | – | Whitelist of fields. Applied on write **and on read**. |
| `omit` | – | Blacklist. Setting both `pick` and `omit` throws at config time. |
| `version` | `1` | A record with a different version is discarded unless `migrate` handles it. |
| `migrate` | – | `(persisted, fromVersion) => Partial<S> \| undefined`. Return `undefined` to discard. |
| `throttle` | `250` | Trailing write debounce, ms. `0` writes **synchronously inside the dispatch** — for a slice whose write is immediately followed by a navigation, where a pending timer is a lost write. |
| `syncTabs` | `false` | Adopt writes from other tabs. Assumes a localStorage-backed driver. |

Config-level: `prefix` (default `"starterkit:"`), `slices`.

### Persistor surface

`REHYDRATE` · `enhancer` · `rehydrate(store)` · `flush()` · `purge(sliceName?)` · `isRehydrated()` · `subscribe(fn)`

---

## Drivers

```ts
type PersistDriver = {
  getItem(key: string): string | null;   // null when absent OR unreadable; never throws
  setItem(key: string, value: string): void;  // failures swallowed
  removeItem(key: string): void;
};
```

Any object with this shape works — sessionStorage, IndexedDB behind a sync cache, a test double.

- **`createPlainDriver(storage?)`** — localStorage by default. Passing `null` explicitly yields a noop; omitting the argument yields the default. Every call is try/caught (Safari private mode throws on write; sandboxed frames throw on access).
- **`createNoopDriver()`** — discards everything. Every factory falls back to this when there is no `window`.
- **`createMemoryDriver()`** — `Map`-backed, for tests.
- **`createSecureDriver({ secret, compression?, encryptionNamespace?, metaKey? })`** — from `/secure`.

Drivers are chosen **per slice**, so one persistor can mix them:

```ts
const persistor = createPersistor({
  slices: {
    customizer: { driver: createPlainDriver(), pick: ['isMiniSidebar'] },
    auth:       { driver: createSecureDriver({ secret, metaKey: 'app:_secure_meta' }), throttle: 0 },
  },
});
```

#### Give the secure driver its own `metaKey` if anything else in the app uses SecureLS

SecureLS keeps an index of the keys it owns in one metadata entry (default `_secure__ls__metadata`). It reads that index **once, in its constructor**, into an in-memory array, and every `set()` writes the whole array back. Two SecureLS instances on the same `metaKey` therefore stamp their key lists over each other, orphaning each other's entries in the index. Reads survive it — both instances pass an explicit `encryptionSecret`, so the index is never consulted to decrypt — but `getAllKeys()` and `removeAll()` silently under-report. A distinct `metaKey` costs one storage entry and removes the interaction.

### The secure driver is obfuscation, not confidentiality

**Read this before persisting anything sensitive.** The AES key is a string your application holds at runtime, so it is in the JavaScript bundle you shipped. In Next.js it almost always arrives via a `NEXT_PUBLIC_*` variable, which is inlined into client JS *by design*. Anyone with DevTools can read the key and decrypt every value. This is not a misconfiguration you can fix; it is what client-side encryption is.

What it does buy: values are not casually readable in the Application tab, a naive extension sweeping localStorage gets ciphertext, and you get compression for free. What it does not buy: protection from anyone running code on the page. **If a value must be secret from the user's own browser, it does not belong in web storage under any encryption.**

Do not reach for it by default. Encrypting two layout booleans costs an AES pass and an LZ-String pass on every toggle and protects nothing.

---

## Behaviour worth knowing

**Writes are skipped twice over.** First by reference (`prev[slice] === next[slice]`), which RTK guarantees for untouched slices — so an unrelated dispatch costs one comparison per slice and nothing else. Then by projection: if the slice object changed but the `pick`ed fields did not, nothing is written. Toggling a non-persisted field in a persisted slice writes zero bytes.

**Nothing is written until something changes.** A fresh profile that never touches a persisted field accumulates no keys.

**Rehydration happens in an effect, and that is deliberate.** Under SSR the store is imported and rendered on the server, so the server HTML always reflects initial state. Reading storage before the first client render would make that render disagree with the markup, which React 19 reports as a hydration failure. The visible cost is that persisted state settles one frame late. For state that drives CSS and cannot tolerate the flip, apply it with a pre-paint `<script>` and let the store follow, rather than reaching for a gate — a gate does not fix the flip, it only hides the app during it.

**Version mismatches discard rather than merge.** A record written under an older shape merged into current state produces a store that is subtly wrong and stays wrong, surfacing days later as an impossible combination of fields. Losing a preference is cheaper. Supply `migrate` when you care.

**Corrupt records are deleted on read**, so a bad value cannot be retried on every load for the lifetime of a browser profile.

**`syncTabs` ignores removals.** When another tab calls `localStorage.clear()` on logout, this tab keeps its live UI state rather than resetting mid-session. It also equality-guards against its own writes, without which two tabs adopt each other forever.

**Interaction with blanket clears.** A `localStorage.clear()` anywhere in your app — a logout handler, most commonly — removes these keys along with everything else. That is usually what you want, but it means persisted preferences do not survive logout. If they should, purge selectively with `persistor.purge(name)` instead of clearing.

---

## Development

```bash
pnpm install
pnpm verify   # typecheck + 54 tests + dual-format build
```

`dist/index.*` and `dist/secure.*` carry no `"use client"` banner so they stay importable from a server component; `dist/react.*` carries one.

## License

MIT
