// Popup UI. Connects to the content script in the YouTube Music tab over a
// long-lived port and re-renders whenever it pushes fresh state.

const ext = globalThis.browser ?? globalThis.chrome;

const el = (id) => document.getElementById(id);
const playerView = el("player");
const emptyView = el("empty");

const YTM_BASE = "https://music.youtube.com/";

let port = null;
let seeking = false;
let volumeDragging = false;
let volumeSettleTimer = null;

// Volume is under user control from pointerdown until shortly after release;
// state echoes from the page are ignored for that whole window.
function volumeBusy() {
  return volumeDragging || volumeSettleTimer !== null;
}
let currentTrack = null;
let currentTabId = null;
let lastState = null;

// Sliders paint their filled portion via the --fill custom property.
function updateFill(slider) {
  const pct = (100 * Number(slider.value)) / Math.max(1, Number(slider.max));
  slider.style.setProperty("--fill", `${pct}%`);
}

function formatTime(totalSeconds) {
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

let emptyTimer = null;

// Tab connected but no track loaded: placeholder header, dimmed transport,
// and the tabs stay usable - search or a playlist can start the music.
function renderIdle() {
  lastState = null;
  currentTrack = null;
  artistsSig = null;
  playerView.hidden = false;
  emptyView.hidden = true;
  playerView.classList.add("idle");
  el("title").textContent = "Nothing is playing!";
  el("title").title = "";
  el("artist").textContent = "Search or pick a playlist to get going";
  el("album").textContent = "";
  el("album-year").textContent = "";
  el("seek").value = 0;
  el("position").textContent = "0:00";
  el("duration").textContent = "0:00";
  updateCaptureBar();
}

function render(state) {
  if (!state.available) {
    // SPA navigation blanks the bar briefly - only bail if it stays gone.
    if (lastState?.available) {
      if (!emptyTimer) {
        emptyTimer = setTimeout(() => {
          emptyTimer = null;
          renderIdle();
        }, 1500);
      }
    } else {
      renderIdle();
    }
    return;
  }
  clearTimeout(emptyTimer);
  emptyTimer = null;
  playerView.hidden = false;
  emptyView.hidden = true;
  playerView.classList.remove("idle");

  // A track change invalidates an in-flight seek drag.
  const track = `${state.title}|${state.artist}`;
  if (track !== currentTrack) {
    currentTrack = track;
    seeking = false;
  }

  el("title").textContent = state.title;
  renderArtists(state);
  el("album").textContent = state.album ?? "";
  el("album-year").textContent = state.album && state.year ? ` • ${state.year}` : "";
  // Tooltips only where text actually truncates.
  el("title").title = el("title").scrollWidth > el("title").clientWidth ? state.title : "";
  el("album").title = el("album").scrollWidth > el("album").clientWidth ? state.album : "";

  lastState = state;
  updateCaptureBar();
  // Must run AFTER lastState updates - renderLyrics reads it.
  if (activeTab === "lyrics") {
    const lyricsStateKey = state.videoId || `${state.title}|${state.artist}`;
    if (lyricsStateKey !== lyricsRenderKey) renderLyrics();
    else updateLyricsHighlight(state.position);
  }
  el("album").classList.toggle("link", Boolean(state.albumUrl));
  el("radio").disabled = !state.videoId;
  el("copy-link").disabled = !state.videoId;
  el("copy-info").disabled = !state.title;

  const gated = state.signedIn === false;
  el("like").classList.toggle("gated", gated);
  el("dislike").classList.toggle("gated", gated);
  el("library").classList.toggle("gated", gated);
  // "Add" until probed; uploads have no library action - keep row, disable.
  // Signed out it stays clickable so the click can explain itself.
  el("library").disabled = gated ? false : !state.videoId || state.libraryAvailable === false;
  el("library").classList.toggle("in", state.inLibrary === true);
  // Tile-sized labels; the filled icon carries the "in library" state too.
  el("library-label").textContent = state.inLibrary === true ? "In library" : "Add to library";
  el("library").title = state.inLibrary === true ? "Remove from library" : "";
  if (el("artwork").src !== state.artwork) el("artwork").src = state.artwork;

  el("play-pause").classList.toggle("playing", state.playing);
  el("like").classList.toggle("active", state.liked);
  el("dislike").classList.toggle("active", state.disliked);
  el("mute").classList.toggle("muted", state.muted);
  if (!volumeBusy()) el("mute").classList.toggle("high", state.volume >= 50);
  el("repeat").classList.toggle("active", state.repeat === "all" || state.repeat === "one");
  el("repeat").classList.toggle("one", state.repeat === "one");

  el("position").textContent = formatTime(state.position);
  el("duration").textContent = formatTime(state.duration);
  if (!seeking) {
    el("seek").max = Math.max(1, Math.floor(state.duration));
    el("seek").value = Math.floor(state.position);
    updateFill(el("seek"));
  }
  // Echoed state would yank the knob mid-drag - wait for the settle window.
  if (!volumeBusy()) {
    el("volume").value = state.muted ? 0 : state.volume;
    updateFill(el("volume"));
  }
}

// One clickable span per artist - a collective link only reached the first.
let artistsSig = null;

function renderArtists(state) {
  const list = state.artists?.length
    ? state.artists
    : state.artist
      ? [{ name: state.artist, url: state.artistUrl ?? "" }]
      : [];
  const sig = JSON.stringify(list);
  if (sig === artistsSig) return; // avoid rebuilding spans on every push
  artistsSig = sig;
  const wrap = el("artist");
  wrap.textContent = "";
  list.forEach((entry, i) => {
    if (i) wrap.append(", ");
    const span = document.createElement("span");
    span.textContent = entry.name;
    if (entry.url) {
      span.className = "artist-link";
      span.addEventListener("click", () => {
        send("openByline", { href: entry.url });
        focusYtmTab();
      });
    }
    wrap.append(span);
  });
  wrap.title =
    wrap.scrollWidth > wrap.clientWidth ? list.map((entry) => entry.name).join(", ") : "";
}

// One toast look; "success" just leaves sooner than notices/errors.
let toastTimer = null;
function showToast(text, kind = "notice") {
  el("toast").textContent = text;
  el("toast").hidden = false;
  placeToast();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el("toast").hidden = true;
  }, kind === "success" ? 2000 : 6000);
}

function showEmpty() {
  playerView.hidden = true;
  emptyView.hidden = false;
}

function send(command, payload = {}) {
  port?.postMessage({ type: "command", command, payload });
}

// Signed-out sessions: account actions stay clickable but explain themselves
// instead of silently opening a sign-in dialog in the hidden tab.
function requireSignIn(what) {
  if (lastState?.signedIn === false) {
    showToast(`Sign in to YouTube Music to ${what}.`);
    return true;
  }
  return false;
}

