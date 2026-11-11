import type { TrayUsageWords } from "@neolix/protocol/tray-usage-model";
import type { TrayLanguage } from "./tray-manager.js";

/**
 * The menu bar's tooltip in the same nine languages as the tray menu
 * (tray-manager's TRAY_LABELS), so a tray-only launch can spell out the
 * figures before any renderer exists. The renderer's i18n resources are the
 * source of these strings; keep the two in step when either changes.
 */
const TRAY_USAGE_WORDS: Record<TrayLanguage, TrayUsageWords> = {
  en: words({
    todayIn: "Today in Neox",
    last7DaysIn: "Last 7 days in Neox",
    tokens: "tokens",
    requests: "requests",
    used: "used",
    left: "left",
    reset: "resets in {when}",
  }),
  "zh-CN": words({
    todayIn: "今天在 Neox",
    last7DaysIn: "近 7 天在 Neox",
    tokens: "token",
    requests: "次请求",
    used: "已用",
    left: "剩余",
    order: "after",
    reset: "{when}后重置",
  }),
  ar: words({
    todayIn: "اليوم في Neox",
    last7DaysIn: "آخر 7 أيام في Neox",
    tokens: "رمز",
    requests: "طلب",
    used: "مستخدم",
    left: "متبقٍ",
    order: "after",
    reset: "يعيد الضبط بعد {when}",
  }),
  es: words({
    todayIn: "Hoy en Neox",
    last7DaysIn: "Últimos 7 días en Neox",
    tokens: "tokens",
    requests: "peticiones",
    used: "usado",
    left: "restante",
    reset: "se reinicia en {when}",
  }),
  fr: words({
    todayIn: "Aujourd'hui dans Neox",
    last7DaysIn: "7 derniers jours dans Neox",
    tokens: "jetons",
    requests: "requêtes",
    used: "utilisé",
    left: "restant",
    reset: "réinitialisation dans {when}",
  }),
  ja: words({
    todayIn: "今日の Neox",
    last7DaysIn: "過去 7 日間の Neox",
    tokens: "トークン",
    requests: "リクエスト",
    used: "使用",
    left: "残り",
    order: "after",
    reset: "{when}後にリセット",
  }),
  ko: words({
    todayIn: "오늘의 Neox",
    last7DaysIn: "최근 7일의 Neox",
    tokens: "토큰",
    requests: "요청",
    used: "사용",
    left: "남음",
    order: "after",
    reset: "{when} 후 초기화",
  }),
  "pt-BR": words({
    todayIn: "Hoje no Neox",
    last7DaysIn: "Últimos 7 dias no Neox",
    tokens: "tokens",
    requests: "requisições",
    used: "usado",
    left: "restante",
    reset: "reinicia em {when}",
  }),
  ru: words({
    todayIn: "Сегодня в Neox",
    last7DaysIn: "Последние 7 дней в Neox",
    tokens: "токенов",
    requests: "запросов",
    used: "использовано",
    left: "осталось",
    reset: "сброс через {when}",
  }),
};

interface WordsSeed {
  todayIn: string;
  last7DaysIn: string;
  tokens: string;
  requests: string;
  used: string;
  left: string;
  /** Chinese, Arabic, Japanese and Korean put the count after the noun. */
  order?: "before" | "after";
  reset: string;
}

function words(seed: WordsSeed): TrayUsageWords {
  const count = (value: string | number, noun: string): string =>
    seed.order === "after" ? `${noun} ${value}` : `${value} ${noun}`;
  return {
    todayIn: seed.todayIn,
    last7DaysIn: seed.last7DaysIn,
    tokens: (value) => count(value, seed.tokens),
    requests: (value) => count(value, seed.requests),
    used: seed.used,
    left: seed.left,
    resetsIn: (when) => seed.reset.replace("{when}", when),
  };
}

export function trayUsageWords(language: TrayLanguage): TrayUsageWords {
  return TRAY_USAGE_WORDS[language];
}
