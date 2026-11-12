import type {
  ImportProjectInput,
  ProjectImportProject,
  ProjectImportProvider,
} from "@synara/contracts";

export const IMPORT_PROVIDERS: readonly ProjectImportProvider[] = ["codex", "claudeAgent"];
export const IMPORT_PROVIDER_LABELS: Record<ProjectImportProvider, string> = {
  codex: "Codex",
  claudeAgent: "Claude Code",
};

export interface ProjectImportQueueItem {
  readonly key: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly input: ImportProjectInput;
}

const MAX_IMPORT_FAILURE_TITLE = 48;
const MAX_IMPORT_FAILURE_DETAIL = 140;

function clipImportText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * 导入失败列表只给一行可读的原因：标题压成单行，已知的 provider 不匹配换成
 * 本地化说明。原始错误仍由调用方的 title 属性保留，排查时可见。
 */
export function summarizeImportFailure(
  title: string,
  error: string,
  translate: (key: string, values?: Record<string, unknown>) => string,
): { readonly title: string; readonly detail: string } {
  const compactTitle = clipImportText(title.replace(/\s+/gu, " ").trim(), MAX_IMPORT_FAILURE_TITLE);
  const mismatch = /uses ([^\s,]+)[, ]+but your current provider is ([^\s.]+)/iu.exec(error);
  if (mismatch?.[1] && mismatch[2]) {
    return {
      title: compactTitle,
      detail: translate("workspace:importFailureProviderMismatch", {
        used: mismatch[1],
        current: mismatch[2],
      }),
    };
  }
  const firstLine =
    error
      .split(/\r?\n/u)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  return {
    title: compactTitle,
    detail: clipImportText(firstLine || error.trim(), MAX_IMPORT_FAILURE_DETAIL),
  };
}

export function projectImportItemKey(projectKey: string, threadKey: string | null): string {
  return JSON.stringify([projectKey, threadKey]);
}

export function selectableProjectImportKeys(
  project: ProjectImportProject,
  includeArchived: boolean,
): string[] {
  if (project.threads.length === 0) {
    return project.existingProjectId ? [] : [projectImportItemKey(project.key, null)];
  }
  return project.threads
    .filter((thread) => !thread.alreadyImported && (includeArchived || !thread.archived))
    .map((thread) => projectImportItemKey(project.key, thread.key));
}

export function buildProjectImportQueue(options: {
  readonly projects: readonly ProjectImportProject[];
  readonly selected: ReadonlySet<string>;
  readonly includeArchived: boolean;
  readonly workspaceRoots: Readonly<Record<string, string>>;
}): ProjectImportQueueItem[] {
  return options.projects.flatMap((project) => {
    const workspaceRoot = options.workspaceRoots[project.key]?.trim();
    const keys = new Set(selectableProjectImportKeys(project, options.includeArchived));
    const threads = project.threads.length === 0 ? [null] : project.threads;
    return threads.flatMap((thread) => {
      const key = projectImportItemKey(project.key, thread?.key ?? null);
      if (!keys.has(key) || !options.selected.has(key)) return [];
      return [
        {
          key,
          title: thread
            ? `${project.title} · ${thread.title || "Untitled conversation"}`
            : project.title,
          workspaceRoot: workspaceRoot || project.workspaceRoot,
          input: {
            projectKey: project.key,
            threadKey: thread?.key ?? null,
            ...(workspaceRoot ? { workspaceRoot } : {}),
            spaceId: null,
          },
        },
      ];
    });
  });
}
