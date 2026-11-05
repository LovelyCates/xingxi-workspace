// Bound DOM/SVG work independently of collection size. Search and the book still
// cover the full collection; the graph explicitly reports its visible subset.
export function graphSubset(entries, relations, limit = 160, edgeLimit = 500) {
  const degrees = new Map();
  for (const r of relations) {
    degrees.set(r.from_id, (degrees.get(r.from_id) || 0) + 1);
    degrees.set(r.to_id, (degrees.get(r.to_id) || 0) + 1);
  }
  const nodes = [...entries]
    .sort(
      (a, b) =>
        (degrees.get(b.id) || 0) - (degrees.get(a.id) || 0) ||
        a.created_at.localeCompare(b.created_at),
    )
    .slice(0, limit);
  const ids = new Set(nodes.map((e) => e.id));
  const edges = [];
  for (const r of relations) {
    if (edges.length >= edgeLimit) break;
    if (ids.has(r.from_id) && ids.has(r.to_id)) edges.push(r);
  }
  return { nodes, edges };
}
