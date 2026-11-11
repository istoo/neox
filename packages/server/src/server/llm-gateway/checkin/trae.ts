import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { authNumber, authString, providerOfKey, readPluginAuth } from "./store.js";
import { renewOnce, tokenStale, writeAuthFields } from "./oauth.js";
import { failedResult, type CheckinResult } from "./state.js";

/**
 * Trae CN's daily check-in (每日签到), ported from the plugin
 * @magpie-community/opencode-trae-auth 0.2.31 (`ugDevice`, `ugHeaders`,
 * `checkin`) and myna's `internal/provider/trae_checkin.go`.
 *
 * The IDE's growth page is asked for its status first, claimed only while
 * it is on and today's isn't in, and the status read again after the claim:
 * a claim's code 0 is not proof the day is in. 9095 means this device is
 * in for today, and 9074 means Trae refused the claim for this account's
 * device; neither is tried again that day.
 *
 * The JWT is renewed through the account's refresh token before it ends:
 * the clients' own device-bound ExchangeToken first, then the plain page as
 * earlier clients used. Trae CN takes a claim only for a JWT bound to the
 * account's device, so the plain one is a fallback, not the rule. The
 * rotated pair is written back where myna's file still holds the token it
 * spent.
 */

export const TRAE_VENDOR = "trae";
export const TRAE_CN_ID = "trae-cn";
export const TRAE_CHECKIN_URL = "https://api.trae.cn/trae/api/v2/ug/checkin_credits";
export const TRAE_AUTH_HOST = "https://api.trae.cn";
export const TRAE_CN_CLIENT_ID = "ono9krqynydwx5";

const TRAE_DEVICE_EXCHANGE_PATH = "/trae/api/v3/oauth/ExchangeToken";
const TRAE_EXCHANGE_PATH = "/cloudide/api/v3/trae/oauth/ExchangeToken";

/** The clients a device-bound renewal is tried as, in the plugin's order. */
const TRAE_EXCHANGE_CLIENTS = [
  { clientId: "en1oxy7wnw8j9n", platform: "SOLO_PC", version: "0.1.64" },
  { clientId: TRAE_CN_CLIENT_ID, platform: "IDE_PC", version: "3.3.99" },
];

const TRAE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TRAE-SOLO-CN/0.1.69 Chrome/120.0.6099.291 Electron/28.2.10 Safari/537.36";

const TRAE_BRAND = "ASUS TUF Gaming A15 FA507RM_FA507RM";

export interface TraeAccount {
  /** Its entry in the check-in file: `trae-cn|<uid>`. */
  key: string;
  user: string;
  uid: string;
  access: string;
  deviceId: string;
  /** Its key in myna's plugin-auth.json, for writing a renewal back. */
  authKey: string;
  refresh?: string;
  expires?: number;
  clientId?: string;
  machineId?: string;
  devicePublicKey?: string;
  devicePrivateKey?: string;
  /** The token host its sign-in named; `https://api.trae.cn` otherwise. */
  authHost?: string;
}

