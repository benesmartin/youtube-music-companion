// Runs on music.youtube.com. Reads playback state from the player bar DOM and
// the <video> element, executes commands, and streams state to connected popups.

const ext = globalThis.browser ?? globalThis.chrome;

// --- Page bridge ---
// The bridge (page context) is the authority on volume/mute/player state;
// the <video> element is only a fallback.

let pageStatus = null;

// SAPISID only exists for signed-in sessions; YTM fully reloads on
// login/logout, so a load-time check stays accurate.
const signedIn = /(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=/.test(document.cookie);

function injectBridge() {
  const script = document.createElement("script");
  script.src = ext.runtime.getURL("content/bridge.js");
  // A bridge from a previous content script may already be listening (an
  // extension reload re-runs THIS script into a live page) - ask it to
  // re-announce, otherwise nothing would ever flush the outbox.
  script.onload = () => {
    script.remove();
    window.postMessage({ source: "ytmc-content", command: "ping" }, window.location.origin);
  };
  (document.head ?? document.documentElement).append(script);
  window.postMessage({ source: "ytmc-content", command: "ping" }, window.location.origin);
}

const pendingBridgeRequests = new Map();
let bridgeRequestCounter = 0;

// injectBridge() appends a <script src>, which loads ASYNCHRONOUSLY - commands
// posted before it runs hit no listener and are lost for good (the popup then
// shows "Couldn't load…" until something makes it ask again). Hold them until
// the bridge announces itself, then flush in order.
let bridgeReady = false;
const bridgeOutbox = [];

function postToBridge(message) {
  if (bridgeReady) {
    window.postMessage(message, window.location.origin);
    return;
  }
  // If the bridge never loads at all, don't grow without bound - the callers'
  // own timeouts already report the failure.
  if (bridgeOutbox.length >= 20) bridgeOutbox.shift();
  bridgeOutbox.push(message);
}

window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.source !== "ytmc-bridge") return;
  if (e.data.type === "ready") {
    bridgeReady = true;
    for (const message of bridgeOutbox.splice(0)) {
      window.postMessage(message, window.location.origin);
    }
    return;
  }
  if (e.data.type === "status") {
    pageStatus = {
      volume: e.data.volume,
      muted: e.data.muted,
      playerState: e.data.playerState,
      videoId: e.data.videoId,
      videoType: e.data.videoType,
      // The playing song's byline taken from its own queue row (id-keyed).
      byline: e.data.byline ?? null,
    };
    broadcastThrottled();
  } else if (e.data.type === "response" && pendingBridgeRequests.has(e.data.requestId)) {
    pendingBridgeRequests.get(e.data.requestId)(e.data.result);
    pendingBridgeRequests.delete(e.data.requestId);
  }
});

function askBridge(command, payload = {}) {
  postToBridge({ source: "ytmc-content", command, payload });
}

// Fire a bridge command and await its response (null on timeout).
function askBridgeAsync(command, payload = {}, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const requestId = ++bridgeRequestCounter;
    const timer = setTimeout(() => {
      pendingBridgeRequests.delete(requestId);
      resolve(null);
    }, timeoutMs);
    pendingBridgeRequests.set(requestId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    postToBridge({ source: "ytmc-content", command, payload, requestId });
  });
}

// YTM ships no public API, so state comes from scraping the player bar.
// These selectors are the maintenance hotspot when Google changes the page.
function playerBar() {
  return document.querySelector("ytmusic-player-bar");
}

function video() {
  return document.querySelector("video");
}

function likeButton() {
  const bar = playerBar();
  if (!bar) return null;
  return (
    bar.querySelector("ytmusic-like-button-renderer #button-shape-like button") ??
    bar.querySelector('ytmusic-like-button-renderer button[aria-label*="like" i]')
  );
}

function dislikeButton() {
  const bar = playerBar();
  if (!bar) return null;
  return (
    bar.querySelector("ytmusic-like-button-renderer #button-shape-dislike button") ??
    bar.querySelector('ytmusic-like-button-renderer button[aria-label*="dislike" i]')
  );
}

// Class selectors first - aria-labels are localized (Czech UI says "Další",
// not "Next"), so label matching is only a last-resort fallback.
function barButton(className, labelPattern) {
  const bar = playerBar();
  if (!bar) return null;
  const byClass = bar.querySelector(`.${className}`);
  if (byClass) return byClass;
  const re = new RegExp(labelPattern, "i");
  for (const btn of bar.querySelectorAll("button, tp-yt-paper-icon-button")) {
    const label = btn.getAttribute("aria-label") ?? btn.getAttribute("title") ?? "";
    if (re.test(label)) return btn;
  }
  return null;
}

// The app's volume slider is the authoritative volume state; its value is
// reflected into an attribute, which the isolated world can read directly.
function sliderVolume() {
  const slider = playerBar()?.querySelector("#volume-slider");
  const value = Number(slider?.getAttribute("aria-valuenow"));
  return Number.isFinite(value) ? value : null;
}

