import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { GatewayConfigStore } from "./config.js";
import { Masker, maskingWanted, masksRequests, StreamRestorer } from "./masking.js";
import { MaskingAlerts, type MaskingAlertNote } from "./masking-alert.js";
import { MaskingRecordStore } from "./masking-records.js";

const logger = pino({ level: "silent" });

describe("masksRequests", () => {
  it("masks a provider while masking is on", () => {
    expect(masksRequests({}, true)).toBe(true);
    expect(masksRequests({ unredacted: false }, true)).toBe(true);
  });

  it("sends a provider the user marked unredacted unmasked", () => {
    expect(masksRequests({ unredacted: true }, true)).toBe(false);
  });

  it("masks nothing while the gateway's masking is off", () => {
    expect(masksRequests({}, false)).toBe(false);
  });
});
describe("maskingWanted", () => {
  it("asks for masking when either switch or a word is set", () => {
    expect(maskingWanted(undefined)).toBe(false);
    expect(maskingWanted({})).toBe(false);
    expect(maskingWanted({ enabled: false, personal: false })).toBe(false);
    expect(maskingWanted({ enabled: true })).toBe(true);
    expect(maskingWanted({ personal: true })).toBe(true);
    expect(maskingWanted({ words: ["Nightjar"] })).toBe(true);
    expect(maskingWanted({ words: [] })).toBe(false);
  });
});
const SECRET = "sk-live-abcdEFGH12345678ijklMNOP";

function createMasker(
  allow: string[] = [],
  categorySwitches: Record<string, boolean> = {},
): Masker {
  return new Masker({
    neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-")),
    logger,
    allow: () => allow,
    categorySwitches: () => categorySwitches,
  });
}

describe("Masker", () => {
  it("replaces an API key with a stable placeholder and restores it", async () => {
    const masker = createMasker();
    await masker.ensureKey();

    const masked = masker.maskText(`key=${SECRET}`);
    expect(masked).not.toContain(SECRET);
    expect(masked).toMatch(/^key=\{\{API_KEY_[0-9a-f]{8}\}\}$/);

    const again = masker.maskText(SECRET);
    expect(again).toBe(masked.replace("key=", ""));
    expect(masker.restoreText(`reply ${again}`)).toBe(`reply ${SECRET}`);
  });

  it("uses the same placeholder across maskers that share a home", async () => {
    const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-mask-shared-"));
    const first = new Masker({ neolixHome, logger, allow: () => [] });
    const second = new Masker({ neolixHome, logger, allow: () => [] });
    await first.ensureKey();
    await second.ensureKey();

    expect(first.maskText(SECRET)).toBe(second.maskText(SECRET));
  });

  it("leaves allow-listed values alone", async () => {
    const masker = createMasker([SECRET]);
    await masker.ensureKey();
    expect(masker.maskText(SECRET)).toBe(SECRET);
  });

  it("masks secrets nested in JSON", async () => {
    const masker = createMasker();
    await masker.ensureKey();

    const masked = masker.maskValue({
      messages: [{ role: "user", content: `token ${SECRET}` }],
      count: 2,
    });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect(JSON.stringify(masked)).toContain("{{API_KEY_");
  });

  it("masks private key blocks as one placeholder", async () => {
    const masker = createMasker();
    await masker.ensureKey();
    const block = [
      "-----BEGIN",
      "PRIVATE KEY-----",
      "MIIEabcdef",
      "-----END",
      "PRIVATE KEY-----",
    ].join(" ");

    const masked = masker.maskText(block);
    expect(masked).toMatch(/^\{\{PRIVATE_KEY_[0-9a-f]{8}\}\}$/);
    expect(masker.restoreText(masked)).toBe(block);
  });
});

