// Build a runnable module out of the pure adapter functions in
// extensions/image-gen.ts. The extension itself imports Pi/TUI internals and
// cannot be loaded outside the agent, but the request/response adapters are
// self-contained, so they can be sliced out and exercised with a mocked fetch.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "extensions/image-gen.ts"), "utf8");
const libSource = readFileSync(join(root, "lib/image-models.generated.ts"), "utf8");

function slice(startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`image-gen.ts: missing start marker for ${label}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`image-gen.ts: missing end marker for ${label}`);
  return source.slice(start, end);
}

const imageApi = /export type ImageApi =([\s\S]*?);/.exec(libSource)?.[1]?.trim();
if (!imageApi) throw new Error("lib/image-models.generated.ts: cannot read ImageApi");

const moduleSource = [
  `type ImageApi = ${imageApi};`,
  "type ImageModel = { id: string; name: string; provider: string; baseUrl: string; api: ImageApi; cost: number };",
  slice("interface ProviderConfig {", "async function resolveProviderConfig", "ProviderConfig"),
  slice("interface GeneratedImage {", "function resolveInputImagePath", "GeneratedImage + InputImage"),
  slice("function imageBlob(", "function inputImageDimensions", "imageBlob"),
  slice("const OPENAI_SIZES:", "async function downloadGeminiImageLocally", "sizes + closestAspectRatio"),
  slice("function isGptImageModel(", "/** Detect an image MIME type from magic bytes. */", "isGptImageModel"),
  slice("/** Detect an image MIME type from magic bytes. */", "// ── Tool Parameters", "adapters"),
  'async function downloadGeminiImageLocally(rawUrl: string): Promise<GeneratedImage> {\n  throw new Error(`download stub hit for ${rawUrl}`);\n}',
  `export {
  generateViaOpenAIImages,
  generateViaOpenRouterImages,
  generateViaChatImage,
  collectChatImageCandidates,
};`,
].join("\n\n");

const outDir = join(root, ".runtime");
mkdirSync(outDir, { recursive: true });
const entry = join(outDir, "test-module.ts");
writeFileSync(entry, `${moduleSource}\n`);

function findEsbuild() {
  const candidates = [
    join(root, "node_modules", ".bin", "esbuild"),
    join(process.env.HOME || "", ".pi", "agent", "npm", "node_modules", ".bin", "esbuild"),
    ...execFileSync("sh", ["-c", 'ls -1 "$HOME"/.pi/agent/install/releases/*/node_modules/.bin/esbuild 2>/dev/null || true'])
      .toString()
      .split("\n")
      .filter(Boolean),
  ];
  return candidates.find((candidate) => {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
}

const esbuild = findEsbuild();
if (!esbuild) {
  console.error("esbuild not found. Install it locally (npm i -D esbuild) or via the Pi install.");
  process.exit(1);
}

const outfile = join(outDir, "test-module.mjs");
execFileSync(esbuild, [entry, "--format=esm", `--outfile=${outfile}`, "--log-level=warning"], {
  stdio: "inherit",
});
console.log(`built ${outfile}`);