// From the progress bar, not <video> - the first video element can go stale
// across track changes.
function progressInfo() {
  const slider = playerBar()?.querySelector("#progress-bar");
  const position = Number(slider?.getAttribute("aria-valuenow"));
  const duration = Number(slider?.getAttribute("aria-valuemax"));
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return null;
  return { position, duration };
}

// repeat-mode attribute: NONE/ALL/ONE; null = unknown.
function repeatMode() {
  const bar = playerBar();
  const raw = bar?.getAttribute("repeat-mode_") ?? bar?.getAttribute("repeat-mode");
  if (!raw) return null;
  return { NONE: "off", ALL: "all", ONE: "one" }[raw] ?? "off";
}

// Album art URLs carry a size suffix (=w60-h60 or =s60); request a larger one.
function upscaleArtwork(url) {
  return url.replace(/=w\d+-h\d+.*$/, "=w544-h544-l90-rj").replace(/=s\d+.*$/, "=s544");
}

// --- Dynamic accent extraction (accent: "auto") ---
// Lives here, not in the popup: the tab sees every track change, so the
// popup opens to a fresh memo and the background can tint the toolbar icon
// even while the popup is closed. Vibrant-style pick (what ThemeSong gets
// from node-vibrant): 4-bit RGB buckets scored 3·S + 6.5·(1−|L−0.5|) +
// 0.5·population. Only hue+sat are stored - consumers impose lightness per
// theme so contrast never depends on the art.
let accentAuto = false;
let accentArtUrl = null;

ext.storage.local
  .get("settings")
  .then((stored) => {
    accentAuto = stored.settings?.accent === "auto";
    if (accentAuto) maybeExtractAccent(playerBar()?.querySelector("img.image")?.src ?? "");
  })
  .catch(() => {});

ext.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const was = accentAuto;
  accentAuto = changes.settings.newValue?.accent === "auto";
  if (accentAuto && !was) {
    accentArtUrl = null; // flipping in re-extracts the current art
    maybeExtractAccent(playerBar()?.querySelector("img.image")?.src ?? "");
  }
});

function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

async function maybeExtractAccent(src) {
  if (!accentAuto || !src || src === accentArtUrl) return;
  accentArtUrl = src;
  let bitmap;
  try {
    // fetch → ImageBitmap, NOT an <img> with crossOrigin: Firefox refuses
    // CORS-mode element loads from the content-script sandbox (silent error
    // event), while a plain cors fetch of the ACAO:* art succeeds - and the
    // blob-backed bitmap never taints the canvas.
    const response = await fetch(corsSafeArtUrl(src));
    if (!response.ok) return;
    bitmap = await createImageBitmap(await response.blob());
  } catch {
    return; // network/decode failure - consumers keep the previous memo
  }
  if (src !== accentArtUrl || !accentAuto) return; // superseded meanwhile
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, size, size);
  bitmap.close();
  let data;
  try {
    data = ctx.getImageData(0, 0, size, size).data;
  } catch {
    return; // tainted canvas - consumers keep their fallback
  }
  const buckets = new Map(); // 4-bit RGB key → [count, rSum, gSum, bSum]
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const bucket = buckets.get(key) ?? [0, 0, 0, 0];
    bucket[0] += 1;
    bucket[1] += data[i];
    bucket[2] += data[i + 1];
    bucket[3] += data[i + 2];
    buckets.set(key, bucket);
  }
  if (buckets.size === 0) return; // blank decode - don't poison the memo
  let best = null;
  let bestScore = -1;
  let maxCount = 0;
  for (const bucket of buckets.values()) maxCount = Math.max(maxCount, bucket[0]);
  for (const [count, rSum, gSum, bSum] of buckets.values()) {
    const [h, s, l] = rgbToHsl(rSum / count, gSum / count, bSum / count);
    if (s < 0.2 || l < 0.12 || l > 0.88) continue; // grays, near-black/white
    const score = 3 * s + 6.5 * (1 - Math.abs(l - 0.5)) + 0.5 * (count / maxCount);
    if (score > bestScore) {
      bestScore = score;
      best = [h, s];
    }
  }
  try {
    // null pick = grayscale art; consumers fall back to red.
    ext.storage.local.set({ autoAccentMemo: { url: src, pick: best } });
  } catch {
    // memo is best-effort
  }
}

// The bar's own URL is already in the HTTP cache as a no-CORS response, and
// re-requesting it with crossOrigin set fails the CORS check against that
// cached copy (no ACAO stored). A size variant the page never asks for gets
// a fresh, properly-CORS'd fetch instead.
function corsSafeArtUrl(url) {
  const swapped = url.replace(/=w\d+-h\d+.*$/, "=w64-h64-l90-rj").replace(/=s\d+.*$/, "=s64");
  if (swapped !== url) return swapped;
  return url + (url.includes("?") ? "&" : "?") + "ytmc=1";
}

