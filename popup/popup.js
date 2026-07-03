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
  const m = Math.floor(totalSeconds / 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

let emptyTimer = null;

function render(state) {
  if (!state.available) {
    // SPA navigation (e.g. playing from history) blanks the player bar for
    // a moment; only fall back to the empty view if it stays unavailable.
    if (lastState?.available) {
      if (!emptyTimer) {
        emptyTimer = setTimeout(() => {
          emptyTimer = null;
          lastState = null;
          showEmpty();
        }, 1500);
      }
    } else {
      showEmpty();
    }
    return;
  }
  clearTimeout(emptyTimer);
  emptyTimer = null;
  playerView.hidden = false;
  emptyView.hidden = true;

  // A track change invalidates any in-flight drag: without this, releasing
  // the seek slider just after a transition seeks the NEW song to its end.
  const track = `${state.title}|${state.artist}`;
  if (track !== currentTrack) {
    currentTrack = track;
    seeking = false;
    if (activeTab === "lyrics") renderLyrics();
  }
  if (activeTab === "lyrics") updateLyricsHighlight(state.position);

  el("title").textContent = state.title;
  el("artist").textContent = state.artist;
  el("album").textContent = state.album ?? "";
  el("album-year").textContent = state.album && state.year ? ` • ${state.year}` : "";
  // Tooltips only where text actually truncates.
  el("title").title = el("title").scrollWidth > el("title").clientWidth ? state.title : "";
  el("album").title = el("album").scrollWidth > el("album").clientWidth ? state.album : "";

  lastState = state;
  el("artist").classList.toggle("link", Boolean(state.artistUrl));
  el("album").classList.toggle("link", Boolean(state.albumUrl));
  el("radio").disabled = !state.videoId;
  el("copy-link").disabled = !state.videoId;
  el("copy-info").disabled = !state.title;

  // Library reflects the probed state; "Add" is the default until known.
  // User uploads have no library action — keep the row (stable spacing)
  // but disable it.
  el("library").disabled = !state.videoId || state.libraryAvailable === false;
  el("library").classList.toggle("in", state.inLibrary === true);
  el("library-label").textContent =
    state.inLibrary === true ? "Remove from library" : "Add to library";
  if (!el("more-menu").hidden) updateOverflowTitles();
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
  // While the user drags the volume, echoed state would yank the knob to a
  // stale value — hold off until the drag has settled.
  if (!volumeBusy()) {
    el("volume").value = state.muted ? 0 : state.volume;
    updateFill(el("volume"));
  }
}

let toastTimer = null;
function showToast(text) {
  el("toast").textContent = text;
  el("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el("toast").hidden = true;
  }, 6000);
}

function showEmpty() {
  playerView.hidden = true;
  emptyView.hidden = false;
}

function send(command, payload = {}) {
  port?.postMessage({ type: "command", command, payload });
}

el("play-pause").addEventListener("click", () => send("playPause"));
el("next").addEventListener("click", () => send("next"));
el("previous").addEventListener("click", () => send("previous"));
el("like").addEventListener("click", () => send("toggleLike"));
el("dislike").addEventListener("click", () => send("toggleDislike"));
el("shuffle").addEventListener("click", () => send("shuffle"));
el("repeat").addEventListener("click", () => send("toggleRepeat"));
el("mute").addEventListener("click", () => send("toggleMute"));

