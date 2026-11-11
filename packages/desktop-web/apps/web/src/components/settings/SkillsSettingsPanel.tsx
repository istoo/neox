// FILE: SkillsSettingsPanel.tsx
// Purpose: Settings → Skills backed by Neox's Library. Lists the library's
//   skills, which agents receive each one, updates, notes, imports and the
//   server-side market.
// Layer: Settings UI components

import type {
  LibraryMutationResult,
  LibraryProblem,
  LibrarySkillMarketHit,
  LibrarySkillSource,
  LibrarySkillView,
} from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { applyLibraryMutation, useNeolixLibrary } from "~/lib/neolixLibraryQuery";
import { neolixLibraryApi } from "~/lib/neolixLibraryClient";
import { localizeLibraryError } from "~/lib/errorLocalization";
import { revealFolderInShell } from "~/lib/revealFolder";
import { ensureNativeApi } from "~/nativeApi";
import { NEOLIX_LIBRARY_OPEN_FOLDER_UI_ENABLED } from "~/neolixFeatures";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/i18n";
import {
  LibraryAddButton,
  LibraryAgentChips,
  LibraryEditorDialog,
  LibraryEmptyState,
  LibraryErrorState,
  LibraryField,
} from "./LibraryShared";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

type Candidate = { name: string; description: string; path: string; hash: string };
type UpdateState = { available: boolean; gone: boolean };

