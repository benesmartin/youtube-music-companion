// Routes keyboard shortcuts (manifest "commands") to the YouTube Music tab.
// Must stay service-worker-safe for Chrome: no DOM, no persistent state.

const ext = globalThis.browser ?? globalThis.chrome;

const SHORTCUT_COMMANDS = {
  "play-pause": "playPause",
  "next-track": "next",
  "previous-track": "previous",
  "toggle-like": "toggleLike",
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

async function setIndicator(indicator) {
  if (indicator === currentIndicator) return;
  currentIndicator = indicator;
  try {
    const imageData = {};
    for (const size of [16, 32]) {
      const response = await fetch(ext.runtime.getURL(`icons/icon${size}.png`));
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext("2d");
      // Badge look: icon shrunk toward bottom-left, dot riding its top-right
      // corner — half on the icon, half beside it.
      const scale = 0.84;
      ctx.drawImage(bitmap, 0, size * (1 - scale), size * scale, size * scale);
      const radius = Math.max(3, Math.round(size * 0.21));
      ctx.beginPath();
      ctx.arc(size - radius - 0.5, radius + 0.5, radius, 0, Math.PI * 2);
      ctx.fillStyle = DOT_COLORS[indicator] ?? DOT_COLORS.none;
      ctx.fill();
      ctx.lineWidth = Math.max(1, size / 16);
      ctx.strokeStyle = "#1a1a1a";
      ctx.stroke();
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    await ext.action.setIcon({ imageData });
  } catch {
    // Canvas unavailable — leave the static icon.
  }
}

ext.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "playbackState") setIndicator(msg.indicator);
});

// No YTM tab left → back to the disconnected dot. The closing/navigating
// tab can still show up in tabs.query for a moment, so exclude it by id.
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
