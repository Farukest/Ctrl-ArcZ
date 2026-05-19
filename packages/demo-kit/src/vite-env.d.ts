// Ambient types for the Vite features this package relies on. Declared inline so
// the library typechecks without taking a direct dependency on vite's types.

interface ImportMeta {
  glob: (
    pattern: string,
    options?: { eager?: boolean; query?: string; import?: string },
  ) => Record<string, unknown>;
}

declare module '*.svg?raw' {
  const content: string;
  export default content;
}
