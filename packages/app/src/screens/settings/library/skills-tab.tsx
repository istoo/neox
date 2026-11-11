import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type {
  LibraryProblem,
  LibrarySkillMarketHit,
  LibrarySkillSource,
  LibrarySkillView,
  LibrarySnapshot,
  LibrarySyncResult,
} from "@neolix/protocol/library";
import type { DaemonClient } from "@neolix/client/internal/daemon-client";
import { SettingsCard } from "@/components/settings";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { AgentChips, LibraryEmpty, LibraryIntro, LibraryRowHeader } from "./library-ui";
import { LibraryEditorSheet } from "./library-editor";
import type { LibraryTabProps } from "./types";

interface UpdateState {
  available: boolean;
  gone: boolean;
}

function SkillBadges({
  skill,
  update,
}: {
  skill: LibrarySkillView;
  update: UpdateState | undefined;
}) {
  const { t } = useTranslation();
  const gone = skill.gone || update?.gone;
  return (
    <View style={styles.badges}>
      {gone ? (
        <StatusBadge
          size="xs"
          variant="error"
          label={t("settings.usePages.library.skills.upstreamGone")}
        />
      ) : null}
      {update?.available ? (
        <StatusBadge
          size="xs"
          variant="warning"
          label={t("settings.usePages.library.skills.updateAvailable")}
        />
      ) : null}
      {skill.modified ? (
        <StatusBadge size="xs" label={t("settings.usePages.library.skills.modifiedLocally")} />
      ) : null}
      {skill.offHere ? (
        <StatusBadge size="xs" label={t("settings.usePages.library.skills.offLocally")} />
      ) : null}
    </View>
  );
}

function ConflictRow({
  problem,
  agents,
  busy,
  onSettle,
}: {
  problem: LibraryProblem;
  agents: { id: string; name: string }[];
  busy: boolean;
  onSettle: (agent: string, name: string, keepOwn: boolean) => void;
}) {
  const { t } = useTranslation();
  const name = problem.what.startsWith("skill:") ? problem.what.slice(6) : problem.what;
  const agentName = agents.find((entry) => entry.id === problem.agent)?.name ?? problem.agent;
  const useLibrary = useCallback(
    () => onSettle(problem.agent, name, false),
    [name, onSettle, problem.agent],
  );
  const keepOwn = useCallback(
    () => onSettle(problem.agent, name, true),
    [name, onSettle, problem.agent],
  );
  return (
    <View style={settingsStyles.row}>
      <View style={styles.grow}>
        <Text style={settingsStyles.rowHint}>
          {t("settings.usePages.library.actions.ownSkill", { name: agentName })}
        </Text>
        <View style={styles.footer}>
          <Button variant="outline" onPress={useLibrary} disabled={busy}>
            {t("settings.usePages.library.actions.useLibrary")}
          </Button>
          <Button variant="outline" onPress={keepOwn} disabled={busy}>
            {t("settings.usePages.library.actions.keepOwn", { name: agentName })}
          </Button>
        </View>
      </View>
    </View>
  );
}

function SkillRow({
  skill,
  agents,
  update,
  disabled,
  onOpen,
  onToggleAgent,
}: {
  skill: LibrarySkillView;
  agents: { id: string; name: string }[];
  update: UpdateState | undefined;
  disabled: boolean;
  onOpen: (skill: LibrarySkillView) => void;
  onToggleAgent: (skill: LibrarySkillView, agent: string) => void;
}) {
  const { t } = useTranslation();
  const open = useCallback(() => onOpen(skill), [onOpen, skill]);
  const toggle = useCallback(
    (agent: string) => onToggleAgent(skill, agent),
    [onToggleAgent, skill],
  );
  return (
    <View style={settingsStyles.row}>
      <View style={[settingsStyles.rowContent, styles.rowBody]}>
        <PressHighlight onPress={disabled ? undefined : open} style={styles.rowText}>
          <View style={styles.titleRow}>
            <Text style={settingsStyles.rowTitle}>{skill.name}</Text>
            <SkillBadges skill={skill} update={update} />
          </View>
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {skill.description || t("settings.usePages.library.skills.descriptionEmpty")}
          </Text>
        </PressHighlight>
        <AgentChips agents={agents} selected={skill.agents} disabled={disabled} onToggle={toggle} />
      </View>
    </View>
  );
}

