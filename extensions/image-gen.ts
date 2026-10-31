/**
 * pi-image-gen — Provider-agnostic image generation extension for Pi.
 *
 * Mirrors Pi's text model architecture:
 * - Built-in models from image-models.generated.ts (build-time discovery)
 * - Custom models via config files (runtime override)
 * - API keys and base URLs resolved via Pi's ModelRegistry
 * - /image-model command for interactive model selection (Pi TUI + Minapi)
 * - Session-persisted selection via pi.appendEntry()
 *
 * API types:
 *   openai-images           — POST /v1/images/generations or /v1/images/edits
 *   google-generative-ai-image — POST generateContent with responseModalities (Google)
 */

import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { getAgentDir, convertToPng, resizeImage } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import {
  Container,
  fuzzyFilter,
  getImageDimensions,
  getKeybindings,
  Input,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { IMAGE_MODELS, type ImageModel, type ImageApi } from "../lib/image-models.generated.js";

const execFileAsync = promisify(execFile);

// ── Image Model Registry ───────────────────────────────────────────
// Mirrors Pi's ModelRegistry: built-in + custom, with provider-aware lookups.

/** All built-in image models flattened */
function getBuiltInModels(): ImageModel[] {
  const models: ImageModel[] = [];
  for (const provider of Object.values(IMAGE_MODELS)) {
    for (const model of Object.values(provider)) {
      models.push(model);
    }
  }
  return models;
}

/** Find a built-in model by provider + id */
function findModel(provider: string, modelId: string): ImageModel | undefined {
  return IMAGE_MODELS[provider]?.[modelId];
}

/** Get all unique provider names that have image models */
function getImageProviders(): string[] {
  return Object.keys(IMAGE_MODELS).sort();
}

/** Get models for a specific provider */
function getModelsForProvider(provider: string): ImageModel[] {
  const providerModels = IMAGE_MODELS[provider];
  if (!providerModels) return [];
  return Object.values(providerModels);
}

// ── Config ─────────────────────────────────────────────────────────

const SAVE_MODES = ["project", "global", "custom"] as const;
type SaveMode = (typeof SAVE_MODES)[number];

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

interface ExtensionConfig {
  save?: SaveMode;
  saveDir?: string;
  defaultProvider?: string;
  defaultModel?: string;
  /** Image generation timeout in seconds. Default: 600 (10 min). */
  timeout?: number;
  /** Image provider definitions. Each key is a provider name; value defines
   *  baseUrl, apiKey, api type, and models. Highest-priority model source. */
  providers?: Record<string, ModelsJsonImageProviderConfig>;
  /** Proxy used by curl when downloading signed Gemini image URLs locally. */
  downloadProxy?: string;
}

/** Strip JSONC syntax — line comments, block comments and trailing commas —
 *  so a commented settings file parses. String contents are left untouched. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += char;
  }

  return out;
}

/** Drop trailing commas without touching strings: `,` followed only by
 *  whitespace before `}` or `]`. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[i + 1] ?? "";
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let lookahead = i + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1;
      if (text[lookahead] === "}" || text[lookahead] === "]") continue;
    }
    out += char;
  }

  return out;
}

function stripJsonc(text: string): string {
  return stripTrailingCommas(stripJsonComments(text));
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(stripJsonc(readFileSync(path, "utf-8"))) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Settings file names accepted in a settings directory, in priority order. */
const CONFIG_FILENAMES = ["pi-image-gen.json", "pi-image-gen.jsonc"] as const;

/** Interactive `/image-model` picks live here so a commented config is never
 *  rewritten (that would discard the comments). */
const MODEL_STATE_FILENAME = "pi-image-gen.state.json";

function settingsDir(): string {
  return join(getAgentDir(), "settings");
}

/** First settings file present in `dir`, `.json` before `.jsonc`. */
function configPathIn(dir: string): string | undefined {
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function globalConfigPath(): string {
  return configPathIn(settingsDir()) ?? join(settingsDir(), CONFIG_FILENAMES[0]);
}

function loadConfig(cwd: string): ExtensionConfig {
  // Defaults chosen via /image-model sit between the global and project files:
  // an explicit project config still wins, a global file does not.
  const globalConfig = {
    ...readJsonFile(globalConfigPath()),
    ...readJsonFile(join(settingsDir(), MODEL_STATE_FILENAME)),
  };
  const projectPath = configPathIn(join(cwd, ".pi", "settings"));
  const projectConfig = projectPath ? readJsonFile(projectPath) : {};
  const globalProviders = (globalConfig.providers || {}) as Record<string, unknown>;
  const projectProviders = (projectConfig.providers || {}) as Record<string, unknown>;
  return {
    ...globalConfig,
    ...projectConfig,
    providers: { ...globalProviders, ...projectProviders },
  } as ExtensionConfig;
}

/** Persist model selection so it survives across sessions. */
async function saveDefaultModel(provider: string, modelId: string): Promise<void> {
  const path = join(settingsDir(), MODEL_STATE_FILENAME);
  const existing = readJsonFile(path);
  existing.defaultProvider = provider;
  existing.defaultModel = modelId;
  await mkdir(settingsDir(), { recursive: true });
  await writeFile(path, JSON.stringify(existing, null, 2));
}

// ── models.json Integration ────────────────────────────────────────
// Read Pi's models.json and extract models with output: ["image"].
// Pi's ajv validation allows additional properties, so users can add
// `output: ["image"]` to any model definition and Pi ignores it while
// pi-image-gen picks it up.
//
// models.json format:
// {
//   "providers": {
//     "my-relay": {
//       "baseUrl": "https://relay.example/v1",
//       "models": [
//         { "id": "my-image-model", "name": "My Image Model", "output": ["image"] }
//       ]
//     }
//   }
// }

interface ModelsJsonModelDef {
  id: string;
  name?: string;
  api?: string;
  output?: string[];
  /** Legacy explicit image API override in providers[].models[] */
  imageApi?: ImageApi;
  /** Legacy cost per image in USD in providers[].models[] */
  imageCost?: number;
  [key: string]: unknown;
}

interface ModelsJsonImageModelDef {
  id: string;
  name?: string;
  api?: ImageApi;
  cost?: number;
}

interface ModelsJsonProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  models?: ModelsJsonModelDef[];
  modelOverrides?: Record<string, { output?: string[]; [key: string]: unknown }>;
}

interface ModelsJsonImageProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: ImageApi;
  /** OpenAI Images response format. Use b64_json when the server owns signed-media authentication. */
  responseFormat?: "url" | "b64_json";
  models?: ModelsJsonImageModelDef[];
}

interface ModelsJsonConfig {
  providers?: Record<string, ModelsJsonProviderConfig>;
}

