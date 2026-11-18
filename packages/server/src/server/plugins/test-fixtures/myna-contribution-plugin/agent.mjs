export const agent = {
  id: "demo-agent",
  name: "Demo Agent",
  config: "~/.demo-agent/config.json",
  model: "model",
  prefix: "openai/",
};

export function connect({ gateway, model }) {
  return { "base-url": gateway.v1, "api-key": gateway.key, model };
}
