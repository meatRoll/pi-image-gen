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
 *   openai-images           — POST /v1/images/generations (OpenAI direct)
 *   openai-chat-image       — POST /v1/chat/completions with image output (OpenRouter)
 *   google-generative-ai-image — POST generateContent with responseModalities (Google)
 */

import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { getAgentDir, convertToPng, resizeImage } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { Container, fuzzyFilter, getKeybindings, Input, Spacer, Text } from "@earendil-works/pi-tui";
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

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function globalConfigPath(): string {
  return join(getAgentDir(), "settings", "pi-image-gen.json");
}

function loadConfig(cwd: string): ExtensionConfig {
  const globalConfig = readJsonFile(globalConfigPath());
  const projectConfig = readJsonFile(join(cwd, ".pi", "settings", "pi-image-gen.json"));
  const globalProviders = (globalConfig.providers || {}) as Record<string, unknown>;
  const projectProviders = (projectConfig.providers || {}) as Record<string, unknown>;
  return {
    ...globalConfig,
    ...projectConfig,
    providers: { ...globalProviders, ...projectProviders },
  } as ExtensionConfig;
}

/** Persist model selection to global config so it survives across sessions. */
async function saveDefaultModel(provider: string, modelId: string): Promise<void> {
  const path = globalConfigPath();
  const existing = readJsonFile(path);
  existing.defaultProvider = provider;
  existing.defaultModel = modelId;
  await mkdir(join(getAgentDir(), "settings"), { recursive: true });
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
//     "openrouter": {
//       "baseUrl": "https://openrouter.ai/api/v1",
//       "models": [
//         { "id": "openai/gpt-5-image", "name": "GPT-5 Image", "output": ["image"] }
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

/** Infer legacy image API type from provider name and model api field */
function inferLegacyImageApi(provider: string, apiField?: string): ImageApi {
  if (provider === "google") return "google-generative-ai-image";
  if (provider === "openrouter") return "openai-chat-image";
  if (provider === "openai") return "openai-images";
  if (apiField?.includes("google")) return "google-generative-ai-image";
  return "openai-chat-image";
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

// ── Runtime Discovery ──────────────────────────────────────────────
// On startup, fetch image-capable models from OpenRouter. Results are
// cached to disk with a 24h TTL so we don't hit the API every launch.
// Discovery runs non-blocking — if the cache is warm, it's instant.
// If the fetch fails, we silently fall back to built-in + models.json.

function discoveryCacheDir(): string { return join(getAgentDir(), "cache"); }
function discoveryCacheFile(): string { return join(discoveryCacheDir(), "pi-image-gen-discovered.json"); }
const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface DiscoveryCache {
  fetchedAt: number;
  models: ImageModel[];
}

/** Read cached discovered models if cache is fresh */
function readDiscoveryCache(): ImageModel[] {
  const cacheFile = discoveryCacheFile();
  if (!existsSync(cacheFile)) return [];
  try {
    const stat = statSync(cacheFile);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > DISCOVERY_TTL_MS) return []; // Stale

    const cache = JSON.parse(readFileSync(cacheFile, "utf-8")) as DiscoveryCache;
    return cache.models;
  } catch {
    return [];
  }
}

/** In-memory store for discovered models (populated on session_start) */
let discoveredModels: ImageModel[] = readDiscoveryCache();

/** Fetch image models from OpenRouter at runtime and update cache.
 *
 * Uses the frontend API (/api/frontend/models) which includes image-only
 * models (FLUX, Riverflow, Seedream) that the public /v1/models endpoint
 * omits. Falls back to /v1/models if frontend API is unavailable.
 */
async function refreshDiscoveryCache(): Promise<void> {
  // Skip if cache is still fresh
  const cacheFile = discoveryCacheFile();
  if (existsSync(cacheFile)) {
    try {
      const stat = statSync(cacheFile);
      if (Date.now() - stat.mtimeMs < DISCOVERY_TTL_MS) return;
    } catch {
      // Continue to fetch
    }
  }

  try {
    let models: ImageModel[] = [];

    // Try frontend API first — has all image models including image-only ones
    const frontendResponse = await fetch("https://openrouter.ai/api/frontend/models");
    if (frontendResponse.ok) {
      const data = (await frontendResponse.json()) as {
        data: Array<{
          slug: string;
          name: string;
          output_modalities?: string[];
        }>;
      };

      for (const model of data.data) {
        const outputMods = model.output_modalities ?? [];
        if (!outputMods.includes("image")) continue;
        if (model.slug === "openrouter/auto") continue;

        models.push({
          id: model.slug,
          name: model.name,
          provider: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-chat-image",
          cost: 0,
        });
      }
    } else {
      // Fallback to public /v1/models (fewer image models but stable)
      const response = await fetch("https://openrouter.ai/api/v1/models");
      if (!response.ok) return;

      const data = (await response.json()) as {
        data: Array<{
          id: string;
          name: string;
          architecture?: { output_modalities?: string[] };
        }>;
      };

      for (const model of data.data) {
        const outputMods = model.architecture?.output_modalities ?? [];
        if (!outputMods.includes("image")) continue;
        if (model.id === "openrouter/auto") continue;

        models.push({
          id: model.id,
          name: model.name,
          provider: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          api: "openai-chat-image",
          cost: 0,
        });
      }
    }

    // Write cache
    await mkdir(discoveryCacheDir(), { recursive: true });
    const cache: DiscoveryCache = { fetchedAt: Date.now(), models };
    await writeFile(discoveryCacheFile(), JSON.stringify(cache, null, 2));

    // Update in-memory
    discoveredModels = models;
  } catch {
    // Silent failure — we still have built-in + models.json
  }
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

  // Runtime-discovered models
  for (const m of discoveredModels) {
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

/** OpenAI /v1/images/generations endpoint */
async function generateViaOpenAIImages(
  config: ProviderConfig,
  model: ImageModel,
  prompt: string,
  aspectRatio: string,
  quality: string,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  const size = OPENAI_SIZES[aspectRatio] || "1024x1024";
  const body: Record<string, unknown> = {
    model: model.id,
    prompt,
    n: 1,
    size,
    response_format: config.responseFormat || "url",
  };
  if (model.id === "gpt-image-1") body.quality = quality;
  if (model.id === "dall-e-3") body.quality = quality === "high" ? "hd" : "standard";

  const response = await fetch(`${config.baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI image generation failed (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as { data: Array<{ b64_json?: string; url?: string }> };
  if (result.data[0]?.b64_json) {
    const encoded = result.data[0].b64_json;
    const bytes = Buffer.from(encoded, "base64");
    let mimeType = "image/png";
    if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) mimeType = "image/jpeg";
    else if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) mimeType = "image/png";
    else if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") mimeType = "image/webp";
    return { data: encoded, mimeType };
  }
    const imageUrl = result.data[0]?.url;
    if (imageUrl) {
      const dataUrl = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(imageUrl);
      if (dataUrl) return { data: dataUrl[2], mimeType: dataUrl[1] };
      return downloadGeminiImageLocally(imageUrl, config.downloadProxy, signal);
    }
  throw new Error("OpenAI returned no image data");
}

/** OpenRouter chat completions with image output.
 *
 * Uses `modalities: ["image"]` so image-only endpoints can route successfully.
 * Response includes `message.images[]` with base64 data URLs.
 * See: https://openrouter.ai/docs/features/image-generation
 */
async function generateViaChatImage(
  config: ProviderConfig,
  model: ImageModel,
  prompt: string,
  aspectRatio: string,
  imageSize: string,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  const body: Record<string, unknown> = {
    model: model.id,
    messages: [{ role: "user", content: prompt }],
    modalities: ["image"],
  };

  // Add image_config for aspect ratio and size
  const imageConfig: Record<string, string> = {};
  if (aspectRatio && aspectRatio !== "1:1") {
    imageConfig.aspect_ratio = aspectRatio;
  }
  if (imageSize && imageSize !== "1K") {
    imageConfig.image_size = imageSize;
  }
  if (Object.keys(imageConfig).length > 0) {
    body.image_config = imageConfig;
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter image generation failed (${response.status}): ${errorText}`);
  }

  const result = (await response.json()) as {
    choices: Array<{
      message: {
        content?: string;
        images?: Array<{
          type: string;
          image_url: { url: string };
        }>;
      };
    }>;
  };

  const message = result.choices[0]?.message;
  if (!message) throw new Error("No message in OpenRouter response");

  // Images are in message.images[], each with a base64 data URL
  if (message.images && message.images.length > 0) {
    const url = message.images[0].image_url.url;
    if (url.startsWith("data:")) {
      const commaIdx = url.indexOf(",");
      const header = url.slice(0, commaIdx);
      const data = url.slice(commaIdx + 1);
      const mimeType = header.match(/data:(.*);/)?.[1] || "image/png";
      return { data, mimeType };
    }
    // URL-based — fetch and convert
    const imgResponse = await fetch(url, { signal });
    const buffer = await imgResponse.arrayBuffer();
    return {
      data: Buffer.from(buffer).toString("base64"),
      mimeType: imgResponse.headers.get("content-type") || "image/png",
    };
  }

  throw new Error("No images in OpenRouter response. Ensure the model supports image generation.");
}

/** Google Gemini generateContent with responseModalities: ["IMAGE"] */
async function generateViaGoogleImage(
  config: ProviderConfig,
  model: ImageModel,
  prompt: string,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  const response = await fetch(
    `${config.baseUrl}/models/${model.id}:generateContent?key=${config.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
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

/** Route to the appropriate generation method based on model's API type */
async function generateImage(
  config: ProviderConfig,
  model: ImageModel,
  prompt: string,
  aspectRatio: string,
  imageSize: string,
  quality: string,
  signal?: AbortSignal,
): Promise<GeneratedImage> {
  switch (model.api) {
    case "openai-images":
      return generateViaOpenAIImages(config, model, prompt, aspectRatio, quality, signal);
    case "openai-chat-image":
      return generateViaChatImage(config, model, prompt, aspectRatio, imageSize, signal);
    case "google-generative-ai-image":
      return generateViaGoogleImage(config, model, prompt, signal);
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

  // 4. Default: first openrouter model, then openai, then anything
  const orModels = allModels.filter((m) => m.provider === "openrouter");
  if (orModels.length > 0) return orModels[0];
  const openaiModels = allModels.filter((m) => m.provider === "openai");
  if (openaiModels.length > 0) return openaiModels[0];
  if (allModels.length > 0) return allModels[0];

  throw new Error("No image models available. Run /image-model to select one.");
}

// ── Session State ──────────────────────────────────────────────────

const SESSION_ENTRY_TYPE = "pi-image-gen:model-select";

// ── Tool Parameters ────────────────────────────────────────────────

const TOOL_PARAMS = Type.Object({
  prompt: Type.String({ description: "Description of the image to generate." }),
  aspectRatio: Type.Optional(Type.String({
    description: "Aspect ratio: 1:1 (default), 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9.",
  })),
  imageSize: Type.Optional(Type.String({
    description: "Image resolution: 1K (1024x1024, default), 2K, 4K. OpenRouter models only.",
  })),
  quality: Type.Optional(Type.String({
    description: "Image quality: auto (default), low, medium, high. OpenAI direct only.",
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

    // Runtime discovery — non-blocking, updates cache for this + future sessions
    refreshDiscoveryCache().catch(() => {});
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
          // For openrouter models, the id itself contains slashes (e.g., "openai/gpt-5-image")
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
      "Generate an image from a text prompt. Uses the selected image model, which is independent of Pi's current text model. " +
      "Do NOT pass provider or model parameters — just provide the prompt.",
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
      const aspectRatio = params.aspectRatio || "1:1";
      const imageSize = params.imageSize || "1K";
      const quality = params.quality || "auto";

      // Build a combined signal: framework abort + configured timeout
      const timeoutMs = (params.timeout ?? config.timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000;
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      onUpdate?.({
        content: [{ type: "text", text: `Generating image with ${imageModel.provider}/${imageModel.id}...` }],
        details: { provider: imageModel.provider, model: imageModel.id, api: imageModel.api },
      });

      const providerConfig = await resolveProviderConfig(imageModel, ctx, config);
      const image = await generateImage(providerConfig, imageModel, params.prompt, aspectRatio, imageSize, quality, combinedSignal);
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
        `Generated image with ${imageModel.provider}/${imageModel.id} (${imageModel.api}).`,
        `Aspect ratio: ${aspectRatio}.`,
      ];
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
          aspectRatio,
          quality,
          savedPath,
          downloadUrl,
          saveError,
          saveMode: saveConfig.mode,
        },
      };
    },
  });
}