export interface TraeRequestOptions {
  account: TraeAccount;
  /** myna's plugin-auth.json, where a renewal is written back. */
  authPath?: string;
  /** The check-in root, for tests; `https://api.trae.cn/trae/api/v2/ug/checkin_credits` otherwise. */
  baseUrl?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Reads the Trae CN plugin's sign-ins from myna's plugin-auth.json. */
export async function loadTraeAccounts(input: { authPath: string }): Promise<TraeAccount[]> {
  const auths = await readPluginAuth(input.authPath);
  const out: TraeAccount[] = [];
  const seen = new Set<string>();
  for (const [authKey, auth] of Object.entries(auths)) {
    if (providerOfKey(authKey) !== TRAE_CN_ID) continue;
    const uid = authString(auth, "uid");
    if (uid === "") continue;
    const key = `${TRAE_CN_ID}|${uid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = authString(auth, "accountId");
    const refresh = authString(auth, "refresh");
    const expires = authNumber(auth, "expires");
    const clientId = authString(auth, "clientId");
    const machineId = authString(auth, "machineId");
    const devicePublicKey = authString(auth, "devicePublicKey");
    const devicePrivateKey = authString(auth, "devicePrivateKey");
    const authHost = authString(auth, "authHost");
    out.push({
      key,
      user: name !== "" ? name : uid,
      uid,
      access: authString(auth, "access"),
      deviceId: authString(auth, "deviceId"),
      authKey,
      ...(refresh === "" ? {} : { refresh }),
      ...(expires === undefined ? {} : { expires }),
      ...(clientId === "" ? {} : { clientId }),
      ...(machineId === "" ? {} : { machineId }),
      ...(devicePublicKey === "" ? {} : { devicePublicKey }),
      ...(devicePrivateKey === "" ? {} : { devicePrivateKey }),
      ...(authHost === "" ? {} : { authHost }),
    });
  }
  return out;
}

/**
 * The device id Trae CN's check-in takes: a 15-digit id as kept, else
 * sha256(`trae-cn-device\0<deviceId>\0<uid>`), its first 30 hex as a number
 * modulo 9e14 plus 1e14, so 15 digits and never a leading zero (the
 * plugin's `ugDevice`).
 */
export function ugDevice(account: Pick<TraeAccount, "deviceId" | "uid">): string {
  const id = account.deviceId;
  if (/^\d{15}$/.test(id)) return id;
  if (id === "" && account.uid === "") return id;
  const digest = createHash("sha256")
    .update(`trae-cn-device\0${id}\0${account.uid}`)
    .digest("hex")
    .slice(0, 30);
  const n = BigInt(`0x${digest}`);
  return String(100_000_000_000_000n + (n % 900_000_000_000_000n));
}

/** The headers Trae CN's IDE sends a growth page, as the plugin's `ugHeaders`. */
export function traeHeaders(account: TraeAccount): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Cloud-IDE-JWT ${account.access}`,
    "User-Agent": TRAE_UA,
    "x-device-id": ugDevice(account),
    "x-device-brand": TRAE_BRAND,
    "x-device-type": "Windows",
    "x-os-version": "10.0.22631",
    "x-app-version": "0.1.69",
  };
}

/**
 * The request Trae CN's client-less check-in tools send, which the plugin
 * falls back to once after a 9074 (`clientShapeHeaders`). Its device, market
 * user and session ids are made from the uid alone, as those tools make
 * them.
 */
export function clientShape(account: TraeAccount): {
  headers: Record<string, string>;
  device: string;
} {
  const uid = account.uid;
  const device = shapeDevice(uid);
  return {
    device,
    headers: {
      Authorization: `Cloud-IDE-JWT ${account.access}`,
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate",
      "Accept-Language": "zh-CN",
      "Content-Type": "application/json",
      "User-Agent": "VSCode 1.107.1 (TRAE SOLO CN)",
      "x-market-client-id": "VSCode 1.107.1",
      "x-market-user-id": shapeMarketUser(uid),
      "x-user-region": "CN",
      "x-device-id": device,
      "x-lgw-req-sdk-type": "3",
      "package-type": "stable_cn",
      "x-lscbd-aid": "787976",
      "x-lscbd-platform": "windows",
      "app-version": "0.1.45",
      "x-tt-trace-id": `00-${randomBytes(8).toString("hex")}-01`,
      "vscode-sessionid": seeded(uid, "sess", 32).toString("hex"),
      "x-request-id": randomUUID(),
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-site": "none",
    },
  };
}

/** The plugin's `seeded`: sha256 of a salt, the seed and a counter, n bytes. */
function seeded(seed: string, salt: string, n: number): Buffer {
  const blocks: Buffer[] = [];
  let length = 0;
  for (let i = 0; length < n; i++) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(i);
    const digest = createHash("sha256").update(`${salt}:${seed}`).update(counter).digest();
    blocks.push(digest);
    length += digest.length;
  }
  return Buffer.concat(blocks).subarray(0, n);
}

/** The client-less tools' device id: 15 digits from the uid. */
function shapeDevice(uid: string): string {
  return [...seeded(uid, "devid", 15)].map((byte) => byte % 10).join("");
}