el("play-pause").addEventListener("click", () => send("playPause"));
el("next").addEventListener("click", () => send("next"));
el("previous").addEventListener("click", () => send("previous"));
el("like").addEventListener("click", () => {
  if (requireSignIn("like songs")) return;
  send("toggleLike");
});
el("dislike").addEventListener("click", () => {
  if (requireSignIn("rate songs")) return;
  send("toggleDislike");
});
el("shuffle").addEventListener("click", () => send("shuffle"));
el("repeat").addEventListener("click", () => send("toggleRepeat"));
el("mute").addEventListener("click", () => send("toggleMute"));

el("seek").addEventListener("input", () => {
  seeking = true;
  el("position").textContent = formatTime(Number(el("seek").value));
  updateFill(el("seek"));
});

// Hover (and drag) preview: the time under the cursor, in a bubble above
// the bar. Native ranges map the value to the thumb's center, hence the
// half-thumb correction at the edges.
const SEEK_THUMB = 10; // --thumb in the slider styles

el("seek").addEventListener("pointermove", (e) => {
  const seek = el("seek");
  const duration = Number(seek.max);
  if (duration <= 1 || playerView.classList.contains("idle")) return;
  const rect = seek.getBoundingClientRect();
  const fraction = Math.min(
    1,
    Math.max(0, (e.clientX - rect.left - SEEK_THUMB / 2) / (rect.width - SEEK_THUMB))
  );
  const bubble = el("seek-preview");
  bubble.textContent = formatTime(fraction * duration);
  bubble.hidden = false;
  const half = bubble.offsetWidth / 2;
  const x = seek.offsetLeft + SEEK_THUMB / 2 + fraction * (seek.offsetWidth - SEEK_THUMB);
  bubble.style.left = `${Math.min(seek.offsetLeft + seek.offsetWidth - half, Math.max(seek.offsetLeft + half, x))}px`;
  bubble.style.top = `${seek.offsetTop - 8}px`;
});

el("seek").addEventListener("pointerleave", () => {
  el("seek-preview").hidden = true;
});
el("seek").addEventListener("change", () => {
  // Only send if the drag wasn't invalidated by a track change mid-drag.
  if (seeking) send("seek", { position: Number(el("seek").value) });
  seeking = false;
});

el("volume").addEventListener("pointerdown", () => {
  volumeDragging = true;
});

window.addEventListener("pointerup", () => {
  if (!volumeDragging) return;
  volumeDragging = false;
  // Let the last command's echo arrive before trusting page state again.
  clearTimeout(volumeSettleTimer);
  volumeSettleTimer = setTimeout(() => {
    volumeSettleTimer = null;
  }, 600);
});

el("volume").addEventListener("input", () => {
  send("setVolume", { volume: Number(el("volume").value) });
  updateFill(el("volume"));
  el("mute").classList.toggle("high", Number(el("volume").value) >= 50);
  if (!volumeDragging) {
    // Keyboard adjustment - settle window keeps echoes at bay.
    clearTimeout(volumeSettleTimer);
    volumeSettleTimer = setTimeout(() => {
      volumeSettleTimer = null;
    }, 600);
  }
});

el("open-ytm").addEventListener("click", async () => {
  await ext.tabs.create({ url: YTM_BASE });
  window.close();
});

// ---- more-actions sheet ----
// Slides over the tab area; persists until a click lands outside it.

// Toasts ride above the sheet while it's open, back to the bottom when not.
function placeToast() {
  const sheet = el("action-sheet");
  el("toast").style.bottom = sheet.hidden ? "" : `${sheet.offsetHeight + 10}px`;
}

function toggleMenu(open) {
  const sheet = el("action-sheet");
  const show = open ?? sheet.hidden;
  sheet.hidden = !show;
  el("sheet-backdrop").hidden = !show;
  el("more").classList.toggle("open", show);
  if (show) {
    // No point churning YTM's menu for library state while signed out.
    if (lastState?.signedIn !== false) send("probeLibrary");
    refreshSleep();
  }
  placeToast();
}

el("more").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleMenu();
});
el("sleep-chip").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleMenu(true);
});
// The backdrop swallows the dismissing click - nothing underneath fires.
el("sheet-backdrop").addEventListener("click", () => toggleMenu(false));

// Radio via YTM's own menu item - SPA navigation, playback keeps running.
el("radio").addEventListener("click", () => send("startRadio"));

el("library").addEventListener("click", () => {
  if (requireSignIn("use your library")) return;
  send("toggleLibrary");
});

async function copyToClipboard(button, text) {
  await navigator.clipboard.writeText(text);
  button.classList.add("copied");
  setTimeout(() => button.classList.remove("copied"), 1200);
}

el("copy-link").addEventListener("click", () => {
  if (lastState?.videoId) copyToClipboard(el("copy-link"), `${YTM_BASE}watch?v=${lastState.videoId}`);
});

el("copy-info").addEventListener("click", () => {
  if (lastState?.title) copyToClipboard(el("copy-info"), `${lastState.artist} - ${lastState.title}`);
});

// ---- sleep timer ----

async function refreshSleep() {
  let alarm = null;
  try {
    alarm = await ext.alarms.get("sleep-timer");
  } catch {
    // API unavailable; leave the timer UI inert.
  }
  const seconds = alarm ? Math.max(1, Math.round((alarm.scheduledTime - Date.now()) / 1000)) : 0;
  // Armed: presets make way for a single Stop timer action.
  el("sleep-off").hidden = !alarm;
  el("sleep-presets").hidden = Boolean(alarm);
  el("sleep-remaining").textContent = alarm
    ? `Pausing in ${formatTime(seconds)}`
    : "No timer running";
  // The chip keeps a running timer visible without opening the sheet.
  el("sleep-chip").hidden = !alarm;
  el("sleep-chip-min").textContent = alarm ? formatTime(seconds) : "";
}

// Live countdown while the popup sits open.
refreshSleep();
setInterval(refreshSleep, 1000);

const SLEEP_MAX_MINUTES = 720;

function armSleep(minutes) {
  if (!Number.isFinite(minutes) || minutes < 1) return;
  const clamped = Math.min(SLEEP_MAX_MINUTES, Math.round(minutes));
  ext.alarms.create("sleep-timer", { delayInMinutes: clamped });
  el("sleep-remaining").textContent = `Pausing in ${formatTime(clamped * 60)}`;
  el("sleep-off").hidden = false;
  el("sleep-presets").hidden = true;
  toggleMenu(false);
  setTimeout(refreshSleep, 150);
}

// Keep typed values inside the timer's range as they're entered.
el("sleep-custom-min").addEventListener("input", () => {
  const input = el("sleep-custom-min");
  const value = Number(input.value);
  if (value > SLEEP_MAX_MINUTES) input.value = String(SLEEP_MAX_MINUTES);
});

for (const option of document.querySelectorAll(".sleep-opt")) {
  option.addEventListener("click", () => armSleep(Number(option.dataset.min)));
}

el("sleep-set").addEventListener("click", () => armSleep(Number(el("sleep-custom-min").value)));
el("sleep-custom-min").addEventListener("keydown", (e) => {
  if (e.key === "Enter") armSleep(Number(el("sleep-custom-min").value));
});

