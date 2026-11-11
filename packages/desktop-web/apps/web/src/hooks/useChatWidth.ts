// FILE: useChatWidth.ts
// Purpose: Applies the selected chat column width preset as a root CSS variable.
// Layer: Web route lifecycle hook
// Exports: useChatWidth

import { useEffect } from "react";

import { normalizeChatWidthPx, useAppSettings } from "../appSettings";
import {
  getChatWidthCssVariables,
  normalizeChatWidthMode,
  type ChatWidthCssVariable,
} from "../lib/chatWidth";

const CHAT_WIDTH_CSS_VARIABLES = Object.keys(
  getChatWidthCssVariables(),
) as readonly ChatWidthCssVariable[];

export function useChatWidth() {
  const { settings } = useAppSettings();
  const chatWidth = normalizeChatWidthMode(settings.chatWidth);
  const chatWidthPx = normalizeChatWidthPx(settings.chatWidthPx);

  useEffect(() => {
    const root = document.documentElement;
    const rootStyle = root.style;
    const variableValues = getChatWidthCssVariables(chatWidth, chatWidthPx);

    for (const cssVariable of CHAT_WIDTH_CSS_VARIABLES) {
      rootStyle.setProperty(cssVariable, variableValues[cssVariable]);
    }
    root.dataset.chatWidth = chatWidthPx === null ? chatWidth : "custom";

    return () => {
      for (const cssVariable of CHAT_WIDTH_CSS_VARIABLES) {
        rootStyle.removeProperty(cssVariable);
      }
      delete root.dataset.chatWidth;
    };
  }, [chatWidth, chatWidthPx]);
}
