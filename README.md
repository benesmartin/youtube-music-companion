# Companion for YouTube Music

A browser extension for Firefox and Chrome that turns YouTube Music into a
mini player in your toolbar: full playback control, queue management, history,
search, playlists and synced lyrics - without ever leaving the tab you're in.

## Features

- **Mini player**: album art, per-artist links, play/pause, previous/next,
  like/dislike, shuffle, repeat, seek, volume
- **Queue**: view with artwork, jump to any track, play next, remove,
  drag to reorder; autoplay suggestions labeled and toggleable
- **History** - your real YouTube Music listening history, click to replay
- **Search** - songs and videos, play or queue straight from results
- **Playlists** - browse your library, play a playlist, open its tracks,
  add the current song to any of your playlists
- **Lyrics** via [LRCLIB](https://lrclib.net) - time-synced highlight with
  click-to-seek; strictly opt-in (sends title/artist to lrclib.net),
  official songs only
- **Sleep timer** with presets and custom minutes
- **Themes**: dark, light, or follow the system, with eight accent colors -
  optionally tinting the toolbar icon to match
- **Keyboard shortcuts**: play/pause, next, previous, like - plus unbound
  volume up/down and dislike commands. Rebind everything right in the
  popup's settings on Firefox (Chrome: chrome://extensions/shortcuts)
- Toolbar status dot (green playing, yellow paused), can be turned off
- Works on both Firefox (MV3 background scripts) and Chrome (MV3 service worker)

## Privacy

Everything runs against the YouTube Music tab you already have open, using
your existing session. No analytics, no tracking, no data collection. The
only external request is the opt-in lyrics lookup, which sends the current
track's title and artist to lrclib.net - and nothing else, nowhere else.

## Known limitations

- **Play on a freshly loaded tab** can be blocked by the browser's autoplay
  policy (extension clicks aren't "user gestures" in the tab). The popup shows
  a notice when this happens. Permanent fix: allow **Autoplay → Audio and
  Video** for music.youtube.com in the browser's site permissions.
- **Keyboard shortcuts are browser-global, not OS-global** - they fire while
  the browser has focus. WebExtensions can't register system-wide hotkeys;
  use your OS media keys for that.
- YouTube Music has no public API, so the extension reads the page and its
  internal endpoints. When Google changes internals, features may break until
  updated - bug reports welcome.

## Development

There is no build step. Load the extension unpacked:

- **Firefox:** `about:debugging` → This Firefox → Load Temporary Add-on
- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked

## Support

If this extension makes your listening a little nicer, you can
[buy me a coffee on Ko-fi](https://ko-fi.com/benesmartin). Never expected,
always appreciated.

## License

© 2026 Martin Beneš. Licensed under the [GNU General Public License v3.0](LICENSE) -
use it, fork it, learn from it, but derivatives must stay open source under the
same terms.
