/**
 * Internal browser mask selector for pi-image-gen.
 *
 * Opens a local browser canvas for freehand lasso selection and writes an
 * OpenAI-compatible PNG mask. Transparent pixels are editable; the rest is
 * opaque. It is spawned by the extension as an internal helper.
 */

import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

function fail(message) {
  console.error(`pi-image-gen mask: ${message}`);
  process.exit(1);
}

function parseInteger(value, label) {
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} is too large.`);
  }
  return parsed;
}

function detectMimeType(buffer, filePath) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "image/jpeg";
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") {
    return "image/gif";
  }

  const ext = extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  throw new Error(`Unsupported image format for "${filePath}". Use PNG, JPEG, WebP, or GIF.`);
}

function detectImageDimensions(buffer, mimeType) {
  if (mimeType === "image/png") {
    if (buffer.length < 24) throw new Error("PNG is truncated.");
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (mimeType === "image/gif") {
    if (buffer.length < 10) throw new Error("GIF is truncated.");
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      while (offset < buffer.length && buffer[offset] !== 0xff) offset += 1;
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length) break;

      const marker = buffer[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = buffer.readUInt16BE(offset + 3);
        const width = buffer.readUInt16BE(offset + 5);
        if (width < 1 || height < 1) throw new Error("JPEG has invalid dimensions.");
        return { width, height };
      }
      offset += length;
    }
    throw new Error("Cannot read JPEG dimensions.");
  }

  if (mimeType === "image/webp") {
    const chunk = buffer.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X" && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return { width, height };
    }
    if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
    }
    if (chunk === "VP8 " && buffer.length >= 30) {
      const start = buffer.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
      if (start >= 0 && start + 7 <= buffer.length) {
        return {
          width: buffer.readUInt16LE(start + 3) & 0x3fff,
          height: buffer.readUInt16LE(start + 5) & 0x3fff,
        };
      }
    }
    throw new Error("Cannot read WebP dimensions.");
  }

  throw new Error(`Unsupported image MIME type: ${mimeType}`);
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function openInBrowser(url) {
  const platform = process.platform;
  const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function selectorHtml(token, sourceWidth, sourceHeight, imageName) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Draw mask area · ${htmlEscape(imageName)}</title>
<style>
  :root { color-scheme: dark; --bg:#111318; --panel:#1b1f27; --text:#e9edf4; --muted:#98a2b3; --accent:#4f8cff; --danger:#ff4d4d; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { padding:18px 24px 8px; }
  h1 { margin:0 0 4px; font-size:18px; font-weight:650; }
  p { margin:0; color:var(--muted); }
  #stage { padding:16px 24px; display:flex; justify-content:center; overflow:auto; }
  canvas { display:block; max-width:100%; cursor:crosshair; border-radius:8px; box-shadow:0 8px 40px #0008; touch-action:none; }
  footer { position:sticky; bottom:0; display:flex; flex-wrap:wrap; gap:12px; align-items:center; padding:14px 24px 22px; background:linear-gradient(transparent,var(--bg) 28%); }
  button { border:1px solid #ffffff22; background:var(--panel); color:var(--text); padding:9px 14px; border-radius:8px; font:inherit; cursor:pointer; }
  button.primary { background:var(--accent); border-color:transparent; color:white; font-weight:600; }
  button:disabled { opacity:.45; cursor:default; }
  #hud { flex:1; color:var(--muted); font-variant-numeric:tabular-nums; }
  #hud.ok { color:#5ee08a; }
  #hud.error { color:var(--danger); }
</style>
</head>
<body>
<header>
  <h1>Draw the area to edit</h1>
  <p>Drag to draw a freehand loop around each area. Release to close and fill it. Draw multiple shapes if needed.</p>
</header>
<div id="stage"><canvas id="canvas" aria-label="Image mask selection canvas"></canvas></div>
<footer>
  <span id="hud">No selection yet</span>
  <button id="undo" type="button">Undo</button>
  <button id="clear" type="button">Clear</button>
  <button id="cancel" type="button">Cancel</button>
  <button id="save" class="primary" type="button" disabled>Save mask</button>
</footer>
<script>
(() => {
  const token = ${JSON.stringify(token)};
  const sourceWidth = ${sourceWidth};
  const sourceHeight = ${sourceHeight};
  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const hud = document.getElementById("hud");
  const saveButton = document.getElementById("save");
  const undoButton = document.getElementById("undo");
  const clearButton = document.getElementById("clear");
  const cancelButton = document.getElementById("cancel");
  const image = new Image();
  const shapes = [];
  let current = null;
  let displayWidth = sourceWidth;
  let displayHeight = sourceHeight;
  let scale = 1;
  let saving = false;
  let finished = false;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const pixelPoint = (event) => {
    const bounds = canvas.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width * sourceWidth, 0, sourceWidth),
      y: clamp((event.clientY - bounds.top) / bounds.height * sourceHeight, 0, sourceHeight),
    };
  };
  const setHud = (text, kind = "") => {
    hud.textContent = text;
    hud.className = kind;
  };
  const traceShape = (target, shape, scaleX, scaleY, close = true) => {
    target.beginPath();
    for (let index = 0; index < shape.length; index++) {
      const point = shape[index];
      const x = point.x * scaleX;
      const y = point.y * scaleY;
      if (index === 0) target.moveTo(x, y);
      else target.lineTo(x, y);
    }
    if (close) target.closePath();
  };
  const draw = () => {
    ctx.clearRect(0, 0, displayWidth, displayHeight);
    if (image.complete) ctx.drawImage(image, 0, 0, displayWidth, displayHeight);

    const scaleX = displayWidth / sourceWidth;
    const scaleY = displayHeight / sourceHeight;
    const lineWidth = Math.max(1, devicePixelRatio || 1);
    for (const shape of shapes) {
      traceShape(ctx, shape, scaleX, scaleY);
      ctx.fillStyle = "rgba(255, 77, 77, 0.30)";
      ctx.fill();
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = "#ff4d4d";
      ctx.stroke();
    }
    if (current && current.length > 1) {
      traceShape(ctx, current, scaleX, scaleY, false);
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = "#ffd166";
      ctx.stroke();
    }
  };
  const fit = () => {
    const availWidth = Math.max(240, window.innerWidth - 48);
    const availHeight = Math.max(240, window.innerHeight - 190);
    scale = Math.min(availWidth / sourceWidth, availHeight / sourceHeight);
    displayWidth = Math.max(1, Math.round(sourceWidth * scale));
    displayHeight = Math.max(1, Math.round(sourceHeight * scale));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(displayWidth * dpr);
    canvas.height = Math.round(displayHeight * dpr);
    canvas.style.width = displayWidth + "px";
    canvas.style.height = displayHeight + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  };
  const update = () => {
    const count = shapes.length;
    saveButton.disabled = count === 0 || saving;
    undoButton.disabled = count === 0 || saving;
    clearButton.disabled = count === 0 || saving;
    cancelButton.disabled = saving;
    if (!saving) {
      setHud(count === 0 ? "No selection yet" : "Selected " + count + (count === 1 ? " area" : " areas"));
    }
  };
  const addPoint = (event) => {
    if (!current) return;
    const point = pixelPoint(event);
    const last = current[current.length - 1];
    if (Math.hypot(point.x - last.x, point.y - last.y) < 1.5) return;
    current.push(point);
  };
  const finishShape = (event) => {
    if (!current) return;
    if (event) addPoint(event);
    if (current.length >= 3) {
      shapes.push(current);
      current = null;
      update();
    } else {
      current = null;
      update();
      setHud("Shape too small; drag a larger loop.", "error");
    }
    draw();
  };
  const buildMask = () => {
    const mask = document.createElement("canvas");
    mask.width = sourceWidth;
    mask.height = sourceHeight;
    const maskCtx = mask.getContext("2d");
    maskCtx.fillStyle = "#fff";
    maskCtx.fillRect(0, 0, sourceWidth, sourceHeight);
    maskCtx.globalCompositeOperation = "destination-out";
    for (const shape of shapes) {
      traceShape(maskCtx, shape, 1, 1);
      maskCtx.fill();
    }
    maskCtx.globalCompositeOperation = "source-over";
    return new Promise((resolve, reject) => {
      mask.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Could not build mask."));
      }, "image/png");
    });
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || saving) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    current = [pixelPoint(event)];
    draw();
    setHud("Drawing… release to close the shape.");
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!current) return;
    event.preventDefault();
    addPoint(event);
    draw();
  });
  canvas.addEventListener("pointerup", finishShape);
  canvas.addEventListener("pointercancel", () => {
    current = null;
    update();
    draw();
  });

  undoButton.addEventListener("click", () => {
    if (saving || shapes.length === 0) return;
    shapes.pop();
    update();
    draw();
  });
  clearButton.addEventListener("click", () => {
    if (saving) return;
    shapes.length = 0;
    current = null;
    update();
    draw();
  });
  cancelButton.addEventListener("click", async () => {
    if (saving) return;
    finished = true;
    try { await fetch("/cancel?token=" + encodeURIComponent(token), { method: "POST" }); } catch (error) {}
    setHud("Canceled", "error");
    saveButton.disabled = true;
    undoButton.disabled = true;
    clearButton.disabled = true;
    cancelButton.disabled = true;
  });
  saveButton.addEventListener("click", async () => {
    if (shapes.length === 0 || saving) return;
    saving = true;
    update();
    setHud("Building mask…");
    try {
      const blob = await buildMask();
      setHud("Saving mask…");
      const response = await fetch("/mask?token=" + encodeURIComponent(token), {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: blob,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not save mask.");
      finished = true;
      setHud("Mask saved — closing…", "ok");
      window.setTimeout(() => {
        try { window.close(); } catch (error) {}
        window.setTimeout(() => {
          setHud("Mask saved: " + result.path + " — automatic closing was blocked; close this tab to return.", "ok");
        }, 500);
      }, 150);
    } catch (error) {
      saving = false;
      update();
      setHud(String(error && error.message ? error.message : error), "error");
    }
  });
  window.addEventListener("pagehide", () => {
    if (finished) return;
    const url = "/cancel?token=" + encodeURIComponent(token);
    if (navigator.sendBeacon) navigator.sendBeacon(url);
    else fetch(url, { method: "POST", keepalive: true }).catch(() => {});
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && shapes.length > 0 && !saving) saveButton.click();
    if (event.key === "Escape") {
      if (current) {
        current = null;
        update();
        draw();
      } else {
        shapes.length = 0;
        update();
        draw();
      }
    }
  });
  window.addEventListener("resize", fit);

  image.addEventListener("load", () => { fit(); update(); });
  image.addEventListener("error", () => setHud("Could not load the source image.", "error"));
  image.src = "/image?token=" + encodeURIComponent(token);
})();
</script>
</body>
</html>`;
}

