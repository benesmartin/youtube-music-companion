// Routes keyboard shortcuts (manifest "commands") to the YouTube Music tab.
// Must stay service-worker-safe for Chrome: no DOM, no persistent state.

const ext = globalThis.browser ?? globalThis.chrome;

const SHORTCUT_COMMANDS = {
  "play-pause": "playPause",
  "next-track": "next",
  "previous-track": "previous",
  "toggle-like": "toggleLike",
  // No default keys (browsers cap suggested keys at four) — users bind them
  // via Manage Extension Shortcuts / chrome://extensions/shortcuts.
  "volume-up": "volumeUp",
  "volume-down": "volumeDown",
  "toggle-dislike": "toggleDislike",
};

async function findMusicTab() {
  const tabs = await ext.tabs.query({ url: "https://music.youtube.com/*" });
  if (tabs.length === 0) return null;
  // Prefer an audible tab when several are open.
  return tabs.find((tab) => tab.audible) ?? tabs[0];
}

// ---- toolbar icon state dot (green playing, yellow paused, gray off) ----

const DOT_COLORS = { playing: "#22c55e", paused: "#eab308", none: "#9ca3af" };
let currentIndicator = null;
let requestedIndicator = "none";

// The icon mark (mirrors icons/icon.svg) drawn vectorially per size — scaled
// rasters looked mushy. Card colors are the palette's deep variants.
const ICON_CARDS = {
  red: "#d93a32",
  orange: "#e07b1a",
  yellow: "#c99b06",
  green: "#1e9e44",
  teal: "#0f8a96",
  blue: "#2673d4",
  purple: "#7c5ce0",
  pink: "#d94a8c",
};
const ICON_RING = "rgba(255, 255, 255, 0.9)";
// [x, y1, y2] per audio line
const ICON_LINES = [
  [32, 57.6, 67.2],
  [44.8, 44.8, 80],
  [57.6, 35.2, 92.8],
  [70.4, 51.2, 73.6],
  [83.2, 41.6, 83.2],
  [96, 57.6, 67.2],
];

function drawIconBase(ctx, size, card) {
  const k = size / 128;
  ctx.beginPath();
  ctx.roundRect(2 * k, 2 * k, 124 * k, 124 * k, 30 * k);
  ctx.fillStyle = card;
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(10 * k, 10 * k, 108 * k, 108 * k, 24 * k);
  ctx.strokeStyle = ICON_RING;
  ctx.lineWidth = Math.max(1, 3.5 * k);
  ctx.stroke();
  ctx.strokeStyle = "#ffffff";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1, 8 * k);
  ctx.beginPath();
  for (const [x, y1, y2] of ICON_LINES) {
    ctx.moveTo(x * k, y1 * k);
    ctx.lineTo(x * k, y2 * k);
  }
  ctx.stroke();
}

async function setIndicator(indicator) {
  requestedIndicator = indicator;
  let stored = null;
  try {
    stored = (await ext.storage.local.get("settings")).settings ?? null;
  } catch {
    stored = null;
  }
  // Setting off → no dot, but still the crisp vector-drawn icon.
  const target = stored?.statusDot !== false ? indicator : "plain";
  const card = stored?.accentIcon ? ICON_CARDS[stored.accent] ?? ICON_CARDS.red : ICON_CARDS.red;
  const cacheKey = `${target}|${card}`;
  if (cacheKey === currentIndicator) return;
  currentIndicator = cacheKey;
  try {
    const imageData = {};
    // 64 serves HiDPI toolbars asking for 32@2x.
    for (const size of [16, 32, 64]) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext("2d");
      drawIconBase(ctx, size, card);
      if (target !== "plain") {
        // Dot overlaps the top-right corner like a notification badge.
        const radius = Math.max(3, Math.round(size * 0.2));
        ctx.beginPath();
        ctx.arc(size - radius - 0.5, radius + 0.5, radius, 0, Math.PI * 2);
        ctx.fillStyle = DOT_COLORS[target] ?? DOT_COLORS.none;
        ctx.fill();
        ctx.lineWidth = Math.max(1, size / 16);
        ctx.strokeStyle = "#1a1a1a";
        ctx.stroke();
      }
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    await ext.action.setIcon({ imageData });
  } catch {
    // Canvas unavailable — leave the static manifest icon.
  }
}

ext.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "playbackState") setIndicator(msg.indicator);
});

// React to the status-dot setting flipping while we're running.
ext.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) setIndicator(requestedIndicator);
});

// ---- lyrics (LRCLIB) ----
// Fetching lives here so content can prefetch and the popup gets cache hits.

const LYRICS_CACHE_LIMIT = 40;
// Bump when matching logic changes to drop stale cached entries.
const LYRICS_CACHE_VERSION = 2;

async function readLyricsCache() {
  const stored = await ext.storage.local.get(["lyricsCache", "lyricsCacheVersion"]);
  return stored.lyricsCacheVersion === LYRICS_CACHE_VERSION ? stored.lyricsCache ?? {} : {};
}

