/**
 * Global type declarations for the Zotero LLM Assistant plugin.
 *
 * These types are available everywhere in src/ without importing.
 * They mirror the globals injected by bootstrap.js and src/index.ts.
 */

declare const __env__: "development" | "production";

declare const addon: import("../src/addon").default;
declare const ztoolkit: ZToolkit;
declare const _globalThis: typeof globalThis & {
  addon: import("../src/addon").default;
  ztoolkit: ZToolkit;
};

type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit")["createZToolkit"]
>;
