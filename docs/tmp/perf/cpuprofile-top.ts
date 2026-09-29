// Prints the top self-time and inclusive-time functions of a .cpuprofile, restricted to src/.
const file = process.argv[2]!;
const p = await Bun.file(file).json();
const byId = new Map<number, any>(p.nodes.map((n: any) => [n.id, n]));
const self = new Map<number, number>();
const dt: number[] = p.timeDeltas;
p.samples.forEach((id: number, i: number) => self.set(id, (self.get(id) ?? 0) + (dt[i] ?? 0)));
const parent = new Map<number, number>();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const label = (n: any) => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.replace(/^.*\/(src|node_modules)\//, '$1/')}:${n.callFrame.lineNumber + 1}`;
const selfBy = new Map<string, number>(), inclBy = new Map<string, number>();
for (const [id, t] of self) {
  selfBy.set(label(byId.get(id)), (selfBy.get(label(byId.get(id))) ?? 0) + t);
  const seen = new Set<string>();
  for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
    const l = label(byId.get(cur));
    if (seen.has(l)) continue;
    seen.add(l);
    inclBy.set(l, (inclBy.get(l) ?? 0) + t);
  }
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
const show = (m: Map<string, number>, title: string, filter = (_: string) => true) => {
  console.log(`\n${title} (total ${(total / 1000).toFixed(0)} ms)`);
  [...m].filter(([l]) => filter(l)).sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([l, t]) => console.log(`${(t / 1000).toFixed(1).padStart(8)} ms  ${l}`));
};
show(selfBy, 'SELF');
show(inclBy, 'INCLUSIVE (app only)', (l) => l.includes('src/') || l.includes('chunks/') || l.includes('entry.mjs') || l.includes('d1-api'));
