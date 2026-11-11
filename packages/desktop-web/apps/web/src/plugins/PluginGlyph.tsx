// FILE: PluginGlyph.tsx
// Purpose: Maps a declaration's Lucide icon name onto the app's own icon set. Unknown names fall
//          back to the plugin glyph so a manifest cannot break a surface.
// Layer: Web plugin host
// Exports: PluginGlyph

import type { ComponentType } from "react";

import {
  AddPlusIcon,
  BotIcon,
  BookOpenIcon,
  CalendarIcon,
  ChatBubbleIcon,
  CheckIcon,
  CircleAlertIcon,
  FileIcon,
  InfoIcon,
  LightbulbIcon,
  MessageCircleIcon,
  PageTextIcon,
  PluginIcon,
  SearchIcon,
  SettingsIcon,
  TrashCanIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";

type Glyph = ComponentType<{ className?: string }>;

const GLYPHS: Readonly<Record<string, Glyph>> = {
  alert: CircleAlertIcon,
  bell: CircleAlertIcon,
  bot: BotIcon,
  book: BookOpenIcon,
  bookopen: BookOpenIcon,
  calendar: CalendarIcon,
  chat: ChatBubbleIcon,
  chatbubble: ChatBubbleIcon,
  check: CheckIcon,
  circlealert: CircleAlertIcon,
  file: FileIcon,
  filetext: PageTextIcon,
  help: InfoIcon,
  info: InfoIcon,
  lightbulb: LightbulbIcon,
  message: MessageCircleIcon,
  messagecircle: MessageCircleIcon,
  pagetext: PageTextIcon,
  plugin: PluginIcon,
  plus: AddPlusIcon,
  search: SearchIcon,
  settings: SettingsIcon,
  sparkles: LightbulbIcon,
  trash: TrashCanIcon,
  trash2: TrashCanIcon,
};

function normalizeName(name: string): string {
  return name.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

export function PluginGlyph({
  name,
  className,
}: {
  readonly name: string | undefined;
  readonly className?: string | undefined;
}) {
  const Glyph = (name && GLYPHS[normalizeName(name)]) || PluginIcon;
  return <Glyph className={cn("size-3.5 shrink-0", className)} />;
}
