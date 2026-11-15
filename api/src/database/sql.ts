// TypeORM's raw `query()` on Postgres returns rows for a SELECT, but
// [rows, rowCount] for an UPDATE/DELETE ... RETURNING. This normalises both.
export function rowsOf<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  return result as T[];
}
