/**
 * pi-image-gen — Provider-agnostic image generation extension for Pi.
 *
 * Mirrors Pi's text model architecture:
 * - Image models declared in the plugin's providers (added/edited via /image-model)
 * - Models imported read-only from Pi's models.json into the plugin config
 * - Custom models via config files or JSON mode
 * - API keys and headers resolved from the plugin config first, then Pi's ModelRegistry
 * - /image-model command for selecting, adding, editing and deleting models
 * - Per-field AI suggestions via Ctrl+G using the current Pi chat model
 * - Session-persisted selection via pi.appendEntry()
 *
 * API types:
 *   openai-images           — POST /v1/images/generations or /v1/images/edits
 *   google-generative-ai-image — POST generateContent with responseModalities (Google)
 */

import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { convertToPng, DynamicBorder, getAgentDir, resizeImage } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  Container,
  fuzzyFilter,
  getImageDimensions,
  Input,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
const execFileAsync = promisify(execFile);

/** A chat model as registered by Pi (models.json providers and built-ins). */
type PiChatModel = Model<Api>;

// ── Image Model Types ──────────────────────────────────────────────
// Image models come exclusively from providers in the plugin settings.
type ImageApi = "openai-images" | "google-generative-ai-image";

interface ImageModel {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  api: ImageApi;
  cost: number;
}

// ── Config ─────────────────────────────────────────────────────────

const SAVE_MODES = ["project", "global", "custom"] as const;
type SaveMode = (typeof SAVE_MODES)[number];

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

/** Image-generation options stored per model in the plugin settings. */
interface ImageModelOptions {
  /** OpenAI Images response format. `b64_json` avoids signed media URLs. */
  responseFormat?: "url" | "b64_json";
  /** Whether the model exposes POST /images/edits (imagePath/maskPath). */
  supportsEdit?: boolean;
  /** Used when the generate_image call omits aspectRatio. */
  defaultAspectRatio?: string;
  /** Used when the generate_image call omits imageSize (Gemini only). */
  defaultImageSize?: string;
}

/** A catalog model plus the image options declared in the plugin settings. */
type ResolvedImageModel = ImageModel & ImageModelOptions;

interface ExtensionConfig {
  save?: SaveMode;
  saveDir?: string;
  defaultProvider?: string;
  defaultModel?: string;
  /** Image generation timeout in seconds. Default: 600 (10 min). */
  timeout?: number;
  /** Image provider definitions. Each key is a provider name; value defines
   *  baseUrl, apiKey, headers, api type, and models. Models imported from Pi's
   *  models.json through /image-model are written here. */
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

/** Persist the model selection so it survives across sessions. Imported model
 *  definitions live in the plugin config; this only remembers the last pick. */
async function saveDefaultModel(provider: string, modelId: string): Promise<void> {
  const path = join(settingsDir(), MODEL_STATE_FILENAME);
  const existing = readJsonFile(path);
  existing.defaultProvider = provider;
  existing.defaultModel = modelId;
  await mkdir(settingsDir(), { recursive: true });
  await writeFile(path, JSON.stringify(existing, null, 2));
}

// ── models.json Integration ────────────────────────────────────────
// Pi's models.json is the read-only source for importing image models:
// /image-model lists the provider's configured chat models, then writes the
// selected model into the plugin config as a standard providers entry (with
// the image options Pi has no field for). The extension never writes models.json.
// The state file only remembers the last selection.
//
// models.json format:
// {
//   "providers": {
//     "my-relay": {
//       "baseUrl": "https://relay.example/v1",
//       "models": [
//         { "id": "my-image-model", "name": "My Image Model" }
//       ]
//     }
//   }
// }

interface ModelsJsonModelDef {
  id: string;
  name?: string;
  api?: string;
  [key: string]: unknown;
}

interface ModelsJsonProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  models?: ModelsJsonModelDef[];
}

interface ModelsJsonImageModelDef {
  id: string;
  name?: string;
  api?: ImageApi;
  cost?: number;
  responseFormat?: "url" | "b64_json";
  supportsEdit?: boolean;
  defaultAspectRatio?: string;
  defaultImageSize?: string;
}

interface ModelsJsonImageProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  /** Extra request headers, e.g. a relay's User-Agent. */
  headers?: Record<string, string>;
  api?: ImageApi;
  /** OpenAI Images response format. Use b64_json when the server owns signed-media authentication. */
  responseFormat?: "url" | "b64_json";
  models?: ModelsJsonImageModelDef[];
}

interface ModelsJsonConfig {
  providers?: Record<string, ModelsJsonProviderConfig>;
}

/** Infer the image API from the provider name, api or baseUrl.
 *
 * Everything OpenAI-compatible uses `POST /images/generations`, which is the
 * only OpenAI-style image endpoint this extension speaks. */
