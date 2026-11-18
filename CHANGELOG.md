# Changelog

## 0.17.0-beta.2 - 2026-11-19

Neox now runs one interface in the desktop app and in a browser. The desktop shell loads the interface served by the daemon; the mobile app and its React Native client are removed.

### Added

- Added an `install.sh` to macOS releases that downloads the ZIP for the CPU architecture, verifies its SHA-512, and installs into `~/Applications`
- Each dock terminal tab shows its own running, attention, or review state, including while the tab is inactive
- Agent Connect wires installed CLI agents to the model gateway, with per-agent model lists and saved profiles
- Orchestration skills can be installed, updated, and removed from Settings › Agent skills
- Workspace setup and teardown, including service ports, appear in the chat dock
- History searches sessions across this computer and other connected computers, and imports threads and projects
- Project icons are detected from the repository or set from an image
- App preferences sync across connected computers
- Sidebar entries can be shown, hidden, and reordered
- Adding a project can search GitHub repositories instead of requiring a URL
- Pull requests show per-check details, GitLab pipeline stages and jobs, and an approvals badge
- Pull requests can be set to auto-merge from the review panel
- The diff panel switches to a single commit's diff from its commit history menu
- Gateway diagnostics show the prompt, reply, SSE stream, and request flow, along with held reports
- Usage reports list every gateway account and show usage from other connected computers
- Agents can drive the built-in browser, controlled by the Browser tools switch
- Subagents can be detached into their own agent, and attention markers can be cleared
- Plugins can render their pages as web views and replace built-in pages
- Settings › About includes third-party licenses, community links, the status line command, the public address, and uninstall
- Amazon Bedrock (Mantle) is available as a gateway provider
- Code Assist can generate images
- Plugin providers that support daily check-in appear in Allowances with their own switch
- The sidebar shows a host badge on remote workspaces, and remote threads show their branch and pull request; the host and pull request row fields can be toggled

### Improved

- The diff panel refreshes immediately after a commit, discard, pull, or branch switch instead of showing the cached diff
- Focusing a terminal clears its attention marker; moving focus away or hiding the page clears the reported focus
- History opens immediately and fills full counts in the background instead of waiting for a complete scan
- The desktop window shows a waiting page and a retry page during daemon startup instead of staying blank
- Settings › Providers uses a master-detail layout with one status line per provider
- The web interface shipped with the daemon is about 1 MB instead of 17.6 MB
- Browser access on the local network serves the same interface as the desktop app
- Docker and Nix installs include the web interface

### Changed

- Create PR on the default branch now asks you to create and switch to a branch first
- Removed the Create draft PR, Commit on new branch, and Checkout feature branch & continue actions
- The desktop app now opens the interface served by the daemon

### Breaking

- The mobile app is removed; Neox now ships desktop and browser interfaces only

### Fixed

- Agents created in a new worktree, including from a pull request, stay in that worktree's workspace instead of creating a duplicate project
- A pull that would conflict now reports the conflict and leaves the working tree unchanged, naming the conflicting files when git lists them
- A `provider/model` request now goes to that provider even when another provider serves the same model, instead of to a gateway group for the model
- When the daemon advertises the provider snapshot, `neox run` rejects an unknown provider before creating a new workspace, so a failed run no longer leaves an empty workspace behind
- Switching branches with uncommitted changes now offers to stash them even when the daemon reports only a generic uncommitted-changes error
- Daemon updates show progress instead of appearing stalled
- Old browser data partitions are cleaned up
- Plugin sign-in shows the correct success message and no longer crashes when the pane updates
- Clearing an attention marker that fails now answers instead of timing out
- Creating a project no longer clears text already typed into the dialog
- Option previews are no longer trimmed
- Settings no longer repeats every sidebar page five times
- Streaming replies no longer overwrite an earlier segment that shares the same id

### Notes

- macOS builds remain unsigned; updates on macOS open the release download page
- This is a beta build and is offered only to installations on the beta channel

## 0.16.5 - 2026-11-13

### Fixed

- Opening the desktop Browser panel no longer crashes when the desktop shell does not provide browser annotations; annotation mode simply stays unavailable

## 0.16.3 - 2026-11-13

### Fixed

- Project actions appear in the Environment panel and run from the top bar; saving one stores it in the project's `neox.json`
- Editing an action keeps the rest of the script's configuration, including a service's `type` and `port`
- "Run automatically on worktree creation" now sets the project's worktree setup and stays on after a reload
- A newly added, renamed or removed project shows up in the sidebar and project picker immediately, without restarting the app

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