describe("Masker stand-ins", () => {
  const SHAPE_KEY = "sk-proj-Xy12_ab-CD34ef56GH78ij90KL12mn34";

  function shapedMasker(rules: { kind: string; pattern: string }[] = []): Masker {
    return new Masker({
      neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-shape-")),
      logger,
      allow: () => [],
      shape: () => true,
      ...(rules.length === 0 ? {} : { rules: () => rules }),
    });
  }

  function sameForm(made: string, value: string): boolean {
    if (made.length !== value.length) {
      return false;
    }
    const head = /^[A-Za-z]+[-_]/.exec(value)?.[0] ?? value.slice(0, 3);
    if (!made.startsWith(head)) {
      return false;
    }
    const kindOf = (character: string) => {
      if (/[A-Z]/.test(character)) return "A";
      if (/[a-z]/.test(character)) return "a";
      if (/[0-9]/.test(character)) return "0";
      return character;
    };
    for (let index = head.length; index < value.length; index += 1) {
      if (kindOf(made[index] ?? "") !== kindOf(value[index] ?? "")) {
        return false;
      }
    }
    return true;
  }

  it("sends a key as a made-up key of its form and puts it back", async () => {
    const masker = shapedMasker();
    await masker.ensureKey();
    const masked = masker.maskText(`OPENAI_API_KEY=${SHAPE_KEY}`);
    const made = masked.replace("OPENAI_API_KEY=", "");
    expect(masked).not.toContain("{{");
    expect(made).not.toBe(SHAPE_KEY);
    expect(sameForm(made, SHAPE_KEY)).toBe(true);
    expect(masker.maskText(`key: ${SHAPE_KEY}`)).toBe(`key: ${made}`);
    expect(masker.restoreText(`use ${made} here`)).toBe(`use ${SHAPE_KEY} here`);
  });

  it("keeps a made-up key's case when putting it back", async () => {
    const masker = shapedMasker();
    await masker.ensureKey();
    const made = masker.maskText(SHAPE_KEY);
    expect(masker.restoreText(made.toUpperCase())).toBe(made.toUpperCase());
  });

  it("keeps the placeholder when shaping is off", async () => {
    const masker = createMasker();
    await masker.ensureKey();
    expect(masker.maskText(SHAPE_KEY)).toContain("{{API_KEY_");
  });

  it("sends a user name as eight letters and puts it back in any case", async () => {
    const masker = shapedMasker([{ kind: "USERNAME", pattern: "yaobin" }]);
    await masker.ensureKey();
    const masked = masker.maskText("user yaobin logged in");
    const made = /user ([a-z]{8}) logged/.exec(masked)?.[1] ?? "";
    expect(made).toMatch(/^[a-z]{8}$/);
    expect(made).not.toBe("yaobin");
    const title = made[0]?.toUpperCase() + made.slice(1);
    expect(masker.restoreText(`Hi ${title}, done`)).toBe("Hi yaobin, done");
    expect(masker.restoreText(`OWNER=${made.toUpperCase()}`)).toBe("OWNER=yaobin");
  });

  it("sends an address as public-ip- and puts it back whole", async () => {
    const masker = shapedMasker([{ kind: "IP", pattern: "203\\.0\\.113\\.7" }]);
    await masker.ensureKey();
    const masked = masker.maskText("server 203.0.113.7 is down");
    const made = /public-ip-[a-z]{8}/.exec(masked)?.[0] ?? "";
    expect(made).not.toBe("");
    expect(masker.restoreText(`ssh root@${made.toUpperCase()}`)).toBe("ssh root@203.0.113.7");
    expect(masker.restoreText(`my-${made.toUpperCase()}`)).toBe(`my-${made.toUpperCase()}`);
  });

  it("puts a stand-in back across every stream cut", async () => {
    const masker = shapedMasker();
    await masker.ensureKey();
    const made = masker.maskText(SHAPE_KEY);
    for (let cut = 0; cut <= made.length; cut += 1) {
      const restorer = masker.createRestorer();
      const got =
        restorer.push(`key ${made.slice(0, cut)}`) +
        restorer.push(made.slice(cut)) +
        restorer.flush();
      expect(got).toBe(`key ${SHAPE_KEY}`);
    }
  });

  it("puts a stand-in back inside a tool call's arguments", async () => {
    const masker = shapedMasker();
    await masker.ensureKey();
    const made = masker.maskText(SHAPE_KEY);
    const args = JSON.stringify({ cmd: `export KEY=${made}` });
    const restored = masker.restoreValue({ arguments: args });
    expect(restored).toEqual({ arguments: JSON.stringify({ cmd: `export KEY=${SHAPE_KEY}` }) });
  });

  it("gives the same value the same stand-in after a restart", async () => {
    const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-mask-shape-shared-"));
    const first = new Masker({ neolixHome, logger, allow: () => [], shape: () => true });
    const second = new Masker({ neolixHome, logger, allow: () => [], shape: () => true });
    await first.ensureKey();
    await second.ensureKey();
    expect(first.maskText(SHAPE_KEY)).toBe(second.maskText(SHAPE_KEY));
  });
});

