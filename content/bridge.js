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

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Autoplay-policy workaround: normal play → muted play (always allowed) →
  // unmute. Some browsers re-block on the unmute; report honestly.
  async function forcePlay() {
    const p = player();
    const media = document.querySelector("video");
    if (!p?.playVideo || !media) return false;
    p.playVideo();
    await wait(350);
    if (!media.paused) return true;

    media.muted = true;
    p.playVideo();
    await wait(450);
    if (media.paused) {
      media.muted = false;
      return false;
    }
    media.muted = false;
    await wait(350);
    if (media.paused || media.muted) {
      // Unmute got re-blocked — don't leave it playing silently.
      p.pauseVideo?.();
      media.muted = false;
      return false;
    }
    postStatus();
    return true;
  }

  // Play through the app router (yt-navigate) so the whole UI — player bar,
  // queue, watch page — follows along; loadVideoById alone switches the audio
  // but leaves the app frozen on the previous track.
  async function playVideo({ videoId, playlistId, params } = {}) {
    if (!videoId) return false;
    const app = document.querySelector("ytmusic-app");
    if (app) {
      const watchEndpoint = { videoId };
      if (playlistId) watchEndpoint.playlistId = playlistId;
      if (params) watchEndpoint.params = params;
      app.dispatchEvent(
        new CustomEvent("yt-navigate", {
          bubbles: true,
          composed: true,
          detail: { endpoint: { watchEndpoint } },
        })
      );
      for (let attempt = 0; attempt < 10; attempt++) {
        await wait(150);
        if (player()?.getVideoData?.()?.video_id === videoId) return true;
      }
    }
    // Fallback: raw player API — at least the audio switches.
    const p = player();
    if (!p?.loadVideoById) return false;
    p.loadVideoById(videoId);
    return true;
  }

  function queueRendererOf(entry) {
    return (
      entry?.playlistPanelVideoRenderer ??
      entry?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer ??
      null
    );
  }

  // "Play next" for a track that is NOT in the queue (history rows): there is
  // no per-row menu to click, so resolve the track's queue renderer via the
  // internal get_queue endpoint and insert it after the current item straight
  // into the app's queue store.
  async function queueVideoNext(videoId) {
    if (!videoId) return false;
    const store = document.querySelector("ytmusic-player-queue")?.queue?.store?.store;
    if (!store?.dispatch || !store?.getState) return false;
    const data = await innertubeRequest("music/get_queue", { videoIds: [videoId] });
    const items = (data?.queueDatas ?? []).map((d) => d?.content).filter(Boolean);
    if (!items.length) return false;
    const state = store.getState()?.queue;
    const existing = state?.items ?? [];
    const currentId = player()?.getVideoData?.()?.video_id ?? null;
    const currentIndex = existing.findIndex((e) => queueRendererOf(e)?.videoId === currentId);
    try {
      store.dispatch({
        type: "ADD_ITEMS",
        payload: {
          nextQueueItemId: state?.nextQueueItemId,
          index: currentIndex >= 0 ? currentIndex + 1 : existing.length,
          items,
          shuffleEnabled: false,
          shouldAssignIds: true,
        },
      });
    } catch (err) {
      console.debug("[YTM Companion] queue insert failed:", err);
      return false;
    }
    // The dispatch is fire-and-forget; report success only if the queue grew.
    return (store.getState()?.queue?.items?.length ?? 0) > existing.length;
  }

  // The queue element's data store knows every item's thumbnail URL and
  // videoId even when the DOM images haven't lazy-loaded yet.
  function readQueueData() {
    const queueEl = document.querySelector("ytmusic-player-queue");
    let items = null;
    try {
      items = queueEl?.queue?.getItems?.() ?? null;
    } catch {
      // fall through to store access
    }
    if (!Array.isArray(items)) {
      try {
        items = queueEl?.queue?.store?.store?.getState?.()?.queue?.items ?? null;
      } catch {
        items = null;
      }
    }
    if (!Array.isArray(items)) {
      console.debug("[YTM Companion] queue data store unreadable");
      return null;
    }
    return items.map((entry) => {
      const renderer = queueRendererOf(entry);
      // Wrapped (video-with-song) entries sometimes only carry a thumbnail
      // on the hidden counterpart renderer.
      const counterpart =
        entry?.playlistPanelVideoWrapperRenderer?.counterpart?.[0]?.counterpartRenderer
          ?.playlistPanelVideoRenderer ?? null;
      const thumbs =
        renderer?.thumbnail?.thumbnails ?? counterpart?.thumbnail?.thumbnails ?? [];
      return {
        videoId: renderer?.videoId ?? null,
        title: (renderer?.title?.runs ?? []).map((run) => run.text).join(""),
        thumb: thumbs.length ? thumbs[thumbs.length - 1].url : "",
      };
    });
  }

  // ---- internal API plumbing ----

  // Internal ("InnerTube") endpoints are called from the page context so they
  // reuse YTM's own config (ytcfg) and cookies; the only extra requirement is
  // the SAPISIDHASH Authorization header Google demands on
  // cookie-authenticated API requests.
  const cfgGet = (key) => window.ytcfg?.get?.(key) ?? window.ytcfg?.data_?.[key];

  async function sapisidHash() {
    const match = document.cookie.match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/);
    if (!match) return null; // signed out — there is no account history
    const ts = Math.floor(Date.now() / 1000);
    const input = new TextEncoder().encode(`${ts} ${match[1]} ${location.origin}`);
    const digest = await crypto.subtle.digest("SHA-1", input);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return `SAPISIDHASH ${ts}_${hex}`;
  }

  async function innertubeRequest(path, body) {
    const context = cfgGet("INNERTUBE_CONTEXT");
    if (!context) return null;
    const headers = { "content-type": "application/json", "x-origin": location.origin };
    const auth = await sapisidHash();
    if (auth) {
      headers.authorization = auth;
      // multi-account sessions break without the right account index
      headers["x-goog-authuser"] = String(cfgGet("SESSION_INDEX") ?? "0");
    }
    const key = cfgGet("INNERTUBE_API_KEY");
    const url = `/youtubei/v1/${path}?prettyPrint=false${key ? `&key=${encodeURIComponent(key)}` : ""}`;
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context, ...body }),
    });
    if (!res.ok) return null;
    return res.json();
  }

  // ---- account history (the real music.youtube.com/history data) ----

  const columnText = (column) =>
    (column?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [])
      .map((run) => run.text)
      .join("");

  // For plain YouTube videos the artist column carries extra runs
  // ("Channel • 1.4M views • today") — keep the linked artist/channel runs
  // and drop the stats; fall back to the text before the first bullet.
  function artistText(column) {
    const runs = column?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [];
    const linked = runs.filter((run) => run.navigationEndpoint).map((run) => run.text);
    if (linked.length) return linked.join(", ");
    return runs.map((run) => run.text).join("").split("•")[0].trim();
  }

  function parseHistoryItem(entry) {
    const renderer = entry?.musicResponsiveListItemRenderer;
    if (!renderer) return null;
    const thumbs = renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? [];
    // The play overlay carries the full watch endpoint; playlistId/params make
    // playback build the same autoplay queue as clicking the history page.
    const endpoint =
      renderer.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
        ?.playNavigationEndpoint?.watchEndpoint ?? null;
    return {
      videoId: renderer.playlistItemData?.videoId ?? endpoint?.videoId ?? null,
      playlistId: endpoint?.playlistId ?? null,
      params: endpoint?.params ?? null,
      title: columnText(renderer.flexColumns?.[0]),
      artist: artistText(renderer.flexColumns?.[1]),
      duration:
        renderer.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]
          ?.text ?? "",
      thumb: thumbs.length ? thumbs[thumbs.length - 1].url : "",
    };
  }

  async function fetchHistory() {
    try {
      if (!(await sapisidHash())) return { signedOut: true, sections: [] };
      const data = await innertubeRequest("browse", { browseId: "FEmusic_history" });
      if (!data) return null;
      const shelves =
        data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
          ?.sectionListRenderer?.contents ?? [];
      const sections = [];
      for (const shelf of shelves) {
        const renderer = shelf?.musicShelfRenderer;
        if (!renderer) continue;
        const items = (renderer.contents ?? []).map(parseHistoryItem).filter((i) => i?.title);
        if (!items.length) continue;
        sections.push({
          // localized period header: "Today", "Yesterday", month names, …
          header: (renderer.title?.runs ?? []).map((run) => run.text).join(""),
          items,
        });
      }
      return { signedOut: false, sections };
    } catch (err) {
      console.debug("[YTM Companion] history fetch failed:", err);
      return null;
    }
  }

  window.addEventListener("message", async (e) => {
    if (e.source !== window || e.data?.source !== FROM_CONTENT) return;
    const { command, payload, requestId } = e.data;
    if (command === "forcePlay") {
      const result = await forcePlay();
      window.postMessage(
        { source: FROM_BRIDGE, type: "response", requestId, result },
        window.location.origin
      );
      return;
    }
    if (command === "playVideoById") {
      const result = await playVideo(payload);
      window.postMessage(
        { source: FROM_BRIDGE, type: "response", requestId, result },
        window.location.origin
      );
      return;
    }
    if (command === "queueVideoNext") {
      const result = await queueVideoNext(payload.videoId);
      window.postMessage(
        { source: FROM_BRIDGE, type: "response", requestId, result },
        window.location.origin
      );
      return;
    }
    if (command === "getHistory") {
      const result = await fetchHistory();
      window.postMessage(
        { source: FROM_BRIDGE, type: "response", requestId, result },
        window.location.origin
      );
      return;
    }
    if (command === "getQueueData") {
      window.postMessage(
        { source: FROM_BRIDGE, type: "response", requestId, result: readQueueData() },
        window.location.origin
      );
      return;
    }
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
