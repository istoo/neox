// FILE: DiffPanelCommitsMenu.tsx
// Purpose: Commit-history section for the diff panel's source menu. Selecting a commit
//          switches the panel to that commit's own diff, matching the old app's commits
//          section; a selected commit offers the way back to the working-tree diff.
// Layer: Diff panel UI

import { useQuery } from "@tanstack/react-query";

import { gitCommitsQueryOptions } from "~/lib/gitReactQuery";
import { GitCommitIcon, XIcon } from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { MenuGroup, MenuGroupLabel, MenuItem } from "./ui/menu";
import { useTranslation } from "~/i18n";

export function DiffPanelCommitsMenuSection(props: {
  cwd: string | null;
  open: boolean;
  activeCommitSha: string | null;
  onSelectCommit: (sha: string) => void;
  onClearCommit: () => void;
}) {
  const { t, formatLocale } = useTranslation();
  const commitsQuery = useQuery(
    gitCommitsQueryOptions({ cwd: props.cwd, enabled: props.open && props.cwd !== null }),
  );
  // Base commits are context, not work the user made in this checkout; the old app's
  // commits section filtered them out for the same reason.
  const commits = (commitsQuery.data?.commits ?? []).filter((commit) => commit.isOnBase !== true);

  return (
    <MenuGroup>
      <MenuGroupLabel>{t("common:diff_commitHistory")}</MenuGroupLabel>
      {props.activeCommitSha !== null ? (
        <MenuItem
          className="gap-2 px-2 py-1.5"
          onClick={() => {
            props.onClearCommit();
          }}
        >
          <XIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{t("common:diff_backToChanges")}</span>
        </MenuItem>
      ) : null}
      {commitsQuery.isLoading ? (
        <p className="px-2.5 py-2 text-ui-sm text-muted-foreground">
          {t("common:diff_loadingCommits")}
        </p>
      ) : commitsQuery.error ? (
        <p className="px-2.5 py-2 text-ui-sm text-red-500/80">
          {t("common:diff_commitHistoryError")}
        </p>
      ) : commits.length === 0 ? (
        <p className="px-2.5 py-2 text-ui-sm text-muted-foreground">{t("common:diff_noCommits")}</p>
      ) : (
        <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto [&>*]:shrink-0">
          {commits.map((commit) => {
            const isActive = commit.sha === props.activeCommitSha;
            return (
              <MenuItem
                key={commit.sha}
                className={cn(
                  "gap-2 px-2 py-1.5",
                  isActive && "bg-[var(--color-background-button-secondary)]",
                )}
                onClick={() => {
                  props.onSelectCommit(commit.sha);
                }}
              >
                <GitCommitIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="w-14 shrink-0 font-mono text-ui-xs text-muted-foreground tabular-nums">
                  {commit.shortSha}
                </span>
                <span className="min-w-0 flex-1 truncate text-ui-sm">{commit.subject}</span>
                <span className="shrink-0 text-ui-xs text-muted-foreground">
                  {formatRelativeTime(commit.authorDate, Date.now(), formatLocale)}
                </span>
              </MenuItem>
            );
          })}
        </div>
      )}
    </MenuGroup>
  );
}
