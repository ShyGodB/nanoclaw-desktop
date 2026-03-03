#!/usr/bin/env node
/**
 * Patchright Browser Tool
 * Anti-detection browser automation using Patchright (undetected Playwright fork).
 *
 * Browser profile is persisted per-conversation via Chromium's --user-data-dir.
 * Chromium is spawned as a detached process and controlled via CDP, so it survives
 * Node process exits — login state and open pages persist across tool invocations.
 *
 * Usage:
 *   patchright-browser open <url>           Open URL in headed Chromium
 *   patchright-browser snapshot [-i]        Snapshot page elements (use -i for interactive only)
 *   patchright-browser screenshot [url]     Take screenshot (optionally navigate first)
 *   patchright-browser html [url]           Print page HTML
 *   patchright-browser text [url]           Print visible text
 *   patchright-browser click <@ref|sel>     Click element by ref or CSS selector
 *   patchright-browser fill <@ref|sel> <text>  Clear and type into element
 *   patchright-browser type <@ref|sel> <text>  Type into element (append)
 *   patchright-browser select <@ref|sel> <val> Select dropdown option
 *   patchright-browser hover <@ref|sel>     Hover over element
 *   patchright-browser press <key>          Press keyboard key (Enter, Escape, Tab, etc.)
 *   patchright-browser scroll <dir> [px]    Scroll page (up/down/left/right)
 *   patchright-browser back                 Navigate back
 *   patchright-browser forward              Navigate forward
 *   patchright-browser reload               Reload page
 *   patchright-browser wait <ms|@ref|--text ".."|--url "..">  Wait for condition
 *   patchright-browser eval <js>            Evaluate JavaScript on current page
 *   patchright-browser close                Close browser
 *   patchright-browser status               Show browser status
 */

import { chromium } from 'patchright';
import { spawn } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';
import http from 'http';

const WORKSPACE_BASE = process.env.WORKSPACE_BASE || '/tmp';
const PROFILE_DIR = path.join(WORKSPACE_BASE, 'group', '.browser-data');
const STATE_FILE = path.join(PROFILE_DIR, '.state.json');
const COOKIES_FILE = path.join(PROFILE_DIR, '.cookies.json');
const SCREENSHOT_DIR = path.join(WORKSPACE_BASE, 'group');
const PROXY_FILE = path.join(PROFILE_DIR, '.proxy');
let BROWSER_LANG = process.env.BROWSER_LANG || 'zh-CN';
let BROWSER_TIMEZONE = process.env.BROWSER_TIMEZONE || 'Asia/Shanghai';
let BROWSER_PROXY = process.env.BROWSER_PROXY || '';

const PROXY_RENEW_BUFFER_MS = 60 * 60 * 1000; // 1 hour buffer before deadline

/** Check if proxy is expired or will expire within buffer period */
function isProxyExpired(proxy) {
  if (!proxy.deadline) return false;
  return new Date(proxy.deadline).getTime() - Date.now() < PROXY_RENEW_BUFFER_MS;
}

/** Call Qingguo API to extract a new IP, update .proxy file */
async function renewProxy(proxy) {
  const authKey = process.env.QG_AUTH_KEY;
  const authPwd = process.env.QG_AUTH_PWD || '';
  if (!authKey) {
    console.error('[proxy] QG_AUTH_KEY not set, cannot renew expired proxy');
    return proxy;
  }

  const ispMap = { '电信': 1, '移动': 2, '联通': 3 };
  const ispCode = ispMap[proxy.ispInput] ?? ispMap[proxy.isp] ?? 0;
  const url = `https://longterm.proxy.qg.net/get?key=${authKey}&num=1&area=${proxy.areaCode || ''}&isp=${ispCode}&format=json&distinct=true`;

  console.error(`[proxy] IP expired (deadline: ${proxy.deadline}), extracting new IP...`);
  const res = await fetch(url);
  const json = await res.json();

  if (json.code !== 'SUCCESS' || !json.data?.length) {
    console.error(`[proxy] Renewal failed: ${json.code} ${json.message || ''}`);
    return proxy; // fall back to old config
  }

  const ip = json.data[0];
  // Auth via IP whitelist — Chromium --proxy-server doesn't support inline credentials
  const server = `socks5://${ip.server}`;

  const newProxy = {
    ...proxy,
    server,
    proxyIp: ip.proxy_ip,
    area: ip.area,
    isp: ip.isp,
    taskId: ip.task_id,
    assignedAt: new Date().toISOString(),
    deadline: ip.deadline,
  };

  fs.mkdirSync(path.dirname(PROXY_FILE), { recursive: true });
  fs.writeFileSync(PROXY_FILE, JSON.stringify(newProxy, null, 2));
  console.error(`[proxy] New IP: ${ip.proxy_ip} (${ip.area}/${ip.isp}) deadline: ${ip.deadline}`);
  return newProxy;
}

