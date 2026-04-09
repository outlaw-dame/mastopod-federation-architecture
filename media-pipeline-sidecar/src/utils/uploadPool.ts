export async function uploadWithLimit(items, limit, fn) {
  const queue = [...items]

  const workers = Array.from({ length: limit }).map(async () => {
    while (queue.length) {
      const item = queue.shift()
      if (!item) break

      let retries = 5
      let delay = 500

      while (retries > 0) {
        try {
          await fn(item)
          break
        } catch (err) {
          retries--
          if (retries === 0) throw err
          await new Promise(r => setTimeout(r, delay))
          delay = Math.min(delay * 2, 8000)
        }
      }
    }
  })

  await Promise.all(workers)
}