el("seek").addEventListener("input", () => {
  seeking = true;
  el("position").textContent = formatTime(Number(el("seek").value));
  updateFill(el("seek"));
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
    // Keyboard adjustment — settle window keeps echoes at bay.
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

// ---- more-actions dropdown ----
// The menu persists until a click lands outside it.

let sleepTicker = null;

function showSleepPage(show) {
  if (show) {
    // Match the main page's height so the submenu's rows can spread out.
    el("menu-sleep").style.minHeight = `${el("menu-main").offsetHeight}px`;
  }
  el("menu-main").hidden = show;
  el("menu-sleep").hidden = !show;
  el("more-menu").scrollTop = 0;
}

// Full-text labels get a tooltip only when actually truncated.
function updateOverflowTitles() {
  for (const label of document.querySelectorAll("#more-menu .label")) {
    label.title = label.scrollWidth > label.clientWidth ? label.textContent : "";
  }
}

function toggleMenu(open) {
  const show = open ?? el("more-menu").hidden;
  if (show) {
    // Anchor just below the ⋯ button — the queue/history lists give the
    // popup plenty of room underneath.
    const anchor = el("more").getBoundingClientRect();
    el("more-menu").style.top = `${anchor.bottom + 6}px`;
    el("more-menu").style.maxHeight = `${Math.max(80, window.innerHeight - anchor.bottom - 14)}px`;
  }
  el("more-menu").hidden = !show;
  el("more").classList.toggle("open", show);
  if (show) {
    showSleepPage(false);
    send("probeLibrary");
    refreshSleep();
    updateOverflowTitles();
    sleepTicker = setInterval(refreshSleep, 10000);
  } else if (sleepTicker) {
    clearInterval(sleepTicker);
    sleepTicker = null;
  }
}

el("more").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleMenu();
});
document.addEventListener("click", (e) => {
  if (!el("more-menu").hidden && !el("more-menu").contains(e.target)) toggleMenu(false);
});

// Radio is started by the content script clicking YTM's own "Start mix" menu
// item — SPA navigation, playback keeps running, no beforeunload dialog.
el("radio").addEventListener("click", () => send("startRadio"));

el("library").addEventListener("click", () => send("toggleLibrary"));

async function copyToClipboard(button, text) {
  await navigator.clipboard.writeText(text);
  button.classList.add("copied");
  setTimeout(() => button.classList.remove("copied"), 1200);
}

el("copy-link").addEventListener("click", () => {
  if (lastState?.videoId) copyToClipboard(el("copy-link"), `${YTM_BASE}watch?v=${lastState.videoId}`);
});

el("copy-info").addEventListener("click", () => {
  if (lastState?.title) copyToClipboard(el("copy-info"), `${lastState.artist} – ${lastState.title}`);
});

// ---- sleep timer ----

// Each character in its own span so the wave animation can stagger them.
function waveText(element, text) {
  element.textContent = "";
  [...text].forEach((char, i) => {
    const span = document.createElement("span");
    span.textContent = char;
    span.style.animationDelay = `${i * 0.12}s`;
    element.append(span);
  });
}

const setSleepStatus = (text) => waveText(el("sleep-status"), text);

async function refreshSleep() {
  let alarm = null;
  try {
    alarm = await ext.alarms.get("sleep-timer");
  } catch {
    // API unavailable; leave the timer UI inert.
  }
  const minutes = alarm
    ? Math.max(1, Math.ceil((alarm.scheduledTime - Date.now()) / 60000))
    : 0;
  el("sleep-off").hidden = !alarm;
  el("sleep-remaining").textContent = alarm ? `Pausing in ${minutes} min` : "No timer running";
  setSleepStatus(alarm ? `${minutes} min` : "");
}

el("sleep-open").addEventListener("click", () => showSleepPage(true));
el("sleep-back").addEventListener("click", () => showSleepPage(false));

function armSleep(minutes) {
  if (!Number.isFinite(minutes) || minutes < 1) return;
  const clamped = Math.min(720, Math.round(minutes));
  ext.alarms.create("sleep-timer", { delayInMinutes: clamped });
  setSleepStatus(`${clamped} min`);
  el("sleep-remaining").textContent = `Pausing in ${clamped} min`;
  el("sleep-off").hidden = false;
  showSleepPage(false);
  setTimeout(refreshSleep, 150);
}

for (const option of document.querySelectorAll(".sleep-opt")) {
  option.addEventListener("click", () => armSleep(Number(option.dataset.min)));
}

el("sleep-set").addEventListener("click", () => armSleep(Number(el("sleep-custom-min").value)));
el("sleep-custom-min").addEventListener("keydown", (e) => {
  if (e.key === "Enter") armSleep(Number(el("sleep-custom-min").value));
});