// Load per-workspace proxy config (overrides env defaults)
async function loadProxy() {
  try {
    if (!fs.existsSync(PROXY_FILE)) return;
    let proxy = JSON.parse(fs.readFileSync(PROXY_FILE, 'utf-8'));

    // Auto-renew if expired
    if (isProxyExpired(proxy)) {
      proxy = await renewProxy(proxy);
    }

    if (proxy.server) BROWSER_PROXY = proxy.server;
    if (proxy.lang) BROWSER_LANG = proxy.lang;
    if (proxy.timezone) BROWSER_TIMEZONE = proxy.timezone;
  } catch (e) {
    console.error(`[proxy] Error loading proxy config: ${e.message}`);
  }
}

// --- Fingerprint diversification ---
// Deterministic per-topic: same topic always gets same fingerprint, different topics differ.

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function generateFingerprint(workspacePath) {
  const seed = hashString(workspacePath);
  const rng = seededRandom(seed);
  return {
    windowWidth: 1280 + Math.floor(rng() * 61) - 30,   // 1250–1310
    windowHeight: 800 + Math.floor(rng() * 41) - 20,    // 780–820
    screenWidth: 1440 + Math.floor(rng() * 5) * 80,     // 1440/1520/1600/1680/1760
    screenHeight: 900 + Math.floor(rng() * 5) * 60,     // 900/960/1020/1080/1140
    uaPatch: 50 + Math.floor(rng() * 50),               // 50–99
    canvasSeed: Math.floor(rng() * 1000000),
    webglSuffix: Math.floor(rng() * 90) + 10,           // 10–99
    hardwareConcurrency: [4, 6, 8, 10, 12][Math.floor(rng() * 5)],
    deviceMemory: [6, 8, 10, 12][Math.floor(rng() * 4)],
    audioNoiseSeed: Math.floor(rng() * 1000000),
  };
}

const FP = generateFingerprint(WORKSPACE_BASE);