function inferProviderImageApi(provider: string, apiField?: string): ImageApi {
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

/** Read image models from the settings file's providers section. */
function getSettingsImageModels(config: ExtensionConfig): ResolvedImageModel[] {
  if (!config.providers) return [];
  const models = new Map<string, ResolvedImageModel>();

  for (const [provider, providerConfig] of Object.entries(config.providers)) {
    const baseUrl = providerConfig.baseUrl || "";
    const providerApi = providerConfig.api || inferProviderImageApi(provider);

    if (!providerConfig.models) continue;
    for (const modelDef of providerConfig.models) {
      models.set(`${provider}/${modelDef.id}`, {
        id: modelDef.id,
        name: modelDef.name || modelDef.id,
        provider,
        baseUrl,
        api: modelDef.api || providerApi,
        cost: modelDef.cost || 0,
        responseFormat: modelDef.responseFormat,
        supportsEdit: modelDef.supportsEdit,
        defaultAspectRatio: modelDef.defaultAspectRatio,
        defaultImageSize: modelDef.defaultImageSize,
      });
    }
  }

  return [...models.values()];
}

/** Infer the image API for a model picked from Pi's models.json. Pi stores
 *  chat APIs there, so the provider name, API and baseUrl are the only hints.
 *  Anything that does not look like Google is treated as an OpenAI-compatible
 *  relay that exposes POST /images/generations. */
function inferPiImageApi(
  provider: string,
  providerConfig?: ModelsJsonProviderConfig,
  modelId?: string,
): ImageApi {
  const modelConfig = modelId ? providerConfig?.models?.find((model) => model.id === modelId) : undefined;
  const hints = `${provider} ${providerConfig?.api ?? ""} ${modelConfig?.api ?? ""} ${providerConfig?.baseUrl ?? ""}`.toLowerCase();
  if (hints.includes("google")) return "google-generative-ai-image";
  return "openai-images";
}

/** Chat models registered by Pi from the user's models.json providers. */
function getPiRegistryModels(ctx: ExtensionContext): PiChatModel[] {
  const providers = new Set(Object.keys(readModelsJson().providers ?? {}));
  if (providers.size === 0) return [];
  // List every configured model: Pi may not have credentials for it, but the
  // import can still copy them from the provider config.
  return ctx.modelRegistry.getAll().filter((model) => providers.has(model.provider));
}

/** Registry model used to resolve auth, baseUrl and headers for a provider. */
function findRegistryModel(
  ctx: ExtensionContext,
  provider: string,
  id: string,
): PiChatModel | undefined {
  return ctx.modelRegistry.find(provider, id)
    ?? ctx.modelRegistry.getAll().find((model) => model.provider === provider);
}

/** Models declared in the plugin settings. There is no built-in catalog:
 *  /image-model only lists what is configured in providers. */
function getAllModels(config: ExtensionConfig): ResolvedImageModel[] {
  return getSettingsImageModels(config);
}

// ── Import from Pi's models.json ───────────────────────────────────

/** Read the target settings file for mutation. A file that exists but cannot
 *  be parsed is never overwritten. */
function readSettingsForUpdate(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf-8");
  try {
    const parsed = JSON.parse(stripJsonc(text)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Cannot update ${path}: ${error instanceof Error ? error.message : String(error)}. Fix the file and try again.`,
    );
  }
}

interface ImportedModelSource {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

/** Add or replace a model as a standard providers.<provider>.models[] entry in
 *  the global plugin settings, copying credentials and headers from Pi. The
 *  resulting entry is managed independently of Pi's models.json. */

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
  /** Provider headers resolved by Pi, e.g. a relay's User-Agent or extra auth. */
  headers?: Record<string, string>;
  downloadProxy?: string;
  responseFormat?: "url" | "b64_json";
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Drop null/empty header values so they can be spread into a fetch init. */
function providerHeadersToRecord(
  headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string" && value.length > 0) record[key] = value;
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

async function resolveProviderConfig(
  imageModel: ResolvedImageModel,
  ctx: ExtensionContext,
  config: ExtensionConfig,
): Promise<ProviderConfig> {
  const settingsProvider = config.providers?.[imageModel.provider];
  const registryModel = findRegistryModel(ctx, imageModel.provider, imageModel.id);

  let apiKey: string | undefined;
  let registryBaseUrl: string | undefined;
  let registryHeaders: Record<string, string> | undefined;
  let registryError: string | undefined;

  // Values declared in the plugin settings win; Pi fills the gaps. Copied
  // credentials and headers keep imported models independent of later changes
  // in Pi's models.json.
  const needsRegistry = !settingsProvider?.apiKey || !settingsProvider.baseUrl || !settingsProvider.headers;
  if (needsRegistry) {
    if (registryModel) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(registryModel);
      if (auth.ok) {
        registryBaseUrl = auth.baseUrl;
        registryHeaders = providerHeadersToRecord(auth.headers);
        if (!settingsProvider?.apiKey) apiKey = auth.apiKey;
      } else {
        registryError = auth.error;
      }
    }
  }
  if (!apiKey && !settingsProvider?.apiKey) {
    apiKey = await ctx.modelRegistry.getApiKeyForProvider(imageModel.provider);
  }
  apiKey ||= settingsProvider?.apiKey;
  apiKey ||= getModelsJsonApiKeyForProvider(imageModel.provider);

  const headers = settingsProvider?.headers ?? registryHeaders;

  if (!apiKey && !headers) {
    const detail = registryError ? ` Pi reported: ${registryError}.` : "";
    throw new Error(
      `No credentials for provider "${imageModel.provider}".${detail} ` +
      `Set them in environment, /login, ~/.pi/agent/models.json, or add apiKey to providers.${imageModel.provider} in ~/.pi/agent/settings/pi-image-gen.json.`,
    );
  }

  const baseUrl = settingsProvider?.baseUrl || registryBaseUrl || imageModel.baseUrl || registryModel?.baseUrl || "";
  if (!baseUrl) {
    throw new Error(`No base URL for provider "${imageModel.provider}".`);
  }

  return {
    apiKey: apiKey ?? "",
    baseUrl: trimBaseUrl(baseUrl),
    headers,
    downloadProxy: config.downloadProxy,
    responseFormat: imageModel.responseFormat ?? settingsProvider?.responseFormat,
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
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.headers,
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
      headers: { "Content-Type": "application/json", ...config.headers },
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
      headers: { "Content-Type": "application/json", ...config.headers },
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
): ResolvedImageModel {
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

  // 3. Default: the first configured model
  if (allModels.length > 0) return allModels[0];

  throw new Error("No image models configured. Run /image-model, then press a to add one.");
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
    description: "Aspect ratio: 1:1 (default for generation), 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9. Uses the model's saved default when omitted. For edits, defaults to the input image's nearest supported ratio.",
  })),
  imageSize: Type.Optional(Type.String({
    description: "Image resolution: 1K (1024x1024, default), 2K, 4K. Uses the model's saved default when omitted. Provider-dependent.",
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

// ── Model Picker & Import ────────────────────────────────────────

/** One row in /image-model. Configured entries come from the plugin settings;
 *  the add-from-Pi picker also shows models from Pi's models.json. */
interface ImageModelPickItem {
  key: string;
  provider: string;
  id: string;
  name: string;
  piModel?: PiChatModel;
  catalogModel?: ResolvedImageModel;
  /** The model is declared in the plugin's providers. */
  inConfig: boolean;
}

type ImageModelPickerResult =
  | { kind: "select"; item: ImageModelPickItem }
  | { kind: "add" }
  | { kind: "edit"; item: ImageModelPickItem }
  | { kind: "delete"; item: ImageModelPickItem }
  | { kind: "json" };

interface ImageModelPickerOptions {
  currentKey: string | null;
  defaultKey: string | null;
  actions: boolean;
  hint?: string;
  showConfigBadge?: boolean;
}

const ASPECT_RATIO_OPTIONS = ["1:1", "16:9", "9:16", "3:2", "2:3", "4:3", "3:4", "4:5", "5:4", "21:9"] as const;

/** Show the model name only when it adds words the ID does not. */
function modelNameSuffix(id: string, name?: string, provider?: string): string | undefined {
  const trimmed = name?.trim();
  if (!trimmed) return undefined;
  const words = (value: string) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const idWords = words(id);
  const idSet = new Set(idWords);
  const compactId = idWords.join("");
  const providerWords = new Set(words(provider ?? ""));
  const covered = (word: string) => idSet.has(word) || (word.length > 1 && compactId.includes(word));
  const extra = words(trimmed).filter((word) => !covered(word) && !providerWords.has(word));
  return extra.length > 0 ? extra.join(" ") : undefined;
}

function imageModelDetail(model: ResolvedImageModel): string {
  const parts: string[] = [model.api];
  if (model.api === "openai-images") {
    if (model.responseFormat) parts.push(model.responseFormat);
    if (model.supportsEdit === false) parts.push("no editing");
  }
  if (model.defaultAspectRatio) parts.push(model.defaultAspectRatio);
  if (model.defaultImageSize) parts.push(model.defaultImageSize);
  return parts.join(" · ");
}

function isModelInPluginConfig(config: ExtensionConfig, provider: string, id: string): boolean {
  return Boolean(config.providers?.[provider]?.models?.some((model) => model.id === id));
}

function configuredPickItems(config: ExtensionConfig): ImageModelPickItem[] {
  return getAllModels(config).map((model) => ({
    key: `${model.provider}/${model.id}`,
    provider: model.provider,
    id: model.id,
    name: model.name,
    catalogModel: model,
    inConfig: isModelInPluginConfig(config, model.provider, model.id),
  }));
}

/** Models exposed by providers in Pi's ~/.pi/agent/models.json. This is
 *  read-only: the plugin never writes that file. */
function piPickItems(ctx: ExtensionContext, config: ExtensionConfig): ImageModelPickItem[] {
  const catalog = new Map(getAllModels(config).map((model) => [`${model.provider}/${model.id}`, model]));
  return getPiRegistryModels(ctx).map((model) => {
    const key = `${model.provider}/${model.id}`;
    const catalogModel = catalog.get(key);
    return {
      key,
      provider: model.provider,
      id: model.id,
      name: catalogModel?.name ?? model.name ?? model.id,
      piModel: model,
      catalogModel,
      inConfig: isModelInPluginConfig(config, model.provider, model.id),
    };
  });
}

/** /model-style picker. Search sits above the list and owns one focus slot;
 *  the list owns the other. Actions only fire while the list is focused, so
 *  typing in the search field never triggers add/edit/delete. */
/**
 * Input always renders a reverse-video fake cursor, even while `focused` is
 * false. Strip that marker when unfocused so the cursor block itself is a
 * reliable focus indicator: block in the search box means search has focus.
 */
class FocusAwareInput extends Input {
  override render(width: number): string[] {
    const lines = super.render(width);
    if (this.focused) return lines;
    return lines.map((line) => line.replace(/\x1b_pi:fc\x07(.*?)\x1b_pi:\/fc\x07/g, "$1"));
  }
}

async function pickImageModel(
  ctx: ExtensionContext,
  items: ImageModelPickItem[],
  options: ImageModelPickerOptions,
): Promise<ImageModelPickerResult | undefined> {
  if (!ctx.hasUI) return undefined;
  const { currentKey, defaultKey, actions, hint, showConfigBadge = false } = options;
  return ctx.ui.custom<ImageModelPickerResult | undefined>((tui, theme, kb, done) => {
    const searchInput = new FocusAwareInput({ prompt: "", placeholder: "type to filter" });
    const searchLabel = new Text("", 0, 0);
    const listLabel = new Text("", 0, 0);
    const listContainer = new Container();
    const footer = new Text("", 0, 0);
    let focus: "search" | "list" = items.length === 0 && actions ? "list" : "search";
    let filteredItems = items;
    let selectedIndex = 0;

    function footerText(): string {
      if (focus === "search") {
        return "SEARCH · type to filter · Tab/↓ list · Enter select · Esc clear/close";
      }
      return actions
        ? "LIST · ↑↓ move · Enter select · a add · e edit · d delete · j JSON · Tab/↑ search · Esc close"
        : "LIST · ↑↓ move · Enter select · Tab/↑ search · Esc close";
    }

    function updateFocus(): void {
      searchInput.focused = focus === "search";
      searchLabel.setText(
        focus === "search"
          ? theme.fg("accent", "▸ Search — typing filters")
          : theme.fg("muted", "  Search — Tab/↓ to edit"),
      );
      listLabel.setText(
        focus === "list"
          ? theme.fg("accent", `▸ Models — Enter select${actions ? " · a add · e edit · d delete · j JSON" : ""}`)
          : theme.fg("muted", "  Models — Tab/↑ to focus"),
      );
      footer.setText(theme.fg("muted", footerText()));
      updateList();
    }

    function updateList(): void {
      listContainer.clear();
      const maxVisible = 10;
      const startIndex = Math.max(
        0,
        Math.min(selectedIndex - Math.floor(maxVisible / 2), filteredItems.length - maxVisible),
      );
      const endIndex = Math.min(startIndex + maxVisible, filteredItems.length);

      for (let i = startIndex; i < endIndex; i++) {
        const item = filteredItems[i];
        if (!item) continue;
        const isHighlighted = i === selectedIndex;
        const isCurrent = item.key === currentKey;
        const isDefault = item.key === defaultKey;
        const listFocused = focus === "list";
        const cursor = isHighlighted && listFocused ? theme.fg("accent", "→ ") : "  ";
        const currentMarker = isCurrent ? theme.fg("accent", "✓ ") : "  ";
        const idText = isHighlighted && listFocused ? theme.fg("accent", item.id) : item.id;
        const name = modelNameSuffix(item.id, item.name, item.provider);
        const nameText = name ? theme.fg("muted", ` (${name})`) : "";
        const providerBadge = theme.fg("muted", ` [${item.provider}]`);
        const configuredBadge = showConfigBadge && item.inConfig ? theme.fg("success", " · in config") : "";
        const defaultBadge = isDefault ? theme.fg("muted", " · default") : "";
        const line = `${cursor}${currentMarker}${idText}${nameText} ${providerBadge}${configuredBadge}${defaultBadge}`;
        listContainer.addChild(
          new Text(listFocused && isHighlighted ? theme.bg("selectedBg", line) : line, 0, 0),
        );
      }

      if (startIndex > 0 || endIndex < filteredItems.length) {
        listContainer.addChild(
          new Text(theme.fg("muted", `  (${selectedIndex + 1}/${filteredItems.length})`), 0, 0),
        );
      }

      if (filteredItems.length === 0) {
        const message = items.length === 0
          ? actions ? "  No models configured — press Tab, then a to add one" : "  No models available"
          : "  No matching models";
        listContainer.addChild(new Text(theme.fg("muted", message), 0, 0));
      } else {
        const item = filteredItems[selectedIndex];
        if (item) {
          listContainer.addChild(new Spacer(1));
          listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${item.name}`), 0, 0));
          if (item.catalogModel) {
            listContainer.addChild(
              new Text(theme.fg("muted", `  Image: ${imageModelDetail(item.catalogModel)}`), 0, 0),
            );
          }
          if (item.piModel && item.inConfig) {
            listContainer.addChild(
              new Text(theme.fg("muted", "  In pi-image-gen.json — select to keep it or reconfigure and re-import"), 0, 0),
            );
          } else if (item.piModel) {
            listContainer.addChild(
              new Text(theme.fg("muted", "  Not configured — select to configure and import"), 0, 0),
            );
          }
        }
      }
    }

    function filterItems(query: string): void {
      filteredItems = query
        ? fuzzyFilter(
            items,
            query,
            (item) => `${item.provider} ${item.provider}/${item.id} ${item.id} ${item.name}`,
          )
        : items;
      selectedIndex = query ? 0 : Math.min(selectedIndex, Math.max(0, filteredItems.length - 1));
      updateList();
    }

    searchInput.onSubmit = () => {
      const item = filteredItems[selectedIndex];
      if (item) done({ kind: "select", item });
    };

    const container = new Container();
    container.addChild(new DynamicBorder());
    if (hint) container.addChild(new Text(theme.fg("muted", `  ${hint}`), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(searchLabel);
    container.addChild(searchInput);
    container.addChild(new Spacer(1));
    container.addChild(listLabel);
    container.addChild(listContainer);
    container.addChild(new Spacer(1));
    container.addChild(footer);
    container.addChild(new DynamicBorder());

    updateFocus();

    return {
      render(width: number) { return container.render(width); },
      invalidate() { container.invalidate(); },
      handleInput(data: string) {
        if (data === "\t") {
          focus = focus === "search" ? "list" : "search";
          updateFocus();
          tui.requestRender();
          return;
        }

        if (kb.matches(data, "tui.select.cancel")) {
          if (focus === "search" && searchInput.getValue()) {
            searchInput.setValue("");
            filterItems("");
          } else {
            done(undefined);
          }
          tui.requestRender();
          return;
        }

        if (focus === "search") {
          if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
            focus = "list";
            updateFocus();
            tui.requestRender();
            return;
          }
          searchInput.handleInput(data);
          filterItems(searchInput.getValue());
          tui.requestRender();
          return;
        }

        const item = filteredItems[selectedIndex];
        if (kb.matches(data, "tui.select.up")) {
          if (selectedIndex === 0) {
            focus = "search";
            updateFocus();
          } else {
            selectedIndex--;
            updateList();
          }
        } else if (kb.matches(data, "tui.select.down")) {
          if (filteredItems.length > 0) {
            selectedIndex = selectedIndex === filteredItems.length - 1 ? 0 : selectedIndex + 1;
            updateList();
          }
        } else if (kb.matches(data, "tui.select.confirm")) {
          if (item) done({ kind: "select", item });
        } else if (actions && data === "a") {
          done({ kind: "add" });
        } else if (actions && data === "e") {
          if (item) done({ kind: "edit", item });
        } else if (actions && data === "d") {
          if (item) done({ kind: "delete", item });
        } else if (actions && data === "j") {
          done({ kind: "json" });
        } else if (data.length === 1 && data >= " " && data !== "\x7f") {
          // Any other printable key starts filtering without hiding the shortcuts.
          focus = "search";
          updateFocus();
          searchInput.handleInput(data);
          filterItems(searchInput.getValue());
        }
        tui.requestRender();
      },
    };
  });
}

