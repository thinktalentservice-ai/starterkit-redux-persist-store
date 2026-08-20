import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { legacy_createStore as createStore } from "redux";
import { createPersistor, type PersistTargetStore } from "./persistor.js";
import { createMemoryDriver, type PersistDriver } from "./drivers.js";

// ---------------------------------------------------------------------------
// A miniature store. Deliberately hand-rolled rather than pulled from RTK: the
// behaviour under test is "reducers return the identical object when nothing
// changed", and writing that by hand makes the contract the persistor relies on
// visible in the test file instead of implied by a dependency.
// ---------------------------------------------------------------------------

type TestState = {
  ui: { theme: string; mini: boolean; transient: number };
  other: { n: number };
};

const INITIAL: TestState = {
  ui: { theme: "light", mini: false, transient: 0 },
  other: { n: 0 },
};

type TestAction =
  | { type: "ui/setTheme"; theme: string }
  | { type: "ui/setMini"; mini: boolean }
  | { type: "ui/setTransient"; transient: number }
  | { type: "other/inc" }
  | { type: string };

function rootReducer(state: TestState = INITIAL, action: TestAction): TestState {
  switch (action.type) {
    case "ui/setTheme":
      return { ...state, ui: { ...state.ui, theme: (action as { theme: string }).theme } };
    case "ui/setMini":
      return { ...state, ui: { ...state.ui, mini: (action as { mini: boolean }).mini } };
    case "ui/setTransient":
      return {
        ...state,
        ui: { ...state.ui, transient: (action as { transient: number }).transient },
      };
    case "other/inc":
      return { ...state, other: { n: state.other.n + 1 } };
    default:
      return state;
  }
}

/** Memory driver that counts calls, so "how many writes happened" is assertable. */
function countingDriver(): PersistDriver & { writes: number; reads: number; removes: number } {
  const inner = createMemoryDriver();
  const driver = {
    writes: 0,
    reads: 0,
    removes: 0,
    getItem(key: string) {
      driver.reads += 1;
      return inner.getItem(key);
    },
    setItem(key: string, value: string) {
      driver.writes += 1;
      inner.setItem(key, value);
    },
    removeItem(key: string) {
      driver.removes += 1;
      inner.removeItem(key);
    },
  };
  return driver;
}

// `Omit` on getState, not an intersection: intersecting the two getState
// signatures makes TS resolve the call to the first overload and hand back
// Record<string, unknown>, so every `store.getState().ui` in this file becomes
// `unknown`.
type TypedTestStore = Omit<PersistTargetStore, "getState"> & { getState(): TestState };

function makeStore(enhancer: unknown, preloaded?: TestState): TypedTestStore {
  return createStore(
    rootReducer as never,
    preloaded as never,
    enhancer as never,
  ) as unknown as TypedTestStore;
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe("configuration", () => {
  it("rejects a slice that sets both pick and omit", () => {
    expect(() =>
      createPersistor({
        slices: { ui: { pick: ["theme"], omit: ["mini"] } as never },
      }),
    ).toThrow(/pick and omit/);
  });

  it("keys storage as prefix + slice name by default", () => {
    const driver = createMemoryDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "ui/setTheme", theme: "dark" } as never);
    vi.runAllTimers();

    expect(driver.getItem("app:ui")).not.toBeNull();
  });

  it("honours an explicit key over the slice name", () => {
    const driver = createMemoryDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver, key: "layout-prefs" } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "ui/setTheme", theme: "dark" } as never);
    vi.runAllTimers();

    expect(driver.getItem("app:layout-prefs")).not.toBeNull();
    expect(driver.getItem("app:ui")).toBeNull();
  });

  it("gives each slice its own key rather than one combined blob", () => {
    const driver = createMemoryDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver } as never, other: { driver } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "ui/setTheme", theme: "dark" } as never);
    store.dispatch({ type: "other/inc" } as never);
    vi.runAllTimers();

    expect(driver.getItem("app:ui")).not.toBeNull();
    expect(driver.getItem("app:other")).not.toBeNull();
    expect(driver.getItem("app:root")).toBeNull();
  });
});

