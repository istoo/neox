import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@synara/contracts";
import { t } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import {
  type ComposerAssistantSelectionAttachment,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import {
  maybeResolveBrowserPromptAttachment,
  type BrowserPromptAttachmentResolution,
} from "../../lib/browserPromptContext";
import {
  maybeResolveDevicePromptAttachment,
  type DevicePromptAttachmentResolution,
} from "../../lib/devicePromptContext";
import { type Thread } from "../../types";
import { toastManager } from "../ui/toast";
interface Input {
  api: NonNullable<ReturnType<typeof readNativeApi>>;
  activeThread: Thread;
  promptForSend: string;
  composerImagesForSend: ComposerImageAttachment[];
  composerFilesForSend: ComposerFileAttachment[];
  composerAssistantSelectionsForSend: ComposerAssistantSelectionAttachment[];
}

export async function resolveChatPromptCaptures({
  api,
  activeThread,
  promptForSend,
  composerImagesForSend,
  composerFilesForSend,
  composerAssistantSelectionsForSend,
}: Input) {
  const browserPromptAttachment: BrowserPromptAttachmentResolution =
    await maybeResolveBrowserPromptAttachment({
      api,
      threadId: activeThread.id,
      prompt: promptForSend,
    }).catch(
      (): BrowserPromptAttachmentResolution => ({
        requested: false,
        image: null,
      }),
    );
  if (browserPromptAttachment.image) {
    const nextAttachmentCount =
      composerImagesForSend.length +
      composerFilesForSend.length +
      composerAssistantSelectionsForSend.length +
      (browserPromptAttachment.image ? 1 : 0);
    if (nextAttachmentCount <= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      composerImagesForSend = [...composerImagesForSend, browserPromptAttachment.image];
    } else {
      toastManager.add({
        type: "warning",
        title: t("chat:attachmentLimitReached", {
          count: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
        }),
        description: t("chat:browserScreenshotSkippedAtLimit"),
      });
    }
  } else if (browserPromptAttachment.requested) {
    const description =
      browserPromptAttachment.reason === "no-open-browser"
        ? t("chat:openTheInAppBrowserFirst")
        : browserPromptAttachment.reason === "no-active-tab"
          ? t("chat:inAppBrowserHasNoActiveTab")
          : browserPromptAttachment.reason === "attachment-processing-failed"
            ? t("chat:browserScreenshotCouldNotBeOptimized")
            : t("chat:browserContextCouldNotBeAttached");
    toastManager.add({
      type: "warning",
      title: t("chat:couldNotAttachInAppBrowserContext"),
      description,
    });
  }

  const devicePromptAttachment: DevicePromptAttachmentResolution =
    await maybeResolveDevicePromptAttachment({
      api,
      threadId: activeThread.id,
      prompt: promptForSend,
    }).catch(
      (): DevicePromptAttachmentResolution => ({
        requested: false,
        image: null,
      }),
    );
  if (devicePromptAttachment.image) {
    const nextAttachmentCount =
      composerImagesForSend.length +
      composerFilesForSend.length +
      composerAssistantSelectionsForSend.length +
      1;
    if (nextAttachmentCount <= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      composerImagesForSend = [...composerImagesForSend, devicePromptAttachment.image];
    } else {
      toastManager.add({
        type: "warning",
        title: t("chat:attachmentLimitReached", {
          count: PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
        }),
        description: t("chat:simulatorScreenshotSkippedAtLimit"),
      });
    }
  } else if (devicePromptAttachment.requested) {
    const description =
      devicePromptAttachment.reason === "no-attached-device"
        ? t("chat:openSimulatorPanelAndChooseDeviceFirst")
        : devicePromptAttachment.reason === "device-not-booted"
          ? t("chat:selectedSimulatorIsStartingUp")
          : devicePromptAttachment.reason === "attachment-processing-failed"
            ? t("chat:simulatorScreenshotCouldNotBeOptimized")
            : t("chat:simulatorContextCouldNotBeAttached");
    toastManager.add({
      type: "warning",
      title: t("chat:couldNotAttachSimulatorScreen"),
      description,
    });
  }
  return { composerImagesForSend };
}
