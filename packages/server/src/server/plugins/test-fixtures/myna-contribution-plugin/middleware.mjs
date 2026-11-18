export function onRequest(body, ctx) {
  if (body && body.rejectWith !== undefined) {
    ctx.reject(body.rejectWith, body.rejectMessage);
    return undefined;
  }
  if (ctx && ctx.state) ctx.state.marker = body && body.marker !== undefined ? body.marker : null;
  body.middleware = "on";
  return body;
}

export function onProvider(body, ctx) {
  body.provider = ctx.provider.id;
  body.marker = ctx.state ? (ctx.state.marker ?? null) : null;
  return body;
}

export function onAccount(account) {
  return account.ref === "skip-me" ? { skip: true } : undefined;
}

export function onEvent(event) {
  if (event && event.drop) return null;
  if (event && typeof event === "object") event.seen = true;
  return event;
}

export function onResponse(body, ctx) {
  if (body && typeof body === "object") {
    body.status = ctx.status;
    body.marker = ctx.state ? (ctx.state.marker ?? null) : null;
  }
  return body;
}

export const strategies = {
  reverse(pool, seats) {
    return seats.map((_seat, index) => index).toReversed();
  },
};

export function onUsage(row) {
  globalThis.__mynaUsage = row;
}
