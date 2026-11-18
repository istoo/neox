// FILE: EditProjectDialog.tsx
// Purpose: Edit a project's local name and its look (emoji, or icon and color) in one place.
// Layer: UI component
// Exports: EditProjectDialog, EditProjectValue

import { useEffect, useId, useRef, useState } from "react";

import { useHostFeatures } from "~/hooks/useHostFeatures";
import { readExecutionContext } from "~/lib/hosts/executionContext";
import type { ProjectAppearance } from "~/lib/projectAppearance";
import { importProjectIconFromUrl, projectIconFromFile } from "~/lib/projectIcons.logic";
import { useProjectIcon, useSetProjectIcon } from "~/lib/projectIcons.query";
import { PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME } from "./CreateGitHubProjectFields";
import { HostUpdateNotice } from "./hosts/HostUpdateNotice";
import { ProjectAppearancePicker } from "./ProjectAppearancePicker";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { useTranslation } from "~/i18n";

export interface EditProjectValue {
  /** Empty clears the local name, so the project shows its folder name again. */
  readonly name: string;
  readonly appearance: ProjectAppearance | null;
}

export interface EditProjectDialogProps {
  open: boolean;
  cwd: string;
  /** The daemon project whose custom icon this dialog reads and writes. */
  projectId?: string | undefined;
  /** Placeholder for the name field: what the project is called with no local name. */
  folderName: string;
  initialValue: EditProjectValue;
  onOpenChange: (open: boolean) => void;
  onSave: (value: EditProjectValue) => void;
}

export function EditProjectDialog({
  open,
  cwd,
  projectId,
  folderName,
  initialValue,
  onOpenChange,
  onSave,
}: EditProjectDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workspace:editProject")}</DialogTitle>
        </DialogHeader>
        {/* Field state lives below DialogPopup, which unmounts its children after the close
            transition, so each open seeds a fresh draft from initialValue. */}
        <EditProjectForm
          cwd={cwd}
          projectId={projectId}
          folderName={folderName}
          initialValue={initialValue}
          onOpenChange={onOpenChange}
          onSave={onSave}
        />
      </DialogPopup>
    </Dialog>
  );
}

function EditProjectForm({
  cwd,
  projectId,
  folderName,
  initialValue,
  onOpenChange,
  onSave,
}: Omit<EditProjectDialogProps, "open">) {
  const { t } = useTranslation();

  const [name, setName] = useState(initialValue.name);
  const [appearance, setAppearance] = useState(initialValue.appearance);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const nameInputId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hostFeatures = useHostFeatures();
  const { iconDataUri, supportsCustomIcons } = useProjectIcon({
    environmentId: readExecutionContext()?.execution.environmentId ?? "local",
    projectId,
    cwd,
  });
  const customIconsUnavailable =
    !supportsCustomIcons && hostFeatures.featureStatus("projectCustomIcon") === "unavailable";
  const setProjectIcon = useSetProjectIcon();

  const applyIconSource = async (source: Parameters<typeof setProjectIcon>[1]) => {
    if (!projectId || imageBusy) return;
    setImageBusy(true);
    setImageError(null);
    try {
      await setProjectIcon(projectId, source);
      // A custom image replaces the local emoji/icon choice so the preview and
      // every other glyph show the same thing.
      setAppearance(null);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : String(error));
    } finally {
      setImageBusy(false);
    }
  };

  useEffect(() => {
    // Deferred a frame: the dialog moves focus itself on open. Matches RenameDialog.
    const frame = window.requestAnimationFrame(() => {
      const nameInput = document.getElementById(nameInputId);
      if (nameInput instanceof HTMLInputElement) {
        nameInput.focus();
        nameInput.select();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [nameInputId]);

  const save = () => {
    onSave({ name: name.trim(), appearance });
    onOpenChange(false);
  };

  return (
    <>
      <DialogPanel>
        {/* The popup is a sibling of the form, not a child of the field: React bubbles
            portal events through the component tree, so inside InputGroupAddon every click
            on the picker's empty space reached the addon's handler and pulled focus into
            the name input. */}
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            {/* Same field as Add project's folder path: the glyph sits in a leading cell,
                here as the button that opens the picker. */}
            <InputGroup className={PROJECT_DIALOG_FIELD_CONTROL_CLASS_NAME}>
              {/* Rounded and clipped like the field: the button's hover / open fill would otherwise
                square off past the field's corners. */}
              <InputGroupAddon className="w-10 self-stretch overflow-hidden rounded-s-[inherit] border-e border-foreground/12 ps-0 has-[>button]:ms-0">
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      aria-label={t("workspace:scripts_chooseIcon")}
                      className="flex size-full cursor-pointer items-center justify-center rounded-s-[inherit] text-muted-foreground outline-hidden transition-colors hover:bg-foreground/5 focus-visible:bg-foreground/6 data-popup-open:bg-foreground/6"
                    />
                  }
                >
                  <span className="relative flex size-4 items-center justify-center">
                    <ProjectSidebarIcon
                      cwd={cwd}
                      projectId={projectId}
                      expanded={false}
                      appearance={appearance}
                    />
                  </span>
                </PopoverTrigger>
              </InputGroupAddon>
              <InputGroupInput
                id={nameInputId}
                aria-label={t("workspace:projectName")}
                value={name}
                placeholder={folderName}
                onChange={(event) => setName(event.target.value)}
              />
            </InputGroup>
          </form>
          <PopoverPopup
            align="start"
            side="bottom"
            sideOffset={8}
            initialFocus={searchInputRef}
            // Opaque like the dialog it opens over: the frosted default lets the
            // dialog's own buttons show through the grid.
            className="w-[22.5rem] bg-popover"
          >
            <ProjectAppearancePicker
              value={appearance}
              searchInputRef={searchInputRef}
              onChange={setAppearance}
              onEmojiPicked={() => setPickerOpen(false)}
            />
          </PopoverPopup>
        </Popover>

        {customIconsUnavailable ? (
          <HostUpdateNotice compact className="mt-3" />
        ) : supportsCustomIcons ? (
          <div className="mt-3 flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  void projectIconFromFile(file)
                    .then((data) => applyIconSource({ type: "upload", data }))
                    .catch((error: unknown) =>
                      setImageError(error instanceof Error ? error.message : String(error)),
                    );
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={imageBusy}
                onClick={() => fileInputRef.current?.click()}
              >
                {t("workspace:projectImage_choose")}
              </Button>
              {iconDataUri ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={imageBusy}
                  onClick={() => void applyIconSource({ type: "automatic" })}
                >
                  {t("workspace:projectImage_useAutomatic")}
                </Button>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="url"
                value={imageUrl}
                onChange={(event) => setImageUrl(event.target.value)}
                placeholder={t("workspace:projectImage_url")}
                aria-label={t("workspace:projectImage_url")}
                className="min-w-0 flex-1"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={imageBusy || imageUrl.trim().length === 0}
                onClick={() => {
                  void importProjectIconFromUrl(imageUrl)
                    .then((data) => {
                      setImageUrl("");
                      return applyIconSource({ type: "upload", data });
                    })
                    .catch((error: unknown) =>
                      setImageError(error instanceof Error ? error.message : String(error)),
                    );
                }}
              >
                {t("workspace:projectImage_import")}
              </Button>
            </div>
            {imageError ? (
              <p role="alert" className="text-ui-xs text-destructive">
                {imageError}
              </p>
            ) : null}
          </div>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
          {t("common:form_cancel")}
        </Button>
        <Button size="sm" onClick={save}>
          {t("computer:form_save")}
        </Button>
      </DialogFooter>
    </>
  );
}
