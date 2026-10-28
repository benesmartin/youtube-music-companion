// Popup UI. Connects to the content script in the YouTube Music tab over a
// long-lived port and re-renders whenever it pushes fresh state.

const ext = globalThis.browser ?? globalThis.chrome;

const el = (id) => document.getElementById(id);

// Strings live in _locales/<lang>/messages.json. The browser picks the
// catalog by its UI language; settings.language overrides that with one of
// LANGUAGES. The override is cached whole in localStorage because the
// data-i18n scan below runs synchronously at load and storage.local does
// not - loadSettings keeps the cache in step and reloads the popup once
// when it changes. Keys the override lacks fall through to the browser's
// pick, so a partial translation shows English gaps, never blanks.
const LANGUAGES = [
  ["system", ""], // label comes from the catalog; the rest are native names
  ["en", "English"],
  ["cs", "Čeština"],
];
let overrideCatalog = null;
try {
  overrideCatalog = JSON.parse(localStorage.getItem("i18n"));
} catch {
  // no cache, or storage unavailable - the browser's catalog it is
}

function getMessage(key, subs = []) {
  const entry = overrideCatalog?.messages?.[key];
  if (!entry) return ext.i18n.getMessage(key, subs);
  return entry.message.replace(/\$(\w+)\$/g, (_, name) => {
    const slot = entry.placeholders?.[name.toLowerCase()]?.content ?? "";
    return slot.replace(/\$(\d)/, (__, i) => subs[Number(i) - 1] ?? "");
  });
}

// A missing key returns the key itself so an untranslated spot reads as a
// leak, never as blank UI.
function t(key, ...subs) {
  return getMessage(key, subs.map(String)) || key;
}

// Plural pick: `${base}_one` / `_few` / `_many` / `_other` by the locale's
// CLDR category, falling back to `_other`. Chrome's catalog format has no
// plural support of its own, so the forms are separate keys. The rules follow
// the catalog on screen: a ja browser gets the en catalog, and ja's rules
// would pick "1 tracks". Folder names are Chrome's (pt_BR); Intl wants pt-BR
// and throws on anything it can't parse.
const catalogLang = String(overrideCatalog?.lang ?? t("locale")).replace(/_/g, "-");
const pluralRules = (() => {
  try {
    return new Intl.PluralRules(catalogLang);
  } catch {
    return new Intl.PluralRules("en");
  }
})();
function tn(base, count, ...subs) {
  const form = pluralRules.select(count);
  const key = `${base}_${form}`;
  return getMessage(key, [count, ...subs].map(String)) || t(`${base}_other`, count, ...subs);
}

// Screen readers pick their voice from lang.
document.documentElement.lang = catalogLang;

// Static markup: data-i18n fills textContent, data-i18n-title the title,
// data-i18n-placeholder the placeholder; data-i18n-args passes one
// substitution. Runs once, before anything reads the DOM.
for (const node of document.querySelectorAll("[data-i18n]")) {
  node.textContent = node.dataset.i18nArgs
    ? t(node.dataset.i18n, node.dataset.i18nArgs)
    : t(node.dataset.i18n);
}
for (const node of document.querySelectorAll("[data-i18n-title]")) node.title = t(node.dataset.i18nTitle);
for (const node of document.querySelectorAll("[data-i18n-placeholder]")) {
  node.placeholder = t(node.dataset.i18nPlaceholder);
}
// The tab strip's bold ghost (see .tab::after) needs the translated label.
for (const tab of document.querySelectorAll(".tab")) tab.dataset.label = tab.textContent;

// Whatever an ellipsis clipped shows whole on hover. One delegated listener
// rather than a title per element: rows are rebuilt on every queue push and
// only the hovered one needs measuring. The player card measures its own
// title and album on each state push, so those are not in the list.
const CLIPPED =
  ".tab, .qtitle, .qartist, .shortcut-name, #sleep-title, #sleep-remaining, " +
  "#album-title, #playlist-title, #album-artist, #album-meta";
document.addEventListener("pointerover", (e) => {
  const node = e.target.closest?.(CLIPPED);
  if (!node) return;
  node.title = node.scrollWidth > node.clientWidth ? node.textContent : "";
});

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
let adShowing = false;

// Tab connected but no track loaded (or an ad playing): placeholder header,
// dimmed transport, and the tabs stay usable - search or a playlist can
// start the music.
function renderIdle() {
  lastState = null;
  currentTrack = null;
  artistsSig = null;
  playerView.hidden = false;
  emptyView.hidden = true;
  playerView.classList.add("idle");
  setAccentHasTrack(false);
  el("title").textContent = t(adShowing ? "adPlaying" : "nothingPlaying");
  el("title").title = "";
  el("artist").textContent = t(adShowing ? "adPlayingSub" : "nothingPlayingSub");
  el("album").textContent = "";
  el("album-year").textContent = "";
  el("album").classList.remove("link");
  el("seek").value = 0;
  updateFill(el("seek"));
  el("position").textContent = "0:00";
  el("duration").textContent = "0:00";
  // Nothing from the previous track may survive: transport states, account
  // flags and the sheet's song tiles (reachable via the sleep chip).
  el("play-pause").classList.remove("playing");
  el("like").classList.remove("active", "gated");
  el("dislike").classList.remove("active", "gated");
  el("repeat").classList.remove("active", "one");
  el("library").classList.remove("in", "gated");
  el("library").disabled = true;
  el("library").title = "";
  el("library-label").textContent = t("addToLibrary");
  el("radio").disabled = true;
  el("copy-link").disabled = true;
  el("copy-info").disabled = true;
  updateCaptureBar();
}

// While a play is in flight the header already shows the TARGET's metadata
// (showPendingTrack); the tab keeps pushing the OUTGOING song's status for
// a couple of seconds, which used to read as "wrong song playing".
let pendingTrackHold = null; // { baseline: videoId playing at click time }
let pendingTrackTimer = null;

function showPendingTrack(item) {
  pendingTrackHold = { targetTitle: item.title ?? "" };
  clearTimeout(pendingTrackTimer);
  // Safety valve: never hold the header hostage if the play goes nowhere.
  // Sized to outlast the worst path (retries + full tab reload + reconnect)
  // - expiring mid-reload used to flash the "nothing playing" idle view.
  pendingTrackTimer = setTimeout(() => {
    pendingTrackHold = null;
  }, 12000);
  el("title").textContent = item.title;
  el("title").title = "";
  el("artist").textContent = item.artist ?? "";
  el("album").textContent = "";
  el("album-year").textContent = "";
  el("position").textContent = "0:00";
  el("duration").textContent = item.duration || "0:00";
  el("seek").value = 0;
  updateFill(el("seek"));
  if (item.thumb) el("artwork").src = item.thumb;
}

