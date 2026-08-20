/**
 * Storage drivers.
 *
 * One interface, several backends, chosen PER SLICE. That is the whole point of
 * this module: a UI-preferences slice goes to plain localStorage, an auth slice
 * goes through an encrypting driver, and the persistor above does not care which
 * is which.
 *
 * THE INTERFACE IS SYNCHRONOUS, and that is a deliberate departure from
 * redux-persist. redux-persist made storage Promise-based to support React
 * Native's AsyncStorage. We have no such consumer. Synchronous reads mean
 * rehydration is a single dispatch with no pending state, which is why this
 * package needs no PersistGate and no `_persist.rehydrated` bookkeeping inside
 * every slice.
 */

export type PersistDriver = {
  /** Return the stored string, or null when absent OR unreadable. Never throws. */
  getItem(key: string): string | null;
  /** Store the string. A failed write is swallowed, not thrown. */
  setItem(key: string, value: string): void;
  /** Remove the key. Never throws. */
  removeItem(key: string): void;
};

/**
 * Discards everything, returns nothing.
 *
 * Every other factory in this file falls back to this when there is no `window`.
 * That is not a nicety — a Next.js app imports its store module during SSR, so
 * `createPlainDriver()` runs on the server on every request. Touching
 * `localStorage` there is a ReferenceError that takes down the render.
 */
export function createNoopDriver(): PersistDriver {
  return {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
}

/** In-process Map. For tests, and for a slice that should survive navigation but not reload. */
export function createMemoryDriver(): PersistDriver {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

/**
 * Plain `Storage` (localStorage by default), values stored in the clear.
 *
 * EVERY CALL IS WRAPPED. Safari in private mode throws QuotaExceededError on
 * setItem with a zero-byte quota, and any storage access throws SecurityError
 * when the page is sandboxed or third-party cookies are blocked. A persistence
 * layer that can take down the app because a preference could not be saved is
 * worse than one that silently forgets.
 */
export function createPlainDriver(storage?: Storage | null): PersistDriver {
  // `undefined` and `null` mean DIFFERENT things and must not be collapsed with
  // `??`. Omitting the argument asks for the default (localStorage, when there
  // is a window); passing null explicitly says "there is no storage here", and
  // a caller doing `createPlainDriver(maybeStorage)` with a null in hand has to
  // get a noop rather than a silent fallback to real localStorage.
  const resolved = storage === undefined
    ? (typeof window === "undefined" ? null : safeLocalStorage())
    : storage;
  if (!resolved) return createNoopDriver();

  return {
    getItem(key) {
      try {
        return resolved.getItem(key);
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        resolved.setItem(key, value);
      } catch {
        /* quota, private mode, sandboxed frame */
      }
    },
    removeItem(key) {
      try {
        resolved.removeItem(key);
      } catch {
        /* as above */
      }
    },
  };
}

/**
 * Accessing `window.localStorage` can itself throw (sandboxed iframe, blocked
 * storage), before any get/set is attempted. Probing it here keeps that failure
 * out of every call site.
 */
function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