el("sleep-off").addEventListener("click", async () => {
  el("sleep-off").hidden = true;
  el("sleep-presets").hidden = false;
  el("sleep-remaining").textContent = "No timer running";
  await ext.alarms.clear("sleep-timer");
  refreshSleep();
});

// ---- navigation ----

// Focus the YTM tab; navigation happens via YTM's own anchors (SPA-safe).
async function focusYtmTab() {
  if (currentTabId === null) return;
  const tab = await ext.tabs.update(currentTabId, { active: true });
  await ext.windows.update(tab.windowId, { focused: true });
  window.close();
}

function goTo(command) {
  send(command);
  focusYtmTab();
}

el("album").addEventListener("click", () => lastState?.albumUrl && goTo("goToAlbum"));
el("artwork").addEventListener("click", focusYtmTab);
el("artwork-idle").addEventListener("click", focusYtmTab);

// ---- queue ----

let lastSelectedIndex = null;

function renderQueue(queue) {
  const list = el("queue-list");
  // A push mid-drag would destroy the dragged row; the post-drop push repaints.
  if (list.querySelector(".qrow.dragging")) return;
  list.textContent = "";
  if (!queue.length) {
    const note = document.createElement("div");
    note.id = "queue-note";
    // Idle: the radio hint would point at a disabled menu.
    note.textContent = playerView.classList.contains("idle")
      ? "Nothing in the queue."
      : "Nothing in the queue. Try Start radio from the ⋯ menu.";
    list.append(note);
    lastSelectedIndex = null;
    return;
  }

  let automixHeaderAdded = false;
  for (const item of queue) {
    // Autoplay off: never render suggestions, even from a stale push.
    if (item.automix && lastAutoplay === false) continue;
    if (item.automix && !automixHeaderAdded) {
      automixHeaderAdded = true;
      const header = document.createElement("div");
      header.className = "queue-subheader";
      header.textContent = "Autoplay";
      list.append(header);
    }
    const row = document.createElement("div");
    row.className = item.selected ? "qrow now" : "qrow";
    if (item.automix) row.classList.add("automix");
    const thumb = document.createElement("div");
    thumb.className = "qthumb";
    if (item.thumb) thumb.style.backgroundImage = `url("${item.thumb}")`;
    const meta = document.createElement("div");
    meta.className = "qmeta";
    const title = document.createElement("div");
    title.className = "qtitle";
    title.textContent = item.title;
    const artist = document.createElement("div");
    artist.className = "qartist";
    artist.textContent = item.artist;
    meta.append(title, artist);
    const duration = document.createElement("div");
    duration.className = "qdur";
    duration.textContent = item.duration;
    row.append(thumb, meta, duration);

    // Hover actions - not on the playing row, where they make no sense.
    if (!item.selected) {
      row.classList.add("has-actions");
      const actions = document.createElement("div");
      actions.className = "qactions";
      for (const [title, icon, command] of [
        ["Play next", "#i-play-next", "queuePlayNext"],
        ["Remove from queue", "#i-remove", "queueRemove"],
      ]) {
        const button = document.createElement("button");
        button.title = title;
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
        use.setAttribute("href", icon);
        svg.append(use);
        button.append(svg);
        button.addEventListener("click", (e) => {
          e.stopPropagation();
          send(command, { index: item.index });
          // Removal shows itself; only play-next toasts (YTM parity).
          if (command === "queuePlayNext") showToast("Song will play next", "success");
        });
        actions.append(button);
      }
      row.append(actions);
    }

    // Automix rows aren't movable, so a drag attempt used to fall through
    // to the click handler and play the row on release. Past a jitter
    // threshold the press counts as a refused drag: show the no-go cursor
    // and swallow the click. Real rows are covered by native drag - no
    // click fires after a drop.
    let dragRefused = false;
    if (item.automix) {
      row.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        dragRefused = false;
        const startX = e.clientX;
        const startY = e.clientY;
        const onMove = (ev) => {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
            dragRefused = true;
            row.classList.add("drag-refused");
          }
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          // The click lands right after mouseup; reset once it has passed.
          setTimeout(() => {
            dragRefused = false;
            row.classList.remove("drag-refused");
          }, 0);
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }
    row.addEventListener("click", () => {
      if (dragRefused) return;
      send("playQueueItem", { index: item.index });
    });

    // Local drag preview; the drop sends one queueMove and the next push
    // confirms or snaps back. Automix rows aren't movable.
    row.draggable = !item.automix;
    row.dataset.qindex = String(item.index);
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", ""); // Firefox needs data to drag
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      const rows = [...list.querySelectorAll(".qrow")];
      const toIndex = rows.indexOf(row);
      const fromIndex = Number(row.dataset.qindex);
      if (toIndex !== -1 && toIndex !== fromIndex) {
        send("queueMove", { fromIndex, toIndex });
      }
    });

    list.append(row);
  }

  const selectedIndex = queue.findIndex((item) => item.selected);
  if (selectedIndex !== lastSelectedIndex) {
    lastSelectedIndex = selectedIndex;
    list.querySelector(".now")?.scrollIntoView({ block: "center" });
  }
}

// ---- settings (theme) ----

const DEFAULT_SETTINGS = {
  theme: "dark", // "dark" | "light" | "system"
  accent: "red",
  statusDot: true,
  showDislike: true,
  accentIcon: false,
  lyricsSize: "m",
};
// Named hues with per-theme variants (bright on dark, deep on light).
const ACCENTS = [
  { name: "red", dark: "#ff4e45", light: "#d93a32" },
  { name: "orange", dark: "#ff9f43", light: "#e07b1a" },
  { name: "yellow", dark: "#f7c948", light: "#c99b06" },
  { name: "green", dark: "#34c759", light: "#1e9e44" },
  { name: "teal", dark: "#2bb8c4", light: "#0f8a96" },
  { name: "blue", dark: "#4a9eff", light: "#2673d4" },
  { name: "purple", dark: "#a78bfa", light: "#7c5ce0" },
  { name: "pink", dark: "#ff6bb0", light: "#d94a8c" },
];
let settings = { ...DEFAULT_SETTINGS };

const systemLightQuery = window.matchMedia("(prefers-color-scheme: light)");

function applySettings() {
  const light =
    settings.theme === "light" || (settings.theme === "system" && systemLightQuery.matches);
  const accent = ACCENTS.find((a) => a.name === settings.accent) ?? ACCENTS[0];
  document.body.classList.toggle("light", light);
  document.documentElement.style.setProperty("--accent", light ? accent.light : accent.dark);
  for (const option of document.querySelectorAll(".theme-opt")) {
    option.classList.toggle("active", option.dataset.theme === settings.theme);
  }
  for (const swatch of document.querySelectorAll(".accent-swatch")) {
    const def = ACCENTS.find((a) => a.name === swatch.dataset.accent);
    // Swatches preview the variant the current theme would actually use.
    if (def) swatch.style.background = light ? def.light : def.dark;
    swatch.classList.toggle("active", swatch.dataset.accent === accent.name);
  }
  el("set-status-dot").classList.toggle("on", settings.statusDot !== false);
  el("set-dislike").classList.toggle("on", settings.showDislike !== false);
  el("dislike").hidden = settings.showDislike === false;
  el("set-accent-icon").classList.toggle("on", settings.accentIcon === true);
  const sizes = { s: "11.5px", m: "12.5px", l: "14px" };
  el("lyrics-pane").style.fontSize = sizes[settings.lyricsSize] ?? sizes.m;
  for (const option of document.querySelectorAll("#lyrics-size button")) {
    option.classList.toggle("active", (settings.lyricsSize ?? "m") === option.dataset.size);
  }
}