function render(state) {
  // Release only when the pushed title matches the TARGET. Nothing weaker
  // works: the videoId flips before the bar does (half-applied navigation
  // pairs the new id with the old title), and the old title isn't stable
  // either (the bar hops between renditions - "Radio Edit"/"Official
  // Video" - of the outgoing song). Substring both ways covers the
  // target's own rendition suffixes; the timeout is the safety valve.
  if (pendingTrackHold) {
    const target = pendingTrackHold.targetTitle;
    const matches =
      state.available &&
      state.title &&
      target &&
      (state.title.includes(target) || target.includes(state.title));
    if (matches) {
      pendingTrackHold = null;
      clearTimeout(pendingTrackTimer);
      // The queue tab sat on "Loading…" during the hold - repaint now
      // instead of waiting out the push throttle.
      port?.postMessage({ type: "getQueue" });
    } else {
      return;
    }
  }
  if (!state.available) {
    adShowing = Boolean(state.ad);
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
  setAccentHasTrack(true);

  // A track change invalidates an in-flight seek drag.
  const track = `${state.title}|${state.artist}`;
  if (track !== currentTrack) {
    currentTrack = track;
    seeking = false;
    // The new play lands in account history - drop the cache so the next
    // History visit refetches (or right away if it's the open tab).
    historyLoaded = false;
    if (activeTab === "history") requestHistory();
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
  el("library-label").textContent = t(state.inLibrary === true ? "inLibrary" : "addToLibrary");
  el("library").title = state.inLibrary === true ? t("removeFromLibrary") : "";
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
  setAccentHasTrack(false);
}

function setAccentHasTrack(has) {
  if (accentHasTrack === has) return;
  accentHasTrack = has;
  if (settings.accent === "auto") applySettings();
}

function send(command, payload = {}) {
  port?.postMessage({ type: "command", command, payload });
}

// Signed-out sessions: account actions stay clickable but explain themselves
// instead of silently opening a sign-in dialog in the hidden tab.
function requireSignIn(key) {
  if (lastState?.signedIn === false) {
    showToast(t(key));
    return true;
  }
  return false;
}

el("play-pause").addEventListener("click", () => send("playPause"));
el("next").addEventListener("click", () => send("next"));
el("previous").addEventListener("click", () => send("previous"));
el("like").addEventListener("click", () => {
  if (requireSignIn("signInLike")) return;
  send("toggleLike");
});
el("dislike").addEventListener("click", () => {
  if (requireSignIn("signInRate")) return;
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
  // The import panel never survives a close - reopening to a stale paste
  // would look like it had queued nothing.
  el("sheet-import").hidden = true;
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
  if (requireSignIn("signInLibrary")) return;
  send("toggleLibrary");
});

async function copyToClipboard(button, text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    showToast(t("copyFailed"));
    return;
  }
  button.classList.add("copied");
  setTimeout(() => button.classList.remove("copied"), 1200);
}

el("copy-link").addEventListener("click", () => {
  if (lastState?.videoId) copyToClipboard(el("copy-link"), `${YTM_BASE}watch?v=${lastState.videoId}`);
});

el("copy-info").addEventListener("click", () => {
  if (lastState?.title) copyToClipboard(el("copy-info"), `${lastState.artist} - ${lastState.title}`);
});

// ---- queue backup ----
// Copy writes a format that reads as a tracklist and imports as one: a "#"
// header line, then one line per track, tab-separated so it also pastes into
// a spreadsheet. Only the watch URL is load-bearing - the name is there for
// the human, and the import ignores it. Automix suggestions are YTM's, not
// the user's queue, and a row without an id would import as nothing.
let lastQueue = [];

el("copy-queue").addEventListener("click", () => {
  const own = lastQueue.filter((item) => !item.automix);
  if (!own.length) {
    showToast(t("copyQueueEmpty"));
    return;
  }
  const linked = own.filter((item) => item.videoId);
  if (!linked.length) {
    showToast(t("copyQueueNoLinks"));
    return;
  }
  const lines = linked.map((item) => {
    const name = [item.title, item.artist].filter(Boolean).join(" - ");
    return `${name}\t${YTM_BASE}watch?v=${item.videoId}`;
  });
  const stamp = new Date().toISOString().slice(0, 10);
  const header = tn("copyQueueHeader", lines.length, stamp);
  copyToClipboard(el("copy-queue"), [header, ...lines].join("\n"));
});

// Deliberately tolerant: pull every watch or youtu.be id out of whatever was
// pasted, in order, and ignore the rest. That way a queue survives a chat app
// eating the tabs, a partial copy, hand-edited lines, or a plain list of
// YouTube links - and the pretty half of the format costs the parser nothing. "# " opens a
// comment line (the header, or a URL commented out) unless a title comes
// before its watch URL, so "# Hashtag" and a bare "#1 Crush" are titles and
// stay.
function videoIdsFromText(text) {
  const ids = [];
  for (const line of text.split("\n")) {
    const fromUrl = line.match(/(?:[?&]v=|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/);
    const urlStart = fromUrl ? line.slice(0, fromUrl.index).search(/\S*$/) : -1;
    const titled = fromUrl && line.slice(2, urlStart).trim() !== "";
    if (line.startsWith("# ") && !titled) continue;
    // A bare id on its own line is the other thing people paste.
    const bare = line.trim().match(/^([A-Za-z0-9_-]{11})$/);
    const id = fromUrl?.[1] ?? bare?.[1];
    if (id) ids.push(id);
  }
  return ids;
}

let importIds = [];
// Importing REPLACES the queue, so the button arms before it fires. An inline
// two-step, not window.confirm - a dialog over an extension popup can dismiss
// the popup out from under itself.
let importArmed = false;

function refreshImportCount() {
  importIds = videoIdsFromText(el("import-text").value);
  const n = importIds.length;
  el("import-count").textContent = importArmed
    ? t("importClears")
    : n
      ? tn("importFound", n)
      : t("importNothing");
  // The "?" is what makes the armed state read as a different button rather
  // than the same one with a number in it.
  el("import-add").textContent = importArmed ? t("importReplaceCount", n) : t("importReplace");
  el("import-add").disabled = !n;
}

function disarmImport() {
  importArmed = false;
  refreshImportCount();
}

function toggleImport(open) {
  const panel = el("sheet-import");
  const show = open ?? panel.hidden;
  panel.hidden = !show;
  if (show) {
    el("import-text").value = "";
    disarmImport();
    el("import-text").focus();
  }
  placeToast(); // the sheet just changed height
}

el("import-queue").addEventListener("click", () => toggleImport());
el("import-cancel").addEventListener("click", () => toggleImport(false));
// Editing the paste after arming re-opens the question.
el("import-text").addEventListener("input", disarmImport);

el("import-add").addEventListener("click", () => {
  if (!importIds.length) return;
  if (!importArmed) {
    importArmed = true;
    refreshImportCount();
    return;
  }
  send("queueImport", { videoIds: importIds });
  showToast(t("importReplacing", importIds.length), "success");
  toggleImport(false);
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
    ? t("sleepPausingIn", formatTime(seconds))
    : t("sleepNone");
  // The chip keeps a running timer visible without opening the sheet.
  el("sleep-chip").hidden = !alarm;
  el("sleep-chip-min").textContent = alarm ? formatTime(seconds) : "";
}

// Live countdown while the popup sits open.
refreshSleep();
setInterval(refreshSleep, 1000);

const SLEEP_MAX_MINUTES = 720;

function armSleep(minutes) {
  if (!Number.isFinite(minutes) || minutes < 1) {
    showToast(t("sleepRange", SLEEP_MAX_MINUTES));
    return;
  }
  const clamped = Math.min(SLEEP_MAX_MINUTES, Math.round(minutes));
  ext.alarms.create("sleep-timer", { delayInMinutes: clamped });
  el("sleep-remaining").textContent = t("sleepPausingIn", formatTime(clamped * 60));
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
  el("sleep-remaining").textContent = t("sleepNone");
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

// The album opens INSIDE the popup - being thrown into the tab to see what
// else is on the record was the exact trip this extension exists to save.
// The header's open-in-YTM button still takes the old path.
el("album").addEventListener("click", () => {
  if (!lastState?.albumUrl) return;
  openAlbum(lastState.albumUrl, lastState.album ?? "");
});
el("artwork").addEventListener("click", focusYtmTab);
el("artwork-idle").addEventListener("click", focusYtmTab);

// ---- queue ----

let lastSelectedIndex = null;

// There is no honest way to promise autoplay suggestions. Whether any are
// coming depends on state YTM does not expose: a restored queue gets automix
// only near its end, and a mix ("Playing from X mix") refills the queue
// itself and never grows an Autoplay section at all. Two rounds of trying to
// infer it produced a note that hung on screen (reported 2026-08-18), so the
// Autoplay header now appears only when real rows exist, and the toggle's
// own busy state is the feedback for switching it on.

// Ratings the tab reported since this popup opened win over a row's fetched
// data: cached panes (home, history) can hold an older rating.
const ratingOverrides = new Map();
// A row's thumbs rate what YTM's own thumb on that row rates. In Liked Music
// that can be a liked music video, listed under its song's id.
const ratedId = (item) => item.ratedId ?? item.videoId;
const rowRating = (item) => ratingOverrides.get(ratedId(item)) ?? item.rating ?? null;

function setRowRating(videoId, status) {
  ratingOverrides.set(videoId, status);
  const selector = `.qrow[data-rated-id="${CSS.escape(videoId)}"]`;
  for (const button of document.querySelectorAll(`${selector} button.rate`)) {
    button.classList.toggle("rated", button.dataset.rating === status);
  }
  if (playlistDetailId === LIKED_MUSIC_ID) {
    for (const row of el("playlist-tracks").querySelectorAll(selector)) {
      row.classList.toggle("unliked", status !== "LIKE");
    }
  }
}

// Outlined until set, filled once set, like the player card's own pair.
// An unlit press sets the rating, a lit one clears it - an unknown rating
// (search rows, a queue row's hidden dislike) reads as unlit, and setting it
// again is harmless. Always built: body.hide-like / hide-dislike hide them, so
// the settings switches reach rows already drawn.
function appendRateButtons(actions, item) {
  for (const [key, icon, rating] of [
    ["like", "#i-thumb-up", "LIKE"],
    ["dislike", "#i-thumb-down", "DISLIKE"],
  ]) {
    const button = document.createElement("button");
    button.className = "rate";
    button.title = t(key);
    button.dataset.rating = rating;
    button.classList.toggle("rated", rowRating(item) === rating);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", icon);
    svg.append(use);
    button.append(svg);
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      if (requireSignIn("signInRate")) return;
      const previous = rowRating(item) ?? "INDIFFERENT";
      const next = previous === rating ? "INDIFFERENT" : rating;
      setRowRating(ratedId(item), next);
      send("rateVideo", {
        videoId: ratedId(item),
        rating: next,
        previous,
        exact: ratedId(item) !== item.videoId,
      });
    });
    actions.append(button);
  }
}

function renderQueue(queue) {
  const list = el("queue-list");
  // A push mid-drag would destroy the dragged row; the post-drop push repaints.
  if (list.querySelector(".qrow.dragging")) return;
  // While a play settles, the old queue is dead data - pushes during the
  // transition would paint it (or an empty flash) with the wrong highlight.
  if (pendingTrackHold) {
    list.classList.remove("loading-suggestions");
    list.textContent = "";
    const note = document.createElement("div");
    note.id = "queue-note";
    note.textContent = t("loading");
    list.append(note);
    lastSelectedIndex = null;
    return;
  }
  list.textContent = "";
  if (!queue.length) {
    list.classList.remove("loading-suggestions");
    const note = document.createElement("div");
    note.id = "queue-note";
    // A pending play means the queue is rebuilding, not gone. Idle: the
    // radio hint would point at a disabled menu.
    note.textContent = queueSwitchFallback
      ? t("loading")
      : playerView.classList.contains("idle")
        ? t("queueEmpty")
        : t("queueEmptyHint");
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
      header.textContent = t("autoplay");
      list.append(header);
    }
    const row = document.createElement("div");
    row.className = item.selected ? "qrow now" : "qrow";
    if (item.automix) row.classList.add("automix");
    // Present once the store aligns; the e2e specs key on it.
    if (item.videoId) row.dataset.videoId = item.videoId;
    if (item.videoId) row.dataset.ratedId = ratedId(item);
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
      if (item.videoId) appendRateButtons(actions, item);
      for (const [title, icon, command, toast, setting] of [
        [t("playNext"), "#i-play-next", "queuePlayNext", t("rowWillPlayNext"), "rowPlayNext"],
        [t("addToQueue"), "#i-add-to-queue", "queueAddToQueue", t("rowAddedToQueue"), "rowAddToQueue"],
        // Remove has no toggle: without it a queue row loses its only way out.
        [t("removeFromQueue"), "#i-remove", "queueRemove", null, null],
      ]) {
        if (setting && settings[setting] === false) continue;
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
          // Removal shows itself; the others toast YTM's own wording.
          if (toast) showToast(toast, "success");
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
      if (dragRefused || row.classList.contains("loading")) return;
      // The playing row has nowhere to jump: the tab ignores it, and nothing
      // would clear a spinner until the next queue push.
      if (item.selected) return;
      // Spinner only - queue jumps keep the queue, so no header hold; the
      // next push repaints the rows (and with them the marker) anyway.
      setPendingPlay(row, "loading");
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

  list.classList.remove("loading-suggestions");

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
  showLike: true,
  showDislike: true,
  compact: false,
  accentIcon: false,
  lyricsSize: "m",
  // Row actions, independent of the player card's own like/dislike toggles.
  rowPlayNext: true,
  rowAddToQueue: true,
  rowRadio: true,
  tabOrder: ["queue", "history", "lyrics", "search", "playlists", "home"],
  hiddenTabs: [],
  defaultTab: "queue",
  language: "system", // "system" or a LANGUAGES code
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

// ---- dynamic accent (the "auto" swatch) ----
// The content script extracts the color (Vibrant-style, ThemeSong parity)
// on every track change and memos {url, pick: [h,s]} to storage - the tab
// sees tracks even while the popup is closed, and the background tints the
// toolbar icon from the same memo. Only hue+sat travel; lightness is
// imposed per theme here so contrast never depends on the art.
let autoAccent = null; // [h, s] from the content script's memo
// The memo outlives the song: it is still there after the tab closes or goes
// idle. "Auto" means the colour of what is playing, so with nothing playing
// the popup wears its own red, not the ghost of the last track.
let accentHasTrack = true; // optimistic until the first verdict, for an instant paint

// Follow the memo live while the popup is open.
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.autoAccentMemo) return;
  const pick = changes.autoAccentMemo.newValue?.pick;
  autoAccent = Array.isArray(pick) ? pick : null;
  if (settings.accent === "auto") applySettings();
});

function hslToHex(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

const systemLightQuery = window.matchMedia("(prefers-color-scheme: light)");

function applySettings() {
  const light =
    settings.theme === "light" || (settings.theme === "system" && systemLightQuery.matches);
  const auto = settings.accent === "auto";
  const accent = ACCENTS.find((a) => a.name === settings.accent) ?? ACCENTS[0];
  document.body.classList.toggle("light", light);
  let accentHex = light ? accent.light : accent.dark;
  if (auto && autoAccent && accentHasTrack) {
    // Impose the palette's character: bright on dark, deep on light.
    const [h, s] = autoAccent;
    accentHex = light
      ? hslToHex(h, Math.min(Math.max(s, 0.5), 0.75), 0.42)
      : hslToHex(h, Math.min(Math.max(s, 0.6), 0.95), 0.62);
  }
  document.documentElement.style.setProperty("--accent", accentHex);
  for (const option of document.querySelectorAll("#theme-options .theme-opt")) {
    option.classList.toggle("active", option.dataset.theme === settings.theme);
  }

  for (const option of document.querySelectorAll("#language-options .theme-opt")) {
    option.classList.toggle("active", option.dataset.language === settings.language);
  }
  for (const swatch of document.querySelectorAll(".accent-swatch")) {
    const def = ACCENTS.find((a) => a.name === swatch.dataset.accent);
    // Swatches preview the variant the current theme would actually use.
    if (def) swatch.style.background = light ? def.light : def.dark;
    swatch.classList.toggle("active", swatch.dataset.accent === (auto ? "auto" : accent.name));
  }
  el("set-status-dot").classList.toggle("on", settings.statusDot !== false);
  document.body.classList.toggle("compact", settings.compact === true);
  el("compact-toggle").title = t(settings.compact === true ? "expand" : "compactMode");
  el("set-like").classList.toggle("on", settings.showLike !== false);
  el("like").hidden = settings.showLike === false;
  document.body.classList.toggle("hide-like", settings.showLike === false);
  el("set-dislike").classList.toggle("on", settings.showDislike !== false);
  el("dislike").hidden = settings.showDislike === false;
  document.body.classList.toggle("hide-dislike", settings.showDislike === false);
  el("set-accent-icon").classList.toggle("on", settings.accentIcon === true);
  el("set-row-play-next").classList.toggle("on", settings.rowPlayNext !== false);
  el("set-row-add").classList.toggle("on", settings.rowAddToQueue !== false);
  // The bar buttons are the whole-release version of the row actions, so the
  // same two switches govern both. Static DOM, unlike the rows - hiding them
  // here is what makes the toggle take effect without a repaint.
  for (const prefix of ["album", "playlist"]) {
    el(`${prefix}-next`).hidden = settings.rowPlayNext === false;
    el(`${prefix}-queue`).hidden = settings.rowAddToQueue === false;
  }
  el("set-row-radio").classList.toggle("on", settings.rowRadio !== false);
  applyTabOrder();
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
  if (settings.accent === "auto") {
    try {
      // The content script keeps the memo fresh on every track change, so
      // this is current, not just optimistic.
      const memo = (await ext.storage.local.get("autoAccentMemo")).autoAccentMemo;
      autoAccent = Array.isArray(memo?.pick) ? memo.pick : null;
    } catch {
      // the memo listener fills it in
    }
  }
  try {
    lyricsEnabled = Boolean((await ext.storage.local.get("lyricsEnabled")).lyricsEnabled);
  } catch {
    lyricsEnabled = false;
  }
  el("set-lyrics").classList.toggle("on", lyricsEnabled);
  applySettings();
  updateLyricsTab();
  // The markup starts on Queue; open on the chosen tab instead. Only from
  // the untouched start - a click that already landed wins.
  if (activeTab === "queue" && homeTab() !== "queue") switchTab(homeTab());
  // Cache out of step with the setting (first open after a change made
  // elsewhere, or a cleared cache) or with the installed version (an update
  // reworded or added strings): rebuild it and start over, once.
  const cacheStale =
    (overrideCatalog?.lang ?? "system") !== settings.language ||
    (overrideCatalog && overrideCatalog.version !== ext.runtime.getManifest().version);
  if (cacheStale) applyLanguage(settings.language);
  try {
    if (sessionStorage.getItem("reopenSettings")) {
      sessionStorage.removeItem("reopenSettings");
      settingsReturnTab = activeTab;
      switchTab("settings");
    }
  } catch {
    // session storage unavailable - open normally
  }
}

// ---- language ----
// Writes the chosen catalog to the cache and reloads the popup so every
// string, static and dynamic, comes up in the new language at once. At most
// one reload per session: a cache that cannot be written must not loop.
async function applyLanguage(code) {
  try {
    if (sessionStorage.getItem("i18nReloaded")) return;
    if (code === "system") {
      localStorage.removeItem("i18n");
    } else {
      const response = await fetch(ext.runtime.getURL(`_locales/${code}/messages.json`));
      const messages = await response.json();
      const version = ext.runtime.getManifest().version;
      localStorage.setItem("i18n", JSON.stringify({ lang: code, version, messages }));
    }
    sessionStorage.setItem("i18nReloaded", "1");
  } catch {
    return; // keep what is showing; the next open tries again
  }
  location.reload();
}

for (const [code, native] of LANGUAGES) {
  const option = document.createElement("button");
  option.className = "theme-opt";
  option.dataset.language = code;
  option.textContent = code === "system" ? t("languageBrowser") : native;
  option.addEventListener("click", () => {
    if (settings.language === code) return;
    settings.language = code;
    saveSettings();
    try {
      sessionStorage.removeItem("i18nReloaded");
      sessionStorage.setItem("reopenSettings", "1");
    } catch {
      // the popup comes back on the starting tab instead
    }
    applyLanguage(code);
  });
  el("language-options").append(option);
}

// ---- tab order, hidden tabs, default tab ----
// Order is an array of tab ids; the strip is re-sorted in place, so the tabs
// keep their listeners. Hidden ids are a second array; lyrics is hidden by
// its own opt-in as well. The default tab is whichever opens with the popup.
const TAB_IDS = DEFAULT_SETTINGS.tabOrder;

// Pure: unknown ids and repeats drop out, tabs missing from a stored order
// (a future tab, a hand-edited value) go to the end in default order.
function normalizeTabOrder(order) {
  const known = Array.isArray(order)
    ? order.filter((id, i) => TAB_IDS.includes(id) && order.indexOf(id) === i)
    : [];
  return [...known, ...TAB_IDS.filter((id) => !known.includes(id))];
}

function tabVisible(id) {
  if (id === "lyrics" && !lyricsEnabled) return false;
  return !settings.hiddenTabs.includes(id);
}

function visibleTabs() {
  return settings.tabOrder.filter(tabVisible);
}

// The tab the popup opens with, and the fallback whenever a tab goes away
// under the user: the chosen default if it is visible, else the first one.
function homeTab() {
  const visible = visibleTabs();
  return visible.includes(settings.defaultTab) ? settings.defaultTab : (visible[0] ?? "queue");
}

function applyTabOrder() {
  settings.tabOrder = normalizeTabOrder(settings.tabOrder);
  if (!Array.isArray(settings.hiddenTabs)) settings.hiddenTabs = [];
  const strip = el("tabs");
  for (const id of settings.tabOrder) {
    const tab = strip.querySelector(`.tab[data-tab="${id}"]`);
    tab.hidden = !tabVisible(id);
    strip.insertBefore(tab, el("autoplay-toggle"));
  }
}

function setTabOrder(order) {
  settings.tabOrder = normalizeTabOrder(order);
  saveSettings();
  renderTabOrder();
}

function setTabHidden(id, hidden) {
  const hiddenTabs = settings.hiddenTabs.filter((other) => other !== id);
  if (hidden) hiddenTabs.push(id);
  settings.hiddenTabs = hiddenTabs;
  // Hiding the default hands the role to the first visible tab, visibly, so
  // the dot never sits on a row that is switched off.
  if (hidden && settings.defaultTab === id) settings.defaultTab = homeTab();
  saveSettings();
  renderTabOrder();
}

function setDefaultTab(id) {
  settings.defaultTab = id;
  saveSettings();
  renderTabOrder();
}

function renderTabOrder() {
  const wrap = el("tab-order");
  wrap.textContent = "";
  const order = settings.tabOrder;
  order.forEach((id, index) => {
    const row = document.createElement("div");
    row.className = "tab-order-row";
    row.draggable = true;
    row.dataset.tab = id;
    const grip = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    grip.setAttribute("class", "grip");
    const gripUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
    gripUse.setAttribute("href", "#i-grip");
    grip.append(gripUse);
    const visible = tabVisible(id);
    const isHome = visible && homeTab() === id;
    // Same shape as every other setting row: white name, dim sub. The sub
    // only exists on the starting tab, so it explains the dot right where
    // the dot is, and moves with it.
    const text = document.createElement("div");
    text.className = "setting-text";
    const name = document.createElement("div");
    name.className = "setting-name";
    name.textContent = document.querySelector(`.tab[data-tab="${id}"]`).textContent;
    text.append(name);
    if (isHome) {
      const sub = document.createElement("div");
      sub.className = "setting-sub";
      sub.textContent = t("tabStartingSub");
      text.append(sub);
    }
    row.append(grip, text);
    row.classList.toggle("off", !visible);
    const pick = document.createElement("button");
    pick.className = "pick";
    pick.classList.toggle("on", isHome);
    pick.title = t("tabSetStarting");
    pick.disabled = !visible;
    const pickSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const pickUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
    pickUse.setAttribute("href", isHome ? "#i-radio-on" : "#i-radio-off");
    pickSvg.append(pickUse);
    pick.append(pickSvg);
    pick.addEventListener("click", () => setDefaultTab(id));
    const show = document.createElement("button");
    show.className = "switch";
    show.setAttribute("role", "switch");
    show.classList.toggle("on", visible);
    show.title = t("tabShow");
    // The last visible tab stays; lyrics is governed by its own opt-in.
    show.disabled = (visible && visibleTabs().length === 1) || (id === "lyrics" && !lyricsEnabled);
    show.addEventListener("click", () => setTabHidden(id, visible));
    row.append(pick, show);
    for (const [icon, delta, title] of [
      ["#i-chevron-up", -1, t("moveUp")],
      ["#i-chevron-down", 1, t("moveDown")],
    ]) {
      const button = document.createElement("button");
      button.className = "move";
      button.title = title;
      button.disabled = index + delta < 0 || index + delta >= order.length;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", icon);
      svg.append(use);
      button.append(svg);
      button.addEventListener("click", () => {
        const next = [...order];
        next.splice(index, 1);
        next.splice(index + delta, 0, id);
        setTabOrder(next);
      });
      row.append(button);
    }
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", ""); // Firefox needs data to drag
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      const next = [...wrap.querySelectorAll(".tab-order-row")].map((r) => r.dataset.tab);
      if (next.join() !== order.join()) setTabOrder(next);
      else renderTabOrder();
    });
    wrap.append(row);
  });
  const untouched =
    order.join() === TAB_IDS.join() &&
    !settings.hiddenTabs.length &&
    settings.defaultTab === DEFAULT_SETTINGS.defaultTab;
  if (!untouched) {
    const reset = document.createElement("button");
    reset.className = "settings-manage";
    reset.textContent = t("tabsReset");
    reset.addEventListener("click", () => {
      settings.hiddenTabs = [];
      settings.defaultTab = DEFAULT_SETTINGS.defaultTab;
      setTabOrder(TAB_IDS);
    });
    wrap.append(reset);
  }
}