async function runInteractive({ imageBuffer, mimeType, imagePath, outputPath, port, timeoutSeconds, shouldOpen }) {
  const dimensions = detectImageDimensions(imageBuffer, mimeType);
  const token = randomBytes(24).toString("hex");
  const imageName = basename(imagePath);
  let settled = false;
  let server;
  let timer;

  return new Promise((resolvePromise, rejectPromise) => {
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      if (result.error) rejectPromise(result.error);
      else resolvePromise(result.path);
    };

    const send = (response, status, contentType, body) => {
      response.writeHead(status, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; connect-src 'self'; img-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      });
      response.end(body);
    };

    server = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
        if (!safeEqual(requestUrl.searchParams.get("token") || "", token)) {
          send(response, 403, "text/plain; charset=utf-8", "Forbidden");
          return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/") {
          send(
            response,
            200,
            "text/html; charset=utf-8",
            selectorHtml(token, dimensions.width, dimensions.height, imageName),
          );
          return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/image") {
          send(response, 200, mimeType, imageBuffer);
          return;
        }

        if (request.method === "POST" && requestUrl.pathname === "/mask") {
          const chunks = [];
          let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              send(response, 413, "application/json", JSON.stringify({ error: "Mask image is too large." }));
              return;
            }
            chunks.push(chunk);
          }

          const body = Buffer.concat(chunks);
          const contentType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
          let mask;
          try {
            if (contentType !== "image/png" && contentType !== "application/octet-stream") {
              throw new Error("Mask must be sent as PNG.");
            }
            if (detectMimeType(body, "mask.png") !== "image/png") {
              throw new Error("Mask must be a PNG image.");
            }
            const maskDimensions = detectImageDimensions(body, "image/png");
            if (maskDimensions.width !== dimensions.width || maskDimensions.height !== dimensions.height) {
              throw new Error(`Mask dimensions must match the source (${dimensions.width}x${dimensions.height}).`);
            }
            if (body.length < 26 || body[24] !== 8 || body[25] !== 6) {
              throw new Error("Mask must be an 8-bit RGBA PNG.");
            }
            mask = body;
          } catch (error) {
            send(response, 400, "application/json", JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }));
            return;
          }

          await mkdir(dirname(outputPath), { recursive: true });
          await writeFile(outputPath, mask);
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ path: outputPath }), () => finish({ path: outputPath }));
          return;
        }

        if (request.method === "POST" && requestUrl.pathname === "/cancel") {
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify({ canceled: true }), () => finish({ error: new Error("Selection canceled.") }));
          return;
        }

        send(response, 404, "text/plain; charset=utf-8", "Not found");
      } catch (error) {
        send(response, 500, "application/json", JSON.stringify({ error: String(error?.message || error) }));
      }
    });

    server.on("error", (error) => finish({ error }));
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const url = `http://127.0.0.1:${address.port}/?token=${token}`;
      console.error(`Source: ${imagePath}`);
      console.error(`Mask output: ${outputPath}`);
      console.error(`Selector: ${url}`);
      if (shouldOpen) openInBrowser(url);
      else console.error("Open the selector URL above in a browser.");

      timer = setTimeout(() => {
        finish({ error: new Error(`Selection timed out after ${timeoutSeconds} seconds.`) });
      }, timeoutSeconds * 1000);
    });
  });
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        output: { type: "string", short: "o" },
        "no-open": { type: "boolean" },
        port: { type: "string" },
        timeout: { type: "string" },
      },
    });
  } catch (error) {
    fail(error.message);
  }

  const { values, positionals } = parsed;
  const imageArg = positionals[0];
  if (!imageArg) {
    fail("missing source image path.");
  }

  const imagePath = isAbsolute(imageArg) ? imageArg : resolve(process.cwd(), imageArg);
  let imageBuffer;
  try {
    imageBuffer = await readFile(imagePath);
  } catch (error) {
    fail(`cannot read "${imagePath}": ${error.message}`);
  }
  if (imageBuffer.length === 0) fail(`"${imagePath}" is empty.`);

  const mimeType = detectMimeType(imageBuffer, imagePath);
  let dimensions;
  try {
    dimensions = detectImageDimensions(imageBuffer, mimeType);
  } catch (error) {
    fail(error.message);
  }
  if (dimensions.width < 1 || dimensions.height < 1) {
    fail(`"${imagePath}" has invalid dimensions.`);
  }

  const defaultOutput = join(dirname(imagePath), `${basename(imagePath, extname(imagePath))}.mask.png`);
  let outputPath = values.output ? resolve(process.cwd(), values.output) : defaultOutput;
  if (!outputPath.toLowerCase().endsWith(".png")) outputPath += ".png";
  if (outputPath === imagePath) fail("Output path must differ from the source image.");

  let port = 0;
  if (values.port !== undefined) {
    port = parseInteger(values.port, "--port");
    if (port < 0 || port > 65535) fail("--port must be between 0 and 65535.");
  }

  let timeoutSeconds = 600;
  if (values.timeout !== undefined) {
    timeoutSeconds = parseInteger(values.timeout, "--timeout");
    if (timeoutSeconds < 1) fail("--timeout must be at least 1 second.");
  }

  try {
    const maskPath = await runInteractive({
      imageBuffer,
      mimeType,
      imagePath,
      outputPath,
      port,
      timeoutSeconds,
      shouldOpen: !values["no-open"],
    });
    console.log(maskPath);
  } catch (error) {
    fail(error.message);
  }
}

await main();
