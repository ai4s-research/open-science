import "@testing-library/jest-dom/vitest";

// DOM stubs — only in a browser-like (jsdom) environment. The node-env tests
// (e.g. the OpenCode integration test) skip these.
if (typeof window !== "undefined") {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  // Web Storage stub. jsdom (25) under Node (>=25) exposes window.localStorage
  // but its methods are not functions, so reads at module init — e.g. the theme
  // and runtime stores — throw "getItem is not a function". Shim an in-memory
  // store so importing those modules doesn't break the suites that touch them.
  if (typeof window.localStorage?.getItem !== "function") {
    const store = new Map<string, string>();
    const shim: Storage = {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      removeItem: (k: string) => {
        store.delete(k);
      },
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
    };
    Object.defineProperty(window, "localStorage", {
      value: shim,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "sessionStorage", {
      value: shim,
      configurable: true,
      writable: true,
    });
  }
}

// Import i18n AFTER the localStorage shim is installed: `@/i18n` calls
// `detectInitialLocale()` at module init, which reads localStorage. A static
// top-of-file `import "@/i18n"` is hoisted above the shim and crashes under
// jsdom 25 / Node 25 where `window.localStorage.getItem` is not yet a function.
await import("@/i18n");
