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
  script.onload = () => script.remove();
  (document.head ?? document.documentElement).append(script);
}

const pendingBridgeRequests = new Map();
let bridgeRequestCounter = 0;

window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.source !== "ytmc-bridge") return;
  if (e.data.type === "status") {
    pageStatus = {
      volume: e.data.volume,
      muted: e.data.muted,
      playerState: e.data.playerState,
      videoId: e.data.videoId,
      videoType: e.data.videoType,
    };
    broadcastThrottled();
  } else if (e.data.type === "response" && pendingBridgeRequests.has(e.data.requestId)) {
    pendingBridgeRequests.get(e.data.requestId)(e.data.result);
    pendingBridgeRequests.delete(e.data.requestId);
  }
});

function askBridge(command, payload = {}) {
  window.postMessage({ source: "ytmc-content", command, payload }, window.location.origin);
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
    window.postMessage({ source: "ytmc-content", command, payload, requestId }, window.location.origin);
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
  const artist = artists.length
    ? artists.map((entry) => entry.name).join(", ")
    : bylineParts[0] ?? "";
  const album =
    links.find((a) => a.getAttribute("href")?.startsWith("browse/"))?.textContent?.trim() ?? "";
  const year = album && bylineParts.length >= 3 ? bylineParts[bylineParts.length - 1] : "";

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
  // like-status carries LIKE / DISLIKE / INDIFFERENT in one attribute.
  const likeStatus = bar
    ?.querySelector("ytmusic-like-button-renderer")
    ?.getAttribute("like-status");

  return {
    available: Boolean(bar && title),
    signedIn,
    title,
    artist,
    artists,
    album,
    year,
    videoId: pageStatus?.videoId ?? location.href.match(/[?&]v=([^&]+)/)?.[1] ?? "",
    videoType: pageStatus?.videoType ?? null,
    artistUrl:
      links.find((a) => a.getAttribute("href")?.startsWith("channel/"))?.getAttribute("href") ?? "",
    albumUrl:
      links.find((a) => a.getAttribute("href")?.startsWith("browse/"))?.getAttribute("href") ?? "",
    artwork: artworkSrc ? upscaleArtwork(artworkSrc) : "",
    playing:
      pageStatus?.playerState != null
        ? pageStatus.playerState === 1 || pageStatus.playerState === 3
        : Boolean(media && !media.paused && media.readyState > 0),
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

// yt-icon-button hosts (e.g. .shuffle, .repeat, .volume) wrap the real
// <button>; clicking the host doesn't reach its listener.
function bylineLink(hrefPrefix) {
  const bylineEl = playerBar()?.querySelector(".byline");
  if (!bylineEl) return null;
  return [...bylineEl.querySelectorAll("a")].find((a) =>
    a.getAttribute("href")?.startsWith(hrefPrefix)
  );
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
      // same service items with the same icons.
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
    for (let attempt = 0; attempt < 20; attempt++) {
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
    const playing =
      pageStatus?.playerState === 1 || pageStatus?.playerState === 3;
    if (playing) {
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
  goToArtist: () => clickIfFound(bylineLink("channel/")),
  goToAlbum: () => clickIfFound(bylineLink("browse/")),
  // Click a specific byline anchor (per-artist navigation), SPA-safe.
  openByline(payload) {
    const anchors = playerBar()?.querySelectorAll(".byline a") ?? [];
    return clickIfFound(
      [...anchors].find((a) => a.getAttribute("href") === payload.href)
    );
  },
  // payload may carry playlistId/params so YTM builds the proper queue
  playVideoById: (payload) => askBridgeAsync("playVideoById", payload),
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
  queuePlayNext: (payload) =>
    queueItemMenuAction(payload.index, QUEUE_MENU_ICONS.playNext).then((ok) => {
      if (!ok) notifyPorts("Couldn’t move that song. Try again.");
      return ok;
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
    // One-way pause (sleep timer): no-op when already paused.
    const playing =
      pageStatus?.playerState != null
        ? pageStatus.playerState === 1 || pageStatus.playerState === 3
        : Boolean(video() && !video().paused);
    if (!playing) return true;
    return commands.playPause();
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
      askBridgeAsync("getPlaylists", {}, 8000).then((playlists) =>
        port.postMessage({ type: "playlists", playlists })
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