// Live-follow the OS when the theme is set to System.
systemLightQuery.addEventListener("change", () => {
  if (settings.theme === "system") applySettings();
});

function saveSettings() {
  applySettings();
  try {
    ext.storage.local.set({ settings });
  } catch {
    // session-only preference
  }
}

async function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...(await ext.storage.local.get("settings")).settings };
  } catch {
    // defaults stand
  }
  // Migrate pre-palette settings that stored a raw hex instead of a name.
  if (settings.accent.startsWith("#")) {
    settings.accent = ACCENTS.find((a) => a.dark === settings.accent)?.name ?? "red";
  }
  try {
    lyricsEnabled = Boolean((await ext.storage.local.get("lyricsEnabled")).lyricsEnabled);
  } catch {
    lyricsEnabled = false;
  }
  el("set-lyrics").classList.toggle("on", lyricsEnabled);
  updateLyricsTab();
  applySettings();
}

for (const def of ACCENTS) {
  const swatch = document.createElement("button");
  swatch.className = "accent-swatch";
  swatch.dataset.accent = def.name;
  swatch.title = def.name;
  swatch.addEventListener("click", () => {
    settings.accent = def.name;
    saveSettings();
  });
  el("accent-options").append(swatch);
}

for (const option of document.querySelectorAll(".theme-opt")) {
  option.addEventListener("click", () => {
    settings.theme = option.dataset.theme;
    saveSettings();
  });
}

el("set-status-dot").addEventListener("click", () => {
  settings.statusDot = settings.statusDot === false;
  saveSettings();
});

el("set-dislike").addEventListener("click", () => {
  settings.showDislike = settings.showDislike === false;
  saveSettings();
});

// The background script watches settings and redraws the toolbar icon.
el("set-accent-icon").addEventListener("click", () => {
  settings.accentIcon = settings.accentIcon !== true;
  saveSettings();
});

for (const option of document.querySelectorAll("#lyrics-size button")) {
  option.addEventListener("click", () => {
    settings.lyricsSize = option.dataset.size;
    saveSettings();
  });
}

// Lyrics opt-in lives under its own storage key (the content script's
// prefetch reads it too); this switch and the in-tab Enable button are two
// faces of the same flag.
el("set-lyrics").addEventListener("click", () => setLyricsEnabled(!lyricsEnabled));

// The gear toggles settings and returns to wherever the user came from.
let settingsReturnTab = "queue";

el("settings-open").addEventListener("click", () => {
  if (activeTab === "settings") {
    switchTab(settingsReturnTab);
  } else {
    settingsReturnTab = activeTab;
    switchTab("settings");
  }
});

try {
  el("about-version").textContent = `v${ext.runtime.getManifest().version}`;
} catch {
  // manifest unavailable; leave the version out
}

// ---- keyboard shortcuts ----
// Editable in-popup on Firefox (commands.update); Chrome only via its page.

const canEditShortcuts = typeof ext.commands?.update === "function";
let shortcutCapture = null; // cleanup fn of the active capture, if any

function comboFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.metaKey) mods.push("Command");
  if (e.shiftKey) mods.push("Shift");
  if (!mods.length) return null; // a plain key can't be a global shortcut
  // e.code = physical key; e.key breaks with Shift and non-US layouts.
  const code = e.code;
  let key = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(code)) key = code;
  else if (/^Arrow(Up|Down|Left|Right)$/.test(code)) key = code.slice(5);
  else if (
    ["Comma", "Period", "Space", "Home", "End", "PageUp", "PageDown", "Insert", "Delete"].includes(code)
  ) {
    key = code;
  }
  return key ? [...mods, key].join("+") : null;
}

function beginShortcutCapture(name, chip) {
  shortcutCapture?.();
  chip.classList.add("capturing");
  chip.textContent = "Press keys…";
  const onKey = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      cleanup();
      renderShortcuts();
      return;
    }
    // Bare Backspace/Delete clears; with modifiers they can be part of a combo.
    if ((e.key === "Backspace" || e.key === "Delete") && !e.ctrlKey && !e.altKey && !e.metaKey) {
      try {
        await ext.commands.update({ name, shortcut: "" });
      } catch {
        // some platforms refuse clearing; leave as-is
      }
      cleanup();
      renderShortcuts();
      return;
    }
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return; // wait for the real key
    const combo = comboFromEvent(e);
    if (combo) {
      try {
        await ext.commands.update({ name, shortcut: combo });
      } catch {
        showToast(`${combo} isn’t allowed as a shortcut. Try Ctrl/Alt (+Shift) + a key.`);
      }
    } else {
      showToast("Shortcuts need Ctrl, Alt or Command plus a regular key.");
    }
    cleanup();
    renderShortcuts();
  };
  const cleanup = () => {
    window.removeEventListener("keydown", onKey, true);
    shortcutCapture = null;
  };
  shortcutCapture = cleanup;
  window.addEventListener("keydown", onKey, true);
}

async function renderShortcuts() {
  const wrap = el("shortcut-rows");
  let commandList = [];
  try {
    commandList = await ext.commands.getAll();
  } catch {
    // commands API unavailable
  }
  // Rebuilding collapses the pane briefly - hold the scroll position.
  const pane = el("settings-pane");
  const scroll = pane.scrollTop;
  wrap.textContent = "";
  for (const command of commandList) {
    const row = document.createElement("div");
    row.className = "shortcut-row";
    const label = document.createElement("div");
    label.className = "shortcut-name";
    // Browsers add reserved commands (no description) on their own,
    // e.g. Chrome's _execute_action.
    label.textContent =
      command.name === "_execute_action" ? "Open the popup" : command.description || command.name;
    const chip = document.createElement("button");
    chip.className = "shortcut-chip";
    chip.textContent = command.shortcut || "Not set";
    if (canEditShortcuts) {
      chip.title = "Click, then press a combination. Backspace clears, Esc cancels.";
      chip.addEventListener("click", () => beginShortcutCapture(command.name, chip));
    } else {
      chip.disabled = true;
    }
    row.append(label, chip);
    wrap.append(row);
  }
  if (canEditShortcuts) {
    const reset = document.createElement("button");
    reset.className = "shortcut-manage";
    reset.textContent = "Reset shortcuts";
    reset.addEventListener("click", async () => {
      for (const command of commandList) {
        try {
          await ext.commands.reset(command.name);
        } catch {
          // leave that one as-is
        }
      }
      renderShortcuts();
    });
    wrap.append(reset);
  } else {
    // Chrome: rebinding only works on its own settings page.
    const note = document.createElement("button");
    note.className = "shortcut-manage";
    note.textContent = "Edit in browser shortcut settings";
    note.addEventListener("click", () => {
      ext.tabs.create({ url: "chrome://extensions/shortcuts" });
      window.close();
    });
    wrap.append(note);
  }
  pane.scrollTop = scroll;
}

