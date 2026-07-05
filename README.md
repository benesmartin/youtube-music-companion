<p align="center">
  <img src="icons/icon.svg" width="92" alt="">
</p>

<h1 align="center">Companion for YouTube Music</h1>

<p align="center">
  A full mini player for YouTube Music in your toolbar - queue, history, search,
  playlists and synced lyrics, without ever leaving the tab you're in.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-blue"></a>
  <img alt="Firefox and Chrome, Manifest V3" src="https://img.shields.io/badge/WebExtension-MV3-orange">
  <a href="https://ko-fi.com/benesmartin"><img alt="Support on Ko-fi" src="https://img.shields.io/badge/Ko--fi-support-ff5e5b"></a>
  <!-- after AMO approval, replace the line above with:
  <a href="https://addons.mozilla.org/firefox/addon/AMO_SLUG/"><img alt="Firefox Add-ons" src="https://img.shields.io/amo/v/AMO_SLUG?label=Firefox%20Add-ons"></a>
  <a href="https://addons.mozilla.org/firefox/addon/AMO_SLUG/"><img alt="Users" src="https://img.shields.io/amo/users/AMO_SLUG"></a>
  -->
</p>

<p align="center">
  <img src="https://github.com/benesmartin/youtube-music-companion/releases/download/v1.0.0/01-player-queue.png" width="640" alt="Player with queue, dark theme">
</p>

## Features

- **Player**: album art, per-artist links, play/pause, previous/next,
  like/dislike, shuffle, repeat, seek and volume
- **Queue**: see what's coming with artwork, jump to any track, play next,
  remove, drag to reorder; toggleable autoplay suggestions
- **History**: your real YouTube Music listening history, click to replay
- **Search**: songs and videos, play or queue straight from results
- **Playlists**: browse your library, play a playlist, open its tracks,
  add the current song to any of your playlists
- **Lyrics** via [LRCLIB](https://lrclib.net): time-synced highlight;
  strictly opt-in (sends title/artist to lrclib.net), official songs only
- **Sleep timer** with presets and custom minutes
- **Themes**: dark, light, or follow the system, with eight accent colors -
  optionally tinting the toolbar icon to match
- **Keyboard shortcuts**: play/pause, next, previous, like - plus unbound
  volume up/down and dislike commands. Rebind everything right in the
  popup's settings on Firefox (Chrome: chrome://extensions/shortcuts)
- Toolbar status dot (green playing, yellow paused), can be turned off

<details>
<summary><b>More screenshots</b> - lyrics, search, history, settings</summary>
<br>
<p align="center">
  <img src="https://github.com/benesmartin/youtube-music-companion/releases/download/v1.0.0/02-synced-lyrics.png" width="404" alt="Time-synced lyrics">
  <img src="https://github.com/benesmartin/youtube-music-companion/releases/download/v1.0.0/03-search.png" width="404" alt="Search with songs and videos filters">
</p>
<p align="center">
  <img src="https://github.com/benesmartin/youtube-music-companion/releases/download/v1.0.0/04-history.png" width="404" alt="Listening history">
  <img src="https://github.com/benesmartin/youtube-music-companion/releases/download/v1.0.0/05-settings.png" width="404" alt="Settings with themes and accent colors">
</p>
</details>

## Install

- **Firefox**: from [addons.mozilla.org](https://addons.mozilla.org/) *(listing in review - link coming)*
- **Chrome**: planned after the Firefox release settles
- **From source**: clone the repo and load it unpacked - see Development below

Requires an open music.youtube.com tab; the popup becomes its remote control.

## How it works

YouTube Music has no public API, so the extension reads the page and speaks
to YTM's own internals: a content script scrapes the player bar and streams
state to the popup, while a small page-context bridge drives the app router,
the queue store and the same internal endpoints the page itself uses - with
your existing session, entirely inside your browser.  

When Google changes internals, features may break until updated; bug reports are very welcome.

## Privacy

No analytics, no tracking, no data collection. Everything runs against the
YouTube Music tab you already have open. The only external request is the
opt-in lyrics lookup, which sends the current track's title and artist to
lrclib.net - and nothing else, nowhere else.

## Known limitations

- **Play on a freshly loaded tab** can be blocked by the browser's autoplay
  policy (extension clicks aren't "user gestures" in the tab). The popup
  shows a notice when this happens. Permanent fix: allow **Autoplay → Audio
  and Video** for music.youtube.com in the browser's site permissions.
- **Keyboard shortcuts are browser-global, not OS-global** - they fire while
  the browser has focus. WebExtensions can't register system-wide hotkeys;
  use your OS media keys for that.

## Support

If this extension makes your listening a little nicer, you can
[buy me a coffee on Ko-fi](https://ko-fi.com/benesmartin) :)

## License

© 2026 Martin Beneš. Licensed under the [GNU General Public License v3.0](LICENSE) -
use it, fork it, learn from it, but derivatives must stay open source under the
same terms.

*This is an independent project, not affiliated with or endorsed by Google or YouTube.*
