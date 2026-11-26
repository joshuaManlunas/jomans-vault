export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const results: R[] = [];
  const iterator = items.entries();
  let failed = false;
  const worker = async () => {
    for (const [index, item] of iterator) {
      if (failed) {
        return;
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- Each worker must finish before taking another item.
        results[index] = await fn(item, index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
};