function readState() {
  const bar = playerBar();
  const media = video();
  const title = bar?.querySelector(".title")?.textContent?.trim() ?? "";

  // Byline: "Artist • Album • Year" - album trusted only when its link exists
  // (music videos have none).
  const bylineEl = bar?.querySelector(".byline");
  const links = bylineEl ? [...bylineEl.querySelectorAll("a")] : [];
  const bylineParts = (bylineEl?.getAttribute("title") ?? bylineEl?.textContent ?? "")
    .split("•")
    .map((part) => part.trim());
  // One <a> per artist - structured for per-artist links in the popup.
  const artists = links
    .filter((a) => a.getAttribute("href")?.startsWith("channel/"))
    .map((a) => ({ name: a.textContent?.trim() ?? "", url: a.getAttribute("href") ?? "" }))
    .filter((entry) => entry.name);
  let artist = artists.length
    ? artists.map((entry) => entry.name).join(", ")
    : bylineParts[0] ?? "";
  let album =
    links.find((a) => a.getAttribute("href")?.startsWith("browse/"))?.textContent?.trim() ?? "";
  let year = album && bylineParts.length >= 3 ? bylineParts[bylineParts.length - 1] : "";
  let artistList = artists;
  let albumHref =
    links.find((a) => a.getAttribute("href")?.startsWith("browse/"))?.getAttribute("href") ?? "";

  // The bar's byline can be left over from the PREVIOUS track (YTM bug: right
  // art and title, stale artist and album). The queue row the bridge reads is
  // keyed by videoId, so it always describes the song that is playing - take
  // it whenever it names an artist.
  const rowByline = pageStatus?.byline;
  if (rowByline?.videoId && rowByline.videoId === pageStatus?.videoId && rowByline.artists?.length) {
    artistList = rowByline.artists;
    artist = rowByline.artists.map((entry) => entry.name).join(", ");
    album = rowByline.album?.name ?? "";
    albumHref = rowByline.album?.url ?? "";
    year = rowByline.year ?? "";
  }

  // Library membership is per-track; a new title invalidates the last probe.
  if (title !== libraryTitle) {
    libraryTitle = title;
    libraryState = null;
    libraryAvailable = null;
    // Re-push the queue as YTM rebuilds it (can land late).
    setTimeout(pushQueue, 500);
    setTimeout(pushQueue, 1600);
    setTimeout(pushQueue, 3500);
    // Warm the lyrics cache; the early try bails until duration settles.
    setTimeout(prefetchLyrics, 800);
    setTimeout(prefetchLyrics, 2500);
  }

  const artworkSrc = bar?.querySelector("img.image")?.src ?? "";
  maybeExtractAccent(artworkSrc); // no-op unless accent is "auto" and the art changed
  // like-status carries LIKE / DISLIKE / INDIFFERENT in one attribute.
  const likeStatus = bar
    ?.querySelector("ytmusic-like-button-renderer")
    ?.getAttribute("like-status");

  return {
    available: Boolean(bar && title),
    signedIn,
    title,
    artist,
    artists: artistList,
    album,
    year,
    videoId: pageStatus?.videoId ?? location.href.match(/[?&]v=([^&]+)/)?.[1] ?? "",
    videoType: pageStatus?.videoType ?? null,
    artistUrl: artistList[0]?.url ?? "",
    albumUrl: albumHref,
    artwork: artworkSrc ? upscaleArtwork(artworkSrc) : "",
    playing: isPlaying(),
    position: progressInfo()?.position ?? media?.currentTime ?? 0,
    duration: progressInfo()?.duration ?? (Number.isFinite(media?.duration) ? media.duration : 0),
    volume: sliderVolume() ?? pageStatus?.volume ?? (media ? Math.round(media.volume * 100) : 100),
    muted: pageStatus?.muted ?? media?.muted ?? false,
    liked: likeStatus ? likeStatus === "LIKE" : likeButton()?.getAttribute("aria-pressed") === "true",
    disliked: likeStatus
      ? likeStatus === "DISLIKE"
      : dislikeButton()?.getAttribute("aria-pressed") === "true",
    repeat: repeatMode(),
    inLibrary: libraryState,
    libraryAvailable,
  };
}

// Is audio actually running? A tab that was restored but never interacted
// with sits in BUFFERING forever when the browser blocks autoplay, and
// calling that "playing" made the popup show a pause button that could only
// pause something already stopped (user report, 2026-08-18).
function isPlaying() {
  const media = video();
  const state = pageStatus?.playerState;
  if (state === 1) return true;
  if (state === 3) return Boolean(media && !media.paused);
  if (state != null) return false;
  return Boolean(media && !media.paused && media.readyState > 0);
}

// Opens the player-bar menu invisibly; workers key on language-independent
// traits (hrefs, icon paths) - labels are localized.
async function withHiddenMenu(worker) {
  const menuButton = playerBar()?.querySelector("ytmusic-menu-renderer #button-shape button");
  if (!menuButton) return false;
  const veil = document.createElement("style");
  veil.textContent =
    "ytmusic-popup-container { opacity: 0 !important; pointer-events: none !important; }";
  document.head.append(veil);
  try {
    menuButton.click();
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = worker();
      if (result != null) return result;
    }
    return false;
  } finally {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.body.click();
    setTimeout(() => veil.remove(), 250);
  }
}

