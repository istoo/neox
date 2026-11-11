import type {
  GatewayQuotaAccountWire,
  GatewayQuotaWindowWire,
  GatewayUsageReportWire,
} from "@neolix/protocol/gateway";

/** The menu bar's allowances, shared by the renderer and the desktop process.
 *
 * myna's gui/trayusage.go draws the cards Settings names
 * (settings.TrayUsages), each saying its windows' figures, beside its icon.
 * Neolix's renderer and the Electron main process both have to compose this
 * text (the main process alone when the app starts in the tray), so the model
 * lives here instead of in either of them.
 */

export interface TrayUsageSettings {
  trayUsages: string[];
  trayNoLogos: boolean;
  trayPace: boolean;
  trayNoCost: boolean;
  trayWindows: Record<string, string[]>;
}

export interface TrayUsageRow {
  id: string;
  name: string;
  usedPercent: number;
  pacePct: number | null;
  resetsAt: number | null;
}

export interface TrayUsageCard {
  id: string;
  name: string;
  /** The provider's id, for a menu bar that draws its mark instead of the name. */
  provider: string;
  providerLabel: string;
  /** The windows the menu bar's short text shows. */
  rows: TrayUsageRow[];
  /** Every window the tooltip lists. */
  lines: TrayUsageRow[];
}

export interface TrayUsageTotal {
  id: "usage:today" | "usage:7d";
  tokens: number;
  costUsd: number;
  calls: number;
}

export interface TrayUsageData {
  cards: TrayUsageCard[];
  totals: TrayUsageTotal[];
}

export interface TrayUsageReports {
  today: GatewayUsageReportWire | null;
  week: GatewayUsageReportWire | null;
}

const TOTAL_IDS = ["usage:today", "usage:7d"] as const;

function readableWindowName(window: GatewayQuotaWindowWire): string {
  if (window.id.trim() !== "") {
    return window.id;
  }
  switch (window.kind) {
    case "tokens5h":
      return "5h";
    case "tokens7d":
      return "7d";
    default:
      return "allowance";
  }
}

function readableCardName(account: GatewayQuotaAccountWire): string {
  const accountLabel = account.accountLabel.trim();
  if (accountLabel === "" || accountLabel === account.providerLabel) {
    return account.providerLabel;
  }
  return `${account.providerLabel} · ${accountLabel}`;
}

function isTotalId(id: string): id is TrayUsageTotal["id"] {
  return (TOTAL_IDS as readonly string[]).includes(id);
}

/** The totals myna offers beside the allowances: today and the last 7 days. */
function totalFor(id: TrayUsageTotal["id"], reports: TrayUsageReports): TrayUsageTotal | null {
  const report = id === "usage:today" ? reports.today : reports.week;
  if (report === null) {
    return null;
  }
  return {
    id,
    tokens:
      report.totals.inputTokens +
      report.totals.outputTokens +
      report.totals.cacheReadTokens +
      report.totals.cacheWriteTokens,
    costUsd: report.totals.costUsd,
    calls: report.totals.calls,
  };
}

/** The windows a card shows in the short text: those Settings picked, else all. */
function cardWindows(
  account: GatewayQuotaAccountWire,
  picked: string[] | undefined,
): { rows: GatewayQuotaWindowWire[]; lines: GatewayQuotaWindowWire[] } {
  const counted = account.windows.filter((window) => window.usedPercent !== null);
  if (picked === undefined || picked.length === 0) {
    return { rows: counted, lines: counted };
  }
  const chosen = counted.filter((window) => picked.includes(window.id));
  return chosen.length === 0 ? { rows: counted, lines: counted } : { rows: chosen, lines: counted };
}

