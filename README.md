# pi-image-gen

![pi-image-gen model selector](screenshot.png)

```bash
pi install @meatroll/pi-image-gen
```

Image generation extension for [pi](https://github.com/badlogic/pi-mono). Adds a `generate_image` tool, an interactive browser edit-region selector, and `/image-model`. Import an image model from the providers in Pi's own `models.json` into the plugin's config, or use a built-in model. Supports the OpenAI Images API (`/images/generations` and `/images/edits`) plus Google's native image APIs (`generateContent` for Gemini image models, `predict` for Imagen), so any OpenAI-compatible relay works.

## Features

- 🎨 **Built-in models** — OpenAI (GPT Image, DALL-E) and Google Gemini
- 🗂️ **Import from Pi's `models.json`** — `/image-model` lists your configured providers' models in a `/model`-style picker
- 🧭 **Import wizard** — choose the image API, response format, editing support and defaults; the model is written to `pi-image-gen.json[c]` as a standard provider entry
- 🔌 **Any OpenAI-compatible relay** — point `baseUrl` at it and use the `openai-images` API type
- ⚙️ **Custom providers** — Point at any compatible API via settings files
- 🖼️ **Aspect ratios & resolution** — `aspectRatio` maps to `size` (OpenAI), `imageConfig` (Gemini), or `parameters.aspectRatio` (Imagen); `imageSize` maps to Gemini's 1K/2K/4K tiers
- 💾 **Flexible save modes** — Project-local, global, or custom directory
- 🎯 **`/image-model` command** — Pi-model picker, per-model options, and session persistence
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

The selected model must use the `openai-images` API type for image editing. Google models support text-to-image generation through Gemini's native API.

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

`/image-model` opens a picker styled like Pi's `/model` selector. It lists:

- every model from the providers in your Pi `~/.pi/agent/models.json`,
- the models already declared in the plugin's `providers`, and
- the built-in catalog when no plugin providers are declared.

Pi has no field for image-generation models, so any model in `models.json` can be imported. After selecting one, the extension asks how to call it:

1. **Image API** — `openai-images` (`/images/generations`, `/images/edits`) or `google-generative-ai-image` (Gemini `generateContent` / Imagen `predict`)
2. **Response format** — `url` or `b64_json` (OpenAI-compatible APIs only)
3. **Image editing** — whether the model supports `/images/edits`
4. **Default aspect ratio** — used when `generate_image` omits `aspectRatio`; edits still use the input image unless you set one
5. **Default image size** — 1K/2K/4K (Gemini/Imagen only)

The wizard then writes a normal `providers.<provider>.models[]` entry into the global `pi-image-gen.json[c]`, copying `baseUrl`, `apiKey` and `headers` from Pi. From that point the model is managed independently: later changes in Pi's `models.json` are not synced.

Selecting a model that is already in the plugin config offers **Keep the current configuration** or **Reconfigure and re-import**.

> [!NOTE]
> Importing rewrites the global settings file, so JSONC comments and formatting are lost. `.jsonc` and `.json` both work; `.json` is read first when both exist.

```
/image-model                                 # picker (fuzzy search)
/image-model meatroll/gemini-4-argon         # direct import
```

Selection persists in the session and shows in the status bar as `🎨 provider/model`.

### Imported model entries

An imported model is a standard settings entry, so it can be edited by hand afterwards:

```json
{
  "providers": {
    "meatroll": {
      "baseUrl": "https://api.meatroll.shop/v1",
      "apiKey": "sk-…",
      "headers": { "User-Agent": "Mozilla/5.0 …" },
      "api": "openai-images",
      "models": [
        {
          "id": "gemini-4-argon",
          "name": "Gemini 4 Argon",
          "api": "openai-images",
          "responseFormat": "url",
          "supportsEdit": true,
          "defaultAspectRatio": "1:1"
        }
      ]
    }
  }
}
```

Running `/image-model` again on the same model with **Reconfigure and re-import** refreshes the copied credentials and options. Because the import writes a `providers` entry, the built-in catalog is replaced by the declared providers; list every provider you want to keep, or remove the `providers` block to return to the built-ins.

## Built-in Providers & Models

The built-in models come from the static catalog in `scripts/generate-image-models.ts`; run `npm run generate-models` to refresh it. Imported models are written to the plugin config and do not depend on this catalog.

| Provider | Models | API Key | API Type |
|----------|--------|---------|----------|
| **openai** | `gpt-image-1`, `dall-e-3`, `dall-e-2` | `OPENAI_API_KEY` | `/v1/images/generations` and `/v1/images/edits` |
| **google** | `gemini-2.0-flash-preview-image-generation`, `imagen-3.0-generate-002` | `GEMINI_API_KEY` | `:generateContent` (Gemini image models) and `:predict` (Imagen) |

## Resolution Order

When generating an image, the model is resolved in this order:

1. **Session selection** — `/image-model` command (imported models included)
2. **Settings file** — `defaultProvider` / `defaultModel` in `pi-image-gen.json` or `pi-image-gen.state.json`
3. **Default** — the first OpenAI model, then anything available

## Configuration

### Full reference

[`settings.example.jsonc`](settings.example.jsonc) contains every supported field with inline comments — save modes, timeouts, proxy, and four provider shapes (OpenAI-compatible relay, OpenAI direct, Gemini/Imagen, local server). A copy lives at `~/.pi/agent/settings/pi-image-gen.example.jsonc` for reference while editing.

The loader accepts JSONC: `//` line comments, `/* */` block comments and trailing commas are stripped before parsing, so the example can be pasted straight into your config. Both `pi-image-gen.json` and `pi-image-gen.jsonc` are read (`.json` first), globally and per project.

Picks made through `/image-model` store the last selection in `pi-image-gen.state.json`. Importing a model also writes it into the global `pi-image-gen.json[c]`, which rewrites that file and drops JSONC comments.

Two rules that surprise people:

- Declaring any `providers` entry replaces the built-in model catalog. Importing adds one, so import every model you need or keep your own `providers` list complete.
- `saveDir` is used verbatim — `~` is not expanded. Use an absolute path.

### Custom Models via Settings

Define image providers in `~/.pi/agent/settings/pi-image-gen.json[c]` (global) or `<project>/.pi/settings/pi-image-gen.json[c]` (project-local, overrides global):

```json
{
  "defaultProvider": "local-llm",
  "defaultModel": "my-local-image-model",
  "providers": {
    "local-llm": {
      "baseUrl": "http://192.168.1.51:9999/v1",
      "apiKey": "MY_API_KEY",
      "headers": { "User-Agent": "My Relay Client" },
      "api": "openai-images",
      "responseFormat": "b64_json",
      "models": [
        {
          "id": "my-local-image-model",
          "name": "My Local Image Model",
          "cost": 0,
          "responseFormat": "url",
          "supportsEdit": true,
          "defaultAspectRatio": "16:9",
          "defaultImageSize": "1K"
        }
      ]
    }
  }
}
```

Model entries accept `responseFormat`, `supportsEdit`, `defaultAspectRatio` and `defaultImageSize` — the fields the import wizard writes. `api` can be set per model to override the provider.

For providers whose signed image URLs require server-side authentication, set `responseFormat` to `b64_json`. The extension also accepts a server-owned `data:image/...;base64,...` URL and saves it directly without making a second request to the provider.


| Type | Used By | Endpoint |
|------|---------|----------|
| `openai-images` | OpenAI direct and any OpenAI-compatible relay | `POST /v1/images/generations` for text-to-image; `POST /v1/images/edits` when `imagePath` is supplied |
| `google-generative-ai-image` | Google Gemini / Imagen | `POST /models/{id}:generateContent` for Gemini image models; `POST /models/{id}:predict` for `imagen-*` models |

Model-level `api` overrides provider-level `api`.

### Legacy: tagged `models.json` entries

`pi-image-gen` still reads `providers.<name>.models[]` entries in `~/.pi/agent/models.json` that are tagged with `output: ["image"]` and model overrides tagged the same way. This is lower priority than the settings file and is only used when no plugin `providers` are declared. Pi ignores the tag, so prefer `/image-model`, which imports the model into the plugin config.

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
| `aspectRatio` | string | configured default, else `1:1` for generation; input ratio for edits | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9` |
| `imageSize` | string | configured default, else `1K` | `1K`, `2K`, `4K` — sent as Gemini `imageConfig.imageSize`; the OpenAI Images API has no equivalent and ignores it |
| `quality` | string | `auto` | `auto`, `low`, `medium`, `high` (OpenAI direct only) |
| `save` | string | `project` | `project`, `global`, or `custom`; images are always saved locally |
| `saveDir` | string | — | Directory for `save=custom` |
| `timeout` | number | `600` | Generation timeout in seconds |

## Pi Integration

- **API keys & headers** — Values declared in the plugin `providers` win (imported models copy them from Pi); Pi's registry fills the rest via `ctx.modelRegistry.getApiKeyAndHeaders()` (env vars, auth.json, OAuth, `models.json`)
- **Base URLs** — From the plugin `providers`, then Pi's `models.json` (provider or model level), then Pi's registry
- **Model list** — Pi `models.json` providers (for import) plus the plugin config catalog
- **Custom providers** — Define in `~/.pi/agent/settings/pi-image-gen.json` or import a `models.json` model with `/image-model`
- **Image edits** — Use `imagePath` and optional `maskPath` with an `openai-images` model that has editing enabled; omitting `maskPath` in the TUI first asks whether to select a region
- **Mask selection** — The browser selector can create a mask inside Pi's interactive edit flow

## Architecture

Mirrors Pi's text model pipeline:

| Layer | Pi (text) | pi-image-gen |
|-------|-----------|--------------|
| Build-time discovery | `generate-models.ts` → `models.generated.ts` | `generate-image-models.ts` → `image-models.generated.ts` |
| Sources | models.dev, OpenRouter, AI Gateway | Static catalog + models imported from Pi `models.json` |
| Custom models | `models.json` providers | Imported Pi models and hand-written entries in `settings/pi-image-gen.json` + legacy tags |
| API key & header resolution | `ModelRegistry.getApiKeyAndHeaders()` | Plugin `providers` first, then `ModelRegistry.getApiKeyAndHeaders()` |
| Model selection | Ctrl+P / model selector | `/image-model` (same picker layout) |

### Model Priority (lowest → highest)

1. **Built-in generated** — `image-models.generated.ts` (baked into package)
2. **Legacy `models.json` tags** — `providers.<name>.models[]` entries with `output: ["image"]`
3. **Settings providers** — `providers` in `pi-image-gen.json`, including models imported by `/image-model`
4. **Session selection** — `/image-model` command or tool params

## Adding Providers

1. Import a model from `~/.pi/agent/models.json` with `/image-model`, or add a `providers` entry to `~/.pi/agent/settings/pi-image-gen.json`,
2. or add static models to `scripts/generate-image-models.ts` and run `npm run generate-models`
3. Add generation logic in `extensions/image-gen.ts` if a new API type is needed

## License

[MIT](LICENSE)