// null = unknown (probed lazily when the popup's dropdown opens);
// libraryAvailable=false means the track has no library action (user uploads)
let libraryState = null;
let libraryAvailable = null;
let libraryTitle = "";

function startRadio() {
  return withHiddenMenu(() => {
    const link = document.querySelector('ytmusic-menu-navigation-item-renderer a[href*="list=RD"]');
    if (!link) return null;
    // Stale menus carry the previous track's radio link - verify the id.
    const id = pageStatus?.videoId;
    if (id && !link.getAttribute("href")?.includes(id)) return null;
    link.click();
    return true;
  });
}

// Library state needs page-context Polymer data - the bridge does the work.
function applyLibraryResult(result) {
  if (!result) return;
  libraryAvailable = result.available;
  libraryState = typeof result.inLibrary === "boolean" ? result.inLibrary : null;
}

async function probeLibrary() {
  // Already known for this track - don't churn the menu again.
  if (libraryAvailable === false || libraryState !== null) {
    broadcast();
    return true;
  }
  applyLibraryResult(await askBridgeAsync("probeLibrary"));
  broadcast();
  return true;
}

async function toggleLibrary() {
  applyLibraryResult(await askBridgeAsync("toggleLibrary"));
  broadcast();
  return true;
}

// yt-icon-button hosts (e.g. .shuffle, .repeat, .volume) wrap the real
// <button>; clicking the host doesn't reach its listener.
function clickIfFound(el) {
  if (!el) return false;
  (el.querySelector?.("button") ?? el).click();
  return true;
}

// ---- queue ----

// Wrapper entries hold a visible primary and a hidden counterpart item;
// counting both duplicates every track.
function queueItemElements() {
  const scope = document.querySelector("ytmusic-player-queue") ?? document;
  return [...scope.querySelectorAll("ytmusic-player-queue-item")].filter(
    (item) => !item.closest("#counterpart-renderer")
  );
}

function readQueue() {
  // Autoplay off leaves automix rows hidden in the DOM - drop them (filter
  // after mapping so item.index keeps matching DOM positions).
  const autoplayOff = autoplayState() === false;
  return queueItemElements()
    .map((item, index) => {
      // Lazy thumbs start as a 1×1 data: GIF - report as missing.
      const src = item.querySelector("img")?.src ?? "";
      return {
        index,
        title: item.querySelector(".song-title")?.textContent?.trim() ?? "",
        artist: item.querySelector(".byline")?.textContent?.trim() ?? "",
        duration: item.querySelector(".duration")?.textContent?.trim() ?? "",
        thumb: src.startsWith("data:") ? "" : src,
        selected: item.hasAttribute("selected"),
        automix: item.closest("#automix-contents") !== null,
      };
    })
    .filter((entry) => entry.title && !(autoplayOff && entry.automix));
}

// Fill thumbs/artists from the queue store - DOM images lazy-load late.
// Store rows map 1:1 onto DOM rows, so the row's own index entry is the
// authority; title-keyed lookup only rescues a misaligned store. It must
// never win over an aligned index match: title keys collapse duplicate
// titles onto the last entry, repainting every same-titled row as it
// (e.g. two covers of one song queued together).
// The home feed, held for the tab's life so reopening the popup is instant.
// Ten minutes: long enough to cover a listening session, short enough that
// YTM's recommendations refresh on their own eventually.
const HOME_TTL_MS = 10 * 60 * 1000;
let homeCache = { at: 0, shelves: [], continuation: null };

function applyQueueStoreData(queue, data) {
  const thumbByTitle = new Map(
    data.filter((entry) => entry.thumb).map((entry) => [entry.title, entry.thumb])
  );
  const artistByTitle = new Map(
    data.filter((entry) => entry.artist).map((entry) => [entry.title, entry.artist])
  );
  for (const item of queue) {
    const indexed = data[item.index];
    // Titleless store entries (player-playlist fallback) still align.
    const aligned = indexed && (!indexed.title || indexed.title === item.title) ? indexed : null;
    if (!item.thumb) {
      item.thumb = aligned?.thumb || thumbByTitle.get(item.title) || "";
    }
    // Store artists are comma-joined; the DOM byline uses localized "and".
    const artist = aligned?.artist || artistByTitle.get(item.title) || "";
    if (artist) item.artist = artist;
    // Only the index-aligned entry may name the row's video: a title match
    // would hand duplicate titles the same id.
    if (aligned?.videoId) item.videoId = aligned.videoId;
  }
}

async function queueWithThumbs() {
  const queue = readQueue();
  if (queue.length) {
    const data = await askBridgeAsync("getQueueData", {}, 2000);
    if (Array.isArray(data)) applyQueueStoreData(queue, data);
  }
  return queue;
}

