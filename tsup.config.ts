import { defineConfig, type Options } from "tsup";

// Typed as Options rather than inferred: without the annotation TS widens
// `format` to a readonly tuple, which is not assignable to tsup's mutable
// Format[] and fails the typecheck that gates the build.
const shared: Options = {
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  target: "es2020",
  // NOT `treeshake: true`. That option post-processes the bundle through rollup,
  // which strips module-level directives — it would silently remove the
  // "use client" banner on the react entry. esbuild already tree-shakes when
  // bundling, so the option buys nothing. (Same finding as
  // starterkit-button-component/tsup.config.ts.)
  external: ["react", "react-dom", "react-redux", "redux", "@reduxjs/toolkit", "secure-ls"],
  outExtension: ({ format }: { format: string }) => ({
    js: format === "cjs" ? ".cjs" : ".js",
  }),
};

export default defineConfig([
  {
    ...shared,
    // `clean` on the FIRST config only. tsup runs these sequentially and a
    // second clean would delete the first entry's output.
    clean: true,
    entry: { index: "src/index.ts", secure: "src/secure.ts" },
    // DELIBERATELY NO "use client" BANNER. The core and the secure driver are
    // framework-agnostic — a Next.js app must be able to import the persistor
    // type or a driver from a server file without dragging the whole module
    // into the client graph. Only src/react.tsx touches React.
  },
  {
    ...shared,
    clean: false,
    entry: { react: "src/react.tsx" },
    // esbuild strips top-of-file directives, so it is re-attached here.
    // Without it, Next's RSC compiler treats a module that calls useEffect and
    // useSyncExternalStore as a server component and the build fails.
    banner: { js: '"use client";' },
  },
]);