describe("Masker detectors", () => {
  async function masker(): Promise<Masker> {
    const created = createMasker();
    await created.ensureKey();
    return created;
  }

  it("masks an address and leaves an asset's name", async () => {
    const instance = await masker();
    const masked = instance.maskText(
      "mail user@example.com, logo@2x.png and 261020_14-16-11@2x.jpg",
    );
    expect(masked).toContain("{{EMAIL_");
    expect(masked).toContain("logo@2x.png");
    expect(masked).toContain("261020_14-16-11@2x.jpg");
    expect(instance.restoreText(masked)).toContain("user@example.com");
  });

  it("masks a mobile number but not an order id of the same form", async () => {
    const instance = await masker();
    const masked = instance.maskText("我的手机号是 13800138000，订单号 13912345679 已发货");
    expect(masked).not.toContain("13800138000");
    expect(masked).toContain("13912345679");
  });

  it("masks a public address but not a version", async () => {
    const instance = await masker();
    const masked = instance.maskText("server 203.0.113.7 runs v1.2.3.4");
    expect(masked).toContain("public-ip-");
    expect(masked).toContain("v1.2.3.4");
  });

  it("masks a home folder's user and keeps the path", async () => {
    const instance = await masker();
    const masked = instance.maskText("cd /Users/alice/project");
    expect(masked).toMatch(/^cd \/Users\/[a-z]{8}\/project$/);
    expect(instance.restoreText(masked)).toBe("cd /Users/alice/project");
  });

  it("masks a secret after its name, and keeps code, paths and versions", async () => {
    const instance = await masker();
    for (const secret of [
      ["password=hunter2pass9", "hunter2pass9"],
      ["API_KEY=AbC123dEf456GhI789", "AbC123dEf456GhI789"],
      ["token: t0k3nValue2", "t0k3nValue2"],
    ] as const) {
      const masked = instance.maskText(secret[0]);
      expect(masked).not.toContain(secret[1]);
      expect(instance.restoreText(masked)).toBe(secret[0]);
    }
    for (const kept of [
      "password = get_password_v2",
      "PRIVATE_KEY_PATH=~/.ssh/id_ed25519",
      "token.go:L643-669",
      'js-tokens = "^4.0.0-beta.1"',
    ]) {
      expect(instance.maskText(kept)).toBe(kept);
    }
  });

  it("masks a URL's password only", async () => {
    const instance = await masker();
    const masked = instance.maskText("redis://:hunter2secret@cache:6379/0");
    expect(masked).toContain("redis://:");
    expect(masked).not.toContain("hunter2secret");
    expect(masked).toContain("@cache:6379/0");
    expect(instance.restoreText(masked)).toBe("redis://:hunter2secret@cache:6379/0");
  });

  it("masks a JWT, an id card, a MAC and an SSN", async () => {
    const instance = await masker();
    const jwt = [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ].join(".");
    const masked = instance.maskText(
      `jwt ${jwt} id 11010519491231002X mac A4:83:E7:2B:11:C6 ssn 536-22-1847`,
    );
    expect(masked).toContain("{{TOKEN_");
    expect(masked).toContain("{{ID_CARD_");
    expect(masked).toContain("{{MAC_");
    expect(masked).toContain("{{SSN_");
    expect(instance.restoreText(masked)).toContain(jwt);
  });

  it("masks an SSN only in the ranges the SSA gives out", async () => {
    const instance = await masker();
    const masked = instance.maskText(
      "SSN 536-22-1847 on file; 123-45-6789, 000-12-3456 and 900-12-3456 are examples",
    );
    expect(masked).toContain("{{SSN_");
    expect(masked).not.toContain("536-22-1847");
    for (const kept of ["123-45-6789", "000-12-3456", "900-12-3456"]) {
      expect(masked).toContain(kept);
    }
    expect(instance.restoreText(masked)).toContain("536-22-1847");
  });

  it("masks a passport, a birthday and a serial number after their words", async () => {
    const instance = await masker();
    const text = [
      "Passport No.: E12345678",
      "护照号码：G28233515",
      "DOB: 03/15/1990",
      "I was born on March 5, 1988 in Ohio",
      "Serial Number (system): C02XG2JHJGH5",
      "S/N: 4CE0460D0G",
    ].join("; ");
    const masked = instance.maskText(text);
    for (const kind of ["PASSPORT", "BIRTHDAY", "SERIAL"]) {
      expect(masked).toContain(`{{${kind}_`);
    }
    expect(masked).not.toContain("E12345678");
    expect(masked).not.toContain("C02XG2JHJGH5");
    expect(masked).toContain(" in Ohio");
    expect(instance.restoreText(masked)).toBe(text);
  });

  it("keeps a birthday close to today and a date with no word before it", async () => {
    const instance = await masker();
    const kept = "DOB: 2099-01-01, released 03/15/1990";
    expect(instance.maskText(kept)).toBe(kept);
  });

  it("masks a MAC in either form and keeps the examples", async () => {
    const instance = await masker();
    const masked = instance.maskText(
      "ether A4:83:E7:2B:11:C6; Physical Address. . : A4-83-E7-2B-11-C6; example AA:BB:CC:DD:EE:FF",
    );
    expect(masked.match(/\{\{MAC_/g)).toHaveLength(2);
    expect(masked).not.toContain("A4-83-E7-2B-11-C6");
    expect(masked).toContain("AA:BB:CC:DD:EE:FF");
    expect(instance.restoreText(masked)).toContain("A4:83:E7:2B:11:C6");
  });

  it("masks a value it masked before wherever it stands", async () => {
    const instance = await masker();
    const secret = "hunter2hunter2";
    const first = instance.maskText(`password=${secret}`);
    expect(first).toContain("{{SECRET_");
    const second = instance.maskText(`the password is ${secret}, remember`);
    expect(second).not.toContain(secret);
    expect(second).toContain("{{SECRET_");
    expect(instance.restoreText(second)).toBe(`the password is ${secret}, remember`);
    // A short value is no news: it would turn up in ordinary text.
    const short = "ab9";
    const maskedUrl = instance.maskText(`redis://:${short}@cache:6379/0`);
    expect(maskedUrl).not.toContain(`:${short}@`);
    expect(instance.maskText(`${short} is a short value`)).toBe(`${short} is a short value`);
  });

  it("keeps a git remote and masks an address beside it", async () => {
    const instance = await masker();
    for (const kept of [
      "git@github.com:istoo/myna.git",
      "git clone git@gitlab.com:group/sub/repo.git",
      "url = git@git.corp-internal.com:team/svc.git",
      "GIT@GitHub.com:o/r",
    ]) {
      expect(instance.maskText(kept)).toBe(kept);
    }
    const masked = instance.maskText("push to git@github.com:o/r.git and tell rina.k@fastmail.com");
    expect(masked).toContain("git@github.com:o/r.git");
    expect(masked).not.toContain("rina.k@fastmail.com");
    expect(instance.restoreText(masked)).toContain("rina.k@fastmail.com");
  });

  it("keeps a home folder that is no one's", async () => {
    const instance = await masker();
    for (const kept of ["/Users/shared/app", "/Users/Public/app", "/home/.cache"]) {
      expect(instance.maskText(kept)).toBe(kept);
    }
    const masked = instance.maskText("open /Users/alice.");
    expect(masked).toMatch(/^open \/Users\/[a-z]{8}\.$/);
  });
});

describe("Masker opt-in categories", () => {
  async function masker(switches: Record<string, boolean>): Promise<Masker> {
    const created = createMasker([], switches);
    await created.ensureKey();
    return created;
  }

  it("leaves user@host, host lines and buckets alone until turned on", async () => {
    const instance = await masker({});
    for (const text of [
      "Hostname: rina-mbp.local\n",
      "s3://acme-prod-logs/2024/01/a.gz",
      "https://acme-assets.s3.us-west-2.amazonaws.com/logo.png",
    ]) {
      expect(instance.maskText(text)).toBe(text);
    }
  });

  it("masks a prompt's user and host and puts them back", async () => {
    const instance = await masker({ userhost: true });
    const text = `${["alice"].join("")}@${["rina", "-mbp"].join("")}:~/src$ ls`;
    const masked = instance.maskText(text);
    expect(masked).toMatch(/^[a-z]{8}@\{\{HOSTNAME_[0-9a-f]{8}\}\}:~\/src\$ ls$/);
    expect(instance.restoreText(masked)).toBe(text);
  });

  it("masks an ssh command's user and host", async () => {
    const instance = await masker({ userhost: true });
    const text = `run ssh ${["alice"].join("")}@${["bastion", ".corp.acme.io"].join("")} -p 22`;
    const masked = instance.maskText(text);
    expect(masked).toMatch(/^run ssh [a-z]{8}@\{\{HOSTNAME_[0-9a-f]{8}\}\} -p 22$/);
    expect(instance.restoreText(masked)).toBe(text);
  });

  it("masks host and user lines, not names in code or chat", async () => {
    const instance = await masker({ userhost: true });
    const masked = instance.maskText(
      "Hostname: rina-mbp.local\nHost prod\n  HostName box17.acme.io\n  User alice\n",
    );
    expect(masked).toContain("{{HOSTNAME_");
    expect(masked).not.toContain("rina-mbp.local");
    expect(masked).not.toContain("box17.acme.io");
    expect(masked).not.toContain("alice");
    for (const kept of [
      "hostname = socket.gethostname()",
      "hostname: str",
      "user = request.user",
      "User: continue",
      "User: thanks",
      'hostname: "localhost",',
      "@types/node@20.1.0",
      "root@localhost:~#",
    ]) {
      expect(instance.maskText(kept)).toBe(kept);
    }
  });

  it("masks a bucket in every form and keeps the examples", async () => {
    const instance = await masker({ bucket: true });
    const masked = instance.maskText(
      [
        "aws s3 cp s3://acme-prod-logs/2024/01/a.gz .",
        "https://acme-assets.s3.us-west-2.amazonaws.com/logo.png",
        "https://storage.googleapis.com/rina-public/x.bin",
      ].join("\n"),
    );
    expect(masked.match(/\{\{BUCKET_[0-9a-f]{8}\}\}/g)).toHaveLength(3);
    expect(masked).toContain("/2024/01/a.gz");
    expect(instance.restoreText(masked)).toContain("acme-prod-logs");
    for (const kept of [
      "s3://my-bucket/key",
      "s3://amzn-s3-demo-bucket/x",
      "https://s3.us-east-1.amazonaws.com",
      "s3.amazonaws.com",
      "https://cos.ap-guangzhou.myqcloud.com",
    ]) {
      expect(instance.maskText(kept)).toBe(kept);
    }
  });
});

describe("Masker actions and preview", () => {
  function createActionMasker(actions: Record<string, "mask" | "warn" | "block">): Masker {
    return new Masker({
      neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-action-")),
      logger,
      allow: () => [],
      actions: () => actions,
    });
  }

  it("sends a warned value as written and records it", async () => {
    const masker = createActionMasker({ API_KEY: "warn" });
    await masker.ensureKey();

    const masked = masker.maskTextWithHits(`token ${SECRET} end`);
    expect(masked.text).toBe(`token ${SECRET} end`);
    expect(masked.blocked).toBe(false);
    expect(masked.hits).toHaveLength(1);
    expect(masked.hits[0]).toMatchObject({
      kind: "API_KEY",
      action: "warn",
      length: SECRET.length,
    });
    expect(masked.hits[0]?.head).toBe("sk-");
  });

  it("holds a blocked value back instead of masking it", async () => {
    const masker = createActionMasker({ API_KEY: "block" });
    await masker.ensureKey();

    const masked = masker.maskValueWithHits({ prompt: `token ${SECRET}` });
    expect(masked.blocked).toBe(true);
    expect(JSON.stringify(masked.value)).toContain(SECRET);
    expect(masked.hits[0]).toMatchObject({ kind: "API_KEY", action: "block" });
  });

  it("records a custom rule as the user's own", async () => {
    const masker = new Masker({
      neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-yours-")),
      logger,
      allow: () => [],
      rules: () => [{ kind: "TICKET", pattern: "TICKET-[0-9]{6}", flags: "g" }],
    });
    await masker.ensureKey();

    const masked = masker.maskTextWithHits("see TICKET-123456");
    expect(masked.hits[0]?.by).toBe("yours");
    expect(masked.text).toMatch(/\{\{TICKET_[0-9a-f]{8}\}\}/);
  });

  it("previews without remembering the value", async () => {
    const masker = createMasker();
    await masker.ensureKey();

    const preview = masker.preview(SECRET);
    expect(preview.text).toMatch(/^\{\{API_KEY_[0-9a-f]{8}\}\}$/);
    expect(masker.restoreText(preview.text)).toBe(preview.text);
  });

  it("leaves an allow-listed value out of the hits", async () => {
    const masker = createMasker([SECRET]);
    await masker.ensureKey();

    const masked = masker.maskTextWithHits(SECRET);
    expect(masked.text).toBe(SECRET);
    expect(masked.hits).toHaveLength(0);
  });
});

describe("MaskingRecordStore", () => {
  it("summarises and lists what was masked without storing values", async () => {
    const store = new MaskingRecordStore({
      neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-rec-")),
      logger,
    });
    await store.start();
    const at = Date.now();
    store.add({
      agent: "Claude Code",
      provider: "ghcp",
      model: "claude-sonnet-5-5",
      blocked: false,
      hits: [
        {
          kind: "API_KEY",
          by: "rule",
          placeholder: "{{API_KEY_1234abcd}}",
          head: "sk-m",
          length: 24,
        },
        {
          kind: "API_KEY",
          by: "rule",
          placeholder: "{{API_KEY_1234abcd}}",
          head: "sk-m",
          length: 24,
        },
      ],
      at,
    });
    store.add({
      agent: "Codex",
      provider: "dashscope",
      model: "deepseek-v4.1-flash-1017",
      blocked: true,
      hits: [
        {
          kind: "EMAIL",
          by: "rule",
          placeholder: "{{EMAIL_5678abcd}}",
          head: "r",
          length: 16,
          action: "block",
        },
      ],
      at: at + 1,
    });

    const summary = store.summary(7, at + 2);
    expect(summary.requests).toBe(2);
    expect(summary.n).toBe(3);
    expect(summary.distinct).toBe(2);
    expect(summary.blocked).toBe(1);
    expect(summary.agents.map((entry) => entry.name)).toEqual(["Claude Code", "Codex"]);
    expect(summary.values.map((entry) => entry.p)).toEqual([
      "{{API_KEY_1234abcd}}",
      "{{EMAIL_5678abcd}}",
    ]);
    expect(JSON.stringify(store.list({ limit: 10 }))).not.toContain("sk-mvld");

    const blocked = store.list({ blocked: true, limit: 10 });
    expect(blocked.records).toHaveLength(1);
    expect(blocked.records[0]?.provider).toBe("dashscope");
  });

  it("says a value masked for the first time once, a minute apart", async () => {
    vi.useFakeTimers();
    try {
      const store = new MaskingRecordStore({
        neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-alert-")),
        logger,
      });
      await store.start();
      const notes: MaskingAlertNote[] = [];
      let now = 1_700_000_000_000;
      const alerts = new MaskingAlerts(
        store,
        () => true,
        (note) => notes.push(note),
        () => now,
      );
      const unsubscribe = store.subscribe((record) => alerts.add(record));
      const email = {
        kind: "EMAIL",
        by: "rule" as const,
        placeholder: "{{EMAIL_5678abcd}}",
        head: "r",
        length: 16,
      };
      store.add({ agent: "Claude Code", blocked: false, hits: [email], at: now });
      vi.advanceTimersByTime(3_000);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toEqual({
        total: 1,
        kinds: [{ name: "EMAIL", n: 1 }],
        agents: ["Claude Code"],
        key: expect.any(String) as unknown as string,
      });

      // The same value again is no news.
      store.add({ agent: "Claude Code", blocked: false, hits: [email], at: now + 1 });
      vi.advanceTimersByTime(70_000);
      expect(notes).toHaveLength(1);

      // A new value is said at once, the minute since the last note having passed.
      now += 70_000;
      store.add({
        agent: "Codex",
        blocked: false,
        hits: [{ ...email, placeholder: "{{PHONE_9999abcd}}", kind: "PHONE" }],
        at: now,
      });
      vi.advanceTimersByTime(3_000);
      expect(notes).toHaveLength(2);
      expect(notes[1]?.kinds).toEqual([{ name: "PHONE", n: 1 }]);

      unsubscribe();
      alerts.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says nothing while the alert is off", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const store = new MaskingRecordStore({
        neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-alert-off-")),
        logger,
      });
      await store.start();
      const notes: MaskingAlertNote[] = [];
      const alerts = new MaskingAlerts(
        store,
        () => false,
        (note) => notes.push(note),
      );
      const unsubscribe = store.subscribe((record) => alerts.add(record));
      store.add({
        blocked: false,
        hits: [
          {
            kind: "EMAIL",
            by: "rule",
            placeholder: "{{EMAIL_off00001}}",
            head: "r",
            length: 16,
          },
        ],
        at: Date.now(),
      });
      vi.advanceTimersByTime(70_000);
      expect(notes).toEqual([]);

      unsubscribe();
      alerts.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a burst waiting when the alert is turned off before it is said", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const store = new MaskingRecordStore({
        neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-alert-toggle-")),
        logger,
      });
      await store.start();
      const notes: MaskingAlertNote[] = [];
      let on = true;
      const alerts = new MaskingAlerts(
        store,
        () => on,
        (note) => notes.push(note),
      );
      const unsubscribe = store.subscribe((record) => alerts.add(record));
      store.add({
        blocked: false,
        hits: [
          {
            kind: "EMAIL",
            by: "rule",
            placeholder: "{{EMAIL_tg000001}}",
            head: "r",
            length: 16,
          },
        ],
        at: Date.now(),
      });
      on = false;
      vi.advanceTimersByTime(3_000);
      expect(notes).toEqual([]);

      // Back on, a value never masked before is news; the dropped email is not.
      on = true;
      store.add({
        blocked: false,
        hits: [
          {
            kind: "PHONE",
            by: "rule",
            placeholder: "{{PHONE_tg000001}}",
            head: "1",
            length: 11,
          },
        ],
        at: Date.now(),
      });
      vi.advanceTimersByTime(3_000);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatchObject({ total: 1, kinds: [{ name: "PHONE", n: 1 }] });

      unsubscribe();
      alerts.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gathers a burst into one note, first values only, warn values left out", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const store = new MaskingRecordStore({
        neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-alert-burst-")),
        logger,
      });
      await store.start();
      const notes: MaskingAlertNote[] = [];
      const alerts = new MaskingAlerts(
        store,
        () => true,
        (note) => notes.push(note),
      );
      const unsubscribe = store.subscribe((record) => alerts.add(record));
      const email = {
        kind: "EMAIL",
        by: "rule" as const,
        placeholder: "{{EMAIL_burst001}}",
        head: "r",
        length: 16,
      };
      const phone = {
        kind: "PHONE",
        by: "rule" as const,
        placeholder: "{{PHONE_burst01}}",
        head: "1",
        length: 11,
      };
      const at = Date.now();
      store.add({ agent: "Claude Code", blocked: false, hits: [email, phone], at });
      store.add({
        agent: "Codex",
        blocked: false,
        hits: [
          { ...phone, placeholder: "{{PHONE_burst02}}" },
          {
            kind: "SSN",
            by: "rule",
            placeholder: "{{SSN_burst0001}}",
            head: "1",
            length: 11,
          },
          {
            kind: "BUCKET",
            by: "rule",
            placeholder: "{{BUCKET_warn001}}",
            head: "b",
            length: 9,
            action: "warn",
          },
        ],
        at: at + 1,
      });
      store.add({ agent: "Claude Code", blocked: false, hits: [email], at: at + 2 });
      expect(notes).toEqual([]);

      vi.advanceTimersByTime(3_000);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toEqual({
        total: 4,
        kinds: [
          { name: "PHONE", n: 2 },
          { name: "EMAIL", n: 1 },
          { name: "SSN", n: 1 },
        ],
        agents: ["Claude Code", "Codex"],
        // The third record only repeats an email, so the second is the latest news.
        key: String(at + 1),
      });

      unsubscribe();
      alerts.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits out the minute from the last note, gathering what came in between", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const store = new MaskingRecordStore({
        neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-alert-gap-")),
        logger,
      });
      await store.start();
      const notes: MaskingAlertNote[] = [];
      const alerts = new MaskingAlerts(
        store,
        () => true,
        (note) => notes.push(note),
      );
      const unsubscribe = store.subscribe((record) => alerts.add(record));
      const email = {
        kind: "EMAIL",
        by: "rule" as const,
        placeholder: "{{EMAIL_gap00001}}",
        head: "r",
        length: 16,
      };
      store.add({ blocked: false, hits: [email], at: Date.now() });
      vi.advanceTimersByTime(3_000);
      expect(notes).toHaveLength(1);

      // 5s after the note: not 3s from now, but a minute after the note.
      vi.advanceTimersByTime(2_000);
      store.add({
        blocked: false,
        hits: [
          {
            kind: "PHONE",
            by: "rule",
            placeholder: "{{PHONE_gap0001}}",
            head: "1",
            length: 11,
          },
        ],
        at: Date.now(),
      });
      vi.advanceTimersByTime(500);
      store.add({
        blocked: false,
        hits: [
          {
            kind: "SSN",
            by: "rule",
            placeholder: "{{SSN_gap000001}}",
            head: "1",
            length: 11,
          },
        ],
        at: Date.now(),
      });
      vi.advanceTimersByTime(57_499);
      expect(notes).toHaveLength(1);

      vi.advanceTimersByTime(1);
      expect(notes).toHaveLength(2);
      expect(notes[1]).toMatchObject({
        total: 2,
        kinds: [
          { name: "PHONE", n: 1 },
          { name: "SSN", n: 1 },
        ],
      });

      unsubscribe();
      alerts.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("StreamRestorer", () => {
  it("does not leak a placeholder split across chunks", () => {
    const restorer = new StreamRestorer((text) => text.replace("{{API_KEY_1234abcd}}", SECRET));

    const first = restorer.push("before {{API_KEY_12");
    const second = restorer.push("34abcd}} after");
    const tail = restorer.flush();

    expect(first).toBe("before ");
    expect(second).toBe(`${SECRET} after`);
    expect(tail).toBe("");
  });

  it("holds a trailing brace until the next chunk", () => {
    const restorer = new StreamRestorer((text) => text.replace("{{API_KEY_1234abcd}}", SECRET));
    expect(restorer.push("text {")).toBe("text ");
    expect(restorer.push("{API_KEY_1234abcd}}")).toBe(SECRET);
  });

  it("flushes a never-completed placeholder unchanged", () => {
    const restorer = new StreamRestorer((text) => text);
    expect(restorer.push("a {{API_KEY")).toBe("a ");
    expect(restorer.flush()).toBe("{{API_KEY");
  });
});