/** The client-less tools' market user id, a UUID-shaped hex from the uid. */
function shapeMarketUser(uid: string): string {
  const bytes = Buffer.from(seeded(uid, "market", 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Trae CN's check-in answers, the codes it refuses with. */
const TRAE_SIGNED_OUT = 1001;
const TRAE_OWN_APP_ONLY = 9074;
const TRAE_DEVICE_CHECKED = 9095;

interface TraeStatus {
  code: number;
  message: string;
  enable: boolean;
  checkedIn: boolean;
  credits: number;
  extraCredits: number;
}

/**
 * Checks one account in for the day as Trae's IDE does: the status first, a
 * claim only while it is on and today's isn't in, and the status again
 * after the claim.
 */
export async function checkTrae(options: TraeRequestOptions): Promise<CheckinResult> {
  const account = await freshTrae(options);
  const context: TraeCallContext = {
    baseUrl: options.baseUrl ?? TRAE_CHECKIN_URL,
    headers: traeHeaders(account),
    fetch: options.fetch ?? globalThis.fetch,
    signal: options.signal,
  };

  const first = await status(context);
  if (first.failure !== undefined) return first.failure;
  const statusNow = first.status;
  if (statusNow.checkedIn) {
    return result("done", statusNow.credits);
  }
  if (!statusNow.enable) {
    return { outcome: "inactive" };
  }

  const claimed = await claim(context);
  if (claimed.failure !== undefined) return claimed.failure;
  let answer = claimed.status;

  // A 9074 on the first claim is tried once more at once, in the request
  // Trae CN's client-less check-in tools send (`clientShapeHeaders`): the
  // plugin does the same, once, never on another code and never twice. A
  // 9074 means nothing was taken, so a second claim can't take the day
  // twice.
  if (answer.code === TRAE_OWN_APP_ONLY) {
    const shape = clientShape(account);
    const again = await claim(context, shape.headers, "{}");
    if (again.failure !== undefined) return again.failure;
    if (again.status.code === TRAE_OWN_APP_ONLY) {
      return deviceRefused(again.status, shape.device);
    }
    answer = again.status;
  }

  // A claim's own code 0 is not proof: Trae answers it for a claim that
  // registered nothing. Success is what the status says after the claim.
  const back = await status(context);
  if (back.failure !== undefined) {
    return noMore(back.failure);
  }
  if (!back.status.checkedIn) {
    return {
      outcome: "ineligible",
      msg: "Trae CN: the claim answered success, but the day's check-in is not in — nothing is claimed again today",
    };
  }
  return result("claimed", answer.credits || answer.extraCredits || back.status.credits);
}

interface RenewedTrae {
  access: string;
  refresh?: string;
  expires?: number;
  devicePublicKey?: string;
  devicePrivateKey?: string;
  deviceId?: string;
  machineId?: string;
}

interface TraeRenewalDevice {
  deviceId: string;
  machineId: string;
  devicePublicKey: string;
  devicePrivateKey: string;
  refresh: string;
  access: string;
}

/**
 * The account with a JWT that isn't about to end, renewed as the plugin's
 * `auth.refresh` renews one. A renewal that fails leaves the token there is,
 * and Trae's own refusal is the answer.
 */
async function freshTrae(options: TraeRequestOptions): Promise<TraeAccount> {
  const account = options.account;
  if (!tokenStale(account.expires)) return account;
  if (account.refresh === undefined || account.refresh === "") return account;
  const renewed = await renewOnce(`trae:${account.authKey}`, () => renewTrae(options, account));
  if (renewed === null) return account;
  if (options.authPath !== undefined) {
    await writeAuthFields({
      authPath: options.authPath,
      authKey: account.authKey,
      field: "access",
      expected: account.access,
      values: {
        access: renewed.access,
        ...(renewed.refresh === undefined ? {} : { refresh: renewed.refresh }),
        ...(renewed.expires === undefined ? {} : { expires: renewed.expires }),
        ...(renewed.deviceId === undefined ? {} : { deviceId: renewed.deviceId }),
        ...(renewed.machineId === undefined ? {} : { machineId: renewed.machineId }),
        ...(renewed.devicePublicKey === undefined
          ? {}
          : { devicePublicKey: renewed.devicePublicKey }),
        ...(renewed.devicePrivateKey === undefined
          ? {}
          : { devicePrivateKey: renewed.devicePrivateKey }),
      },
    });
  }
  return {
    ...account,
    access: renewed.access,
    ...(renewed.refresh === undefined ? {} : { refresh: renewed.refresh }),
    ...(renewed.expires === undefined ? {} : { expires: renewed.expires }),
    ...(renewed.deviceId === undefined ? {} : { deviceId: renewed.deviceId }),
    ...(renewed.machineId === undefined ? {} : { machineId: renewed.machineId }),
    ...(renewed.devicePublicKey === undefined ? {} : { devicePublicKey: renewed.devicePublicKey }),
    ...(renewed.devicePrivateKey === undefined
      ? {}
      : { devicePrivateKey: renewed.devicePrivateKey }),
  };
}

/**
 * The plugin's `renewal`: the device-bound exchange first, then the plain
 * `/cloudide/` page. A device key and machine id made here go back with the
 * result, so the next renewal signs as the same device.
 */
async function renewTrae(
  options: TraeRequestOptions,
  account: TraeAccount,
): Promise<RenewedTrae | null> {
  const keys: { devicePublicKey?: string; devicePrivateKey?: string } =
    account.devicePublicKey === undefined || account.devicePrivateKey === undefined
      ? newDeviceKey()
      : {};
  const deviceId = account.deviceId !== "" ? account.deviceId : newDeviceId();
  const machineId = account.machineId ?? randomBytes(16).toString("hex");
  const device: TraeRenewalDevice = {
    deviceId,
    machineId,
    devicePublicKey: account.devicePublicKey ?? keys.devicePublicKey ?? "",
    devicePrivateKey: account.devicePrivateKey ?? keys.devicePrivateKey ?? "",
    refresh: account.refresh ?? "",
    access: account.access,
  };
  const host = (account.authHost ?? TRAE_AUTH_HOST).replace(/\/+$/, "");
  const renewed =
    (await boundExchange(host, device, options)) ?? (await plainExchange(host, account, options));
  if (renewed === null) return null;
  return {
    ...renewed,
    ...keys,
    ...(account.deviceId === "" ? { deviceId } : {}),
    ...(account.machineId === undefined ? { machineId } : {}),
  };
}

/** The clients' own ExchangeToken: the first token any client's shape gets. */
async function boundExchange(
  host: string,
  device: TraeRenewalDevice,
  options: TraeRequestOptions,
): Promise<RenewedTrae | null> {
  for (const client of TRAE_EXCHANGE_CLIENTS) {
    try {
      const response = await (options.fetch ?? globalThis.fetch)(
        `${host}${TRAE_DEVICE_EXCHANGE_PATH}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(device.access === "" ? {} : { Authorization: `Cloud-IDE-JWT ${device.access}` }),
          },
          body: JSON.stringify({
            ClientID: client.clientId,
            ClientSecret: "",
            RefreshToken: device.refresh,
            DeviceInfo: deviceInfoOf(device, client),
            DeviceProof: proofOf(
              TRAE_DEVICE_EXCHANGE_PATH,
              client.clientId,
              device.refresh,
              device.devicePrivateKey,
            ),
            IDEVersion: client.version,
          }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      if (!response.ok) continue;
      const parsed = parseObject(await response.text());
      const answer = asObject(parsed?.Result ?? parsed?.result ?? parsed);
      const renewed = tokensOf(answer, device.refresh);
      if (renewed !== null) return renewed;
    } catch {
      // Try the next client, as the plugin does.
    }
  }
  return null;
}

/** The earlier clients' plain renewal, which carries no device. */
async function plainExchange(
  host: string,
  account: TraeAccount,
  options: TraeRequestOptions,
): Promise<RenewedTrae | null> {
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`${host}${TRAE_EXCHANGE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ClientID: account.clientId ?? TRAE_CN_CLIENT_ID,
        RefreshToken: account.refresh ?? "",
        ClientSecret: "-",
        UserID: "",
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) return null;
    const parsed = parseObject(await response.text());
    const answer = asObject(parsed?.Result ?? parsed?.result ?? parsed);
    return tokensOf(answer, account.refresh ?? "");
  } catch {
    return null;
  }
}

/** A renewal's token pair, its end as Trae said it or the JWT's own exp. */
function tokensOf(answer: Record<string, unknown>, fallbackRefresh: string): RenewedTrae | null {
  const access = stringOf(answer.Token ?? answer.token);
  if (access === "") return null;
  const refresh = stringOf(answer.RefreshToken ?? answer.refreshToken) || fallbackRefresh;
  const expires = whenOf(answer.TokenExpireAt ?? answer.tokenExpireAt) || jwtExp(access);
  return {
    access,
    ...(refresh === "" ? {} : { refresh }),
    ...(expires > 0 ? { expires } : {}),
  };
}

/** The device a device-bound renewal names, its public key with it. */
function deviceInfoOf(
  device: TraeRenewalDevice,
  client: (typeof TRAE_EXCHANGE_CLIENTS)[number],
): Record<string, string> {
  return {
    DeviceID: device.deviceId,
    MachineID: device.machineId,
    PlatformCode: client.platform,
    DeviceType: "PC",
    DeviceName: "",
    DeviceModel: "",
    ClientVersion: client.version,
    DevicePublicKey: device.devicePublicKey,
    DeviceBrand: TRAE_BRAND,
    DeviceCPU: "AMD",
    OSInfo: "Windows",
    OSVersion: "10.0.22631",
  };
}

/**
 * A renewal's DeviceProof: the device key's ECDSA-SHA256 signature (DER,
 * base64) of the method, path, client, refresh token, time and nonce, one
 * to a line, as the clients sign it.
 */
function proofOf(
  path: string,
  clientId: string,
  refresh: string,
  privateKey: string,
  at = Math.floor(Date.now() / 1000),
  nonce = randomBytes(16).toString("hex"),
): { Signature: string; Timestamp: number; Nonce: string } {
  const text = ["POST", path, clientId, refresh, String(at), nonce].join("\n");
  return {
    Signature: sign("sha256", Buffer.from(text), privateKey).toString("base64"),
    Timestamp: at,
    Nonce: nonce,
  };
}

/** The device's key pair, an ECDSA P-256 one as the clients keep. */
function newDeviceKey(): { devicePublicKey: string; devicePrivateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    devicePublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    devicePrivateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** A device id in the shape Trae CN's clients make: 16 digits, no leading zero. */
function newDeviceId(): string {
  const bytes = randomBytes(16);
  let id = String(1 + (bytes[0]! % 9));
  for (let i = 1; i < 16; i++) id += String(bytes[i]! % 10);
  return id;
}

/** Trae's expiry: seconds, milliseconds or an ISO date. */
function whenOf(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
    const at = Date.parse(value);
    return Number.isNaN(at) ? 0 : at;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e11 ? n * 1000 : n;
}

/** A JWT's exp in milliseconds, 0 when it has none. */
function jwtExp(token: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
    ) as Record<string, unknown>;
    return whenOf(payload.exp);
  } catch {
    return 0;
  }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface TraeCallContext {
  baseUrl: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
  signal?: AbortSignal;
}

type TraeAnswer<T> = { status: T; failure?: never } | { failure: CheckinResult; status?: never };

async function status(context: TraeCallContext): Promise<TraeAnswer<TraeStatus>> {
  const answer = await call(context, "/status");
  if (answer.failure !== undefined) return { failure: answer.failure };
  return answerStatus(answer, "check-in status", refuseStatus);
}

async function claim(
  context: TraeCallContext,
  headers: Record<string, string> = context.headers,
  body: string = TRAE_UG_BODY,
): Promise<TraeAnswer<TraeStatus>> {
  const answer = await call(context, "/claim", headers, body);
  if (answer.failure !== undefined) return { failure: answer.failure };
  return answerStatus(answer, "check-in claim", refuseClaim);
}

function answerStatus(
  answer: RawCall,
  what: string,
  refuse: (status: TraeStatus, device: string) => CheckinResult | undefined,
): TraeAnswer<TraeStatus> {
  if (answer.body === null) {
    if (answer.httpStatus < 200 || answer.httpStatus >= 300) {
      return { failure: { outcome: "failed", msg: `HTTP ${answer.httpStatus}` } };
    }
    return { failure: unreadable(what, answer.text) };
  }
  const statusNow = asStatus(answer.body);
  const refused = refuse(statusNow, answer.device);
  if (refused !== undefined) return { failure: refused };
  if (answer.httpStatus < 200 || answer.httpStatus >= 300) {
    return {
      failure: {
        outcome: "failed",
        msg:
          statusNow.message !== ""
            ? `HTTP ${answer.httpStatus}: ${statusNow.message}`
            : `HTTP ${answer.httpStatus}`,
      },
    };
  }
  return { status: statusNow };
}

interface RawCall {
  httpStatus: number;
  body: Record<string, unknown> | null;
  text: string;
  device: string;
  failure?: CheckinResult;
}

/** What Trae CN's growth pages are sent for an empty body (the plugin's ownRequest). */
const TRAE_UG_BODY = JSON.stringify({ req_source: 1 });

/**
 * Posts the growth page's body to the check-in's path and reads its answer.
 * A 401, the sign-in header's `expired`, code 1001, or a request that got no
 * reply is a failure here; Trae's other codes are left to the caller.
 */
async function call(
  context: TraeCallContext,
  pathname: string,
  headers: Record<string, string> = context.headers,
  body: string = TRAE_UG_BODY,
): Promise<RawCall> {
  const device = headers["x-device-id"] ?? "";
  let response: Response;
  try {
    response = await context.fetch(`${context.baseUrl}${pathname}`, {
      method: "POST",
      headers,
      body,
      signal: context.signal,
    });
  } catch (error) {
    return { httpStatus: 0, body: null, text: "", device, failure: failedResult(error) };
  }
  const text = await response.text();
  const signInExpired = response.headers.get("x-magpie-sign-in")?.toLowerCase() === "expired";
  let parsedBody: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      parsedBody = parsed as Record<string, unknown>;
    }
  } catch {
    parsedBody = null;
  }

  if (
    response.status === 401 ||
    signInExpired ||
    (parsedBody !== null && numeric(parsedBody.code) === TRAE_SIGNED_OUT)
  ) {
    return {
      httpStatus: response.status,
      body: parsedBody,
      text,
      device,
      failure: signInFailure(),
    };
  }
  return { httpStatus: response.status, body: parsedBody, text, device };
}

function refuseStatus(statusNow: TraeStatus, device: string): CheckinResult | undefined {
  if (statusNow.code === TRAE_DEVICE_CHECKED) {
    return deviceChecked(statusNow, device);
  }
  if (statusNow.code === TRAE_OWN_APP_ONLY) {
    return deviceRefused(statusNow, device);
  }
  if (statusNow.code !== 0) {
    return {
      outcome: "failed",
      msg: `code ${statusNow.code}: ${statusNow.message}`,
    };
  }
  return undefined;
}

function refuseClaim(statusNow: TraeStatus, device: string): CheckinResult | undefined {
  if (statusNow.code === TRAE_DEVICE_CHECKED) {
    return deviceChecked(statusNow, device);
  }
  // 9074 is the caller's: it gets one more claim in the client-less shape.
  if (statusNow.code !== 0 && statusNow.code !== TRAE_OWN_APP_ONLY) {
    return {
      outcome: "failed",
      msg: `code ${statusNow.code}: ${statusNow.message}`,
    };
  }
  return undefined;
}

function deviceChecked(statusNow: TraeStatus, device: string): CheckinResult {
  const msg = statusNow.message !== "" ? statusNow.message : "this device has checked in today";
  return {
    outcome: "ineligible",
    msg: `${msg} (sent on this account's own device ${device})`,
  };
}

function deviceRefused(statusNow: TraeStatus, device: string): CheckinResult {
  const msg = statusNow.message !== "" ? statusNow.message : "asked too often";
  return {
    outcome: "ineligible",
    msg: `${msg} (9074) — Trae CN did not take this check-in for this account's device (device ${device})`,
  };
}

function signInFailure(): CheckinResult {
  return {
    outcome: "failed",
    msg: "Trae CN's sign-in has expired — sign in again",
  };
}

function unreadable(what: string, text: string): CheckinResult {
  const said = text.trim().slice(0, 120);
  return {
    outcome: "failed",
    msg: `${what}: unreadable reply ${said !== "" ? said : "(empty)"}`,
  };
}

/** After a claim, nothing is claimed again that day: a failure is an answer. */
function noMore(failure: CheckinResult): CheckinResult {
  return {
    outcome: "ineligible",
    msg: `${failure.msg ?? "Trae CN: the status could not be read"} — nothing is claimed again today`,
  };
}

function result(outcome: "done" | "claimed", credit: number): CheckinResult {
  return credit > 0 ? { outcome, credit } : { outcome };
}

function asStatus(body: Record<string, unknown>): TraeStatus {
  return {
    code: numeric(body.code),
    message: typeof body.message === "string" ? body.message : "",
    enable: body.enable === true,
    checkedIn: body.checked_in === true,
    credits: amount(body.credits),
    extraCredits: amount(body.extra_credits),
  };
}

function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function amount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
