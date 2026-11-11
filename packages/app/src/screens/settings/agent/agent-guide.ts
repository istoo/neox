/**
 * myna's guideShown (gui/assets/app.js): the Get started card shows until a
 * model source and a connected agent are both there, unless the reader put
 * it away or the host is in gateway mode. The routing step is optional and
 * never decides whether the card shows.
 */
export interface GuideState {
  /** A model source is there: the gateway lists at least one model. */
  source: boolean;
  /** At least one agent is wired to the gateway. */
  agent: boolean;
  /** The user has a routing group of its own (found groups do not count). */
  routing: boolean;
  show: boolean;
}

export function guideStateOf(input: {
  gatewayMode: boolean;
  hidden: boolean;
  models: number;
  anyConnected: boolean;
  ownGroups: number;
}): GuideState {
  const source = input.models > 0;
  const agent = input.anyConnected;
  const routing = input.ownGroups > 0;
  return {
    source,
    agent,
    routing,
    show: !input.gatewayMode && !input.hidden && !(source && agent),
  };
}
