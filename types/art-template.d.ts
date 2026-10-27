declare function artTemplate(
  filename: string,
  data?: unknown,
  options?: artTemplate.ArtTemplateOptions,
): string;

declare namespace artTemplate {
  interface ArtTemplateOptions {
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
  function render(filename: string, data?: unknown, options?: ArtTemplateOptions): string;
  function render(source: string, data?: unknown, options?: ArtTemplateOptions): string;
  function compile(source: string, options?: ArtTemplateOptions): (data?: unknown) => string;
  function defaults(options: ArtTemplateOptions): void;
  export { artTemplate as default };
}

export = artTemplate;