/** The cards the menu bar shows, in the order Settings names them. */
export function trayUsageData(
  settings: TrayUsageSettings,
  accounts: readonly GatewayQuotaAccountWire[],
  reports: TrayUsageReports,
): TrayUsageData {
  const cards: TrayUsageCard[] = [];
  const totals: TrayUsageTotal[] = [];
  for (const id of settings.trayUsages) {
    if (isTotalId(id)) {
      const total = totalFor(id, reports);
      if (total !== null) {
        totals.push(total);
      }
      continue;
    }
    const account = accounts.find((candidate) => candidate.id === id);
    if (account === undefined) {
      continue;
    }
    const windows = cardWindows(account, settings.trayWindows[account.id]);
    if (windows.lines.length === 0) {
      continue;
    }
    const row = (window: GatewayQuotaWindowWire): TrayUsageRow => ({
      id: window.id,
      name: readableWindowName(window),
      usedPercent: window.usedPercent ?? 0,
      pacePct: window.pacePct,
      resetsAt: window.resetsAt,
    });
    cards.push({
      id: account.id,
      name: readableCardName(account),
      provider: account.provider,
      providerLabel: account.providerLabel,
      rows: windows.rows.map(row),
      lines: windows.lines.map(row),
    });
  }
  return { cards, totals };
}

/** "+12%", "−8%" with myna's true minus, "±0%"; the sign turns when showing what is left. */
export function formatTrayPace(pacePct: number, displayAs: "used" | "remaining"): string {
  const value = Math.round(displayAs === "remaining" ? -pacePct : pacePct);
  if (value > 0) {
    return `+${value}%`;
  }
  if (value < 0) {
    return `−${Math.abs(value)}%`;
  }
  return "±0%";
}

/** The figure beside each window, as the display setting has it. */
export function trayPercent(usedPercent: number, displayAs: "used" | "remaining"): number {
  return displayAs === "remaining" ? 100 - usedPercent : usedPercent;
}

/** Windows' tray icon draws the first figure, its digits alone (traynumber.go). */
export function trayFigure(label: string): string | null {
  // The first card's segment, whose first percentage is the figure; the
  // provider's name may stand before it ("Claude 62% +3%").
  const segment = label.split(" · ")[0]?.trim() ?? "";
  for (const token of segment.split(/\s+/)) {
    const digits = token.endsWith("%") ? token.slice(0, -1) : "";
    if (digits.length > 0 && digits.length <= 3 && /^[0-9]+$/.test(digits)) {
      return digits;
    }
  }
  return null;
}

/** What the menu bar shows: the Settings rows, and how the reader reads figures. */
export interface TrayUsagePresentationSettings {
  trayUsages: string[];
  trayNoLogos: boolean;
  trayPace: boolean;
  trayNoCost: boolean;
}

export interface TrayUsageFormat {
  locale?: string;
  displayAs: "used" | "remaining";
  currency: "usd" | "cny";
  numberUnits: "compact" | "wan";
  cnyPerUsd: number;
  /**
   * Whether a card's provider name goes in the text. The Mac app draws a
   * provider's mark in the menu bar instead, when it has the image.
   */
  showProviderName?: (card: TrayUsageCard) => boolean;
}

export interface TrayUsageWords {
  todayIn: string;
  last7DaysIn: string;
  tokens: (value: string) => string;
  requests: (value: number) => string;
  used: string;
  left: string;
  resetsIn: (when: string) => string;
}

