import { createHash } from "node:crypto";
import WebSocket from "ws";

// Independent native MCP read-only Chrome CDP capture. Never activate, focus,
// resize, reload, scroll, type into, or navigate an existing page.
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const MAX_DISCOVERY_BYTES = 1024 * 1024;
const SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

export function allowedCdpPorts(envValue = process.env.PC_CONTROL_BROWSER_CDP_ALLOWED_PORTS) {
  const value = String(envValue || "17410,17447");
  const ports = value.split(",").map(s => Number(s.trim()));
  if (!ports.length || ports.length > 16 || ports.some(p =>
    !Number.isInteger(p) || p < 1024 || p > 65535)) {
    throw new Error("CDP_ALLOWLIST_INVALID");
  }
  return new Set(ports);
}

function validPort(port, allowedPorts) {
  if (!Number.isInteger(port) || !allowedPorts.has(port)) {
    throw new Error("CDP_PORT_NOT_ALLOWED");
  }
  return port;
}

function safePageUrl(raw) {
  try {
    const u = new URL(raw);
    if ((u.protocol !== "http:" && u.protocol !== "https:") ||
        u.username || u.password) return null;
    return u.origin + u.pathname;
  } catch {
    return null;
  }
}

export function validateTargetEndpoint(raw, port, id) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("CDP_ENDPOINT_INVALID"); }
  if (u.protocol !== "ws:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
      Number(u.port) !== port || u.username || u.password || u.search || u.hash ||
      u.pathname !== "/devtools/page/" + id) {
    throw new Error("CDP_ENDPOINT_INVALID");
  }
  return "ws://127.0.0.1:" + port + u.pathname;
}

async function chromeTargets(port, { allowedPorts = allowedCdpPorts(), fetchImpl = fetch } = {}) {
  validPort(port, allowedPorts);
  const response = await fetchImpl("http://127.0.0.1:" + port + "/json/list", {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error("CDP_DISCOVERY_UNAVAILABLE");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_DISCOVERY_BYTES) throw new Error("CDP_DISCOVERY_TOO_LARGE");
  let targets;
  try { targets = JSON.parse(text); } catch { throw new Error("CDP_DISCOVERY_MALFORMED"); }
  if (!Array.isArray(targets) || targets.length > 500) {
    throw new Error("CDP_DISCOVERY_MALFORMED");
  }
  return targets.filter(t => t && t.type === "page" &&
    typeof t.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(t.id) &&
    typeof t.webSocketDebuggerUrl === "string" && safePageUrl(t.url));
}

export async function listChromeTabs(port, options = {}) {
  const targets = await chromeTargets(port, options);
  return targets.map(t => ({
    target_id: t.id,
    title: String(t.title || "").slice(0, 180),
    url: safePageUrl(t.url),
    port,
  }));
}

export function validatePng(data) {
  if (typeof data !== "string" ||
      data.length > Math.ceil(MAX_PNG_BYTES * 4 / 3) + 8 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error("CDP_PNG_INVALID_BASE64");
  }
  const png = Buffer.from(data, "base64");
  if (png.length < 24 || png.length > MAX_PNG_BYTES ||
      !png.subarray(0, 8).equals(SIGNATURE) ||
      png.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("CDP_PNG_INVALID");
  }
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  if (!width || !height || width > 16384 || height > 16384) {
    throw new Error("CDP_PNG_INVALID_DIMENSIONS");
  }
  return { png, width, height };
}

async function screenshotMessage(url, Socket = WebSocket) {
  const socket = new Socket(url);
  let done = false;
  const command = { id: 1, method: "Page.captureScreenshot",
    params: { format: "png", fromSurface: true, captureBeyondViewport: false } };
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("CDP_SCREENSHOT_TIMEOUT")), 9000);
    const finish = (error = null, result = null) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      try { socket.close(); } catch {}
      if (error) reject(error); else resolve(result);
    };
    socket.on("open", () => {
      try { socket.send(JSON.stringify(command)); }
      catch { finish(new Error("CDP_SEND_FAILED")); }
    });
    socket.on("message", data => {
      let event;
      try { event = JSON.parse(String(data)); } catch { return; }
      if (event.id !== 1) return;
      if (event.error) finish(new Error("CDP_SCREENSHOT_FAILED"));
      else finish(null, event.result);
    });
    socket.on("error", () => finish(new Error("CDP_WEBSOCKET_FAILED")));
    socket.on("close", () => finish(new Error("CDP_WEBSOCKET_CLOSED")));
  });
}

export async function captureChromeTab({
  port, target_id, expected_url = null,
  allowedPorts = allowedCdpPorts(), fetchImpl = fetch,
  sendImpl = screenshotMessage,
} = {}) {
  validPort(port, allowedPorts);
  if (typeof target_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(target_id)) {
    throw new Error("CDP_TARGET_ID_REQUIRED");
  }
  const targets = await chromeTargets(port, { allowedPorts, fetchImpl });
  const matched = targets.filter(t => t.id === target_id);
  if (matched.length !== 1) throw new Error("CDP_TARGET_MISSING_OR_AMBIGUOUS");
  const target = matched[0];
  const sanitizedUrl = safePageUrl(target.url);
  if (expected_url !== null && expected_url !== sanitizedUrl) {
    throw new Error("CDP_TARGET_CHANGED");
  }
  const wsUrl = validateTargetEndpoint(target.webSocketDebuggerUrl, port, target_id);
  const data = (await sendImpl(wsUrl))?.data;
  const { png, width, height } = validatePng(data);
  return {
    target_id, port, url: sanitizedUrl, width, height,
    sha256: createHash("sha256").update(png).digest("hex"),
    byte_length: png.length,
    base64: png.toString("base64"),
  };
}

export function mcpScreenshotResult(screenshot) {
  const { base64, ...metadata } = screenshot;
  return {
    content: [
      { type: "image", data: base64, mimeType: "image/png" },
      { type: "text", text: JSON.stringify({
        ok: true, ...metadata, focus_changed_by_tool: false,
        source: "chrome_cdp_read_only",
      }) },
    ],
    isError: false,
  };
}