describe("field selection", () => {
  it("pick persists only the whitelisted fields", () => {
    const driver = createMemoryDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver, pick: ["theme", "mini"] } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "ui/setTheme", theme: "dark" } as never);
    vi.runAllTimers();

    const record = JSON.parse(driver.getItem("app:ui") ?? "null");
    expect(record.s).toEqual({ theme: "dark", mini: false });
    expect(record.s).not.toHaveProperty("transient");
  });

  it("omit persists everything except the blacklisted fields", () => {
    const driver = createMemoryDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver, omit: ["transient"] } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "ui/setTheme", theme: "dark" } as never);
    vi.runAllTimers();

    const record = JSON.parse(driver.getItem("app:ui") ?? "null");
    expect(record.s).toEqual({ theme: "dark", mini: false });
  });

  it("persists the whole slice when neither pick nor omit is given", () => {
    const driver = createMemoryDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "ui/setTheme", theme: "dark" } as never);
    vi.runAllTimers();

    const record = JSON.parse(driver.getItem("app:ui") ?? "null");
    expect(record.s).toEqual({ theme: "dark", mini: false, transient: 0 });
  });
});

describe("write economy", () => {
  it("writes nothing when an unrelated slice changes", () => {
    const driver = countingDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "other/inc" } as never);
    store.dispatch({ type: "other/inc" } as never);
    vi.runAllTimers();

    expect(driver.writes).toBe(0);
  });

  it("writes nothing when the slice object changes but no persisted field does", () => {
    // This is the isMobileSidebar case: the reducer produces a new object, but
    // the picked fields are byte-identical. Without the projection comparison
    // every drawer toggle would re-serialise and re-encrypt the slice.
    const driver = countingDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver, pick: ["theme", "mini"] } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "ui/setTransient", transient: 1 } as never);
    store.dispatch({ type: "ui/setTransient", transient: 2 } as never);
    vi.runAllTimers();

    expect(driver.writes).toBe(0);
  });

  it("coalesces rapid changes into a single write", () => {
    const driver = countingDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver, throttle: 250 } as never },
    });
    const store = makeStore(persistor.enhancer);

    for (let i = 0; i < 10; i += 1) {
      store.dispatch({ type: "ui/setTheme", theme: `theme-${i}` } as never);
      vi.advanceTimersByTime(10);
    }
    expect(driver.writes).toBe(0);

    vi.runAllTimers();
    expect(driver.writes).toBe(1);
    expect(JSON.parse(driver.getItem("app:ui") ?? "null").s.theme).toBe("theme-9");
  });

  it("throttle: 0 writes synchronously inside the dispatch, with no timer to run", () => {
    const driver = countingDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver, throttle: 0 } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "ui/setTheme", theme: "dark" } as never);

    // The point of the option: readable BEFORE any timer is allowed to run, so a
    // navigation in the same task cannot drop it.
    expect(driver.writes).toBe(1);
    expect(JSON.parse(driver.getItem("app:ui") ?? "null").s.theme).toBe("dark");

    // And nothing is left queued to fire a duplicate later.
    vi.runAllTimers();
    expect(driver.writes).toBe(1);
  });

  it("throttle: 0 still writes once per distinct change, not once per dispatch", () => {
    const driver = countingDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver, throttle: 0, pick: ["theme", "mini"] } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "ui/setTheme", theme: "dark" } as never);
    store.dispatch({ type: "ui/setTransient", transient: 1 } as never);
    vi.runAllTimers();

    // The transient field is not projected, so the second dispatch changes the
    // slice by reference but not the persisted projection. Synchronous writing
    // must not bypass that comparison.
    expect(driver.writes).toBe(1);
  });

  it("flush() commits a pending write immediately", () => {
    const driver = countingDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver, throttle: 5000 } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "ui/setTheme", theme: "dark" } as never);
    expect(driver.writes).toBe(0);

    persistor.flush();
    expect(driver.writes).toBe(1);

    // The debounce timer must not fire a second, duplicate write afterwards.
    vi.runAllTimers();
    expect(driver.writes).toBe(1);
  });

  it("flush() is a no-op when nothing is pending", () => {
    const driver = countingDriver();
    const persistor = createPersistor({ prefix: "app:", slices: { ui: { driver } as never } });
    makeStore(persistor.enhancer);

    persistor.flush();
    expect(driver.writes).toBe(0);
  });
});