export function SkillsSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const libraryQuery = useNeolixLibrary();

  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [sourceOpen, setSourceOpen] = useState(false);
  const [kind, setKind] = useState<LibrarySkillSource["kind"]>("github");
  const [repo, setRepo] = useState("");
  const [ref, setRef] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [finding, setFinding] = useState(false);
  const [noteSkill, setNoteSkill] = useState<LibrarySkillView | null>(null);
  const [noteText, setNoteText] = useState("");
  const [marketQuery, setMarketQuery] = useState("");
  const [marketHits, setMarketHits] = useState<LibrarySkillMarketHit[]>([]);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [updates, setUpdates] = useState<Record<string, UpdateState>>({});
  const [owns, setOwns] = useState<LibraryProblem[]>([]);
  const [busyName, setBusyName] = useState<string | null>(null);

  const apply = useCallback(
    async (run: () => Promise<LibraryMutationResult>) => {
      try {
        const result = await run();
        applyLibraryMutation(queryClient, result);
        // An agent's own skill by the library's name: a sync reports it as a
        // problem with `own`, and the user settles it here.
        setOwns(result.result.problems.filter((problem) => problem.own === true));
        toastManager.add({ type: "success", title: t("settings:library_saved") });
        return result;
      } catch (error) {
        toastManager.add({
          type: "error",
          title: t("settings:library_saveFailed"),
          description: localizeLibraryError(error, t),
        });
        return null;
      }
    },
    [queryClient, t],
  );

  const library = libraryQuery.data?.library;
  if (libraryQuery.isLoading) {
    return <p className="text-ui text-muted-foreground">{t("settings:library_loading")}</p>;
  }
  if (libraryQuery.isError || !library) {
    return (
      <LibraryErrorState error={libraryQuery.error} fallback={t("settings:library_loadFailed")} />
    );
  }

  const allAgents = library.agents;
  const updatedCount = Object.values(updates).filter((entry) => entry.available).length;

  const sourceForInput = (): LibrarySkillSource => {
    if (kind === "folder") return { kind: "folder", dir: sourcePath.trim() };
    return {
      kind,
      repo: repo.trim(),
      ...(ref.trim() ? { ref: ref.trim() } : {}),
      ...(sourcePath.trim() ? { path: sourcePath.trim() } : {}),
    };
  };

  const find = async () => {
    setFinding(true);
    // No `finally`: React Compiler cannot lower it and would skip this panel.
    try {
      const result = await neolixLibraryApi.findSkills({ source: sourceForInput() });
      setCandidates([...result.candidates]);
      setSelected(result.candidates.map((candidate) => candidate.name));
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:library_skills_findFailed"),
        description: localizeLibraryError(error, t),
      });
    }
    setFinding(false);
  };

  const installSelected = async () => {
    const ok = await apply(() =>
      neolixLibraryApi.installSkills({ source: sourceForInput(), names: selected }),
    );
    if (ok) {
      setSourceOpen(false);
      setCandidates([]);
      setSelected([]);
    }
  };

  const searchMarket = async () => {
    try {
      const result = await neolixLibraryApi.searchSkillMarket({
        query: marketQuery.trim(),
      });
      setMarketHits([...result.skills]);
      setMarketError(null);
    } catch (error) {
      setMarketError(localizeLibraryError(error, t));
    }
  };

  const installMarketHit = async (hit: LibrarySkillMarketHit) => {
    setBusyName(hit.id);
    await apply(() =>
      neolixLibraryApi.installSkills({
        source: { kind: "github", repo: hit.source },
        names: [hit.name],
      }),
    );
    setBusyName(null);
  };

  const toggleAgent = (skill: LibrarySkillView, agent: string) => {
    const next = skill.agents.includes(agent)
      ? skill.agents.filter((entry) => entry !== agent)
      : [...skill.agents, agent];
    void apply(() => neolixLibraryApi.setSkillAgents({ name: skill.name, agents: next }));
  };

  const saveNote = async () => {
    if (!noteSkill) return;
    const ok = await apply(() =>
      neolixLibraryApi.setSkillNote({ name: noteSkill.name, note: noteText }),
    );
    if (ok) setNoteSkill(null);
  };

  const removeSkill = async (skill: LibrarySkillView) => {
    const confirmed = await ensureNativeApi().dialogs.confirm(
      t("settings:library_removeConfirm", { name: skill.name }),
      { confirmLabel: t("common:delete"), destructive: true },
    );
    if (!confirmed) return;
    setBusyName(skill.name);
    await apply(() => neolixLibraryApi.removeSkill({ name: skill.name }));
    setBusyName(null);
  };

  const checkUpdates = async () => {
    try {
      const result = await neolixLibraryApi.checkSkillUpdates();
      setUpdates(
        Object.fromEntries(
          result.updates.map((update) => [
            update.name,
            { available: update.available, gone: update.gone },
          ]),
        ),
      );
      toastManager.add({
        type: "success",
        title: t("settings:library_skills_updatesFound", {
          count: result.updates.filter((update) => update.available).length,
        }),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:library_skills_findFailed"),
        description: localizeLibraryError(error, t),
      });
    }
  };

  const updateSkills = async (names: string[] | null) => {
    setBusyName(names?.[0] ?? "__all__");
    const ok = await apply(() => neolixLibraryApi.updateSkills({ names }));
    setBusyName(null);
    if (ok) setUpdates({});
  };

  const settle = (problem: LibraryProblem, keepOwn: boolean) => {
    const name = problem.what.startsWith("skill:") ? problem.what.slice(6) : problem.what;
    void apply(() => neolixLibraryApi.settleSkill({ name, agent: problem.agent, keepOwn }));
  };

  const removeMany = async (names: string[], title: string) => {
    if (names.length === 0) return;
    const confirmed = await ensureNativeApi().dialogs.confirm(`${title}\n\n${names.join(", ")}`, {
      confirmLabel: t("common:delete"),
      destructive: true,
    });
    if (!confirmed) return;
    setBusyName("__many__");
    for (const name of names) {
      const ok = await apply(() => neolixLibraryApi.removeSkill({ name }));
      if (!ok) break;
    }
    setBusyName(null);
  };

  const removeAll = () =>
    void removeMany(
      library.skills.map((skill) => skill.name),
      t("settings:library_skills_removeAllConfirm"),
    );

  const removeGone = () =>
    void removeMany(
      library.skills
        .filter((skill) => skill.gone === true || updates[skill.name]?.gone === true)
        .map((skill) => skill.name),
      t("settings:library_skills_removeGoneConfirm"),
    );

  const goneCount = library.skills.filter(
    (skill) => skill.gone === true || updates[skill.name]?.gone === true,
  ).length;

  const syncNow = async () => {
    await apply(() => neolixLibraryApi.sync());
  };

  const openFolder = (path: string) => revealFolderInShell({ path });

  return (
    <div className="space-y-8">
      <SettingsSection title="settings:skills_portableSkills">
        <SettingsRow
          id="setting-library-skills-folder"
          title="settings:skills_synaraSkillsFolder"
          description={library.dir}
          status={t("settings:library_skills_count", { count: library.skills.length })}
          stackControl
          control={
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                {t("settings:library_skills_importFolder")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSourceOpen(true)}>
                {t("settings:library_skills_installSource")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void syncNow()}>
                {t("settings:library_sync")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void checkUpdates()}>
                {t("settings:library_skills_checkUpdates")}
              </Button>
              {updatedCount > 0 ? (
                <Button size="sm" onClick={() => void updateSkills(null)}>
                  {t("settings:library_skills_updateAll", { count: updatedCount })}
                </Button>
              ) : null}
              {goneCount > 0 ? (
                <Button size="sm" variant="outline" onClick={() => void removeGone()}>
                  {t("settings:library_skills_removeGone")}
                </Button>
              ) : null}
              {library.skills.length > 0 ? (
                <Button size="sm" variant="outline" onClick={() => void removeAll()}>
                  {t("settings:library_skills_removeAll")}
                </Button>
              ) : null}
              {NEOLIX_LIBRARY_OPEN_FOLDER_UI_ENABLED ? (
                <>
                  <Button size="sm" variant="outline" onClick={() => openFolder(library.dir)}>
                    {t("settings:library_openFolder")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => openFolder(library.backupsDir)}>
                    {t("settings:library_openBackups")}
                  </Button>
                </>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void (async () => {
                    const confirmed = await ensureNativeApi().dialogs.confirm(
                      t("settings:library_skills_handOverConfirm"),
                      { confirmLabel: t("common:confirm_move") },
                    );
                    if (confirmed) {
                      await apply(() => neolixLibraryApi.handOverSkills({ names: null }));
                    }
                  })();
                }}
              >
                {t("settings:library_skills_handOver")}
              </Button>
            </div>
          }
        />
      </SettingsSection>

      {owns.length > 0 ? (
        <SettingsSection title="settings:library_skills_conflicts">
          {owns.map((problem) => {
            const agent =
              allAgents.find((entry) => entry.id === problem.agent)?.name ?? problem.agent;
            const name = problem.what.startsWith("skill:") ? problem.what.slice(6) : problem.what;
            return (
              <SettingsRow
                key={`${problem.agent}:${problem.what}`}
                title={t("settings:library_skills_ownName", { name: agent })}
                description={name}
                control={
                  <div className="flex flex-wrap gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyName !== null}
                      onClick={() => settle(problem, false)}
                    >
                      {t("settings:library_skills_useLibrary")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyName !== null}
                      onClick={() => settle(problem, true)}
                    >
                      {t("settings:library_skills_keepOwn", { name: agent })}
                    </Button>
                  </div>
                }
              />
            );
          })}
        </SettingsSection>
      ) : null}

      <SettingsSection title="settings:library_skills_title">
        {library.skills.length === 0 ? (
          <LibraryEmptyState
            title={t("settings:library_skills_emptyTitle")}
            description={t("settings:library_skills_emptyText")}
            actionLabel={t("settings:library_skills_importFolder")}
            onAction={() => setImportOpen(true)}
          />
        ) : (
          library.skills.map((skill) => {
            const update = updates[skill.name];
            return (
              <SettingsRow
                key={skill.name}
                title={
                  <span className="inline-flex items-center gap-2">
                    {skill.name}
                    {skill.modified ? (
                      <span className="text-ui-xs text-warning">
                        {t("settings:library_skills_modified")}
                      </span>
                    ) : null}
                    {update?.available ? (
                      <span className="text-ui-xs text-primary">
                        {t("settings:library_skills_updateAvailable")}
                      </span>
                    ) : null}
                    {skill.gone ? (
                      <span className="text-ui-xs text-destructive">
                        {t("settings:library_skills_gone")}
                      </span>
                    ) : null}
                  </span>
                }
                description={skill.description}
                status={
                  <span className="flex flex-col gap-1">
                    <code className="text-ui-sm text-muted-foreground">{skill.path}</code>
                    {skill.note ? (
                      <span className="text-ui-sm text-muted-foreground">{skill.note}</span>
                    ) : null}
                  </span>
                }
                control={
                  <div className="flex flex-col items-end gap-2">
                    <LibraryAgentChips
                      agents={allAgents}
                      selected={skill.agents}
                      onToggle={(agent) => toggleAgent(skill, agent)}
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="inline-flex items-center gap-1.5 text-ui-sm text-muted-foreground">
                        <Switch
                          checked={!skill.offHere}
                          aria-label={t("settings:library_skills_onHere", {
                            name: skill.name,
                          })}
                          onCheckedChange={(checked) =>
                            void apply(() =>
                              neolixLibraryApi.setSkillHere({
                                name: skill.name,
                                on: Boolean(checked),
                              }),
                            )
                          }
                        />
                        {t("settings:library_skills_onHereHint")}
                      </label>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          setNoteSkill(skill);
                          setNoteText(skill.note ?? "");
                        }}
                      >
                        {t("settings:library_skills_note")}
                      </Button>
                      {update?.available ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busyName !== null}
                          onClick={() => void updateSkills([skill.name])}
                        >
                          {t("settings:library_skills_update")}
                        </Button>
                      ) : null}
                      {skill.shared ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busyName === skill.name}
                          onClick={() =>
                            void apply(() => neolixLibraryApi.handBackSkill({ name: skill.name }))
                          }
                        >
                          {t("settings:library_skills_handBack")}
                        </Button>
                      ) : null}
                      <Button
                        size="xs"
                        variant="destructive-outline"
                        disabled={busyName === skill.name}
                        onClick={() => void removeSkill(skill)}
                      >
                        {t("settings:library_remove")}
                      </Button>
                    </div>
                  </div>
                }
              />
            );
          })
        )}
      </SettingsSection>
      {library.skills.length > 0 ? (
        <LibraryAddButton
          label={t("settings:library_skills_importFolder")}
          onClick={() => setImportOpen(true)}
        />
      ) : null}

      <SettingsSection title="settings:library_skills_options">
        <SettingsRow
          title="settings:library_skills_copy"
          description={t("settings:library_skills_copyHint")}
          control={
            <Switch
              checked={library.skillOptions?.copySkills ?? false}
              aria-label={t("settings:library_skills_copy")}
              onCheckedChange={(checked) =>
                void apply(() => neolixLibraryApi.setSkillOptions({ copySkills: Boolean(checked) }))
              }
            />
          }
        />
        <SettingsRow
          title="settings:library_skills_shared"
          description={t("settings:library_skills_sharedHint")}
          control={
            <Switch
              checked={library.skillOptions?.sharedSkills ?? false}
              aria-label={t("settings:library_skills_shared")}
              onCheckedChange={(checked) =>
                void apply(() =>
                  neolixLibraryApi.setSkillOptions({ sharedSkills: Boolean(checked) }),
                )
              }
            />
          }
        />
      </SettingsSection>

      <SettingsSection title="settings:library_skills_market">
        <div className="flex flex-wrap items-center gap-2 px-4 pt-4">
          <Input
            value={marketQuery}
            placeholder={t("settings:library_skills_marketPlaceholder")}
            onChange={(event) => setMarketQuery(event.target.value)}
            className="max-w-sm"
          />
          <Button size="sm" variant="outline" onClick={() => void searchMarket()}>
            {t("settings:library_skills_marketSearch")}
          </Button>
        </div>
        {marketError ? (
          <p className="px-4 py-3 text-ui-sm text-destructive">{marketError}</p>
        ) : null}
        {marketHits.length === 0 ? (
          <p className="px-4 py-4 text-ui-sm text-muted-foreground">
            {t("settings:library_skills_marketEmpty")}
          </p>
        ) : (
          marketHits.map((hit) => (
            <SettingsRow
              key={hit.id}
              title={hit.name}
              description={hit.source}
              status={t("settings:library_skills_marketInstalls", {
                count: hit.installs,
              })}
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busyName !== null}
                  onClick={() => void installMarketHit(hit)}
                >
                  {t("settings:library_skills_install")}
                </Button>
              }
            />
          ))
        )}
      </SettingsSection>

      <LibraryEditorDialog
        open={importOpen}
        title={t("settings:library_skills_importFolder")}
        description={t("settings:library_skills_importFolderHint")}
        saveDisabled={importPath.trim().length === 0}
        onOpenChange={(open) => (open ? undefined : setImportOpen(false))}
        onSave={() => {
          void (async () => {
            const ok = await apply(() => neolixLibraryApi.importSkill({ path: importPath.trim() }));
            if (ok) {
              setImportOpen(false);
              setImportPath("");
            }
          })();
        }}
      >
        <LibraryField label={t("settings:library_skills_path")}>
          <Input
            value={importPath}
            onChange={(event) => setImportPath(event.target.value)}
            placeholder="/path/to/skill"
          />
        </LibraryField>
      </LibraryEditorDialog>

      <LibraryEditorDialog
        open={sourceOpen}
        title={t("settings:library_skills_installSource")}
        description={t("settings:library_skills_installSourceHint")}
        saveDisabled={candidates.length === 0 || selected.length === 0}
        onOpenChange={(open) => (open ? undefined : setSourceOpen(false))}
        onSave={() => void installSelected()}
      >
        <LibraryField label={t("settings:library_skills_sourceKind")}>
          <div className="flex flex-wrap gap-1.5">
            {(["github", "git", "folder"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={kind === option}
                onClick={() => setKind(option)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-ui-sm",
                  kind === option
                    ? "border-primary/40 bg-primary/10 text-foreground"
                    : "border-border bg-secondary text-muted-foreground",
                )}
              >
                {t(`settings:library_skills_kind_${option}`)}
              </button>
            ))}
          </div>
        </LibraryField>
        {kind === "folder" ? (
          <LibraryField label={t("settings:library_skills_path")}>
            <Input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} />
          </LibraryField>
        ) : (
          <>
            <LibraryField label={t("settings:library_skills_repo")}>
              <Input
                value={repo}
                placeholder="owner/repo"
                onChange={(event) => setRepo(event.target.value)}
              />
            </LibraryField>
            <LibraryField label={t("settings:library_skills_ref")}>
              <Input value={ref} onChange={(event) => setRef(event.target.value)} />
            </LibraryField>
            <LibraryField label={t("settings:library_skills_path")}>
              <Input value={sourcePath} onChange={(event) => setSourcePath(event.target.value)} />
            </LibraryField>
          </>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={finding || (kind === "folder" ? !sourcePath.trim() : !repo.trim())}
          onClick={() => void find()}
        >
          {finding ? t("settings:library_skills_finding") : t("settings:library_skills_find")}
        </Button>
        {candidates.length === 0 ? (
          <p className="text-ui-sm text-muted-foreground">
            {t("settings:library_skills_noCandidates")}
          </p>
        ) : (
          <div className="space-y-1">
            {candidates.map((candidate) => {
              const on = selected.includes(candidate.name);
              return (
                <button
                  key={candidate.name}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setSelected((current) =>
                      current.includes(candidate.name)
                        ? current.filter((entry) => entry !== candidate.name)
                        : [...current, candidate.name],
                    )
                  }
                  className={cn(
                    "flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left",
                    on ? "border-primary/40 bg-primary/10" : "border-border",
                  )}
                >
                  <span className="mt-0.5 size-2 rounded-full bg-primary/60" aria-hidden="true" />
                  <span className="min-w-0">
                    <span className="block text-ui font-medium text-foreground">
                      {candidate.name}
                    </span>
                    <span className="block truncate text-ui-sm text-muted-foreground">
                      {candidate.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </LibraryEditorDialog>

      <LibraryEditorDialog
        open={noteSkill !== null}
        title={t("settings:library_skills_noteTitle", { name: noteSkill?.name ?? "" })}
        onOpenChange={(open) => (open ? undefined : setNoteSkill(null))}
        onSave={() => void saveNote()}
      >
        <LibraryField label={t("settings:library_skills_note")}>
          <Textarea
            value={noteText}
            className="min-h-28 resize-y"
            onChange={(event) => setNoteText(event.target.value)}
          />
        </LibraryField>
      </LibraryEditorDialog>
    </div>
  );
}