// ── Field prompts and AI assist ────────────────────────────────────

interface SelectOption<T> {
  label: string;
  value: T;
}

/** Put the current or inferred choice first so Enter accepts it. */
function preferredFirst<T>(options: SelectOption<T>[], current: T): SelectOption<T>[] {
  return [...options].sort((a, b) => Number(Object.is(b.value, current)) - Number(Object.is(a.value, current)));
}

interface ImageModelSetup extends ImageModelOptions {
  api: ImageApi;
}

interface AiFieldContext {
  provider: string;
  modelId: string;
  modelName?: string;
  baseUrl?: string;
  providerApi?: string;
  piModel?: PiChatModel;
  options?: ImageModelSetup;
}

type AiFieldKind = "api" | "responseFormat" | "boolean" | "aspect" | "size" | "text" | "url" | "headers" | "id";

interface AiFieldSpec {
  kind: AiFieldKind;
  field: string;
  guidance: string;
  context: AiFieldContext;
  current?: unknown;
}

interface AiSuggestion {
  value: unknown;
  reason?: string;
  confidence?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

const SECRET_HEADER = /authorization|api[-_]?key|cookie|token|secret/i;

function normalizeAiValue(kind: AiFieldKind, raw: unknown): unknown | undefined {
  switch (kind) {
    case "api":
      return raw === "openai-images" || raw === "google-generative-ai-image" ? raw : undefined;
    case "responseFormat":
      return raw === "url" || raw === "b64_json" ? raw : undefined;
    case "boolean":
      if (raw === true || raw === "true" || raw === "yes") return true;
      if (raw === false || raw === "false" || raw === "no") return false;
      return undefined;
    case "aspect":
      if (raw === null || raw === "" || raw === "not set") return null;
      return typeof raw === "string" && (ASPECT_RATIO_OPTIONS as readonly string[]).includes(raw) ? raw : undefined;
    case "size":
      if (raw === null || raw === "" || raw === "not set") return null;
      return raw === "1K" || raw === "2K" || raw === "4K" ? raw : undefined;
    case "text":
    case "id": {
      if (typeof raw !== "string") return undefined;
      const value = raw.trim();
      return value.length > 0 ? value : undefined;
    }
    case "url": {
      if (typeof raw !== "string" || !raw.trim()) return undefined;
      try {
        const url = new URL(raw.trim());
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
      } catch {
        return undefined;
      }
    }
    case "headers": {
      if (!isRecord(raw)) return undefined;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(raw)) {
        if (typeof value !== "string") return undefined;
        if (SECRET_HEADER.test(name)) return undefined;
        headers[name] = value;
      }
      return headers;
    }
  }
}

function formatAiValue(value: unknown): string {
  if (value === null) return "not set";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function aiPrompt(spec: AiFieldSpec): string {
  const context = {
    provider: spec.context.provider,
    baseUrl: spec.context.baseUrl,
    providerApi: spec.context.providerApi,
    modelId: spec.context.modelId,
    modelName: spec.context.modelName,
    piModel: spec.context.piModel
      ? {
          provider: spec.context.piModel.provider,
          id: spec.context.piModel.id,
          name: spec.context.piModel.name,
          api: spec.context.piModel.api,
          baseUrl: spec.context.piModel.baseUrl,
        }
      : undefined,
    currentOptions: spec.context.options,
    currentValue: spec.current ?? null,
  };
  const allowed = spec.kind === "api"
    ? "openai-images | google-generative-ai-image"
    : spec.kind === "responseFormat"
      ? "url | b64_json"
      : spec.kind === "boolean"
        ? "true | false"
        : spec.kind === "aspect"
          ? `null | ${ASPECT_RATIO_OPTIONS.join(" | ")}`
          : spec.kind === "size"
            ? "null | 1K | 2K | 4K"
            : spec.kind === "headers"
              ? "an object of header names to string values"
              : "a string";
  return [
    "You are helping configure an image-generation model in Pi's pi-image-gen extension.",
    "Answer with ONE JSON object only, no markdown fences:",
    '{"value": <suggested value>, "reason": "<one short sentence>", "confidence": "high|medium|low"}',
    "",
    `Field: ${spec.field}`,
    `Guidance: ${spec.guidance}`,
    `Allowed values: ${allowed}`,
    `Context: ${JSON.stringify(context)}`,
    "Never propose credentials or secret header values (Authorization, API keys, cookies, tokens).",
    "If you do not know, return a conservative value and low confidence.",
  ].join("\n");
}

function parseAiReply(text: string): AiSuggestion | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    if (!("value" in parsed)) return undefined;
    return {
      value: parsed.value,
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      confidence: typeof parsed.confidence === "string" ? parsed.confidence : undefined,
    };
  } catch {
    return undefined;
  }
}

