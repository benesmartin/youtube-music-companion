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

// Radio replaces the queue in the existing tab; no need to focus it.
el("radio").addEventListener("click", () => {
  const id = lastState?.videoId;
  if (!id || currentTabId === null) return;
  ext.tabs.update(currentTabId, { url: `${YTM_BASE}watch?v=${id}&list=RDAMVM${id}` });
});

el("copy-link").addEventListener("click", async () => {
  const id = lastState?.videoId;
  if (!id) return;
  await navigator.clipboard.writeText(`${YTM_BASE}watch?v=${id}`);
  el("copy-link").classList.add("copied");
  setTimeout(() => el("copy-link").classList.remove("copied"), 1500);
});

// Artist/album navigate the YTM tab and bring it into view.
async function openInTab(relativeUrl) {
  if (!relativeUrl || currentTabId === null) return;
  const tab = await ext.tabs.update(currentTabId, { url: YTM_BASE + relativeUrl, active: true });
  await ext.windows.update(tab.windowId, { focused: true });
  window.close();
}

el("artist").addEventListener("click", () => openInTab(lastState?.artistUrl));
el("album").addEventListener("click", () => openInTab(lastState?.albumUrl));

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
