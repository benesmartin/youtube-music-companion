// Runs on music.youtube.com. Reads playback state from the player bar DOM and
// the <video> element, executes commands, and streams state to connected popups.

const ext = globalThis.browser ?? globalThis.chrome;

// --- Page bridge ---
// Volume must go through YTM's own player API (page context), otherwise the
// page slider desyncs and YTM snaps the volume back. The bridge reports the
// authoritative volume/mute state; the <video> element is only a fallback.

let pageVolume = null;

function injectBridge() {
  const script = document.createElement("script");
  script.src = ext.runtime.getURL("content/bridge.js");
  script.onload = () => script.remove();
  (document.head ?? document.documentElement).append(script);
}

window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.source !== "ytmc-bridge") return;
  if (e.data.type === "volume") {
    pageVolume = { volume: e.data.volume, muted: e.data.muted };
    broadcastThrottled();
  }
});

function askBridge(command, payload = {}) {
  window.postMessage({ source: "ytmc-content", command, payload }, window.location.origin);
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

// Class selectors first — aria-labels are localized (Czech UI says "Další",
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

// Album art URLs carry a size suffix (=w60-h60 or =s60); request a larger one.
function upscaleArtwork(url) {
  return url.replace(/=w\d+-h\d+.*$/, "=w544-h544-l90-rj").replace(/=s\d+.*$/, "=s544");
}

function readState() {
  const bar = playerBar();
  const media = video();
  const title = bar?.querySelector(".title")?.textContent?.trim() ?? "";
  // The byline runs "Artist • Album • Year"; the first segment is the artist.
  const byline = bar?.querySelector(".byline")?.textContent?.trim() ?? "";
  const artist = byline.split("•")[0]?.trim() ?? "";
  const artworkSrc = bar?.querySelector("img.image")?.src ?? "";
  const like = likeButton();

  return {
    available: Boolean(bar && title),
    title,
    artist,
    artwork: artworkSrc ? upscaleArtwork(artworkSrc) : "",
    playing: Boolean(media && !media.paused && media.readyState > 0),
    position: media?.currentTime ?? 0,
    duration: Number.isFinite(media?.duration) ? media.duration : 0,
    volume: pageVolume?.volume ?? (media ? Math.round(media.volume * 100) : 100),
    muted: pageVolume?.muted ?? media?.muted ?? false,
    liked: like?.getAttribute("aria-pressed") === "true",
    disliked: dislikeButton()?.getAttribute("aria-pressed") === "true",
  };
}

function clickIfFound(el) {
  if (!el) return false;
  el.click();
  return true;
}

const commands = {
  playPause() {
    const media = video();
    if (!media) return false;
    media.paused ? media.play() : media.pause();
    return true;
  },
  next: () => clickIfFound(barButton("next-button", "^next")),
  previous: () => clickIfFound(barButton("previous-button", "^previous")),
  toggleLike: () => clickIfFound(likeButton()),
  toggleDislike: () => clickIfFound(dislikeButton()),
  seek(payload) {
    const media = video();
    if (!media || !Number.isFinite(media.duration)) return false;
    // Clamp inside the track: an out-of-range position makes YTM skip tracks.
    media.currentTime = Math.min(Math.max(0, payload.position), Math.max(0, media.duration - 0.5));
    return true;
  },
  setVolume(payload) {
    if (pageVolume) {
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
    if (pageVolume) {
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

function broadcast() {
  if (ports.size === 0) return;
  const state = readState();
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
    }
  });
  port.postMessage({ type: "state", state: readState() });
});

// One-shot commands (keyboard shortcuts routed via the background script).
ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "command") {
    sendResponse({ ok: runCommand(msg.command, msg.payload) });
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
  broadcastThrottled();
});

function start() {
  const bar = playerBar();
  if (!bar) {
    setTimeout(start, 1000);
    return;
  }
  observer.observe(bar, { childList: true, subtree: true, characterData: true });
  watchMedia();
}

start();
injectBridge();