// Fold case/diacritics/"(Remastered)"-suffixes so cosmetics don't block matches.
function normalizeName(name) {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function lrclibLookup(track) {
  // Exact lookup first — duration (±2s server-side) is what makes it precise.
  const params = new URLSearchParams({
    track_name: track.title,
    artist_name: track.artist,
    duration: String(Math.round(track.duration)),
  });
  if (track.album) params.set("album_name", track.album);
  let res = await fetch(`https://lrclib.net/api/get?${params}`);
  if (res.ok) return res.json();
  // Miss — search and take the closest duration within reason.
  const searchParams = new URLSearchParams({
    track_name: track.title,
    artist_name: track.artist,
  });
  res = await fetch(`https://lrclib.net/api/search?${searchParams}`);
  if (!res.ok) return null;
  const hits = await res.json();
  if (!Array.isArray(hits) || !hits.length) return null;
  // Fuzzy search returns wrong songs — demand a title match + artist overlap.
  const title = normalizeName(track.title);
  const artist = normalizeName(track.artist);
  const candidates = hits.filter((hit) => {
    if (normalizeName(hit.trackName) !== title) return false;
    const hitArtist = normalizeName(hit.artistName);
    return hitArtist === artist || hitArtist.includes(artist) || artist.includes(hitArtist);
  });
  if (!candidates.length) return null;
  candidates.sort(
    (a, b) =>
      Math.abs((a.duration ?? 0) - track.duration) - Math.abs((b.duration ?? 0) - track.duration)
  );
  return Math.abs((candidates[0].duration ?? 0) - track.duration) <= 10 ? candidates[0] : null;
}

// One lookup per track at a time — the popup joins the in-flight prefetch.
const lyricsInflight = new Map();

function getLyrics(track) {
  if (!track?.title) return Promise.resolve(null);
  const key = track.videoId || `${track.title}|${track.artist}`;
  if (lyricsInflight.has(key)) return lyricsInflight.get(key);
  const pending = doGetLyrics(track).finally(() => lyricsInflight.delete(key));
  lyricsInflight.set(key, pending);
  return pending;
}

async function doGetLyrics(track) {
  try {
    if (track.videoId) {
      const cache = await readLyricsCache();
      if (cache[track.videoId]) return cache[track.videoId];
    }
    let data = null;
    try {
      data = await lrclibLookup(track);
    } catch {
      data = null;
    }
    const entry = {
      synced: data?.syncedLyrics ?? "",
      plain: data?.plainLyrics ?? "",
      instrumental: Boolean(data?.instrumental),
      at: Date.now(),
    };
    if (track.videoId) {
      const cache = await readLyricsCache();
      cache[track.videoId] = entry;
      const keys = Object.keys(cache);
      if (keys.length > LYRICS_CACHE_LIMIT) {
        keys.sort((a, b) => (cache[a].at ?? 0) - (cache[b].at ?? 0));
        for (const key of keys.slice(0, keys.length - LYRICS_CACHE_LIMIT)) delete cache[key];
      }
      await ext.storage.local.set({
        lyricsCache: cache,
        lyricsCacheVersion: LYRICS_CACHE_VERSION,
      });
    }
    return entry;
  } catch {
    return null;
  }
}

ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "fetchLyrics") {
    getLyrics(msg.track).then(sendResponse);
    return true; // async response
  }
  return false;
});

// No YTM tab left → disconnected dot (the closing tab may still be queryable).
async function checkTabsGone(excludeTabId) {
  const tabs = await ext.tabs.query({ url: "https://music.youtube.com/*" });
  if (tabs.every((tab) => tab.id === excludeTabId)) setIndicator("none");
}
ext.tabs.onRemoved.addListener((tabId) => checkTabsGone(tabId));
ext.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && !changeInfo.url.startsWith("https://music.youtube.com/")) {
    checkTabsGone(tabId);
  }
});

// On (re)start, ask the content script for the real state instead of
// assuming disconnected.
(async () => {
  await setIndicator("none");
  const tab = await findMusicTab();
  if (!tab) return;
  try {
    await ext.tabs.sendMessage(tab.id, { type: "queryPlayback" });
  } catch {
    // Content script not ready; it will report when it loads.
  }
})();

ext.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "sleep-timer") return;
  const tab = await findMusicTab();
  if (!tab) return;
  try {
    await ext.tabs.sendMessage(tab.id, { type: "command", command: "pause" });
  } catch {
    // Content script not reachable; nothing to pause.
  }
});

ext.commands.onCommand.addListener(async (name) => {
  const command = SHORTCUT_COMMANDS[name];
  if (!command) return;
  const tab = await findMusicTab();
  if (!tab) return;
  try {
    await ext.tabs.sendMessage(tab.id, { type: "command", command });
  } catch {
    // Tab exists but the content script isn't ready (e.g. mid-reload); ignore.
  }
});
