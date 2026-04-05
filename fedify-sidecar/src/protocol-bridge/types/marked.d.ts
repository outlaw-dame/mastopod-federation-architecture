declare module "marked" {
  export const marked: {
    use(options: Record<string, unknown>): void;
    parse(input: string, options?: Record<string, unknown>): string | Promise<string>;
  };
}
