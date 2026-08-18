from pathlib import Path

for raw in [
    "fedify-sidecar/scripts/proof-redis-stream-brotli-compression.ts",
    "fedify-sidecar/scripts/benchmark-redis-stream-brotli-queue-path.ts",
]:
    path = Path(raw)
    text = path.read_text()
    text = text.replace("brotliQuality: 4", "brotliQuality: 1")
    text = text.replace('name: "brotli-4"', 'name: "brotli-1"')
    path.write_text(text)
    print("tuned", path)
