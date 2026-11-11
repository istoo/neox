# LLM gateway

The daemon can serve models from providers Neox does not manage itself. Agents point their
provider base URL at the daemon and Neox forwards the request, so one config file holds the keys,
the model list and the fallback order.

This is Neox's counterpart to a local model gateway such as myna: one catalog of providers,
model aliases, failover, and translation between the Anthropic Messages, OpenAI Chat Completions,
OpenAI Responses and Gemini wire protocols.

## Endpoints

Mounted on the daemon's own port, before web UI and daemon bearer auth:

| Path                                                                          | API                                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------- |
| `GET /v1/models`                                                              | the configured catalog                              |
| `POST /v1/messages`                                                           | Anthropic Messages                                  |
| `POST /v1/messages/count_tokens`                                              | Anthropic token count                               |
| `POST /v1/chat/completions`                                                   | OpenAI Chat Completions                             |
| `POST /v1/responses`                                                          | OpenAI Responses                                    |
| `GET /v1beta/models`                                                          | Gemini model catalog                                |
| `POST /v1beta/models/{model}:generateContent`                                 | Gemini                                              |
| `POST /v1beta/models/{model}:streamGenerateContent`                           | Gemini, streaming                                   |
| `POST /v1/embeddings`, `/v1/rerank`                                           | raw passthrough                                     |
| `POST /v1/images/generations`, `/v1/images/edits`                             | raw passthrough                                     |
| `POST /v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/audio/translations` | raw passthrough                                     |
| `POST /v1/videos`                                                             | OpenAI Videos API: start a video                    |
| `GET/POST/DELETE /v1/myna/keys`                                               | key issue, list, revoke                             |
| `GET /v1`, `GET /v1/models/{id}`                                              | gateway info, one model                             |
| `GET /v1/myna/quotas`, `/usage`                                               | account windows, spend, recent calls                |
| `GET /v1/myna/concurrency`, `/limit`, `/route`                                | inflight lanes, caller limits, conversation binding |
| `GET /v1/videos/{id}`, `/v1/videos/{id}/content`                              | video status and bytes                              |

The non-chat endpoints skip protocol translation: the body keeps its shape, the `model` field
(or the `model` part of a multipart form) is rewritten to the provider's id, and the reply bytes go
back with the upstream status and content type. They use the same key, alias, failover, account
pool and ledger rules as chat.

## Protocol translation

The client protocol comes from the endpoint; the upstream protocol comes from the provider's
`protocol` field. When they match, the request and response pass through untouched except for
`model`. When they differ, both sides go through an internal IR (`ir.ts`), so any client can use
any provider:

- Anthropic request to OpenAI Chat: system prompt becomes a `system` message, `tool_use` becomes
  `tool_calls`, `tool_result` becomes `tool` messages, images become `data:` URLs.
- OpenAI Chat to Anthropic: the reverse, with `tool` messages grouped into one user message of
  `tool_result` blocks.
- OpenAI Responses carries its system prompt in `instructions` and its turns in `input`, mixing
  `message` items with `function_call` and `function_call_output` items.
- Gemini carries turns in `contents[].parts` (`text`, `inlineData`, `functionCall`,
  `functionResponse`), the system prompt in `systemInstruction`, and tools in
  `functionDeclarations`. Reasoning parts marked `thought: true` stay reasoning instead of leaking
  into the reply. Streaming selects the method name, not a body flag, and the body's `model` field
  is omitted.
- Streaming is translated event by event: OpenAI `delta.content` becomes `text_delta`,
  `delta.reasoning_content` becomes `thinking_delta`, and `delta.tool_calls` argument fragments
  become `input_json_delta` blocks. The reverse emits OpenAI chunks and a final `data: [DONE]`;
  Responses emits `response.output_text.delta` and `response.completed`; Gemini emits `data:`
  frames the same way `alt=sse` does.
- Reasoning text survives translation. An Anthropic thinking signature is kept with its text
  while the gateway re-encodes the turn (masking, hooks, a stream shape change) and replayed when
  the turn goes back to an Anthropic-protocol upstream. Gemini's thought signatures ride in the
  call ids a client sees (`<id>__ts<n>__<signature>`) or, for Gemini's OpenAI-compatible API, in
  `extra_content.google.thought_signature`, and go back to Gemini; a turn translated to another
  vendor keeps the reasoning text and drops the signature.
- Codex's tool search is kept for the ChatGPT backend, which runs it as Codex sends it. Another
  Responses API is offered the search as a plain function, its earlier calls and results as a
  function's, and the tools a search found among its tools without `defer_loading`; the model's
  calls to it come back to Codex as `tool_search_call`. A request that only carries the history (a
  compaction) is rewritten too, with no tools added.