// ---- autoplay toggle (mirrors YTM's queue-header switch) ----

let lastAutoplay = null; // null = YTM hasn't rendered its toggle

function updateAutoplayToggle(value) {
  lastAutoplay = typeof value === "boolean" ? value : null;
  const button = el("autoplay-toggle");
  button.hidden = lastAutoplay === null || activeTab !== "queue";
  button.classList.toggle("on", lastAutoplay === true);
  button.title = lastAutoplay ? "Autoplay is on" : "Autoplay is off";
}

el("autoplay-toggle").addEventListener("click", () => {
  send("toggleAutoplay");
  // Optimistic flip; the next queue push confirms.
  updateAutoplayToggle(!lastAutoplay);
});

// Live drag preview: the dragged row follows the pointer through the list.
// Autoplay rows are excluded - the real queue ends at the Autoplay header.
function dragRowAfter(container, y) {
  const rows = [...container.querySelectorAll(".qrow:not(.dragging):not(.automix)")];
  let closest = { offset: -Infinity, element: null };
  for (const child of rows) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
  }
  return closest.element;
}

el("queue-list").addEventListener("dragover", (e) => {
  const list = el("queue-list");
  const dragging = list.querySelector(".qrow.dragging");
  if (!dragging) return;
  e.preventDefault();
  const after = dragRowAfter(list, e.clientY);
  if (after === null) {
    // Past the last real row: land at the end of the real queue, never
    // inside the Autoplay section.
    const boundary = list.querySelector(".queue-subheader");
    if (boundary) list.insertBefore(dragging, boundary);
    else list.append(dragging);
  } else if (after !== dragging) {
    list.insertBefore(dragging, after);
  }
});

// ---- history ----
// Real YTM account history via the bridge; loaded once per popup, failed
// loads retry on the next tab open.

let historyLoaded = false;

function historyNote(text) {
  const list = el("history-list");
  list.textContent = "";
  const note = document.createElement("div");
  note.className = "list-note";
  note.textContent = text;
  list.append(note);
}

function requestHistory() {
  if (historyLoaded || !port) return;
  historyNote("Loading history…");
  port.postMessage({ type: "getHistory" });
}

function renderHistory(history) {
  historyLoaded = Boolean(history);
  if (!history) {
    historyNote("Couldn’t load history from YouTube Music.");
    return;
  }
  if (history.signedOut) {
    historyNote("Sign in to YouTube Music to see your history.");
    return;
  }
  if (!history.sections.length) {
    historyNote("No history yet. Songs you play will show up here.");
    return;
  }
  const list = el("history-list");
  list.textContent = "";
  // Period headers arrive with the data but stay unrendered - flat reads better.
  for (const section of history.sections) {
    for (const item of section.items) list.append(buildTrackRow(item));
  }
}

// Track row shared by the History, Search and Playlists tabs: click plays
// (with the item's own queue context), hover exposes Play next - plus
// Remove when the caller supplies onRemove (playlist detail only).
function buildTrackRow(item, { onRemove } = {}) {
  const row = document.createElement("div");
  row.className = "qrow";
  const thumb = document.createElement("div");
  thumb.className = "qthumb";
  if (item.thumb) thumb.style.backgroundImage = `url("${item.thumb}")`;
  const meta = document.createElement("div");
  meta.className = "qmeta";
  const title = document.createElement("div");
  title.className = "qtitle";
  title.textContent = item.title;
  const artist = document.createElement("div");
  artist.className = "qartist";
  artist.textContent = item.artist;
  meta.append(title, artist);
  const duration = document.createElement("div");
  duration.className = "qdur";
  duration.textContent = item.duration;
  row.append(thumb, meta, duration);
  if (item.videoId) {
    row.classList.add("has-actions");
    const actions = document.createElement("div");
    actions.className = "qactions";
    const button = document.createElement("button");
    button.title = "Play next";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-play-next");
    svg.append(use);
    button.append(svg);
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      send("queueVideoNext", { videoId: item.videoId });
      // Optimistic - the content script pushes an error toast if it fails.
      showToast("Song will play next", "success");
    });
    actions.append(button);
    if (onRemove) {
      // Destructive, so it takes two clicks: the first arms the button
      // (turns red), the second within 2.5s actually removes.
      const remove = document.createElement("button");
      remove.title = "Remove from playlist";
      const removeSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const removeUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
      removeUse.setAttribute("href", "#i-remove");
      removeSvg.append(removeUse);
      remove.append(removeSvg);
      let confirmTimer = null;
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!remove.classList.contains("confirm")) {
          remove.classList.add("confirm");
          remove.title = "Click again to remove";
          confirmTimer = setTimeout(() => {
            remove.classList.remove("confirm");
            remove.title = "Remove from playlist";
          }, 2500);
          return;
        }
        clearTimeout(confirmTimer);
        onRemove();
      });
      actions.append(remove);
    }
    row.append(actions);
    row.addEventListener("click", () => {
      send("playVideoById", {
        videoId: item.videoId,
        playlistId: item.playlistId,
        params: item.params,
      });
      armQueueSwitch(item.videoId);
    });
  }
  return row;
}

// ---- search (songs + videos, filtered server-side) ----

let searchTimer = null;

function searchNote(text) {
  const list = el("search-results");
  list.textContent = "";
  const note = document.createElement("div");
  note.className = "list-note";
  note.textContent = text;
  list.append(note);
}

function runSearch() {
  const query = el("search-input").value.trim();
  if (query.length < 2) {
    el("search-results").textContent = "";
    el("search-filters").hidden = true;
    searchResultsData = null;
    return;
  }
  if (!port) return;
  searchNote("Searching…");
  port.postMessage({ type: "search", query });
}

el("search-input").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 400);
});
el("search-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    clearTimeout(searchTimer);
    runSearch();
  }
});

let searchResultsData = null; // {songs, videos} of the current query
let searchGroup = "songs";

function renderSearchResults(msg) {
  // Only render the response matching what's in the box right now.
  if (msg.query !== el("search-input").value.trim()) return;
  searchResultsData = msg.results ?? null;
  if (!msg.results) {
    el("search-filters").hidden = true;
    searchNote("Search failed. Try again.");
    return;
  }
  if (!msg.results.songs.length && !msg.results.videos.length) {
    el("search-filters").hidden = true;
    searchNote("Nothing found.");
    return;
  }
  // If the selected group came back empty, hop to the one with results.
  if (!msg.results[searchGroup].length) {
    searchGroup = msg.results.songs.length ? "songs" : "videos";
  }
  showSearchGroup();
}

