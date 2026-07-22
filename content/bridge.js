// Runs in the PAGE context (injected by content.js), where YTM's internal
// player API is reachable. Talks to the content script via window.postMessage.
// Keep this layer as thin as possible - it's the first thing to break when
// YTM changes internals.

(() => {
  const FROM_BRIDGE = "ytmc-bridge";
  const FROM_CONTENT = "ytmc-content";

  // Reloads inject fresh copies while old ones keep listening - only the
  // newest generation may act.
  const generation = (window.__ytmcBridgeGeneration =
    (window.__ytmcBridgeGeneration ?? 0) + 1);
  const isCurrent = () => window.__ytmcBridgeGeneration === generation;

  const player = () => document.getElementById("movie_player");
  const volumeSlider = () => document.querySelector("ytmusic-player-bar #volume-slider");

  function postStatus() {
    const p = player();
    if (!isCurrent() || !p?.getVolume) return;
    window.postMessage(
      {
        source: FROM_BRIDGE,
        type: "status",
        volume: p.getVolume(),
        muted: p.isMuted(),
        // -1 unstarted, 1 playing, 2 paused, 3 buffering, 5 cued
        playerState: p.getPlayerState?.() ?? null,
        videoId: p.getVideoData?.()?.video_id ?? null,
        // ATV = album track, OMV = official video, UGC = plain upload
        videoType: p.getPlayerResponse?.()?.videoDetails?.musicVideoType ?? null,
      },
      window.location.origin
    );
  }

  // App state lives in the volume slider; setVolume() alone gets snapped back.
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

  // Menu automations must not overlap - a second open kills both.
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
      // A beat before closing, or the clicked action gets cancelled.
      await new Promise((resolve) => setTimeout(resolve, 200));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      document.body.click();
      setTimeout(() => veil.remove(), 250);
    }
  }

  // Both library states share one bookmark icon; state comes from Polymer
  // data when readable, else from keyword-matching the localized label.
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

  // Distinguishes "menu not ready" from "no library item" (user uploads).
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
      return {
        available: true,
        inLibrary: found.inLibrary === null ? null : !found.inLibrary,
      };
    });

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Autoplay workaround: play → muted play → unmute; report re-blocks honestly.
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
      // Unmute got re-blocked - don't leave it playing silently.
      p.pauseVideo?.();
      media.muted = false;
      return false;
    }
    postStatus();
    return true;
  }

  // yt-navigate keeps the whole app in sync - but with a pre-existing queue
  // YTM sometimes HALF-applies it: the player swaps the audio while the
  // queue/watch page never rebuild (the stale-UI desync). So success means
  // the player switched AND the queue changed; anything less falls back to
  // a real watch navigation, which reloads the page but always lands
  // coherent.
  // YTM resumes history plays mid-track (position persists server-side);
  // an explicit play should start at the top. The resume seek can land a
  // couple of seconds AFTER playback starts, and countering it with a
  // plain seek-to-0 replayed whatever the user already heard (an audible
  // "restart"). Watch for the forward JUMP instead and put playback back
  // where it was - 0 before any audio, otherwise a near-seamless continue.
  async function restartIfResumed() {
    let heard = 0;
    for (let attempt = 0; attempt < 50; attempt++) {
      const t = player()?.getCurrentTime?.() ?? 0;
      if (t > heard + 5) {
        player()?.seekTo?.(heard, true);
      } else if (t > heard) {
        heard = t;
      }
      await wait(100);
    }
  }

  async function playVideo({ videoId, playlistId, params, videoType } = {}) {
    if (!videoId) return false;
    // Watch the HIGHLIGHTED row, not the queue order - a restored queue
    // hydrating its automix continuations changes the order without any
    // navigation, which read as success while the app stayed stale.
    const highlightIds = () => {
      const state = document.querySelector("ytmusic-player-queue")?.queue?.store?.store
        ?.getState()?.queue;
      const combined = (state?.items ?? []).concat(state?.automixItems ?? []);
      const entry = combined[currentQueueIndex(state, null)];
      const counterpart =
        entry?.playlistPanelVideoWrapperRenderer?.counterpart?.[0]?.counterpartRenderer
          ?.playlistPanelVideoRenderer;
      return [queueRendererOf(entry)?.videoId, counterpart?.videoId].filter(Boolean);
    };
    const app = document.querySelector("ytmusic-app");
    if (app) {
      const before = highlightIds().join();
      // startTimeSeconds asks for a fresh start outright; the watcher below
      // still guards against a late server-side resume seek. The music
      // config block is what native endpoints carry - WITHOUT it the router
      // half-applies the event in some states (audio swaps, queue stays),
      // the root of the whole desync family. ATV fits song rows by default.
      const watchEndpoint = {
        videoId,
        startTimeSeconds: 0,
        watchEndpointMusicSupportedConfigs: {
          watchEndpointMusicConfig: {
            musicVideoType: videoType || "MUSIC_VIDEO_TYPE_ATV",
          },
        },
      };
      if (playlistId) watchEndpoint.playlistId = playlistId;
      if (params) watchEndpoint.params = params;
      // Some queue states HALF-apply the first dispatch (audio switches,
      // queue stays) but complete on a second identical one - retry ONCE,
      // then reload. More rounds just delay the inevitable (measured: a
      // stuck state cost 5s before the fallback even started).
      let restartWatcher = false;
      for (let round = 0; round < 2; round++) {
        app.dispatchEvent(
          new CustomEvent("yt-navigate", {
            bubbles: true,
            composed: true,
            detail: { endpoint: { watchEndpoint } },
          })
        );
        for (let attempt = 0; attempt < (round === 0 ? 10 : 7); attempt++) {
          await wait(150);
          if (player()?.getVideoData?.()?.video_id !== videoId) continue;
          // The audio has swapped - start guarding against a resume seek
          // NOW, not after coherence (retries can add 1.5s+ of played-
          // from-the-middle audio otherwise).
          if (!restartWatcher) {
            restartWatcher = true;
            restartIfResumed();
          }
          // Success = the highlight moved onto our song (any rendition id
          // of the row) or onto a different row than before the dispatch.
          const now = highlightIds();
          if (now.includes(videoId) || (now.length && now.join() !== before)) return true;
        }
      }
    }
    // Pause first: YTM's leave-confirmation guards PLAYING music, and the
    // audio is being replaced anyway. Let the response reach the popup
    // before the page goes away. The marker tells the next bridge copy to
    // undo a mid-track resume.
    player()?.pauseVideo?.();
    const url = `${location.origin}/watch?v=${encodeURIComponent(videoId)}${
      playlistId ? `&list=${encodeURIComponent(playlistId)}` : ""
    }&ytmc_restart=1`;
    setTimeout(() => location.assign(url), 50);
    return true;
  }

  // Fallback navigations carry ytmc_restart: strip it, then make sure the
  // track starts from the top once playback begins.
  if (new URLSearchParams(location.search).has("ytmc_restart")) {
    const cleaned = new URL(location.href);
    cleaned.searchParams.delete("ytmc_restart");
    history.replaceState(history.state, "", cleaned.toString());
    (async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        await wait(250);
        if ((player()?.getCurrentTime?.() ?? 0) > 0) break;
      }
      await restartIfResumed();
    })();
  }

  function queueRendererOf(entry) {
    return (
      entry?.playlistPanelVideoRenderer ??
      entry?.playlistPanelVideoWrapperRenderer?.primaryRenderer?.playlistPanelVideoRenderer ??
      null
    );
  }

  function entryMatchesId(entry, videoId) {
    if (!videoId) return false;
    const counterpart =
      entry?.playlistPanelVideoWrapperRenderer?.counterpart?.[0]?.counterpartRenderer
        ?.playlistPanelVideoRenderer;
    return queueRendererOf(entry)?.videoId === videoId || counterpart?.videoId === videoId;
  }

  // Where the playing row sits in items[] + automixItems[] concatenated.
  // The DOM highlight leads: in the seed+automix queue shape the store's
  // selectedItemIndex and renderer `selected` flags lag one song behind the
  // actual playback (play-next landed right BEFORE the playing track), while
  // the highlighted row - which mirrors the combined store order - stays
  // live. videoId is unambiguous unless the same track is queued twice; the
  // store fields close out as fallbacks.
  function currentQueueIndex(state, currentId) {
    const combined = (state?.items ?? []).concat(state?.automixItems ?? []);
    const rows = [...document.querySelectorAll("ytmusic-player-queue-item")].filter(
      (row) => !row.closest("#counterpart-renderer")
    );
    const domIndex = rows.findIndex((row) => row.hasAttribute("selected"));
    if (domIndex >= 0 && domIndex < combined.length) return domIndex;
    const byId = combined.reduce(
      (found, entry, index) => (entryMatchesId(entry, currentId) ? [...found, index] : found),
      []
    );
    if (byId.length === 1) return byId[0];
    const live = state?.selectedItemIndex;
    if (Number.isInteger(live) && live >= 0 && live < combined.length) return live;
    const selected = combined.findIndex((entry) => {
      const counterpart =
        entry?.playlistPanelVideoWrapperRenderer?.counterpart?.[0]?.counterpartRenderer
          ?.playlistPanelVideoRenderer;
      return queueRendererOf(entry)?.selected === true || counterpart?.selected === true;
    });
    if (selected >= 0) return selected;
    return byId.length ? byId[0] : -1;
  }

  // Play-next / add-to-queue for out-of-queue tracks: get_queue renderer →
  // ADD_ITEMS, mirroring the captured native payload (no shuffleEnabled key).
  // atEnd appends after the last user item - the native "Add to queue" spot;
  // automix suggestions stay behind it.
  async function queueVideoNext(videoId, atEnd) {
    if (!videoId) return false;
    const store = document.querySelector("ytmusic-player-queue")?.queue?.store?.store;
    if (!store?.dispatch || !store?.getState) return false;
    const data = await innertubeRequest("music/get_queue", { videoIds: [videoId] });
    const items = (data?.queueDatas ?? []).map((d) => d?.content).filter(Boolean);
    if (!items.length) return false;
    const state = store.getState()?.queue;
    const currentId = player()?.getVideoData?.()?.video_id ?? null;
    const currentIndex = currentQueueIndex(state, currentId);
    const target = atEnd
      ? (state?.items?.length ?? 0)
      : currentIndex >= 0
        ? currentIndex + 1
        : (state?.items?.length ?? 0);
    try {
      store.dispatch({
        type: "ADD_ITEMS",
        payload: {
          nextQueueItemId: state?.nextQueueItemId,
          index: target,
          items,
          shouldAssignIds: true,
        },
      });
    } catch (err) {
      return false;
    }
    // Fire-and-forget dispatch; success = the song sits at the target spot
    // (growth alone would mask a misplaced insert).
    const after = store.getState()?.queue;
    const combined = (after?.items ?? []).concat(after?.automixItems ?? []);
    return entryMatchesId(combined[target], queueRendererOf(items[0])?.videoId ?? videoId);
  }

  // MOVE_ITEM only reaches queue.items - automix indices are rejected.
  async function queueMove(fromIndex, toIndex) {
    const store = document.querySelector("ytmusic-player-queue")?.queue?.store?.store;
    if (!store?.dispatch || !store?.getState) return false;
    const q = store.getState()?.queue;
    const itemCount = q?.items?.length ?? 0;
    if (
      !Number.isInteger(fromIndex) ||
      !Number.isInteger(toIndex) ||
      fromIndex === toIndex ||
      fromIndex >= itemCount ||
      toIndex >= itemCount
    ) {
      return false;
    }
    const order = (entries) =>
      (entries ?? []).map((entry) => queueRendererOf(entry)?.videoId ?? "").join();
    const before = order(q.items);
    try {
      store.dispatch({ type: "MOVE_ITEM", payload: { fromIndex, toIndex } });
    } catch (err) {
      return false;
    }
    // The dispatch is fire-and-forget; success = the order actually changed.
    return order(store.getState()?.queue?.items) !== before;
  }

  // The queue store knows thumbs/videoIds before DOM images lazy-load.
  function readQueueData() {
    const queueEl = document.querySelector("ytmusic-player-queue");
    let items = null;
    // automixItems holds radio continuations; getItems() omits them.
    try {
      const state =
        queueEl?.queue?.store?.store?.getState?.() ?? queueEl?.queue?.store?.getState?.();
      const q = state?.queue;
      if (q) items = [...(q.items ?? []), ...(q.automixItems ?? [])];
    } catch {
      // fall through to getItems
    }
    if (!Array.isArray(items) || !items.length) {
      try {
        items = queueEl?.queue?.getItems?.() ?? null;
      } catch {
        items = null;
      }
    }
    if (!Array.isArray(items) || !items.length) {
      // Store unreadable → player playlist; every videoId has a static thumb.
      const ids = player()?.getPlaylist?.() ?? null;
      if (Array.isArray(ids) && ids.length) {
        return ids.map((id) => ({
          videoId: id ?? null,
          title: "",
          thumb: id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : "",
        }));
      }
      return null;
    }
    // Prefer artist-linked runs; endpoint-less bylines alternate names with
    // localized "and" runs - drop separators, comma-join.
    const ARTIST_PAGE = /ARTIST|USER_CHANNEL/;
    const SEPARATOR_RUN = /^[\s ]*(•|,|&|\+|a|and|y|e|i|et|en|ve|und|och|og|ja|и)[\s ]*$/i;
    const linkedArtists = (byline) =>
      (byline?.runs ?? [])
        .filter((run) =>
          ARTIST_PAGE.test(
            run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
              ?.browseEndpointContextMusicConfig?.pageType ?? ""
          )
        )
        .map((run) => run.text);
    const bylineArtists = (renderer) => {
      const linked = linkedArtists(renderer?.shortBylineText).length
        ? linkedArtists(renderer?.shortBylineText)
        : linkedArtists(renderer?.longBylineText);
      if (linked.length) return linked.join(", ");
      const short = (renderer?.shortBylineText?.runs ?? []).map((run) => run.text);
      if (short.length > 1) {
        const names = short.filter((text) => !SEPARATOR_RUN.test(text));
        if (names.length) return names.join(", ");
      }
      return short.join("");
    };
    const mapped = items.map((entry) => {
      const renderer = queueRendererOf(entry);
      // Wrapped entries may only carry a thumb on the hidden counterpart.
      const counterpart =
        entry?.playlistPanelVideoWrapperRenderer?.counterpart?.[0]?.counterpartRenderer
          ?.playlistPanelVideoRenderer ?? null;
      const thumbs =
        renderer?.thumbnail?.thumbnails ?? counterpart?.thumbnail?.thumbnails ?? [];
      const videoId = renderer?.videoId ?? counterpart?.videoId ?? null;
      return {
        videoId,
        title: (renderer?.title?.runs ?? []).map((run) => run.text).join(""),
        artist: bylineArtists(renderer),
        thumb: thumbs.length
          ? thumbs[thumbs.length - 1].url
          : videoId
            ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
            : "",
      };
    });
    // Patch unrecognized renderers from the player playlist when aligned.
    const ids = player()?.getPlaylist?.() ?? null;
    if (Array.isArray(ids) && ids.length === mapped.length) {
      mapped.forEach((entry, i) => {
        if (!entry.videoId) entry.videoId = ids[i] ?? null;
        if (!entry.thumb && ids[i]) entry.thumb = `https://i.ytimg.com/vi/${ids[i]}/mqdefault.jpg`;
      });
    }
    return mapped;
  }

  // ---- internal API plumbing ----

  // Page context reuses ytcfg + cookies; SAPISIDHASH auths the calls.
  const cfgGet = (key) => window.ytcfg?.get?.(key) ?? window.ytcfg?.data_?.[key];

  async function sapisidHash() {
    const match = document.cookie.match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/);
    if (!match) return null; // signed out - there is no account history
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
    const sep = path.includes("?") ? "&" : "?";
    const url = `/youtubei/v1/${path}${sep}prettyPrint=false${key ? `&key=${encodeURIComponent(key)}` : ""}`;
    const res = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers,
      body: JSON.stringify({ context, ...body }),
    });
    if (!res.ok) return null;
    return res.json();
  }

  // ---- shared list-item parsing (history + search rows) ----

  const columnText = (column) =>
    (column?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [])
      .map((run) => run.text)
      .join("");

  // Byline mixes artists/album/views/date: prefer artist-page runs, then any
  // linked run, then text before the first bullet.
  function artistText(column) {
    const runs = column?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [];
    const pageTypeOf = (run) =>
      run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
        ?.browseEndpointContextMusicConfig?.pageType ?? "";
    const artists = runs
      .filter((run) => /ARTIST|USER_CHANNEL/.test(pageTypeOf(run)))
      .map((run) => run.text);
    if (artists.length) return artists.join(", ");
    const linked = runs.filter((run) => run.navigationEndpoint).map((run) => run.text);
    if (linked.length) return linked.join(", ");
    return runs.map((run) => run.text).join("").split("•")[0].trim();
  }

  function parseListItem(entry) {
    const renderer = entry?.musicResponsiveListItemRenderer;
    if (!renderer) return null;
    const thumbs = renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? [];
    // playlistId/params from the play overlay make playback build the proper queue.
    const endpoint =
      renderer.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
        ?.playNavigationEndpoint?.watchEndpoint ?? null;
    // YTM's own "Remove from playlist" menu entry carries the exact edit
    // payload - replay it verbatim instead of hand-building one. Rows
    // that can't be removed (other people's playlists, Liked Music)
    // simply don't have the entry.
    const removeEndpoint =
      (renderer.menu?.menuRenderer?.items ?? [])
        .map((item) => item?.menuServiceItemRenderer?.serviceEndpoint?.playlistEditEndpoint)
        .find((ep) =>
          // The action name is often absent in menu payloads - the
          // removedVideoId/setVideoId pair is what identifies removal.
          ep?.actions?.some(
            (a) =>
              a?.action === "ACTION_REMOVE_VIDEO_FROM_PLAYLIST" ||
              (a?.removedVideoId && a?.setVideoId)
          )
        ) ?? null;
    return {
      videoId: renderer.playlistItemData?.videoId ?? endpoint?.videoId ?? null,
      setVideoId: renderer.playlistItemData?.playlistSetVideoId ?? null,
      removeEndpoint,
      playlistId: endpoint?.playlistId ?? null,
      params: endpoint?.params ?? null,
      videoType:
        endpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig
          ?.musicVideoType ?? null,
      title: columnText(renderer.flexColumns?.[0]),
      artist: artistText(renderer.flexColumns?.[1]),
      duration:
        renderer.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]
          ?.text ??
        // Search rows keep the duration at the end of the byline instead.
        columnText(renderer.flexColumns?.[1]).match(/((?:\d+:)?\d+:\d{2})\s*$/)?.[1] ??
        "",
      thumb: thumbs.length ? thumbs[thumbs.length - 1].url : "",
    };
  }

  // ---- account history (the real music.youtube.com/history data) ----

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
        const items = (renderer.contents ?? []).map(parseListItem).filter((i) => i?.title);
        if (!items.length) continue;
        sections.push({
          // localized period header: "Today", "Yesterday", month names, …
          header: (renderer.title?.runs ?? []).map((run) => run.text).join(""),
          items,
        });
      }
      return { signedOut: false, sections };
    } catch (err) {
      return null;
    }
  }

  // ---- search (internal search API, same row shape as history) ----

  // Filter params as sent by YTM's own "Songs" / "Videos" chips.
  const SEARCH_FILTERS = {
    songs: "EgWKAQIIAWoMEA4QChADEAQQCRAF",
    videos: "EgWKAQIQAWoMEA4QChADEAQQCRAF",
  };

  async function searchFiltered(query, params) {
    const data = await innertubeRequest("search", { query, params });
    if (!data) return null;
    const shelves =
      data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
        ?.sectionListRenderer?.contents ?? [];
    const items = [];
    for (const shelf of shelves) {
      for (const entry of shelf?.musicShelfRenderer?.contents ?? []) {
        const item = parseListItem(entry);
        if (item?.title && item.videoId) items.push(item);
      }
    }
    return items;
  }

  async function searchMusic(query) {
    try {
      const [songs, videos] = await Promise.all([
        searchFiltered(query, SEARCH_FILTERS.songs),
        searchFiltered(query, SEARCH_FILTERS.videos),
      ]);
      if (!songs && !videos) return null;
      return { songs: songs ?? [], videos: videos ?? [] };
    } catch (err) {
      return null;
    }
  }

  // ---- playlists (library list, tracks, play, add-current) ----

  // Collects tiles; returns a continuation token if one rides along.
  function collectPlaylistItems(items, playlists) {
    let token = null;
    for (const item of items ?? []) {
      const riderToken =
        item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (riderToken) {
        token = riderToken;
        continue;
      }
      const renderer = item?.musicTwoRowItemRenderer;
      const browseId = renderer?.navigationEndpoint?.browseEndpoint?.browseId ?? "";
      // Skips the "New playlist" tile and non-playlist entries.
      if (!browseId.startsWith("VL")) continue;
      const thumbs =
        renderer.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? [];
      playlists.push({
        id: browseId,
        title: (renderer.title?.runs ?? []).map((run) => run.text).join(""),
        subtitle: (renderer.subtitle?.runs ?? []).map((run) => run.text).join(""),
        thumb: thumbs.length ? thumbs[thumbs.length - 1].url : "",
      });
    }
    return token;
  }

  async function getPlaylists() {
    try {
      if (!(await sapisidHash())) return { signedOut: true };
      const data = await innertubeRequest("browse", { browseId: "FEmusic_liked_playlists" });
      // Named failures instead of null - the popup logs them for reports
      // from setups we can't reproduce (Edge app windows, work profiles).
      if (!data) return { error: "liked_playlists browse returned nothing" };
      const sections =
        data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
          ?.sectionListRenderer?.contents ??
        data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer
          ?.contents ??
        [];
      const grid = sections.find((s) => s.gridRenderer)?.gridRenderer;
      const playlists = [];
      // ~25 tiles per page - follow continuations (new or legacy format).
      let token =
        collectPlaylistItems(grid?.items, playlists) ??
        grid?.continuations?.[0]?.nextContinuationData?.continuation ??
        null;
      for (let page = 0; token && page < 40; page++) {
        const query = `ctoken=${encodeURIComponent(token)}&continuation=${encodeURIComponent(token)}&type=next`;
        const next = await innertubeRequest(`browse?${query}`, { continuation: token });
        if (!next) break;
        const gridCont = next?.continuationContents?.gridContinuation;
        const contItems =
          gridCont?.items ??
          (next?.onResponseReceivedActions ?? []).flatMap(
            (action) => action?.appendContinuationItemsAction?.continuationItems ?? []
          );
        token =
          collectPlaylistItems(contItems, playlists) ??
          gridCont?.continuations?.[0]?.nextContinuationData?.continuation ??
          null;
      }
      return playlists;
    } catch (err) {
      return { error: `playlists parse failed: ${err}` };
    }
  }

  // Collects shelf rows; returns a continuation token if one rides along.
  function collectShelfTracks(items, tracks) {
    let token = null;
    for (const item of items ?? []) {
      const riderToken =
        item?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
      if (riderToken) {
        token = riderToken;
        continue;
      }
      const parsed = parseListItem(item);
      if (parsed?.title) tracks.push(parsed);
    }
    return token;
  }

  // One ~100-row page per call; the popup pages via the returned token
  // (infinite scroll). Loading everything up front took ~30 sequential
  // requests on a 3000-track library.
  async function getPlaylistTracks(browseId, continuation) {
    try {
      let items;
      let contSource; // wherever a legacy continuation might ride
      if (continuation) {
        const query = `ctoken=${encodeURIComponent(continuation)}&continuation=${encodeURIComponent(continuation)}&type=next`;
        const next = await innertubeRequest(`browse?${query}`, { continuation });
        if (!next) return null;
        contSource = next?.continuationContents?.musicPlaylistShelfContinuation;
        items =
          contSource?.contents ??
          (next?.onResponseReceivedActions ?? []).flatMap(
            (action) => action?.appendContinuationItemsAction?.continuationItems ?? []
          );
      } else {
        const data = await innertubeRequest("browse", { browseId });
        if (!data) return null;
        const sections =
          data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
            ?.sectionListRenderer?.contents ??
          data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer
            ?.contents ??
          [];
        const shelf = sections.find((s) => s.musicPlaylistShelfRenderer)
          ?.musicPlaylistShelfRenderer;
        if (!shelf) return null;
        contSource = shelf;
        items = shelf.contents;
      }
      const tracks = [];
      const token =
        collectShelfTracks(items, tracks) ??
        contSource?.continuations?.[0]?.nextContinuationData?.continuation ??
        null;
      return { tracks, continuation: token };
    } catch (err) {
      return null;
    }
  }

  // Whole-playlist play via the app router.
  async function playPlaylist(playlistId, shuffle) {
    const app = document.querySelector("ytmusic-app");
    if (!app || !playlistId) return false;
    const pid = playlistId.replace(/^VL/, "");
    const watchPlaylistEndpoint = { playlistId: pid };
    // The params blob YTM's own shuffle buttons carry on this endpoint.
    if (shuffle) watchPlaylistEndpoint.params = "wAEB8gECKAE%3D";
    app.dispatchEvent(
      new CustomEvent("yt-navigate", {
        bubbles: true,
        composed: true,
        detail: { endpoint: { watchPlaylistEndpoint } },
      })
    );
    for (let attempt = 0; attempt < 10; attempt++) {
      await wait(200);
      if (player()?.getPlaylistId?.() === pid) return true;
    }
    return false;
  }

  // Returns "added", "duplicate" or "error". DEDUPE_OPTION_CHECK makes the
  // API refuse songs already in the playlist (STATUS_FAILED) instead of
  // silently adding them twice.
  async function addToPlaylist(playlistId, videoId) {
    if (!playlistId || !videoId) return "error";
    try {
      const data = await innertubeRequest("browse/edit_playlist", {
        playlistId: playlistId.replace(/^VL/, ""),
        actions: [
          {
            action: "ACTION_ADD_VIDEO",
            addedVideoId: videoId,
            dedupeOption: "DEDUPE_OPTION_CHECK",
          },
        ],
      });
      if (data?.status === "STATUS_SUCCEEDED") return "added";
      if (data?.status === "STATUS_FAILED") return "duplicate";
      return "error";
    } catch (err) {
      return "error";
    }
  }

  // The endpoint comes verbatim from the row's own menu (parseListItem).
  async function removeFromPlaylist(endpoint) {
    if (!endpoint?.playlistId || !endpoint?.actions?.length) return false;
    try {
      const data = await innertubeRequest("browse/edit_playlist", {
        ...endpoint,
        // Menu payloads may omit the action name; the API wants it.
        actions: endpoint.actions.map((a) => ({
          action: "ACTION_REMOVE_VIDEO_FROM_PLAYLIST",
          ...a,
        })),
      });
      return data?.status === "STATUS_SUCCEEDED";
    } catch (err) {
      return false;
    }
  }

  window.addEventListener("message", async (e) => {
    if (!isCurrent()) return;
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
    if (command === "queueMove") {
      const result = await queueMove(payload.fromIndex, payload.toIndex);
      window.postMessage(
        { source: FROM_BRIDGE, type: "response", requestId, result },
        window.location.origin
      );
      return;
    }
    if (command === "queueVideoNext" || command === "queueVideoLast") {
      const result = await queueVideoNext(payload.videoId, command === "queueVideoLast");
      window.postMessage(
        { source: FROM_BRIDGE, type: "response", requestId, result },
        window.location.origin
      );
      return;
    }
    if (command === "search") {
      const result = await searchMusic(payload.query);
      window.postMessage(
        { source: FROM_BRIDGE, type: "response", requestId, result },
        window.location.origin
      );
      return;
    }
    if (
      command === "getPlaylists" ||
      command === "getPlaylistTracks" ||
      command === "playPlaylist" ||
      command === "addToPlaylist" ||
      command === "removeFromPlaylist"
    ) {
      const handlers = {
        getPlaylists: () => getPlaylists(),
        getPlaylistTracks: () => getPlaylistTracks(payload.browseId, payload.continuation),
        playPlaylist: () => playPlaylist(payload.playlistId, payload.shuffle),
        addToPlaylist: () => addToPlaylist(payload.playlistId, payload.videoId),
        removeFromPlaylist: () => removeFromPlaylist(payload.endpoint),
      };
      const result = await handlers[command]();
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
    if (!isCurrent()) {
      clearInterval(poll);
      return;
    }
    const p = player();
    if (!p?.addEventListener) return;
    clearInterval(poll);
    p.addEventListener("onVolumeChange", postStatus);
    p.addEventListener("onStateChange", postStatus);
    postStatus();
  }, 500);
})();
