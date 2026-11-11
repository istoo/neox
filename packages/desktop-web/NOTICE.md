# NOTICE

This directory is a fork of **Synara**, an open-source project distributed under
the MIT License.

- Upstream repository: https://github.com/Emanuele-web04/synara
- Upstream license: MIT
- Fork base commit: `38bdf5d9429eb9dc21e928500f45e19a8b371079`
- Upstream copyright: Copyright (c) 2026 T3 Tools Inc.

The original MIT license text is preserved in [`LICENSE`](./LICENSE) and is not
modified by this fork.

## Changes in this fork

The frontend in `apps/web` is adapted for **Neox** (a Neolix derivative):

- User-visible branding is rendered as Neox while internal identifiers,
  protocol headers (`x-synara-*`), storage keys, package names (`@synara/*`)
  and message keys remain unchanged to stay compatible with the upstream fork
  base and the Neolix protocol bridge.
- The Synara mark is replaced with the Neox N-graph mark (four nodes joined in
  an N). Its geometry lives in `apps/web/src/components/NeolixLogo.tsx`.
- Entries for services that have no Neolix backend (accounts, billing,
  telemetry, feedback, desktop auto-update, sponsorships, share cards, the
  first-launch project-import announcement, the product tour auto-start and
  What's New) are hidden or disabled. Their modules remain in the source tree.

These modifications are also distributed under the MIT License.
