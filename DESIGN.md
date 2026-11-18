---
name: Neolix
description: A calm control surface for coding agents across desktop, mobile, web, and CLI.
colors:
  surface-workbench: "#ffffff"
  surface-subtle: "#fcfcfc"
  surface-muted: "#f8f8f8"
  surface-raised: "#f1f1f1"
  surface-strong: "#e2e2e2"
  surface-diff-empty: "#fafafa"
  surface-sidebar: "#f7f7f7"
  surface-sidebar-hover: "#f0f0f0"
  surface-sidebar-selected: "#ececec"
  text-primary: "#0d0d0d"
  text-secondary: "#5c5c5c"
  text-tertiary: "#636363"
  border-hairline: "#eeeeee"
  border-accent: "#e7e7e7"
  accent: "#c74614"
  accent-strong: "#a83a0f"
  accent-foreground: "#ffffff"
  destructive: "#e02e2a"
  status-success: "#3e704a"
  status-danger: "#9d433b"
  status-warning: "#7b5d39"
  status-merged: "#7347af"
  status-dot-success: "#299f51"
  status-dot-danger: "#f12e2f"
  status-dot-warning: "#b37824"
  status-dot-running: "#268ae0"
  diff-addition: "#00a240"
  diff-deletion: "#e02e2a"
  surface-workbench-dark: "#101010"
  surface-subtle-dark: "#111111"
  surface-sidebar-dark: "#151515"
  surface-sidebar-selected-dark: "#1b1b1b"
  text-primary-dark: "#fcfcfc"
  text-secondary-dark: "#9a9a9a"
  text-tertiary-dark: "#8f8f8f"
  border-hairline-dark: "#222222"
  border-accent-dark: "#2d2d2d"
  accent-dark: "#f2612d"
  accent-strong-dark: "#f58056"
typography:
  display:
    fontFamily: "Cal Sans, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.2
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.3
  content:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.625
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.3
  code:
    fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', 'SF Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  none: "0"
  sm: "2px"
  base: "4px"
  md: "6px"
  lg: "8px"
  xl: "12px"
  "2xl": "16px"
  full: "9999px"
spacing:
  "0": "0"
  "0.5": "2px"
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "3": "12px"
  "3.5": "14px"
  "4": "16px"
  "6": "24px"
  "7": "28px"
  "8": "32px"
  "12": "48px"
  "16": "64px"
  "20": "80px"
  "24": "96px"
  "32": "128px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    rounded: "{rounded.lg}"
    padding: "0 16px"
    height: "32px pointer / 44px touch"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "0 16px"
    height: "32px pointer / 44px touch"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "0 16px"
    height: "32px pointer / 44px touch"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.lg}"
    padding: "0 16px"
    height: "32px pointer / 44px touch"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.accent-foreground}"
    rounded: "{rounded.lg}"
    padding: "0 16px"
    height: "32px pointer / 44px touch"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.lg}"
    size: "26px pointer / 44px touch"
  input-field:
    backgroundColor: "{colors.surface-workbench}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "0 12px"
    height: "32px pointer / 44px touch"
  composer:
    backgroundColor: "{colors.surface-workbench}"
    textColor: "{colors.text-primary}"
    rounded: "19.2px"
    padding: "16px"
  sidebar-row:
    backgroundColor: "{colors.surface-sidebar}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    height: "28px pointer / 44px touch"
  sidebar-row-hover:
    backgroundColor: "{colors.surface-sidebar-hover}"
    rounded: "{rounded.lg}"
  sidebar-row-selected:
    backgroundColor: "{colors.surface-sidebar-selected}"
    rounded: "{rounded.lg}"
  card:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "16px"
  status-badge:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.full}"
    padding: "3px 8px"
---

# Design System: Neolix

## Overview

**Creative North Star: "The Calm Instrument"**