describe("rehydrate", () => {
  it("applies a stored record to the store", () => {
    const driver = createMemoryDriver();
    driver.setItem("app:ui", JSON.stringify({ v: 1, s: { theme: "dark", mini: true } }));

    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver, pick: ["theme", "mini"] } as never },
    });
    const store = makeStore(persistor.enhancer);

    expect(store.getState().ui.theme).toBe("light");
    persistor.rehydrate(store);
    expect(store.getState().ui.theme).toBe("dark");
    expect(store.getState().ui.mini).toBe(true);
  });

  it("merges shallowly so a newly-added field keeps its initial value", () => {
    const driver = createMemoryDriver();
    // Written before `transient` existed on the slice.
    driver.setItem("app:ui", JSON.stringify({ v: 1, s: { theme: "dark" } }));

    const persistor = createPersistor({ prefix: "app:", slices: { ui: { driver } as never } });
    const store = makeStore(persistor.enhancer);
    persistor.rehydrate(store);

    expect(store.getState().ui).toEqual({ theme: "dark", mini: false, transient: 0 });
  });

  it("does not resurrect a field that has since been dropped from pick", () => {
    const driver = createMemoryDriver();
    driver.setItem(
      "app:ui",
      JSON.stringify({ v: 1, s: { theme: "dark", mini: true, transient: 99 } }),
    );

    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver, pick: ["theme"] } as never },
    });
    const store = makeStore(persistor.enhancer);
    persistor.rehydrate(store);

    expect(store.getState().ui.theme).toBe("dark");
    expect(store.getState().ui.transient).toBe(0);
    expect(store.getState().ui.mini).toBe(false);
  });

  it("leaves the store untouched when nothing is stored, and writes no key", () => {
    const driver = countingDriver();
    const persistor = createPersistor({ prefix: "app:", slices: { ui: { driver } as never } });
    const store = makeStore(persistor.enhancer);

    persistor.rehydrate(store);
    vi.runAllTimers();

    expect(store.getState()).toEqual(INITIAL);
    expect(driver.writes).toBe(0);
  });

  it("is idempotent - a second call does not re-read storage", () => {
    const driver = countingDriver();
    driver.setItem("app:ui", JSON.stringify({ v: 1, s: { theme: "dark" } }));

    const persistor = createPersistor({ prefix: "app:", slices: { ui: { driver } as never } });
    const store = makeStore(persistor.enhancer);

    persistor.rehydrate(store);
    const readsAfterFirst = driver.reads;
    persistor.rehydrate(store);

    expect(driver.reads).toBe(readsAfterFirst);
  });

  it("is a no-op when there is no window", () => {
    const driver = createMemoryDriver();
    driver.setItem("app:ui", JSON.stringify({ v: 1, s: { theme: "dark" } }));

    const persistor = createPersistor({ prefix: "app:", slices: { ui: { driver } as never } });
    const store = makeStore(persistor.enhancer);

    vi.stubGlobal("window", undefined);
    try {
      persistor.rehydrate(store);
      // The whole point: the server-rendered tree must be initial state, or the
      // client's first render disagrees with the HTML and React fails hydration.
      expect(store.getState().ui.theme).toBe("light");
      expect(persistor.isRehydrated()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("flips isRehydrated and notifies subscribers", () => {
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver: createMemoryDriver() } as never },
    });
    const store = makeStore(persistor.enhancer);
    const listener = vi.fn();
    persistor.subscribe(listener);

    expect(persistor.isRehydrated()).toBe(false);
    persistor.rehydrate(store);
    expect(persistor.isRehydrated()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("stops notifying after unsubscribe", () => {
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver: createMemoryDriver() } as never },
    });
    const store = makeStore(persistor.enhancer);
    const listener = vi.fn();
    persistor.subscribe(listener)();

    persistor.rehydrate(store);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("versioning", () => {
  it("discards and deletes a record written under a different version", () => {
    const driver = countingDriver();
    driver.setItem("app:ui", JSON.stringify({ v: 1, s: { theme: "dark" } }));

    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver, version: 2 } as never },
    });
    const store = makeStore(persistor.enhancer);
    persistor.rehydrate(store);

    expect(store.getState().ui.theme).toBe("light");
    expect(driver.removes).toBe(1);
    expect(driver.getItem("app:ui")).toBeNull();
  });

  it("runs migrate when one is supplied", () => {
    const driver = createMemoryDriver();
    driver.setItem("app:ui", JSON.stringify({ v: 1, s: { colour: "dark" } }));

    const persistor = createPersistor({
      prefix: "app:",
      slices: {
        ui: {
          driver,
          version: 2,
          migrate: (persisted: unknown, from: number) => {
            if (from !== 1) return undefined;
            return { theme: (persisted as { colour: string }).colour };
          },
        } as never,
      },
    });
    const store = makeStore(persistor.enhancer);
    persistor.rehydrate(store);

    expect(store.getState().ui.theme).toBe("dark");
  });

  it("discards when migrate declines the record", () => {
    const driver = createMemoryDriver();
    driver.setItem("app:ui", JSON.stringify({ v: 0, s: { theme: "dark" } }));

    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver, version: 2, migrate: () => undefined } as never },
    });
    const store = makeStore(persistor.enhancer);
    persistor.rehydrate(store);

    expect(store.getState().ui.theme).toBe("light");
  });

  it("writes the current version into the envelope", () => {
    const driver = createMemoryDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver, version: 7 } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "ui/setTheme", theme: "dark" } as never);
    vi.runAllTimers();

    expect(JSON.parse(driver.getItem("app:ui") ?? "null").v).toBe(7);
  });
});