el("tab-order").addEventListener("dragover", (e) => {
  const wrap = el("tab-order");
  const dragging = wrap.querySelector(".tab-order-row.dragging");
  if (!dragging) return;
  e.preventDefault();
  const after = dragRowAfter(wrap, e.clientY, ".tab-order-row:not(.dragging)");
  if (after === null) wrap.insertBefore(dragging, wrap.querySelector(".settings-manage"));
  else if (after !== dragging) wrap.insertBefore(dragging, after);
});

for (const def of [...ACCENTS, { name: "auto" }]) {
  const swatch = document.createElement("button");
  swatch.className = "accent-swatch";
  swatch.dataset.accent = def.name;
  swatch.title = t(`accent${def.name[0].toUpperCase()}${def.name.slice(1)}`);
  swatch.addEventListener("click", () => {
    settings.accent = def.name;
    // "auto": the settings write wakes the content script, which extracts
    // the current art and memos it back - the memo listener recolors us.
    saveSettings();
  });
  el("accent-options").append(swatch);
}

for (const option of document.querySelectorAll("#theme-options .theme-opt")) {
  option.addEventListener("click", () => {
    settings.theme = option.dataset.theme;
    saveSettings();
  });
}

el("set-status-dot").addEventListener("click", () => {
  settings.statusDot = settings.statusDot === false;
  saveSettings();
});

