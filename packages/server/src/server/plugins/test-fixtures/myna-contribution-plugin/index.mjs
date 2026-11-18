export async function DemoContributions(pluginInput, options) {
  pluginInput.app.log(options.greeting);
  return {
    tool: {
      add: {
        description: "Adds two numbers",
        args: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        execute({ a, b }) {
          return { sum: a + b };
        },
      },
    },
    search: {
      web: {
        name: "Demo search",
        keysURL: "https://example.com/keys",
        keyOptional: true,
        execute({ query, count }) {
          return {
            results: [
              {
                title: "Result for " + query,
                url: "https://example.com/" + encodeURIComponent(query),
                text: count + " pages",
              },
            ],
          };
        },
      },
    },
    auth: {
      provider: "demo",
      name: "Demo",
      methods: [{ type: "api", label: "API key" }],
      async loader() {
        return { baseURL: "https://demo.invalid/v1", headers: { "x-demo": "1" } };
      },
    },
    provider: {
      id: "demo",
      models() {
        return { fast: { name: "Demo Fast", limit: { context: 8000, output: 1000 } } };
      },
    },
    "chat.headers"(input, output) {
      output.headers["x-myna-demo"] = input.provider.info.id;
    },
    config(config) {
      const providers = { ...config.provider };
      providers.demo = {
        ...providers.demo,
        name: "Demo",
        npm: "@ai-sdk/openai-compatible",
      };
      config.provider = providers;
    },
  };
}
