import assert from "node:assert/strict";
import {
  generateViaOpenAIImages,
  generateViaOpenRouterImages,
  generateViaChatImage,
  collectChatImageCandidates,
} from "../.runtime/test-module.mjs";

// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const B64 = PNG.toString("base64");

let handler;
let calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  return handler(String(url), init);
};

const cfg = { apiKey: "k", baseUrl: "https://relay.test/v1" };
const model = (api, id = "some/model") => ({ id, name: id, provider: "meatroll", baseUrl: cfg.baseUrl, api, cost: 0 });
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── OpenRouter Image API ────────────────────────────────────────────
test("openrouter-images: POST /images with standard params, parses b64_json + media_type", async () => {
  calls = [];
  handler = (url, init) => {
    assert.equal(url, "https://relay.test/v1/images");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer k");
    const body = JSON.parse(init.body);
    assert.deepEqual(body, {
      model: "some/model",
      prompt: "a cat",
      n: 1,
      aspect_ratio: "16:9",
      resolution: "2K",
      quality: "high",
    });
    return json({ created: 1, data: [{ b64_json: B64, media_type: "image/png" }, ], usage: {} });
  };
  const img = await generateViaOpenRouterImages(cfg, model("openrouter-images"), "a cat", "16:9", "2K", "high");
  assert.equal(img.data, B64);
  assert.equal(img.mimeType, "image/png");
});

test("openrouter-images: omits quality when auto, honors data URL in data[0].url", async () => {
  calls = [];
  handler = (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal("quality" in body, false);
    assert.equal(body.aspect_ratio, "1:1");
    return json({ created: 1, data: [{ url: `data:image/jpeg;base64,${B64}` }] });
  };
  const img = await generateViaOpenRouterImages(cfg, model("openrouter-images"), "a cat", "1:1", "1K", "auto");
  assert.equal(img.mimeType, "image/jpeg");
  assert.equal(img.data, B64);
});

test("openrouter-images: downloads data[0].url and sniffs mime from bytes", async () => {
  handler = (url) => {
    if (url.endsWith("/images")) return json({ data: [{ url: "https://cdn.test/x" }] });
    assert.equal(url, "https://cdn.test/x");
    return new Response(PNG, { status: 200, headers: { "content-type": "application/octet-stream" } });
  };
  const img = await generateViaOpenRouterImages(cfg, model("openrouter-images"), "a cat", "1:1", "1K", "auto");
  assert.equal(img.mimeType, "image/png", "magic bytes take over when content-type is not an image");
  assert.equal(img.data, B64);
});

test("openrouter-images: surfaces upstream error object and HTTP errors", async () => {
  handler = () => json({ error: { message: "model does not support images" } });
  await assert.rejects(
    () => generateViaOpenRouterImages(cfg, model("openrouter-images"), "p", "1:1", "1K", "auto"),
    /model does not support images/,
  );
  handler = () => json({ error: { message: "nope" } }, 400);
  await assert.rejects(
    () => generateViaOpenRouterImages(cfg, model("openrouter-images"), "p", "1:1", "1K", "auto"),
    /OpenRouter image generation failed \(400\)/,
  );
  handler = () => json({ data: [] });
  await assert.rejects(
    () => generateViaOpenRouterImages(cfg, model("openrouter-images"), "p", "1:1", "1K", "auto"),
    /returned no image data/,
  );
});

// ── OpenAI Images API ───────────────────────────────────────────────
test("openai-images: gpt-image models omit response_format and keep quality", async () => {
  calls = [];
  handler = (url, init) => {
    assert.equal(url, "https://relay.test/v1/images/generations");
    const body = JSON.parse(init.body);
    assert.deepEqual(body, { model: "gpt-image-1", prompt: "p", n: 1, size: "1536x1024", quality: "high" });
    return json({ created: 1, data: [{ b64_json: B64, media_type: "image/webp" }] });
  };
  const img = await generateViaOpenAIImages(
    { ...cfg, responseFormat: "b64_json" },
    model("openai-images", "gpt-image-1"),
    "p",
    "16:9",
    "high",
  );
  assert.equal(img.mimeType, "image/webp");
  assert.equal(img.data, B64);
});