el("compact-toggle").addEventListener("click", () => {
  settings.compact = settings.compact !== true;
  saveSettings();
});

el("set-like").addEventListener("click", () => {
  settings.showLike = settings.showLike === false;
  saveSettings();
});

el("set-dislike").addEventListener("click", () => {
  settings.showDislike = settings.showDislike === false;
  saveSettings();
});

// Row actions. Rows are built once per render, so repaint what's on screen
// and make the lazy tabs rebuild on their next visit - otherwise the toggle
// looks like it did nothing until you navigate.
for (const [id, key] of [
  ["set-row-play-next", "rowPlayNext"],
  ["set-row-add", "rowAddToQueue"],
  ["set-row-radio", "rowRadio"],
]) {
  el(id).addEventListener("click", () => {
    settings[key] = settings[key] === false;
    saveSettings();
    port?.postMessage({ type: "getQueue" }); // repaints the queue rows
    if (searchResultsData) showSearchGroup();
    historyLoaded = false;
    homeLoaded = false;
    playlistsLoaded = false;
  });
}

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
    // The remembered tab may have been disabled meanwhile (lyrics opt-out).
    const chip = document.querySelector(`.tab[data-tab="${settingsReturnTab}"]`);
    switchTab(chip && !chip.hidden ? settingsReturnTab : homeTab());
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
  chip.textContent = t("shortcutPressKeys");
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
        showToast(t("shortcutNotAllowed", combo));
      }
    } else {
      showToast(t("shortcutNeedsModifier"));
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

const COMMAND_KEYS = {
  "play-pause": "cmdPlayPause",
  "next-track": "cmdNext",
  "previous-track": "cmdPrevious",
  "toggle-like": "cmdLike",
  "toggle-dislike": "cmdDislike",
  "volume-up": "cmdVolumeUp",
  "volume-down": "cmdVolumeDown",
};

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
    // Descriptions arrive in the BROWSER's language; a language override
    // has to re-translate them by command name.
    label.textContent =
      command.name === "_execute_action"
        ? t("shortcutOpenPopup")
        : getMessage(COMMAND_KEYS[command.name] ?? "") || command.description || command.name;
    const chip = document.createElement("button");
    chip.className = "shortcut-chip";
    chip.textContent = command.shortcut || t("shortcutNotSet");
    if (canEditShortcuts) {
      chip.title = t("shortcutChipHint");
      chip.addEventListener("click", () => beginShortcutCapture(command.name, chip));
    } else {
      chip.disabled = true;
    }
    row.append(label, chip);
    wrap.append(row);
  }
  if (canEditShortcuts) {
    const reset = document.createElement("button");
    reset.className = "settings-manage";
    reset.textContent = t("shortcutReset");
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
    note.className = "settings-manage";
    note.textContent = t("shortcutEditInBrowser");
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
  button.title = t(lastAutoplay ? "autoplayOn" : "autoplayOff");
}

el("autoplay-toggle").addEventListener("click", () => {
  send("toggleAutoplay");
  // Optimistic flip; busy until the next queue push confirms (that's also
  // when the Autoplay section actually appears/disappears in the list).
  el("autoplay-toggle").classList.add("busy");
  updateAutoplayToggle(!lastAutoplay);
});

// Live drag preview: the dragged row follows the pointer through the list.
// Autoplay rows are excluded - the real queue ends at the Autoplay header.
function dragRowAfter(container, y, selector = ".qrow:not(.dragging):not(.automix)") {
  const rows = [...container.querySelectorAll(selector)];
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
  historyNote(t("historyLoading"));
  port.postMessage({ type: "getHistory" });
}

function renderHistory(history) {
  historyLoaded = Boolean(history);
  if (!history) {
    historyNote(t("historyFailed"));
    return;
  }
  if (history.signedOut) {
    historyNote(t("historySignIn"));
    return;
  }
  if (!history.sections.length) {
    historyNote(t("historyEmpty"));
    return;
  }
  const list = el("history-list");
  list.textContent = "";
  // Period headers arrive with the data but stay unrendered - flat reads better.
  for (const section of history.sections) {
    for (const item of section.items) list.append(buildTrackRow(item));
  }
}

// ---- home ----
// YTM's own recommendation shelves (quick picks, listen again, …), songs
// only - tiles that open an album or a playlist belong to Playlists. Rows
// carry the radio playlist YTM ships with them, so clicking one starts a
// station off that song, which is the whole point of the tab.

let homeLoaded = false;
let homeNextToken = null; // shelves page in, three at a time
let homeLoadingMore = false;

const homeMore = document.createElement("div");
homeMore.className = "list-note";
homeMore.textContent = t("loadingMore");