function showSearchGroup() {
  el("search-filters").hidden = false;
  for (const pill of document.querySelectorAll("#search-filters .pill")) {
    pill.classList.toggle("active", pill.dataset.group === searchGroup);
    pill.disabled = !searchResultsData?.[pill.dataset.group]?.length;
  }
  const list = el("search-results");
  list.textContent = "";
  for (const item of searchResultsData[searchGroup]) list.append(buildTrackRow(item));
  list.scrollTop = 0;
}

for (const pill of document.querySelectorAll("#search-filters .pill")) {
  pill.addEventListener("click", () => {
    searchGroup = pill.dataset.group;
    showSearchGroup();
  });
}

// ---- playlists ----
// Library list → drill into tracks; rows offer play-all and add-current-song.

let playlistsLoaded = false;
let playlistDetailId = null; // browseId the detail view shows (stale guard)
let playlistDetailTitle = ""; // for toasts about the open playlist

function noteInto(container, text) {
  container.textContent = "";
  const note = document.createElement("div");
  note.className = "list-note";
  note.textContent = text;
  container.append(note);
}

function requestPlaylists(silent = false) {
  if (!port) return;
  if (!silent) {
    if (playlistsLoaded) return;
    noteInto(el("playlists-list"), "Loading playlists…");
  }
  port.postMessage({ type: "getPlaylists" });
}

function renderPlaylists(playlists) {
  playlistsLoaded = Boolean(playlists);
  const list = el("playlists-list");
  if (!playlists) {
    noteInto(list, "Couldn’t load playlists from YouTube Music.");
    return;
  }
  if (playlists.signedOut) {
    noteInto(list, "Sign in to YouTube Music to see your playlists.");
    return;
  }
  if (!playlists.length) {
    noteInto(list, "No playlists in your library yet.");
    return;
  }
  list.textContent = "";
  for (const pl of playlists) {
    const row = document.createElement("div");
    row.className = "qrow has-actions";
    const thumb = document.createElement("div");
    thumb.className = "qthumb";
    if (pl.thumb) thumb.style.backgroundImage = `url("${pl.thumb}")`;
    const meta = document.createElement("div");
    meta.className = "qmeta";
    const title = document.createElement("div");
    title.className = "qtitle";
    title.textContent = pl.title;
    const subtitle = document.createElement("div");
    subtitle.className = "qartist";
    subtitle.textContent = pl.subtitle;
    meta.append(title, subtitle);
    row.append(thumb, meta);

    const actions = document.createElement("div");
    actions.className = "qactions";
    for (const [label, icon, handler] of [
      [
        "Shuffle",
        "#i-shuffle",
        () => {
          send("playPlaylist", { playlistId: pl.id, shuffle: true });
          armQueueSwitch(null); // playlistStarted or the fallback switches
        },
      ],
    ]) {
      const button = document.createElement("button");
      button.title = label;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", icon);
      svg.append(use);
      button.append(svg);
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        handler();
      });
      actions.append(button);
    }
    row.append(actions);

    // Visible drill-in zone; the row itself plays (play-first model).
    const open = document.createElement("button");
    open.className = "pl-open";
    open.title = "Open playlist";
    const chevSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const chevUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
    chevUse.setAttribute("href", "#i-chevron-right");
    chevSvg.append(chevUse);
    open.append(chevSvg);
    open.addEventListener("click", (e) => {
      e.stopPropagation();
      openPlaylist(pl);
    });
    row.append(open);

    row.addEventListener("click", () => {
      // Armed capture bar repurposes the click: file the song, don't play.
      if (captureArmed) {
        if (requireSignIn("save to playlists")) return;
        if (!lastState?.videoId) {
          showToast("Nothing is playing to add.");
          return;
        }
        port?.postMessage({
          type: "addToPlaylist",
          playlistId: pl.id,
          videoId: lastState.videoId,
          name: pl.title,
        });
        return; // stays armed - filing into several playlists in a row
      }
      send("playPlaylist", { playlistId: pl.id });
      armQueueSwitch(null); // playlistStarted or the fallback switches
    });
    list.append(row);
  }
}

// ---- capture bar: "save the playing song to a playlist" as a mode ----

let captureArmed = false;

function updateCaptureBar() {
  const bar = el("playlist-capture");
  const playing = lastState?.videoId && lastState?.title;
  // Capture targets playlist rows - hide alongside the list view.
  bar.hidden = !playing || lastState?.signedIn === false || Boolean(playlistDetailId);
  if (bar.hidden) captureArmed = false;
  bar.classList.toggle("armed", captureArmed);
  // Armed mode paints a plus badge on every playlist thumb.
  el("playlists-list").classList.toggle("capture-armed", captureArmed);
  if (bar.hidden) return;
  bar.querySelector("use").setAttribute("href", captureArmed ? "#i-x" : "#i-plus");
  bar.querySelector(".ctitle").textContent = captureArmed
    ? "Choose a playlist below"
    : "Save current song";
  // The song name truncates; the tail (artist / cancel hint) always shows.
  const song = bar.querySelector(".csub-main");
  const side = bar.querySelector(".csub-side");
  if (captureArmed) {
    song.textContent = "or click here to cancel";
    side.textContent = "";
  } else {
    song.textContent = lastState.title;
    side.textContent = lastState.artist ? ` - ${lastState.artist}` : "";
  }
  // Tooltips only where text actually truncates (same pattern as the player).
  song.title =
    !captureArmed && song.scrollWidth > song.clientWidth ? lastState.title : "";
  side.title = side.scrollWidth > side.clientWidth ? (lastState.artist ?? "") : "";
}

el("playlist-capture").addEventListener("click", () => {
  captureArmed = !captureArmed;
  updateCaptureBar();
});

let playlistsScrollTop = 0; // list position, restored after the back button

// Infinite scroll: one ~100-track page at a time. The sentinel rides at the
// list's tail whenever a continuation token remains; scrolling it near the
// viewport fetches the next page.
let playlistNextToken = null;
let playlistLoadingMore = false;

const playlistMore = document.createElement("div");
playlistMore.className = "list-note";
playlistMore.textContent = "Loading more…";

new IntersectionObserver(
  (entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    if (!playlistNextToken || playlistLoadingMore || !playlistDetailId) return;
    playlistLoadingMore = true;
    port?.postMessage({
      type: "getPlaylistTracks",
      browseId: playlistDetailId,
      continuation: playlistNextToken,
    });
  },
  { root: el("playlists-pane"), rootMargin: "200px" }
).observe(playlistMore);

function openPlaylist(pl) {
  playlistDetailId = pl.id;
  playlistDetailTitle = pl.title;
  playlistNextToken = null;
  playlistLoadingMore = false;
  playlistsScrollTop = el("playlists-pane").scrollTop;
  el("playlists-pane").scrollTop = 0;
  el("playlists-list").hidden = true;
  el("playlist-detail").hidden = false;
  el("playlist-title").textContent = pl.title;
  updateCaptureBar();
  noteInto(el("playlist-tracks"), "Loading tracks…");
  port?.postMessage({ type: "getPlaylistTracks", browseId: pl.id });
}

