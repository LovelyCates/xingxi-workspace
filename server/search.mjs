// Deterministic terms shared by the persisted index and queries. No model calls.
export function searchTerms(text, singles = false) {
  const tokens = (text.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]+/g) || []).flatMap((s) => {
    if (!/[\u4e00-\u9fff]/.test(s)) return [s];
    const pairs = Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2));
    return singles || s.length === 1 ? [...pairs, ...s] : pairs;
  });
  return [...new Set(tokens)];
}