test("openai-images: relay payload stays inside a strict OpenAI-compatible whitelist", async () => {
  calls = [];
  handler = (url, init) => {
    const body = JSON.parse(init.body);
    // gemini-web2api rejects unknown fields, so this set must stay minimal
    assert.deepEqual(body, {
      model: "gemini-4-argon",
      prompt: "p",
      n: 1,
      size: "1024x1024",
      response_format: "b64_json",
    });
    return json({ created: 1, data: [{ b64_json: B64, media_type: "image/jpeg" }] });
  };
  const img = await generateViaOpenAIImages(
    { ...cfg, responseFormat: "b64_json" },
    model("openai-images", "gemini-4-argon"),
    "p",
    "1:1",
    "high",
  );
  assert.equal(img.mimeType, "image/jpeg");
});

test("openai-images: sniffs jpeg when media_type is absent", async () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("rest")]);
  handler = () => json({ data: [{ b64_json: jpeg.toString("base64") }] });
  const img = await generateViaOpenAIImages(cfg, model("openai-images"), "p", "1:1", "auto");
  assert.equal(img.mimeType, "image/jpeg");
});

test("openai-images: accepts a server-owned data URL in data[0].url", async () => {
  handler = () => json({ data: [{ url: `data:image/jpeg;base64,${B64}` }] });
  const img = await generateViaOpenAIImages(cfg, model("openai-images"), "p", "1:1", "auto");
  assert.equal(img.mimeType, "image/jpeg");
  assert.equal(img.data, B64);
});

// ── Legacy chat-completions ─────────────────────────────────────────
test("chat-image: documented message.images[] shape", async () => {
  handler = (_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.modalities, ["image"]);
    assert.deepEqual(body.image_config, { aspect_ratio: "16:9", image_size: "2K" });
    return json({ choices: [{ message: { role: "assistant", content: "", images: [{ type: "image_url", image_url: { url: `data:image/png;base64,${B64}` } }] } }] });
  };
  const img = await generateViaChatImage(cfg, model("openai-chat-image"), "p", "16:9", "2K");
  assert.equal(img.mimeType, "image/png");
  assert.equal(img.data, B64);
});

test("chat-image: meatroll-style markdown data URL inside content", async () => {
  handler = () =>
    json({
      choices: [
        {
          message: {
            role: "assistant",
            content: `http://googleusercontent.com/image_generation_content/0_879\n\n![Generated image](data:image/jpeg;base64,${B64})`,
          },
        },
      ],
    });
  const img = await generateViaChatImage(cfg, model("openai-chat-image"), "p", "16:9", "1K");
  assert.equal(img.mimeType, "image/jpeg");
  assert.equal(img.data, B64);
});

test("chat-image: markdown http link without a file extension is still followed", async () => {
  handler = (url) => {
    if (url.endsWith("/chat/completions")) {
      return json({
        choices: [{ message: { content: "here you go\n\n![Generated image](https://lh3.googleusercontent.com/gg-dl/TOKEN=s0-d)" } }],
      });
    }
    assert.equal(url, "https://lh3.googleusercontent.com/gg-dl/TOKEN=s0-d");
    return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
  };
  const img = await generateViaChatImage(cfg, model("openai-chat-image"), "p", "1:1", "1K");
  assert.equal(img.data, B64);
});

test("chat-image: no-image error is honest and actionable", async () => {
  handler = () => json({ choices: [{ message: { content: "I cannot draw that." } }] });
  await assert.rejects(
    () => generateViaChatImage(cfg, model("openai-chat-image"), "p", "1:1", "1K"),
    (error) => {
      assert.doesNotMatch(error.message, /OpenRouter/, "must not claim the request went to OpenRouter");
      assert.match(error.message, /neither message\.images\[\] nor an image data URL/);
      assert.match(error.message, /openai-images/);
      return true;
    },
  );
});

test("chat-image: HTTP failure names the provider and model", async () => {
  handler = () => json({ error: { message: "upstream error: 400" } }, 400);
  await assert.rejects(
    () => generateViaChatImage(cfg, model("openai-chat-image", "gemini-4-argon"), "p", "1:1", "1K"),
    /chat-completions image generation failed \(400\) for meatroll\/gemini-4-argon/i,
  );
});

// ── Candidate collection ────────────────────────────────────────────
test("collectChatImageCandidates: dedupes and prefers message.images[]", () => {
  const urls = collectChatImageCandidates({
    images: [{ image_url: { url: "https://a.test/1.png" } }],
    content: "![x](https://a.test/1.png) and https://b.test/2",
  });
  assert.deepEqual(urls, ["https://a.test/1.png", "https://b.test/2"]);
});

// ── Run ─────────────────────────────────────────────────────────────
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ❌ ${name}\n     ${error.message.split("\n").join("\n     ")}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);