// Sentinel at the tail: scrolling it into view fetches the next shelves.
new IntersectionObserver(
  (entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    if (!homeNextToken || homeLoadingMore || !port) return;
    homeLoadingMore = true;
    port.postMessage({ type: "getHome", continuation: homeNextToken });
  },
  { root: el("home-list"), rootMargin: "200px" }
).observe(homeMore);

function requestHome() {
  if (homeLoaded || !port) return;
  homeNextToken = null;
  homeLoadingMore = false;
  noteInto(el("home-list"), t("homeLoading"));
  port.postMessage({ type: "getHome" });
}

function renderHome(home, append) {
  homeLoadingMore = false;
  const list = el("home-list");
  if (!home || home.signedOut) {
    // A failed page keeps whatever already rendered - just stop paging.
    if (append) {
      homeMore.remove();
      homeNextToken = null;
      return;
    }
    homeLoaded = false; // retry on the next tab visit
    noteInto(
      list,
      home?.signedOut
        ? t("homeSignIn")
        : t("homeFailed")
    );
    return;
  }
  homeLoaded = true;
  if (!append) list.textContent = "";
  homeMore.remove();
  for (const shelf of home.shelves) {
    if (shelf.header) {
      const header = document.createElement("div");
      header.className = "queue-subheader";
      header.textContent = shelf.header;
      list.append(header);
    }
    for (const item of shelf.items) list.append(buildTrackRow(item));
  }
  homeNextToken = home.continuation ?? null;
  // Re-appending the sentinel also re-arms the observer when a page brought
  // nothing renderable and the next one still might.
  if (homeNextToken) list.append(homeMore);
  else if (!list.children.length) noteInto(list, t("homeEmpty"));
}

