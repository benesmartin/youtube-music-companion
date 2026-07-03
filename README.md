# YouTube Music Companion

A browser extension for Firefox and Chrome that lets you control YouTube Music playback from a mini player: song info, play/pause, next/previous, and more.

> ⚠️ Early development — nothing to see here yet.

## Features (planned)

- Mini player popup: album art, playback controls, seek, volume
- Keyboard shortcuts (play/pause, next, previous, like)
- Queue: view, jump, play next, remove, reorder
- Playback history — your real YouTube Music history, grouped by day
- Lyrics via [LRCLIB](https://lrclib.net) — time-synced with click-to-seek, opt-in, official songs only
- Search and playlists
- Themes
- Works on both Firefox (MV3 background scripts) and Chrome (MV3 service worker)

See [ROADMAP.md](ROADMAP.md) for build order and decisions.

## Known limitations

- **Play on a freshly loaded tab** can be blocked by the browser's autoplay
  policy (extension clicks aren't "user gestures" in the tab). The popup shows
  a notice when this happens. Permanent fix: allow **Autoplay → Audio and
  Video** for music.youtube.com in the browser's site permissions.

## Development

There is no build step yet. Load the extension unpacked:

- **Firefox:** `about:debugging` → This Firefox → Load Temporary Add-on
- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked
