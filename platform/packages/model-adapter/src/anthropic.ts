import Anthropic from "@anthropic-ai/sdk";
import { insertGenerationEvent } from "@new-one-two/db";
import { logger } from "@new-one-two/logger";
import type { ModelAdapter, ModelCallParams, ModelCallResult } from "./types.js";

const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    return err.status === 429 || err.status >= 500;
  }
  return false;
}

export function createAnthropicAdapter(options?: {
  apiKey?: string;
  defaultModel?: string;
}): ModelAdapter {
  const client = new Anthropic({
    apiKey: options?.apiKey ?? process.env["ANTHROPIC_API_KEY"],
  });

  const defaultModel = options?.defaultModel ?? "claude-haiku-4-5-20251001";

  async function callWithRetry(
    params: ModelCallParams
  ): Promise<ModelCallResult> {
    const model = params.model ?? defaultModel;
    const maxTokens = params.maxTokens ?? 4096;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = INITIAL_DELAY_MS * 2 ** (attempt - 1);
        logger.warn(
          { agentName: params.agentName, attempt, delay },
          "Model call retry"
        );
        await sleep(delay);
      }

      const startMs = Date.now();
      try {
        const response = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system: params.systemPrompt,
          messages: [{ role: "user", content: params.userPrompt }],
        });

        const latencyMs = Date.now() - startMs;
        const content =
          response.content[0]?.type === "text" ? response.content[0].text : "";
        const inputTokens = response.usage.input_tokens;
        const outputTokens = response.usage.output_tokens;

        // Fire-and-forget — cost tracking must not block the generation
        insertGenerationEvent({
          sessionId: params.sessionId,
          agentName: params.agentName,
          provider: "anthropic",
          model,
          inputTokens,
          outputTokens,
          latencyMs,
          status: "success",
        }).catch((err: unknown) =>
          logger.error({ err }, "Failed to write generation_event")
        );

        return { content, inputTokens, outputTokens, latencyMs, model, provider: "anthropic" };
      } catch (err) {
        lastError = err;
        if (!isRetryable(err)) break;
      }
    }

    const errorMsg = lastError instanceof Error ? lastError.message : String(lastError);

    insertGenerationEvent({
      sessionId: params.sessionId,
      agentName: params.agentName,
      provider: "anthropic",
      model,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      status: "failed",
      error: errorMsg,
    }).catch((err: unknown) =>
      logger.error({ err }, "Failed to write failed generation_event")
    );

    throw lastError;
  }

  return {
    call: callWithRetry,
    get defaultModel() {
      return defaultModel;
    },
    provider: "anthropic",
  };
}
