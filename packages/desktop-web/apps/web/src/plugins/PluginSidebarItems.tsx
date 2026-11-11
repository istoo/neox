// FILE: PluginSidebarItems.tsx
// Purpose: Renders manifest-declared sidebar page entries. Selecting one opens its sandboxed view
//          as a full-page route (`/plugin/<id>/<view>`), matching the native plugin screens.
// Layer: Web plugin host
// Exports: PluginSidebarItems

import type { ComponentType } from "react";
import { useMemo } from "react";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";

import { SidebarPrimaryAction } from "~/components/SidebarPrimaryAction";

import { useRunningPlugins } from "./catalog";
import { buildPluginContributionIndex, type PluginSidebarEntry } from "./contributions";
import { PluginGlyph } from "./PluginGlyph";

const glyphCache = new Map<string, ComponentType<{ className?: string }>>();

function glyphFor(name: string | undefined): ComponentType<{ className?: string }> {
  const key = name ?? "__plugin__";
  const cached = glyphCache.get(key);
  if (cached) return cached;
  const Glyph = ({ className }: { className?: string }) => (
    <PluginGlyph name={name} className={className} />
  );
  glyphCache.set(key, Glyph);
  return Glyph;
}

export function PluginSidebarItems({ section }: { readonly section: "header" | "footer" }) {
  const plugins = useRunningPlugins();
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const entries = useMemo(
    () =>
      buildPluginContributionIndex(plugins).sidebarItems.filter(
        (entry) => (entry.contribution.section ?? "header") === section,
      ),
    [plugins, section],
  );
  if (entries.length === 0) return null;
  return (
    <>
      {entries.map((entry: PluginSidebarEntry) => (
        <SidebarPrimaryAction
          key={`${entry.pluginId}:${entry.contribution.id}`}
          icon={glyphFor(entry.contribution.icon)}
          label={entry.contribution.title}
          active={Boolean(
            matchRoute({
              to: "/plugin/$pluginId/$viewId",
              params: { pluginId: entry.pluginId, viewId: entry.contribution.view },
            }),
          )}
          onClick={() =>
            void navigate({
              to: "/plugin/$pluginId/$viewId",
              params: { pluginId: entry.pluginId, viewId: entry.contribution.view },
            })
          }
        />
      ))}
    </>
  );
}
