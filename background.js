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