for (const [id, shuffle] of [
  ["playlist-play", false],
  ["playlist-shuffle", true],
]) {
  el(id).addEventListener("click", () => {
    if (!playlistDetailId) return;
    send("playPlaylist", { playlistId: playlistDetailId, shuffle });
    armQueueSwitch(null); // playlistStarted or the fallback switches
  });
}

function renderPlaylistTracks(msg) {
  if (msg.browseId !== playlistDetailId) return; // navigated away meanwhile
  const list = el("playlist-tracks");
  playlistLoadingMore = false;
  if (!msg.tracks) {
    // A failed continuation just stops paging; keep what's rendered.
    if (msg.append) playlistMore.remove();
    else noteInto(list, "Couldn’t load this playlist.");
    return;
  }
  if (!msg.append) {
    list.textContent = "";
    if (!msg.tracks.length && !msg.continuation) {
      noteInto(list, "This playlist is empty.");
      playlistNextToken = null;
      return;
    }
  } else {
    playlistMore.remove();
  }
  for (const item of msg.tracks) list.append(buildPlaylistTrackRow(item, msg.browseId));
  playlistNextToken = msg.continuation;
  if (playlistNextToken) list.append(playlistMore);
}

// Rows whose own YTM menu offers removal get the remove action; the
// endpoint is replayed verbatim, so rows without one (other people's
// playlists, Liked Music) never show the button.
function buildPlaylistTrackRow(item, browseId) {
  const removable = Boolean(item.removeEndpoint && item.setVideoId);
  const row = buildTrackRow(
    item,
    removable
      ? {
          onRemove: () =>
            port?.postMessage({
              type: "removeFromPlaylist",
              endpoint: item.removeEndpoint,
              playlistId: browseId,
              setVideoId: item.setVideoId,
              name: playlistDetailTitle,
            }),
        }
      : {}
  );
  if (removable) row.dataset.setVideoId = item.setVideoId;
  return row;
}

el("playlist-back").addEventListener("click", () => {
  playlistDetailId = null;
  el("playlist-detail").hidden = true;
  el("playlists-list").hidden = false;
  updateCaptureBar();
  el("playlists-pane").scrollTop = playlistsScrollTop;
});

// ---- lyrics (LRCLIB) ----
// Opt-in (sends title/artist to lrclib.net), official songs only.

const LYRICS_TYPES = new Set(["MUSIC_VIDEO_TYPE_ATV", "MUSIC_VIDEO_TYPE_OMV"]);

let lyricsEnabled = null; // null = not read from storage yet
let lyricsKey = null; // track the pane currently reflects
let lyricsRenderKey = null; // track renderLyrics last ran for (any outcome)
let lyricsLines = null; // [{t, text, el}] when synced lyrics are shown
let lyricsFetchId = 0;
let lyricsScrollHold = 0; // pause autoscroll until this timestamp

function lyricsEligible(state) {
  if (!state?.available || !state.title) return false;
  if (state.videoType) return LYRICS_TYPES.has(state.videoType);
  // Fallback heuristic: plain uploads/videos carry no album link.
  return Boolean(state.album);
}

function lyricsNote(text) {
  const pane = el("lyrics-pane");
  pane.textContent = "";
  const note = document.createElement("div");
  note.className = "list-note";
  note.textContent = text;
  pane.append(note);
  return note;
}

async function getLyricsEnabled() {
  if (lyricsEnabled === null) {
    try {
      lyricsEnabled = Boolean((await ext.storage.local.get("lyricsEnabled")).lyricsEnabled);
    } catch {
      lyricsEnabled = false;
    }
  }
  return lyricsEnabled;
}

function renderLyricsOptIn() {
  const pane = el("lyrics-pane");
  pane.textContent = "";
  const note = document.createElement("div");
  note.className = "list-note";
  note.textContent =
    "Lyrics are looked up on lrclib.net using the track’s title and artist.";
  const button = document.createElement("button");
  button.id = "lyrics-enable";
  button.textContent = "Enable lyrics";
  button.addEventListener("click", () => setLyricsEnabled(true));
  pane.append(note, button);
}

// One flag behind both the in-tab Enable button and the settings switch.
function setLyricsEnabled(value) {
  lyricsEnabled = value;
  el("set-lyrics").classList.toggle("on", value);
  updateLyricsTab();
  try {
    ext.storage.local.set({ lyricsEnabled: value });
  } catch {
    // session-only preference
  }
  lyricsKey = null; // force the pane to re-evaluate (fetch or opt-in prompt)
  if (!value && activeTab === "lyrics") switchTab("queue");
  else if (activeTab === "lyrics") renderLyrics();
}

// Lyrics off → the tab (and its size control) disappears entirely.
function updateLyricsTab() {
  document.querySelector('.tab[data-tab="lyrics"]').hidden = !lyricsEnabled;
  el("lyrics-size-row").hidden = !lyricsEnabled;
}

// LRC format: one or more [mm:ss.xx] stamps per line.
function parseLrc(text) {
  const lines = [];
  for (const raw of (text ?? "").split("\n")) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const content = raw.replace(/\[\d+:\d+(?:\.\d+)?\]/g, "").trim();
    if (!content) continue;
    for (const stamp of stamps) {
      lines.push({ t: Number(stamp[1]) * 60 + Number(stamp[2]), text: content });
    }
  }
  return lines.sort((a, b) => a.t - b.t);
}

function showLyricsEntry(entry) {
  const pane = el("lyrics-pane");
  pane.textContent = "";
  lyricsLines = null;
  if (entry.error) {
    lyricsNote("Couldn’t reach the lyrics service. It’ll retry on the next play.");
    return;
  }
  if (entry.instrumental) {
    lyricsNote("Instrumental track.");
    return;
  }
  if (entry.synced) {
    const lines = parseLrc(entry.synced);
    if (lines.length) {
      for (const line of lines) {
        const div = document.createElement("div");
        div.className = "lyr-line";
        div.textContent = line.text;
        div.addEventListener("click", () => send("seek", { position: line.t }));
        line.el = div;
        pane.append(div);
      }
      lyricsLines = lines;
      updateLyricsHighlight(lastState?.position ?? 0, true);
      return;
    }
  }
  if (entry.plain?.trim()) {
    const div = document.createElement("div");
    div.className = "lyr-plain";
    div.textContent = entry.plain.trim();
    pane.append(div);
    pane.scrollTop = 0;
    return;
  }
  lyricsNote("No lyrics found for this track.");
}

function updateLyricsHighlight(position, force = false) {
  if (!lyricsLines || el("lyrics-pane").hidden) return;
  // Closest stamp wins - source offsets err by half a gap instead of a full one.
  let current = -1;
  let best = Infinity;
  for (let i = 0; i < lyricsLines.length; i++) {
    const distance = Math.abs(lyricsLines[i].t - position);
    if (distance < best) {
      best = distance;
      current = i;
    }
  }
  lyricsLines.forEach((line, i) => line.el.classList.toggle("cur", i === current));
  if (current >= 0 && (force || Date.now() > lyricsScrollHold)) {
    lyricsLines[current].el.scrollIntoView({
      block: "center",
      behavior: force ? "auto" : "smooth",
    });
  }
}

