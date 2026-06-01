/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEMO_PK?: string;
  readonly VITE_DEMO_RECEIVER?: string;
  readonly VITE_RECEIVER_URL?: string;
  readonly VITE_BRIDGE_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