// Track row shared by the History, Home, Search and Playlists tabs: click plays
// (with the item's own queue context), hover exposes Play next - plus
// Remove when the caller supplies onRemove (playlist detail only).
function buildTrackRow(item, { onRemove, number } = {}) {
  const row = document.createElement("div");
  row.className = "qrow";
  if (item.videoId) row.dataset.videoId = item.videoId;
  if (item.videoId) row.dataset.ratedId = ratedId(item);
  const thumb = document.createElement("div");
  thumb.className = "qthumb";
  // Album rows all share one cover, so repeating it down the list says
  // nothing - YTM numbers them instead, and so do we.
  if (number) {
    thumb.classList.add("num");
    thumb.textContent = number;
  } else if (item.thumb) {
    thumb.style.backgroundImage = `url("${item.thumb}")`;
  }
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
    const actionButton = (title, icon, onClick) => {
      const button = document.createElement("button");
      button.title = title;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", icon);
      svg.append(use);
      button.append(svg);
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick();
      });
      actions.append(button);
      return button;
    };
    appendRateButtons(actions, item);
    // Radio leads the queue actions: it plays, the other two only queue. The
    // ⋯ menu can only radio the PLAYING song - this seeds a station from any
    // row.
    if (settings.rowRadio !== false) actionButton(t("startRadio"), "#i-radio", () => {
      if (row.classList.contains("loading")) return;
      setPendingPlay(row, "loading");
      showPendingTrack(item);
      send("playVideoById", {
        videoId: item.videoId,
        // Home rows arrive with YTM's own radio playlist; anywhere else the
        // song's station is RDAMVM<videoId>, the id its menu link carries.
        playlistId: item.playlistId?.startsWith("RD")
          ? item.playlistId
          : `RDAMVM${item.videoId}`,
        params: "wAEB", // the radio flag on YTM's own endpoints
        videoType: item.videoType,
      });
      armQueueSwitch(item.videoId);
    });
    for (const [title, icon, command, toast, setting] of [
      [t("playNext"), "#i-play-next", "queueVideoNext", t("rowWillPlayNext"), "rowPlayNext"],
      [t("addToQueue"), "#i-add-to-queue", "queueVideoLast", t("rowAddedToQueue"), "rowAddToQueue"],
    ]) {
      if (settings[setting] === false) continue;
      actionButton(title, icon, () => {
        send(command, { videoId: item.videoId });
        // Optimistic - the content script pushes an error toast if it fails.
        showToast(toast, "success");
      });
    }
    if (onRemove) {
      // Destructive, so it takes two clicks: the first arms the button
      // (turns red), the second within 2.5s actually removes.
      const remove = document.createElement("button");
      remove.title = t("removeFromPlaylist");
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
          remove.title = t("removeConfirm");
          confirmTimer = setTimeout(() => {
            remove.classList.remove("confirm");
            remove.title = t("removeFromPlaylist");
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
      if (row.classList.contains("loading")) return;
      setPendingPlay(row, "loading");
      showPendingTrack(item);
      send("playVideoById", {
        videoId: item.videoId,
        playlistId: item.playlistId,
        params: item.params,
        videoType: item.videoType,
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
  searchNote(t("searching"));
  // The old query's pills would repaint stale results over the note.
  searchResultsData = null;
  el("search-filters").hidden = true;
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
    searchNote(t("searchFailed"));
    return;
  }
  if (!msg.results.songs.length && !msg.results.videos.length) {
    el("search-filters").hidden = true;
    searchNote(t("searchEmpty"));
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
    noteInto(el("playlists-list"), t("playlistsLoading"));
  }
  playlistsNextToken = null;
  playlistsLoadingMore = false;
  port.postMessage({ type: "getPlaylists" });
}

// The library arrives in ~5s worth of pages at a time (a big library used to
// blow the whole request budget and show nothing) - the rest pages in as the
// list is scrolled, same as playlist tracks.
let playlistsNextToken = null;
let playlistsLoadingMore = false;

const playlistsMore = document.createElement("div");
playlistsMore.className = "list-note";
playlistsMore.textContent = t("loadingMore");

new IntersectionObserver(
  (entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    if (!playlistsNextToken || playlistsLoadingMore || playlistDetailId || !port) return;
    playlistsLoadingMore = true;
    port.postMessage({ type: "getPlaylists", continuation: playlistsNextToken });
  },
  { root: el("playlists-pane"), rootMargin: "200px" }
).observe(playlistsMore);

function renderPlaylists(result, append = false) {
  playlistsLoadingMore = false;
  // The bridge answers {playlists, continuation}; signedOut/error come bare.
  const playlists = Array.isArray(result?.playlists) ? result.playlists : null;
  const failed = !result || Boolean(result.error) || (!playlists && !result.signedOut);
  if (append) {
    // A failed page keeps what's rendered - just stop paging. A bare
    // signedOut reply (session expired mid-scroll) is a stop too: it carries
    // no rows, so it must not reach the loop below.
    if (failed || !playlists) {
      playlistsMore.remove();
      playlistsNextToken = null;
      return;
    }
    playlistsMore.remove();
    for (const pl of playlists) el("playlists-list").append(buildPlaylistRow(pl));
    playlistsNextToken = result.continuation ?? null;
    if (playlistsNextToken) el("playlists-list").append(playlistsMore);
    return;
  }
  playlistsLoaded = !failed; // a failure must refetch on the next tab visit
  const list = el("playlists-list");
  if (failed) {
    // null = the tab never answered (askBridge timeout); error = the bridge
    // named a cause. Warn with the raw reason so remote reporters (Edge app
    // windows, other profiles) can paste something actionable.
    console.warn(
      "[YTM Companion] playlists load failed:",
      result?.error ?? "no reply from the YTM tab (timeout)"
    );
    noteInto(
      list,
      result?.error
        ? t("playlistsFailedRequest")
        : t("playlistsFailedTimeout")
    );
    return;
  }
  if (result.signedOut) {
    noteInto(list, t("playlistsSignIn"));
    return;
  }
  if (!playlists.length) {
    noteInto(list, t("playlistsEmpty"));
    return;
  }
  list.textContent = "";
  for (const pl of playlists) list.append(buildPlaylistRow(pl));
  playlistsNextToken = result.continuation ?? null;
  if (playlistsNextToken) list.append(playlistsMore);
}

function buildPlaylistRow(pl) {
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
  const shuffle = document.createElement("button");
  shuffle.title = t("shuffle");
  const shuffleSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const shuffleUse = document.createElementNS("http://www.w3.org/2000/svg", "use");
  shuffleUse.setAttribute("href", "#i-shuffle");
  shuffleSvg.append(shuffleUse);
  shuffle.append(shuffleSvg);
  shuffle.addEventListener("click", (e) => {
    e.stopPropagation();
    setPendingPlay(shuffle, "busy");
    send("playPlaylist", { playlistId: pl.id, shuffle: true });
    armQueueSwitch(null); // playlistStarted or the fallback switches
  });
  actions.append(shuffle);
  row.append(actions);

  // Visible drill-in zone; the row itself plays (play-first model).
  const open = document.createElement("button");
  open.className = "pl-open";
  open.title = t("openPlaylist");
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
      if (requireSignIn("signInPlaylists")) return;
      if (!lastState?.videoId) {
        showToast(t("nothingToAdd"));
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
  return row;
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
    ? t("captureChoose")
    : t("captureSave");
  // The song name truncates; the tail (artist / cancel hint) always shows.
  const song = bar.querySelector(".csub-main");
  const side = bar.querySelector(".csub-side");
  if (captureArmed) {
    song.textContent = t("captureCancel");
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
playlistMore.textContent = t("loadingMore");

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
  noteInto(el("playlist-tracks"), t("tracksLoading"));
  port?.postMessage({ type: "getPlaylistTracks", browseId: pl.id });
}

for (const [id, shuffle] of [
  ["playlist-play", false],
  ["playlist-shuffle", true],
]) {
  el(id).addEventListener("click", () => {
    if (!playlistDetailId) return;
    setPendingPlay(el(id), "busy");
    send("playPlaylist", { playlistId: playlistDetailId, shuffle });
    armQueueSwitch(null); // playlistStarted or the fallback switches
  });
}

// Queue the whole thing without disturbing what is playing - the counterpart
// to Play/Shuffle, which replace the queue. Optimistic toast like the row
// actions; a failed insert answers with its own notice.
function wireBarQueueing(prefix, source) {
  for (const [id, command, toast] of [
    [`${prefix}-next`, "queuePlaylistNext", t(`${prefix}WillPlayNext`)],
    [`${prefix}-queue`, "queuePlaylistLast", t(`${prefix}AddedToQueue`)],
  ]) {
    el(id).addEventListener("click", () => {
      const target = source();
      if (!target?.playlistId && !target?.videoIds?.length) return;
      send(command, target);
      showToast(toast, "success");
    });
  }
}

wireBarQueueing("playlist", () => {
  if (!playlistDetailId) return null;
  // Playlists page, so the loaded rows are only the whole list once the last
  // page is in - then they are a fallback for ids get_queue declines (Liked
  // Music); before that, a half-queued fallback is worse than the notice.
  const rows = [...el("playlist-tracks").querySelectorAll("[data-video-id]")];
  const complete = !playlistNextToken && rows.length > 0;
  return {
    playlistId: playlistDetailId,
    videoIds: complete ? rows.map((row) => row.dataset.videoId) : undefined,
  };
});

function renderPlaylistTracks(msg) {
  if (msg.browseId !== playlistDetailId) return; // navigated away meanwhile
  const list = el("playlist-tracks");
  playlistLoadingMore = false;
  if (!msg.tracks) {
    // A failed continuation just stops paging; keep what's rendered.
    if (msg.append) playlistMore.remove();
    else noteInto(list, t("playlistFailed"));
    return;
  }
  if (!msg.append) {
    list.textContent = "";
    if (!msg.tracks.length && !msg.continuation) {
      noteInto(list, t("playlistEmpty"));
      playlistNextToken = null;
      return;
    }
  } else {
    playlistMore.remove();
  }
  // Pages are positional: a song liked, unliked or removed meanwhile shifts
  // the list, and the next page repeats a row already shown.
  const shown = new Set(
    [...list.querySelectorAll(".qrow")].map((row) => playlistRowKey(row.dataset, msg.browseId))
  );
  for (const item of msg.tracks) {
    const key = playlistRowKey(item, msg.browseId);
    if (msg.append && key && shown.has(key)) continue;
    list.append(buildPlaylistTrackRow(item, msg.browseId));
  }
  playlistNextToken = msg.continuation;
  if (playlistNextToken) list.append(playlistMore);
}

// Unliking a song takes it out of Liked Music. The row stays, dimmed, until
// the playlist is reopened: rows don't shift under the cursor, and liking it
// again undoes it in place.
const LIKED_MUSIC_ID = "VLLM";

// A song is liked once, so Liked Music keys on the song; other playlists can
// hold it twice, and only the entry id tells those apart.
function playlistRowKey(item, browseId) {
  return browseId === LIKED_MUSIC_ID ? item.videoId : item.setVideoId;
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
  if (item.setVideoId) row.dataset.setVideoId = item.setVideoId;
  if (browseId === LIKED_MUSIC_ID && rowRating(item) && rowRating(item) !== "LIKE") {
    row.classList.add("unliked");
  }
  return row;
}

el("playlist-back").addEventListener("click", () => {
  playlistDetailId = null;
  el("playlist-detail").hidden = true;
  el("playlists-list").hidden = false;
  updateCaptureBar();
  el("playlists-pane").scrollTop = playlistsScrollTop;
});

// ---- album view ----
// The release behind the playing song, in the popup instead of a trip to the
// tab. Not a tab of its own (the strip is full at six) - it takes over the
// pane area like settings does and returns to wherever it was opened from.

let albumBrowseId = null; // the album being shown (stale-response guard)
let albumReturnTab = "queue";
let albumPlaylistId = null; // OLAK5uy_ audio playlist, for play/shuffle
let albumOpenUrl = ""; // browse/... href, for the open-in-YTM button
let albumFailed = false; // a failed load may be retried by clicking again
let albumVideoIds = []; // fallback for queueing, if get_queue refuses the id

function openAlbum(url, fallbackTitle = "") {
  const browseId = String(url ?? "").split("/").pop();
  if (!browseId) return;
  // Clicking the byline for the album already on screen asks to get back to
  // the top of it, not to fetch it again - re-running the open would flash
  // the skeleton over a view that was already right. The track can change
  // underneath, though, so this turns on the id and not on the pane being
  // open; a load that failed is still allowed to retry.
  if (browseId === albumBrowseId && activeTab === "album" && !albumFailed) {
    el("album-pane").scrollTop = 0;
    return;
  }
  albumOpenUrl = url;
  albumBrowseId = browseId;
  albumPlaylistId = null;
  albumFailed = false;
  if (activeTab !== "album") albumReturnTab = activeTab;
  // Nothing is named until the response lands - the shape goes up first and
  // the words arrive together. Titling the header (or the bar) early meant
  // the name sat next to "Loading album…" claiming to be loaded, and put it
  // briefly in both places at once, which read as a flash.
  el("album-title").textContent = fallbackTitle || t("album");
  el("album-name").textContent = "";
  el("album-artist").textContent = "";
  el("album-meta").textContent = "";
  el("album-art").style.backgroundImage = "";
  el("album-head").classList.add("skeleton");
  el("album-head").hidden = false;
  el("album-bar").classList.remove("scrolled");
  albumVideoIds = [];
  setAlbumActionsEnabled(false);
  switchTab("album");
  el("album-pane").scrollTop = 0;
  el("album-tracks").textContent = "";
  el("album-tracks").append(albumSkeleton());
  port?.postMessage({ type: "getAlbum", browseId });
}

// Placeholder rows under the placeholder header: same metrics as the real
// ones, so nothing moves when the words arrive. Widths vary because a column
// of identical bars reads as a table, not as loading.
function albumSkeleton() {
  const frag = document.createDocumentFragment();
  for (const width of [72, 54, 80, 63, 76, 48]) {
    const row = document.createElement("div");
    row.className = "qrow";
    const thumb = document.createElement("div");
    thumb.className = "qthumb num";
    const number = document.createElement("span");
    number.className = "sk sk-num";
    thumb.append(number);
    const meta = document.createElement("div");
    meta.className = "qmeta";
    const title = document.createElement("div");
    title.className = "sk sk-title";
    title.style.width = `${width}%`;
    const artist = document.createElement("div");
    artist.className = "sk sk-artist";
    artist.style.width = `${Math.round(width * 0.55)}%`;
    meta.append(title, artist);
    const duration = document.createElement("div");
    duration.className = "sk sk-dur";
    row.append(thumb, meta, duration);
    frag.append(row);
  }
  return frag;
}

function renderAlbum(msg) {
  if (msg.browseId !== albumBrowseId) return; // navigated away meanwhile
  const list = el("album-tracks");
  const album = msg.album;
  el("album-head").classList.remove("skeleton");
  if (!album) {
    albumFailed = true;
    el("album-head").hidden = true;
    noteInto(list, t("albumFailed"));
    return;
  }
  el("album-title").textContent = album.title || t("album");
  el("album-name").textContent = album.title;
  el("album-artist").textContent = album.artist;
  // YTM writes both of these in the user's language; shown verbatim, joined
  // with the same separator it uses inside them.
  el("album-meta").textContent = [album.subtitle, album.meta].filter(Boolean).join(" • ");
  el("album-art").style.backgroundImage = album.thumb ? `url("${album.thumb}")` : "";
  albumPlaylistId = album.playlistId;
  albumVideoIds = album.tracks.map((track) => track.videoId).filter(Boolean);
  setAlbumActionsEnabled(Boolean(albumPlaylistId));
  if (!album.tracks.length) {
    noteInto(list, t("albumEmpty"));
    return;
  }
  list.textContent = "";
  for (const item of album.tracks) list.append(buildTrackRow(item, { number: item.index }));
}

function setAlbumActionsEnabled(on) {
  for (const id of ["album-play", "album-shuffle", "album-next", "album-queue"]) {
    el(id).disabled = !on;
  }
}

wireBarQueueing("album", () =>
  albumPlaylistId ? { playlistId: albumPlaylistId, videoIds: albumVideoIds } : null
);

for (const [id, shuffle] of [
  ["album-play", false],
  ["album-shuffle", true],
]) {
  el(id).addEventListener("click", () => {
    if (!albumPlaylistId) return;
    setPendingPlay(el(id), "busy");
    send("playPlaylist", { playlistId: albumPlaylistId, shuffle });
    armQueueSwitch(null); // playlistStarted or the fallback switches
  });
}

// The title's hand-off from the header to the sticky bar. Watching the
// header's own title (not the whole header block) makes the swap happen at
// the exact moment it goes out of sight; the negative margin is the bar's
// own height, since the bar is what it disappears behind.
new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      el("album-bar").classList.toggle("scrolled", !entry.isIntersecting);
    }
  },
  { root: el("album-pane"), rootMargin: "-36px 0px 0px 0px" }
).observe(el("album-name"));

el("album-back").addEventListener("click", () => {
  albumBrowseId = null;
  switchTab(albumReturnTab);
});

el("album-open").addEventListener("click", () => {
  if (!albumOpenUrl) return;
  send("openByline", { href: albumOpenUrl });
  focusYtmTab();
});

// ---- lyrics (LRCLIB) ----
// Opt-in (sends title/artist to lrclib.net), official songs only.

const LYRICS_TYPES = new Set(["MUSIC_VIDEO_TYPE_ATV", "MUSIC_VIDEO_TYPE_OMV"]);

let lyricsEnabled = null; // null = not read from storage yet
let lyricsKey = null; // track the pane currently reflects
let lyricsRenderKey = null; // track renderLyrics last ran for (any outcome)
const LYRICS_SETTLE_MS = 800; // matches the tab's first prefetch delay
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
  note.textContent = t("lyricsOptIn");
  const button = document.createElement("button");
  button.id = "lyrics-enable";
  button.textContent = t("lyricsEnable");
  button.addEventListener("click", () => setLyricsEnabled(true));
  pane.append(note, button);
}

// One flag behind both the in-tab Enable button and the settings switch.
function setLyricsEnabled(value) {
  lyricsEnabled = value;
  el("set-lyrics").classList.toggle("on", value);
  // Lyrics was the last visible tab: the strip must keep one, so the first
  // tab in order comes back and takes the default, as the Show switches do.
  if (!value && !visibleTabs().length) {
    const first = settings.tabOrder.find((id) => id !== "lyrics");
    settings.hiddenTabs = settings.hiddenTabs.filter((id) => id !== first);
    settings.defaultTab = first;
    saveSettings();
  }
  updateLyricsTab();
  try {
    ext.storage.local.set({ lyricsEnabled: value });
  } catch {
    // session-only preference
  }
  lyricsKey = null; // force the pane to re-evaluate (fetch or opt-in prompt)
  if (!value && activeTab === "lyrics") switchTab(homeTab());
  else if (activeTab === "lyrics") renderLyrics();
}

// Lyrics off → the tab (and its size control) disappears entirely.
function updateLyricsTab() {
  applyTabOrder();
  renderTabOrder(); // the lyrics row locks off while lyrics are off
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
    lyricsNote(t("lyricsUnreachable"));
    return;
  }
  if (entry.instrumental) {
    lyricsNote(t("lyricsInstrumental"));
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
  lyricsNote(t("lyricsNotFound"));
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
    lyricsNote(t(adShowing ? "adPlaying" : "lyricsNothingPlaying"));
    return;
  }
  if (!lyricsEligible(state)) {
    lyricsKey = null;
    lyricsLines = null;
    lyricsNote(t("lyricsSongsOnly"));
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
  lyricsNote(t("lyricsLooking"));
  const fetchId = ++lyricsFetchId;
  // The videoId flips before the bar's title and duration do. A lookup sent
  // in that window asks LRCLIB about the previous track and the background
  // caches the answer under the NEW id. Let the bar settle first (the tab's
  // own prefetch waits the same way) and read the state again at send time.
  await new Promise((resolve) => setTimeout(resolve, LYRICS_SETTLE_MS));
  if (fetchId !== lyricsFetchId) return;
  const settled = lastState;
  if (!settled || (settled.videoId || `${settled.title}|${settled.artist}`) !== key) return;
  if (!settled.duration) {
    // Still no duration - the next state push re-enters renderLyrics.
    lyricsKey = null;
    lyricsRenderKey = null;
    return;
  }
  // Background fetches+caches; the prefetch usually made this a cache hit.
  let entry = null;
  try {
    entry = await ext.runtime.sendMessage({
      type: "fetchLyrics",
      track: {
        videoId: settled.videoId,
        title: settled.title,
        artist: settled.artist,
        album: settled.album,
        duration: settled.duration,
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

// Loading affordance while a play is in flight (navigation can take a few
// seconds, or even reload the tab). One pending element at a time; cleared
// by the queue switch (success or its fallback) and by error notices.
let pendingPlay = null;

function setPendingPlay(element, cls) {
  pendingPlay?.element.classList.remove(pendingPlay.cls);
  pendingPlay = element ? { element, cls } : null;
  element?.classList.add(cls);
}

function armQueueSwitch(videoId) {
  queueSwitchVideoId = videoId;
  queueSwitchLoaded = false;
  clearTimeout(queueSwitchFallback);
  queueSwitchFallback = setTimeout(doQueueSwitch, 3000);
}

function doQueueSwitch() {
  setPendingPlay(null);
  clearTimeout(queueSwitchFallback);
  queueSwitchFallback = null;
  queueSwitchVideoId = null;
  queueSwitchLoaded = false;
  // A hidden queue tab stays hidden - the play still happened.
  if (tabVisible("queue")) switchTab("queue");
}

let activeTab = "queue";

function switchTab(name) {
  activeTab = name;
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === name);
  }
  el("queue-list").hidden = name !== "queue";
  el("history-list").hidden = name !== "history";
  el("home-list").hidden = name !== "home";
  el("lyrics-pane").hidden = name !== "lyrics";
  el("search-pane").hidden = name !== "search";
  el("playlists-pane").hidden = name !== "playlists";
  el("album-pane").hidden = name !== "album";
  el("settings-pane").hidden = name !== "settings";
  el("settings-open").classList.toggle("active", name === "settings");
  el("autoplay-toggle").hidden = name !== "queue" || lastAutoplay === null;
  if (name === "history") requestHistory();
  if (name === "home") requestHome();
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

let reconnectAttempts = 0;
// Session restore (and Firefox's tab unloading) leaves YTM tabs DISCARDED:
// they still match a tab query, but they have no content script, so nothing
// can answer the popup. The tab is open in the user's mind, so wake it once
// rather than claiming YouTube Music isn't open.
let wakeState = null; // { tabId, deadline }

let sleepingTabId = null;
let reloadOnOpen = false;

// Firefox only loads a session-restored tab when it is selected, so a
// background reload can quietly do nothing. Offer the one action that always
// works rather than leaving the popup claiming nothing is open.
function offerToOpenTab(tabId, { reload = false } = {}) {
  sleepingTabId = tabId;
  reloadOnOpen = reload;
  if (!reload) {
    el("empty-title").textContent = t("emptyAsleepTitle");
    el("empty-sub").textContent = t("emptyAsleepSub");
  }
  el("empty-allow").hidden = true;
  el("empty-open").hidden = false;
  el("open-ytm").hidden = true;
  showEmpty();
}

el("empty-open").addEventListener("click", async () => {
  if (sleepingTabId === null) return;
  try {
    if (reloadOnOpen) await ext.tabs.reload(sleepingTabId);
    const tab = await ext.tabs.update(sleepingTabId, { active: true });
    if (tab?.windowId !== undefined) await ext.windows.update(tab.windowId, { focused: true });
  } catch {
    // the tab went away; the next popup open will report honestly
  }
  window.close();
});

function showWaking() {
  el("empty-allow").hidden = true;
  el("empty-open").hidden = true;
  el("empty-title").textContent = t("emptyWakingTitle");
  el("empty-sub").textContent = t("emptyWakingSub");
  showEmpty();
}

function showConnecting() {
  el("empty-allow").hidden = true;
  el("empty-open").hidden = true;
  el("open-ytm").hidden = true;
  el("empty-title").textContent = t("emptyConnectingTitle");
  el("empty-sub").textContent = t("emptyConnectingSub");
  showEmpty();
}

// Without site access the browser hides YTM tabs from the query and keeps the
// content script off the page, so "isn't open" may be a lie: Firefox's
// per-site toggle (off for a temporary add-on) and Chrome's "on click" site
// access both land here.
const SITE_ACCESS = { origins: [`${YTM_BASE}*`] };
// Lyrics come from LRCLIB; one prompt covers both.
const SITE_ACCESS_ALL = { origins: [`${YTM_BASE}*`, "https://lrclib.net/*"] };

async function offerSiteAccessIfMissing() {
  let granted = true;
  try {
    granted = (await ext.permissions?.contains?.(SITE_ACCESS)) ?? true;
  } catch {
    // no permissions API - nothing to offer
  }
  if (granted) return;
  el("empty-title").textContent = t("emptyAccessTitle");
  el("empty-sub").textContent = t("emptyAccessSub");
  el("empty-allow").hidden = false;
  el("open-ytm").hidden = true;
}

// request() needs the click's user gesture, so nothing may be awaited first.
// Firefox anchors its prompt under the popup: closing the popup a beat after
// asking uncovers it (the grant is the browser's, not this page's).
el("empty-allow").addEventListener("click", () => {
  Promise.resolve(ext.permissions.request(SITE_ACCESS_ALL)).then(
    (granted) => {
      if (!granted) return;
      reconnectAttempts = 0;
      connect();
    },
    () => {}
  );
  if (ext.runtime.getBrowserInfo) setTimeout(() => window.close(), 100);
});

function resetEmptyCopy() {
  el("empty-allow").hidden = true;
  el("empty-open").hidden = true;
  el("open-ytm").hidden = false;
  el("empty-title").textContent = t("emptyTitle");
  el("empty-sub").textContent = t("emptySub");
}

function tryTab(candidates, index) {
  const tab = candidates[index];
  if (!tab) {
    // Tabs exist but none accepted the port: usually a tab mid-reload
    // (playVideo's watch-URL fallback navigates the page under us) with no
    // content script yet. Retry briefly instead of giving up on the popup.
    // 16 x 500ms: a watch-URL reload plus a cold YTM load can pass 4s.
    if (candidates.length && reconnectAttempts < 16) {
      reconnectAttempts += 1;
      // Both panes start hidden: with nothing shown yet, these retries left
      // the popup an empty box for 8s (a tab open since before the install
      // has no content script, and never answers).
      if (playerView.hidden && emptyView.hidden) showConnecting();
      setTimeout(connect, 500);
      return;
    }
    // Still waiting on a tab we woke - a cold YTM load takes a few seconds.
    if (wakeState && Date.now() < wakeState.deadline) {
      setTimeout(connect, 750);
      return;
    }
    // The wake never took: some browsers only load a restored tab when it is
    // selected. Hand the user the button instead of a wrong answer.
    if (wakeState) {
      offerToOpenTab(wakeState.tabId);
      return;
    }
    // An unloaded tab can't answer, so wake it once and keep trying while it
    // boots. Reloading needs no extra permission: we already hold host
    // access to music.youtube.com.
    const asleep = candidates.find((candidate) => candidate.discarded);
    if (asleep && !wakeState) {
      wakeState = { tabId: asleep.id, deadline: Date.now() + 20000 };
      showWaking();
      Promise.resolve(ext.tabs.reload(asleep.id)).catch(() => {});
      setTimeout(connect, 900);
      return;
    }
    // A live (not discarded) tab that refused every connect has no content
    // script to talk to - the classic case is the extension just updated and
    // orphaned it. "YouTube Music isn't open" would be a lie; say what fixes
    // it and hand over the button, which reloads that tab.
    const orphan = candidates.find((candidate) => !candidate.discarded);
    if (orphan) {
      el("empty-title").textContent = t("emptyReloadTitle");
      el("empty-sub").textContent = t("emptyReloadSub");
      offerToOpenTab(orphan.id, { reload: true });
      return;
    }
    resetEmptyCopy();
    showEmpty();
    offerSiteAccessIfMissing();
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
    reconnectAttempts = 0;
    wakeState = null;
    if (msg.type === "state") {
      if (queueSwitchVideoId && msg.state.available && msg.state.videoId === queueSwitchVideoId) {
        queueSwitchLoaded = true;
      }
      render(msg.state);
    } else if (msg.type === "queue") {
      // Autoplay state first - renderQueue keys the suggestions section on it.
      el("autoplay-toggle").classList.remove("busy");
      updateAutoplayToggle(msg.autoplay);
      lastQueue = msg.queue; // for Copy queue
      renderQueue(msg.queue);
      if (queueSwitchLoaded && msg.queue.some((item) => item.selected)) doQueueSwitch();
    } else if (msg.type === "history") renderHistory(msg.history);
    else if (msg.type === "ratings") {
      for (const [videoId, status] of Object.entries(msg.ratings)) setRowRating(videoId, status);
    }
    else if (msg.type === "home") renderHome(msg.home, msg.append);
    else if (msg.type === "searchResults") renderSearchResults(msg);
    else if (msg.type === "playlists") renderPlaylists(msg.playlists, msg.append);
    else if (msg.type === "playlistTracks") renderPlaylistTracks(msg);
    else if (msg.type === "album") renderAlbum(msg);
    else if (msg.type === "playlistStarted") {
      // Only act while a playlist-play switch is armed (videoId-less).
      if (queueSwitchFallback && queueSwitchVideoId === null) {
        if (msg.ok) doQueueSwitch();
        else {
          setPendingPlay(null);
          clearTimeout(queueSwitchFallback);
          queueSwitchFallback = null;
          showToast(t("playlistStartFailed"));
        }
      }
    }
    else if (msg.type === "addToPlaylistResult") {
      showToast(
        msg.result === "added"
          ? t("playlistAdded", msg.name)
          : msg.result === "duplicate"
            ? t("playlistAlready", msg.name)
            : t("playlistAddFailed"),
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
        showToast(t("playlistRemoved", msg.name), "success");
        // Drop the row in place - a refetch would reset infinite scroll.
        if (playlistDetailId === msg.playlistId) {
          el("playlist-tracks")
            .querySelector(`[data-set-video-id="${msg.setVideoId}"]`)
            ?.remove();
        }
        requestPlaylists(true); // keep list track counts honest
      } else {
        showToast(t("playlistRemoveFailed"));
      }
    }
    else if (msg.type === "queueImported") {
      // Dead ids come back with no renderer, so "asked" and "count" can differ
      // - saying so beats a silently short queue.
      showToast(
        msg.count === msg.asked
          ? tn("queueReplaced", msg.count)
          : t("queueReplacedPartial", msg.count, msg.asked),
        msg.count === msg.asked ? "success" : "notice"
      );
    } else if (msg.type === "notice") {
      // Errors end whatever play was pending.
      setPendingPlay(null);
      showToast(t(msg.key));
    }
  });
  port.postMessage({ type: "getQueue" });
  // A lazy tab opened before the port existed (fast click on a fresh popup,
  // or a reconnect) dropped its request - re-issue it now.
  if (activeTab === "history") requestHistory();
  if (activeTab === "home") requestHome();
  if (activeTab === "playlists") requestPlaylists();
  port.onDisconnect.addListener(() => {
    port = null;
    // A dead tab (no content script) drops the port before ever speaking -
    // fall through to the next candidate. A live one closing means retry all.
    if (alive) connect();
    else tryTab(candidates, index + 1);
  });
}

// ---- the one-time rating ask ----
// Ratings are what store search ranks on, and the honest way to earn them is
// to ask people who have actually used the thing. So: no prompt until the
// extension has been around a fortnight AND opened enough times to mean it,
// one ask, and never again whichever button gets pressed.
const RATE_MIN_DAYS = 14;
const RATE_MIN_OPENS = 40;
// A dismissal means "not now", not "never" - so it snoozes rather than ends.
// Each later ask needs another fortnight AND some more real use, and the
// third no is final.
const RATE_SNOOZE_DAYS = 14;
const RATE_SNOOZE_OPENS = 10;
const RATE_MAX_ASKS = 3;
// Once due it stays until answered, like the update notice: the x is one
// click, and a strip that leaves on its own is one most people never saw.
const RATE_URLS = {
  firefox: "https://addons.mozilla.org/firefox/addon/companion-for-youtube-music/reviews/",
  chrome:
    "https://chromewebstore.google.com/detail/companion-for-youtube-mus/iifmpealppkjdljfhbjcdgdgglflnfkl/reviews",
};

// Pure so it can be tested without a clock or a browser.
function rateEligible(state, now = Date.now()) {
  if (!state?.installedAt || state.ratedAt) return false;
  const dismissals = state.dismissals ?? 0;
  if (dismissals >= RATE_MAX_ASKS) return false;
  const opens = state.opens ?? 0;
  if (dismissals === 0) {
    return (now - state.installedAt) / 86400000 >= RATE_MIN_DAYS && opens >= RATE_MIN_OPENS;
  }
  return now >= (state.snoozeUntil ?? Infinity) && opens >= (state.snoozeOpens ?? Infinity);
}

const storeUrl = () =>
  /firefox/i.test(navigator.userAgent) ? RATE_URLS.firefox : RATE_URLS.chrome;

let rateState = null;

// ---- the update notice ----
// Shares the rating strip: a feature release (x.y) announces itself once to
// people who had the extension before it and links its release notes. It is
// news, not a request, so unlike the ask it stays until it is answered.
const RELEASES_URL = "https://github.com/benesmartin/youtube-music-companion/releases/tag/";
const featureOf = (version) => String(version).split(".").slice(0, 2).join(".");

// Pure, like rateEligible. seen: the last version whose notice was settled.
function updateNoticeDue(notice, version, existingUser) {
  if (!notice?.seen) return existingUser;
  return featureOf(notice.seen) !== featureOf(version);
}

let updateShowing = false;

async function announceUpdate(existingUser) {
  const version = ext.runtime.getManifest().version;
  try {
    const notice = (await ext.storage.local.get("updateNotice")).updateNotice ?? null;
    if (!updateNoticeDue(notice, version, existingUser)) {
      if (notice?.seen !== version) await ext.storage.local.set({ updateNotice: { seen: version } });
      return false;
    }
  } catch {
    return false;
  }
  updateShowing = true;
  // Named after the feature release, which is also where the button leads: a
  // patch on top of it has nothing of its own to announce.
  el("rate-text").textContent = t("updateText", `${featureOf(version)}.0`);
  el("rate-go").textContent = t("updateGo");
  el("rate-dismiss").title = t("updateDismiss");
  el("rate-bar").hidden = false;
  return true;
}

async function answerUpdate(open) {
  const version = ext.runtime.getManifest().version;
  el("rate-bar").hidden = true;
  updateShowing = false;
  try {
    await ext.storage.local.set({ updateNotice: { seen: version } });
  } catch {
    // the bar is gone for this session either way
  }
  if (open) ext.tabs.create({ url: `${RELEASES_URL}v${featureOf(version)}.0` });
}

async function trackOpenAndMaybeAsk() {
  let existingUser = false;
  try {
    const stored = (await ext.storage.local.get("rateState")).rateState ?? {};
    existingUser = Boolean(stored.installedAt);
    rateState = {
      ...stored,
      // No stored install date means this is the first run since the ask
      // shipped - existing users start their clock now rather than being
      // prompted the moment they update.
      installedAt: stored.installedAt ?? Date.now(),
      opens: (stored.opens ?? 0) + 1,
    };
    await ext.storage.local.set({ rateState });
  } catch {
    return; // storage unavailable: never nag
  }
  // One strip at a time, and the notice is the one with a date on it.
  if (await announceUpdate(existingUser)) return;
  if (!rateEligible(rateState)) return;
  el("rate-bar").hidden = false;
}

// A "not now" costs one of the three asks and buys a fortnight of silence.
async function snoozeRate() {
  const now = Date.now();
  rateState = {
    ...rateState,
    dismissals: (rateState?.dismissals ?? 0) + 1,
    snoozeUntil: now + RATE_SNOOZE_DAYS * 86400000,
    snoozeOpens: (rateState?.opens ?? 0) + RATE_SNOOZE_OPENS,
  };
  try {
    await ext.storage.local.set({ rateState });
  } catch {
    // the bar stays hidden for this session either way
  }
}

async function answerRate(rated) {
  el("rate-bar").hidden = true;
  if (!rated) {
    await snoozeRate();
    return;
  }
  rateState = { ...rateState, ratedAt: Date.now() };
  try {
    await ext.storage.local.set({ rateState });
  } catch {
    // the bar is gone for this session either way
  }
  ext.tabs.create({ url: storeUrl() });
}

el("rate-go").addEventListener("click", () => (updateShowing ? answerUpdate(true) : answerRate(true)));
el("rate-dismiss").addEventListener("click", () =>
  updateShowing ? answerUpdate(false) : answerRate(false)
);

loadSettings();
connect();
trackOpenAndMaybeAsk();