const FINGERPRINT_INIT_SCRIPT = `
(function() {
  const seed = ${FP.canvasSeed};
  let state = seed;
  function next() { state = (state * 1664525 + 1013904223) & 0x7fffffff; return state / 0x7fffffff; }

  // --- Screen resolution ---
  Object.defineProperty(screen, 'width', { get: () => ${FP.screenWidth} });
  Object.defineProperty(screen, 'height', { get: () => ${FP.screenHeight} });
  Object.defineProperty(screen, 'availWidth', { get: () => ${FP.screenWidth} });
  Object.defineProperty(screen, 'availHeight', { get: () => ${FP.screenHeight} - 25 });
  Object.defineProperty(screen, 'colorDepth', { get: () => 24 });

  // --- Hardware ---
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${FP.hardwareConcurrency} });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => ${FP.deviceMemory} });

  // --- User-Agent (JS level) ---
  const uaPatch = ${FP.uaPatch};
  const origUA = navigator.userAgent;
  const newUA = origUA.replace(/Chrome\\/(\\d+\\.\\d+\\.\\d+)\\.\\d+/, 'Chrome/$1.' + uaPatch);
  Object.defineProperty(navigator, 'userAgent', { get: () => newUA });
  Object.defineProperty(navigator, 'appVersion', { get: () => newUA.replace('Mozilla/', '') });

  // --- Canvas fingerprint noise (non-destructive, operates on clone) ---
  function addNoise(canvas) {
    try {
      const clone = document.createElement('canvas');
      clone.width = canvas.width;
      clone.height = canvas.height;
      const ctx = clone.getContext('2d');
      if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
      ctx.drawImage(canvas, 0, 0);
      const img = ctx.getImageData(0, 0, clone.width, clone.height);
      for (let i = 0; i < 10; i++) {
        const px = Math.floor(next() * img.data.length / 4) * 4;
        img.data[px] = (img.data[px] + 1) & 0xff;
      }
      ctx.putImageData(img, 0, 0);
      return clone;
    } catch { return null; }
  }

  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
    const clone = addNoise(this);
    return origToDataURL.call(clone || this, type, quality);
  };

  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  HTMLCanvasElement.prototype.toBlob = function(cb, type, quality) {
    const clone = addNoise(this);
    return origToBlob.call(clone || this, cb, type, quality);
  };

  // --- WebGL noise (renderer + vendor) ---
  const UNMASKED_RENDERER = 0x9246;
  const UNMASKED_VENDOR = 0x9245;
  function patchGetParameter(proto) {
    const orig = proto.getParameter;
    proto.getParameter = function(p) {
      const val = orig.call(this, p);
      if (p === UNMASKED_RENDERER && typeof val === 'string') return val + ' (v1.${FP.webglSuffix})';
      if (p === UNMASKED_VENDOR && typeof val === 'string') return val + ', Inc.';
      return val;
    };
  }
  patchGetParameter(WebGLRenderingContext.prototype);
  if (typeof WebGL2RenderingContext !== 'undefined') patchGetParameter(WebGL2RenderingContext.prototype);

  // --- AudioContext fingerprint noise ---
  const audioSeed = ${FP.audioNoiseSeed};
  let audioState = audioSeed;
  function audioNext() { audioState = (audioState * 1664525 + 1013904223) & 0x7fffffff; return (audioState / 0x7fffffff) * 0.0001; }

  if (typeof AudioBuffer !== 'undefined') {
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function(ch) {
      const data = origGetChannelData.call(this, ch);
      // Only add noise once per buffer (tag it)
      if (!data._fp_noised) {
        for (let i = 0; i < Math.min(data.length, 128); i++) {
          data[i] += audioNext();
        }
        data._fp_noised = true;
      }
      return data;
    };
  }
})();
`;

// --- State management ---

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {}
  return null;
}

function saveState(port, pid) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ port, pid }));
}

function clearState() {
  try { fs.unlinkSync(STATE_FILE); } catch {}
}

// --- Cookie persistence (survives VM restarts) ---
// Session cookies are only in Chrome's memory; SIGKILL loses them.
// We export via Playwright API after each navigation and restore on new browser launch.

async function saveCookiesIfChanged(context) {
  try {
    const cookies = await context.cookies();
    const newJson = JSON.stringify(cookies);
    let oldJson = '';
    try { oldJson = fs.readFileSync(COOKIES_FILE, 'utf-8'); } catch {}
    if (newJson !== oldJson) {
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      fs.writeFileSync(COOKIES_FILE, newJson);
    }
  } catch {}
}

async function restoreCookies(context) {
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
      if (cookies.length > 0) {
        await context.addCookies(cookies);
      }
    }
  } catch {}
}

// --- Ref management ---
// Refs persist between invocations so snapshot → click @e1 works across calls.

const REF_FILE = path.join(PROFILE_DIR, '.refs.json');

function saveRefs(refs) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(REF_FILE, JSON.stringify(refs));
}