async function requestAiSuggestion(ctx: ExtensionContext, spec: AiFieldSpec): Promise<AiSuggestion | undefined> {
  if (!ctx.hasUI) return undefined;
  const model = ctx.model;
  if (!model) {
    ctx.ui.notify("AI help needs a current chat model.", "warning");
    return undefined;
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
    ctx.ui.notify(`AI help needs configured auth for ${model.provider}/${model.id}.`, "warning");
    return undefined;
  }
  ctx.ui.notify(`Asking ${model.provider}/${model.id} for a suggestion…`, "info");
  try {
    const response = await ctx.modelRegistry.complete(model, {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: aiPrompt(spec) }],
          timestamp: Date.now(),
        },
      ],
    });
    const text = response.content
      .filter((content): content is { type: "text"; text: string } => content.type === "text")
      .map((content) => content.text)
      .join("\n");
    const parsed = parseAiReply(text);
    if (!parsed) {
      ctx.ui.notify("AI returned no usable suggestion.", "warning");
      return undefined;
    }
    const normalized = normalizeAiValue(spec.kind, parsed.value);
    if (normalized === undefined) {
      ctx.ui.notify(`AI suggested an invalid ${spec.field} value: ${formatAiValue(parsed.value)}`, "warning");
      return undefined;
    }
    return { ...parsed, value: normalized };
  } catch (error) {
    ctx.ui.notify(`AI suggestion failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    return undefined;
  }
}

// ── Basic select and text fields (Ctrl+G asks the current chat model) ──

interface SelectUISpec<T> {
  title: string;
  note?: string;
  options: SelectOption<T>[];
  current?: T;
  allowAi?: boolean;
}

type SelectUIResult<T> = { kind: "value"; value: T } | { kind: "ai" };

async function selectUI<T>(ctx: ExtensionContext, spec: SelectUISpec<T>): Promise<SelectUIResult<T> | undefined> {
  if (!ctx.hasUI) return undefined;
  return ctx.ui.custom<SelectUIResult<T> | undefined>((tui, theme, kb, done) => {
    let selectedIndex = Math.max(0, spec.options.findIndex((option) => Object.is(option.value, spec.current)));
    const list = new Container();
    const footer = new Text("", 0, 0);

    function updateList(): void {
      list.clear();
      const maxVisible = 12;
      const startIndex = Math.max(
        0,
        Math.min(selectedIndex - Math.floor(maxVisible / 2), spec.options.length - maxVisible),
      );
      const endIndex = Math.min(startIndex + maxVisible, spec.options.length);
      for (let i = startIndex; i < endIndex; i++) {
        const option = spec.options[i];
        if (!option) continue;
        const highlighted = i === selectedIndex;
        const cursor = highlighted ? theme.fg("accent", "→ ") : "  ";
        const current = Object.is(option.value, spec.current) ? theme.fg("accent", "✓ ") : "  ";
        list.addChild(new Text(`${cursor}${current}${highlighted ? theme.fg("accent", option.label) : option.label}`, 0, 0));
      }
      if (startIndex > 0 || endIndex < spec.options.length) {
        list.addChild(new Text(theme.fg("muted", `  (${selectedIndex + 1}/${spec.options.length})`), 0, 0));
      }
    }

    const container = new Container();
    container.addChild(new DynamicBorder());
    container.addChild(new Text(theme.fg("accent", spec.title), 0, 0));
    if (spec.note) container.addChild(new Text(theme.fg("muted", spec.note), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);
    container.addChild(new Spacer(1));
    container.addChild(footer);
    container.addChild(new DynamicBorder());

    footer.setText(
      theme.fg(
        "muted",
        `↑↓ move · Enter select${spec.allowAi ? " · Ctrl+G Ask AI" : ""} · Esc cancel`,
      ),
    );
    updateList();

    return {
      render(width: number) { return container.render(width); },
      invalidate() { container.invalidate(); },
      handleInput(data: string) {
        if (kb.matches(data, "tui.select.up")) {
          if (spec.options.length === 0) return;
          selectedIndex = selectedIndex === 0 ? spec.options.length - 1 : selectedIndex - 1;
          updateList();
        } else if (kb.matches(data, "tui.select.down")) {
          if (spec.options.length === 0) return;
          selectedIndex = selectedIndex === spec.options.length - 1 ? 0 : selectedIndex + 1;
          updateList();
        } else if (kb.matches(data, "tui.select.confirm")) {
          const option = spec.options[selectedIndex];
          if (option) done({ kind: "value", value: option.value });
        } else if (kb.matches(data, "tui.select.cancel")) {
          done(undefined);
        } else if (spec.allowAi && data === "\x07") {
          done({ kind: "ai" });
        }
        tui.requestRender();
      },
    };
  });
}

/** Ask a select field. Ctrl+G asks the current model for a suggestion. */
async function askChoiceField<T>(
  ctx: ExtensionContext,
  spec: SelectUISpec<T> & { ai?: AiFieldSpec },
): Promise<T | undefined> {
  if (!ctx.hasUI) return undefined;
  let mode: "select" | "ai" = "select";
  while (true) {
    if (mode === "ai") {
      if (!spec.ai) {
        mode = "select";
        continue;
      }
      const suggestion = await requestAiSuggestion(ctx, spec.ai);
      if (!suggestion) {
        mode = "select";
        continue;
      }
      const option = spec.options.find((item) => Object.is(item.value, suggestion.value));
      if (!option) {
        ctx.ui.notify(
          `AI suggested ${formatAiValue(suggestion.value)}, which is not one of the available choices.`,
          "warning",
        );
        mode = "select";
        continue;
      }
      const gate = await selectUI<string>(ctx, {
        title: `${spec.title} — AI suggestion`,
        note: [
          `Use: ${option.label}`,
          suggestion.reason ? `Reason: ${suggestion.reason}` : undefined,
          suggestion.confidence ? `Confidence: ${suggestion.confidence}` : undefined,
        ].filter(Boolean).join("\n"),
        options: [
          { label: "Use this suggestion", value: "apply" },
          { label: "Ask AI again", value: "retry" },
          { label: "Choose manually", value: "manual" },
        ],
        current: "apply",
      });
      if (!gate || gate.kind !== "value") {
        mode = "select";
        continue;
      }
      if (gate.value === "apply") return option.value;
      if (gate.value === "retry") {
        mode = "ai";
        continue;
      }
      mode = "select";
      continue;
    }

    const result = await selectUI(ctx, { ...spec, allowAi: Boolean(spec.ai) });
    if (!result) return undefined;
    if (result.kind === "ai") {
      mode = "ai";
      continue;
    }
    return result.value;
  }
}

interface TextUISpec {
  title: string;
  note?: string;
  value?: string;
  placeholder?: string;
  ai?: AiFieldSpec;
  validate?: (value: string) => string | undefined;
}

async function askTextField(ctx: ExtensionContext, spec: TextUISpec): Promise<string | undefined> {
  if (!ctx.hasUI) return spec.value ?? "";
  let value = spec.value ?? "";
  let mode: "input" | "ai" = "input";
  while (true) {
    if (mode === "ai") {
      if (!spec.ai) {
        mode = "input";
        continue;
      }
      const suggestion = await requestAiSuggestion(ctx, spec.ai);
      if (!suggestion) {
        mode = "input";
        continue;
      }
      const suggested = formatAiValue(suggestion.value);
      const gate = await selectUI<string>(ctx, {
        title: `${spec.title} — AI suggestion`,
        note: [
          `Use: ${suggested}`,
          suggestion.reason ? `Reason: ${suggestion.reason}` : undefined,
          suggestion.confidence ? `Confidence: ${suggestion.confidence}` : undefined,
        ].filter(Boolean).join("\n"),
        options: [
          { label: "Use this suggestion", value: "apply" },
          { label: "Ask AI again", value: "retry" },
          { label: "Enter manually", value: "manual" },
        ],
        current: "apply",
      });
      if (!gate || gate.kind !== "value") {
        mode = "input";
        continue;
      }
      if (gate.value === "apply") {
        value = suggested;
        mode = "input";
        continue;
      }
      if (gate.value === "retry") {
        mode = "ai";
        continue;
      }
      mode = "input";
      continue;
    }

    const result = await ctx.ui.custom<{ kind: "value"; value: string } | { kind: "ai" } | undefined>(
      (tui, theme, kb, done) => {
        const input = new Input({ prompt: "", placeholder: spec.placeholder ?? "" });
        input.setValue(value);
        if (value) input.handleInput("\x05");
        input.focused = true;
        input.onSubmit = () => done({ kind: "value", value: input.getValue() });

        const container = new Container();
        container.addChild(new DynamicBorder());
        container.addChild(new Text(theme.fg("accent", spec.title), 0, 0));
        if (spec.note) container.addChild(new Text(theme.fg("muted", spec.note), 0, 0));
        container.addChild(new Spacer(1));
        container.addChild(input);
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(
            theme.fg("muted", `Enter confirm${spec.ai ? " · Ctrl+G Ask AI" : ""} · Esc cancel`),
            0,
            0,
          ),
        );
        container.addChild(new DynamicBorder());

        return {
          render(width: number) { return container.render(width); },
          invalidate() { container.invalidate(); },
          handleInput(data: string) {
            if (kb.matches(data, "tui.select.cancel")) {
              done(undefined);
            } else if (spec.ai && data === "\x07") {
              done({ kind: "ai" });
            } else {
              input.handleInput(data);
            }
            tui.requestRender();
          },
        };
      },
    );
    if (!result) return undefined;
    if (result.kind === "ai") {
      mode = "ai";
      continue;
    }
    const error = spec.validate?.(result.value);
    if (error) {
      ctx.ui.notify(error, "warning");
      value = result.value;
      continue;
    }
    return result.value;
  }
}

/** Multi-line JSON headers. Ctrl+G on the keep/edit prompt asks AI for
 *  non-secret headers. */
async function askHeaders(
  ctx: ExtensionContext,
  current: Record<string, string> | undefined,
  aiContext: AiFieldContext,
): Promise<Record<string, string> | undefined> {
  if (!ctx.hasUI) return current ?? {};
  let mode: "select" | "ai" = "select";
  let headerDraft = JSON.stringify(current ?? {}, null, 2);
  while (true) {
    if (mode === "ai") {
      const suggestion = await requestAiSuggestion(ctx, {
        kind: "headers",
        field: "headers",
        guidance: "Suggest only non-secret request headers such as User-Agent. Never include Authorization, cookies, API keys or tokens.",
        context: aiContext,
        current: current ?? {},
      });
      if (!suggestion) {
        mode = "select";
        continue;
      }
      const gate = await selectUI<string>(ctx, {
        title: "Request headers — AI suggestion",
        note: [
          `Use: ${formatAiValue(suggestion.value)}`,
          suggestion.reason ? `Reason: ${suggestion.reason}` : undefined,
          suggestion.confidence ? `Confidence: ${suggestion.confidence}` : undefined,
        ].filter(Boolean).join("\n"),
        options: [
          { label: "Use these headers", value: "apply" },
          { label: "Ask AI again", value: "retry" },
          { label: "Edit manually", value: "manual" },
        ],
        current: "apply",
      });
      if (!gate || gate.kind !== "value") {
        mode = "select";
        continue;
      }
      if (gate.value === "apply") return suggestion.value as Record<string, string>;
      if (gate.value === "retry") {
        mode = "ai";
        continue;
      }
      mode = "select";
      continue;
    }

    const result = await selectUI<"keep" | "edit">(ctx, {
      title: "Request headers",
      note: current && Object.keys(current).length > 0
        ? `Current: ${JSON.stringify(current)}`
        : "No headers configured",
      options: [
        { label: current && Object.keys(current).length > 0 ? "Keep current headers" : "Skip headers", value: "keep" },
        { label: "Edit headers as JSON (multi-line)…", value: "edit" },
      ],
      current: "keep",
      allowAi: true,
    });
    if (!result) return undefined;
    if (result.kind === "ai") {
      mode = "ai";
      continue;
    }
    if (result.value === "keep") return current ?? {};

    const edited = await ctx.ui.editor("Request headers (JSON object)", headerDraft);
    if (edited === undefined) continue;
    headerDraft = edited;
    try {
      const parsed = JSON.parse(stripJsonc(edited)) as unknown;
      if (!isStringRecord(parsed)) throw new Error("expected a JSON object of string header values");
      return parsed;
    } catch (error) {
      ctx.ui.notify(
        `Headers not changed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }
}

interface ImageOptionsContext {
  provider: string;
  modelId: string;
  modelName?: string;
  baseUrl?: string;
  providerApi?: string;
  piModel?: PiChatModel;
  existing?: ImageModelSetup;
}

function aiContextForOptions(context: ImageOptionsContext, options?: ImageModelSetup): AiFieldContext {
  return {
    provider: context.provider,
    modelId: context.modelId,
    modelName: context.modelName,
    baseUrl: context.baseUrl,
    providerApi: context.providerApi,
    piModel: context.piModel,
    options: options ?? context.existing,
  };
}

