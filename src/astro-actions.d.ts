declare module 'astro:actions' {
  export interface BookkitActionContext {
    request: Request;
    locals: App.Locals;
  }

  export function defineAction<TInput, TOutput>(options: {
    input?: unknown;
    handler: (input: TInput, context: BookkitActionContext) => Promise<TOutput> | TOutput;
  }): string & ((input: TInput) => Promise<TOutput>);
}
