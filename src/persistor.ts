import type { StoreEnhancer } from "redux";
import { createPlainDriver, type PersistDriver } from "./drivers.js";

/** The narrow slice of a Redux store this package touches. */
export type PersistTargetStore = {
  getState(): Record<string, unknown>;
  dispatch(action: { type: string; payload: Record<string, unknown> }): unknown;
  subscribe(listener: () => void): () => void;
};

export type SlicePersistOptions<S = Record<string, unknown>> = {
  /** Storage key suffix. Defaults to the slice's name in the store. */
  key?: string;
  /** Where this slice is written. Defaults to plain localStorage. */
  driver?: PersistDriver;
  /** Persist only these fields. Mutually exclusive with `omit`. */
  pick?: (keyof S & string)[];
  /** Persist everything except these fields. Mutually exclusive with `pick`. */
  omit?: (keyof S & string)[];
  /** Shape version. A stored record with a different version is discarded unless `migrate` handles it. */
  version?: number;
  /** Upgrade a record written by an older `version`. Return undefined to discard it. */
  migrate?: (persisted: unknown, fromVersion: number) => Partial<S> | undefined;
  /**
   * Write debounce in ms. Defaults to 250. Pass 0 (or less) to write
   * synchronously inside the dispatch, for a slice whose writes are immediately
   * followed by a navigation and so cannot afford a pending timer.
   */
  throttle?: number;
  /** Adopt writes made by other tabs. Assumes a localStorage-backed driver. Defaults to false. */
  syncTabs?: boolean;
};

export type PersistorConfig = {
  /** Prepended to every storage key. Defaults to "starterkit:". */
  prefix?: string;
  slices: Record<string, SlicePersistOptions<never>>;
};

