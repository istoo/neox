# Calc tools, ported from myna

`server/calc/index.mjs` and `server/calc/calc.mjs` are copied unmodified from
`@magpie-community/tools-calc@0.1.0` (MIT, <https://github.com/magpie-community/plugins>).
They are pure functions with no dependencies; the wrapper in `index.server.ts` is Neolix's.

This is the myna conversion pilot: `index.server.ts` turns the package's JSON Schema tool hooks
into Neolix agent tools with `z.fromJSONSchema` and attaches them in `agent.open.before`.
