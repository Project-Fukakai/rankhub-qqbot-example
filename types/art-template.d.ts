declare module 'art-template' {
  export interface ArtTemplateOptions {
    filename?: string;
    cache?: boolean;
    minimize?: boolean;
    htmlMinifierOptions?: Record<string, unknown>;
    rules?: Array<{ test: RegExp; use: unknown }>;
    escape?: boolean;
    debug?: boolean;
    bail?: boolean;
    imports?: Record<string, unknown>;
  }
  export function render(filename: string, data?: unknown, options?: ArtTemplateOptions): string;
  export function render(source: string, data?: unknown, options?: ArtTemplateOptions): string;
  export function compile(source: string, options?: ArtTemplateOptions): (data?: unknown) => string;
  export function defaults(options: ArtTemplateOptions): void;
  const template: {
    render: typeof render;
    compile: typeof compile;
    defaults: typeof defaults;
  };
  export default template;
}