// YTM's autoplay toggle; null = not rendered yet.
function autoplayState() {
  const toggle = document.querySelector("tp-yt-paper-toggle-button#automix");
  if (!toggle) return null;
  // Live property first - attribute reflection lags a re-render.
  if (typeof toggle.checked === "boolean") return toggle.checked;
  return toggle.hasAttribute("checked") || toggle.getAttribute("aria-pressed") === "true";
}

async function pushQueue() {
  if (ports.size === 0) return;
  const queue = await queueWithThumbs();
  const autoplay = autoplayState();
  for (const port of ports) {
    port.postMessage({ type: "queue", queue, autoplay });
  }
}

let queueThrottle = null;
function pushQueueThrottled() {
  if (queueThrottle) return;
  queueThrottle = setTimeout(() => {
    queueThrottle = null;
    pushQueue();
  }, 800);
}

const queueObserver = new MutationObserver(pushQueueThrottled);
let observedQueue = null;

function watchQueue() {
  const container = document.querySelector("ytmusic-player-queue");
  if (!container || container === observedQueue) return;
  // The container is replaced on queue rebuilds - re-observe the new one.
  observedQueue = container;
  queueObserver.disconnect();
  queueObserver.observe(container, {
    childList: true,
    subtree: true,
    attributes: true,
    // "src" catches thumbnails lazy-loading in after a queue rebuild
    attributeFilter: ["selected", "src"],
  });
}

// Per-row menu actions, items identified by icon path (labels localized).
const QUEUE_MENU_ICONS = {
  playNext: 'path[d^="M6 2.86"]',
  addToQueue: 'path[d^="M21 6.998"]',
  removeFromQueue: 'path[d*="Zm3 6H6"]',
};

async function queueItemMenuAction(index, iconSelector) {
  const item = queueItemElements()[index];
  if (!item) return false;
  const menuButton = item.querySelector("ytmusic-menu-renderer #button-shape button");
  const veil = document.createElement("style");
  veil.textContent =
    "ytmusic-popup-container { opacity: 0 !important; pointer-events: none !important; }";
  document.head.append(veil);
  try {
    if (menuButton) {
      menuButton.click();
    } else {
      // Automix rows have no ⋯ button; the right-click menu carries the
      // same service items with the same icons. Off-screen coordinates
      // make YTM drop the event, so bring the row into view first.
      item.scrollIntoView({ block: "center" });
      const rect = item.getBoundingClientRect();
      item.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          composed: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        })
      );
    }
    // Menu contents are fetched per-row - slow networks need the long tail.
    for (let attempt = 0; attempt < 35; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Scope to the OPEN dropdown - stale menus linger and would match.
      const path = document.querySelector(
        `ytmusic-popup-container tp-yt-iron-dropdown:not([aria-hidden="true"]) ${iconSelector}`
      );
      const target = path?.closest("ytmusic-menu-service-item-renderer");
      if (target) {
        target.click();
        return true;
      }
    }
    return false;
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 200));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.body.click();
    setTimeout(() => veil.remove(), 250);
    setTimeout(pushQueue, 700);
  }
}

function currentVolume() {
  const media = video();
  return sliderVolume() ?? pageStatus?.volume ?? (media ? Math.round(media.volume * 100) : 100);
}

