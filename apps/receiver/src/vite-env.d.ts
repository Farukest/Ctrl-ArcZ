/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEMO_PK?: string;
  readonly VITE_GASLESS_ENABLED?: string;
  // VITE_RELAYER_PK / VITE_CLIENT_KEY / VITE_CLIENT_URL are intentionally NOT here:
  // they are read only server-side in vite.config.ts (/api/gasless-claim) and must
  // never be referenced in client code, so they are never inlined into the bundle.
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
