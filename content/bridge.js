// Runs in the PAGE context (injected by content.js), where YTM's internal
// player API is reachable. Talks to the content script via window.postMessage.
// Keep this layer as thin as possible — it's the first thing to break when
// YTM changes internals.

(() => {
  const FROM_BRIDGE = "ytmc-bridge";
  const FROM_CONTENT = "ytmc-content";

  const player = () => document.getElementById("movie_player");
  const volumeSlider = () => document.querySelector("ytmusic-player-bar #volume-slider");

  function postStatus() {
    const p = player();
    if (!p?.getVolume) return;
    window.postMessage(
      {
        source: FROM_BRIDGE,
        type: "status",
        volume: p.getVolume(),
        muted: p.isMuted(),
        // -1 unstarted, 1 playing, 2 paused, 3 buffering, 5 cued
        playerState: p.getPlayerState?.() ?? null,
        videoId: p.getVideoData?.()?.video_id ?? null,
      },
      window.location.origin
    );
  }

  // YTM's app state lives in its volume slider, not in the movie_player API —
  // setVolume() alone changes the audio but the app overwrites it later. Drive
  // the slider like a user would and let YTM propagate it everywhere itself.
  function setVolume(value) {
    const clamped = Math.min(100, Math.max(0, value));
    const slider = volumeSlider();
    if (slider) {
      slider.value = clamped;
      slider.dispatchEvent(new CustomEvent("change", { bubbles: true, composed: true }));
    } else {
      player()?.setVolume?.(clamped);
    }
    postStatus();
  }

  // ---- library toggle (needs Polymer element data, page-context only) ----

  // Menu automations must never overlap: a second menuButton.click() while
  // a probe holds the menu open would close it and kill both operations.
  let menuBusy = Promise.resolve();
  function withHiddenMenu(worker) {
    const run = menuBusy.then(() => runWithHiddenMenu(worker));
    menuBusy = run.catch(() => {});
    return run;
  }

  async function runWithHiddenMenu(worker) {
    const menuButton = document.querySelector(
      "ytmusic-player-bar ytmusic-menu-renderer #button-shape button"
    );
    if (!menuButton) return null;
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
      return null;
    } finally {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.body.click();
      setTimeout(() => veil.remove(), 250);
    }
  }

  // The add/remove library menu items share one icon; only the localized text
  // differs. The Polymer data object carries language-independent iconTypes
  // (e.g. LIBRARY_ADD) plus both text variants — comparing the rendered text
  // against defaultText reveals which state is currently shown.
  function findLibrary() {
    const toggles = [...document.querySelectorAll("ytmusic-toggle-menu-service-item-renderer")];
    for (const item of toggles) {
      const data = item.data ?? item.__data?.data ?? null;
      const defaultIcon = data?.defaultIcon?.iconType ?? "";
      const toggledIcon = data?.toggledIcon?.iconType ?? "";
      if (!defaultIcon.includes("LIBRARY") && !toggledIcon.includes("LIBRARY")) continue;
      const shownText = item.querySelector("yt-formatted-string.text")?.textContent?.trim() ?? "";
      const defaultText = (data?.defaultText?.runs ?? []).map((r) => r.text).join("").trim();
      const showingDefault = shownText !== "" && shownText === defaultText;
      const defaultIsAdd = defaultIcon.includes("ADD");
      return { item, inLibrary: showingDefault ? !defaultIsAdd : defaultIsAdd };
    }
    if (toggles.length) {
      // Data unreadable on this build: assume the first toggle is the library
      // entry (holds in all observed menus) but report the state as unknown.
      console.debug("[YTM Companion] library data unreadable, using first toggle of", toggles.length);
      return { item: toggles[0], inLibrary: null };
    }
    return null;
  }

  const probeLibrary = () =>
    withHiddenMenu(() => {
      const found = findLibrary();
      return found ? { inLibrary: found.inLibrary } : null;
    });

  const toggleLibrary = () =>
    withHiddenMenu(() => {
      const found = findLibrary();
      if (!found) return null;
      found.item.click();
      console.debug("[YTM Companion] library toggled, was:", found.inLibrary);
      return { inLibrary: found.inLibrary === null ? null : !found.inLibrary };
    });

  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.data?.source !== FROM_CONTENT) return;
    const { command, payload, requestId } = e.data;
    if (command === "setVolume") {
      setVolume(payload.volume);
    } else if (command === "toggleMute") {
      const p = player();
      if (!p) return;
      p.isMuted() ? p.unMute() : p.mute();
      postStatus();
    } else if (command === "seekTo") {
      player()?.seekTo?.(payload.position, true);
    } else if (command === "probeLibrary" || command === "toggleLibrary") {
      const result = command === "probeLibrary" ? await probeLibrary() : await toggleLibrary();
      window.postMessage(
        { source: FROM_BRIDGE, type: "response", requestId, result: result ?? null },
        window.location.origin
      );
    }
  });

  // The player element may not exist yet at document_idle.
  const poll = setInterval(() => {
    const p = player();
    if (!p?.addEventListener) return;
    clearInterval(poll);
    p.addEventListener("onVolumeChange", postStatus);
    p.addEventListener("onStateChange", postStatus);
    postStatus();
  }, 500);
})();