const commands = {
  async playPause() {
    // When in doubt, try to PLAY: a stuck-buffering tab used to take the
    // pause branch, which did nothing and said nothing.
    if (isPlaying()) {
      const pageButton = barButton("play-pause-button", "^(play|pause)$");
      if (pageButton) return clickIfFound(pageButton);
      video()?.pause();
      return true;
    }
    // Play can hit the autoplay policy; the bridge tries the muted-start trick.
    const result = await askBridgeAsync("forcePlay", {}, 3000);
    if (result === true) return true;
    if (result === null) {
      // Bridge unavailable - fall back to the plain button click.
      const pageButton = barButton("play-pause-button", "^(play|pause)$");
      if (pageButton) return clickIfFound(pageButton);
      return false;
    }
    notifyPorts(
      "Playback was blocked by the browser. Allow autoplay for music.youtube.com, or press play in the tab once."
    );
    return false;
  },
  next: () => clickIfFound(barButton("next-button", "^next")),
  previous: () => clickIfFound(barButton("previous-button", "^previous")),
  shuffle: () => clickIfFound(barButton("shuffle", "shuffle")),
  toggleRepeat: () => clickIfFound(barButton("repeat", "repeat")),
  startRadio: () =>
    Promise.resolve(startRadio()).then((ok) => {
      if (!ok) notifyPorts("Couldn’t start a radio for this song. Try again.");
      return ok;
    }),
  toggleLibrary,
  probeLibrary,
  // Click a specific byline anchor (per-artist navigation), SPA-safe.
  openByline(payload) {
    const anchors = playerBar()?.querySelectorAll(".byline a") ?? [];
    const anchor = [...anchors].find((a) => a.getAttribute("href") === payload.href);
    if (anchor) return clickIfFound(anchor);
    // The href came from the queue row, so the bar has no such anchor.
    const browseId = String(payload.href ?? "").split("/")[1];
    if (!browseId) return false;
    askBridgeAsync("navigateBrowse", { browseId }, 5000);
    return true;
  },
  // payload may carry playlistId/params so YTM builds the proper queue
  playVideoById: (payload) =>
    askBridgeAsync("playVideoById", payload).then((result) => {
      if (!result) notifyPorts("Couldn’t play that song. Try again.");
      return result === true;
    }),
  playPlaylist: (payload) =>
    askBridgeAsync("playPlaylist", {
      playlistId: payload.playlistId,
      shuffle: payload.shuffle,
    }).then((ok) => {
      // Tell popups directly - the queue-tab switch shouldn't wait out its
      // 3s fallback when the bridge already confirmed playback.
      for (const port of ports) port.postMessage({ type: "playlistStarted", ok });
      setTimeout(pushQueue, 400);
      return ok;
    }),
  toggleAutoplay() {
    const toggle = document.querySelector("tp-yt-paper-toggle-button#automix");
    if (!toggle) return false;
    toggle.click();
    setTimeout(pushQueue, 400);
    return true;
  },
  queueMove(payload) {
    return askBridgeAsync("queueMove", {
      fromIndex: payload.fromIndex,
      toIndex: payload.toIndex,
    }).then((ok) => {
      if (!ok) notifyPorts("That row can’t be reordered. Autoplay suggestions stay put.");
      // Re-push either way: confirms the new order or snaps the preview back.
      setTimeout(pushQueue, 400);
      return ok;
    });
  },
  queueVideoNext(payload) {
    return askBridgeAsync("queueVideoNext", { videoId: payload.videoId }).then((ok) => {
      if (!ok) notifyPorts("Couldn’t add that song to the queue.");
      setTimeout(pushQueue, 700);
      return ok;
    });
  },
  queueVideoLast(payload) {
    return askBridgeAsync("queueVideoLast", { videoId: payload.videoId }).then((ok) => {
      if (!ok) notifyPorts("Couldn’t add that song to the queue.");
      setTimeout(pushQueue, 700);
      return ok;
    });
  },
  queuePlayNext: (payload) =>
    queueItemMenuAction(payload.index, QUEUE_MENU_ICONS.playNext).then(async (ok) => {
      if (!ok) {
        // The automix right-click menu sometimes never populates. Fall back
        // to inserting a copy after the playing row via the store - the
        // song still plays next, the suggestion row just stays put.
        const data = await askBridgeAsync("getQueueData", {}, 2000);
        const videoId = Array.isArray(data) ? data[payload.index]?.videoId : null;
        if (videoId) {
          ok = (await askBridgeAsync("queueVideoNext", { videoId })) === true;
          if (ok) setTimeout(pushQueue, 700);
        }
      }
      if (!ok) notifyPorts("Couldn’t move that song. Try again.");
      return ok;
    }),
  queueAddToQueue: (payload) =>
    queueItemMenuAction(payload.index, QUEUE_MENU_ICONS.addToQueue).then(async (ok) => {
      if (!ok) {
        // Same automix stall as play-next - fall back to a store append.
        const data = await askBridgeAsync("getQueueData", {}, 2000);
        const videoId = Array.isArray(data) ? data[payload.index]?.videoId : null;
        if (videoId) {
          ok = (await askBridgeAsync("queueVideoLast", { videoId })) === true;
          if (ok) setTimeout(pushQueue, 700);
        }
      }
      if (!ok) notifyPorts("Couldn’t add that song to the queue.");
      return ok;
    }),
  // Whole album/playlist, from the album and playlist pane bars. The queue
  // push is delayed like the row actions - the store settles a frame or two
  // after the dispatch.
  queuePlaylistNext: (payload) =>
    askBridgeAsync("queuePlaylistNext", {
      playlistId: payload.playlistId,
      videoIds: payload.videoIds,
    }).then((ok) => {
      if (!ok) notifyPorts("Couldn’t queue that up. Try again.");
      setTimeout(pushQueue, 700);
      return ok;
    }),
  queuePlaylistLast: (payload) =>
    askBridgeAsync("queuePlaylistLast", {
      playlistId: payload.playlistId,
      videoIds: payload.videoIds,
    }).then((ok) => {
      if (!ok) notifyPorts("Couldn’t queue that up. Try again.");
      setTimeout(pushQueue, 700);
      return ok;
    }),
  // Import: a pasted queue, already reduced to videoIds by the popup. The
  // chunked get_queue makes this slower than any other command, hence the
  // longer leash.
  queueImport: (payload) =>
    askBridgeAsync(
      "queueImport",
      { videoIds: payload.videoIds, replace: payload.replace },
      30000
    ).then((count) => {
      if (!count) {
        notifyPorts("Couldn’t import that queue.");
        return 0;
      }
      for (const port of ports) {
        port.postMessage({ type: "queueImported", count, asked: payload.videoIds.length });
      }
      setTimeout(pushQueue, 700);
      return count;
    }),
  queueRemove: (payload) =>
    queueItemMenuAction(payload.index, QUEUE_MENU_ICONS.removeFromQueue).then((ok) => {
      if (!ok) notifyPorts("Couldn’t remove that song. Try again.");
      return ok;
    }),
  playQueueItem(payload) {
    const items = queueItemElements();
    const item = items[payload.index];
    if (!item || item.hasAttribute("selected")) return false;
    (item.querySelector("ytmusic-play-button-renderer") ?? item).click();
    return true;
  },
  pause() {
    // One-way pause (sleep timer): no-op when nothing is audible. Not the
    // playPause toggle - on a stuck-buffering tab that toggle deliberately
    // takes the PLAY branch, which is the last thing a sleep timer wants.
    if (!isPlaying()) return true;
    const pageButton = barButton("play-pause-button", "^(play|pause)$");
    if (pageButton) return clickIfFound(pageButton);
    video()?.pause();
    return true;
  },
  toggleLike: () => clickIfFound(likeButton()),
  toggleDislike: () => clickIfFound(dislikeButton()),
  seek(payload) {
    // Clamp: out-of-range seeks make YTM skip; 1s margin avoids the end race.
    const progress = progressInfo();
    if (progress) {
      const target = Math.min(Math.max(0, payload.position), Math.max(0, progress.duration - 1));
      askBridge("seekTo", { position: target });
      return true;
    }
    const media = video();
    if (!media || !Number.isFinite(media.duration)) return false;
    media.currentTime = Math.min(Math.max(0, payload.position), Math.max(0, media.duration - 1));
    return true;
  },
  volumeUp: () => commands.setVolume({ volume: Math.min(100, currentVolume() + 10) }),
  volumeDown: () => commands.setVolume({ volume: Math.max(0, currentVolume() - 10) }),
  setVolume(payload) {
    if (pageStatus || sliderVolume() !== null) {
      askBridge("setVolume", { volume: payload.volume });
      return true;
    }
    const media = video();
    if (!media) return false;
    media.volume = Math.min(1, Math.max(0, payload.volume / 100));
    if (media.volume > 0) media.muted = false;
    return true;
  },
  toggleMute() {
    // YTM's own mute button keeps the app state consistent, same as the slider.
    const pageMute = barButton("volume", "^mute");
    if (pageMute) return clickIfFound(pageMute);
    if (pageStatus) {
      askBridge("toggleMute");
      return true;
    }
    const media = video();
    if (!media) return false;
    media.muted = !media.muted;
    return true;
  },
};

