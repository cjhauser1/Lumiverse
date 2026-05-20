import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const source = process.argv[2];
const outDir = process.argv[3] || join(process.cwd(), "android", "app", "src", "main", "assets", "bun");

if (!source) {
  console.error("Usage: bun run scripts/android/prepare-bun-sidecar.ts <path-to-bun-arm64>");
  process.exit(1);
}

if (!existsSync(source)) {
  console.error(`Source Bun binary not found: ${source}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const out = join(outDir, "bun-arm64");
copyFileSync(source, out);
chmodSync(out, 0o755);

console.log(`Bundled Bun sidecar prepared: ${out}`);
