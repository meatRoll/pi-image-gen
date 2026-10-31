function imageBlob(image) {
  const bytes = new Uint8Array(new ArrayBuffer(image.data.length));
  bytes.set(image.data);
  return new Blob([bytes.buffer], { type: image.mimeType });
}
const OPENAI_SIZES = {
  "1:1": "1024x1024",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  "4:3": "1536x1024",
  "3:4": "1024x1536",
  "3:2": "1536x1024",
  "2:3": "1024x1536"
};
function closestAspectRatio(inputImage) {
  const { widthPx, heightPx } = inputImageDimensions(inputImage);
  const target = widthPx / heightPx;
  let bestRatio = "1:1";
  let bestDistance = Infinity;
  for (const ratio of Object.keys(OPENAI_SIZES)) {
    const [width, height] = ratio.split(":").map(Number);
    if (!width || !height) continue;
    const distance = Math.abs(Math.log(width / height / target));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestRatio = ratio;
    }
  }
  return bestRatio;
}
function isGptImageModel(modelId) {
  return modelId.startsWith("gpt-image-") || modelId === "chatgpt-image-latest";
}
function sniffImageMime(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
  return void 0;
}
function parseDataUrl(value) {
  const trimmed = value.trim();
  const comma = trimmed.indexOf(",");
  if (comma < 0 || !trimmed.slice(0, comma).toLowerCase().startsWith("data:")) return void 0;
  const header = trimmed.slice(0, comma);
  const mimeType = header.slice("data:".length).split(";", 1)[0] || "image/png";
  if (!mimeType.startsWith("image/")) return void 0;
  const payload = trimmed.slice(comma + 1);
  if (header.toLowerCase().includes(";base64")) {
    return { data: payload.replace(/\s+/g, ""), mimeType };
  }
  return { data: Buffer.from(decodeURIComponent(payload), "binary").toString("base64"), mimeType };
}
async function downloadImageUrl(url, options = {}) {
  const inline = parseDataUrl(url);
  if (inline) return inline;
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Unsupported image reference: expected an http(s) URL or a base64 data URL.");
  }
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) throw new Error(`Image download failed (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  return {
    data: buffer.toString("base64"),
    mimeType: contentType.startsWith("image/") ? contentType : sniffImageMime(buffer) || "image/png"
  };
}
async function generateViaOpenAIImages(config, model, prompt, aspectRatio, quality, inputImage, maskImage, signal) {
  const size = OPENAI_SIZES[aspectRatio] || "1024x1024";
  const operation = inputImage ? "image edit" : "image generation";
  const endpoint = inputImage ? "edits" : "generations";
  const headers = {
    Authorization: `Bearer ${config.apiKey}`
  };
  let requestBody;
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
    const body = {
      model: model.id,
      prompt,
      n: 1,
      size
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
    signal
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI ${operation} failed (${response.status}): ${errorText}`);
  }
  const result = await response.json();
  const image = result.data?.[0];
  if (image?.b64_json) {
    const bytes = Buffer.from(image.b64_json, "base64");
    return {
      data: image.b64_json,
      mimeType: image.media_type?.split(";", 1)[0] || sniffImageMime(bytes) || "image/png"
    };
  }
  if (image?.url) {
    const dataUrl = parseDataUrl(image.url);
    if (dataUrl) return dataUrl;
    return downloadGeminiImageLocally(image.url, config.downloadProxy, signal);
  }
  throw new Error(`OpenAI ${operation} returned no image data`);
}
async function generateViaOpenRouterImages(config, model, prompt, aspectRatio, imageSize, quality, signal) {
  const body = { model: model.id, prompt, n: 1 };
  if (aspectRatio) body.aspect_ratio = aspectRatio;
  if (imageSize) body.resolution = imageSize;
  if (quality && quality !== "auto") body.quality = quality;
  const response = await fetch(`${config.baseUrl}/images`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter image generation failed (${response.status}): ${errorText}`);
  }
  const result = await response.json();
  if (result.error?.message) {
    throw new Error(`OpenRouter image generation failed: ${result.error.message}`);
  }
  const image = result.data?.[0];
  if (!image) {
    throw new Error("OpenRouter returned no image data (expected data[0].b64_json or data[0].url)");
  }
  if (image.b64_json) {
    const bytes = Buffer.from(image.b64_json, "base64");
    return {
      data: image.b64_json,
      mimeType: image.media_type?.split(";", 1)[0] || sniffImageMime(bytes) || "image/png"
    };
  }
  if (image.url) {
    return downloadImageUrl(image.url, { signal, downloadProxy: config.downloadProxy });
  }
  throw new Error("OpenRouter returned no image data (expected data[0].b64_json or data[0].url)");
}
function collectChatImageCandidates(message) {
  const urls = [];
  for (const image of message.images ?? []) {
    const url = image?.image_url?.url;
    if (typeof url === "string" && url) urls.push(url);
  }
  const content = typeof message.content === "string" ? message.content : "";
  if (content) {
    for (const match of content.matchAll(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g)) {
      urls.push(match[0].replace(/\s+/g, ""));
    }
    for (const match of content.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/g)) {
      urls.push(match[1]);
    }
    for (const match of content.matchAll(/https?:\/\/[^\s"'()<>\]]+/g)) {
      urls.push(match[0]);
    }
  }
  return [...new Set(urls)];
}
async function generateViaChatImage(config, model, prompt, aspectRatio, imageSize, signal) {
  const body = {
    model: model.id,
    messages: [{ role: "user", content: prompt }],
    modalities: ["image"]
  };
  const imageConfig = {};
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
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Chat-completions image generation failed (${response.status}) for ${model.provider}/${model.id}: ${errorText}`
    );
  }
  const result = await response.json();
  if (result.error?.message) {
    throw new Error(`Chat-completions image generation failed for ${model.provider}/${model.id}: ${result.error.message}`);
  }
  const message = result.choices?.[0]?.message;
  if (!message) {
    throw new Error(`No message in the ${model.provider}/${model.id} chat-completions response`);
  }
  const candidates = collectChatImageCandidates(message);
  if (candidates.length === 0) {
    throw new Error(
      `No image in the ${model.provider}/${model.id} chat-completions response: neither message.images[] nor an image data URL / link in message.content. Use api "openai-images" or "openrouter-images" if the provider exposes a standard image endpoint.`
    );
  }
  const failures = [];
  for (const url of candidates) {
    try {
      return await downloadImageUrl(url, { signal, downloadProxy: config.downloadProxy });
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    `Found ${candidates.length} image reference(s) in the ${model.provider}/${model.id} response but none could be read: ${failures.join("; ")}`
  );
}
async function generateViaGoogleImage(config, model, prompt, signal) {
  const response = await fetch(
    `${config.baseUrl}/models/${model.id}:generateContent?key=${config.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] }
      }),
      signal
    }
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google image generation failed (${response.status}): ${errorText}`);
  }
  const result = await response.json();
  const parts = result.candidates?.[0]?.content?.parts;
  if (!parts) throw new Error("Google returned no content");
  for (const part of parts) {
    if (part.inlineData?.data) {
      return { data: part.inlineData.data, mimeType: part.inlineData.mimeType || "image/png" };
    }
  }
  throw new Error("Google returned no image data");
}
async function generateImage(config, model, prompt, aspectRatio, imageSize, quality, inputImage, maskImage, signal) {
  if (inputImage && model.api !== "openai-images") {
    throw new Error(
      `Image editing currently requires a model configured with api: "openai-images"; "${model.api}" does not expose /images/edits.`
    );
  }
  switch (model.api) {
    case "openai-images":
      return generateViaOpenAIImages(config, model, prompt, aspectRatio, quality, inputImage, maskImage, signal);
    case "openrouter-images":
      return generateViaOpenRouterImages(config, model, prompt, aspectRatio, imageSize, quality, signal);
    case "openai-chat-image":
      return generateViaChatImage(config, model, prompt, aspectRatio, imageSize, signal);
    case "google-generative-ai-image":
      return generateViaGoogleImage(config, model, prompt, signal);
    default:
      throw new Error(`Unknown image API type: ${model.api}`);
  }
}
function resolveModel(sessionSelection, config) {
  const allModels = getAllModels(config);
  if (sessionSelection) {
    const found = allModels.find(
      (m) => m.provider === sessionSelection.provider && m.id === sessionSelection.model
    );
    if (found) return found;
  }
  if (config.defaultModel) {
    const found = allModels.find((m) => m.id === config.defaultModel);
    if (found) return found;
  }
  if (config.defaultProvider) {
    const providerModels = allModels.filter((m) => m.provider === config.defaultProvider);
    if (providerModels.length > 0) return providerModels[0];
  }
  const orModels = allModels.filter((m) => m.provider === "openrouter");
  if (orModels.length > 0) return orModels[0];
  const openaiModels = allModels.filter((m) => m.provider === "openai");
  if (openaiModels.length > 0) return openaiModels[0];
  if (allModels.length > 0) return allModels[0];
  throw new Error("No image models available. Run /image-model to select one.");
}
const SESSION_ENTRY_TYPE = "pi-image-gen:model-select";
async function downloadGeminiImageLocally(rawUrl) {
  throw new Error(`download stub hit for ${rawUrl}`);
}
export {
  collectChatImageCandidates,
  generateViaChatImage,
  generateViaOpenAIImages,
  generateViaOpenRouterImages
};