// Manual scrolling pauses the autoscroll so it doesn't fight the user.
el("lyrics-pane").addEventListener("wheel", () => {
  lyricsScrollHold = Date.now() + 4000;
});

async function renderLyrics() {
  const state = lastState;
  // render() re-invokes only when this key changes, whatever the outcome.
  lyricsRenderKey =
    state?.available && state.title ? state.videoId || `${state.title}|${state.artist}` : null;
  if (!state?.available || !state.title) {
    lyricsKey = null;
    lyricsLines = null;
    lyricsNote("Nothing is playing.");
    return;
  }
  if (!lyricsEligible(state)) {
    lyricsKey = null;
    lyricsLines = null;
    lyricsNote("Lyrics are available for official songs only.");
    return;
  }
  if (!(await getLyricsEnabled())) {
    lyricsKey = null;
    lyricsLines = null;
    renderLyricsOptIn();
    return;
  }
  const key = state.videoId || `${state.title}|${state.artist}`;
  if (key === lyricsKey) return; // pane already reflects this track
  lyricsKey = key;
  lyricsNote("Looking up lyrics…");
  const fetchId = ++lyricsFetchId;
  // Background fetches+caches; the prefetch usually made this a cache hit.
  let entry = null;
  try {
    entry = await ext.runtime.sendMessage({
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
    entry = null;
  }
  if (fetchId !== lyricsFetchId) return; // a newer track superseded this fetch
  showLyricsEntry(entry ?? { synced: "", plain: "", instrumental: false });
}

// Jump to Queue once the picked song is confirmed playing AND a fresh queue
// push landed; 3s fallback covers ids that never echo.
let queueSwitchVideoId = null;
let queueSwitchLoaded = false;
let queueSwitchFallback = null;

function armQueueSwitch(videoId) {
  queueSwitchVideoId = videoId;
  queueSwitchLoaded = false;
  clearTimeout(queueSwitchFallback);
  queueSwitchFallback = setTimeout(doQueueSwitch, 3000);
}

function doQueueSwitch() {
  clearTimeout(queueSwitchFallback);
  queueSwitchFallback = null;
  queueSwitchVideoId = null;
  queueSwitchLoaded = false;
  switchTab("queue");
}

let activeTab = "queue";

function switchTab(name) {
  activeTab = name;
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === name);
  }
  el("queue-list").hidden = name !== "queue";
  el("history-list").hidden = name !== "history";
  el("lyrics-pane").hidden = name !== "lyrics";
  el("search-pane").hidden = name !== "search";
  el("playlists-pane").hidden = name !== "playlists";
  el("settings-pane").hidden = name !== "settings";
  el("settings-open").classList.toggle("active", name === "settings");
  el("autoplay-toggle").hidden = name !== "queue" || lastAutoplay === null;
  if (name === "history") requestHistory();
  if (name === "lyrics") renderLyrics();
  if (name === "search") el("search-input").focus();
  if (name === "playlists") requestPlaylists();
  if (name === "settings") renderShortcuts();
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
}

async function connect() {
  const tabs = await ext.tabs.query({ url: "https://music.youtube.com/*" });
  // Audible tabs first, discarded ones last (they have no content script),
  // most recently used within each group.
  const rank = (t) => (t.audible ? 0 : t.discarded ? 2 : 1);
  const candidates = tabs
    .slice()
    .sort((a, b) => rank(a) - rank(b) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  tryTab(candidates, 0);
}

function tryTab(candidates, index) {
  const tab = candidates[index];
  if (!tab) {
    showEmpty();
    return;
  }
  currentTabId = tab.id;
  try {
    port = ext.tabs.connect(tab.id, { name: "popup" });
  } catch {
    port = null;
    tryTab(candidates, index + 1);
    return;
  }
  let alive = false;
  port.onMessage.addListener((msg) => {
    alive = true;
    if (msg.type === "state") {
      if (queueSwitchVideoId && msg.state.available && msg.state.videoId === queueSwitchVideoId) {
        queueSwitchLoaded = true;
      }
      render(msg.state);
    } else if (msg.type === "queue") {
      // Autoplay state first - renderQueue keys the suggestions section on it.
      updateAutoplayToggle(msg.autoplay);
      renderQueue(msg.queue);
      if (queueSwitchLoaded && msg.queue.some((item) => item.selected)) doQueueSwitch();
    } else if (msg.type === "history") renderHistory(msg.history);
    else if (msg.type === "searchResults") renderSearchResults(msg);
    else if (msg.type === "playlists") renderPlaylists(msg.playlists);
    else if (msg.type === "playlistTracks") renderPlaylistTracks(msg);
    else if (msg.type === "playlistStarted") {
      // Only act while a playlist-play switch is armed (videoId-less).
      if (queueSwitchFallback && queueSwitchVideoId === null) {
        if (msg.ok) doQueueSwitch();
        else {
          clearTimeout(queueSwitchFallback);
          queueSwitchFallback = null;
          showToast("Couldn’t start that playlist.");
        }
      }
    }
    else if (msg.type === "addToPlaylistResult") {
      showToast(
        msg.result === "added"
          ? `Added to ${msg.name}`
          : msg.result === "duplicate"
            ? `Already in ${msg.name}`
            : "Couldn’t add to that playlist.",
        msg.result === "added" ? "success" : "notice"
      );
      if (msg.result === "added") {
        // Refresh so the list view's track counts match reality.
        requestPlaylists(true);
        // An open, fully loaded detail gets the new row appended in place -
        // a refetch would reset infinite scroll. Partially loaded lists pick
        // the song up when paging reaches the end anyway.
        if (playlistDetailId === msg.playlistId && !playlistNextToken && lastState?.videoId) {
          const list = el("playlist-tracks");
          list.querySelector(".list-note")?.remove(); // "empty playlist" note
          list.append(
            buildPlaylistTrackRow(
              {
                videoId: lastState.videoId,
                title: lastState.title,
                artist: lastState.artist,
                duration: formatTime(lastState.duration),
                thumb: lastState.artwork,
              },
              msg.playlistId
            )
          );
        }
      }
    }
    else if (msg.type === "removeFromPlaylistResult") {
      if (msg.ok) {
        showToast(`Removed from ${msg.name}`, "success");
        // Drop the row in place - a refetch would reset infinite scroll.
        if (playlistDetailId === msg.playlistId) {
          el("playlist-tracks")
            .querySelector(`[data-set-video-id="${msg.setVideoId}"]`)
            ?.remove();
        }
        requestPlaylists(true); // keep list track counts honest
      } else {
        showToast("Couldn’t remove that song.");
      }
    }
    else if (msg.type === "notice") showToast(msg.text);
  });
  port.postMessage({ type: "getQueue" });
  port.onDisconnect.addListener(() => {
    port = null;
    // A dead tab (no content script) drops the port before ever speaking -
    // fall through to the next candidate. A live one closing means retry all.
    if (alive) connect();
    else tryTab(candidates, index + 1);
  });
}

loadSettings();
connect();
refreshSleep();