/** Ask for the image options stored next to a model in the plugin config. */
async function askImageOptions(
  ctx: ExtensionContext,
  context: ImageOptionsContext,
): Promise<ImageModelSetup | undefined> {
  const providerConfig = readModelsJson().providers?.[context.provider];
  const inferredApi = context.existing?.api
    ?? (context.piModel
      ? inferPiImageApi(context.provider, providerConfig, context.modelId)
      : inferProviderImageApi(context.provider, context.providerApi));
  const title = (label: string) => `${label} — ${context.provider}/${context.modelId}`;

  if (!ctx.hasUI) {
    return {
      api: inferredApi,
      ...(inferredApi === "openai-images"
        ? { responseFormat: context.existing?.responseFormat ?? "url", supportsEdit: context.existing?.supportsEdit ?? true }
        : {}),
      ...(context.existing?.defaultAspectRatio ? { defaultAspectRatio: context.existing.defaultAspectRatio } : {}),
      ...(context.existing?.defaultImageSize ? { defaultImageSize: context.existing.defaultImageSize } : {}),
    };
  }

  const apiOptions: SelectOption<ImageApi>[] = [
    { label: "openai-images (OpenAI-compatible /images/generations)", value: "openai-images" },
    { label: "google-generative-ai-image (Gemini generateContent / Imagen predict)", value: "google-generative-ai-image" },
  ];
  const api = await askChoiceField<ImageApi>(ctx, {
    title: title("Image API"),
    options: preferredFirst(apiOptions, inferredApi),
    current: inferredApi,
    ai: {
      kind: "api",
      field: "api",
      guidance: "Use google-generative-ai-image for Gemini generateContent or Imagen predict; use openai-images for OpenAI-compatible /images/generations relays.",
      context: aiContextForOptions(context),
    },
  });
  if (api === undefined) return undefined;

  let responseFormat: "url" | "b64_json" = context.existing?.responseFormat ?? "url";
  let supportsEdit = context.existing?.supportsEdit ?? true;
  const partial = (): ImageModelSetup => ({
    api,
    ...(api === "openai-images" ? { responseFormat, supportsEdit } : {}),
    ...(context.existing?.defaultAspectRatio ? { defaultAspectRatio: context.existing.defaultAspectRatio } : {}),
    ...(context.existing?.defaultImageSize ? { defaultImageSize: context.existing.defaultImageSize } : {}),
  });

  if (api === "openai-images") {
    const format = await askChoiceField(ctx, {
      title: title("Response format"),
      options: preferredFirst([
        { label: "url — server returns an image link (or data URL)", value: "url" as const },
        { label: "b64_json — server returns image bytes", value: "b64_json" as const },
      ], responseFormat),
      current: responseFormat,
      ai: {
        kind: "responseFormat",
        field: "responseFormat",
        guidance: "Use url when the server returns a URL or data URL; use b64_json when it returns base64 image bytes.",
        context: aiContextForOptions(context, partial()),
      },
    });
    if (!format) return undefined;
    responseFormat = format;

    const edit = await askChoiceField<boolean>(ctx, {
      title: title("Image editing"),
      options: preferredFirst([
        { label: "Yes — supports /images/edits (imagePath, maskPath)", value: true },
        { label: "No — text-to-image only", value: false },
      ], supportsEdit),
      current: supportsEdit,
      ai: {
        kind: "boolean",
        field: "supportsEdit",
        guidance: "true only if the server supports POST /images/edits with an input image and optional mask.",
        context: aiContextForOptions(context, partial()),
      },
    });
    if (edit === undefined) return undefined;
    supportsEdit = edit;
  }

  const aspectOptions: SelectOption<string | null>[] = [
    { label: "Not set — the tool decides per request", value: null },
    ...ASPECT_RATIO_OPTIONS.map((value) => ({ label: value, value })),
  ];
  const aspect = await askChoiceField(ctx, {
    title: title("Default aspect ratio"),
    options: preferredFirst(aspectOptions, context.existing?.defaultAspectRatio ?? null),
    current: context.existing?.defaultAspectRatio ?? null,
    ai: {
      kind: "aspect",
      field: "defaultAspectRatio",
      guidance: "Pick a default aspect ratio only when the model or server has a clear convention; otherwise use null.",
      context: aiContextForOptions(context, partial()),
    },
  });
  if (aspect === undefined) return undefined;

  let defaultImageSize: string | undefined;
  if (api === "google-generative-ai-image") {
    const sizeOptions: SelectOption<string | null>[] = [
      { label: "Not set — use the model default (1K)", value: null },
      { label: "1K", value: "1K" },
      { label: "2K", value: "2K" },
      { label: "4K", value: "4K" },
    ];
    const size = await askChoiceField(ctx, {
      title: title("Default image size"),
      options: preferredFirst(sizeOptions, context.existing?.defaultImageSize ?? null),
      current: context.existing?.defaultImageSize ?? null,
      ai: {
        kind: "size",
        field: "defaultImageSize",
        guidance: "Gemini/Imagen resolution hint. Use null to keep the model default (1K).",
        context: aiContextForOptions(context, partial()),
      },
    });
    if (size === undefined) return undefined;
    defaultImageSize = size ?? undefined;
  }

  return {
    api,
    ...(api === "openai-images" ? { responseFormat, supportsEdit } : {}),
    ...(aspect != null ? { defaultAspectRatio: aspect } : {}),
    ...(defaultImageSize ? { defaultImageSize } : {}),
  };
}

// ── Settings mutation ──────────────────────────────────────────────

interface SettingsDraft {
  path: string;
  raw: Record<string, unknown>;
}

function readGlobalSettingsForUpdate(): SettingsDraft {
  const path = globalConfigPath();
  return { path, raw: readSettingsForUpdate(path) };
}

async function writeSettingsFile(path: string, raw: Record<string, unknown>): Promise<void> {
  await mkdir(settingsDir(), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function providersOf(raw: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const providers = raw.providers;
  if (!isRecord(providers)) return {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, provider] of Object.entries(providers)) {
    if (isRecord(provider)) result[name] = { ...provider };
  }
  return result;
}

function modelEntriesOf(provider: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(provider.models)
    ? provider.models.filter(isRecord).map((model) => ({ ...model }))
    : [];
}

function modelEntryFrom(
  options: ImageModelSetup,
  modelId: string,
  modelName: string | undefined,
  existing?: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...(existing ?? {}),
    id: modelId,
    api: options.api,
  };
  if (modelName) next.name = modelName;
  else if (typeof next.name !== "string") next.name = modelId;

  if (options.api === "openai-images") {
    next.responseFormat = options.responseFormat ?? "url";
    next.supportsEdit = options.supportsEdit ?? true;
  } else {
    delete next.responseFormat;
    delete next.supportsEdit;
  }
  if (options.defaultAspectRatio) next.defaultAspectRatio = options.defaultAspectRatio;
  else delete next.defaultAspectRatio;
  if (options.defaultImageSize) next.defaultImageSize = options.defaultImageSize;
  else delete next.defaultImageSize;

  return next;
}

function upsertModelEntry(
  raw: Record<string, unknown>,
  provider: string,
  modelId: string,
  modelName: string | undefined,
  options: ImageModelSetup,
  source: ImportedModelSource,
): void {
  const providers = providersOf(raw);
  const providerEntry = providers[provider] ?? {};
  const models = modelEntriesOf(providerEntry);
  const index = models.findIndex((model) => model.id === modelId);
  const nextModel = modelEntryFrom(options, modelId, modelName, index >= 0 ? models[index] : undefined);
  if (index >= 0) models[index] = nextModel;
  else models.push(nextModel);

  const existingHeaders = isStringRecord(providerEntry.headers) ? providerEntry.headers : {};
  const nextProvider: Record<string, unknown> = {
    ...providerEntry,
    baseUrl: source.baseUrl || (typeof providerEntry.baseUrl === "string" ? providerEntry.baseUrl : "") || "",
    api: providerEntry.api ?? options.api,
    models,
  };
  if (source.apiKey) nextProvider.apiKey = source.apiKey;
  if (source.headers && Object.keys(source.headers).length > 0) {
    nextProvider.headers = { ...existingHeaders, ...source.headers };
  }
  providers[provider] = nextProvider;
  raw.providers = providers;
}

function removeModelEntry(
  raw: Record<string, unknown>,
  provider: string,
  modelId: string,
): { removed: boolean; providerRemoved: boolean } {
  const providers = providersOf(raw);
  const providerEntry = providers[provider];
  if (!providerEntry) return { removed: false, providerRemoved: false };
  const models = modelEntriesOf(providerEntry);
  if (!models.some((model) => model.id === modelId)) return { removed: false, providerRemoved: false };
  const remaining = models.filter((model) => model.id !== modelId);
  let providerRemoved = false;
  if (remaining.length === 0) {
    delete providers[provider];
    providerRemoved = true;
  } else {
    providers[provider] = { ...providerEntry, models: remaining };
  }
  raw.providers = providers;
  if (raw.defaultProvider === provider && raw.defaultModel === modelId) {
    delete raw.defaultProvider;
    delete raw.defaultModel;
  }
  if (providerRemoved && raw.defaultProvider === provider) {
    delete raw.defaultProvider;
    delete raw.defaultModel;
  }
  return { removed: true, providerRemoved };
}

async function clearDefaultModel(provider: string, modelId: string): Promise<boolean> {
  const path = join(settingsDir(), MODEL_STATE_FILENAME);
  const existing = readJsonFile(path);
  if (existing.defaultProvider !== provider || existing.defaultModel !== modelId) return false;
  delete existing.defaultProvider;
  delete existing.defaultModel;
  await mkdir(settingsDir(), { recursive: true });
  await writeFile(path, JSON.stringify(existing, null, 2));
  return true;
}

async function renameSavedDefault(provider: string, oldId: string, newProvider: string, newId: string): Promise<boolean> {
  const path = join(settingsDir(), MODEL_STATE_FILENAME);
  const existing = readJsonFile(path);
  if (existing.defaultProvider !== provider || existing.defaultModel !== oldId) return false;
  existing.defaultProvider = newProvider;
  existing.defaultModel = newId;
  await mkdir(settingsDir(), { recursive: true });
  await writeFile(path, JSON.stringify(existing, null, 2));
  return true;
}