describe("corrupt data", () => {
  it("deletes an unparseable record instead of retrying it forever", () => {
    const driver = countingDriver();
    driver.setItem("app:ui", "}}}not json{{{");

    const persistor = createPersistor({ prefix: "app:", slices: { ui: { driver } as never } });
    const store = makeStore(persistor.enhancer);
    persistor.rehydrate(store);

    expect(store.getState()).toEqual(INITIAL);
    expect(driver.getItem("app:ui")).toBeNull();
  });

  it("rejects a record that is valid JSON but not an envelope", () => {
    const driver = createMemoryDriver();
    driver.setItem("app:ui", JSON.stringify({ theme: "dark" }));

    const persistor = createPersistor({ prefix: "app:", slices: { ui: { driver } as never } });
    const store = makeStore(persistor.enhancer);
    persistor.rehydrate(store);

    expect(store.getState()).toEqual(INITIAL);
  });
});

describe("purge", () => {
  it("removes one slice and cancels its pending write", () => {
    const driver = countingDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver, throttle: 5000 } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "ui/setTheme", theme: "dark" } as never);
    persistor.purge("ui");
    vi.runAllTimers();

    expect(driver.getItem("app:ui")).toBeNull();
    expect(driver.writes).toBe(0);
  });

  it("removes every configured slice when called with no argument", () => {
    const driver = createMemoryDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver } as never, other: { driver } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "ui/setTheme", theme: "dark" } as never);
    store.dispatch({ type: "other/inc" } as never);
    vi.runAllTimers();
    expect(driver.getItem("app:ui")).not.toBeNull();

    persistor.purge();
    expect(driver.getItem("app:ui")).toBeNull();
    expect(driver.getItem("app:other")).toBeNull();
  });
});

