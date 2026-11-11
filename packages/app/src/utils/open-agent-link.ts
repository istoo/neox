import * as Linking from "expo-linking";
import { isWeb } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";

/** The agent apps whose own deeplinks Neolix may open. */
const AGENT_LINK = /^(aionui|cindy|lody):/i;

/**
 * Opens an agent app's own deeplink (`aionui://add-provider…`, `cindy://provider/import…`),
 * the way myna's Import button does. False when this platform has no way to
 * open it, so the caller can offer the link to copy instead.
 */
export async function openAgentLink(url: string): Promise<boolean> {
  if (!AGENT_LINK.test(url)) return false;
  if (isWeb) {
    const opener = getDesktopHost()?.opener?.openAgentLink;
    if (typeof opener !== "function") return false;
    await opener(url);
    return true;
  }
  await Linking.openURL(url);
  return true;
}
