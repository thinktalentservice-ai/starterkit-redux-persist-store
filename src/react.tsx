import { useEffect, useSyncExternalStore } from "react";
import { useStore } from "react-redux";
import type { PersistTargetStore, Persistor } from "./persistor.js";

export type PersistRehydratorProps = {
  persistor: Persistor;
};

/**
 * Renders nothing. Mount it once inside your <Provider>.
 *
 * DELIBERATELY NOT A PersistGate. redux-persist's gate blocks the whole tree
 * until storage has been read, trading a brief state flip for a blank frame.
 * That is the wrong trade for layout preferences: a blank app is more jarring
 * than a sidebar that settles, and the gate does nothing for the flip anyway on
 * a second render pass. Anything that genuinely cannot tolerate the flip should
 * read usePersistRehydrated() and render its own skeleton, or - for state that
 * drives CSS - be applied by a pre-paint script instead of by the store.
 *
 * WHY AN EFFECT AND NOT STORE-CREATION TIME. Under SSR the store module is
 * imported and rendered on the server, where storage does not exist, so the
 * server HTML always reflects initial state. Reading storage before the first
 * client render would make that render disagree with the server markup, which
 * React 19 reports as a hydration failure. Effects run after hydration commits,
 * which is the earliest safe moment.
 */
export function PersistRehydrator({ persistor }: PersistRehydratorProps) {
  const store = useStore();

  useEffect(() => {
    persistor.rehydrate(store as unknown as PersistTargetStore);
  }, [persistor, store]);

  useEffect(() => {
    // `pagehide`, not `beforeunload`. beforeunload does not fire reliably on
    // mobile Safari and disqualifies the page from the back/forward cache;
    // pagehide fires in both the unload and the bfcache-entry cases, which are
    // exactly the two moments a debounced write would otherwise be lost.
    const onHide = () => persistor.flush();
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      // Flush on unmount too. A route change that tears down the provider
      // otherwise drops whatever was still inside the debounce window.
      persistor.flush();
    };
  }, [persistor]);

  return null;
}

/**
 * True once storage has been read and applied.
 *
 * Returns false during SSR and on the first client render - which is the point:
 * both sides of hydration agree, and the value flips in an effect afterwards.
 */
export function usePersistRehydrated(persistor: Persistor): boolean {
  return useSyncExternalStore(
    persistor.subscribe,
    persistor.isRehydrated,
    () => false,
  );
}
