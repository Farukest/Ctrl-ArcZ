/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEMO_PK?: string;
  readonly VITE_DEMO_RECEIVER?: string;
  readonly VITE_BRIDGE_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injected by vite.config.ts at build time. Empty string when unknown. */
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
