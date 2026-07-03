// Runs in the PAGE context (injected by content.js), where YTM's internal
// player API is reachable. Talks to the content script via window.postMessage.
// Keep this layer as thin as possible — it's the first thing to break when
// YTM changes internals.

(() => {
  const FROM_BRIDGE = "ytmc-bridge";
  const FROM_CONTENT = "ytmc-content";

  const player = () => document.getElementById("movie_player");

  function postVolume() {
    const p = player();
    if (!p?.getVolume) return;
    window.postMessage(
      { source: FROM_BRIDGE, type: "volume", volume: p.getVolume(), muted: p.isMuted() },
      window.location.origin
    );
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== FROM_CONTENT) return;
    const p = player();
    if (!p) return;
    const { command, payload } = e.data;
    if (command === "setVolume") {
      p.setVolume(Math.min(100, Math.max(0, payload.volume)));
      postVolume();
    } else if (command === "toggleMute") {
      p.isMuted() ? p.unMute() : p.mute();
      postVolume();
    }
  });

  // The player element may not exist yet at document_idle.
  const poll = setInterval(() => {
    const p = player();
    if (!p?.addEventListener) return;
    clearInterval(poll);
    p.addEventListener("onVolumeChange", postVolume);
    postVolume();
  }, 500);
})();
