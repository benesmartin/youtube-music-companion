// Runs in the PAGE context (injected by content.js), where YTM's internal
// player API is reachable. Talks to the content script via window.postMessage.
// Keep this layer as thin as possible — it's the first thing to break when
// YTM changes internals.

(() => {
  const FROM_BRIDGE = "ytmc-bridge";
  const FROM_CONTENT = "ytmc-content";

  // Extension reloads inject a fresh copy of this script while older copies
  // keep their listeners alive in the page. Only the newest generation may
  // act, or the content script races duplicate (stale-code) responses.
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

  // Reorder within the queue store. Only the real queue (items) is movable —
  // autoplay/radio continuations live in automixItems, which MOVE_ITEM
  // doesn't reach, so indices past the items array are rejected.
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
      console.debug("[YTM Companion] queue move failed:", err);
      return false;
    }
    // The dispatch is fire-and-forget; success = the order actually changed.
    return order(store.getState()?.queue?.items) !== before;
  }

  // The queue element's data store knows every item's thumbnail URL and
  // videoId even when the DOM images haven't lazy-loaded yet.
  function readQueueData() {
    const queueEl = document.querySelector("ytmusic-player-queue");
    let items = null;
    // Read the raw store state first: radio queues (playing from history)
    // keep the generated part in automixItems, which getItems() omits —
    // it reports a single item for a 50-row queue.
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
      // Rebuilt queues (playing from history) sometimes expose no readable
      // store, but the player API still knows the playlist order — and every
      // videoId has a guaranteed static thumbnail.
      const ids = player()?.getPlaylist?.() ?? null;
      if (Array.isArray(ids) && ids.length) {
        console.debug("[YTM Companion] queue store empty, using player playlist:", ids.length);
        return ids.map((id) => ({
          videoId: id ?? null,
          title: "",
          thumb: id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : "",
        }));
      }
      console.debug("[YTM Companion] queue data store unreadable");
      return null;
    }
    console.debug("[YTM Companion] queue store items:", items.length);
    // Artists from a queue renderer's bylines. Prefer runs linking to an
    // artist/channel page; queue bylines are often endpoint-less though, in
    // which case artists and localized "and" separators (" a " in Czech)
    // alternate as runs — drop the separator runs and comma-join the rest.
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
      // Wrapped (video-with-song) entries sometimes only carry a thumbnail
      // on the hidden counterpart renderer.
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
        // Every YouTube video has a guaranteed static thumbnail URL; use it
        // when the store entry carries no thumbnail of its own (common right
        // after a queue rebuild).
        thumb: thumbs.length
          ? thumbs[thumbs.length - 1].url
          : videoId
            ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
            : "",
      };
    });
    // Store entries with unrecognized renderers yield no videoId/thumb;
    // patch those from the player's playlist when the orders line up.
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

  // The byline column mixes artists with albums, view counts and dates
  // ("Channel • 1.4M views • today", "Artist • Album • 3:14"). Prefer runs
  // that link to an artist/channel page, then any linked run, then the text
  // before the first bullet.
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
    // The play overlay carries the full watch endpoint; playlistId/params make
    // playback build the same autoplay queue as clicking the item on the page.
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
      console.debug("[YTM Companion] history fetch failed:", err);
      return null;
    }
  }

  // ---- search (internal search API, same row shape as history) ----

  // Filter params as sent by YTM's own "Songs" / "Videos" chips. Videos
  // matter because plenty of songs only exist as user uploads.
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
      console.debug("[YTM Companion] search failed:", err);
      return null;
    }
  }

  // ---- playlists (library list, tracks, play, add-current) ----

  // Collects playlist tiles from a batch of grid items; returns the
  // continuation token if one rides along as a continuationItemRenderer.
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
      const data = await innertubeRequest("browse", { browseId: "FEmusic_liked_playlists" });
      if (!data) return null;
      const sections =
        data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
          ?.sectionListRenderer?.contents ??
        data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer
          ?.contents ??
        [];
      const grid = sections.find((s) => s.gridRenderer)?.gridRenderer;
      const playlists = [];
      // The grid is paginated (~25 tiles per page) — follow continuations
      // until the library is exhausted. Token arrives either as a trailing
      // continuationItemRenderer or in the legacy continuations array.
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
      console.debug("[YTM Companion] playlists fetch failed:", err);
      return null;
    }
  }

  async function getPlaylistTracks(browseId) {
    try {
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
      return (shelf.contents ?? []).map(parseListItem).filter((t) => t?.title);
    } catch (err) {
      console.debug("[YTM Companion] playlist tracks fetch failed:", err);
      return null;
    }
  }

  // Play a whole playlist through the app router, same as clicking its
  // play button on the library page.
  async function playPlaylist(playlistId) {
    const app = document.querySelector("ytmusic-app");
    if (!app || !playlistId) return false;
    const pid = playlistId.replace(/^VL/, "");
    app.dispatchEvent(
      new CustomEvent("yt-navigate", {
        bubbles: true,
        composed: true,
        detail: { endpoint: { watchPlaylistEndpoint: { playlistId: pid } } },
      })
    );
    for (let attempt = 0; attempt < 10; attempt++) {
      await wait(200);
      if (player()?.getPlaylistId?.() === pid) return true;
    }
    return false;
  }

  async function addToPlaylist(playlistId, videoId) {
    if (!playlistId || !videoId) return false;
    try {
      const data = await innertubeRequest("browse/edit_playlist", {
        playlistId: playlistId.replace(/^VL/, ""),
        actions: [{ action: "ACTION_ADD_VIDEO", addedVideoId: videoId }],
      });
      return data?.status === "STATUS_SUCCEEDED";
    } catch (err) {
      console.debug("[YTM Companion] add to playlist failed:", err);
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
    if (command === "queueVideoNext") {
      const result = await queueVideoNext(payload.videoId);
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
      command === "addToPlaylist"
    ) {
      const handlers = {
        getPlaylists: () => getPlaylists(),
        getPlaylistTracks: () => getPlaylistTracks(payload.browseId),
        playPlaylist: () => playPlaylist(payload.playlistId),
        addToPlaylist: () => addToPlaylist(payload.playlistId, payload.videoId),
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
