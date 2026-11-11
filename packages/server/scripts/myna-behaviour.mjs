#!/usr/bin/env node
/**
 * Compares response bodies and streaming frames of the chat protocols on a
 * running myna and a running Neolix gateway. It spends one tiny request per
 * shape (`max_tokens: 1`), so the two sides answer with different text but
 * the same structure.
 *
 *   node scripts/myna-behaviour.mjs --myna http://127.0.0.1:3425 --neolix http://127.0.0.1:6768 --model auto/deepseek-v4.1-flash
 */
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const MYNA = arg("myna", "http://127.0.0.1:3425");
const NEOLIX = arg("neolix", "http://127.0.0.1:6768");
const MODEL = arg("model", "auto/deepseek-v4.1-flash");
const NEOLIX_MODEL = arg("neolix-model", `myna/${MODEL}`);

const payloads = {
  messages: { model: "MODEL", max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
  chat: { model: "MODEL", max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
  ollama: { model: "MODEL", stream: false, messages: [{ role: "user", content: "hi" }] },
};

async function request(base, path, body, model) {
  const requestBody = JSON.parse(JSON.stringify(body).replaceAll("MODEL", model));
  const url = `${base}${path.replaceAll("MODEL", model)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, text: await response.text() };
}

function keysOf(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
}

function messageShape(text) {
  try {
    const body = JSON.parse(text);
    return {
      keys: ["id", "type", "role", "model", "content", "stop_reason", "usage"].filter(
        (key) => body[key] !== undefined,
      ),
      type: body.type,
      contentTypes: Array.isArray(body.content)
        ? [...new Set(body.content.map((part) => part.type).filter((type) => type !== "thinking"))]
        : [],
      usage: ["input_tokens", "output_tokens"].filter((key) => body.usage?.[key] !== undefined),
    };
  } catch {
    return { raw: text.slice(0, 120) };
  }
}

function chatShape(text) {
  try {
    const body = JSON.parse(text);
    const choice = body.choices?.[0] ?? {};
    return {
      keys: keysOf(body),
      object: body.object,
      choiceKeys: keysOf(choice),
      messageKeys: keysOf(choice.message),
      usage: ["prompt_tokens", "completion_tokens", "total_tokens"].filter(
        (key) => body.usage?.[key] !== undefined,
      ),
    };
  } catch {
    return { raw: text.slice(0, 120) };
  }
}

function ollamaShape(text) {
  try {
    const body = JSON.parse(text);
    return { keys: keysOf(body), messageKeys: keysOf(body.message), done: body.done };
  } catch {
    return { raw: text.slice(0, 120) };
  }
}

function sseEventTypes(text) {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("event:")))
    .filter(Boolean)
    .map((line) => line.slice(6).trim())
    .filter((type) => type !== "ping");
}

function chunkKeys(text) {
  const required = new Set(["choices", "created", "id", "model", "object"]);
  const patterns = new Set();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
    try {
      patterns.add(
        keysOf(JSON.parse(line.slice(5)))
          .filter((key) => required.has(key))
          .join(","),
      );
    } catch {
      patterns.add("unparsed");
    }
  }
  return [...patterns];
}

function responsesShape(text) {
  try {
    const body = JSON.parse(text);
    return {
      keys: ["id", "object", "created_at", "status", "model", "output", "usage"].filter(
        (key) => body[key] !== undefined,
      ),
      object: body.object,
      outputTypes: Array.isArray(body.output) ? body.output.map((item) => item.type) : [],
      usage: ["input_tokens", "output_tokens", "total_tokens"].filter(
        (key) => body.usage?.[key] !== undefined,
      ),
    };
  } catch {
    return { raw: text.slice(0, 120) };
  }
}

function geminiShape(text) {
  try {
    const body = JSON.parse(text);
    const candidate = body.candidates?.[0] ?? {};
    return {
      keys: keysOf(body),
      candidateKeys: keysOf(candidate),
      partTypes: (candidate.content?.parts ?? []).map((part) => Object.keys(part).sort().join(",")),
      usage: keysOf(body.usageMetadata),
    };
  } catch {
    return { raw: text.slice(0, 120) };
  }
}

function dataKeys(text) {
  const patterns = new Set();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") continue;
    try {
      patterns.add(keysOf(JSON.parse(payload)).join(","));
    } catch {
      patterns.add("unparsed");
    }
  }
  return [...patterns];
}

const cases = [
  { name: "messages", path: "/v1/messages", body: payloads.messages, shape: messageShape },
  { name: "chat", path: "/v1/chat/completions", body: payloads.chat, shape: chatShape },
  { name: "ollama", path: "/api/chat", body: payloads.ollama, shape: ollamaShape },
  {
    name: "responses",
    path: "/v1/responses",
    body: { model: "MODEL", input: "hi", max_output_tokens: 200 },
    shape: responsesShape,
    neolixModel: "myna-responses/auto/deepseek-v4.1-flash",
  },
  {
    name: "gemini",
    path: "/v1beta/models/MODEL:generateContent",
    body: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { maxOutputTokens: 50 },
    },
    shape: geminiShape,
    neolixModel: "myna-gemini/auto/deepseek-v4.1-flash",
  },
  {
    name: "messages stream",
    path: "/v1/messages",
    body: { ...payloads.messages, stream: true },
    shape: (text) => ({ sse: sseEventTypes(text) }),
  },
  {
    name: "chat stream",
    path: "/v1/chat/completions",
    body: { ...payloads.chat, stream: true },
    shape: (text) => ({ chunks: chunkKeys(text) }),
  },
  {
    name: "ollama stream",
    path: "/api/chat",
    body: { model: "MODEL", messages: [{ role: "user", content: "hi" }] },
    shape: (text) => ({
      lines: [
        ...new Set(
          text
            .trim()
            .split("\n")
            .map((line) => keysOf(JSON.parse(line)).join(",")),
        ),
      ],
    }),
  },
  {
    name: "responses stream",
    path: "/v1/responses",
    body: { model: "MODEL", input: "hi", max_output_tokens: 200, stream: true },
    shape: (text) => ({ sse: dataKeys(text) }),
    neolixModel: "myna-responses/auto/deepseek-v4.1-flash",
  },
  {
    name: "gemini stream",
    path: "/v1beta/models/MODEL:streamGenerateContent?alt=sse",
    body: {
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { maxOutputTokens: 50 },
    },
    shape: (text) => ({ data: dataKeys(text) }),
    neolixModel: "myna-gemini/auto/deepseek-v4.1-flash",
  },
];

let differences = 0;
for (const { name, path, body, shape, neolixModel } of cases) {
  const [myna, neolix] = await Promise.all([
    request(MYNA, path, body, MODEL),
    request(NEOLIX, path, body, neolixModel ?? NEOLIX_MODEL),
  ]);
  const mynaShape = myna.status < 300 ? shape(myna.text) : { status: myna.status };
  const neolixShape = neolix.status < 300 ? shape(neolix.text) : { status: neolix.status };
  const equal = JSON.stringify(mynaShape) === JSON.stringify(neolixShape);
  if (!equal) {
    differences += 1;
  }
  console.log(
    `${equal ? "SAME" : "DIFF"} ${name.padEnd(16)} myna ${JSON.stringify(mynaShape)} neolix ${JSON.stringify(neolixShape)}`,
  );
}
console.log(`\n${cases.length} response shapes, ${differences} differences`);
process.exitCode = differences === 0 ? 0 : 1;
