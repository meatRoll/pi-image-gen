# pi-image-gen

![pi-image-gen model selector](screenshot.png)

```bash
pi install @meatroll/pi-image-gen
```

Image generation extension for [pi](https://github.com/badlogic/pi-mono). Adds a `generate_image` tool, an interactive browser edit-region selector, and `/image-model`. Supports OpenAI, Google, and OpenRouter providers, with runtime discovery of new models from OpenRouter.

## Features

- 🎨 **20+ built-in models** — OpenAI, Google Gemini, OpenRouter (FLUX, Seedream, Riverflow, and more)
- 🔄 **Runtime discovery** — Automatically finds new OpenRouter image models on startup
- ⚙️ **Custom providers** — Point at any compatible API via settings files
- 🖼️ **Aspect ratios & quality** — 1:1, 16:9, 9:16, 4:3, etc. with quality controls
- 💾 **Flexible save modes** — Project-local, global, or custom directory
- 🎯 **`/image-model` command** — Interactive fuzzy-search model picker with session persistence
- 🖱️ **Interactive editing** — The edit flow first asks whether to select a region, then launches the browser freehand lasso tool; after selection, choose the suggested prompt or write a custom one

## Install

```bash
pi install npm:@meatroll/pi-image-gen
# or from local path
pi install /path/to/pi-image-gen
```

## Usage

Just ask the agent to generate an image:

```
> Generate an image of a sunset over mountains

> Create a 16:9 wallpaper of a cyberpunk city using dall-e-3

> Make me a logo for a coffee shop, save it to the project
```

### Image-to-image editing

Pass a local image path through `imagePath` to edit an existing image. With an `openai-images` model, the extension sends a `multipart/form-data` request to `/v1/images/edits`.

In interactive Pi TUI mode, leave `maskPath` out. The extension first asks **“Select an edit area?”** and only launches a selector after you choose one:

- **Launch browser mask tool (freehand lasso)** — opens a local browser canvas where you draw freehand lasso shapes around any area at source-pixel precision. Multiple areas, undo, and clear are supported.
- **Edit whole image** — skip the mask and edit the full image.
- **Cancel** — abort without calling the image API.

After a region is saved, Pi asks whether to use the suggested prompt or write a custom one. Custom prompts start in a blank multi-line editor, so there is nothing to delete. Press Enter to confirm, Shift+Enter for a newline, or Escape to cancel.

```text
> Edit `/tmp/source.png` into a watercolor illustration while preserving the composition.
```

The selected region(s) are converted to a PNG mask automatically and saved under `.pi/generated-images/`. In non-TUI or headless mode, omitting `maskPath` edits the whole image. Pass `maskPath` only when a mask has already been prepared. For edits, the output aspect ratio defaults to the input image's nearest supported ratio unless `aspectRatio` is set explicitly.

The selected model must use the `openai-images` API type for image editing. OpenRouter chat-image and Google models continue to support text-to-image generation through their existing APIs.

### Browser mask selector

The interactive edit flow can launch a local browser canvas for freehand lasso selection. It does not depend on Pi's terminal-cell resolution and supports multiple shapes, undo, and clear at source-pixel precision.

Drag to draw a loop around each area; release to close and fill it. Press Enter to save the mask or Escape to clear the current selection. After saving, Pi asks whether to use the suggested prompt or write a custom one. The selector attempts to close its browser tab automatically; if the browser blocks script-initiated tab closing, it shows a fallback message instead.

The helper binds only to `127.0.0.1`, writes the mask under `.pi/generated-images/`, and returns its path to Pi. Transparent pixels are the editable region; opaque pixels are preserved.

#### Browser selector service lifecycle

The local HTTP service starts only when the browser selector is actually launched. It is not started at Pi startup.

- **Start** — `generate_image` spawns `lib/mask-selector.mjs` after you choose the browser mask tool. The helper binds a random port on `127.0.0.1`, creates a per-run token, then opens the browser page.
- **Stop on save** — after the mask is written, the helper responds, closes the server and all connections, and exits. It then returns to Pi for the prompt choice.
- **Stop on cancel** — the Cancel button sends `/cancel`; closing the tab without saving sends a `pagehide` cancel beacon.
- **Stop on timeout or abort** — the interactive timeout defaults to 600 seconds; aborting the tool terminates the child process.

The service only serves the source image and accepts the mask for that single run. It is never a persistent daemon.

### Choosing a Model

Use `/image-model` — works in both Pi terminal and Minapi:

```
/image-model                                 # Interactive picker (fuzzy search)
/image-model openai/gpt-image-1              # Direct selection
/image-model openrouter/openai/gpt-5-image   # OpenRouter model
```

Selection persists in the session and shows in the status bar as `🎨 provider/model`.

## Built-in Providers & Models

Models are auto-generated from OpenRouter's API and static catalogs. Run `npm run generate-models` to refresh.

| Provider | Models | API Key | API Type |
|----------|--------|---------|----------|
| **openai** | `gpt-image-1`, `dall-e-3`, `dall-e-2` | `OPENAI_API_KEY` | `/v1/images/generations` and `/v1/images/edits` |
| **google** | `gemini-2.0-flash-preview-image-generation`, `imagen-3.0-generate-002` | `GEMINI_API_KEY` | Gemini `generateContent` |
| **openrouter** | `openai/gpt-5-image`, `openai/gpt-5-image-mini`, `google/gemini-2.5-flash-image`, `google/gemini-3-pro-image-preview`, FLUX.2 variants, Seedream, Riverflow, and more | `OPENROUTER_API_KEY` | Chat completions |

## Resolution Order

When generating an image, the model is resolved in this order:

1. **Session selection** — `/image-model` command
2. **Settings file** — `defaultProvider` / `defaultModel` in `pi-image-gen.json`
3. **Default** — first available OpenRouter model, then OpenAI

## Configuration

### Custom Models via Settings

Define image providers in `~/.pi/agent/settings/pi-image-gen.json` (global) or `<project>/.pi/settings/pi-image-gen.json` (project-local, overrides global):

```json
{
  "defaultProvider": "local-llm",
  "defaultModel": "my-local-image-model",
  "providers": {
    "local-llm": {
      "baseUrl": "http://192.168.1.51:9999/v1",
      "apiKey": "MY_API_KEY",
      "api": "openai-images",
      "responseFormat": "b64_json",
      "models": [
        {
          "id": "my-local-image-model",
          "name": "My Local Image Model",
          "cost": 0
        }
      ]
    }
  }
}
```

For providers whose signed image URLs require server-side authentication, set `responseFormat` to `b64_json`. The extension also accepts a server-owned `data:image/...;base64,...` URL and saves it directly without making a second request to the provider.


| Type | Used By | Endpoint |
|------|---------|----------|
| `openai-images` | OpenAI direct | `POST /v1/images/generations` for text-to-image; `POST /v1/images/edits` when `imagePath` is supplied |
| `openai-chat-image` | OpenRouter | `POST /v1/chat/completions` with `modalities: ["image"]` |
| `google-generative-ai-image` | Google Gemini | `POST /models/{id}:generateContent` |

Model-level `api` overrides provider-level `api`.

### Legacy: `models.json`

`pi-image-gen` also reads `providers.<name>.models[]` entries in `~/.pi/agent/models.json` that are tagged with `output: ["image"]`. This is lower priority than the settings file.

## Save Modes

Images are always saved locally so every result includes a reusable file path and download link. The default location is the project directory.

| Mode | Location |
|------|----------|
| `project` | `<repo>/.pi/generated-images/` (default) |
| `global` | `~/.pi/agent/generated-images/` |
| `custom` | `saveDir` param or `saveDir` in config |
| `none` | Legacy value; falls back to `project` |

The TUI result shows the absolute local path and a clickable `Download image` link when the terminal supports OSC 8 hyperlinks. In terminals without hyperlink support, it shows the `file://` URL as text.

## Tool Parameters

The `generate_image` tool accepts:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | *required* | Description of the image to generate or edit. After a region is selected, this is offered as the suggested prompt; choose it or write a custom prompt |
| `imagePath` | string | — | Local input image path or `file://` URL; uses `/v1/images/edits` with an `openai-images` model. In interactive TUI, omit `maskPath` and the tool first asks whether to select an edit area |
| `maskPath` | string | — | Optional prepared mask path or `file://` URL for localized edits; requires `imagePath`. Omit to be asked whether to select interactively |
| `aspectRatio` | string | `1:1` for generation; input ratio for edits | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9` |
| `imageSize` | string | `1K` | `1K`, `2K`, `4K` (OpenRouter models only) |
| `quality` | string | `auto` | `auto`, `low`, `medium`, `high` (OpenAI direct only) |
| `save` | string | `project` | `project`, `global`, or `custom`; images are always saved locally |
| `saveDir` | string | — | Directory for `save=custom` |
| `timeout` | number | `600` | Generation timeout in seconds |

## Pi Integration

- **API keys** — Resolved via `ctx.modelRegistry.getApiKeyForProvider()` (env vars, auth.json, OAuth)
- **Base URLs** — From model data, settings providers, or Pi's registry
- **Custom providers** — Define in `~/.pi/agent/settings/pi-image-gen.json`
- **Image edits** — Use `imagePath` and optional `maskPath` with a provider configured as `openai-images`; omitting `maskPath` in the TUI first asks whether to select a region
- **Mask selection** — The browser selector can create a mask inside Pi's interactive edit flow

## Architecture

Mirrors Pi's text model pipeline:

| Layer | Pi (text) | pi-image-gen |
|-------|-----------|--------------|
| Build-time discovery | `generate-models.ts` → `models.generated.ts` | `generate-image-models.ts` → `image-models.generated.ts` |
| Runtime discovery | None | OpenRouter `/v1/models` on startup (24h cache) |
| Sources | models.dev, OpenRouter, AI Gateway | OpenRouter (`output_modalities: ["image"]`), static catalog |
| Custom models | `models.json` providers | `settings/pi-image-gen.json` (preferred) + legacy `models.json` |
| API key resolution | `ModelRegistry.getApiKeyForProvider()` | Same |
| Model selection | Ctrl+P / model selector | `/image-model` command |

### Model Priority (lowest → highest)

1. **Built-in generated** — `image-models.generated.ts` (baked into package)
2. **Runtime discovered** — OpenRouter API fetch, cached at `~/.pi/agent/cache/pi-image-gen-discovered.json` (24h TTL)
3. **Legacy `models.json`** — `providers.<name>.models[]` entries with `output: ["image"]`
4. **Settings providers** — `providers` in `pi-image-gen.json` settings file
5. **Session selection** — `/image-model` command or tool params

## Adding Providers

1. Add static models to `scripts/generate-image-models.ts`
2. Or add a new dynamic fetch function (like `fetchOpenRouterImageModels`)
3. Run `npm run generate-models`
4. Add generation logic in `extensions/image-gen.ts` if a new API type is needed

## License

[MIT](LICENSE)