function runCommand(name, payload = {}) {
  const handler = commands[name];
  return handler ? handler(payload) !== false : false;
}

// --- State streaming to popups over long-lived ports ---

const ports = new Set();

// Error toasts in any open popup - corrects the popup's optimistic toasts.
function notifyPorts(text) {
  for (const port of ports) {
    port.postMessage({ type: "notice", text });
  }
}

// Keep the toolbar icon's state dot current even when no popup is open.
let lastIndicator = null;
function notifyBackground(state) {
  const indicator = state.available ? (state.playing ? "playing" : "paused") : "none";
  if (indicator === lastIndicator) return;
  lastIndicator = indicator;
  ext.runtime.sendMessage({ type: "playbackState", indicator }).catch(() => {});
}

// --- Lyrics prefetch (fetching + cache live in the background script) ---

const LYRICS_TYPES = new Set(["MUSIC_VIDEO_TYPE_ATV", "MUSIC_VIDEO_TYPE_OMV"]);
let lyricsPrefetchedKey = null;

async function prefetchLyrics() {
  const state = readState();
  if (!state.available || !state.title || !state.duration) return;
  const eligible = state.videoType
    ? LYRICS_TYPES.has(state.videoType)
    : Boolean(state.album);
  if (!eligible) return;
  const key = state.videoId || `${state.title}|${state.artist}`;
  if (key === lyricsPrefetchedKey) return;
  try {
    // Respect the opt-in: no request leaves the browser until it's enabled.
    if (!(await ext.storage.local.get("lyricsEnabled")).lyricsEnabled) return;
    lyricsPrefetchedKey = key;
    await ext.runtime.sendMessage({
      type: "fetchLyrics",
      track: {
        videoId: state.videoId,
        title: state.title,
        artist: state.artist,
        album: state.album,
        duration: state.duration,
      },
    });
  } catch {
    // background unavailable - the popup fetches on demand instead
  }
}

function broadcast() {
  const state = readState();
  notifyBackground(state);
  for (const port of ports) {
    port.postMessage({ type: "state", state });
  }
}

let throttleTimer = null;
function broadcastThrottled() {
  if (throttleTimer) return;
  throttleTimer = setTimeout(() => {
    throttleTimer = null;
    broadcast();
  }, 500);
}

