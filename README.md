<p align="center">
  <img src="icons/icon.svg" width="92" alt="">
</p>

<h1 align="center">Companion for YouTube Music</h1>

<p align="center">
  A full mini player for YouTube Music in your toolbar - recommendations, queue,
  history, search, playlists and synced lyrics, without ever leaving the tab
  you're in.
</p>

<p align="center">
  <a href="https://addons.mozilla.org/firefox/addon/companion-for-youtube-music/"><img alt="Firefox Add-ons" src="https://img.shields.io/amo/v/companion-for-youtube-music?label=Firefox%20Add-ons"></a>
  <a href="https://chromewebstore.google.com/detail/companion-for-youtube-mus/iifmpealppkjdljfhbjcdgdgglflnfkl"><img alt="Chrome Web Store" src="https://img.shields.io/chrome-web-store/v/iifmpealppkjdljfhbjcdgdgglflnfkl?label=Chrome%20Web%20Store"></a>
  <a href="LICENSE"><img alt="License: GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-blue"></a>
  <a href="https://ko-fi.com/benesmartin"><img alt="Support on Ko-fi" src="https://img.shields.io/badge/Ko--fi-support-ff5e5b"></a>
</p>

<p align="center"><sub>Edge, Brave, Opera and Vivaldi install the Chrome Web Store build.</sub></p>

<p align="center">
  <img src="https://github.com/benesmartin/youtube-music-companion/releases/download/v1.3.0/01-player-queue.png" width="640" alt="Player with queue, dark theme">
</p>

## Features

- **Player**: album art, per-artist links, play/pause, previous/next,
  like/dislike, shuffle, repeat, seek and volume - hover the seek bar to
  preview the exact time before you click
- **Home**: YouTube Music's own recommendation shelves - quick picks, listen
  again and the rest - right in the popup. Click a song and it starts a radio
  from it, so you can pick something and let the algorithm run
- **Queue**: see what's coming with artwork, jump to any track, play next
  or add to queue, remove, drag to reorder; toggleable autoplay suggestions
- **History**: your real YouTube Music listening history, click to replay
- **Search**: songs and videos - play, play next or add to queue straight
  from results
- **Start a radio from any song** in search, history, playlists or home -
  not just the one that's playing
- **Playlists**: browse your library, play or shuffle a playlist, open its
  tracks, save the current song to any playlist (with a duplicate guard),
  remove songs - long playlists load as you scroll
- **Lyrics** via [LRCLIB](https://lrclib.net): time-synced highlight;
  strictly opt-in (sends title/artist to lrclib.net), official songs only
- **Sleep timer** with presets and custom minutes - a live countdown sits
  on the album art while it runs
- **Themes**: dark, light, or follow the system, with eight accent colors
  or a **dynamic accent** picked from the album art of whatever's playing -
  optionally tinting the toolbar icon to match
- **Compact mode**: one click collapses the popup to just the player card -
  art, controls, seek and volume
- **Keyboard shortcuts**: play/pause, next, previous, like - plus unbound
  volume up/down and dislike commands. Rebind everything right in the
  popup's settings on Firefox (Chrome: chrome://extensions/shortcuts)
- **Row actions you choose**: switch play next, add to queue and start radio
  on or off per row in settings
- Toolbar status dot (green playing, yellow paused), can be turned off

<details>
<summary><b>More screenshots</b> - home, playlists, lyrics, search, history, settings</summary>
<br>
<p align="center">
  <img src="https://github.com/benesmartin/youtube-music-companion/releases/download/v1.3.0/07-home.png" width="404" alt="Home tab with recommendation shelves">
  <img src="https://github.com/benesmartin/youtube-music-companion/releases/download/v1.3.0/08-playlists.png" width="404" alt="Playlists with the save-current-song bar">
</p>
<p align="center">
  <img src="https://github.com/benesmartin/youtube-music-companion/releases/download/v1.3.0/02-synced-lyrics.png" width="404" alt="Time-synced lyrics">
  <img src="https://github.com/benesmartin/youtube-music-companion/releases/download/v1.3.0/03-search.png" width="404" alt="Search with songs and videos filters">
</p>
<p align="center">
  <img src="https://github.com/benesmartin/youtube-music-companion/releases/download/v1.3.0/04-history.png" width="404" alt="Listening history">
  <img src="https://github.com/benesmartin/youtube-music-companion/releases/download/v1.3.0/05-settings.png" width="404" alt="Settings with themes and accent colors">
</p>
</details>

## Install

- **Firefox**: [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/companion-for-youtube-music/)
- **Chrome**: [Chrome Web Store](https://chromewebstore.google.com/detail/companion-for-youtube-mus/iifmpealppkjdljfhbjcdgdgglflnfkl)
- **From source**: clone the repo and load it unpacked, no build step
  (Firefox: `about:debugging` → Load Temporary Add-on; Chrome: `chrome://extensions` → Load unpacked)

Requires an open music.youtube.com tab; the popup becomes its remote control.
Nothing playing yet? Search, playlists and history still work, so you can
start the music from the popup itself.

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
