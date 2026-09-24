// Ambient types for the Vite features this package relies on. Declared inline so
// the library typechecks without taking a direct dependency on vite's types.

interface ImportMeta {
  glob: (
    pattern: string,
    options?: { eager?: boolean; query?: string; import?: string },
  ) => Record<string, unknown>;
  /** Vite's build-time env. Absent under plain Node, hence optional. */
  readonly env?: { readonly VITE_NETWORK?: string; readonly [key: string]: unknown };
}

declare module '*.svg?raw' {
  const content: string;
  export default content;
}
