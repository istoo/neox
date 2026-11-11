import { defineRpc } from "@neolix/plugin";
import { z } from "zod";

export const greetRpc = defineRpc({
  name: "greet",
  input: z.object({ name: z.string().optional(), args: z.string().optional() }),
  output: z.object({ message: z.string() }),
});

export const notesSearchRpc = defineRpc({
  name: "notes.search",
  input: z.object({ query: z.string() }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        identifier: z.string().optional(),
        title: z.string(),
        subtitle: z.string().optional(),
        text: z.string(),
        resourceType: z.string().optional(),
        url: z.string().optional(),
      }),
    ),
  }),
});
