from pathlib import Path

for raw in [
    "fedify-sidecar/scripts/proof-redis-stream-brotli-compression.ts",
    "fedify-sidecar/scripts/benchmark-redis-stream-brotli-queue-path.ts",
]:
    path = Path(raw)
    text = path.read_text()
    text = text.replace("brotliQuality: 1", "brotliQuality: 0")
    text = text.replace('name: "brotli-1"', 'name: "brotli-0"')
    path.write_text(text)
    print("tuned", path)