function validateSettingsObject(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected a JSON object");
  const providers = value.providers;
  if (providers !== undefined) {
    if (!isRecord(providers)) throw new Error("providers must be an object");
    for (const [provider, providerValue] of Object.entries(providers)) {
      if (!isRecord(providerValue)) throw new Error(`providers.${provider} must be an object`);
      if (providerValue.headers !== undefined && !isStringRecord(providerValue.headers)) {
        throw new Error(`providers.${provider}.headers must be an object of string values`);
      }
      if (providerValue.models !== undefined) {
        if (!Array.isArray(providerValue.models)) throw new Error(`providers.${provider}.models must be an array`);
        for (const modelValue of providerValue.models) {
          if (!isRecord(modelValue)) throw new Error(`providers.${provider}.models[] must contain objects`);
          if (typeof modelValue.id !== "string" || !modelValue.id.trim()) {
            throw new Error(`providers.${provider}.models[].id must be a non-empty string`);
          }
          if (modelValue.api !== undefined && modelValue.api !== "openai-images" && modelValue.api !== "google-generative-ai-image") {
            throw new Error(`providers.${provider}.models[].api must be openai-images or google-generative-ai-image`);
          }
          if (modelValue.responseFormat !== undefined && modelValue.responseFormat !== "url" && modelValue.responseFormat !== "b64_json") {
            throw new Error(`providers.${provider}.models[].responseFormat must be url or b64_json`);
          }
          if (modelValue.supportsEdit !== undefined && typeof modelValue.supportsEdit !== "boolean") {
            throw new Error(`providers.${provider}.models[].supportsEdit must be a boolean`);
          }
          for (const key of ["defaultAspectRatio", "defaultImageSize"] as const) {
            if (modelValue[key] !== undefined && typeof modelValue[key] !== "string") {
              throw new Error(`providers.${provider}.models[].${key} must be a string`);
            }
          }
        }
      }
    }
  }
  for (const key of ["defaultProvider", "defaultModel"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new Error(`${key} must be a string`);
  }
}

// ── Import from Pi and custom model flows ─────────────────────────

/** Credentials and headers copied from Pi into the plugin config. */
async function readImportSource(ctx: ExtensionContext, item: ImageModelPickItem): Promise<ImportedModelSource> {
  if (!item.piModel) return {};
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(item.piModel);
  const apiKey = auth.ok && auth.apiKey
    ? auth.apiKey
    : await ctx.modelRegistry.getApiKeyForProvider(item.provider);
  return {
    baseUrl: (auth.ok ? auth.baseUrl : undefined) || item.piModel.baseUrl,
    apiKey,
    headers: auth.ok ? providerHeadersToRecord(auth.headers) : undefined,
  };
}

function toPickItem(model: ResolvedImageModel, config: ExtensionConfig): ImageModelPickItem {
  return {
    key: `${model.provider}/${model.id}`,
    provider: model.provider,
    id: model.id,
    name: model.name,
    catalogModel: model,
    inConfig: isModelInPluginConfig(config, model.provider, model.id),
  };
}

async function importPiItem(
  ctx: ExtensionContext,
  item: ImageModelPickItem,
): Promise<ImageModelPickItem | undefined> {
  const existing = item.catalogModel;
  const existingOptions: ImageModelSetup | undefined = existing
    ? {
        api: existing.api,
        responseFormat: existing.responseFormat,
        supportsEdit: existing.supportsEdit,
        defaultAspectRatio: existing.defaultAspectRatio,
        defaultImageSize: existing.defaultImageSize,
      }
    : undefined;

  if (item.inConfig && existingOptions) {
    const keep = "Keep the current configuration";
    const choice = await ctx.ui.select(
      `${item.provider}/${item.id} is in pi-image-gen.json (${imageModelDetail(existing!)})`,
      [keep, "Reconfigure and re-import"],
    );
    if (choice === undefined) return undefined;
    if (choice === keep) return item;
  }

  const options = await askImageOptions(ctx, {
    provider: item.provider,
    modelId: item.id,
    modelName: item.name,
    baseUrl: item.piModel?.baseUrl,
    piModel: item.piModel,
    existing: existingOptions,
  });
  if (!options) return undefined;

  const source = await readImportSource(ctx, item);
  const draft = readGlobalSettingsForUpdate();
  upsertModelEntry(draft.raw, item.provider, item.id, item.name, options, source);
  await writeSettingsFile(draft.path, draft.raw);
  ctx.ui.notify(`Wrote ${item.provider}/${item.id} to ${draft.path}.`, "info");
  return toPickItem({
    id: item.id,
    name: item.name,
    provider: item.provider,
    baseUrl: source.baseUrl || item.piModel?.baseUrl || "",
    cost: existing?.cost ?? 0,
    ...options,
  }, loadConfig(ctx.cwd));
}

async function addFromPiFlow(
  ctx: ExtensionContext,
  config: ExtensionConfig,
): Promise<ImageModelPickItem | undefined> {
  if (!ctx.hasUI) return undefined;
  const items = piPickItems(ctx, config);
  if (items.length === 0) {
    ctx.ui.notify("No models found in providers declared in ~/.pi/agent/models.json.", "warning");
    return undefined;
  }
  items.sort((a, b) =>
    Number(a.inConfig) - Number(b.inConfig) ||
    a.provider.localeCompare(b.provider) ||
    a.id.localeCompare(b.id),
  );
  const picked = await pickImageModel(ctx, items, {
    currentKey: null,
    defaultKey: null,
    actions: false,
    showConfigBadge: true,
    hint: "Models from providers in ~/.pi/agent/models.json. Configured entries can be kept or reconfigured.",
  });
  if (!picked || picked.kind !== "select") return undefined;
  return importPiItem(ctx, picked.item);
}

// ── Custom add flow ────────────────────────────────────────────────

type ProviderChoice = { kind: "existing"; provider: string } | { kind: "new" };

async function addCustomFlow(
  ctx: ExtensionContext,
  config: ExtensionConfig,
): Promise<ImageModelPickItem | undefined> {
  if (!ctx.hasUI) return undefined;
  const providerNames = Object.keys(config.providers ?? {}).sort();
  const choices: SelectOption<ProviderChoice>[] = [
    ...providerNames.map((provider) => ({ label: `Existing provider: ${provider}`, value: { kind: "existing" as const, provider } })),
    { label: "＋ New provider…", value: { kind: "new" } },
  ];
  const providerChoice = await askChoiceField<ProviderChoice>(ctx, {
    title: "Add image model — provider",
    options: choices,
    current: choices[0]?.value,
  });
  if (!providerChoice) return undefined;

  let provider: string;
  if (providerChoice.kind === "new") {
    const input = await askTextField(ctx, {
      title: "New provider name",
      placeholder: "e.g. my-relay",
      validate: (value) => {
        if (!value.trim()) return "Provider name cannot be empty.";
        if (/\s/.test(value)) return "Provider name cannot contain spaces.";
        if (value.includes("/")) return "Provider name cannot contain '/'.";
        if (config.providers?.[value]) return "That provider already exists.";
        return undefined;
      },
    });
    if (input === undefined) return undefined;
    provider = input.trim();
  } else {
    provider = providerChoice.provider;
  }

  const providerEntry = providersOf(readGlobalSettingsForUpdate().raw)[provider] ?? {};
  const baseUrl = typeof providerEntry.baseUrl === "string" ? providerEntry.baseUrl : "";
  const providerApi = typeof providerEntry.api === "string" ? providerEntry.api : undefined;

  const modelId = await askTextField(ctx, {
    title: `Model ID — ${provider}`,
    placeholder: "exact id sent to the API",
    validate: (value) => value.trim() ? undefined : "Model ID cannot be empty.",
    ai: {
      kind: "id",
      field: "model id",
      guidance: "Suggest the provider's exact model id only when it is obvious from the context; otherwise repeat the current value.",
      context: { provider, modelId: "", baseUrl, providerApi },
    },
  });
  if (modelId === undefined) return undefined;
  const id = modelId.trim();

  const existingDraft = readGlobalSettingsForUpdate();
  if (modelEntriesOf(providersOf(existingDraft.raw)[provider] ?? {}).some((model) => model.id === id)) {
    ctx.ui.notify(`${provider}/${id} already exists. Use edit to change it.`, "warning");
    return undefined;
  }

  const modelName = await askTextField(ctx, {
    title: `Display name — ${provider}/${id}`,
    value: id,
    validate: (value) => value.trim() ? undefined : "Display name cannot be empty.",
    ai: {
      kind: "text",
      field: "display name",
      guidance: "Suggest a short human-readable display name; preserve the model family and version.",
      context: { provider, modelId: id, baseUrl, providerApi },
    },
  });
  if (modelName === undefined) return undefined;

  const options = await askImageOptions(ctx, {
    provider,
    modelId: id,
    modelName: modelName.trim(),
    baseUrl,
    providerApi,
  });
  if (!options) return undefined;

  const piProviderConfig = readModelsJson().providers?.[provider];
  let nextBaseUrl = baseUrl || piProviderConfig?.baseUrl || "";
  if (!nextBaseUrl) {
    const input = await askTextField(ctx, {
      title: `Base URL — ${provider}`,
      placeholder: "https://api.example.com/v1",
      validate: (value) => {
        if (!value.trim()) return "Base URL is required for a new provider.";
        try {
          const url = new URL(value.trim());
          if (url.protocol !== "http:" && url.protocol !== "https:") return "Base URL must start with http:// or https://.";
        } catch {
          return "Enter a valid URL.";
        }
        return undefined;
      },
      ai: {
        kind: "url",
        field: "base URL",
        guidance: "Suggest the API base URL including /v1 where needed. Only suggest official or well-known endpoints; do not guess unknown relays.",
        context: { provider, modelId: id, baseUrl, providerApi, options },
      },
    });
    if (input === undefined) return undefined;
    nextBaseUrl = input.trim();
  }

  let apiKey = typeof providerEntry.apiKey === "string" ? providerEntry.apiKey : "";
  if (!apiKey) {
    const input = await askTextField(ctx, {
      title: `API key — ${provider} (optional)`,
      note: "Leave blank to rely on Pi auth or environment variables.",
      value: "",
      placeholder: "sk-…",
    });
    if (input === undefined) return undefined;
    apiKey = input.trim();
  }

  const currentHeaders = isStringRecord(providerEntry.headers) ? providerEntry.headers : undefined;
  const headers = await askHeaders(ctx, currentHeaders, {
    provider,
    modelId: id,
    modelName: modelName.trim(),
    baseUrl: nextBaseUrl,
    providerApi,
    options,
  });
  if (headers === undefined) return undefined;

  const confirmed = await askChoiceField<boolean>(ctx, {
    title: `Add ${provider}/${id}`,
    note: [
      `API: ${options.api}`,
      options.responseFormat ? `Response: ${options.responseFormat}` : undefined,
      `Base URL: ${nextBaseUrl}`,
      `Headers: ${Object.keys(headers).length}`,
      `API key: ${apiKey ? "set" : "not set"}`,
    ].filter(Boolean).join(" · "),
    options: [
      { label: "Add model", value: true },
      { label: "Cancel", value: false },
    ],
    current: true,
  });
  if (!confirmed) return undefined;

  const draft = readGlobalSettingsForUpdate();
  upsertModelEntry(draft.raw, provider, id, modelName.trim(), options, {
    baseUrl: nextBaseUrl,
    apiKey: apiKey || undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  });
  await writeSettingsFile(draft.path, draft.raw);
  ctx.ui.notify(`Added ${provider}/${id} to ${draft.path}.`, "info");
  return toPickItem({
    id,
    name: modelName.trim(),
    provider,
    baseUrl: nextBaseUrl,
    cost: 0,
    ...options,
  }, loadConfig(ctx.cwd));
}

// ── Edit flow ─────────────────────────────────────────────────────

interface EditResult {
  item: ImageModelPickItem;
  previousProvider: string;
  previousId: string;
}

async function editFlow(
  ctx: ExtensionContext,
  item: ImageModelPickItem,
): Promise<EditResult | undefined> {
  if (!ctx.hasUI) return undefined;
  const draft = readGlobalSettingsForUpdate();
  const providers = providersOf(draft.raw);
  const providerEntry = providers[item.provider];
  if (!providerEntry) {
    ctx.ui.notify(
      `${item.provider}/${item.id} is not declared in the global settings file. Use JSON mode (j) or edit the config directly.`,
      "warning",
    );
    return undefined;
  }
  const models = modelEntriesOf(providerEntry);
  const index = models.findIndex((model) => model.id === item.id);
  if (index < 0) {
    ctx.ui.notify(`${item.provider}/${item.id} is not declared in the global settings file.`, "warning");
    return undefined;
  }

  const original = models[index]!;
  let modelId = item.id;
  let modelName = typeof original.name === "string" ? original.name : item.id;
  let options: ImageModelSetup = {
    api: original.api === "google-generative-ai-image" || original.api === "openai-images"
      ? original.api
      : item.catalogModel?.api ?? "openai-images",
    responseFormat: original.responseFormat === "b64_json" || original.responseFormat === "url"
      ? original.responseFormat
      : item.catalogModel?.responseFormat ?? "url",
    supportsEdit: typeof original.supportsEdit === "boolean" ? original.supportsEdit : item.catalogModel?.supportsEdit ?? true,
    defaultAspectRatio: typeof original.defaultAspectRatio === "string" ? original.defaultAspectRatio : item.catalogModel?.defaultAspectRatio,
    defaultImageSize: typeof original.defaultImageSize === "string" ? original.defaultImageSize : item.catalogModel?.defaultImageSize,
  };
  let providerBaseUrl = typeof providerEntry.baseUrl === "string" ? providerEntry.baseUrl : "";
  let providerApi = typeof providerEntry.api === "string" ? providerEntry.api : options.api;
  let providerApiKey = typeof providerEntry.apiKey === "string" ? providerEntry.apiKey : "";
  let providerHeaders = isStringRecord(providerEntry.headers) ? providerEntry.headers : {};
  let dirty = false;

  const aiContext = (): AiFieldContext => ({
    provider: item.provider,
    modelId,
    modelName,
    baseUrl: providerBaseUrl,
    providerApi,
    options,
  });

  const save = async (): Promise<EditResult> => {
    const nextModels = modelEntriesOf(providerEntry);
    const nextIndex = nextModels.findIndex((model) => model.id === item.id);
    if (nextIndex < 0) throw new Error(`${item.provider}/${item.id} disappeared from the settings draft.`);
    if (modelId !== item.id && nextModels.some((model) => model.id === modelId)) {
      throw new Error(`${item.provider}/${modelId} already exists.`);
    }
    nextModels[nextIndex] = modelEntryFrom(options, modelId, modelName, nextModels[nextIndex]);
    const nextProvider: Record<string, unknown> = {
      ...providerEntry,
      baseUrl: providerBaseUrl,
      api: providerApi,
      models: nextModels,
    };
    if (providerApiKey) nextProvider.apiKey = providerApiKey;
    else delete nextProvider.apiKey;
    if (Object.keys(providerHeaders).length > 0) nextProvider.headers = providerHeaders;
    else delete nextProvider.headers;
    providers[item.provider] = nextProvider;
    draft.raw.providers = providers;
    if (draft.raw.defaultProvider === item.provider && draft.raw.defaultModel === item.id) {
      draft.raw.defaultModel = modelId;
    }
    await writeSettingsFile(draft.path, draft.raw);
    ctx.ui.notify(`Saved ${item.provider}/${modelId} to ${draft.path}.`, "info");
    return {
      item: toPickItem({
        id: modelId,
        name: modelName,
        provider: item.provider,
        baseUrl: providerBaseUrl,
        cost: typeof original.cost === "number" ? original.cost : 0,
        ...options,
      }, loadConfig(ctx.cwd)),
      previousProvider: item.provider,
      previousId: item.id,
    };
  };

  while (true) {
    const responseFormatLabel = options.api === "openai-images" ? options.responseFormat ?? "url" : "n/a";
    const fields: SelectOption<string>[] = [
      { label: `Name: ${modelName}`, value: "name" },
      { label: `Model ID: ${modelId}`, value: "id" },
      { label: `Image API: ${options.api}`, value: "api" },
      ...(options.api === "openai-images"
        ? [
            { label: `Response format: ${responseFormatLabel}`, value: "responseFormat" },
            { label: `Image editing: ${options.supportsEdit === false ? "no" : "yes"}`, value: "supportsEdit" },
          ]
        : []),
      { label: `Default aspect ratio: ${options.defaultAspectRatio ?? "not set"}`, value: "aspect" },
      ...(options.api === "google-generative-ai-image"
        ? [{ label: `Default image size: ${options.defaultImageSize ?? "not set"}`, value: "size" }]
        : []),
      { label: `Provider base URL: ${providerBaseUrl || "not set"}`, value: "baseUrl" },
      { label: `Provider default API: ${providerApi}`, value: "providerApi" },
      { label: `Provider API key: ${providerApiKey ? "set" : "not set"}`, value: "apiKey" },
      { label: `Provider headers: ${Object.keys(providerHeaders).length}`, value: "headers" },
      { label: "Done — save changes", value: "done" },
    ];

    const field = await askChoiceField<string>(ctx, {
      title: `Edit ${item.provider}/${modelId}`,
      note: dirty ? "Unsaved changes" : undefined,
      options: fields,
    });

    if (field === undefined) {
      if (!dirty) return undefined;
      const decision = await askChoiceField<string>(ctx, {
        title: "Unsaved changes",
        options: [
          { label: "Save changes", value: "save" },
          { label: "Discard changes", value: "discard" },
          { label: "Continue editing", value: "continue" },
        ],
        current: "continue",
      });
      if (decision === "save") return await save();
      if (decision === "discard") return undefined;
      continue;
    }

    switch (field) {
      case "name": {
        const value = await askTextField(ctx, {
          title: `Display name — ${item.provider}/${modelId}`,
          value: modelName,
          validate: (input) => input.trim() ? undefined : "Display name cannot be empty.",
          ai: {
            kind: "text",
            field: "display name",
            guidance: "Suggest a short human-readable display name; preserve the model family and version.",
            context: aiContext(),
          },
        });
        if (value !== undefined) {
          modelName = value.trim();
          dirty = true;
        }
        break;
      }
      case "id": {
        const value = await askTextField(ctx, {
          title: `Model ID — ${item.provider}`,
          value: modelId,
          validate: (input) => {
            if (!input.trim()) return "Model ID cannot be empty.";
            const clash = modelEntriesOf(providerEntry).some((model) => model.id === input.trim() && model.id !== item.id);
            if (clash) return `${item.provider}/${input.trim()} already exists.`;
            return undefined;
          },
          ai: {
            kind: "id",
            field: "model id",
            guidance: "Suggest the provider's exact model id only when it is obvious from the context; otherwise repeat the current value.",
            context: aiContext(),
          },
        });
        if (value !== undefined) {
          modelId = value.trim();
          dirty = true;
        }
        break;
      }
      case "api": {
        const value = await askChoiceField<ImageApi>(ctx, {
          title: `Image API — ${item.provider}/${modelId}`,
          options: [
            { label: "openai-images (OpenAI-compatible /images/generations)", value: "openai-images" },
            { label: "google-generative-ai-image (Gemini generateContent / Imagen predict)", value: "google-generative-ai-image" },
          ],
          current: options.api,
          ai: {
            kind: "api",
            field: "api",
            guidance: "Use google-generative-ai-image for Gemini generateContent or Imagen predict; use openai-images for OpenAI-compatible relays.",
            context: aiContext(),
          },
        });
        if (value !== undefined) {
          options.api = value;
          dirty = true;
        }
        break;
      }
      case "responseFormat": {
        const value = await askChoiceField<"url" | "b64_json">(ctx, {
          title: `Response format — ${item.provider}/${modelId}`,
          options: [
            { label: "url — server returns an image link (or data URL)", value: "url" },
            { label: "b64_json — server returns image bytes", value: "b64_json" },
          ],
          current: options.responseFormat ?? "url",
          ai: {
            kind: "responseFormat",
            field: "responseFormat",
            guidance: "Use url when the server returns a URL or data URL; use b64_json when it returns base64 image bytes.",
            context: aiContext(),
          },
        });
        if (value !== undefined) {
          options.responseFormat = value;
          dirty = true;
        }
        break;
      }
      case "supportsEdit": {
        const value = await askChoiceField<boolean>(ctx, {
          title: `Image editing — ${item.provider}/${modelId}`,
          options: [
            { label: "Yes — supports /images/edits", value: true },
            { label: "No — text-to-image only", value: false },
          ],
          current: options.supportsEdit ?? true,
          ai: {
            kind: "boolean",
            field: "supportsEdit",
            guidance: "true only if the server supports POST /images/edits with an input image and optional mask.",
            context: aiContext(),
          },
        });
        if (value !== undefined) {
          options.supportsEdit = value;
          dirty = true;
        }
        break;
      }
      case "aspect": {
        const value = await askChoiceField<string | null>(ctx, {
          title: `Default aspect ratio — ${item.provider}/${modelId}`,
          options: [
            { label: "Not set — the tool decides per request", value: null },
            ...ASPECT_RATIO_OPTIONS.map((ratio) => ({ label: ratio, value: ratio })),
          ],
          current: options.defaultAspectRatio ?? null,
          ai: {
            kind: "aspect",
            field: "defaultAspectRatio",
            guidance: "Pick a default aspect ratio only when the model or server has a clear convention; otherwise use null.",
            context: aiContext(),
          },
        });
        if (value !== undefined) {
          options.defaultAspectRatio = value ?? undefined;
          dirty = true;
        }
        break;
      }
      case "size": {
        const value = await askChoiceField<string | null>(ctx, {
          title: `Default image size — ${item.provider}/${modelId}`,
          options: [
            { label: "Not set — use the model default (1K)", value: null },
            { label: "1K", value: "1K" },
            { label: "2K", value: "2K" },
            { label: "4K", value: "4K" },
          ],
          current: options.defaultImageSize ?? null,
          ai: {
            kind: "size",
            field: "defaultImageSize",
            guidance: "Gemini/Imagen resolution hint. Use null to keep the model default (1K).",
            context: aiContext(),
          },
        });
        if (value !== undefined) {
          options.defaultImageSize = value ?? undefined;
          dirty = true;
        }
        break;
      }
      case "baseUrl": {
        ctx.ui.notify(`Base URL affects every model in provider "${item.provider}".`, "warning");
        const value = await askTextField(ctx, {
          title: `Provider base URL — ${item.provider}`,
          value: providerBaseUrl,
          placeholder: "https://api.example.com/v1",
          ai: {
            kind: "url",
            field: "provider base URL",
            guidance: "Suggest the API base URL including /v1 where needed. Only suggest official or well-known endpoints; do not guess unknown relays.",
            context: aiContext(),
          },
        });
        if (value !== undefined) {
          providerBaseUrl = value.trim();
          dirty = true;
        }
        break;
      }
      case "providerApi": {
        const value = await askChoiceField<ImageApi>(ctx, {
          title: `Provider default API — ${item.provider}`,
          options: [
            { label: "openai-images", value: "openai-images" },
            { label: "google-generative-ai-image", value: "google-generative-ai-image" },
          ],
          current: providerApi as ImageApi,
          ai: {
            kind: "api",
            field: "provider default api",
            guidance: "Default API for models in this provider that do not override it.",
            context: aiContext(),
          },
        });
        if (value !== undefined) {
          providerApi = value;
          dirty = true;
        }
        break;
      }
      case "apiKey": {
        const choice = await askChoiceField<"keep" | "replace" | "clear">(ctx, {
          title: `Provider API key — ${item.provider}`,
          note: providerApiKey ? "A key is currently set." : "No key is set.",
          options: [
            { label: "Keep current", value: "keep" },
            { label: "Replace…", value: "replace" },
            { label: "Clear", value: "clear" },
          ],
          current: "keep",
        });
        if (choice === "replace") {
          const value = await askTextField(ctx, {
            title: `New API key — ${item.provider}`,
            placeholder: "sk-…",
            validate: (input) => input.trim() ? undefined : "API key cannot be empty; choose Clear instead.",
          });
          if (value !== undefined) {
            providerApiKey = value.trim();
            dirty = true;
          }
        } else if (choice === "clear") {
          providerApiKey = "";
          dirty = true;
        }
        break;
      }
      case "headers": {
        const value = await askHeaders(ctx, providerHeaders, aiContext());
        if (value !== undefined) {
          providerHeaders = value;
          dirty = true;
        }
        break;
      }
      case "done": {
        if (!dirty) return undefined;
        const clash = modelEntriesOf(providerEntry).some((model) => model.id === modelId && model.id !== item.id);
        if (clash) {
          ctx.ui.notify(`${item.provider}/${modelId} already exists.`, "warning");
          continue;
        }
        return await save();
      }
    }
  }
}

// ── Delete flow ───────────────────────────────────────────────────

interface DeleteResult {
  deleted: boolean;
  providerRemoved: boolean;
}

async function deleteFlow(
  ctx: ExtensionContext,
  item: ImageModelPickItem,
): Promise<DeleteResult | undefined> {
  if (!ctx.hasUI) return undefined;
  const confirmed = await askChoiceField<boolean>(ctx, {
    title: `Delete ${item.provider}/${item.id}?`,
    note: `This rewrites the global ${basename(globalConfigPath())} and drops JSONC comments.`,
    options: [
      { label: "Delete model", value: true },
      { label: "Cancel", value: false },
    ],
    current: false,
  });
  if (!confirmed) return undefined;

  const draft = readGlobalSettingsForUpdate();
  const result = removeModelEntry(draft.raw, item.provider, item.id);
  if (!result.removed) {
    ctx.ui.notify(`${item.provider}/${item.id} is not declared in the global settings file.`, "warning");
    return undefined;
  }
  await writeSettingsFile(draft.path, draft.raw);
  ctx.ui.notify(
    result.providerRemoved
      ? `Deleted ${item.provider}/${item.id} and removed the empty provider.`
      : `Deleted ${item.provider}/${item.id}.`,
    "info",
  );
  return { deleted: true, providerRemoved: result.providerRemoved };
}

// ── JSON mode ─────────────────────────────────────────────────────

async function jsonFlow(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;
  const path = globalConfigPath();
  let draft = existsSync(path)
    ? readFileSync(path, "utf-8")
    : `${JSON.stringify({ providers: {} }, null, 2)}\n`;
  try {
    const parsed = JSON.parse(stripJsonc(draft)) as unknown;
    draft = `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    // Keep the raw text so the user can fix invalid JSON in the editor.
  }

  while (true) {
    const edited = await ctx.ui.editor(`Edit ${basename(path)} (global, JSON)`, draft);
    if (edited === undefined) return;
    try {
      const parsed = JSON.parse(stripJsonc(edited)) as unknown;
      validateSettingsObject(parsed);
      await writeSettingsFile(path, parsed);
      ctx.ui.notify(`Saved ${path}.`, "info");
      return;
    } catch (error) {
      const choice = await askChoiceField<string>(ctx, {
        title: "Invalid settings",
        note: error instanceof Error ? error.message : String(error),
        options: [
          { label: "Edit again", value: "edit" },
          { label: "Discard changes", value: "discard" },
        ],
        current: "edit",
      });
      if (choice !== "edit") return;
      draft = edited;
    }
  }
}


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
    let sawSelectionEntry = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === SESSION_ENTRY_TYPE) {
        const data = entry.data as ModelSelection | null | undefined;
        // A null entry is the tombstone written when the selected model is deleted.
        sessionSelection = data?.provider && data?.model ? data : null;
        sawSelectionEntry = true;
      }
    }
    if (!sessionSelection && !sawSelectionEntry) {
      const config = loadConfig(ctx.cwd);
      if (config.defaultProvider && config.defaultModel) {
        sessionSelection = { provider: config.defaultProvider, model: config.defaultModel };
      }
    }
    ctx.ui.setStatus(
      "image-model",
      sessionSelection ? `🎨 ${sessionSelection.provider}/${sessionSelection.model}` : undefined,
    );
  });

  // ── /image-model command ──

  pi.registerCommand("image-model", {
    description: "Select, add, edit or delete image generation models",

    getArgumentCompletions(prefix: string) {
      const config = loadConfig(process.cwd());
      return getAllModels(config)
        .map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.name} (${model.provider})` }))
        .filter((item) => item.value.startsWith(prefix))
        .sort((a, b) => a.value.localeCompare(b.value));
    },

    async handler(args: string, ctx) {
      const saveSelection = async (item: ImageModelPickItem) => {
        sessionSelection = { provider: item.provider, model: item.id };
        pi.appendEntry(SESSION_ENTRY_TYPE, sessionSelection);
        await saveDefaultModel(item.provider, item.id);
        ctx.ui.setStatus("image-model", `🎨 ${item.provider}/${item.id}`);
        ctx.ui.notify(`Image model: ${item.name} (${item.provider}/${item.id})`, "info");
      };

      const clearSelectionIfCurrent = async (provider: string, id: string) => {
        if (sessionSelection?.provider === provider && sessionSelection.model === id) {
          sessionSelection = null;
          pi.appendEntry(SESSION_ENTRY_TYPE, null);
          ctx.ui.setStatus("image-model", undefined);
        }
        const cleared = await clearDefaultModel(provider, id);
        if (cleared) ctx.ui.notify(`Cleared the saved default for ${provider}/${id}.`, "info");
      };

      const renameSelectionIfCurrent = async (
        previousProvider: string,
        previousId: string,
        item: ImageModelPickItem,
      ) => {
        if (sessionSelection?.provider === previousProvider && sessionSelection.model === previousId) {
          sessionSelection = { provider: item.provider, model: item.id };
          pi.appendEntry(SESSION_ENTRY_TYPE, sessionSelection);
          await saveDefaultModel(item.provider, item.id);
          ctx.ui.setStatus("image-model", `🎨 ${item.provider}/${item.id}`);
          ctx.ui.notify(`Selection updated to ${item.provider}/${item.id}.`, "info");
        }
      };

      const input = args.trim();

      // Direct selection: /image-model meatroll/gemini-4-argon
      if (input) {
        const config = loadConfig(ctx.cwd);
        const items = configuredPickItems(config);
        let found = items.find((item) => item.key === input);
        if (!found) {
          // Model ids may contain slashes ("z-ai/glm-5.3"), so match the full input too.
          const byId = items.filter((item) => item.id === input);
          if (byId.length === 1) found = byId[0];
          else if (byId.length > 1) {
            ctx.ui.notify(
              `Model "${input}" exists in several providers: ${byId.map((item) => item.provider).join(", ")}. Use provider/model.`,
              "error",
            );
            return;
          }
        }
        if (found) {
          await saveSelection(found);
          return;
        }

        const piItems = piPickItems(ctx, config);
        let piFound = piItems.find((item) => item.key === input);
        if (!piFound) {
          const byId = piItems.filter((item) => item.id === input);
          if (byId.length === 1) piFound = byId[0];
          else if (byId.length > 1) {
            ctx.ui.notify(
              `Model "${input}" exists in several Pi providers: ${byId.map((item) => item.provider).join(", ")}. Use provider/model.`,
              "error",
            );
            return;
          }
        }
        if (piFound) {
          const imported = await importPiItem(ctx, piFound);
          if (imported) await saveSelection(imported);
          return;
        }

        ctx.ui.notify(
          `Unknown image model "${input}". Run /image-model to see configured models, then press a to add one.`,
          "error",
        );
        return;
      }

      if (!ctx.hasUI) {
        const config = loadConfig(ctx.cwd);
        const current = sessionSelection ?? (config.defaultProvider && config.defaultModel
          ? { provider: config.defaultProvider, model: config.defaultModel }
          : null);
        ctx.ui.notify(
          current
            ? `Current image model: ${current.provider}/${current.model}`
            : "No image models configured. Add one in pi-image-gen.json.",
          current ? "info" : "warning",
        );
        return;
      }

      // Interactive loop: after add/edit/delete/JSON, reopen the refreshed list.
      while (true) {
        const config = loadConfig(ctx.cwd);
        const currentKey = sessionSelection ? `${sessionSelection.provider}/${sessionSelection.model}` : null;
        const accountDefault = config.defaultProvider && config.defaultModel
          ? `${config.defaultProvider}/${config.defaultModel}`
          : null;
        const items = configuredPickItems(config).sort((a, b) => {
          const rank = (item: ImageModelPickItem) =>
            item.key === currentKey ? 0 : item.key === accountDefault ? 1 : 2;
          return rank(a) - rank(b) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
        });
        const result = await pickImageModel(ctx, items, {
          currentKey,
          defaultKey: accountDefault,
          actions: true,
        });
        if (!result) return;

        switch (result.kind) {
          case "select":
            await saveSelection(result.item);
            return;

          case "add": {
            const choice = await askChoiceField<"custom" | "pi" | "cancel">(ctx, {
              title: "Add image model",
              options: [
                { label: "Custom model…", value: "custom" },
                { label: "From Pi's models.json…", value: "pi" },
                { label: "Cancel", value: "cancel" },
              ],
              current: "custom",
            });
            if (!choice || choice === "cancel") continue;
            const added = choice === "custom"
              ? await addCustomFlow(ctx, config)
              : await addFromPiFlow(ctx, config);
            if (added) {
              await saveSelection(added);
              return;
            }
            continue;
          }

          case "edit": {
            const edited = await editFlow(ctx, result.item);
            if (edited) {
              await renameSelectionIfCurrent(edited.previousProvider, edited.previousId, edited.item);
              await renameSavedDefault(edited.previousProvider, edited.previousId, edited.item.provider, edited.item.id);
            }
            continue;
          }

          case "delete": {
            const deleted = await deleteFlow(ctx, result.item);
            if (deleted?.deleted) {
              await clearSelectionIfCurrent(result.item.provider, result.item.id);
            }
            continue;
          }

          case "json": {
            await jsonFlow(ctx);
            const nextConfig = loadConfig(ctx.cwd);
            if (
              sessionSelection &&
              !getAllModels(nextConfig).some(
                (model) => model.provider === sessionSelection!.provider && model.id === sessionSelection!.model,
              )
            ) {
              sessionSelection = null;
              pi.appendEntry(SESSION_ENTRY_TYPE, null);
              ctx.ui.setStatus("image-model", undefined);
              ctx.ui.notify("The selected image model no longer exists.", "warning");
            }
            continue;
          }
        }
      }
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
      const supportsEdit = imageModel.supportsEdit ?? imageModel.api === "openai-images";
      let aspectRatio = params.aspectRatio || imageModel.defaultAspectRatio || "1:1";
      const imageSize = params.imageSize || imageModel.defaultImageSize || "1K";
      const quality = params.quality || "auto";
      let prompt = params.prompt;

      const hasEditInput = Boolean(params.imagePath || params.maskPath);
      if (params.maskPath && !params.imagePath) {
        throw new Error("maskPath requires imagePath.");
      }
      if (hasEditInput && !supportsEdit) {
        throw new Error(
          `Image editing is not enabled for ${imageModel.provider}/${imageModel.id}` +
          (imageModel.api === "openai-images"
            ? "; enable it with /image-model."
            : ` (${imageModel.api} does not expose /images/edits).`),
        );
      }
      const inputPath = params.imagePath ? resolveInputImagePath(params.imagePath, ctx.cwd) : undefined;
      const inputImage = inputPath
        ? await loadInputImage(inputPath, ctx.cwd, "input image")
        : undefined;
      if (inputImage && !params.aspectRatio && !imageModel.defaultAspectRatio) {
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