/** A large count as K/M/B, or as 万/亿 when the reader prefers Chinese units. */
export function formatTrayCount(value: number, format: TrayUsageFormat): string {
  if (format.numberUnits === "wan") {
    const magnitude = Math.abs(value);
    if (magnitude >= 100_000_000) {
      return `${Number((value / 100_000_000).toFixed(1))}亿`;
    }
    if (magnitude >= 10_000) {
      return `${Number((value / 10_000).toFixed(1))}万`;
    }
    return new Intl.NumberFormat(format.locale).format(value);
  }
  return new Intl.NumberFormat(format.locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/** A cost in the display currency, with more digits for the tiny ones. */
export function formatTrayCost(valueUsd: number, format: TrayUsageFormat): string {
  const currency = format.currency === "cny" ? "CNY" : "USD";
  const shown = format.currency === "cny" ? valueUsd * format.cnyPerUsd : valueUsd;
  if (valueUsd === 0) {
    return new Intl.NumberFormat(format.locale, { style: "currency", currency }).format(0);
  }
  let digits = 2;
  if (shown < 0.01) {
    digits = 4;
  } else if (shown < 1) {
    digits = 3;
  }
  return new Intl.NumberFormat(format.locale, {
    style: "currency",
    currency,
    minimumFractionDigits: shown < 0.01 ? 2 : digits,
    maximumFractionDigits: digits,
  }).format(shown);
}

function formatTrayPercent(value: number, locale: string | undefined): string {
  const rounded = Math.round(value * 10) / 10;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(rounded)}%`;
}

function untilText(remainingMs: number): string {
  const minutes = Math.max(1, Math.round(remainingMs / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) {
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  return `${minutes}m`;
}

/** The Mac menu bar's text: up to two figures, in the order Settings names. */
export function trayUsageLabel(
  data: TrayUsageData,
  settings: TrayUsagePresentationSettings,
  format: TrayUsageFormat,
): string {
  const cards = new Map(data.cards.map((card) => [card.id, card]));
  const rows: string[] = [];
  for (const id of settings.trayUsages) {
    if (rows.length >= 2) {
      break;
    }
    const total = data.totals.find((candidate) => candidate.id === id);
    if (total !== undefined) {
      const tokens = `Σ${formatTrayCount(total.tokens, format)}`;
      rows.push(
        settings.trayNoCost ? tokens : `${tokens} · ${formatTrayCost(total.costUsd, format)}`,
      );
      continue;
    }
    const card = cards.get(id);
    if (card === undefined) {
      continue;
    }
    for (const [index, row] of card.rows.entries()) {
      if (rows.length >= 2) {
        break;
      }
      const pct = `${Math.round(trayPercent(row.usedPercent, format.displayAs))}%`;
      const pace =
        settings.trayPace && row.pacePct !== null
          ? ` ${formatTrayPace(row.pacePct, format.displayAs)}`
          : "";
      const named = format.showProviderName?.(card) ?? true;
      const logo = index === 0 && !settings.trayNoLogos && named ? `${card.providerLabel} ` : "";
      rows.push(`${logo}${pct}${pace}`);
    }
  }
  return rows.join(" · ");
}

/** The tooltip, spelling out every window and the totals Settings names. */
export function trayUsageTooltip(
  data: TrayUsageData,
  settings: TrayUsagePresentationSettings,
  format: TrayUsageFormat,
  words: TrayUsageWords,
  now = Date.now(),
): string {
  const cards = new Map(data.cards.map((card) => [card.id, card]));
  const lines: string[] = [];
  for (const id of settings.trayUsages) {
    const total = data.totals.find((candidate) => candidate.id === id);
    if (total !== undefined) {
      lines.push(id === "usage:today" ? words.todayIn : words.last7DaysIn);
      const cost = settings.trayNoCost ? "" : ` · ${formatTrayCost(total.costUsd, format)}`;
      lines.push(
        `${words.tokens(formatTrayCount(total.tokens, format))}${cost} · ${words.requests(
          total.calls,
        )}`,
      );
      continue;
    }
    const card = cards.get(id);
    if (card === undefined) {
      continue;
    }
    lines.push(card.name);
    for (const row of card.lines) {
      const pct = formatTrayPercent(trayPercent(row.usedPercent, format.displayAs), format.locale);
      const word = format.displayAs === "remaining" ? words.left : words.used;
      let line = `${row.name}: ${pct} ${word}`;
      if (settings.trayPace && row.pacePct !== null) {
        line += ` · ${formatTrayPace(row.pacePct, format.displayAs)}`;
      }
      if (row.resetsAt !== null && row.resetsAt > now) {
        line += ` · ${words.resetsIn(untilText(row.resetsAt - now))}`;
      }
      lines.push(line);
    }
  }
  return lines.length === 0 ? "Neolix" : lines.join("\n");
}
