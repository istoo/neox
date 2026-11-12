# Changelog

## 0.16.2 - 2026-11-12

### Fixed

- The desktop menu follows the system language; a Chinese system now shows Chinese menu items instead of English ones
- Importing a Codex chat that ran on a different model provider no longer fails; Neox resumes it on the provider the chat recorded
- A failed project import shows a short title and one line of detail per row instead of dumping the full provider error into the list

## 0.16.1 - 2026-11-12

### Fixed

- A turn that fails because the provider rejected the sign-in or could not be reached now says what to do, instead of repeating the provider's raw `401 authentication_error` or `fetch failed` text
- Settings › Usage reports an expired provider login in the app's language and keeps the command that refreshes it

## 0.16.0 - 2026-11-11

First Neox release published from [istoo/neox](https://github.com/istoo/neox). Desktop builds for macOS (Apple Silicon and Intel), Windows and Linux, with updates delivered through GitHub Releases.

The macOS app is not signed with an Apple Developer ID yet. The first time you open it, macOS may refuse to start it: open System Settings › Privacy & Security and choose Open Anyway, or run `xattr -dr com.apple.quarantine /Applications/Neox.app`.

Windows and the Linux AppImage download and install updates themselves. The macOS app, and Linux `.deb` and `.rpm` installs, tell you when a new version is out and open its download page instead.

### Added

- Neox desktop UI: threads, split views, kanban, review, browser, device and gateway panels
- Model gateway with provider routing, failover, allowances and masking
- GitHub Releases update feed for the desktop app
