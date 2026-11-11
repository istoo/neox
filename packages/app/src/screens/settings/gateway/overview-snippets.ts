/** The four client APIs the gateway translates. */
export type GatewayApi = "openai" | "responses" | "anthropic" | "gemini";

export type SnippetLanguage = "shell" | "curl" | "python" | "node";

export interface GatewaySnippetInput {
  api: GatewayApi;
  language: SnippetLanguage;
  /** `http://host:port`, with no trailing slash. */
  origin: string;
  model: string;
  apiKey: string;
}

export interface GatewayEnvVar {
  name: string;
  value: string;
}

export function gatewayBaseUrl(origin: string, api: GatewayApi): string {
  const trimmed = origin.replace(/\/$/, "");
  return api === "openai" || api === "responses" ? `${trimmed}/v1` : trimmed;
}

/** The variables an SDK or CLI reads for this API. */
export function gatewayEnvVars(api: GatewayApi, origin: string, apiKey: string): GatewayEnvVar[] {
  const base = gatewayBaseUrl(origin, api);
  switch (api) {
    case "openai":
    case "responses":
      return [
        { name: "OPENAI_BASE_URL", value: base },
        { name: "OPENAI_API_KEY", value: apiKey },
      ];
    case "anthropic":
      return [
        { name: "ANTHROPIC_BASE_URL", value: base },
        { name: "ANTHROPIC_AUTH_TOKEN", value: apiKey },
      ];
    case "gemini":
      return [
        { name: "GOOGLE_GEMINI_BASE_URL", value: base },
        { name: "GEMINI_API_KEY", value: apiKey },
      ];
  }
}

/** The variable behind the Base URL row. */
export function gatewayBaseEnvName(api: GatewayApi): string {
  return gatewayEnvVars(api, "http://127.0.0.1", "")[0]?.name ?? "OPENAI_BASE_URL";
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

function requestBody(api: GatewayApi, model: string): string {
  switch (api) {
    case "openai":
      return JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
      });
    case "responses":
      return JSON.stringify({ model, input: "hi" });
    case "anthropic":
      return JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      });
    case "gemini":
      return JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] });
  }
}

function requestUrl(origin: string, api: GatewayApi, model: string): string {
  const trimmed = origin.replace(/\/$/, "");
  switch (api) {
    case "openai":
      return `${trimmed}/v1/chat/completions`;
    case "responses":
      return `${trimmed}/v1/responses`;
    case "anthropic":
      return `${trimmed}/v1/messages`;
    case "gemini":
      return `${trimmed}/v1beta/models/${model}:generateContent`;
  }
}

function authHeaders(api: GatewayApi, apiKey: string): string[] {
  switch (api) {
    case "openai":
    case "responses":
      return [`Authorization: Bearer ${apiKey}`];
    case "anthropic":
      return [`x-api-key: ${apiKey}`, "anthropic-version: 2023-06-01"];
    case "gemini":
      return [`x-goog-api-key: ${apiKey}`];
  }
}

function curlSnippet(input: GatewaySnippetInput): string {
  const url = requestUrl(input.origin, input.api, input.model);
  const headers = [...authHeaders(input.api, input.apiKey), "Content-Type: application/json"];
  const lines = headers.map((header) => `  -H ${shellQuote(header)} \\`).join("\n");
  return `curl ${shellQuote(url)} \\\n${lines}\n  -d ${shellQuote(requestBody(input.api, input.model))}`;
}

function shellSnippet(input: GatewaySnippetInput): string {
  return gatewayEnvVars(input.api, input.origin, input.apiKey)
    .map((entry) => `export ${entry.name}=${shellQuote(entry.value)}`)
    .join("\n");
}

function pythonSnippet(input: GatewaySnippetInput): string {
  const base = gatewayBaseUrl(input.origin, input.api);
  const model = jsonString(input.model);
  const key = jsonString(input.apiKey);
  const baseLiteral = jsonString(base);
  switch (input.api) {
    case "openai":
      return `from openai import OpenAI

client = OpenAI(base_url=${baseLiteral}, api_key=${key})
r = client.chat.completions.create(
    model=${model},
    messages=[{"role": "user", "content": "hi"}],
)
print(r.choices[0].message.content)`;
    case "responses":
      return `from openai import OpenAI

client = OpenAI(base_url=${baseLiteral}, api_key=${key})
r = client.responses.create(model=${model}, input="hi")
print(r.output_text)`;
    case "anthropic":
      return `import anthropic

client = anthropic.Anthropic(base_url=${baseLiteral}, api_key=${key})
m = client.messages.create(
    model=${model},
    max_tokens=1024,
    messages=[{"role": "user", "content": "hi"}],
)
print(m.content[0].text)`;
    case "gemini":
      return `from google import genai

client = genai.Client(api_key=${key}, http_options={"base_url": ${baseLiteral}})
r = client.models.generate_content(model=${model}, contents="hi")
print(r.text)`;
  }
}

function nodeSnippet(input: GatewaySnippetInput): string {
  const base = gatewayBaseUrl(input.origin, input.api);
  const model = jsonString(input.model);
  const key = jsonString(input.apiKey);
  const baseLiteral = jsonString(base);
  switch (input.api) {
    case "openai":
      return `import OpenAI from "openai";

const client = new OpenAI({ baseURL: ${baseLiteral}, apiKey: ${key} });
const r = await client.chat.completions.create({
  model: ${model},
  messages: [{ role: "user", content: "hi" }],
});
console.log(r.choices[0].message.content);`;
    case "responses":
      return `import OpenAI from "openai";

const client = new OpenAI({ baseURL: ${baseLiteral}, apiKey: ${key} });
const r = await client.responses.create({ model: ${model}, input: "hi" });
console.log(r.output_text);`;
    case "anthropic":
      return `import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ baseURL: ${baseLiteral}, apiKey: ${key} });
const m = await client.messages.create({
  model: ${model},
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }],
});
console.log(m.content[0].text);`;
    case "gemini":
      return `import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: ${key},
  httpOptions: { baseUrl: ${baseLiteral} },
});
const r = await ai.models.generateContent({ model: ${model}, contents: "hi" });
console.log(r.text);`;
  }
}

export function buildGatewaySnippet(input: GatewaySnippetInput): string {
  switch (input.language) {
    case "shell":
      return shellSnippet(input);
    case "curl":
      return curlSnippet(input);
    case "python":
      return pythonSnippet(input);
    case "node":
      return nodeSnippet(input);
  }
}
