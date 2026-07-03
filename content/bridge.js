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
      // Give YTM a beat to process the clicked item before closing the menu;
      // an instant close can cancel the service action.
      await new Promise((resolve) => setTimeout(resolve, 200));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.body.click();
      setTimeout(() => veil.remove(), 250);
    }
  }

  // The add/remove library menu items share one icon; only the localized text
  // differs. The Polymer data object carries language-independent iconTypes
  // (e.g. LIBRARY_ADD) plus both text variants — comparing the rendered text
  // against defaultText reveals which state is currently shown.
  // Both library states render the SAME bookmark icon (path M14.25 1.5…), so
  // the icon identifies the item but not the state. Polymer data is
  // unreadable on current builds, so the state comes from keyword-matching
  // the localized label.
  const LIBRARY_ICON = 'path[d^="M14.25 1.5"]';
  const REMOVE_WORDS =
    /odstranit|odebrat|remove|entfernen|supprimer|retirer|eliminar|quitar|rimuovi|remover|usuń|verwijder|ta bort|poista|fjern|удалить|убрать|削除|삭제|移除|删除/i;
  const ADD_WORDS =
    /uložit|přidat|save|add|speichern|hinzufügen|enregistrer|ajouter|guardar|añadir|agregar|salva|aggiungi|salvar|adicionar|zapisz|dodaj|opslaan|toevoegen|spara|lägg till|tallenna|lisää|lagre|legg til|сохранить|добавить|保存|追加|저장|추가/i;

  function libraryStateFromText(text) {
    if (REMOVE_WORDS.test(text)) return true;
    if (ADD_WORDS.test(text)) return false;
    return null;
  }

  // Menu rendered at all? (distinguishes "not ready yet" from "no library
  // item exists" — user uploads have no library action, only liked/pin
  // toggles, and clicking those by mistake acts like a like button)
  function menuRendered() {
    return document.querySelector("ytmusic-menu-popup-renderer [role='menuitem']") !== null;
  }

  function findLibrary() {
    const toggles = [...document.querySelectorAll("ytmusic-toggle-menu-service-item-renderer")];
    const item = toggles.find((t) => t.querySelector(LIBRARY_ICON)) ?? null;
    if (!item) return null;
    const shownText = item.querySelector("yt-formatted-string.text")?.textContent?.trim() ?? "";

    // Prefer Polymer data when a build exposes it; fall back to keywords.
    let inLibrary = null;
    const data = item.data ?? item.__data?.data ?? null;
    const defaultIcon = data?.defaultIcon?.iconType ?? "";
    if (defaultIcon.includes("LIBRARY")) {
      const defaultText = (data?.defaultText?.runs ?? []).map((r) => r.text).join("").trim();
      const showingDefault = shownText !== "" && shownText === defaultText;
      const defaultIsAdd = defaultIcon.includes("ADD");
      inLibrary = showingDefault ? !defaultIsAdd : defaultIsAdd;
    } else {
      inLibrary = libraryStateFromText(shownText);
    }
    console.debug("[YTM Companion] library item:", JSON.stringify(shownText), "→ inLibrary:", inLibrary);
    return { item, inLibrary };
  }

  const probeLibrary = () =>
    withHiddenMenu(() => {
      if (!menuRendered()) return null;
      const found = findLibrary();
      return { available: Boolean(found), inLibrary: found?.inLibrary ?? null };
    });

  const toggleLibrary = () =>
    withHiddenMenu(() => {
      if (!menuRendered()) return null;
      const found = findLibrary();
      if (!found) return { available: false, inLibrary: null };
      found.item.click();
      console.debug("[YTM Companion] library toggled, was:", found.inLibrary);
      return {
        available: true,
        inLibrary: found.inLibrary === null ? null : !found.inLibrary,
      };
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
