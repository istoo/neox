interface ExternalUrlOwner {
  open(url: string): Promise<void>;
}

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

/** The agent apps whose own deeplinks Neolix may hand to the OS. */
const AGENT_PROTOCOLS = new Set(["aionui:", "cindy:", "lody:"]);

const asExternalUrl = (input: unknown): URL | undefined => {
  if (typeof input !== "string" || !URL.canParse(input)) return undefined;
  const candidate = new URL(input);
  return EXTERNAL_PROTOCOLS.has(candidate.protocol) ? candidate : undefined;
};

export function createExternalUrlOpener(owner: ExternalUrlOwner) {
  return async (candidate: unknown): Promise<void> => {
    const url = asExternalUrl(candidate);
    if (url === undefined) {
      throw new Error("Only HTTP(S) URLs can open externally.");
    }
    return owner.open(url.href);
  };
}

/** Opens an agent app's deeplink, only for the apps Neolix knows. */
export function createAgentLinkOpener(owner: ExternalUrlOwner) {
  return async (candidate: unknown): Promise<void> => {
    if (typeof candidate !== "string" || !URL.canParse(candidate)) {
      throw new Error("That is not an agent link.");
    }
    const url = new URL(candidate);
    if (!AGENT_PROTOCOLS.has(url.protocol)) {
      throw new Error("Only the agent apps Neox knows can be opened by their link.");
    }
    return owner.open(url.href);
  };
}