el("sleep-off").addEventListener("click", async () => {
  el("sleep-off").hidden = true;
  el("sleep-remaining").textContent = "No timer running";
  setSleepStatus("");
  await ext.alarms.clear("sleep-timer");
  refreshSleep();
});

// ---- navigation ----

// Focus the YTM tab; navigation itself (if any) happens via YTM's own
// anchors clicked by the content script, so playback keeps running.
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

el("artist").addEventListener("click", () => lastState?.artistUrl && goTo("goToArtist"));
el("album").addEventListener("click", () => lastState?.albumUrl && goTo("goToAlbum"));
el("artwork").addEventListener("click", focusYtmTab);

// ---- queue ----

let lastSelectedIndex = null;

function renderQueue(queue) {
  const list = el("queue-list");
  list.textContent = "";
  if (!queue.length) {
    const note = document.createElement("div");
    note.id = "queue-note";
    note.textContent = "Nothing in the queue — try Start radio from the ⋯ menu.";
    list.append(note);
    lastSelectedIndex = null;
    return;
  }

  let automixHeaderAdded = false;
  for (const item of queue) {
    // Belt and suspenders: with autoplay off, suggestions never render —
    // even if a stale push still carries them.
    if (item.automix && lastAutoplay === false) continue;
    // Everything below this line is YTM's suggestions, not the real queue.
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

    // Hover actions — not on the playing row, where they make no sense.
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
        });
        actions.append(button);
      }
      row.append(actions);
    }

    row.addEventListener("click", () => send("playQueueItem", { index: item.index }));

    // Drag to reorder: the popup previews the move locally; the drop sends
    // one queueMove and the next queue push confirms (or snaps back).
    // Autoplay suggestions aren't movable (they live outside the queue store's
    // reorderable items), so they don't even offer the drag.
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
// Autoplay rows are excluded — the real queue ends at the Autoplay header.
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
// The user's real YouTube Music history (music.youtube.com/history), fetched
// through the page's own internal API by the bridge. Loaded once per popup;
// a failed load retries the next time the tab is opened.

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
    historyNote("No history yet — songs you play will show up here.");
    return;
  }
  const list = el("history-list");
  list.textContent = "";
  // Period headers ("Today", …) come with the data but aren't rendered —
  // one flat, uncluttered list reads better in a popup this size.
  for (const section of history.sections) {
    for (const item of section.items) list.append(buildTrackRow(item));
  }
}

// Track row shared by the History and Search tabs: click plays (with the
// item's own queue context), hover exposes Play next.
function buildTrackRow(item) {
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
    });
    actions.append(button);
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

// ---- search (songs only) ----

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
    searchNote("Search failed — try again.");
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
// Library playlists → drill into tracks. Rows offer "play all" and "add the
// currently playing song" (edit_playlist via the bridge).

let playlistsLoaded = false;
let playlistDetailId = null; // browseId the detail view shows (stale guard)

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
    noteInto(list, "Couldn’t load playlists — are you signed in?");
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
        "Play playlist",
        "#i-play",
        () => {
          send("playPlaylist", { playlistId: pl.id });
          armQueueSwitch(null); // no videoId to confirm; the fallback switches
        },
      ],
      [
        "Add current song",
        "#i-plus",
        () => {
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
    row.addEventListener("click", () => openPlaylist(pl));
    list.append(row);
  }
}

function openPlaylist(pl) {
  playlistDetailId = pl.id;
  el("playlists-list").hidden = true;
  el("playlist-detail").hidden = false;
  el("playlist-title").textContent = pl.title;
  noteInto(el("playlist-tracks"), "Loading tracks…");
  port?.postMessage({ type: "getPlaylistTracks", browseId: pl.id });
}