export type Persistor = {
  /** Action type dispatched by `rehydrate`. Feed it to RTK's `serializableCheck.ignoredActions`. */
  readonly REHYDRATE: string;
  /** Store enhancer: wraps the reducer to apply REHYDRATE, and subscribes to write changes. */
  readonly enhancer: StoreEnhancer;
  /** Read storage and apply it. Client-only, idempotent. Call after mount, not at store creation. */
  rehydrate(store: PersistTargetStore): void;
  /** Commit pending debounced writes now. Call on `pagehide`. */
  flush(): void;
  /** Delete persisted data for one slice, or all of them. */
  purge(sliceName?: string): void;
  /** Whether `rehydrate` has run. */
  isRehydrated(): boolean;
  /** Notified when `isRehydrated()` flips. Returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
};

type Envelope = { v: number; s: Record<string, unknown> };

type ResolvedSlice = {
  key: string;
  version: number;
  throttle: number;
  driver: PersistDriver;
  opts: SlicePersistOptions<never>;
};

const DEFAULT_PREFIX = "starterkit:";
const DEFAULT_THROTTLE = 250;
const DEFAULT_VERSION = 1;

export function createPersistor(config: PersistorConfig): Persistor {
  const REHYDRATE = "persist/REHYDRATE";
  const prefix = config.prefix ?? DEFAULT_PREFIX;
  const names = Object.keys(config.slices);

  // Resolved once, not per call. createPlainDriver() probes window.localStorage,
  // and doing that on every write is measurable when a slice changes rapidly.
  const resolved = new Map<string, ResolvedSlice>();

  for (const name of names) {
    const opts = config.slices[name];
    if (!opts) continue;
    if (opts.pick && opts.omit) {
      throw new Error(
        `[starterkit-redux-persist-store] slice "${name}" sets both pick and omit. `
          + "Choose one - a whitelist and a blacklist together have no unambiguous meaning.",
      );
    }
    resolved.set(name, {
      key: prefix + (opts.key ?? name),
      version: opts.version ?? DEFAULT_VERSION,
      throttle: opts.throttle ?? DEFAULT_THROTTLE,
      driver: opts.driver ?? createPlainDriver(),
      opts,
    });
  }

  /** Last string committed per slice. The write-skip comparison is against this, not against storage. */
  const lastWritten = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, string>();

  let rehydrated = false;
  const listeners = new Set<() => void>();

  function project(sliceState: unknown, opts: SlicePersistOptions<never>): Record<string, unknown> {
    if (typeof sliceState !== "object" || sliceState === null) return {};
    const source = sliceState as Record<string, unknown>;
    if (opts.pick) {
      const out: Record<string, unknown> = {};
      for (const field of opts.pick as unknown as string[]) {
        if (field in source) out[field] = source[field];
      }
      return out;
    }
    if (opts.omit) {
      const drop = new Set(opts.omit as unknown as string[]);
      const out: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(source)) {
        if (!drop.has(field)) out[field] = value;
      }
      return out;
    }
    return { ...source };
  }

  function encode(entry: ResolvedSlice, sliceState: unknown): string {
    const envelope: Envelope = { v: entry.version, s: project(sliceState, entry.opts) };
    return JSON.stringify(envelope);
  }

  function commit(name: string): void {
    const entry = resolved.get(name);
    const value = pending.get(name);
    if (!entry || value === undefined) return;
    pending.delete(name);
    const timer = timers.get(name);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(name);
    }
    entry.driver.setItem(entry.key, value);
    lastWritten.set(name, value);
  }

  function schedule(name: string, value: string): void {
    const entry = resolved.get(name);
    if (!entry) return;
    pending.set(name, value);
    const existing = timers.get(name);
    if (existing !== undefined) clearTimeout(existing);

    // throttle: 0 IS SYNCHRONOUS, NOT setTimeout(fn, 0). The difference matters
    // for exactly one kind of slice: one whose write is immediately followed by
    // a navigation. `setTimeout(…, 0)` still yields, and a location.replace() in
    // the same task can tear the page down before the timer fires, silently
    // dropping the write. The cost is that the driver runs inside the dispatch -
    // for the secure driver that is an AES pass on the reducer's critical path,
    // which is why this is opt-in per slice rather than the default.
    if (entry.throttle <= 0) {
      commit(name);
      return;
    }

    // Trailing debounce. A slider or a rapid toggle produces one write, not N -
    // which matters most for an encrypting driver, where every write is an AES
    // pass over the whole slice.
    timers.set(
      name,
      setTimeout(() => commit(name), entry.throttle),
    );
  }

  function decode(
    raw: string,
    version: number,
    opts: SlicePersistOptions<never>,
  ): Record<string, unknown> | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || !("s" in parsed)) return null;
    const record = parsed as Partial<Envelope>;
    const storedVersion = typeof record.v === "number" ? record.v : 0;

    if (storedVersion !== version) {
      // DISCARD, DO NOT MERGE. A record written under a different shape merged
      // into current state produces a store that is subtly wrong and stays
      // wrong - the failure surfaces days later as an impossible combination of
      // fields. Losing a preference is the cheaper outcome.
      if (!opts.migrate) return null;
      const migrated = opts.migrate(record.s, storedVersion);
      if (!migrated) return null;
      return project(migrated, opts);
    }
    // Re-projected on READ as well as on write, so a field dropped from `pick`
    // since the record was written does not come back from storage.
    return project(record.s, opts);
  }

  function attach(store: PersistTargetStore): void {
    let prev = store.getState();

    // BASELINE THE INITIAL PROJECTION WITHOUT WRITING IT. Without this, the
    // first dispatch that touches a persisted slice compares against an empty
    // `lastWritten` and always schedules a write - so a user who only ever
    // toggled a NON-persisted field (the mobile drawer) still gets a storage
    // key full of untouched defaults. Seeding the baseline makes "nothing the
    // persisted projection cares about has changed" mean no write, which is
    // what the fast path above claims.
    for (const name of names) {
      const entry = resolved.get(name);
      if (!entry) continue;
      lastWritten.set(name, encode(entry, prev[name]));
    }

    store.subscribe(() => {
      const next = store.getState();
      for (const name of names) {
        const entry = resolved.get(name);
        if (!entry) continue;

        // FAST PATH, AND THE REASON THIS IS CHEAP. RTK reducers return the
        // identical object when they did not change a slice, so an unrelated
        // dispatch fails this check for every slice and costs one comparison
        // each. Without it, every dispatch anywhere in the app re-serialises
        // (and re-encrypts) every persisted slice.
        if (prev[name] === next[name]) continue;

        // Slower second check: the slice object changed but the PERSISTED
        // fields may not have. Toggling isMobileSidebar produces a new
        // customizer object while the picked fields are byte-identical, and
        // there is no reason to write that.
        const serialized = encode(entry, next[name]);
        if (serialized === lastWritten.get(name)) continue;

        schedule(name, serialized);
      }
      prev = next;
    });

    if (typeof window !== "undefined") attachTabSync(store);
  }

  function attachTabSync(store: PersistTargetStore): void {
    const watched = new Map<string, string>();
    for (const name of names) {
      const entry = resolved.get(name);
      if (entry?.opts.syncTabs) watched.set(entry.key, name);
    }
    if (watched.size === 0) return;

    window.addEventListener("storage", (event) => {
      // Both guards are load-bearing. Without the storageArea check a
      // sessionStorage write with a colliding key is adopted as if it were
      // ours; without the key check every unrelated storage write in the app -
      // i18n language, theme mode - wakes this handler up.
      if (event.storageArea && event.storageArea !== window.localStorage) return;
      if (!event.key) return;
      const name = watched.get(event.key);
      if (!name) return;

      // A null newValue is a removal - another tab logging out and calling
      // localStorage.clear(), most often. Deliberately ignored: wiping this
      // tab's live UI state because a background tab signed out is a worse
      // outcome than briefly disagreeing about a sidebar.
      if (event.newValue === null) return;

      // Breaks the write-echo loop. Two tabs adopting each other's writes will
      // otherwise dispatch, write, notify, dispatch forever.
      if (event.newValue === lastWritten.get(name)) return;

      const entry = resolved.get(name);
      if (!entry) return;
      const decoded = decode(event.newValue, entry.version, entry.opts);
      if (!decoded) return;
      lastWritten.set(name, event.newValue);
      store.dispatch({ type: REHYDRATE, payload: { [name]: decoded } });
    });
  }

  function wrapReducer(
    reducer: (state: unknown, action: { type: string }) => unknown,
  ): (state: unknown, action: { type: string; payload?: unknown }) => unknown {
    return (state, action) => {
      if (action.type !== REHYDRATE || !action.payload || state === undefined) {
        return reducer(state, action);
      }
      const current = state as Record<string, unknown>;
      const payload = action.payload as Record<string, Record<string, unknown>>;
      const next: Record<string, unknown> = { ...current };
      for (const [name, partial] of Object.entries(payload)) {
        const existing = current[name];
        // SHALLOW MERGE OVER CURRENT, not replacement. A slice that gained a
        // field since the last write keeps that field's initial value instead
        // of becoming undefined.
        next[name] = typeof existing === "object" && existing !== null
          ? { ...(existing as Record<string, unknown>), ...partial }
          : partial;
      }
      // Still handed to the real reducer so a slice may observe REHYDRATE in
      // its own extraReducers. RTK slices ignore unknown actions and return
      // state untouched, so the merge above survives.
      return reducer(next, action);
    };
  }

  const enhancer = ((createStore: (r: unknown, p?: unknown) => PersistTargetStore) =>
    (reducer: unknown, preloadedState?: unknown) => {
      const store = createStore(
        wrapReducer(reducer as (state: unknown, action: { type: string }) => unknown),
        preloadedState,
      );
      attach(store);
      return store;
    }) as unknown as StoreEnhancer;

  return {
    REHYDRATE,
    enhancer,

    rehydrate(store) {
      // No window means SSR. Bail before dispatching so the server-rendered
      // tree is always the slices' initial state - the client's first render
      // must match that HTML or React 19 fails hydration. This is exactly why
      // rehydration belongs in an effect and not at store-creation time.
      if (typeof window === "undefined") return;
      if (rehydrated) return;
      rehydrated = true;

      const payload: Record<string, Record<string, unknown>> = {};
      for (const name of names) {
        const entry = resolved.get(name);
        if (!entry) continue;
        const raw = entry.driver.getItem(entry.key);
        if (raw === null) continue;
        const decoded = decode(raw, entry.version, entry.opts);
        if (!decoded) {
          // Unparseable or version-rejected. Drop it so it cannot be retried
          // on every load for the lifetime of the browser profile.
          entry.driver.removeItem(entry.key);
          continue;
        }
        payload[name] = decoded;
      }

      // Only dispatch when there is something to apply. A cold start writes no
      // keys and notifies no subscribers - a fresh profile should not
      // accumulate storage entries just for having loaded the app.
      //
      // When there IS something, the resulting reference change wakes the
      // subscriber, which writes the canonical projection back. That single
      // startup write is intentional: it is what upgrades a record that was
      // missing a newly-picked field.
      if (Object.keys(payload).length > 0) store.dispatch({ type: REHYDRATE, payload });

      for (const listener of listeners) listener();
    },

    flush() {
      for (const name of [...pending.keys()]) commit(name);
    },

    purge(sliceName) {
      const targets = sliceName ? [sliceName] : names;
      for (const name of targets) {
        const entry = resolved.get(name);
        if (!entry) continue;
        const timer = timers.get(name);
        if (timer !== undefined) clearTimeout(timer);
        timers.delete(name);
        pending.delete(name);
        lastWritten.delete(name);
        entry.driver.removeItem(entry.key);
      }
    },

    isRehydrated: () => rehydrated,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
