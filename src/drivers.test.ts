import { describe, expect, it, vi } from "vitest";
import { createMemoryDriver, createNoopDriver, createPlainDriver } from "./drivers.js";

describe("createPlainDriver", () => {
  it("round-trips a value through the given Storage", () => {
    const driver = createPlainDriver(window.localStorage);
    driver.setItem("k", "v");
    expect(driver.getItem("k")).toBe("v");
    driver.removeItem("k");
    expect(driver.getItem("k")).toBeNull();
  });

  it("returns null for an absent key", () => {
    expect(createPlainDriver(window.localStorage).getItem("never-written")).toBeNull();
  });

  it("swallows a throwing setItem instead of taking down the caller", () => {
    // Safari private mode: quota is zero, so every write throws.
    const storage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("QuotaExceededError");
      },
      removeItem: () => {},
    } as unknown as Storage;

    const driver = createPlainDriver(storage);
    expect(() => driver.setItem("k", "v")).not.toThrow();
  });

  it("swallows a throwing getItem and reports it as absent", () => {
    const storage = {
      getItem: () => {
        throw new DOMException("SecurityError");
      },
      setItem: () => {},
      removeItem: () => {},
    } as unknown as Storage;

    expect(createPlainDriver(storage).getItem("k")).toBeNull();
  });

  it("swallows a throwing removeItem", () => {
    const storage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new DOMException("SecurityError");
      },
    } as unknown as Storage;

    expect(() => createPlainDriver(storage).removeItem("k")).not.toThrow();
  });

  it("degrades to a noop when explicitly handed null storage", () => {
    const driver = createPlainDriver(null);
    driver.setItem("k", "v");
    expect(driver.getItem("k")).toBeNull();
  });
});

describe("createNoopDriver", () => {
  it("discards writes and reports every key absent", () => {
    const driver = createNoopDriver();
    driver.setItem("k", "v");
    expect(driver.getItem("k")).toBeNull();
    expect(() => driver.removeItem("k")).not.toThrow();
  });
});

describe("createMemoryDriver", () => {
  it("round-trips without touching the DOM", () => {
    const spy = vi.spyOn(window.localStorage, "setItem");
    const driver = createMemoryDriver();
    driver.setItem("k", "v");
    expect(driver.getItem("k")).toBe("v");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("isolates instances from each other", () => {
    const a = createMemoryDriver();
    const b = createMemoryDriver();
    a.setItem("k", "v");
    expect(b.getItem("k")).toBeNull();
  });
});