A client that asks for streaming gets a stream even if the upstream answered in one piece, and a
client that asks for JSON gets a complete message from an upstream that streamed.

## Config

`$NEOLIX_HOME/gateway.json`, re-read when the file changes. A malformed file disables the gateway
and logs once; it never falls back to a previous revision's credentials.

```json
{
  "version": 1,
  "keys": ["local-dev-key"],
  "providers": [
    {
      "id": "deepseek",
      "protocol": "openai",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "sk-…",
      "models": [{ "id": "deepseek-v4-pro", "contextWindow": 1000000 }]
    },
    {
      "id": "zai",
      "protocol": "anthropic",
      "baseUrl": "https://api.z.ai/api/anthropic/v1",
      "models": [{ "id": "glm-5.3" }],
      "accounts": [
        { "id": "main", "apiKey": "…", "priority": 10, "weight": 3 },
        {
          "id": "spare",
          "apiKey": "…",
          "weight": 1,
          "maxRpm": 30,
          "quota": { "tokens5h": 2000000 },
          "monthlyUsd": 20
        }
      ]
    }
  ],
  "groups": [
    { "id": "coding", "members": ["zai/glm-5.3", "deepseek/deepseek-v4-pro"], "strategy": "rotate" }
  ],
  "middleware": {
    "aliases": { "fast": "deepseek/deepseek-v4-pro" },
    "overrides": [{ "model": "deepseek/deepseek-v4-pro", "set": { "temperature": 0.2 } }]
  },
  "pricing": { "deepseek/deepseek-v4-pro": { "inputPerMTok": 0.28, "outputPerMTok": 1.1 } },
  "budget": { "monthlyUsd": 50 },
  "masking": { "enabled": true, "allow": ["sk-known-test-key"] }
}
```

