/**
 * Runs fn over items with at most `limit` calls in flight; results keep input order.
 * After any call rejects, no lane starts another item; the returned promise rejects with the
 * first error only once every in-flight call has settled, so no work outlives the caller.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | null = null;
  async function lane(): Promise<void> {
    while (failure === null && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index] as T);
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure !== null) throw (failure as { error: unknown }).error;
  return results;
}
