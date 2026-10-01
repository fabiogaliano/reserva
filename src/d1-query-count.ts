import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

// D1 caps the queries one Worker invocation may run (50 on the Free plan) and counts every
// statement inside a batch() on its own, so this counts at the same grain the cap does.
export function countD1Queries(db: D1Database): { db: D1Database; issued: () => number } {
  let issued = 0;
  // batch() is handed the binding's own statements, not these wrappers: the binding reads their
  // internals, which a proxy only half-forwards.
  const originals = new WeakMap<object, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        if (key === 'first' || key === 'all' || key === 'run' || key === 'raw') {
          return (...args: unknown[]) => {
            issued += 1;
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
    originals.set(wrapped, statement);
    return wrapped;
  };
  const counted = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare') return (query: string) => wrap(target.prepare(query));
      if (key === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          issued += statements.length;
          return target.batch(statements.map((statement) => originals.get(statement) ?? statement));
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: counted, issued: () => issued };
}