ext.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((msg) => {
    if (msg.type === "command") {
      runCommand(msg.command, msg.payload);
      // Reflect the result quickly; button clicks need a beat to apply.
      setTimeout(broadcast, 150);
    } else if (msg.type === "getQueue") {
      queueWithThumbs().then((queue) =>
        port.postMessage({ type: "queue", queue, autoplay: autoplayState() })
      );
    } else if (msg.type === "getPlaylists") {
      // Above the bridge's own paging budget, so a partial page still wins
      // over this timeout instead of failing the whole tab.
      askBridgeAsync("getPlaylists", { continuation: msg.continuation }, 10000).then((playlists) =>
        port.postMessage({
          type: "playlists",
          append: Boolean(msg.continuation),
          playlists,
        })
      );
    } else if (msg.type === "getPlaylistTracks") {
      askBridgeAsync(
        "getPlaylistTracks",
        { browseId: msg.browseId, continuation: msg.continuation },
        8000
      ).then((result) =>
        port.postMessage({
          type: "playlistTracks",
          browseId: msg.browseId,
          append: Boolean(msg.continuation),
          tracks: result?.tracks ?? null,
          continuation: result?.continuation ?? null,
        })
      );
    } else if (msg.type === "getAlbum") {
      // One request, no paging - albums come whole.
      askBridgeAsync("getAlbum", { browseId: msg.browseId }, 8000).then((album) =>
        port.postMessage({ type: "album", browseId: msg.browseId, album: album ?? null })
      );
    } else if (msg.type === "addToPlaylist") {
      askBridgeAsync("addToPlaylist", { playlistId: msg.playlistId, videoId: msg.videoId }, 8000)
        .then((result) =>
          port.postMessage({
            type: "addToPlaylistResult",
            result: result ?? "error",
            name: msg.name,
            playlistId: msg.playlistId,
          })
        );
    } else if (msg.type === "removeFromPlaylist") {
      askBridgeAsync("removeFromPlaylist", { endpoint: msg.endpoint }, 8000).then((ok) =>
        port.postMessage({
          type: "removeFromPlaylistResult",
          ok: Boolean(ok),
          name: msg.name,
          playlistId: msg.playlistId,
          setVideoId: msg.setVideoId,
        })
      );
    } else if (msg.type === "search") {
      askBridgeAsync("search", { query: msg.query }, 8000).then((results) =>
        port.postMessage({ type: "searchResults", query: msg.query, results })
      );

    } else if (msg.type === "getHome") {
      // Recommendation shelves off the YTM home page; paged like playlists,
      // one continuation at a time. Kept in the tab so reopening the popup
      // paints instantly instead of refetching - the feed barely moves within
      // a listening session, and everything the user scrolled in comes back.
      if (!msg.continuation && homeCache.shelves.length && Date.now() - homeCache.at < HOME_TTL_MS) {
        port.postMessage({
          type: "home",
          append: false,
          home: { signedOut: false, shelves: homeCache.shelves, continuation: homeCache.continuation },
        });
        return;
      }
      askBridgeAsync("getHome", { continuation: msg.continuation }, 10000).then((home) => {
        if (home?.shelves?.length) {
          homeCache = {
            at: Date.now(),
            // A continuation extends what's cached; a fresh load replaces it.
            shelves: msg.continuation ? homeCache.shelves.concat(home.shelves) : home.shelves,
            continuation: home.continuation ?? null,
          };
        }
        port.postMessage({ type: "home", append: Boolean(msg.continuation), home });
      });
    } else if (msg.type === "getHistory") {
      // The user's real YTM history, fetched by the bridge via the page's
      // own internal API (needs page context for ytcfg + auth cookies).
      askBridgeAsync("getHistory", {}, 8000).then((history) =>
        port.postMessage({ type: "history", history })
      );
    }
  });
  port.postMessage({ type: "state", state: readState() });
});

// One-shot commands (keyboard shortcuts routed via the background script).
ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "command") {
    sendResponse({ ok: runCommand(msg.command, msg.payload) });
  } else if (msg.type === "queryPlayback") {
    lastIndicator = null; // force a fresh notification
    broadcast();
  }
  return false;
});

// --- Change detection ---

function watchMedia() {
  const media = video();
  if (!media || media.dataset.ytmcWatched) return;
  media.dataset.ytmcWatched = "true";
  for (const event of ["play", "pause", "volumechange", "loadedmetadata"]) {
    media.addEventListener(event, broadcast);
  }
  media.addEventListener("timeupdate", broadcastThrottled);
}

const observer = new MutationObserver(() => {
  watchMedia();
  watchQueue();
  broadcastThrottled();
});

function start() {
  const bar = playerBar();
  if (!bar) {
    setTimeout(start, 1000);
    return;
  }
  // attributeFilter also catches volume-slider drags and like-state changes
  observer.observe(bar, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-valuenow", "aria-pressed", "like-status", "repeat-mode_", "repeat-mode"],
  });
  watchMedia();
  watchQueue();
}

start();
injectBridge();
