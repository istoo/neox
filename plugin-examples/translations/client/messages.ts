import { defineTranslations } from "@neolix/plugin/client";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

export const messages = defineTranslations({ resources: { en, "zh-CN": zhCN } });
