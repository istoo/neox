// FILE: JsonTreeView.tsx
// Purpose: myna's foldable JSON tree for archived gateway bodies and replies:
//          objects and arrays fold at their bracket, a primitive is its JSON,
//          every value and key can be copied, and a large container draws its
//          children a page at a time.
// Layer: Settings gateway components

import { type ReactNode, useMemo, useState } from "react";

import { useTranslation } from "~/i18n";

import { CopyTextButton } from "../../ui/copyTextButton";
import {
  JSON_CHILD_PAGE,
  jsonEntries,
  jsonNodeOpen,
  primitiveText,
  rememberJsonNode,
  valueCopyText,
} from "./jsonTree.logic";

const INDENT_PX = 14;

/** What a body tab draws when its text parses as a JSON object or array. */
export function JsonTreeView({ value, stateKey }: { value: unknown; stateKey: string }) {
  return (
    <div className="max-h-80 overflow-auto rounded bg-foreground/5 p-2 font-mono text-ui-xs">
      <JsonNode value={value} name={null} path="" stateKey={stateKey} depth={0} />
    </div>
  );
}

function JsonNode({
  value,
  name,
  path,
  stateKey,
  depth,
}: {
  value: unknown;
  name: string | null;
  path: string;
  stateKey: string;
  depth: number;
}) {
  return isContainer(value) ? (
    <JsonBranch value={value} name={name} path={path} stateKey={stateKey} depth={depth} />
  ) : (
    <JsonPrimitive value={value} name={name} depth={depth} />
  );
}

function JsonPrimitive({
  value,
  name,
  depth,
}: {
  value: unknown;
  name: string | null;
  depth: number;
}) {
  return (
    <JsonRow depth={depth} name={name} value={value}>
      <JsonName name={name} />
      <span className="min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap text-foreground">
        {primitiveText(value)}
      </span>
    </JsonRow>
  );
}

function JsonBranch({
  value,
  name,
  path,
  stateKey,
  depth,
}: {
  value: unknown[] | Record<string, unknown>;
  name: string | null;
  path: string;
  stateKey: string;
  depth: number;
}) {
  const { t } = useTranslation();
  const entries = useMemo(() => jsonEntries(value), [value]);
  const [open, setOpen] = useState(() => jsonNodeOpen(stateKey, path, entries.length));
  const [shown, setShown] = useState(JSON_CHILD_PAGE);
  const [openBracket, closeBracket] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  const label =
    name ??
    (lastSegment === "" ? t("gateway:json_root") : t("gateway:json_item", { index: lastSegment }));
  const visible = entries.slice(0, shown);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    rememberJsonNode(stateKey, path, next);
  };
  return (
    <div>
      <JsonRow depth={depth} name={name} value={value}>
        <JsonName name={name} />
        <button
          type="button"
          aria-expanded={open}
          aria-label={
            open
              ? t("gateway:json_collapse", { name: label })
              : t("gateway:json_expand", { name: label })
          }
          onClick={toggle}
          className="rounded px-0.5 text-foreground hover:bg-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--color-border)]"
        >
          {open ? openBracket : `${openBracket} … ${closeBracket}`}
        </button>
      </JsonRow>
      {open ? (
        <div>
          {visible.map(([childKey, child]) => (
            <JsonNode
              key={childKey}
              value={child}
              name={Array.isArray(value) ? null : childKey}
              path={`${path}/${childKey}`}
              stateKey={stateKey}
              depth={depth + 1}
            />
          ))}
          {entries.length > shown ? (
            <div style={{ paddingLeft: (depth + 1) * INDENT_PX }}>
              <button
                type="button"
                onClick={() => setShown(shown + JSON_CHILD_PAGE)}
                className="rounded px-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
              >
                {t("gateway:json_showMore", {
                  n: Math.min(JSON_CHILD_PAGE, entries.length - shown),
                })}
              </button>
            </div>
          ) : null}
          <div style={{ paddingLeft: depth * INDENT_PX }} className="text-foreground">
            {closeBracket}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function JsonRow({
  depth,
  name,
  value,
  children,
}: {
  depth: number;
  name: string | null;
  value: unknown;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="group/json-node flex flex-wrap items-baseline gap-x-1"
      style={{ paddingLeft: depth * INDENT_PX }}
    >
      {children}
      <span className="inline-flex items-center opacity-100 sm:opacity-0 sm:group-hover/json-node:opacity-100 sm:focus-within:opacity-100">
        {name === null ? null : (
          <CopyTextButton
            text={name}
            label={`${name} ${t("gateway:json_key")}`}
            iconOnly
            className="size-5"
          />
        )}
        <CopyTextButton
          text={valueCopyText(value)}
          label={name === null ? t("gateway:json_value") : `${name} ${t("gateway:json_value")}`}
          iconOnly
          className="size-5"
        />
      </span>
    </div>
  );
}

function JsonName({ name }: { name: string | null }) {
  if (name === null) return null;
  return (
    <span className="shrink-0 select-text text-muted-foreground">{`${JSON.stringify(name)}: `}</span>
  );
}

function isContainer(value: unknown): value is unknown[] | Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
