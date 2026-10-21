function requiredPairs(factors: Readonly<Record<string, readonly string[]>>, names: string[]) {
  const uncovered = new Map<string, readonly [string, string, string, string]>();
  names.forEach((a, index) => {
    for (const b of names.slice(index + 1))
      for (const av of factors[a])
        for (const bv of factors[b]) uncovered.set(key(a, av, b, bv), [a, av, b, bv]);
  });
  return uncovered;
}

const key = (a: string, av: string, b: string, bv: string) => JSON.stringify([a, av, b, bv]);

/** Deterministic greedy covering array: cover every pair without enumerating the Cartesian product.
 * Ties follow declared factor/value order; the result is reproducible and includes its witnesses.
 */
export function pairwiseRows(factors: Readonly<Record<string, readonly string[]>>) {
  const names = Object.keys(factors);
  if (names.length < 2 || names.some(name => !factors[name].length))
    throw new Error('Pairwise generation needs at least two nonempty factors.');
  const uncovered = requiredPairs(factors, names);
  const pairKeys = (row: Record<string, string>) =>
    names.flatMap((a, index) =>
      names
        .slice(index + 1)
        .flatMap(b =>
          row[a] !== undefined && row[b] !== undefined ? [key(a, row[a], b, row[b])] : []
        )
    );
  const rows: Record<string, string>[] = [];
  while (uncovered.size) {
    const [a, av, b, bv] = uncovered.values().next().value as readonly [
      string,
      string,
      string,
      string,
    ];
    const row: Record<string, string> = { [a]: av, [b]: bv };
    for (const name of names) {
      if (row[name] !== undefined) continue;
      const candidates = factors[name].map(value => ({
        value,
        coverage: pairKeys({ ...row, [name]: value }).filter(pair => uncovered.has(pair)).length,
      }));
      row[name] = candidates.reduce(
        (best, candidate) => (candidate.coverage > best.coverage ? candidate : best),
        candidates[0]
      ).value;
    }
    for (const pair of pairKeys(row)) uncovered.delete(pair);
    rows.push(row);
  }
  return { factors, rows };
}