Neolix is a developer tool at category standard, executed at high craft. The interface is an instrument for operating agents, not a dashboard that performs activity. A cool-gray sidebar holds orientation and state; a white workbench holds the conversation; one burnt-orange accent fills the single primary action and the focus ring. Selection is a neutral ink step, not a tint. Everything else is gray, a hairline, or a status signal. The app is quiet so the work is legible.

The light and dark chrome follow Synara's default palette (MIT, Copyright (c) 2026 T3 Tools Inc.). `theme.ts` takes its three seeds — ink, surface, accent — and derives every other step from them.

The world is Chinese-first and cross-platform: iOS, Android, browser, and Electron render the same React Native surfaces. The type is the platform's own sans-serif, so Latin and CJK share a voice and a Chinese character never falls back to a serif. Code runs in JetBrains Mono and the wordmark in Cal Sans on web. Density is operational — rows, tool calls, diffs, terminals — and spacing is deliberate enough to keep a long session calm.

Hierarchy comes from weight and color, not size. State is never carried by hover alone. Selection is a distinct, persistent fill, and hover is a lighter temporary one; the two are different tokens so a pointer passing over a row cannot impersonate a selection.

**Key Characteristics:**

- Cool-gray sidebar against a white workbench.
- Near-black ink; three text tiers, all at or above 4.5:1 on every text surface.
- One burnt-orange accent: a fill for the primary action and the focus ring, never for selection.
- Selection is a neutral ink step, distinct from the lighter hover fill.
- Four status hues plus a brighter dot band for the sidebar.
- 1px hairlines instead of shadows; 8px controls; 16px bubbles; a 19.2px composer.
- 13px base type on web, 15px on native; content at 13px and 16px.
- Two control sizes, resolved from pointer versus touch.

## Colors

A near-neutral ink world with a single burnt-orange marker and a semantic status family. The palette is low-chroma except where a status must be read on its own.

### Primary