function useSkillMutation(
  onLibrary: (library: LibrarySnapshot) => void,
  onSaved: (result: LibrarySyncResult) => void,
  onError: (error: unknown) => void,
  onOwns?: (owns: LibraryProblem[]) => void,
) {
  return useCallback(
    async (work: () => Promise<{ library: LibrarySnapshot; result: LibrarySyncResult }>) => {
      try {
        const result = await work();
        onLibrary(result.library);
        onSaved(result.result);
        // An agent's own skill by the library's name, found by this sync
        // (myna keeps these in the result, not in the snapshot).
        onOwns?.(result.result.problems.filter((problem) => problem.own === true));
      } catch (error) {
        onError(error);
      }
    },
    [onError, onLibrary, onOwns, onSaved],
  );
}

export function SkillsTab({
  library,
  client,
  onLibrary,
  onSaved,
  onError,
  disabled,
}: LibraryTabProps) {
  const { t } = useTranslation();
  const [sourceOpen, setSourceOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [marketOpen, setMarketOpen] = useState(false);
  const [selected, setSelected] = useState<LibrarySkillView | null>(null);
  const [updates, setUpdates] = useState<Record<string, UpdateState>>({});
  const [owns, setOwns] = useState<LibraryProblem[]>([]);
  const [busy, setBusy] = useState(false);

  const agents = useMemo(
    () => library.agents.map((agent) => ({ id: agent.id, name: agent.name })),
    [library.agents],
  );
  const run = useSkillMutation(onLibrary, onSaved, onError, setOwns);

  const settle = useCallback(
    (agent: string, name: string, keepOwn: boolean) => {
      void run(() => client.settleLibrarySkill(name, agent, keepOwn));
    },
    [client, run],
  );

  const toggleAgent = useCallback(
    (skill: LibrarySkillView, agent: string) => {
      const next = skill.agents.includes(agent)
        ? skill.agents.filter((entry) => entry !== agent)
        : [...skill.agents, agent];
      void run(() => client.setLibrarySkillAgents(skill.name, next));
    },
    [client, run],
  );

  const checkUpdates = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        const result = await client.checkLibrarySkillUpdates();
        const next: Record<string, UpdateState> = {};
        for (const update of result.updates) {
          next[update.name] = { available: update.available, gone: update.gone };
        }
        setUpdates(next);
      } catch (error) {
        onError(error);
      } finally {
        setBusy(false);
      }
    })();
  }, [client, onError]);

  const updateAll = useCallback(() => {
    setBusy(true);
    void (async () => {
      await run(() => client.updateLibrarySkills(null));
      setUpdates({});
      setBusy(false);
    })();
  }, [client, run]);

  const hasUpdates = Object.values(updates).some((update) => update.available || update.gone);

  const remove = useCallback(
    async (name: string) => {
      const confirmed = await confirmDialog({
        title: t("settings.usePages.library.common.remove"),
        message: t("settings.usePages.library.skills.removeConfirm", { name }),
        confirmLabel: t("settings.usePages.library.common.remove"),
        cancelLabel: t("settings.usePages.library.common.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      await run(() => client.removeLibrarySkill(name));
      setSelected(null);
    },
    [client, run, t],
  );

  const handOver = useCallback(
    async (skills: LibrarySkillView[]) => {
      if (skills.length === 0) {
        return;
      }
      const one = skills.length === 1;
      const first = skills[0];
      const readers = [...new Set(skills.flatMap((skill) => skill.always ?? []))]
        .map((id) => agents.find((agent) => agent.id === id)?.name ?? id)
        .join(", ");
      const target = `${library.dir}/skills/`;
      let moved: string;
      if (!one) {
        moved = t("settings.usePages.library.actions.manageMovesMany", { to: target });
      } else if (first.sharedElsewhere) {
        moved = t("settings.usePages.library.actions.manageElsewhere", {
          path: first.source?.dir ?? first.shared ?? "",
        });
      } else {
        moved = t("settings.usePages.library.actions.manageMovesOne", {
          from: first.shared ?? "",
          to: `${target}${first.name}`,
        });
      }
      const lines = [
        moved,
        ...(readers
          ? [
              one
                ? t("settings.usePages.library.actions.manageReadersOne", { agents: readers })
                : t("settings.usePages.library.actions.manageReadersMany", { agents: readers }),
            ]
          : []),
        t("settings.usePages.library.actions.managePutBack", {
          cmd: `neolix library skill hand-back ${one ? first.name : "<name>"}`,
        }),
      ];
      const confirmed = await confirmDialog({
        title: one
          ? t("settings.usePages.library.actions.manageAskOne", { name: first.name })
          : t("settings.usePages.library.actions.manageAskMany", { count: skills.length }),
        message: lines.join("\n\n"),
        confirmLabel: t("settings.usePages.library.actions.moveIntoLibrary"),
        cancelLabel: t("settings.usePages.library.common.cancel"),
      });
      if (!confirmed) {
        return;
      }
      setBusy(true);
      try {
        await run(() => client.handOverLibrarySkills(skills.map((skill) => skill.name)));
      } finally {
        setBusy(false);
      }
    },
    [agents, client, library.dir, run, t],
  );

  const kept = useMemo(() => library.skills.filter((skill) => skill.shared), [library.skills]);
  const manageKept = useCallback(() => {
    void handOver(kept);
  }, [handOver, kept]);
  const manageOne = useCallback(
    (skill: LibrarySkillView) => {
      void handOver([skill]);
    },
    [handOver],
  );

  const removeMany = useCallback(
    async (names: string[], title: string) => {
      if (names.length === 0) {
        return;
      }
      const confirmed = await confirmDialog({
        title,
        message: names.join(", "),
        confirmLabel: t("settings.usePages.library.common.remove"),
        cancelLabel: t("settings.usePages.library.common.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      setBusy(true);
      try {
        for (const name of names) {
          const result = await client.removeLibrarySkill(name);
          onLibrary(result.library);
          onSaved(result.result);
        }
      } catch (error) {
        onError(error);
      } finally {
        setBusy(false);
      }
    },
    [client, onError, onLibrary, onSaved, t],
  );

  const removeAll = useCallback(() => {
    void removeMany(
      library.skills.map((skill) => skill.name),
      t("settings.usePages.library.actions.removeAll"),
    );
  }, [library.skills, removeMany, t]);

  const removeGone = useCallback(() => {
    void removeMany(
      library.skills
        .filter((skill) => skill.gone === true || updates[skill.name]?.gone === true)
        .map((skill) => skill.name),
      t("settings.usePages.library.actions.removeGone"),
    );
  }, [library.skills, removeMany, t, updates]);

  const openSource = useCallback(() => setSourceOpen(true), []);
  const closeSource = useCallback(() => setSourceOpen(false), []);
  const openMarket = useCallback(() => setMarketOpen(true), []);
  const closeMarket = useCallback(() => setMarketOpen(false), []);
  const openOptions = useCallback(() => setOptionsOpen(true), []);
  const closeOptions = useCallback(() => setOptionsOpen(false), []);
  const openSkill = useCallback((skill: LibrarySkillView) => setSelected(skill), []);
  const closeSkill = useCallback(() => setSelected(null), []);
  const removeSelected = useCallback(() => {
    if (selected) {
      void remove(selected.name);
    }
  }, [remove, selected]);

  return (
    <View>
      <LibraryIntro>{t("settings.usePages.library.skills.intro")}</LibraryIntro>
      {owns.length > 0 ? (
        <SettingsCard>
          {owns.map((problem) => (
            <ConflictRow
              key={`${problem.agent}:${problem.what}`}
              problem={problem}
              agents={agents}
              busy={busy}
              onSettle={settle}
            />
          ))}
        </SettingsCard>
      ) : null}
      <LibraryRowHeader label={t("settings.usePages.library.tabs.skills")} />
      {kept.length > 1 ? (
        <View style={styles.footer}>
          <Button variant="outline" onPress={manageKept} disabled={disabled || busy}>
            {t("settings.usePages.library.actions.manageMany", { count: kept.length })}
          </Button>
        </View>
      ) : null}
      {library.skills.length === 0 ? (
        <SettingsCard>
          <LibraryEmpty
            title={t("settings.usePages.library.skills.emptyTitle")}
            text={t("settings.usePages.library.skills.emptyText")}
            actionLabel={t("settings.usePages.library.skills.install")}
            onAction={openSource}
          />
        </SettingsCard>
      ) : (
        <SettingsCard>
          {library.skills.map((skill) => (
            <SkillRow
              key={skill.name}
              skill={skill}
              agents={agents}
              update={updates[skill.name]}
              disabled={disabled}
              onOpen={openSkill}
              onToggleAgent={toggleAgent}
            />
          ))}
        </SettingsCard>
      )}
      <View style={styles.footer}>
        <Button variant="outline" onPress={openSource} disabled={disabled}>
          {t("settings.usePages.library.skills.install")}
        </Button>
        <Button variant="outline" onPress={openMarket} disabled={disabled}>
          {t("settings.usePages.library.skills.market")}
        </Button>
        <Button variant="outline" onPress={openOptions} disabled={disabled}>
          {t("settings.usePages.library.skills.options")}
        </Button>
        <Button variant="outline" onPress={checkUpdates} disabled={disabled || busy}>
          {t("settings.usePages.library.skills.checkUpdates")}
        </Button>
        {hasUpdates ? (
          <Button variant="default" onPress={updateAll} disabled={disabled || busy}>
            {t("settings.usePages.library.skills.updateAll")}
          </Button>
        ) : null}
        {library.skills.some((skill) => skill.gone === true) ? (
          <Button variant="outline" onPress={removeGone} disabled={disabled || busy}>
            {t("settings.usePages.library.actions.removeGone")}
          </Button>
        ) : null}
        {library.skills.length > 0 ? (
          <Button variant="outline" onPress={removeAll} disabled={disabled || busy}>
            {t("settings.usePages.library.actions.removeAll")}
          </Button>
        ) : null}
      </View>

      <SourceSheet
        visible={sourceOpen}
        client={client}
        onClose={closeSource}
        onLibrary={onLibrary}
        onSaved={onSaved}
        onError={onError}
      />
      <MarketSheet
        visible={marketOpen}
        client={client}
        onClose={closeMarket}
        onLibrary={onLibrary}
        onSaved={onSaved}
        onError={onError}
      />
      <OptionsSheet
        visible={optionsOpen}
        library={library}
        client={client}
        onClose={closeOptions}
        onLibrary={onLibrary}
        onSaved={onSaved}
        onError={onError}
      />
      {selected ? (
        <SkillSheet
          key={selected.name}
          skill={selected}
          client={client}
          onClose={closeSkill}
          onLibrary={onLibrary}
          onSaved={onSaved}
          onRemove={removeSelected}
          onError={onError}
          onHandOver={manageOne}
        />
      ) : null}
    </View>
  );
}

function CandidateRow({
  name,
  description,
  selected,
  onToggle,
}: {
  name: string;
  description: string;
  selected: boolean;
  onToggle: (name: string) => void;
}) {
  const toggle = useCallback(() => onToggle(name), [name, onToggle]);
  return (
    <View style={settingsStyles.row}>
      <View style={styles.grow}>
        <Text style={settingsStyles.rowTitle}>{name}</Text>
        <Text style={settingsStyles.rowHint} numberOfLines={2}>
          {description}
        </Text>
      </View>
      <Switch value={selected} onValueChange={toggle} accessibilityLabel={name} />
    </View>
  );
}

const SOURCE_KINDS = ["github", "git", "folder"] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];

function SourceSheet({
  visible,
  client,
  onClose,
  onLibrary,
  onSaved,
  onError,
}: {
  visible: boolean;
  client: DaemonClient;
  onClose: () => void;
  onLibrary: (library: LibrarySnapshot) => void;
  onSaved: (result: LibrarySyncResult) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<SourceKind>("github");
  const [repo, setRepo] = useState("");
  const [dir, setDir] = useState("");
  const [ref, setRef] = useState("");
  const [subpath, setSubpath] = useState("");
  const [candidates, setCandidates] = useState<
    { name: string; description: string; path: string }[] | null
  >(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.usePages.library.skills.install") }),
    [t],
  );
  const kindOptions = useMemo(
    () =>
      SOURCE_KINDS.map((value) => ({
        value,
        label: t(`settings.usePages.library.skills.kind.${value}`),
      })),
    [t],
  );

  const source = useMemo<LibrarySkillSource>(
    () => ({
      kind,
      ...(kind === "folder" ? { dir: dir.trim() } : { repo: repo.trim() }),
      ...(ref.trim() ? { ref: ref.trim() } : {}),
      ...(subpath.trim() ? { path: subpath.trim() } : {}),
    }),
    [dir, kind, ref, repo, subpath],
  );

  const close = useCallback(() => {
    setCandidates(null);
    setSelected(new Set());
    onClose();
  }, [onClose]);

  const find = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        const result = await client.findLibrarySkills(source);
        setCandidates(result.candidates);
        setSelected(new Set(result.candidates.map((candidate) => candidate.name)));
      } catch (error) {
        onError(error);
      } finally {
        setBusy(false);
      }
    })();
  }, [client, onError, source]);

  const toggle = useCallback((name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const install = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        const result = await client.installLibrarySkills(source, [...selected]);
        onLibrary(result.library);
        onSaved(result.result);
        close();
      } catch (error) {
        onError(error);
      } finally {
        setBusy(false);
      }
    })();
  }, [client, close, onError, onLibrary, onSaved, selected, source]);

  let candidateList: ReactNode = null;
  if (candidates !== null) {
    candidateList =
      candidates.length === 0 ? (
        <Text style={styles.hint}>{t("settings.usePages.library.skills.findEmpty")}</Text>
      ) : (
        <View>
          {candidates.map((candidate) => (
            <CandidateRow
              key={candidate.name}
              name={candidate.name}
              description={candidate.description}
              selected={selected.has(candidate.name)}
              onToggle={toggle}
            />
          ))}
        </View>
      );
  }

  return (
    <AdaptiveModalSheet visible={visible} header={header} onClose={close}>
      <View style={styles.sheetBody}>
        <SegmentedControl options={kindOptions} value={kind} onValueChange={setKind} />
        {kind === "folder" ? (
          <Field label={t("settings.usePages.library.skills.dir")}>
            <FormTextInput
              initialValue=""
              onChangeText={setDir}
              placeholder="~/skills"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
        ) : (
          <Field label={t("settings.usePages.library.skills.repo")}>
            <FormTextInput
              initialValue=""
              onChangeText={setRepo}
              placeholder={kind === "github" ? "owner/repo" : "https://example.com/skills.git"}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
        )}
        <Field label={t("settings.usePages.library.skills.ref")}>
          <FormTextInput
            initialValue=""
            onChangeText={setRef}
            placeholder="main"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
        <Field label={t("settings.usePages.library.skills.subpath")}>
          <FormTextInput
            initialValue=""
            onChangeText={setSubpath}
            placeholder="skills"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
        <Button variant="outline" onPress={find} disabled={busy}>
          {t("settings.usePages.library.skills.find")}
        </Button>
        {candidateList}
        <Button variant="default" onPress={install} disabled={busy || selected.size === 0}>
          {t("settings.usePages.library.skills.installSelected")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

function MarketResult({
  hit,
  installing,
  onInstall,
}: {
  hit: LibrarySkillMarketHit;
  installing: boolean;
  onInstall: (hit: LibrarySkillMarketHit) => void;
}) {
  const { t } = useTranslation();
  const install = useCallback(() => onInstall(hit), [hit, onInstall]);
  return (
    <View style={settingsStyles.row}>
      <View style={styles.grow}>
        <Text style={settingsStyles.rowTitle}>{hit.name}</Text>
        <Text style={settingsStyles.rowHint}>
          {hit.source} · {t("settings.usePages.library.skills.installs", { count: hit.installs })}
        </Text>
      </View>
      <Button variant="outline" onPress={install} disabled={installing}>
        {t("settings.usePages.library.skills.installOne")}
      </Button>
    </View>
  );
}

function MarketSheet({
  visible,
  client,
  onClose,
  onLibrary,
  onSaved,
  onError,
}: {
  visible: boolean;
  client: DaemonClient;
  onClose: () => void;
  onLibrary: (library: LibrarySnapshot) => void;
  onSaved: (result: LibrarySyncResult) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LibrarySkillMarketHit[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.usePages.library.skills.market") }),
    [t],
  );

  const search = useCallback(() => {
    setBusy("search");
    void (async () => {
      try {
        const result = await client.searchLibrarySkillMarket(query);
        setHits(result.skills);
      } catch (error) {
        onError(error);
      } finally {
        setBusy(null);
      }
    })();
  }, [client, onError, query]);

  const install = useCallback(
    (hit: LibrarySkillMarketHit) => {
      setBusy(hit.id);
      void (async () => {
        try {
          const result = await client.installLibrarySkills({ kind: "github", repo: hit.source }, [
            hit.name,
          ]);
          onLibrary(result.library);
          onSaved(result.result);
          onClose();
        } catch (error) {
          onError(error);
        } finally {
          setBusy(null);
        }
      })();
    },
    [client, onClose, onError, onLibrary, onSaved],
  );

  let resultList: ReactNode = null;
  if (hits !== null) {
    resultList =
      hits.length === 0 ? (
        <Text style={styles.hint}>{t("settings.usePages.library.skills.marketEmpty")}</Text>
      ) : (
        <View>
          {hits.map((hit) => (
            <MarketResult key={hit.id} hit={hit} installing={busy === hit.id} onInstall={install} />
          ))}
        </View>
      );
  }

  return (
    <AdaptiveModalSheet visible={visible} header={header} onClose={onClose}>
      <View style={styles.sheetBody}>
        <Field label={t("settings.usePages.library.skills.marketSearch")}>
          <FormTextInput
            initialValue=""
            onChangeText={setQuery}
            placeholder={t("settings.usePages.library.skills.marketPlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
        <Button variant="outline" onPress={search} disabled={busy !== null}>
          {t("settings.usePages.library.skills.marketSearch")}
        </Button>
        {resultList}
        <Button variant="secondary" onPress={onClose}>
          {t("settings.usePages.library.common.cancel")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

function OptionRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <View style={settingsStyles.row}>
      <Text style={[settingsStyles.rowTitle, styles.grow]}>{label}</Text>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} />
    </View>
  );
}

function OptionsSheet({
  visible,
  library,
  client,
  onClose,
  onLibrary,
  onSaved,
  onError,
}: {
  visible: boolean;
  library: LibrarySnapshot;
  client: DaemonClient;
  onClose: () => void;
  onLibrary: (library: LibrarySnapshot) => void;
  onSaved: (result: LibrarySyncResult) => void;
  onError: (error: unknown) => void;
}) {
  const { t } = useTranslation();
  const options = library.skillOptions;
  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.usePages.library.skills.options") }),
    [t],
  );
  const run = useSkillMutation(onLibrary, onSaved, onError);

  const setCopy = useCallback(
    (copySkills: boolean) => {
      void run(() => client.setLibrarySkillOptions({ copySkills }));
    },
    [client, run],
  );
  const setShared = useCallback(
    (sharedSkills: boolean) => {
      void run(() => client.setLibrarySkillOptions({ sharedSkills }));
    },
    [client, run],
  );

  return (
    <AdaptiveModalSheet visible={visible} header={header} onClose={onClose}>
      <View style={styles.sheetBody}>
        <Text style={styles.hint}>{t("settings.usePages.library.skills.optionsHint")}</Text>
        <OptionRow
          label={t("settings.usePages.library.skills.copies")}
          value={options?.copySkills ?? false}
          onChange={setCopy}
        />
        <OptionRow
          label={t("settings.usePages.library.skills.sharedFolder")}
          value={options?.sharedSkills ?? false}
          onChange={setShared}
        />
        <Button variant="secondary" onPress={onClose}>
          {t("settings.usePages.library.common.cancel")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

function SkillSheet({
  skill,
  client,
  onClose,
  onLibrary,
  onSaved,
  onRemove,
  onError,
  onHandOver,
}: {
  skill: LibrarySkillView;
  client: DaemonClient;
  onClose: () => void;
  onLibrary: (library: LibrarySnapshot) => void;
  onSaved: (result: LibrarySyncResult) => void;
  onRemove: () => void;
  onError: (error: unknown) => void;
  onHandOver: (skill: LibrarySkillView) => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState(skill.note ?? "");
  const [busy, setBusy] = useState(false);
  const save = useCallback(async () => {
    const result = await client.setLibrarySkillNote(skill.name, note);
    onLibrary(result.library);
    onSaved(result.result);
  }, [client, note, onLibrary, onSaved, skill.name]);

  const setHere = useCallback(
    (on: boolean) => {
      setBusy(true);
      void (async () => {
        try {
          const result = await client.setLibrarySkillHere(skill.name, on);
          onLibrary(result.library);
          onSaved(result.result);
        } catch (error) {
          onError(error);
        } finally {
          setBusy(false);
        }
      })();
    },
    [client, onError, onLibrary, onSaved, skill.name],
  );

  const toggleHere = useCallback((on: boolean) => setHere(!on), [setHere]);
  const manage = useCallback(() => onHandOver(skill), [onHandOver, skill]);

  const handBack = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        const result = await client.handBackLibrarySkill(skill.name);
        onLibrary(result.library);
        onSaved(result.result);
      } catch (error) {
        onError(error);
      } finally {
        setBusy(false);
      }
    })();
  }, [client, onError, onLibrary, onSaved, skill.name]);

  const sourceText = skill.source
    ? [skill.source.repo ?? skill.source.dir, skill.source.ref, skill.source.path]
        .filter(Boolean)
        .join(" · ")
    : t("settings.usePages.library.skills.noSource");

  return (
    <LibraryEditorSheet
      visible
      title={skill.name}
      onClose={onClose}
      onSave={save}
      removeLabel={t("settings.usePages.library.common.remove")}
      onRemove={onRemove}
    >
      <Text style={settingsStyles.rowHint}>{skill.description}</Text>
      <Text style={settingsStyles.rowHint}>{skill.path}</Text>
      <Text style={settingsStyles.rowHint}>{sourceText}</Text>
      {skill.shared ? (
        <Button variant="outline" onPress={manage}>
          {t("settings.usePages.library.actions.manageOne")}
        </Button>
      ) : null}
      {skill.commit ? (
        <Text style={styles.hint}>
          {t("settings.usePages.library.skills.commit", { commit: skill.commit.slice(0, 12) })}
        </Text>
      ) : null}
      <Field label={t("settings.usePages.library.skills.note")}>
        <FormTextInput
          initialValue={skill.note ?? ""}
          onChangeText={setNote}
          placeholder={t("settings.usePages.library.skills.notePlaceholder")}
          multiline
          autoCorrect={false}
        />
      </Field>
      <View style={settingsStyles.row}>
        <View style={styles.grow}>
          <Text style={settingsStyles.rowTitle}>
            {t("settings.usePages.library.skills.offLocally")}
          </Text>
        </View>
        <Switch
          value={skill.offHere === true}
          onValueChange={toggleHere}
          disabled={busy}
          accessibilityLabel={t("settings.usePages.library.skills.offLocally")}
        />
      </View>
      <Button variant="outline" onPress={handBack} disabled={busy}>
        {t("settings.usePages.library.actions.handBack")}
      </Button>
    </LibraryEditorSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowBody: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[2],
  },
  rowText: {
    gap: theme.spacing[0.5],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  badges: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  footer: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
  },
  sheetBody: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  grow: {
    flex: 1,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
