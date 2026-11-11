// FILE: index.ts
// Purpose: Author-facing types for the host-injected `window.neolix` bridge inside a sandboxed
//          plugin web view. The host injects `bootstrap.ts`; authors only import these types.
// Layer: Plugin web SDK
// Exports: PluginWebContext and the Window augmentation.

export interface PluginWebContext {
  readonly theme: "light" | "dark";
  readonly locale: string;
  readonly params: Readonly<Record<string, string>>;
  readonly pluginId: string;
  readonly viewId: string;
  readonly permissions: readonly string[];
  /** Timeline item data when the view is a custom timeline renderer. */
  readonly data?: unknown;
}

export interface PluginThemeInfo {
  readonly theme: "light" | "dark";
  readonly variables: Readonly<Record<string, string>>;
}

export interface NeolixPluginWebApi {
  /** Announces the view to the host. The host also posts `init`, so calling this is optional. */
  ready(): void;
  /** The host context for this view: theme, locale, URL params, and granted permissions. */
  getContext(): Promise<PluginWebContext>;
  onReady(listener: (context: PluginWebContext) => void): () => void;
  /** Calls one plugin server RPC declared in the view's manifest `rpcs` list. */
  rpc: {
    invoke(method: string, params?: unknown): Promise<unknown>;
  };
  /** Opens another view of the same plugin. Requires the `navigate` permission. */
  navigate: {
    openView(viewId: string, params?: Readonly<Record<string, string>>): Promise<unknown>;
  };
  /** Requests a new iframe height. Requires the `resize` permission. */
  setHeight(height: number): void;
  onTheme(listener: (info: PluginThemeInfo) => void): () => void;
}

declare global {
  interface Window {
    readonly neolix: NeolixPluginWebApi;
  }
}