- **Burnt Orange** (#c74614): the only accent. It fills the primary button and the focus ring. `#a83a0f` is the emphasis step (`accentBright`) for accent glyphs and notes. In dark, the accent is `#f2612d` with `#f58056` where accent text sits on a dark fill. It is never a selection color.
- **Ink** (#0d0d0d; `text-primary-dark` in dark): the filled send control in the composer. The ink action and the accent action are two different signals; a surface uses one or the other.

There is no secondary or tertiary brand color. Status is a semantic family, not decoration.

### Neutral

- **Workbench White** (#ffffff): the main work surface, page background, composer shell, and the detail pane of every list+detail layout.
- **Subtle Paper** (#fcfcfc): settings cards, expanded tool detail, and low-emphasis blocks that sit on the workbench without becoming a second background.
- **Soft Gray** (#f8f8f8): the user chat bubble, the hovered composer control, the selected tab chip, and the pressed state of a row.
- **Raised Fill** (#f1f1f1): secondary button fill, selected segment, and neutral badge shell.
- **Strong Gray** (#e2e2e2): pressed fills and decorative steps.
- **Sidebar Gray** (#f7f7f7): the app sidebar and the base of the cool-gray column.
- **Sidebar Hover** (#f0f0f0): the hover fill of a sidebar row.
- **Sidebar Selected** (#ececec): the selected fill of a sidebar row, settings item, or navigation destination — a neutral ink step, not a tint.
- **Near-Black Ink** (#0d0d0d): primary text.
- **Secondary Ink** (#5c5c5c): hints, metadata, idle rows, placeholders.
- **Tertiary Ink** (#636363): passive chrome that must sit behind muted text; never a general text color.
- **Hairline** (#eeeeee): the 1px border on cards, inputs, pane seams, and row dividers.
- **Border Accent** (#e7e7e7): the outline button and control hover border.

### Status

One token per signal, shared by every surface: success (#3e704a), danger (#9d433b), warning (#7b5d39), merged (#7347af). They are generated at one lightness and one chroma, with hue as the only variable, so four hues read as one family. Status dots are a separate, brighter band (#299f51, #f12e2f, #b37824, #268ae0) because a 6pt disc has to separate hues, not sit quietly beside text.

### Named Rules

**The One Accent Rule.** Burnt orange is used on ≤10% of any screen: at most one filled primary action and the focus ring. Selection, tabs, and chat bubbles are neutral. Its rarity is what makes it point.

**The Selection Is Not Hover Rule.** Selection is `surface-sidebar-selected`; hover is `surface-sidebar-hover`. A hovered row never borrows the selected fill, and a selected row suppresses its hover fill. The two states answer different questions — "where am I" and "what will this click".

**The 4.5 Floor Rule.** Primary, secondary, and tertiary text all hold 4.5:1 against every text surface in every theme, and tertiary stays a visible step below secondary.

**The Named Theme Rule.** Dark themes are named and keep their hue: neolix (neutral ink chrome with a burnt-orange accent, the default), zinc (monochrome), midnight (blue), claude (warm orange), ghostty (blue-gray), pureBlack (zero-luminance with a green accent). A named theme changes hue and surface values, never the token structure. Dark surfaces are recorded in `.impeccable/design.json`.

## Typography

**Display Font:** Cal Sans (web wordmark only)
**Body Font:** The platform's system UI stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` on web)
**Label/Mono Font:** JetBrains Mono Variable / JetBrains Mono / SF Mono / SFMono-Regular / Menlo / Consolas

**Character:** The platform's own sans carries the interface, so Latin and Chinese share a voice and Chinese never falls back to a serif. Code takes Synara's JetBrains Mono; the web wordmark takes Cal Sans at a single weight. Hierarchy is weight and ink color, not a second family.

### Hierarchy

- **Display** (400, 17px Cal Sans): the sidebar wordmark and nothing else. The New workspace hero uses `fontSize["2xl"]` at 400 in the UI face.
- **Title** (400, 13px): screen titles; `<ScreenTitle>` renders 400 on compact and 300 on desktop. The workspace top bar uses a plain 13px/400 title.
- **Content** (400, 13px web / 16px native): message bodies, composer text, Markdown, and PR prose. This is the reading size; the chat bubble runs at 1.625 line height.
- **Body** (400, 13px web / 15px native): the interface default — rows, controls, navigation, metadata that must stay legible.
- **Label** (400, 12px token; 11px at the 13px web base): field hints, sidebar section labels, compact metadata, tab labels.
- **Code** (400, 12px mono): code, diffs, terminal chrome, and code-size-controlled surfaces.

### Named Rules

**The Base Rule.** Web authors 13px for both the interface and chat; native authors 15px and 16px. The authored ramp is 14px and scales proportionally from the chosen interface size, so a smaller context is a missing size tier, not a reason to shrink locally.

**The Weight Rule.** `medium` is for structural labels only — a label that names a surface or a group. Content inside a surface, row titles, and badge text are `normal`. Screen titles are lighter still (400 compact, 300 desktop).

## Layout

The compact/wide boundary is 600 logical points. Compact is designed first; wide adds chrome around it.

The app sidebar is pinned on desktop and overlaid on compact. It prefers 320px and may shrink to 200px, always on `surface-sidebar`. The sidebar is orientation and state, not a page.

Reading and settings surfaces sit in a centered 720px column. Settings and projects split it as 320px list + 400px detail; the list shrinks first so the detail never drops below 400px. Feature pages — Models & quota, Schedules, Library — keep the app sidebar and add a 240px section column inside the content pane, on `surface-workbench` with a single 1px right seam; it is the content pane's list, not a second sidebar. Chat and workspace surfaces take the full width, with a content column capped at 820px and a composer content width of 500px on compact.

The wide workspace top bar is 44px tall with a 13px/400 title and 26px icon buttons. The tab rail under it is 36px on pointer.

Spacing comes from one scale (2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 80, 96, 128). Page padding is 16–24px; a settings row is 16px vertical; sidebar rows are 28px on pointer with a 4px vertical inset; workspace rows are 28px on pointer and one touch target (44px) on touch. Cards inside a section sit tighter than sections; rows inside a card touch, separated only by their divider.

## Elevation & Depth

Flat by default. Depth is tonal: `surface-workbench` → `surface-subtle` → `surface-muted` → `surface-raised`, separated by 1px hairlines. A card is not lifted; it is a bordered region on the page. Pane structure uses a single bottom border, never a shadow.

Shadow tokens exist for objects that genuinely float: popovers, menus, sheets, the dragged sidebar row, and the composer on compact layouts. They are black at low alpha — light: sm `0 2px 8px rgba(0,0,0,0.08)`, md `0 4px 16px rgba(0,0,0,0.04)`, lg `0 8px 24px rgba(0,0,0,0.08)`; dark: sm `0 2px 4px rgba(0,0,0,0.25)`, md `0 4px 8px rgba(0,0,0,0.20)`, lg `0 12px 24px rgba(0,0,0,0.40)`.

### Named Rules

**The Flat-by-Default Rule.** A surface at rest is flat. Shadows appear only when an object is above the page (menu, sheet, drag) or when a compact composer needs to separate from the conversation. A shadow used to group rows is wrong; use a border.

## Shapes

The form language is the rounded rectangle. Controls use an 8px radius (`rounded.lg`): buttons, fields, sidebar rows, settings items, segmented segments. Containers run 8–16px: cards and group shells at 8px, user bubbles at 16px, tab chips and menu items at 10px, and the composer at 19.2px. Composer glyph buttons — attach, voice, send — are 28px circles; the send control is an ink-filled circle. Status badges and status dots are fully round.

Borders are 1px hairlines. A focused control adds a 2px burnt-orange outline at 1px offset; a hovered control shifts its border to `border-accent`. Icons are 1.5px strokes at 12/14/16/20px.

### Named Rules

**The 8px Control Rule.** Every button, field, dropdown trigger, and selectable row is an 8px rectangle. A pill button is a different product's language; a circle is reserved for a dot and for the composer's own glyph buttons.

**The Fill-Not-Underline Rule.** A selected workspace tab is a filled capsule (`surface2`, 10px radius, 28px high, 12px label). It gets no accent text and no underline.

**The Hairline Rule.** 1px separates, groups, and occasionally emphasizes. Two adjacent borders are wrong; a single bordered element that is not a card, input, or button is wrong.

## Components

### Buttons

- **Shape:** 8px rounded rectangle (`border-radius: 8px`), 1px transparent border, 8px gap between icon and label.
- **Primary (`default`):** burnt-orange fill with the `accent-foreground` label (white in light, ink in dark); at most one per page.
- **Secondary:** `surface-raised` fill with primary text; the component default and the paired action.
- **Outline:** transparent with `border-accent`; row-level actions such as Restart and Remove.
- **Ghost:** transparent, muted label that returns to primary text on hover; chrome-level affordances.
- **Destructive:** `destructive` fill; only inside a confirmation.
- **Sizes:** `md` is 32px on pointer and 44px on touch; `sm` is 28/32px with 12px labels, for toolbars and nested rows only.
- **States:** press at 0.85 opacity; disabled at 0.5 opacity with no color change; focus ring 2px burnt orange at 1px offset.

### Icon Buttons

Square, 8px radius, transparent until hover. Large is 26px pointer / 44px touch, small is 20px / 44px. The icon is centered in the hitbox and is never given its own local padding. The composer's attach, voice, and send buttons are the exception: they are 28px circles inside the input shell.

### Inputs

- **Field:** 1px `border-hairline`, 8px radius, `surface-workbench` fill, 12px horizontal padding, 32px pointer / 44px touch height (28/32px in `sm`).
- **Composer:** the shell is `surface-workbench`, 19.2px radius, 1px hairline, 16px padding on desktop (8px on compact), and a `shadow.sm` lift on compact. It is the input, not a container around one.
- **Composer controls:** the model selector and agent controls are borderless, 12px labels on a 28px `sm` box, hover `surface2`, pressed `surface3`. They are chrome inside the input, not buttons.
- **Send:** a 28px ink circle (`primary` fill, `primaryForeground` glyph), disabled at 0.5 opacity.
- **Focus:** the shared 2px burnt-orange focus ring. Read-only state uses a dotted border instead of a color change.

### Navigation

Sidebar rows are 8px rectangles with 8px left padding and 12px right padding. Hover is `surface-sidebar-hover`; the selected destination, workspace, or settings item is `surface-sidebar-selected`, and selection suppresses hover. Navigation destinations set `activeFill="selected"` so the active page is a filled row, not a hover. Workspace tabs carry selection as a filled capsule (`surface2`, 10px radius, 12px label) with no accent text and no underline; hover is a lighter fill. The app sidebar is `surface-sidebar`; a feature page's section column is `surface-workbench` with a 1px right seam.

### Rows and Cards

- **Card:** `surface-subtle` fill, 8px radius, 1px hairline, 16px row padding. The first row has no top border; every later row carries a 1px top divider.
- **Sidebar row:** 8px radius, 28px pointer / 44px touch minimum height, 4px vertical padding. A row that swaps its trailing content on hover keeps a fixed height so nothing shifts.
- **Row actions:** a kebab is revealed on hover or keyboard focus on web, and always present on touch. An open menu keeps its trigger rendered.
- **Selection:** `surface-sidebar-selected`; hover never substitutes for it.

### Status Badges

Neutral badges use `surface-raised` with a hairline. Success, warning, and error badges use their status tint (`status-*-tint`) as fill and the same status token as text, so fill and label cannot drift. Radius is full; the label is the `sm` token (11px at the 13px web base), `normal`.

### Chat

A user message is a right-aligned bubble filled with `surface2`, 16px radius, 10px vertical / 14px horizontal padding, at most 80% of the column, at 1.625 line height. It has no visible border and no avatar. An agent turn is plain prose on the page: no response card and no agent header. Tool calls are compact rows that gain a hairline only when expanded. The stream is the page, not a card inside one.

## Do's and Don'ts

### Do:

- **Do** use `surface-sidebar-selected` for selection and `surface-sidebar-hover` for hover; keep them distinct.
- **Do** keep every text tier at or above 4.5:1 and let `theme-contrast.test.ts` enforce it.
- **Do** use 8px radii for controls, 8–16px for containers, and 19.2px for the composer.
- **Do** separate with 1px hairlines and tonal surface steps before reaching for a shadow.
- **Do** use the system UI sans stack, and set type through the 13px web / 15px native base ramp.
- **Do** resolve control size from pointer versus touch through `resolveControlSizing`.
- **Do** keep the feature-page section column at 240px on `surface-workbench` with a single seam.
- **Do** keep one burnt-orange primary action per surface.

### Don't:

- **Don't** use `borderRadius.full` for buttons or toolbar icon buttons; the composer's attach, voice, and send glyphs are the only circles.
- **Don't** let hover stand in for selection, or change a selected row's fill on hover.
- **Don't** use the accent for selection, tab labels, or chat bubbles; those are neutral.
- **Don't** underline the selected tab or give it accent text; it is a filled capsule.
- **Don't** wrap an agent reply in a card or add an avatar to a message.
- **Don't** introduce a second accent hue or a decorative status color.
- **Don't** put a shadow on a resting card or use shadows to group rows.
- **Don't** use `palette` values or hardcoded hex outside the semantic tokens.
- **Don't** shrink text or padding locally to fit a context; use the size tier.
- **Don't** reveal row actions only on hover; keyboard focus and touch need the same controls.
- **Don't** give a feature page's section column the sidebar surface; it belongs to the content pane.
