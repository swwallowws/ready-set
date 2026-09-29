// Search the frozen /try/ catalogue: case- and accent-insensitive substring
// match over title and artist. An empty query returns nothing.

const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function searchCatalog(rows, q) {
  const needle = fold(q).trim();
  if (!needle) return [];
  return rows.filter((r) => fold(r.title).includes(needle) || fold(r.artist).includes(needle));
}