describe("Masker categories and custom rules", () => {
  it("masks only the enabled categories", async () => {
    const masker = new Masker({
      neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-cat-")),
      logger,
      allow: () => [],
      categories: () => ["GITHUB_TOKEN"],
    });
    await masker.ensureKey();

    expect(masker.maskText(SECRET)).toBe(SECRET);
    const masked = masker.maskText("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(masked).toContain("{{GITHUB_TOKEN_");
  });

  it("masks a card number only when the Luhn digit agrees", async () => {
    const masker = createMasker();
    await masker.ensureKey();

    expect(masker.maskText("4111 1111 1111 1111")).toContain("{{CARD_");
    expect(masker.maskText("4111 1111 1111 1112")).toBe("4111 1111 1111 1112");
  });

  it("masks an IBAN only when mod-97 agrees", async () => {
    const masker = createMasker();
    await masker.ensureKey();

    expect(masker.maskText("GB82WEST12345698765432")).toContain("{{IBAN_");
    expect(masker.maskText("GB82WEST12345698765433")).toBe("GB82WEST12345698765433");
  });

  it("runs a configured pattern with its kind", async () => {
    const masker = new Masker({
      neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-rule-")),
      logger,
      allow: () => [],
      rules: () => [{ kind: "TICKET", pattern: "TICKET-[0-9]{6}", flags: "g" }],
    });
    await masker.ensureKey();

    const masked = masker.maskText("see TICKET-123456");
    expect(masked).toMatch(/^see \{\{TICKET_[0-9a-f]{8}\}\}$/);
    expect(masker.restoreText(masked)).toBe("see TICKET-123456");
  });

  it("ignores an invalid configured pattern instead of failing the request", async () => {
    const masker = new Masker({
      neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-bad-")),
      logger,
      allow: () => [],
      rules: () => [{ kind: "BROKEN", pattern: "([" }],
    });
    await masker.ensureKey();

    expect(masker.maskText(SECRET)).toContain("{{API_KEY_");
  });
});

describe("Masker words, kind switches and prefixes", () => {
  function optionMasker(options: {
    words?: string[];
    wordsAnyCase?: boolean;
    wordsWhole?: boolean;
    categorySwitches?: Record<string, boolean>;
    rules?: { kind: string; prefix?: string; pattern: string; flags?: string }[];
  }): Masker {
    return new Masker({
      neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-option-")),
      logger,
      allow: () => [],
      words: () => options.words ?? [],
      wordsAnyCase: () => options.wordsAnyCase === true,
      wordsWhole: () => options.wordsWhole === true,
      categorySwitches: () => options.categorySwitches ?? {},
      rules: () => options.rules ?? [],
    });
  }

  it("masks the user's words as written, or in any case", async () => {
    const written = optionMasker({ words: ["Nightjar"] });
    await written.ensureKey();
    const masked = written.maskText("Nightjar and nightjar");
    expect(masked).toMatch(/^\{\{TERM_[0-9a-f]{8}\}\} and nightjar$/);

    const any = optionMasker({ words: ["Nightjar"], wordsAnyCase: true });
    await any.ensureKey();
    expect(any.maskText("Nightjar and nightjar")).toMatch(
      /^\{\{TERM_[0-9a-f]{8}\}\} and \{\{TERM_[0-9a-f]{8}\}\}$/,
    );
  });

  it("matches words only as whole words where asked", async () => {
    const masker = optionMasker({ words: ["ABC"], wordsWhole: true });
    await masker.ensureKey();
    const masked = masker.maskText("ABC 'ABC' XABCD");
    expect(masked.match(/\{\{TERM_[0-9a-f]{8}\}\}/g)?.length).toBe(2);
    expect(masked).toContain("XABCD");

    const digits = optionMasker({ words: ["123456"], wordsWhole: true });
    await digits.ensureKey();
    const number = digits.maskText("0.123456 123456.78 123456");
    expect(number.match(/\{\{TERM_[0-9a-f]{8}\}\}/g)?.length).toBe(1);
    expect(number).toContain("0.123456");
    expect(number).toContain("123456.78");
  });

  it("turns a personal kind off by its own switch", async () => {
    const on = optionMasker({});
    await on.ensureKey();
    expect(on.maskText("234-56-7890")).toMatch(/\{\{SSN_[0-9a-f]{8}\}\}/);

    const off = optionMasker({ categorySwitches: { ssn: false } });
    await off.ensureKey();
    expect(off.maskText("234-56-7890")).toBe("234-56-7890");
  });

  it("masks only the user's words with Mask secrets off", async () => {
    const masker = new Masker({
      neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-words-only-")),
      logger,
      allow: () => [],
      secrets: () => false,
      words: () => ["Nightjar"],
    });
    await masker.ensureKey();
    const masked = masker.maskText(`Nightjar ${SECRET}`);
    expect(masked).toContain(SECRET);
    expect(masked).toMatch(/\{\{TERM_[0-9a-f]{8}\}\}/);
  });

  it("matches a rule's prefix followed by a key's characters", async () => {
    const masker = optionMasker({
      rules: [{ kind: "GATEWAY_KEY", prefix: "oc_sk_", pattern: "" }],
    });
    await masker.ensureKey();
    const masked = masker.maskTextWithHits("key oc_sk_ABCDEFGH done");
    expect(masked.text).toMatch(/^key \{\{GATEWAY_KEY_[0-9a-f]{8}\}\} done$/);
    expect(masked.hits[0]?.by).toBe("yours");
    expect(masker.maskText("oc_sk_abc")).toBe("oc_sk_abc");
  });
});

describe("Mask personal data", () => {
  function personalMasker(options: {
    personal: boolean;
    secrets: boolean;
    categories?: string[];
    categorySwitches?: Record<string, boolean>;
    words?: string[];
    rules?: { kind: string; pattern: string }[];
  }): Masker {
    return new Masker({
      neolixHome: mkdtempSync(path.join(os.tmpdir(), "neolix-mask-personal-")),
      logger,
      allow: () => [],
      personal: () => options.personal,
      secrets: () => options.secrets,
      categories: () => options.categories ?? [],
      categorySwitches: () => options.categorySwitches ?? {},
      words: () => options.words ?? [],
      rules: () => options.rules ?? [],
    });
  }

  it("masks no personal data while it is off, but keeps secrets, rules and words", async () => {
    const masker = personalMasker({
      personal: false,
      secrets: true,
      words: ["Nightjar"],
      rules: [{ kind: "TICKET", pattern: "TICKET-[0-9]+" }],
    });
    await masker.ensureKey();
    const masked = masker.maskTextWithHits(`ada@example.com ${SECRET} TICKET-1234 Nightjar`);
    expect(masked.text).toContain("ada@example.com");
    expect(masked.text).not.toContain(SECRET);
    expect(masked.text).not.toContain("TICKET-1234");
    expect(masked.text).not.toContain("Nightjar");
    expect(masked.hits.map((hit) => hit.kind).sort()).toEqual(["API_KEY", "TERM", "TICKET"]);
  });

  it("masks personal data while it is on and secrets are off, and no rules", async () => {
    const masker = personalMasker({
      personal: true,
      secrets: false,
      rules: [{ kind: "TICKET", pattern: "TICKET-[0-9]+" }],
    });
    await masker.ensureKey();
    const masked = masker.maskTextWithHits(`ada@example.com ${SECRET} TICKET-1234`);
    expect(masked.text).toMatch(/\{\{EMAIL_[0-9a-f]{8}\}\}/);
    expect(masked.text).toContain(SECRET);
    expect(masked.text).toContain("TICKET-1234");
    expect(masked.hits.map((hit) => hit.kind)).toEqual(["EMAIL"]);
  });

  it("does not mask a personal kind its categories list while it is off", async () => {
    const masker = personalMasker({
      personal: false,
      secrets: true,
      categories: ["EMAIL"],
      categorySwitches: { ssn: true },
    });
    await masker.ensureKey();
    expect(masker.maskText("ada@example.com")).toBe("ada@example.com");
  });

  it("keeps a kind's own switch under it", async () => {
    const off = personalMasker({
      personal: true,
      secrets: true,
      categorySwitches: { ssn: false },
    });
    await off.ensureKey();
    expect(off.maskText("234-56-7890")).toBe("234-56-7890");
  });

  it("masks personal data after a config written before the switch is read", async () => {
    const neolixHome = mkdtempSync(path.join(os.tmpdir(), "neolix-mask-upgrade-"));
    writeFileSync(
      path.join(neolixHome, "gateway.json"),
      JSON.stringify({ version: 1, masking: { enabled: true } }),
    );
    const store = new GatewayConfigStore({ neolixHome, logger });
    await store.start();
    const masker = new Masker({
      neolixHome,
      logger,
      allow: () => [],
      personal: () => store.get().masking?.personal === true,
    });
    await masker.ensureKey();

    const masked = masker.maskText("write to ada@example.com");
    expect(masked).not.toContain("ada@example.com");
    expect(masked).toMatch(/\{\{EMAIL_[0-9a-f]{8}\}\}/);
    store.dispose();
  });
});
