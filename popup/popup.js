// Popup UI. Connects to the content script in the YouTube Music tab over a
// long-lived port and re-renders whenever it pushes fresh state.

const ext = globalThis.browser ?? globalThis.chrome;

const el = (id) => document.getElementById(id);
const playerView = el("player");
const emptyView = el("empty");

const YTM_BASE = "https://music.youtube.com/";

let port = null;
let seeking = false;
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

function render(state) {
  if (!state.available) {
    showEmpty();
    return;
  }
  playerView.hidden = false;
  emptyView.hidden = true;

  // A track change invalidates any in-flight drag: without this, releasing
  // the seek slider just after a transition seeks the NEW song to its end.
  const track = `${state.title}|${state.artist}`;
  if (track !== currentTrack) {
    currentTrack = track;
    seeking = false;
  }

  el("title").textContent = state.title;
  el("title").title = state.title;
  el("artist").textContent = state.artist;
  const album = state.album ? `${state.album}${state.year ? ` • ${state.year}` : ""}` : "";
  el("album").textContent = album;
  el("album").hidden = !album;

  lastState = state;
  el("artist").classList.toggle("link", Boolean(state.artistUrl));
  el("album").classList.toggle("link", Boolean(state.albumUrl));
  el("radio").disabled = !state.videoId;
  el("copy-link").disabled = !state.videoId;
  el("library").disabled = !state.videoId;
  el("copy-info").disabled = !state.title;

  // Library reflects the probed state; "Add" is the default until known.
  el("library").classList.toggle("in", state.inLibrary === true);
  el("library-label").textContent =
    state.inLibrary === true ? "Remove from library" : "Add to library";
  if (!el("more-menu").hidden) updateOverflowTitles();
  if (el("artwork").src !== state.artwork) el("artwork").src = state.artwork;

  el("play-pause").classList.toggle("playing", state.playing);
  el("like").classList.toggle("active", state.liked);
  el("dislike").classList.toggle("active", state.disliked);
  el("mute").classList.toggle("muted", state.muted);
  el("repeat").classList.toggle("active", state.repeat === "all" || state.repeat === "one");
  el("repeat").classList.toggle("one", state.repeat === "one");

  el("position").textContent = formatTime(state.position);
  el("duration").textContent = formatTime(state.duration);
  if (!seeking) {
    el("seek").max = Math.max(1, Math.floor(state.duration));
    el("seek").value = Math.floor(state.position);
    updateFill(el("seek"));
  }
  el("volume").value = state.muted ? 0 : state.volume;
  updateFill(el("volume"));
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

el("volume").addEventListener("input", () => {
  send("setVolume", { volume: Number(el("volume").value) });
  updateFill(el("volume"));
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
  el("sleep-active").hidden = !alarm;
  if (alarm) el("sleep-remaining").textContent = `Pausing in ${minutes} min`;
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
  el("sleep-active").hidden = false;
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
  el("sleep-active").hidden = true;
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
    if (msg.type === "state") render(msg.state);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    showEmpty();
  });
}

connect();
refreshSleep();