function renderPlaylistTracks(msg) {
  if (msg.browseId !== playlistDetailId) return; // navigated away meanwhile
  const list = el("playlist-tracks");
  if (!msg.tracks) {
    noteInto(list, "Couldn’t load this playlist.");
    return;
  }
  if (!msg.tracks.length) {
    noteInto(list, "This playlist is empty.");
    return;
  }
  list.textContent = "";
  for (const item of msg.tracks) list.append(buildTrackRow(item));
}

el("playlist-back").addEventListener("click", () => {
  playlistDetailId = null;
  el("playlist-detail").hidden = true;
  el("playlists-list").hidden = false;
});

// ---- lyrics (LRCLIB) ----
// Opt-in (sends title/artist to lrclib.net), official songs only. Synced
// entries get a live highlight + click-to-seek; the highlighted line is the
// one with the CLOSEST timestamp, which halves the average error when the
// community timing is offset from YTM's version of a track.

const LYRICS_TYPES = new Set(["MUSIC_VIDEO_TYPE_ATV", "MUSIC_VIDEO_TYPE_OMV"]);

let lyricsEnabled = null; // null = not read from storage yet
let lyricsKey = null; // track the pane currently reflects
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
  button.addEventListener("click", async () => {
    lyricsEnabled = true;
    try {
      await ext.storage.local.set({ lyricsEnabled: true });
    } catch {
      // session-only enable
    }
    renderLyrics();
  });
  pane.append(note, button);
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
  // Closest timestamp wins — not "last line started" — so a constant timing
  // offset in the source is only ever half a line-gap wrong.
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
  // The background script fetches and caches; usually the content script has
  // already prefetched on song start, making this an instant cache hit.
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

// After a history play, jump to the Queue tab only once the picked song is
// confirmed playing (state echoes its videoId) AND a fresh queue push landed —
// a fixed delay raced YTM's queue rebuild. Fallback fires in case the id
// never echoes (e.g. the bridge used its raw-player fallback).
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
  el("autoplay-toggle").hidden = name !== "queue" || lastAutoplay === null;
  if (name === "history") requestHistory();
  if (name === "lyrics") renderLyrics();
  if (name === "search") el("search-input").focus();
  if (name === "playlists") requestPlaylists();
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
}

async function connect() {
  const tabs = await ext.tabs.query({ url: "https://music.youtube.com/*" });
  const tab = tabs.find((t) => t.audible) ?? tabs[0];
  if (!tab) {
    showEmpty();
    return;
  }
  currentTabId = tab.id;
  try {
    port = ext.tabs.connect(tab.id, { name: "popup" });
  } catch {
    showEmpty();
    return;
  }
  port.onMessage.addListener((msg) => {
    if (msg.type === "state") {
      if (queueSwitchVideoId && msg.state.available && msg.state.videoId === queueSwitchVideoId) {
        queueSwitchLoaded = true;
      }
      render(msg.state);
    } else if (msg.type === "queue") {
      // Autoplay state first — renderQueue keys the suggestions section on it.
      updateAutoplayToggle(msg.autoplay);
      renderQueue(msg.queue);
      if (queueSwitchLoaded && msg.queue.some((item) => item.selected)) doQueueSwitch();
    } else if (msg.type === "history") renderHistory(msg.history);
    else if (msg.type === "searchResults") renderSearchResults(msg);
    else if (msg.type === "playlists") renderPlaylists(msg.playlists);
    else if (msg.type === "playlistTracks") renderPlaylistTracks(msg);
    else if (msg.type === "addToPlaylistResult") {
      showToast(msg.ok ? `Added to ${msg.name}.` : "Couldn’t add to that playlist.");
      if (msg.ok) {
        // Refresh so track counts (and the open detail view) match reality.
        requestPlaylists(true);
        if (playlistDetailId === msg.playlistId) {
          port?.postMessage({ type: "getPlaylistTracks", browseId: msg.playlistId });
        }
      }
    }
    else if (msg.type === "notice") showToast(msg.text);
  });
  port.postMessage({ type: "getQueue" });
  port.onDisconnect.addListener(() => {
    port = null;
    showEmpty();
  });
}

connect();
refreshSleep();
