import { Effect, Schema } from "effect"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  tool: Schema.String,
  error: Schema.String,
})

export const InvalidTool = Tool.define(
  "invalid",
  Effect.succeed({
    description: "Do not use",
    parameters: Parameters,
    execute: (params: { tool: string; error: string }) =>
      Effect.succeed({
        title: "Unknown or invalid tool",
        output: [
          `Tool call failed for "${params.tool}".`,
          params.error,
          "Do not call a tool named invalid. Pick one of the available tools from the schema and retry with valid arguments.",
        ].join("\n"),
        metadata: { repaired: true, attempted: params.tool },
      }),
  }),
)