function loadRefs() {
  try {
    if (fs.existsSync(REF_FILE)) {
      return JSON.parse(fs.readFileSync(REF_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

/** Resolve @eN ref to CSS selector, or return as-is if not a ref */
function resolveSelector(selectorOrRef) {
  if (/^@e\d+$/.test(selectorOrRef)) {
    const refs = loadRefs();
    const sel = refs[selectorOrRef];
    if (!sel) throw new Error(`Unknown ref ${selectorOrRef}. Run 'snapshot -i' first.`);
    return sel;
  }
  return selectorOrRef;
}

// --- CDP helpers ---

/** Check if Chrome's CDP endpoint is reachable */
function isCdpAlive(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

/** Wait for Chrome's debug port to become available */
async function waitForCdpReady(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpAlive(port)) return;
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Chrome CDP not ready on port ${port} after ${timeoutMs}ms`);
}

/** Find an available TCP port */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

// --- Browser lifecycle ---

/** Spawn a detached Chromium process with persistent profile and CDP */
function spawnChromium(debugPort) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const execPath = chromium.executablePath();
  const args = [
    `--user-data-dir=${PROFILE_DIR}`,
    `--remote-debugging-port=${debugPort}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--lang=${BROWSER_LANG}`,
    `--window-size=${FP.windowWidth},${FP.windowHeight}`,
  ];
  if (BROWSER_PROXY) args.push(`--proxy-server=${BROWSER_PROXY}`);
  args.push('about:blank');
  const child = spawn(execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, TZ: BROWSER_TIMEZONE },
  });
  child.unref();
  return child;
}

/** Connect to existing browser or launch a new one */
async function ensureBrowser(url) {
  // Load proxy config (auto-renew if expired) before launching browser
  await loadProxy();

  let port;
  let isNewBrowser = false;
  const state = loadState();

  // Try reconnecting to existing browser
  if (state?.port && await isCdpAlive(state.port)) {
    port = state.port;
  } else {
    // Kill orphaned Chrome process if we have a stale PID (e.g. after VM restart)
    if (state?.pid) {
      try { process.kill(state.pid, 'SIGTERM'); } catch {}
    }
    clearState();
    port = await findFreePort();
    const child = spawnChromium(port);
    // Save state BEFORE waiting — so the next call can kill this Chrome if we time out
    saveState(port, child.pid);
    try {
      await waitForCdpReady(port, 30000);
    } catch (err) {
      // Chrome failed to start — kill it, clear state, propagate
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
      clearState();
      throw err;
    }
    isNewBrowser = true;
  }

  // connectOverCDP auto-discovers wsUrl from http endpoint
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

  // Use the default context (tied to --user-data-dir, survives disconnection)
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error('No default browser context found after CDP connection');
  }

  // Inject fingerprint diversification (Canvas/WebGL noise, UA override at JS level)
  await context.addInitScript(FINGERPRINT_INIT_SCRIPT);

  // Build diversified UA from the real browser UA (not hardcoded)
  let diversifiedUA = '';
  try {
    const tmpPage = context.pages()[0] || await context.newPage();
    const cdp = await context.newCDPSession(tmpPage);
    const { userAgent: realUA } = await cdp.send('Browser.getVersion');
    diversifiedUA = realUA.replace(/Chrome\/(\d+\.\d+\.\d+)\.\d+/, `Chrome/$1.${FP.uaPatch}`);
  } catch {}

  // Apply HTTP-level UA override to each page (covers User-Agent header)
  async function applyHttpUA(p) {
    if (!diversifiedUA) return;
    try {
      const cdp = await context.newCDPSession(p);
      await cdp.send('Network.setUserAgentOverride', { userAgent: diversifiedUA });
    } catch {}
  }

  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }
  await applyHttpUA(page);

  // Also apply to future pages opened in this context
  context.on('page', applyHttpUA);

  // Restore saved cookies when launching a fresh Chrome (e.g. after VM restart)
  if (isNewBrowser) {
    await restoreCookies(context);
  }

  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Save cookies after navigation — captures any auth cookies set by the page
    await saveCookiesIfChanged(context);
  }

  return { browser, context, page };
}

// --- Command dispatch ---

const [,, command, ...args] = process.argv;

try {
  switch (command) {
    case 'open': {
      const url = args[0];
      if (!url) { console.error('Usage: patchright-browser open <url>'); process.exit(1); }
      const { page } = await ensureBrowser(url);
      const title = await page.title();
      console.log(`Opened: ${url}`);
      console.log(`Title: ${title}`);
      console.log(`Tip: Run 'patchright-browser snapshot -i' to see interactive elements`);
      break;
    }

    case 'snapshot': {
      const interactiveOnly = args.includes('-i');
      const { page } = await ensureBrowser();

      const results = await page.evaluate(([interactive]) => {
        // --- inline snapshot logic (runs in browser) ---
        // Remove old refs
        document.querySelectorAll('[data-pb-ref]').forEach(el => el.removeAttribute('data-pb-ref'));

        const INTERACTIVE_SEL = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="switch"], [role="combobox"], [role="option"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';

        // Phase 2: find non-semantic clickable elements via cursor:pointer heuristic
        // Covers <span>/<div> with JS click handlers (like buttons, likes, follows on SPAs)
        const POINTER_SKIP = new Set(['HTML', 'BODY', 'HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META']);

        function isVisible(el) {
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          // offsetParent is null for position:fixed/sticky elements, which are visible
          if (!el.offsetParent && style.position !== 'fixed' && style.position !== 'sticky'
              && el.tagName !== 'BODY' && el.tagName !== 'HTML') return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return false;
          return true;
        }

        function getLabel(el) {
          if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
          const labelledBy = el.getAttribute('aria-labelledby');
          if (labelledBy) {
            const labelEl = document.getElementById(labelledBy);
            if (labelEl) return labelEl.textContent.trim();
          }
          if (el.id) {
            const label = document.querySelector('label[for="' + el.id + '"]');
            if (label) return label.textContent.trim();
          }
          if (el.placeholder) return el.placeholder;
          if (el.title) return el.title;
          const text = el.textContent?.trim();
          return text && text.length <= 80 ? text : (text ? text.slice(0, 77) + '...' : '');
        }

        function getRole(el) {
          if (el.getAttribute('role')) return el.getAttribute('role');
          const tag = el.tagName.toLowerCase();
          if (tag === 'a') return 'link';
          if (tag === 'button') return 'button';
          if (tag === 'input') {
            const type = (el.type || 'text').toLowerCase();
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            if (type === 'submit' || type === 'button') return 'button';
            return 'textbox';
          }
          if (tag === 'textarea') return 'textbox';
          if (tag === 'select') return 'combobox';
          if (tag === 'img') return 'img';
          return tag;
        }

        function buildSelector(el) {
          if (el.id) return '#' + CSS.escape(el.id);
          const tag = el.tagName.toLowerCase();
          const attrs = [];
          for (const attr of ['name', 'type', 'data-testid', 'data-id', 'aria-label']) {
            if (el.getAttribute(attr)) {
              const sel = tag + '[' + attr + '=' + JSON.stringify(el.getAttribute(attr)) + ']';
              if (document.querySelectorAll(sel).length === 1) return sel;
              attrs.push([attr, el.getAttribute(attr)]);
            }
          }
          if (attrs.length >= 2) {
            const sel = tag + attrs.map(([k, v]) => '[' + k + '=' + JSON.stringify(v) + ']').join('');
            if (document.querySelectorAll(sel).length === 1) return sel;
          }
          // Fallback: use data-pb-ref attribute (we set it below)
          return '[data-pb-ref="' + el._pbRefTemp + '"]';
        }

        let candidates;
        if (interactive) {
          // Phase 1: standard interactive elements
          const standard = new Set(document.querySelectorAll(INTERACTIVE_SEL));

          // Phase 2: cursor:pointer heuristic for non-semantic clickable elements
          // Performance guard: only scan viewport-visible, leaf-like elements
          const vpH = window.innerHeight;
          const pointerHits = [];
          document.querySelectorAll('*').forEach(el => {
            if (standard.has(el) || POINTER_SKIP.has(el.tagName)) return;
            // Skip containers with many children (not a button)
            if (el.childElementCount > 5) return;
            // Skip elements that wrap a standard interactive child
            if (el.querySelector(INTERACTIVE_SEL)) return;
            // Skip off-viewport elements (cheap layout check, avoids getComputedStyle)
            const rect = el.getBoundingClientRect();
            if (rect.bottom < 0 || rect.top > vpH || rect.width === 0 || rect.height === 0) return;
            // Skip oversized elements (likely page-level containers, not buttons)
            if (rect.width > 600 && rect.height > 200) return;
            try {
              if (getComputedStyle(el).cursor === 'pointer') pointerHits.push(el);
            } catch {}
          });

          // Deduplicate nested pointer elements: keep the outermost (shallowest)
          // pointer element and remove its descendants. This groups visual children
          // (icon + count) under one ref (e.g. like-wrapper) instead of splitting them.
          const pointerSet = new Set(pointerHits);
          for (const el of pointerHits) {
            if (!pointerSet.has(el)) continue; // already removed as a descendant
            // Remove all descendants of this element from the set
            for (const other of pointerHits) {
              if (other !== el && el.contains(other)) {
                pointerSet.delete(other);
              }
            }
          }
          for (const el of pointerSet) standard.add(el);

          candidates = Array.from(standard);
          // Sort by DOM order so standard + pointer elements are interleaved naturally
          candidates.sort((a, b) => {
            const pos = a.compareDocumentPosition(b);
            if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
          });
        } else {
          candidates = Array.from(document.querySelectorAll('*'));
        }
        const elements = candidates.filter(isVisible);
        const results = [];
        let refIndex = 1;

        for (const el of elements) {
          const role = getRole(el);
          const label = getLabel(el);
          if (!interactive && !label && role !== 'img') continue;

          const ref = 'e' + refIndex++;
          el._pbRefTemp = ref;
          el.setAttribute('data-pb-ref', ref);

          const entry = { ref: '@' + ref, role, name: label, _selector: buildSelector(el) };
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            if (el.value) entry.value = el.value.slice(0, 100);
            if (el.type && el.type !== 'text') entry.type = el.type;
          }
          if (el.tagName === 'A' && el.href) entry.href = el.href;
          if (el.checked !== undefined) entry.checked = el.checked;
          if (el.disabled) entry.disabled = true;

          delete el._pbRefTemp;
          results.push(entry);
        }
        return results;
      }, [interactiveOnly]);

      // Save ref → selector mapping (el.ref is already "@eN")
      const refMap = {};
      for (const el of results) {
        refMap[el.ref] = el._selector;
      }
      saveRefs(refMap);

      // Print results (without internal _selector)
      const title = await page.title();
      const url = page.url();
      console.log(`Page: ${title}`);
      console.log(`URL: ${url}`);
      console.log(`Elements: ${results.length}${interactiveOnly ? ' (interactive)' : ''}`);
      console.log('---');
      for (const el of results) {
        const parts = [el.ref, el.role];
        if (el.name) parts.push(`"${el.name}"`);
        if (el.type) parts.push(`[${el.type}]`);
        if (el.value) parts.push(`value="${el.value}"`);
        if (el.checked !== undefined) parts.push(el.checked ? '[checked]' : '[unchecked]');
        if (el.disabled) parts.push('[disabled]');
        if (el.href) parts.push(`→ ${el.href}`);
        console.log(parts.join('  '));
      }
      break;
    }

    case 'screenshot': {
      const fullPage = args.includes('--full');
      const url = args.find(a => a !== '--full');
      const { page } = await ensureBrowser(url);
      if (url) await page.waitForTimeout(2000);
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
      const filePath = path.join(SCREENSHOT_DIR, `screenshot-${Date.now()}.png`);
      await page.screenshot({ path: filePath, fullPage });
      console.log(`Screenshot saved: ${filePath}`);
      break;
    }

    case 'html': {
      const url = args[0];
      const { page } = await ensureBrowser(url);
      console.log(await page.content());
      break;
    }

    case 'text': {
      const url = args[0];
      const { page } = await ensureBrowser(url);
      console.log(await page.evaluate(() => document.body.innerText));
      break;
    }

    case 'click': {
      const target = args[0];
      if (!target) { console.error('Usage: patchright-browser click <@ref|selector>'); process.exit(1); }
      const { page, context } = await ensureBrowser();
      const selector = resolveSelector(target);
      await page.click(selector, { timeout: 10000 });
      console.log(`Clicked: ${target}`);
      // Save cookies — click may have triggered login/auth state change
      await saveCookiesIfChanged(context);
      break;
    }

    case 'fill': {
      const target = args[0];
      const text = args.slice(1).join(' ');
      if (!target) { console.error('Usage: patchright-browser fill <@ref|selector> <text>'); process.exit(1); }
      const { page, context } = await ensureBrowser();
      const selector = resolveSelector(target);
      await page.fill(selector, text, { timeout: 10000 });
      console.log(`Filled ${target}: ${text}`);
      await saveCookiesIfChanged(context);
      break;
    }

    case 'type': {
      const target = args[0];
      const text = args.slice(1).join(' ');
      if (!target || !text) { console.error('Usage: patchright-browser type <@ref|selector> <text>'); process.exit(1); }
      const { page, context } = await ensureBrowser();
      const selector = resolveSelector(target);
      await page.type(selector, text);
      console.log(`Typed into ${target}: ${text}`);
      await saveCookiesIfChanged(context);
      break;
    }

    case 'select': {
      const target = args[0];
      const value = args[1];
      if (!target || !value) { console.error('Usage: patchright-browser select <@ref|selector> <value>'); process.exit(1); }
      const { page } = await ensureBrowser();
      const selector = resolveSelector(target);
      await page.selectOption(selector, value, { timeout: 10000 });
      console.log(`Selected ${target}: ${value}`);
      break;
    }

    case 'hover': {
      const target = args[0];
      if (!target) { console.error('Usage: patchright-browser hover <@ref|selector>'); process.exit(1); }
      const { page } = await ensureBrowser();
      const selector = resolveSelector(target);
      await page.hover(selector, { timeout: 10000 });
      console.log(`Hovered: ${target}`);
      break;
    }

    case 'press': {
      const key = args[0];
      if (!key) { console.error('Usage: patchright-browser press <key>'); process.exit(1); }
      const { page, context } = await ensureBrowser();
      await page.keyboard.press(key);
      console.log(`Pressed: ${key}`);
      await saveCookiesIfChanged(context);
      break;
    }

    case 'scroll': {
      const dir = args[0] || 'down';
      const px = parseInt(args[1]) || 500;
      const { page } = await ensureBrowser();
      const deltaX = dir === 'left' ? -px : dir === 'right' ? px : 0;
      const deltaY = dir === 'up' ? -px : dir === 'down' ? px : 0;
      await page.mouse.wheel(deltaX, deltaY);
      console.log(`Scrolled ${dir} ${px}px`);
      break;
    }

    case 'back': {
      const { page } = await ensureBrowser();
      await page.goBack({ timeout: 15000 });
      console.log(`Navigated back: ${page.url()}`);
      break;
    }

    case 'forward': {
      const { page } = await ensureBrowser();
      await page.goForward({ timeout: 15000 });
      console.log(`Navigated forward: ${page.url()}`);
      break;
    }

    case 'reload': {
      const { page } = await ensureBrowser();
      await page.reload({ timeout: 30000 });
      console.log(`Reloaded: ${page.url()}`);
      break;
    }

    case 'wait': {
      const { page } = await ensureBrowser();
      if (args[0] === '--text') {
        const text = args.slice(1).join(' ');
        await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout: 15000 });
        console.log(`Text found: "${text}"`);
      } else if (args[0] === '--url') {
        const pattern = args[1];
        await page.waitForURL(pattern, { timeout: 15000 });
        console.log(`URL matched: ${page.url()}`);
      } else if (/^@e\d+$/.test(args[0])) {
        const selector = resolveSelector(args[0]);
        await page.waitForSelector(selector, { timeout: 15000 });
        console.log(`Element found: ${args[0]}`);
      } else {
        const ms = parseInt(args[0]) || 1000;
        await page.waitForTimeout(ms);
        console.log(`Waited ${ms}ms`);
      }
      break;
    }

    case 'eval': {
      const js = args.join(' ');
      if (!js) { console.error('Usage: patchright-browser eval <javascript>'); process.exit(1); }
      const { page } = await ensureBrowser();
      const result = await page.evaluate(js);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'close': {
      const state = loadState();
      if (state?.port && await isCdpAlive(state.port)) {
        try {
          const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.port}`);
          await browser.close(); // Only disconnects CDP, does NOT kill detached process
        } catch {}
      }
      // Always kill by PID — connectOverCDP's close() doesn't terminate the process
      // Use negative PID to kill the entire process group (Chrome + helpers)
      if (state?.pid) {
        try { process.kill(-state.pid, 'SIGTERM'); } catch {
          try { process.kill(state.pid, 'SIGTERM'); } catch {} // Fallback to single process
        }
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try {
            process.kill(state.pid, 0); // Check if main process still alive
            await new Promise(r => setTimeout(r, 200));
          } catch { break; } // Process exited
        }
        try { process.kill(-state.pid, 'SIGKILL'); } catch {
          try { process.kill(state.pid, 'SIGKILL'); } catch {}
        }
      }
      clearState();
      console.log(state ? 'Browser closed.' : 'No browser running.');
      break;
    }

    case 'status': {
      const state = loadState();
      if (state?.port && await isCdpAlive(state.port)) {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.port}`);
        const pages = browser.contexts().flatMap(c => c.pages());
        console.log(`Browser running (port ${state.port}). Pages: ${pages.length}`);
        console.log(`Profile: ${PROFILE_DIR}`);
        for (const p of pages) {
          console.log(`  - ${await p.title()} (${p.url()})`);
        }
      } else {
        if (state) clearState();
        console.log('No browser running.');
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Commands: open, snapshot, screenshot, html, text, click, fill, type, select, hover, press, scroll, back, forward, reload, wait, eval, close, status');
      process.exit(1);
  }
  // Disconnect from CDP WebSocket so Node can exit
  process.exit(0);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
