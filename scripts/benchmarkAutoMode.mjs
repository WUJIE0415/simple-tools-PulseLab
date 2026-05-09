import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_BROWSER_PATHS = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
];

const appUrl = process.env.BPM_BENCHMARK_URL ?? "http://127.0.0.1:5173";
const audioDir = path.resolve(process.env.BPM_BENCHMARK_AUDIO_DIR ?? "1/audio");
const browserPath = process.env.BPM_BENCHMARK_BROWSER ?? DEFAULT_BROWSER_PATHS.find((candidate) => existsSync(candidate));
const cdpPort = Number(process.env.BPM_BENCHMARK_CDP_PORT ?? 9223);

if (!browserPath) {
  throw new Error("No Edge or Chrome executable found. Set BPM_BENCHMARK_BROWSER to a browser path.");
}

const audioFiles = readdirSync(audioDir)
  .filter((name) => /\.(mp3|wav|flac|m4a|aac|ogg)$/i.test(name))
  .sort((a, b) => a.localeCompare(b, "en"))
  .map((name) => path.resolve(audioDir, name));

if (audioFiles.length === 0) {
  throw new Error(`No audio files found in ${audioDir}`);
}

async function waitForEndpoint(url, attempts = 50) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastError ?? new Error(`Endpoint not ready: ${url}`);
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;

    const callbacks = pending.get(message.id);
    if (!callbacks) return;

    pending.delete(message.id);
    if (message.error) {
      callbacks.reject(new Error(`${message.error.message}: ${message.error.data ?? ""}`));
    } else {
      callbacks.resolve(message.result);
    }
  });

  return {
    opened,
    close: () => socket.close(),
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    }
  };
}

async function main() {
  await waitForEndpoint(appUrl);

  const userDataDir = mkdtempSync(path.join(tmpdir(), "bpm-auto-benchmark-"));
  const browser = spawn(
    browserPath,
    [
      "--headless=new",
      "--disable-gpu",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "--autoplay-policy=no-user-gesture-required",
      appUrl
    ],
    { stdio: "ignore", windowsHide: true }
  );

  try {
    const pagesResponse = await waitForEndpoint(`http://127.0.0.1:${cdpPort}/json/list`);
    const pages = await pagesResponse.json();
    const page = pages.find((entry) => entry.type === "page") ?? pages[0];
    if (!page?.webSocketDebuggerUrl) throw new Error("No debuggable browser page found.");

    const cdp = createCdpClient(page.webSocketDebuggerUrl);
    await cdp.opened;
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");

    async function evaluate(expression, awaitPromise = false) {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true
      });

      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text ?? "Runtime evaluation failed");
      }

      return result.result?.value;
    }

    async function waitForApp() {
      for (let index = 0; index < 100; index += 1) {
        const ready = await evaluate(
          "Boolean(document.querySelector('.auto-mode-button') && document.querySelector('input[type=\"file\"]'))"
        );
        if (ready) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("App controls did not appear.");
    }

    async function navigateFresh() {
      await cdp.send("Page.navigate", { url: `${appUrl}?benchmark=${Date.now()}` });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await waitForApp();
    }

    async function setFileInput(filePath) {
      const doc = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
      const query = await cdp.send("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector: "input[type=\"file\"]"
      });

      if (!query.nodeId) throw new Error("File input not found.");
      await cdp.send("DOM.setFileInputFiles", { nodeId: query.nodeId, files: [filePath] });
    }

    async function readStatus() {
      return evaluate(`(() => ({
        status: document.querySelector('.status span')?.textContent?.trim() ?? '',
        bpm: document.querySelector('.bpm-value')?.textContent?.trim() ?? '',
        file: document.querySelector('.drop-title')?.textContent?.trim() ?? '',
        meta: document.querySelector('.drop-meta')?.textContent?.trim() ?? '',
        error: document.querySelector('.terminal')?.textContent?.trim() ?? ''
      }))()`);
    }

    await waitForApp();
    await evaluate("localStorage.setItem('bpm-web-analysis-mode', 'judge')");
    await navigateFresh();

    const results = [];
    for (const filePath of audioFiles) {
      await evaluate("document.querySelector('.auto-mode-button')?.click()");
      const start = performance.now();
      await setFileInput(filePath);

      let state = await readStatus();
      for (let index = 0; index < 900; index += 1) {
        state = await readStatus();
        if (state.status === "Complete" || state.status === "Error") break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      const expectedMatch = path.basename(filePath).match(/(\d+(?:\.\d+)?)\s*bpm/i);
      const bpm = Number.parseFloat(state.bpm);

      results.push({
        file: path.basename(filePath),
        expectedBpm: expectedMatch ? Number(expectedMatch[1]) : null,
        status: state.status,
        bpm: Number.isFinite(bpm) ? bpm : null,
        deltaBpm: expectedMatch && Number.isFinite(bpm) ? Math.round((bpm - Number(expectedMatch[1])) * 10) / 10 : null,
        elapsedMs: Math.round(performance.now() - start),
        meta: state.meta,
        error: state.error
      });

      await navigateFresh();
    }

    cdp.close();
    console.log(JSON.stringify(results, null, 2));
  } finally {
    browser.kill();
    await new Promise((resolve) => browser.once("exit", resolve));
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

await main();