- A model id is `provider/model`. A bare model id resolves to the first provider that has it.
- `group/<id>` resolves to its members; members may be groups. A cycle is an error.
- `protocol` is `anthropic`, `openai`, `openai-responses` or `gemini`.
- `strategy` is `order` (default), `rotate`, `least-used`, `smart` or `pace`, or a running plugin's
  `<pluginId>/<strategyId>` ([plugins](plugins.md#gateway-middleware)).
- `middleware.aliases` maps a client-facing model name to a catalog id. The reply keeps the alias,
  so a caller that echoes `model` back gets its own name.
- `middleware.overrides` patches the upstream request body after translation, so `set` and
  `remove` use the upstream protocol's field names. A rule without `model` applies to every
  request; a rule with one matches either the requested id or the upstream model id.
- Failover moves to the next candidate only before any byte reaches the client, and only for
  401/403/408/409/425/429 and 5xx or a transport error.
- `keys` empty means loopback callers only. With keys set, `x-api-key` or `Authorization: Bearer`
  must match. An entry is either the secret or an object with limits (see Access control).
- `providers[].accounts` is that vendor's credential pool. A provider with only `apiKey` has one
  implicit account called `default`.
- `providers[].enabled: false` keeps a provider's keys and settings but serves nothing: it leaves
  `/v1/models`, routing, video and the usage pollers until it is set back on.
- `pricing` is per million tokens, keyed by `provider/model` (or a bare model id). `budget.monthlyUsd`
  caps the whole gateway per calendar month. Prices missing here come from the models.dev catalog,
  cached in `$NEOLIX_HOME/gateway-pricing.json` and refreshed every six hours.
- `priceRate` scales every computed cost; `peak` sets a rate for a local-time hour range, so a
  vendor's peak surcharge lands in the ledger and the budgets.
- `maxAccounts` limits how many accounts may serve at once; `queueWaitMs` lets a request wait that
  long for a free account instead of failing. `sink` marks a provider as best-effort: its failure
  never blocks the response from the rest of the group.
- `accounts[].warmup` sends one minimum-size turn every five hours, so a quota window starts at a
  known time; it spends the account's own allowance, so it is off unless set.
- `search` enables one search vendor (Tavily-shaped `url`, `apiKey`, optional `monthlyCalls`).
  `keys[].searchCallsPerMonth` caps one key; a successful call is charged once.
- `oidc.rules` each name an issuer, an audience, the claims a token must carry, the gateway key it
  is issued under and the longest lifetime. No rule means no exchange.
- `mcp` maps a myna MCP name (`tools`, `vision`, `image`, `browser`, `hub`, `run:<name>`) to the
  JSON-RPC URL that serves it; with no entry the endpoint still answers MCP with an empty tool
  list.
- `codexBackend` is the base URL for `/backend-api/codex/*`; without it those calls answer 501.

## Account pool

Failover walks the accounts of one provider before it moves to the next routing member, so a dead
credential costs one attempt, not the whole provider.

| Field            | Meaning                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `priority`       | Higher tiers are exhausted first; a lower tier is only touched when every higher one is resting or full |
| `weight`         | Share of traffic inside one tier, smooth weighted round-robin                                           |
| `maxConcurrency` | Attempts in flight; a full account moves behind the ones with room                                      |
| `maxRpm`         | Requests per rolling minute                                                                             |
| `models`         | Model ids this account serves; empty means every model of the provider                                  |
| `quota`          | Rolling token caps (`tokens5h`, `tokens7d`); the account rests when they run out                        |
| `monthlyUsd`     | Spend cap for this account per calendar month                                                           |
| `proxy`          | `http(s)://` or `socks5://` for this account, or `direct`; absent follows the gateway's own proxy       |
| `usageUrl`       | Endpoint polled for this account's remaining allowance; `usageIntervalMs` sets the period (default 5m)  |
| `enabled`        | `false` removes it from rotation without deleting the key                                               |

A failed attempt rests the account, not the provider: the gateway's backoff, a minute doubling up
to ten, or until the `Retry-After` or reset the vendor named. A rested account moves to the back
of its tier instead of disappearing.

The gateway's own `proxy` is the fallback for accounts that name none, and for the daemon's
requests outside the gateway (a WebSocket, an agent process). It follows myna's order: the settings
value when set (`""` or absent means auto, `direct` means off), then `HTTP(S)_PROXY`/`ALL_PROXY`,
then the system's proxy — macOS network settings through `scutil --proxy`, Windows Internet
Options. A `socks5://` address is carried by a loopback HTTP bridge, because undici and Bun refuse
a SOCKS proxy directly. Settings › Network shows which proxy is in force and what chose it.
Loopback is never proxied.

Rate-limit headers (`anthropic-ratelimit-*`, `x-ratelimit-*`) are read from every reply. An account
the vendor reports at zero rests until the reset time in the header, and an account whose
`usageUrl` reports nothing left sorts behind the others.

The allowance curves read `$NEOLIX_HOME/gateway-quota-readings.jsonl`. When sync shares usage, the
other computers' readings are merged in at read time, and each point says which computer it came
from (`device`: `"this"` or the other's id). Nothing is appended to the local file — it stays the
poller's own log — and with no other computer's readings the answer is unchanged. Cards are still
drawn only for this computer's configured providers and accounts: shared history fills their
curves, it does not add cards for accounts configured elsewhere.

A credit failure (402, or a 4xx body naming insufficient credit, balance or payment) rests the
account on a ladder: 30 minutes, then 2 hours, 8 hours, 1 day, 3 days, 7 days. The level persists in
`$NEOLIX_HOME/gateway-rests.json`, so a restart does not retry a drained account.

## Routing

A failed upstream is rested before the next request: the gateway's backoff, a minute doubling up
to ten, with the vendor's `Retry-After` winning when it names one. Rested candidates move to the
back of the list instead of disappearing, so a request still tries them when every upstream is
resting.

| Strategy     | Order of members                                       |
| ------------ | ------------------------------------------------------ |
| `order`      | as written                                             |
| `rotate`     | next member first, advancing per request               |
| `least-used` | fewest successful requests, then written order         |
| `smart`      | longest since it last answered, then written order     |
| `pace`       | longest since it last answered, then fewest successful |

`smart` and `pace` spread requests across accounts that each have their own allowance. They read
recency and served counts, not vendor quota headers, so they reduce the chance of draining one
account first; they cannot know the allowance itself. Failed attempts do not count as usage, so a
rate-limited upstream is not made to look busy.

Send `x-neolix-conversation: <id>` to keep a conversation on the upstream and account that answered
its previous turn: the vendor's prompt cache only pays off while the same account keeps serving. A
failed turn drops that binding, and a bound upstream that left the group is ignored. Bindings are
written to `$NEOLIX_HOME/gateway-affinity.json` (newest 512, dropped after a day) and restored on
start.

Each request appends one line to `$NEOLIX_HOME/gateway-usage.jsonl`: requested model, serving
provider, account and model, status, tokens, attempts, duration, cost and key. Counters live in memory and reset when
the daemon restarts. Token counts come from the upstream reply, so a streamed same-protocol request
that passes straight through records zeros.

A 400 that names `thinking` is retried once without `thinking` and `output_config`: a client that
asks for a thinking budget still gets an answer from a model that only accepts adaptive thinking.

## Videos

`POST /v1/videos` starts a video and answers at once with an OpenAI-shaped video object whose
`id` names the provider and the vendor's job. `GET /v1/videos/{id}` reports its state and
`GET /v1/videos/{id}/content` sends the bytes once it is made. The gateway keeps no state between
the calls: the id is `video_<provider>.<vendor id>.<started>.<account mark>`.

A provider makes videos when a model has `"kind": "video"`, or when its host (or `videoApi`) names
a vendor whose video API is implemented:

| `videoApi` | Vendor API                                                       | Models                              |
| ---------- | ---------------------------------------------------------------- | ----------------------------------- |
| `openai`   | `<base>/videos`, then `<base>/videos/{id}` and `/content`        | models marked `"kind": "video"`     |
| `ark`      | Volcengine Ark `<base>/contents/generations/tasks`               | Seedance models, or marked models   |
| `minimax`  | MiniMax `<host>/v2/video_generation` and `/v2/query/...`         | MiniMax-H3, -Highspeed, -Lite, -Max |
| `grok`     | Grok `<base>/videos/generations`, status at `<base>/videos/{id}` | `grok-imagine-video*`               |

`videoApi` is inferred from the provider's host when omitted: MiniMax's API hosts, `grok.com`, and
Volcengine Ark's hosts select their own; every other host speaks the OpenAI-shaped API. Set it when
a relay or a custom domain hides the vendor.

```json
{
  "id": "ark",
  "protocol": "openai-responses",
  "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
  "apiKey": "…",
  "videoApi": "ark",
  "models": [{ "id": "doubao-seedance-2-0-260128" }]
}
```

The request is OpenAI's Videos body (JSON or multipart): `model`, `prompt`, `seconds`, `size`,
`input_reference`, `last_frame`, `reference_images`. Fields myna does not read are passed to the
vendor unchanged. `model` may be `provider/model` or a bare video model id; with none, the first
provider that makes videos is used, and MiniMax keys come last because H3 is paid from their
balance. `size` may be `WIDTHxHEIGHT`, a ratio, or a tier; each vendor is given its nearest form.

Only Ark's Seedance accepts `seconds: -1` (the model picks the length), an image with no prompt,
and `asset://` images. A MiniMax request takes frames or reference images, not both. A download
is capped at 512 MB; every vendor call is given five minutes. Asking for content before the video
is ready answers 409 with its current state.

## Browser

`/mcp/myna/browser` serves one MCP tool, `browser`, whose `action` names what to do: `tabs`,
`navigate`, `snapshot`, `click`, `type`, the rest. Each call is handed to the Myna Browser
extension (ported from myna, bundled under `llm-gateway/browser-extension`) over
`/v1/myna/browser/extension`; the extension carries it out with the DevTools protocol in the
user's own Chrome, Edge or other Chromium browser and answers with MCP content.

The extension is written where the user can load it with
`POST /v1/myna/browser/setup` (`{"dir": "/path"}`; default `~/Neox Browser Extension`), loopback
only. Load it in `chrome://extensions` with "Load unpacked"; it connects by itself while the
browser and the daemon both run. `GET /v1/myna/browser` reports whether it is connected.

Only this computer's extension may open the socket (its origin is checked), and only this
computer's agents may call the tools: they act as the user wherever their browser is signed in.
With more than one browser connected, `action: "browsers"` lists them and `use_browser` picks one
per MCP session (`X-Magpie-Browser-Session` or `Mcp-Session-Id`).

## Library MCP sign-ins

A remote Library server that asks for OAuth (Neon, Notion, Supabase…) is signed in to once, in
Settings → Library → MCP, and every agent given it reaches it through `/mcp/<name>` on the daemon.
The sign-in follows the MCP spec: the server's 401 names its protected resource metadata
(RFC 9728), that names the authorization server (RFC 8414), and Neox registers a client
(RFC 7591) and authorizes with PKCE. A server with no resource metadata is treated as the older
spec, its own origin being the authorization server. An "OAuth app" in the server's editor is
used when the server doesn't allow dynamic registration.

Tokens live in `$NEOLIX_HOME/mcp-signins.json` (0600, atomic) and are never sent over an RPC: the
snapshot carries only `signedIn`/`dead`. The relay renews a token two minutes before it expires,
and once more when the server refuses it; a refusal after that marks the sign-in dead and the
Library says so. `/mcp/<name>` answers a dead sign-in with 502 rather than 401, so an agent does
not start a sign-in of its own. Requests carrying an `Origin` are refused: the relay lends the
sign-in to agents, not to web pages.

A server not signed in keeps its own URL in the agent's config, and the agent signs in itself.

The MCP hub connects to a signed-in server itself with Neox's token, not through `/mcp/<name>`: a
401 on a stored token renews it once, a 401 on the renewed one marks the sign-in dead, and a
sign-in change resets the hub's connections.

## MCP over stdio

`neox mcp <name>` serves one of the gateway's MCP servers on stdin/stdout for an agent that
launches MCP servers as commands. It passes each JSON-RPC line to `/mcp/<name>` and writes the
answer back; `image` and `vision` map to their `/mcp/myna/` paths. `NEOLIX_GATEWAY` (or `--gateway`)
and `NEOLIX_GATEWAY_KEY` (or `--key`) point it at a gateway other than the local daemon's.

For `image`, a generated file is saved into the project the agent runs in, under
`generated-images/` or `generated-videos/`, named from the prompt and the time, never over an
existing file; the answer gains a `Saved to <path>` line. Set the server up in the Library as
`command: neox`, `args: ["mcp", "image"]`.

## MCP tools from the terminal

`neox tools` lists what the gateway's own MCP servers (image, vision, web-search, tools) give
agents, with each tool's parameters; `neox tools <name>` shows one in full. `neox tool <name>
[--<param> <value>…] [<words>…] [-o <file|folder>] [--json]` calls one the way an agent would:
unknown and missing parameters are refused before anything is called, and the words left over go
to the tool's one required text. An image or video it makes is saved like `neox mcp image` saves
one (`-o` names a file or folder, else `generated-images/` or `generated-videos/` named from the
prompt, never over a file already there); `--json` prints the raw result and saves nothing. The
gateway address comes from `NEOLIX_GATEWAY` or the daemon's config, as for `neox mcp`.

## Access control, budget and cost

A key entry with limits looks like this:

```json
{
  "key": "pk-team",
  "label": "team",
  "models": ["group/coding", "zai/*"],
  "dailyTokens": 5000000,
  "monthlyUsd": 25,
  "ratePerMinute": 120
}
```

- `models` accepts exact ids, `provider/model`, `group/<id>`, and `provider/*`. Empty means every
  model the catalog resolves.
- `dailyTokens` counts tokens served today for this key; `monthlyUsd` counts its cost this month.
  Older files may use these two alone; they are read as the equivalent day-token and month-cost
  limits, so both shapes hold a key the same way.
- `limits` is the list form, at most five windows, each holding the key on its own. A request
  passes only while every one has something left:

```json
{
  "key": "pk-team",
  "limits": [
    { "period": "day", "tokens": 5000000 },
    { "period": "hours", "hours": 5, "cost": 3, "cacheReads": true },
    { "period": "days", "days": 10, "tokens": 40000000, "since": "2026-11-01T09:00:00Z" }
  ]
}
```

`period` is `day`, `week` or `month` (calendar, local time), or `days`/`hours` (a cycle of
`days`/`hours` from `since`, the moment the limit was set). Tokens are uncached input, output and
cache writes, plus cache reads when `cacheReads` is true; `cost` is the Usage page's estimate.
Setting `since` to now is the Reset action: the window starts again from there. A request in
flight holds a reservation — its body's size in tokens plus the key's mean output per call — so
parallel requests overshoot by about one call. A refusal carries `Retry-After` in seconds until
the window resets.

- `ratePerMinute` is a sliding one-minute window; a rejected request does not consume it.
- The global `budget.monthlyUsd` is checked before routing. A refusal is `402 budget_exceeded`;
  a key limit is `429 quota_exceeded`; a model outside the allow-list is `403 model_not_allowed`.
- `readOnly` keys may only list models, read quota/usage and count tokens; anything that spends is
  `403 read_only_key`. `expiresAt` (ISO timestamp) makes a key stop working at that moment.
- A key with `issues: true` may create child keys at `POST /v1/myna/keys`. Children are `pk_…`
  entries stored in `gateway.json`, can be listed (secrets are masked) and revoked. Limits cannot
  exceed the issuer's own.

Cost comes from `pricing` and the token counts the upstream reported, and is written to the ledger
line (`costUsd`). Without a price entry the cost is zero, so budgets only bind where prices exist.
Spend is replayed from `gateway-usage.jsonl` at start, so a restart does not reset the month.

## Search and OIDC

`search` serves Codex's `/v1/alpha/search` and an MCP endpoint at
`/mcp/myna/web-search` (`initialize`, `tools/list`, `tools/call` with a `search` tool). The daemon
forwards `{query}` to the configured URL with the API key, records the call in
`$NEOLIX_HOME/gateway-search.jsonl`, and refuses once the key's `searchCallsPerMonth` or the global
`monthlyCalls` is used up.

When a model that can't search asks for `web_search`, the gateway runs one search and tells the
client about it as its provider would: Anthropic clients get `server_tool_use` and
`web_search_tool_result` blocks, Responses clients a `web_search_call` item, before the answer.

`search.apis[].vendor` also takes a plugin's API, named `plugin:<pluginId>:<searchId>`
([plugins](plugins.md#search-apis)); the settings page lists those beside the built-in vendors.

`POST /v1/myna/keys/oidc` takes `Authorization: Bearer <JWT>` and returns a `pk_…` key. Tokens must
be RS256, signed by a configured issuer, and carry every claim the rule names (a claim value may be
a glob). The rule's `key` must be a gateway key with `issues: true`; the child key inherits its
models and lives no longer than `ttlSeconds`. A token with a `jti` is traded once. The same
behaviour is in `oidc.ts` and `routes.test.ts`.

`GET /v1/myna/keys/oidc` lists the rules with the issuer key masked.

## Key page and warm-up

`GET /me` is a small HTML page that asks for a key and calls `GET /v1/myna/me`; the JSON lists that
key's limits, spend, today's tokens and its own recent calls, never another key's.

`accounts[].warmup` warms a quota window: one `max_tokens: 1` request to the first model, then one
every five hours. It runs when the daemon starts and on each ten-minute tick (`warmup.ts`). A live
run with an account enabled logged `Warmed a quota window {provider:"myna", status:200}` on the
first tick; myna has no public endpoint that triggers its own warm-up, so there is no counterpart
to probe.

## Masking

With `masking.enabled`, secrets in the request are replaced before they leave the machine and put
back in the reply. Recognised kinds: private key blocks, `sk-` API keys, GitHub tokens, AWS access
keys, Slack tokens and `Bearer` tokens.

With `masking.personal`, personal data is masked too: emails, phone numbers, ID and bank card
numbers, and the kinds under it. With it off, none of them masks whatever its own switch says
(myna's `redactPersonal`). Words and rules do not depend on it. A request masks anything when
`enabled`, `personal` or `words` asks for it.

- `masking.categories` narrows the built-in kinds; empty means all of them.
- `masking.categorySwitches` turns one personal kind or an opt-in group (`userhost`, `bucket`) on or
  off by its lower-case id; an absent kind is on, an absent opt-in group off. A kind is still off
  while `masking.personal` is off.
- `masking.words` masks the user's own words as written, with either switch off; `wordsAnyCase`
  matches them in any case and `wordsWhole` only as whole words. Words are masked after the
  built-in rules, so a key keeps its own kind.
- `masking.rules` adds `{kind, prefix, pattern, flags}` entries, masked while `enabled` is on; a rule
  has a prefix or a regular expression, and an invalid expression is logged and skipped, never
  failing the request. A prefix matches itself followed by eight or more key characters.
- `masking.routeTo` names a `provider/model` that takes requests unmasked. A request masking would
  change goes there as written instead of being masked; if that model fails, the request fails.
  Only a model whose every route is set to `unredacted` can be picked.
- The settings page edits all of these: per-kind switches, words, the rules' mode/kind/pattern, and
  the unmasked model.

- A value becomes `{{KIND_xxxxxxxx}}`, derived from an HMAC key stored in
  `$NEOLIX_HOME/gateway-mask-key`. The same value always gets the same placeholder.
- Values are held in memory only. `allow` lists values that must never be masked.
- Streaming restores placeholders as text arrives and holds back a placeholder split across
  chunks.
- Masking turns off the same-protocol passthrough: requests and replies are re-encoded through the
  IR, which drops provider thinking signatures.

## Pointing an agent at the gateway

Set the provider's base URL in `config.json` like any other custom endpoint
([custom-providers.md](custom-providers.md)). Claude reads `ANTHROPIC_BASE_URL`; Codex and other
OpenAI-protocol agents read `OPENAI_BASE_URL`.

```json
{
  "agents": {
    "providers": {
      "claude": {
        "env": {
          "ANTHROPIC_BASE_URL": "http://127.0.0.1:6768",
          "ANTHROPIC_AUTH_TOKEN": "<one of gateway.json keys>"
        }
      }
    }
  }
}
```

Model ids in the picker come from the agent's own catalog, so add the gateway's `provider/model`
ids to that provider's `models` list.

A gateway profile must also stop Claude Code from loading the machine's own settings, which usually
carry a base URL of their own. Set `options.settingSources` to an empty array on the provider:

```json
"neolix-gateway": {
  "extends": "claude",
  "label": "Neox Gateway",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:6768",
    "ANTHROPIC_AUTH_TOKEN": "<one of gateway.json keys>"
  },
  "models": [{ "id": "deepseek/deepseek-v4-pro", "label": "DeepSeek through the gateway" }],
  "options": { "settingSources": [] }
}
```

Claude Code logs `[claude-code:unrecognized_model]` on stderr for a gateway model id it does not
know. The request still reaches the gateway with that id, so the agent answers normally; the line
is noise, not a failure.

Title, branch name and commit message generation pick their own model; automatic selection tries
the first catalog model whose id contains `haiku`. If that model id is not one the installed
Claude Code accepts, generation fails with a 400. Point it at the gateway profile explicitly:

```json
{
  "agents": {
    "metadataGeneration": {
      "providers": [{ "provider": "neolix-gateway", "model": "myna/auto/claude-haiku-5-5" }]
    }
  }
}
```

## Middleware hooks

`middleware.hooks` holds JavaScript function bodies. They run with `ctx` in scope, have 250ms, and
every error keeps the request as it was (fail open). This is trusted local code from
`gateway.json`; `node:vm` bounds the runtime, not the capabilities.

```json
"hooks": {
  "request": "if (ctx.model === 'cheap') return { reject: { status: 403, message: 'not here' } }",
  "provider": "ctx.body.temperature = 0.2",
  "account": "if (ctx.account === 'spare') return { skip: true }"
}
```

- `request` sees the client body and `model`; returning `{reject:{status,message}}` ends the request.
- `provider` sees the translated upstream body plus `provider`, `account` and `model`; it runs per
  attempt, so it may rewrite the body for each one.
- `account` runs before an account is used; `{skip:true}` removes it for this request without
  resting it and without counting a failed attempt.
- `response` sees the complete reply body and may return a replacement `body`.
- `event` runs on every stream event; returning `{event: …}` replaces it, `{drop: true}` removes it.
  An event hook forces the stream through the IR even when the protocols match.

## Configuring in the app

Settings → a host → **Model gateway** edits the same file through the daemon, laid out the way
myna's window lays its gateway out: an overview with the switch, masking, budget, account health,
quota bars and recent calls; then providers and their account pools, routing groups, access keys,
and a JSON editor for everything else (pricing, middleware). The selected tab uses myna's indigo
(`#4f46e5` light, `#a5b4fc` dark) and the same card, pill and status-dot language. The daemon
validates the whole document before writing, so an invalid edit is refused instead of disabling
the gateway. Changes are pushed to every connected client.

## Myna parity

`routes.test.ts` ends with an in-process parity check covering every client-facing path myna
serves: chat, images, audio, videos, embeddings, rerank, Responses over HTTP, both protocol
prefixes, Ollama, native, search, key page, quotas, trace, usage, statusline, diagnostics, MCP
companions, Codex's backend and vendor-native paths.

Two scripts check the implementation against a running myna:

```bash
node packages/server/scripts/myna-parity.mjs --myna http://127.0.0.1:3425 --neolix http://127.0.0.1:6768
node packages/server/scripts/myna-behaviour.mjs --myna http://127.0.0.1:3425 \
  --neolix http://127.0.0.1:6768 --model auto/claude-haiku-5-5
```

`myna-parity.mjs` probes routes with empty or invalid bodies (no model call), compares MCP tool
lists, and compares the status of endpoints where myna defines an error contract. The last run:
62 probes, 0 route gaps, 0 Neox-only answers, 0 tool-list differences, 0 behaviour differences,
and the same `/me` and empty-`web_search` shapes. Its report is
`artifacts/myna-parity-report.json`.

`myna-behaviour.mjs` sends one tiny turn through each chat protocol and compares bodies and stream
frames. The last run with `auto/claude-haiku-5-5` matched all ten shapes: Anthropic JSON and SSE,
OpenAI chat JSON and chunks, Responses JSON and events, Gemini JSON and SSE data, Ollama JSON and
NDJSON, including keys, content part types, sequence numbers and Ollama timing fields.

MCP companion tools carry myna's names and schemas (`web_search`/`web_fetch` with a working fetch,
`calc_*`, `analyze_image`, `generate_image`/`generate_video`/`generation_result`, `browser`).
`calc_eval`, `calc_convert` and `calc_date` run locally with exact fraction arithmetic, myna's unit
table and calendar/time-zone rules; the parity script compares their output with live myna on each
run and reports 0 differences. The other tools are forwarded to the server named by
`mcp.<name>`; without one, `tools/list` still matches and a call answers an MCP error rather than a 404. With the dev config's `mcp.*` pointed at myna, the
verified execution paths are: `calc_*` locally and through myna (identical output), `analyze_image`
(identical "Red"), `generate_image` (pending id, then a finished image with a file URL and inline
data), `generate_video` (myna has no video model, both refuse with the same `isError` message), and
`browser` (a program's call reaches myna's tool and gets the same "Myna Browser isn't
connected" result; a browser-originated call gets the same 403 from both). The MCP proxy uses a raw
HTTP client, because undici's `Sec-Fetch-*` headers make myna treat it as a web page. Warm-up has no
public myna endpoint to probe — myna drives it from its own account loop and this checkout has no
warm-up state file — so `warmup.ts` is verified by unit tests for the five-hour window and the
off-by-default account.

`POST /v1/myna/restart` answers `state: "current"` under the supervisor (the worker can ask it to
respawn through `neolix:restart`), matching live myna's answer from a terminal; a browser-originated
call is refused with myna's 403, and without a supervisor the answer is `unsupported`.

The CLI keeps myna's commands under different words, because Neox's `usage` already means account
quotas: `myna quota` is `neox usage` (quotas, balances, reset, alerts), and `myna usage` is
`neox usage report` (tokens, cost, CSV). The report takes myna's periods, `--days`, and `--last`;
a `--last` that isn't whole days is a rolling window ending now, filtered by `gateway.usage.get`'s
`since`/`until`, so a host older than that field answers `UNSUPPORTED_HOST` instead of widening the
window.

### Daily check-ins

`neox accounts checkin` presses myna's daily check-ins (签到) and so do the Usage page's check-in
card and the TUI's `c`. Accounts come from myna's own plugin sign-ins in
`~/.config/myna/plugin-auth.json`; Neox never asks for the password, and writes back only renewed
token fields (below). WorkBuddy (China), MiniMax Code (China and international), Trae CN and Qoder
(international and CN) are ported. Results are kept in
`$NEOLIX_HOME/gateway/{workbuddy,minimax,trae,qoder}-checkin.json`, keyed by account, with myna's
semantics: one press a Beijing day, a provisional answer re-asked every 30 minutes until noon, a
failure retried after 30 minutes, and an offline failure backed off 1, 2, 4, 8, 16 and 30 minutes.
The vendor switches live in `gateway.json` under `checkin`; absent is off, as myna's settings are.

Trae CN sends the growth page's `{"req_source":1}` body with the IDE's headers and a 15-digit device
derived from the account, and a 9074 claim is tried once more in the request Trae's client-less
tools send. Qoder asks the campaigns page as the account's device token and needs the machine
identity from Qoder's own `runtime-info` (desktop app, CLI cache, or `QODER_RUNTIME_INFO` /
`QODERCN_RUNTIME_INFO`); without it the day is `ineligible`, not retried every half hour.

Neox renews a token through the endpoint its plugin uses: WorkBuddy's
`/v2/plugin/auth/token/refresh` and MiniMax's OAuth refresh grant when the access token is within ten
minutes of its end, Trae CN's device-bound ExchangeToken (then the plain `/cloudide/` page) when its
JWT is, and Qoder's device token once when a campaigns call answers 401/403. The result goes back
into `plugin-auth.json` only where the entry still holds the token the renewal spent (a
compare-and-swap), merging just the token fields, so a sign-in myna refreshed meanwhile is left
alone.

### Plugin-backed providers

A provider can be served by a plugin's subscription provider. Point it at the plugin and list its
models; each account's `id` names the sign-in the plugin keeps:

```json
{
  "id": "qoder",
  "protocol": "anthropic",
  "baseUrl": "https://plugin.invalid",
  "plugin": { "pluginId": "qoder-auth", "providerId": "qoder" },
  "models": [{ "id": "ultimate" }],
  "accounts": [{ "id": "ann" }]
}
```

Before each attempt the gateway asks the plugin's loader with the account id, model, body and the
headers it built. The loader answers the real `baseUrl`, additional headers, and optionally a
reshaped body; those win over the provider's. `baseUrl` is a placeholder because the loader names
the address. A provider whose plugin is not running, or whose account the loader can't serve, skips
the attempt without resting it. A loader that returns its own `fetch` (a vendor whose request is
signed as it goes) has every request sent through the plugin process instead; that answer is
buffered whole, so a stream arrives as one body. A plugin provider with no models listed has them
filled from the plugin at startup, and again when a plugin registration changes.

A running plugin's gateway middleware may also rewrite any attempt's request or non-streaming
answer, its own provider's or another's, and its usage observers see each finished call
([plugins](plugins.md#gateway-middleware)).