/** Infer the image API from the provider name and model api field.
 *
 * Everything OpenAI-compatible uses `POST /images/generations`, which is the
 * only OpenAI-style image endpoint this extension speaks. */
function inferLegacyImageApi(provider: string, apiField?: string): ImageApi {
  if (provider === "google") return "google-generative-ai-image";
  if (apiField?.includes("google")) return "google-generative-ai-image";
  return "openai-images";
}

function readModelsJson(): Partial<ModelsJsonConfig> {
  const modelsJsonPath = join(getAgentDir(), "models.json");
  return readJsonFile(modelsJsonPath) as Partial<ModelsJsonConfig>;
}

/** Fallback API key lookup for providers defined in models.json providers section */
function getModelsJsonApiKeyForProvider(provider: string): string | undefined {
  const raw = readModelsJson();
  return raw.providers?.[provider]?.apiKey;
}

/** Read Pi's models.json and extract image-capable models from the legacy
 *  providers.<provider>.models[] with output:["image"] format. */
function getModelsJsonImageModels(): ImageModel[] {
  const raw = readModelsJson();
  const models = new Map<string, ImageModel>();

  if (raw.providers) {
    for (const [provider, config] of Object.entries(raw.providers)) {
      const baseUrl = config.baseUrl || "";

      if (config.models) {
        for (const modelDef of config.models) {
          if (!modelDef.output?.includes("image")) continue;
          const model: ImageModel = {
            id: modelDef.id,
            name: modelDef.name || modelDef.id,
            provider,
            baseUrl,
            api: modelDef.imageApi || inferLegacyImageApi(provider, modelDef.api),
            cost: modelDef.imageCost || 0,
          };
          models.set(`${provider}/${modelDef.id}`, model);
        }
      }

      if (config.modelOverrides) {
        for (const [modelId, override] of Object.entries(config.modelOverrides)) {
          if (!override.output?.includes("image")) continue;
          if (config.models?.some((m) => m.id === modelId)) continue;
          const model: ImageModel = {
            id: modelId,
            name: modelId,
            provider,
            baseUrl,
            api: inferLegacyImageApi(provider, undefined),
            cost: 0,
          };
          models.set(`${provider}/${modelId}`, model);
        }
      }
    }
  }

  return [...models.values()];
}

/** Read image models from the settings file's providers section. */
function getSettingsImageModels(config: ExtensionConfig): ImageModel[] {
  if (!config.providers) return [];
  const models = new Map<string, ImageModel>();

  for (const [provider, providerConfig] of Object.entries(config.providers)) {
    const baseUrl = providerConfig.baseUrl || "";
    const providerApi = providerConfig.api || inferLegacyImageApi(provider);

    if (!providerConfig.models) continue;
    for (const modelDef of providerConfig.models) {
      models.set(`${provider}/${modelDef.id}`, {
        id: modelDef.id,
        name: modelDef.name || modelDef.id,
        provider,
        baseUrl,
        api: modelDef.api || providerApi,
        cost: modelDef.cost || 0,
      });
    }
  }

  return [...models.values()];
}

/** Merge model sources, with explicit settings acting as the catalog override. */
function getAllModels(config: ExtensionConfig): ImageModel[] {
  const configuredModels = getSettingsImageModels(config);
  if (configuredModels.length > 0) return configuredModels;

  const models = new Map<string, ImageModel>();

  // Built-in generated models (lowest priority)
  for (const m of getBuiltInModels()) {
    models.set(`${m.provider}/${m.id}`, m);
  }

  // Pi's models.json — legacy output:["image"] entries
  for (const m of getModelsJsonImageModels()) {
    models.set(`${m.provider}/${m.id}`, m);
  }

  return [...models.values()];
}

// ── Save Logic ─────────────────────────────────────────────────────

function resolveSaveConfig(save: string | undefined, saveDir: string | undefined, cwd: string, config: ExtensionConfig): { mode: SaveMode; outputDir?: string } {
  // Images are always persisted locally. Legacy save=none falls back to project storage.
  const requestedMode = save || config.save;
  const mode: SaveMode = requestedMode === "global" || requestedMode === "custom" ? requestedMode : "project";

  if (mode === "project") return { mode, outputDir: join(cwd, ".pi", "generated-images") };
  if (mode === "global") return { mode, outputDir: join(getAgentDir(), "generated-images") };
  if (mode === "custom") {
    const dir = saveDir || config.saveDir;
    if (!dir?.trim()) throw new Error("save=custom requires saveDir parameter or saveDir in config.");
    return { mode, outputDir: dir };
  }
  throw new Error(`Unsupported save mode: ${String(requestedMode)}`);
}

function imageExtension(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("gif")) return "gif";
  if (lower.includes("webp")) return "webp";
  return "png";
}

async function saveImageToDisk(base64Data: string, mimeType: string, outputDir: string): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const ext = imageExtension(mimeType);
  const filename = `image-${timestamp}-${randomUUID().slice(0, 8)}.${ext}`;
  const filePath = join(outputDir, filename);
  await writeFile(filePath, Buffer.from(base64Data, "base64"));
  return filePath;
}

/**
 * Models often turn a file:// URL from the tool result into a bare absolute
 * path in their final Markdown response. OSC 8 needs a URL scheme for
 * terminals such as iTerm2 to open the target with Command-click.
 */
function normalizeLocalMarkdownLinks(text: string): string {
  let normalized = text.replace(/\]\(<(\/[^>\r\n]+)>\)/g, (_match, rawPath: string) =>
    `](${pathToFileURL(rawPath).href})`,
  );
  normalized = normalized.replace(/\]\((\/[^)\r\n]+)\)/g, (_match, rawPath: string) =>
    `](${pathToFileURL(rawPath).href})`,
  );
  return normalized;
}

// ── Provider Config Resolution ─────────────────────────────────────

interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  downloadProxy?: string;
  responseFormat?: "url" | "b64_json";
}

async function resolveProviderConfig(
  imageModel: ImageModel,
  ctx: ExtensionContext,
  config: ExtensionConfig,
): Promise<ProviderConfig> {
  // Resolution order: Pi's ModelRegistry → settings providers → models.json providers
  let apiKey = await ctx.modelRegistry.getApiKeyForProvider(imageModel.provider);
  if (!apiKey) {
    apiKey = config.providers?.[imageModel.provider]?.apiKey;
  }
  if (!apiKey) {
    apiKey = getModelsJsonApiKeyForProvider(imageModel.provider);
  }
  if (!apiKey) {
    throw new Error(
      `No API key for provider "${imageModel.provider}". ` +
      `Set it in environment, /login, or add apiKey to providers.${imageModel.provider} in ~/.pi/agent/settings/pi-image-gen.json.`,
    );
  }

  // Use model's baseUrl, or fall back to Pi's registry for the provider
  let baseUrl = imageModel.baseUrl;
  if (!baseUrl) {
    const allModels = ctx.modelRegistry.getAll();
    const textModel = allModels.find((m) => m.provider === imageModel.provider);
    baseUrl = textModel?.baseUrl || "";
  }

  if (!baseUrl) {
    throw new Error(`No base URL for provider "${imageModel.provider}".`);
  }

  return {
    apiKey,
    baseUrl,
    downloadProxy: config.downloadProxy,
    responseFormat: config.providers?.[imageModel.provider]?.responseFormat,
  };
}

