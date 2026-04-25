export async function uploadWithLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];

  const workers = Array.from({ length: limit }).map(async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) break;

      let retries = 5;
      let delay = 500;

      while (retries > 0) {
        try {
          await fn(item);
          break;
        } catch (err) {
          retries -= 1;
          if (retries === 0) throw err;
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 8000);
        }
      }
    }
  });

  await Promise.all(workers);
}
