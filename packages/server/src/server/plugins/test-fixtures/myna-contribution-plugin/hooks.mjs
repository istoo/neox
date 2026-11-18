export async function onRequest(body) {
  if (body && typeof body === "object") body.recalled = true;
  return body;
}

export async function onResponse(reply, ctx) {
  globalThis.__mynaReply = { success: ctx.success };
}
