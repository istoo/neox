/**
 * Whether the gateway settings page has an error to show instead of its
 * permanent spinner. A failed read leaves the config null, which the load
 * branch would otherwise treat as still loading.
 */
export function gatewayConfigUnavailable(input: {
  isLoading: boolean;
  hasConfig: boolean;
  error: unknown;
}): boolean {
  return !input.isLoading && !input.hasConfig && input.error !== null && input.error !== undefined;
}