describe("cross-tab sync", () => {
  function fireStorage(init: Partial<StorageEvent>) {
    const event = new StorageEvent("storage", {
      key: init.key ?? null,
      newValue: init.newValue ?? null,
      storageArea: init.storageArea ?? window.localStorage,
    });
    window.dispatchEvent(event);
  }

  it("adopts a write made by another tab", () => {
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver: createMemoryDriver(), syncTabs: true } as never },
    });
    const store = makeStore(persistor.enhancer);

    fireStorage({ key: "app:ui", newValue: JSON.stringify({ v: 1, s: { theme: "dark" } }) });
    expect(store.getState().ui.theme).toBe("dark");
  });

  it("ignores events for keys it does not own", () => {
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver: createMemoryDriver(), syncTabs: true } as never },
    });
    const store = makeStore(persistor.enhancer);

    fireStorage({ key: "i18nextLng", newValue: JSON.stringify({ v: 1, s: { theme: "dark" } }) });
    expect(store.getState().ui.theme).toBe("light");
  });

  it("ignores events from a different storage area", () => {
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver: createMemoryDriver(), syncTabs: true } as never },
    });
    const store = makeStore(persistor.enhancer);

    fireStorage({
      key: "app:ui",
      newValue: JSON.stringify({ v: 1, s: { theme: "dark" } }),
      storageArea: window.sessionStorage,
    });
    expect(store.getState().ui.theme).toBe("light");
  });

  it("ignores a removal so a sibling tab's logout does not wipe live state", () => {
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver: createMemoryDriver(), syncTabs: true } as never },
    });
    const store = makeStore(persistor.enhancer);
    store.dispatch({ type: "ui/setTheme", theme: "dark" } as never);

    fireStorage({ key: "app:ui", newValue: null });
    expect(store.getState().ui.theme).toBe("dark");
  });

  it("does not echo back a value it just wrote itself", () => {
    const driver = countingDriver();
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver, syncTabs: true } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "ui/setTheme", theme: "dark" } as never);
    vi.runAllTimers();
    const written = driver.getItem("app:ui");
    const writesAfterOwn = driver.writes;

    fireStorage({ key: "app:ui", newValue: written });
    vi.runAllTimers();

    // No dispatch, therefore no state change, therefore no second write.
    expect(driver.writes).toBe(writesAfterOwn);
  });

  it("attaches no listener when no slice opts in", () => {
    const spy = vi.spyOn(window, "addEventListener");
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver: createMemoryDriver() } as never },
    });
    makeStore(persistor.enhancer);

    expect(spy.mock.calls.filter(([type]) => type === "storage")).toHaveLength(0);
    spy.mockRestore();
  });
});

describe("reducer pass-through", () => {
  it("leaves non-REHYDRATE actions entirely to the wrapped reducer", () => {
    const persistor = createPersistor({
      prefix: "app:",
      slices: { ui: { driver: createMemoryDriver() } as never },
    });
    const store = makeStore(persistor.enhancer);

    store.dispatch({ type: "other/inc" } as never);
    store.dispatch({ type: "other/inc" } as never);
    expect(store.getState().other.n).toBe(2);
  });

  it("does not disturb slices absent from the REHYDRATE payload", () => {
    const driver = createMemoryDriver();
    driver.setItem("app:ui", JSON.stringify({ v: 1, s: { theme: "dark" } }));

    const persistor = createPersistor({ prefix: "app:", slices: { ui: { driver } as never } });
    const store = makeStore(persistor.enhancer);
    store.dispatch({ type: "other/inc" } as never);
    persistor.rehydrate(store);

    expect(store.getState().other.n).toBe(1);
  });
});