// ── Image Generation by API Type ───────────────────────────────────

interface GeneratedImage {
  data: string;       // base64
  mimeType: string;
}

interface InputImage {
  data: Buffer;
  filename: string;
  mimeType: string;
}

function resolveInputImagePath(inputPath: string, cwd: string): string {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("Image path cannot be empty.");
  if (trimmed.startsWith("file://")) return fileURLToPath(trimmed);
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

function detectInputImageMimeType(data: Buffer, filePath: string): string {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "image/jpeg";
  }
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }

  const lowerPath = filePath.toLowerCase();
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) return "image/jpeg";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  throw new Error(`Unsupported image format for "${filePath}". Use PNG, JPEG, or WebP.`);
}

async function loadInputImage(inputPath: string, cwd: string, label: string): Promise<InputImage> {
  const resolvedPath = resolveInputImagePath(inputPath, cwd);
  let data: Buffer;
  try {
    data = await readFile(resolvedPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read ${label} "${resolvedPath}": ${detail}`);
  }
  if (data.length === 0) throw new Error(`${label} "${resolvedPath}" is empty.`);

  return {
    data,
    filename: basename(resolvedPath),
    mimeType: detectInputImageMimeType(data, resolvedPath),
  };
}

function imageBlob(image: InputImage): Blob {
  const bytes = new Uint8Array(new ArrayBuffer(image.data.length));
  bytes.set(image.data);
  return new Blob([bytes.buffer], { type: image.mimeType });
}

function inputImageDimensions(inputImage: InputImage): { widthPx: number; heightPx: number } {
  const dimensions = getImageDimensions(inputImage.data.toString("base64"), inputImage.mimeType);
  if (!dimensions || dimensions.widthPx < 1 || dimensions.heightPx < 1) {
    throw new Error(`Cannot determine dimensions for "${inputImage.filename}".`);
  }
  return dimensions;
}

async function nextMaskPath(cwd: string, config: ExtensionConfig): Promise<string> {
  const saveConfig = resolveSaveConfig(undefined, undefined, cwd, config);
  const outputDir = saveConfig.outputDir || join(cwd, ".pi", "generated-images");
  await mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(outputDir, `mask-${timestamp}-${randomUUID().slice(0, 8)}.png`);
}

/**
 * Launch the internal browser canvas selector and wait for the user to draw
 * freehand lasso shapes. The helper prints the generated mask path on stdout.
 * The browser canvas gives pixel-level precision and also works in terminals
 * without inline-image support.
 */
async function selectMaskWithBrowser(
  imagePath: string,
  cwd: string,
  config: ExtensionConfig,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<string | "canceled"> {
  const helperPath = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "mask-selector.mjs");
  if (!existsSync(helperPath)) {
    throw new Error(`Browser mask helper not found at ${helperPath}. Reinstall the package.`);
  }

  const seconds = Math.max(1, Math.floor(timeoutSeconds));
  const maskPath = await nextMaskPath(cwd, config);
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [helperPath, imagePath, "-o", maskPath, "--timeout", String(seconds)],
      {
        signal,
        timeout: (seconds + 10) * 1000,
        maxBuffer: 1024 * 1024,
      },
    );
    const output = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    return output || maskPath;
  } catch (error) {
    const stderr = typeof (error as { stderr?: unknown })?.stderr === "string"
      ? (error as { stderr: string }).stderr.trim()
      : "";
    const detail = `${error instanceof Error ? error.message : String(error)}${stderr ? `\n${stderr}` : ""}`;
    if (/Selection canceled/i.test(detail)) return "canceled";
    if (error instanceof Error && (
      error.name === "AbortError"
      || (error as NodeJS.ErrnoException).code === "ABORT_ERR"
    )) throw error;
    throw new Error(`Browser mask selector failed: ${detail}`);
  }
}

/**
 * Match Pi's read-tool image path: resize large results and normalize the
 * returned attachment to PNG so Kitty terminals do not depend on a later
 * asynchronous JPEG/WebP transcoder inside the TUI.
 */
async function prepareImageForTui(image: GeneratedImage): Promise<GeneratedImage> {
  try {
    const resized = await resizeImage(
      new Uint8Array(Buffer.from(image.data, "base64")),
      image.mimeType,
      { maxWidth: 1200, maxHeight: 1200, maxBytes: 2 * 1024 * 1024 },
    );
    if (!resized) return image;
    const png = await convertToPng(resized.data, resized.mimeType);
    return png || { data: resized.data, mimeType: resized.mimeType };
  } catch {
    // Keep the original provider result available if local image processing fails.
    return image;
  }
}

// OpenAI size mapping from aspect ratios
const OPENAI_SIZES: Record<string, string> = {
  "1:1": "1024x1024",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  "4:3": "1536x1024",
  "3:4": "1024x1536",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
};

/** Pick the supported ratio closest to the source image when editing. */
function closestAspectRatio(inputImage: InputImage): string {
  const { widthPx, heightPx } = inputImageDimensions(inputImage);
  const target = widthPx / heightPx;
  let bestRatio = "1:1";
  let bestDistance = Infinity;
  for (const ratio of Object.keys(OPENAI_SIZES)) {
    const [width, height] = ratio.split(":").map(Number);
    if (!width || !height) continue;
    const distance = Math.abs(Math.log((width / height) / target));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestRatio = ratio;
    }
  }
  return bestRatio;
}

async function downloadGeminiImageLocally(
  rawUrl: string,
  proxy: string | undefined,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  const debugUrlFile = process.env.PI_IMAGE_DEBUG_URL_FILE;
  if (debugUrlFile) {
    await writeFile(debugUrlFile, rawUrl, { encoding: "utf8", mode: 0o600 });
  }
  const allowedHosts = new Set([
    "lh3.googleusercontent.com",
    "lh3.google.com",
    "work.fife.usercontent.google.com",
  ]);
  const validateUrl = (value: string): URL => {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) {
      throw new Error("Gemini image URL host is not allowed");
    }
    return parsed;
  };
  const withWebVariant = (value: string): string => {
    const parsed = validateUrl(value);
    if ((parsed.pathname.startsWith("/gg/") || parsed.pathname.startsWith("/gg-dl/"))
        && !parsed.pathname.split("/").pop()?.includes("=")) {
      parsed.pathname += "=d-I";
    }
    parsed.searchParams.set("alr", "yes");
    return parsed.toString();
  };
  const parseHeaders = (text: string): { status: number; contentType: string; location?: string } => {
    const blocks = text.split(/\r?\n\r?\n/).filter(Boolean);
    const block = blocks.at(-1) || text;
    const statusMatch = block.match(/^HTTP\/\S+\s+(\d+)/m);
    if (!statusMatch) throw new Error("curl returned no HTTP status");
    const headerMap = new Map<string, string>();
    for (const line of block.split(/\r?\n/).slice(1)) {
      const separator = line.indexOf(":");
      if (separator > 0) headerMap.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim());
    }
    return {
      status: Number(statusMatch[1]),
      contentType: (headerMap.get("content-type") || "").split(";", 1)[0].toLowerCase(),
      location: headerMap.get("location"),
    };
  };

  const directory = await mkdtemp(join(tmpdir(), "pi-image-gen-"));
  const cookieJarPath = join(directory, "cookies.txt");
  let current = withWebVariant(rawUrl);
  try {
    for (let hop = 0; hop <= 3; hop += 1) {
      const headerPath = join(directory, "headers");
      const bodyPath = join(directory, "body");
      const requestHost = new URL(current).hostname;
      const sameSiteMediator = requestHost.endsWith(".usercontent.google.com");
      const fetchSite = sameSiteMediator ? "same-site" : "cross-site";
      const args = [
        "--silent", "--show-error", "--http2", "--compressed", "--max-time", "90", "--connect-timeout", "20",
        "--dump-header", headerPath, "--output", bodyPath,
        "--cookie", cookieJarPath, "--cookie-jar", cookieJarPath,
        "-H", "accept: */*",
        "-H", "accept-language: zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7",
        "-H", "cache-control: no-cache",
        "-H", "origin: https://gemini.google.com",
        "-H", "pragma: no-cache",
        "-H", "referer: https://gemini.google.com/",
        "-H", "priority: u=1, i",
        "-H", "sec-ch-ua: \"Google Chrome\";v=\"155\", \"Chromium\";v=\"155\", \"Not(A:Brand\";v=\"24\"",
        "-H", "sec-ch-ua-arch: \"arm\"",
        "-H", "sec-ch-ua-bitness: \"64\"",
        "-H", "sec-ch-ua-form-factors: \"Desktop\"",
        "-H", "sec-ch-ua-full-version: \"155.0.8059.80\"",
        "-H", "sec-ch-ua-full-version-list: \"Google Chrome\";v=\"155.0.8059.80\", \"Chromium\";v=\"155.0.8059.80\", \"Not(A:Brand\";v=\"24.0.0.0\"",
        "-H", "sec-ch-ua-mobile: ?0",
        "-H", "sec-ch-ua-model: \"\"",
        "-H", "sec-ch-ua-platform: \"macOS\"",
        "-H", "sec-ch-ua-platform-version: \"15.3.2\"",
        "-H", "sec-ch-ua-wow64: ?0",
        "-H", "sec-fetch-dest: empty",
        "-H", "sec-fetch-mode: cors",
        "-H", `sec-fetch-site: ${fetchSite}`,
        ...(sameSiteMediator ? [] : ["-H", "sec-fetch-storage-access: active"]),
        "-H", "x-browser-channel: stable",
        "-H", "x-browser-copyright: Copyright 2026 Google LLC. All Rights Reserved.",
        "-H", "x-browser-validation: YXjt/if5gRhK4M5qXvb22nUeBck=",
        "-H", "x-browser-year: 2026",
        "-H", "x-client-data: CKmdygEIlaHLAQiGoM0B",
        "-H", "user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.8059.80 Safari/537.36",
      ];
      if (proxy) args.push("--proxy", proxy);
      args.push("--url", current);
      await execFileAsync("curl", args, { signal, maxBuffer: 1024 * 1024 });
      const result = parseHeaders(await readFile(headerPath, "utf8"));
      const body = await readFile(bodyPath);
      const currentUrl = new URL(current);
      const pathHash = createHash("sha256").update(currentUrl.pathname).digest("hex").slice(0, 12);
      console.error(
        `[pi-image-gen] download hop=${hop} host=${currentUrl.hostname} path_len=${currentUrl.pathname.length} path_sha256=${pathHash} status=${result.status} mime=${result.contentType || "-"} bytes=${body.length}`,
      );
      if (result.status >= 300 && result.status < 400 && result.location) {
        current = withWebVariant(new URL(result.location, current).toString());
        continue;
      }
      if (result.status !== 200) throw new Error(`Gemini image download failed (${result.status})`);
      if (result.contentType === "image/jpeg" || result.contentType === "image/png" || result.contentType === "image/webp") {
        return { data: body.toString("base64"), mimeType: result.contentType };
      }
      if (result.contentType === "text/plain") {
        const nextUrl = body.toString("utf8").trim();
        current = withWebVariant(nextUrl);
        continue;
      }
      throw new Error(`Gemini image download returned ${result.contentType || "unknown content"}`);
    }
    throw new Error("Gemini image download exceeded hop limit");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function isGptImageModel(modelId: string): boolean {
  return modelId.startsWith("gpt-image-") || modelId === "chatgpt-image-latest";
}

/** Detect an image MIME type from magic bytes. */
function sniffImageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  return undefined;
}

/** Parse a `data:<mime>[;base64],<payload>` URL into base64 + mime. */
function parseDataUrl(value: string): GeneratedImage | undefined {
  const trimmed = value.trim();
  const comma = trimmed.indexOf(",");
  if (comma < 0 || !trimmed.slice(0, comma).toLowerCase().startsWith("data:")) return undefined;
  const header = trimmed.slice(0, comma);
  const mimeType = header.slice("data:".length).split(";", 1)[0] || "image/png";
  if (!mimeType.startsWith("image/")) return undefined;
  const payload = trimmed.slice(comma + 1);
  if (header.toLowerCase().includes(";base64")) {
    return { data: payload.replace(/\s+/g, ""), mimeType };
  }
  return { data: Buffer.from(decodeURIComponent(payload), "binary").toString("base64"), mimeType };
}

/** Hosts whose signed media URLs reject plain requests and need the Chrome transport. */
const GOOGLE_MEDIA_HOSTS = new Set([
  "lh3.googleusercontent.com",
  "lh3.google.com",
  "work.fife.usercontent.google.com",
]);

/** Materialize a data URL, or download an http(s) image into base64 + mime.
 *
 * Plain `fetch` covers any OpenAI-compatible CDN, which is what a standard
 * `data[].url` response points at. Signed Gemini media hosts are the exception:
 * they only answer the browser-shaped request, so they fall back to curl.
 */
async function downloadImageUrl(
  url: string,
  options: { signal?: AbortSignal; downloadProxy?: string } = {},
): Promise<GeneratedImage> {
  const inline = parseDataUrl(url);
  if (inline) return inline;
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Unsupported image reference: expected an http(s) URL or a base64 data URL.");
  }

  const host = new URL(url).hostname;
  try {
    const response = await fetch(url, { signal: options.signal });
    if (!response.ok) throw new Error(`Image download failed (${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    return {
      data: buffer.toString("base64"),
      mimeType: contentType.startsWith("image/") ? contentType : sniffImageMime(buffer) || "image/png",
    };
  } catch (error) {
    if (!GOOGLE_MEDIA_HOSTS.has(host)) throw error;
    return downloadGeminiImageLocally(url, options.downloadProxy, options.signal);
  }
}

/** OpenAI /v1/images/generations and /v1/images/edits endpoints */
async function generateViaOpenAIImages(
  config: ProviderConfig,
  model: ImageModel,
  prompt: string,
  aspectRatio: string,
  quality: string,
  inputImage?: InputImage,
  maskImage?: InputImage,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  const size = OPENAI_SIZES[aspectRatio] || "1024x1024";
  const operation = inputImage ? "image edit" : "image generation";
  const endpoint = inputImage ? "edits" : "generations";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
  };
  let requestBody: string | FormData;

  if (inputImage) {
    const form = new FormData();
    form.append("model", model.id);
    form.append("prompt", prompt);
    form.append("n", "1");
    form.append("size", size);
    if (!isGptImageModel(model.id)) form.append("response_format", config.responseFormat || "url");
    if (isGptImageModel(model.id)) form.append("quality", quality);
    if (model.id === "dall-e-3") form.append("quality", quality === "high" ? "hd" : "standard");
    form.append("image", imageBlob(inputImage), inputImage.filename);
    if (maskImage) {
      form.append("mask", imageBlob(maskImage), maskImage.filename);
    }
    requestBody = form;
  } else {
    const body: Record<string, unknown> = {
      model: model.id,
      prompt,
      n: 1,
      size,
    };
    if (!isGptImageModel(model.id)) body.response_format = config.responseFormat || "url";
    if (isGptImageModel(model.id)) body.quality = quality;
    if (model.id === "dall-e-3") body.quality = quality === "high" ? "hd" : "standard";
    headers["Content-Type"] = "application/json";
    requestBody = JSON.stringify(body);
  }

  const response = await fetch(`${config.baseUrl}/images/${endpoint}`, {
    method: "POST",
    headers,
    body: requestBody,
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI ${operation} failed (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as {
    data?: Array<{ b64_json?: string; url?: string; media_type?: string }>;
  };
  const image = result.data?.[0];
  if (image?.b64_json) {
    const bytes = Buffer.from(image.b64_json, "base64");
    return {
      data: image.b64_json,
      mimeType: image.media_type?.split(";", 1)[0] || sniffImageMime(bytes) || "image/png",
    };
  }
  if (image?.url) {
    // Standard behaviour: honour the URL as given. Relays usually hand back a
    // server-owned data URL; anything else is just fetched.
    return downloadImageUrl(image.url, { signal, downloadProxy: config.downloadProxy });
  }
  throw new Error(`OpenAI ${operation} returned no image data`);
}

/** Google Gemini image generation.
 *
 * Two request shapes share this API type:
 * - Imagen models (`imagen-*`) use `:predict` with `instances`/`parameters`.
 * - Gemini image models use `:generateContent` with `responseModalities`.
 */
async function generateViaGoogleImage(
  config: ProviderConfig,
  model: ImageModel,
  prompt: string,
  aspectRatio: string,
  imageSize: string,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  return model.id.startsWith("imagen-")
    ? generateViaImagenPredict(config, model, prompt, aspectRatio, signal)
    : generateViaGeminiGenerateContent(config, model, prompt, aspectRatio, imageSize, signal);
}

/** Imagen: POST {baseUrl}/models/{id}:predict */
async function generateViaImagenPredict(
  config: ProviderConfig,
  model: ImageModel,
  prompt: string,
  aspectRatio: string,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  // Imagen only accepts this subset; anything else keeps the model default.
  const IMAGEN_RATIOS = new Set(["1:1", "3:4", "4:3", "9:16", "16:9"]);
  const parameters: Record<string, unknown> = { sampleCount: 1 };
  if (aspectRatio && IMAGEN_RATIOS.has(aspectRatio)) parameters.aspectRatio = aspectRatio;

  const response = await fetch(
    `${config.baseUrl}/models/${model.id}:predict?key=${config.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt }], parameters }),
      signal,
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Imagen image generation failed (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as {
    predictions?: Array<{ bytesBase64Encoded?: string; mimeType?: string }>;
  };
  const prediction = result.predictions?.[0];
  if (prediction?.bytesBase64Encoded) {
    return {
      data: prediction.bytesBase64Encoded,
      mimeType: prediction.mimeType || "image/png",
    };
  }
  throw new Error("Imagen returned no image data (expected predictions[0].bytesBase64Encoded)");
}

/** Gemini image models: POST {baseUrl}/models/{id}:generateContent */
async function generateViaGeminiGenerateContent(
  config: ProviderConfig,
  model: ImageModel,
  prompt: string,
  aspectRatio: string,
  imageSize: string,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  const imageConfig: Record<string, string> = {};
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
  if (imageSize) imageConfig.imageSize = imageSize;

  const generationConfig: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
  if (Object.keys(imageConfig).length > 0) generationConfig.imageConfig = imageConfig;

  const response = await fetch(
    `${config.baseUrl}/models/${model.id}:generateContent?key=${config.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig,
      }),
      signal,
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google image generation failed (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
    }>;
  };

  const parts = result.candidates?.[0]?.content?.parts;
  if (!parts) throw new Error("Google returned no content");
  for (const part of parts) {
    if (part.inlineData?.data) {
      return { data: part.inlineData.data, mimeType: part.inlineData.mimeType || "image/png" };
    }
  }
  throw new Error("Google returned no image data");
}

/** Route to the appropriate generation or edit method based on model's API type */
async function generateImage(
  config: ProviderConfig,
  model: ImageModel,
  prompt: string,
  aspectRatio: string,
  imageSize: string,
  quality: string,
  inputImage?: InputImage,
  maskImage?: InputImage,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  if (inputImage && model.api !== "openai-images") {
    throw new Error(
      `Image editing currently requires a model configured with api: "openai-images"; "${model.api}" does not expose /images/edits.`,
    );
  }

  switch (model.api) {
    case "openai-images":
      return generateViaOpenAIImages(config, model, prompt, aspectRatio, quality, inputImage, maskImage, signal);
    case "google-generative-ai-image":
      return generateViaGoogleImage(config, model, prompt, aspectRatio, imageSize, signal);
    default:
      throw new Error(`Unknown image API type: ${model.api}`);
  }
}

// ── Model Resolution ───────────────────────────────────────────────

interface ModelSelection {
  provider: string;
  model: string;
}

function resolveModel(
  sessionSelection: ModelSelection | null,
  config: ExtensionConfig,
): ImageModel {
  const allModels = getAllModels(config);

  // 1. Session selection (set via /image-model)
  if (sessionSelection) {
    const found = allModels.find(
      (m) => m.provider === sessionSelection.provider && m.id === sessionSelection.model,
    );
    if (found) return found;
  }

  // 2. Config defaults
  if (config.defaultModel) {
    const found = allModels.find((m) => m.id === config.defaultModel);
    if (found) return found;
  }
  if (config.defaultProvider) {
    const providerModels = allModels.filter((m) => m.provider === config.defaultProvider);
    if (providerModels.length > 0) return providerModels[0];
  }

  // 3. Default: first OpenAI model, then anything
  const openaiModels = allModels.filter((m) => m.provider === "openai");
  if (openaiModels.length > 0) return openaiModels[0];
  if (allModels.length > 0) return allModels[0];

  throw new Error("No image models available. Run /image-model to select one.");
}

// ── Session State ──────────────────────────────────────────────────

const SESSION_ENTRY_TYPE = "pi-image-gen:model-select";

// ── Tool Parameters ────────────────────────────────────────────────

const TOOL_PARAMS = Type.Object({
  prompt: Type.String({ description: "Description of the image to generate or edit. After a region is selected, this is offered as the suggested prompt; the user can accept it or write a custom prompt." }),
  imagePath: Type.Optional(Type.String({
    description: "Local path (or file:// URL) of an input image for image-to-image editing. Requires an openai-images model. In interactive TUI mode, omit maskPath and the tool will ask whether to launch a region selector first.",
  })),
  maskPath: Type.Optional(Type.String({
    description: "Optional prepared mask image for local editing. Requires imagePath. Omit this to be asked whether to select an area interactively.",
  })),
  aspectRatio: Type.Optional(Type.String({
    description: "Aspect ratio: 1:1 (default for generation), 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9. For edits, defaults to the input image's nearest supported ratio.",
  })),
  imageSize: Type.Optional(Type.String({
    description: "Image resolution: 1K (1024x1024, default), 2K, 4K. Provider-dependent.",
  })),
  quality: Type.Optional(Type.String({
    description: "Image quality: auto (default), low, medium, high. Sent for gpt-image/DALL-E models.",
  })),
  save: Type.Optional(Type.String({
    description: "Save mode: project (default), global, or custom. Images are always saved locally.",
  })),
  saveDir: Type.Optional(Type.String({
    description: "Directory to save image when save=custom.",
  })),
  timeout: Type.Optional(Type.Number({
    description: "Generation timeout in seconds. Default: 600 (10 min).",
  })),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

// ── Extension Entry Point ──────────────────────────────────────────

export default function piImageGen(pi: ExtensionAPI) {
  let sessionSelection: ModelSelection | null = null;

  // Models sometimes rewrite the tool's file:// URL as a bare absolute path
  // in their final Markdown answer. Normalize it before Pi renders and saves
  // the assistant message so OSC 8 and Command-click receive a real file URL.
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;

    let changed = false;
    const content = event.message.content.map((block) => {
      if (block.type !== "text") return block;
      const text = normalizeLocalMarkdownLinks(block.text);
      if (text === block.text) return block;
      changed = true;
      return { ...block, text };
    });

    if (changed) return { message: { ...event.message, content } };
  });

  // ── Restore state from session ──
  pi.on("session_start", async (_event, ctx) => {
    // Restore session model selection from branch entries, then fall back to saved config
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === SESSION_ENTRY_TYPE) {
        const data = entry.data as ModelSelection | undefined;
        if (data?.provider && data?.model) {
          sessionSelection = data;
        }
      }
    }
    if (!sessionSelection) {
      const config = loadConfig(ctx.cwd);
      if (config.defaultProvider && config.defaultModel) {
        sessionSelection = { provider: config.defaultProvider, model: config.defaultModel };
      }
    }
  });

  // ── /image-model command ──

  pi.registerCommand("image-model", {
    description: "Select the default image generation model",

    getArgumentCompletions(prefix: string) {
      const config = loadConfig(process.cwd());
      const models = getAllModels(config);
      return models
        .map((m) => `${m.provider}/${m.id}`)
        .filter((label) => label.startsWith(prefix))
        .map((label) => {
          const model = models.find((m) => `${m.provider}/${m.id}` === label)!;
          return { value: label, label: `${model.name} (${model.provider})` };
        });
    },

    async handler(args: string, ctx) {
      const config = loadConfig(ctx.cwd);
      const allModels = getAllModels(config);

      // Direct selection: /image-model openai/gpt-image-1
      if (args.trim()) {
        const input = args.trim();
        // Try "provider/model" format
        const slashIdx = input.indexOf("/");
        let found: ImageModel | undefined;
        if (slashIdx > 0) {
          const provider = input.slice(0, slashIdx);
          const modelId = input.slice(slashIdx + 1);
          found = allModels.find((m) => m.provider === provider && m.id === modelId);
          // Relay model ids may themselves contain slashes (e.g., "openai/gpt-5-image")
          if (!found) {
            found = allModels.find((m) => m.id === input);
          }
        } else {
          // Try just model id
          found = allModels.find((m) => m.id === input);
        }

        if (!found) {
          ctx.ui.notify(`Unknown image model "${input}". Run /image-model to see options.`, "error");
          return;
        }

        sessionSelection = { provider: found.provider, model: found.id };
        pi.appendEntry(SESSION_ENTRY_TYPE, sessionSelection);
        await saveDefaultModel(found.provider, found.id);
        ctx.ui.setStatus("image-model", undefined);
        ctx.ui.notify(`Image model: ${found.name} (${found.provider}/${found.id})`, "info");
        return;
      }

      // Interactive selection with search — mirrors Pi's /model UI
      const currentKey = sessionSelection ? `${sessionSelection.provider}/${sessionSelection.model}` : null;

      // Sort: current model first, then alphabetically by provider
      const sortedModels = [...allModels].sort((a, b) => {
        const aIsCurrent = `${a.provider}/${a.id}` === currentKey;
        const bIsCurrent = `${b.provider}/${b.id}` === currentKey;
        if (aIsCurrent && !bIsCurrent) return -1;
        if (!aIsCurrent && bIsCurrent) return 1;
        return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
      });

      const selected = await ctx.ui.custom<ImageModel | undefined>((tui, theme, _kb, done) => {
        const searchInput = new Input();
        searchInput.focused = true;
        const listContainer = new Container();
        const previewText = new Text("", 1, 0);
        let filteredModels = sortedModels;
        let selectedIndex = 0;
        const kb = getKeybindings();

        // Thin border that spans viewport width, matching Pi's DynamicBorder
        const border = { render: (w: number) => [theme.fg("border", "─".repeat(Math.max(1, w)))], invalidate() {} };

        function updateList() {
          listContainer.clear();
          const maxVisible = 10;
          const startIndex = Math.max(
            0,
            Math.min(selectedIndex - Math.floor(maxVisible / 2), filteredModels.length - maxVisible),
          );
          const endIndex = Math.min(startIndex + maxVisible, filteredModels.length);

          for (let i = startIndex; i < endIndex; i++) {
            const item = filteredModels[i];
            if (!item) continue;
            const isHighlighted = i === selectedIndex;
            const isCurrent = `${item.provider}/${item.id}` === currentKey;
            const providerBadge = theme.fg("muted", ` [${item.provider}]`);
            const checkmark = isCurrent ? theme.fg("success", " ✓") : "";

            const line = isHighlighted
              ? `${theme.fg("accent", "→ ")}${theme.fg("accent", item.id)}${providerBadge}${checkmark}`
              : `  ${item.id}${providerBadge}${checkmark}`;
            listContainer.addChild(new Text(line, 0, 0));
          }

          if (filteredModels.length > maxVisible) {
            listContainer.addChild(
              new Text(theme.fg("muted", `  (${selectedIndex + 1}/${filteredModels.length})`), 0, 0),
            );
          }

          if (filteredModels.length === 0) {
            listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
          }
        }

        function updatePreview() {
          const model = filteredModels[selectedIndex];
          previewText.setText(model ? theme.fg("muted", `Model Name: ${model.name}`) : "");
        }

        function filterModels(query: string) {
          filteredModels = query
            ? fuzzyFilter(sortedModels, query, (m) => `${m.id} ${m.provider} ${m.name}`)
            : sortedModels;
          selectedIndex = Math.min(selectedIndex, Math.max(0, filteredModels.length - 1));
          updateList();
          updatePreview();
        }

        searchInput.onSubmit = () => {
          if (filteredModels[selectedIndex]) done(filteredModels[selectedIndex]);
        };

        const container = new Container();
        container.addChild(border);
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("accent", "Select image model"), 1, 0));
        container.addChild(new Spacer(1));
        container.addChild(searchInput);
        container.addChild(new Spacer(1));
        container.addChild(listContainer);
        container.addChild(new Spacer(1));
        container.addChild(previewText);
        container.addChild(new Spacer(1));
        container.addChild(border);

        updateList();
        updatePreview();

        return {
          render(width: number) { return container.render(width); },
          invalidate() { container.invalidate(); },
          handleInput(data: string) {
            if (kb.matches(data, "tui.select.up")) {
              if (filteredModels.length === 0) return;
              selectedIndex = selectedIndex === 0 ? filteredModels.length - 1 : selectedIndex - 1;
              updateList();
              updatePreview();
            } else if (kb.matches(data, "tui.select.down")) {
              if (filteredModels.length === 0) return;
              selectedIndex = selectedIndex === filteredModels.length - 1 ? 0 : selectedIndex + 1;
              updateList();
              updatePreview();
            } else if (kb.matches(data, "tui.select.confirm")) {
              if (filteredModels[selectedIndex]) done(filteredModels[selectedIndex]);
            } else if (kb.matches(data, "tui.select.cancel")) {
              done(undefined);
            } else {
              searchInput.handleInput(data);
              filterModels(searchInput.getValue());
            }
            tui.requestRender();
          },
        };
      });

      if (!selected) return;

      sessionSelection = { provider: selected.provider, model: selected.id };
      pi.appendEntry(SESSION_ENTRY_TYPE, sessionSelection);
      await saveDefaultModel(selected.provider, selected.id);
      ctx.ui.setStatus("image-model", undefined);
      ctx.ui.notify(`Image model: ${selected.name} (${selected.provider}/${selected.id})`, "info");
    },
  });

  // ── generate_image tool ──

  pi.registerTool({
    name: "generate_image",
    label: "Generate image",
    description:
      "Generate an image from a text prompt, or edit a local input image when imagePath is supplied. Uses the selected image model, which is independent of Pi's current text model. " +
      "When imagePath is supplied without maskPath in interactive TUI mode, the tool first asks whether to launch a region selector. If chosen, it opens a browser canvas for freehand lasso drawing; the user can also choose the whole image or cancel. After a mask is selected, the user chooses to use the suggested prompt or write a custom one from a blank editor. " +
      "Pass maskPath only when a mask was already prepared. Do NOT pass provider or model parameters — just provide the prompt and optional imagePath.",
    parameters: TOOL_PARAMS,

    async execute(
      _toolCallId: string,
      params: ToolParams,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      const config = loadConfig(ctx.cwd);
      const imageModel = resolveModel(sessionSelection, config);
      let aspectRatio = params.aspectRatio || "1:1";
      const imageSize = params.imageSize || "1K";
      const quality = params.quality || "auto";
      let prompt = params.prompt;

      const hasEditInput = Boolean(params.imagePath || params.maskPath);
      if (params.maskPath && !params.imagePath) {
        throw new Error("maskPath requires imagePath.");
      }
      if (hasEditInput && imageModel.api !== "openai-images") {
        throw new Error(
          `Image editing currently requires an openai-images model; selected ${imageModel.provider}/${imageModel.id} uses ${imageModel.api}.`,
        );
      }
      const inputPath = params.imagePath ? resolveInputImagePath(params.imagePath, ctx.cwd) : undefined;
      const inputImage = inputPath
        ? await loadInputImage(inputPath, ctx.cwd, "input image")
        : undefined;
      if (inputImage && !params.aspectRatio) {
        aspectRatio = closestAspectRatio(inputImage);
      }
      let maskImage = params.maskPath
        ? await loadInputImage(params.maskPath, ctx.cwd, "mask image")
        : undefined;
      let generatedMaskPath: string | undefined;
      let editScope: "provided" | "region" | "whole" | "none" = params.maskPath ? "provided" : "none";
      let editFallback: string | undefined;
      let maskSource: "provided" | "browser" | undefined = params.maskPath ? "provided" : undefined;
      const canceledEdit = (message = "Image edit canceled: no edit area was selected."): AgentToolResult<unknown> => ({
        content: [{ type: "text", text: message }],
        details: { canceled: true, operation: "edit", imagePath: params.imagePath },
      });

      // Editing with no explicit mask should not edit silently and should not
      // launch a selector without consent. Ask first, then open the
      // pixel-precise browser tool if the user wants a region.
      if (inputImage && inputPath && !params.maskPath) {
        if (ctx.mode === "tui") {
          const browserChoice = "Launch browser mask tool (freehand lasso)";
          const wholeChoice = "Edit whole image";
          const cancelChoice = "Cancel";
          const choices = [browserChoice, wholeChoice, cancelChoice];
          const choice = await ctx.ui.select("Select an edit area?", choices);
          if (!choice || choice === cancelChoice) return canceledEdit();

          if (choice === browserChoice) {
            ctx.ui.notify("Opening browser mask selector…", "info");
            const selectedMask = await selectMaskWithBrowser(
              inputPath,
              ctx.cwd,
              config,
              params.timeout ?? config.timeout ?? DEFAULT_TIMEOUT_MS / 1000,
              signal,
            );
            if (selectedMask === "canceled") return canceledEdit();
            generatedMaskPath = selectedMask;
            maskImage = await loadInputImage(selectedMask, ctx.cwd, "mask image");
            editScope = "region";
            maskSource = "browser";
          } else {
            editScope = "whole";
          }
        } else {
          editScope = "whole";
          editFallback = "Interactive image selection requires TUI mode; editing the entire image.";
        }
      }

      // After the user has drawn a mask, let them either accept the agent's
      // suggested prompt or start from a blank editor. Never prefill the custom
      // editor: clearing a long suggestion should not be part of the flow.
      if (editScope === "region" && generatedMaskPath) {
        const suggestedPrompt = params.prompt.trim();
        const askForCustomPrompt = async (): Promise<string | undefined> => {
          const title = "Write a custom prompt for the selected area";
          let editedPrompt = await ctx.ui.editor(title, "");
          while (editedPrompt !== undefined && !editedPrompt.trim()) {
            ctx.ui.notify("Edit prompt cannot be empty.", "warning");
            editedPrompt = await ctx.ui.editor(title, "");
          }
          return editedPrompt?.trim();
        };

        if (suggestedPrompt) {
          const preview = suggestedPrompt.replace(/\s+/g, " ").trim();
          const previewLabel = preview.length > 90 ? `${preview.slice(0, 87)}...` : preview;
          const useSuggested = `Use suggested prompt — ${previewLabel}`;
          const writeCustom = "Write a custom prompt";
          const cancelPrompt = "Cancel";
          const promptChoice = await ctx.ui.select(
            "Edit prompt for the selected area",
            [useSuggested, writeCustom, cancelPrompt],
          );
          if (!promptChoice || promptChoice === cancelPrompt) {
            return canceledEdit("Image edit canceled: prompt entry was canceled.");
          }
          if (promptChoice === writeCustom) {
            const customPrompt = await askForCustomPrompt();
            if (customPrompt === undefined) {
              return canceledEdit("Image edit canceled: prompt entry was canceled.");
            }
            prompt = customPrompt;
          } else {
            prompt = suggestedPrompt;
          }
        } else {
          const customPrompt = await askForCustomPrompt();
          if (customPrompt === undefined) {
            return canceledEdit("Image edit canceled: prompt entry was canceled.");
          }
          prompt = customPrompt;
        }
      }

      const action = inputImage
        ? editScope === "region"
          ? "Editing selected area"
          : editScope === "provided"
            ? "Editing masked area"
            : "Editing entire image"
        : "Generating image";

      // Build a combined signal: framework abort + configured timeout
      const timeoutMs = (params.timeout ?? config.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      onUpdate?.({
        content: [{ type: "text", text: `${action} with ${imageModel.provider}/${imageModel.id}...` }],
        details: { provider: imageModel.provider, model: imageModel.id, api: imageModel.api },
      });

      const providerConfig = await resolveProviderConfig(imageModel, ctx, config);
      const image = await generateImage(
        providerConfig,
        imageModel,
        prompt,
        aspectRatio,
        imageSize,
        quality,
        inputImage,
        maskImage,
        combinedSignal,
      );
      const displayImage = await prepareImageForTui(image);

      // Always save a local copy so the result can expose a stable path and file link.
      const saveConfig = resolveSaveConfig(params.save, params.saveDir, ctx.cwd, config);
      let savedPath: string | undefined;
      let saveError: string | undefined;
      if (saveConfig.outputDir) {
        try {
          savedPath = await saveImageToDisk(image.data, image.mimeType, saveConfig.outputDir);
        } catch (error) {
          saveError = error instanceof Error ? error.message : String(error);
        }
      }

      const downloadUrl = savedPath ? pathToFileURL(savedPath).href : undefined;
      const summary: string[] = [
        `${inputImage ? "Edited" : "Generated"} image with ${imageModel.provider}/${imageModel.id} (${imageModel.api}).`,
        `Aspect ratio: ${aspectRatio}.`,
      ];
      if (inputImage) summary.push(`Input image: ${inputImage.filename}.`);
      if (maskSource === "browser") {
        summary.push("Edit area: browser-selected mask.");
      } else if (editScope === "whole" && !params.maskPath) {
        summary.push("Edit area: entire image.");
      } else if (params.maskPath) {
        summary.push(`Mask: ${params.maskPath}.`);
      }
      if (editScope === "region") summary.push(`Edit prompt: ${prompt}`);
      if (generatedMaskPath) summary.push(`Generated mask: ${generatedMaskPath}.`);
      if (editFallback) summary.push(editFallback);
      if (savedPath) {
        summary.push(`Saved locally to: ${savedPath}`);
        summary.push(`Download link: ${downloadUrl}`);
      }
      if (saveError) summary.push(`Local save failed: ${saveError}`);

      return {
        content: [
          { type: "text", text: summary.join(" ") },
          { type: "image", data: displayImage.data, mimeType: displayImage.mimeType },
        ],
        details: {
          provider: imageModel.provider,
          model: imageModel.id,
          api: imageModel.api,
          operation: inputImage ? "edit" : "generate",
          aspectRatio,
          quality,
          imagePath: params.imagePath,
          maskPath: generatedMaskPath ?? params.maskPath,
          maskSource,
          editScope: inputImage ? editScope : undefined,
          prompt,
          promptEdited: prompt !== params.prompt,
          fallbackReason: editFallback,
          savedPath,
          downloadUrl,
          saveError,
          saveMode: saveConfig.mode,
        },
      };
    },
  });
}
