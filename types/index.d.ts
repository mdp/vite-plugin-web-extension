import type { Plugin, ChunkMetadata, FilterPattern } from "vite";

interface ViteWebExtensionOptions {
  /**
   * The manifest file to use as a base for the generated extension
   */
  manifest: chrome.runtime.Manifest;

  /**
   * Options for compiling web accessible scripts
   * <https://github.com/rollup/plugins/tree/master/packages/pluginutils#createfilter>
   */
  webAccessibleScripts?: {
    include?: FilterPattern | undefined;
    exclude?: FilterPattern | undefined;
    options?: {
      resolve?: string | false | null | undefined;
    };
  };
}

/**
 * Build cross platform, module-based web extensions using vite
 */
export default function webExtension(options?: ViteWebExtensionOptions): Plugin;

declare module "rollup" {
  export interface RenderedChunk {
    viteMetadata: ChunkMetadata;
  }
}
