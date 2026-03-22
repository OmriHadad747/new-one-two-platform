// ─── Model Adapter Public Interfaces ─────────────────────────────────────────
// All agents use these types. No agent imports an AI SDK directly.

export type SupportedProvider = "anthropic";

export interface ModelCallParams {
  /** Which generation session this call belongs to (for cost tracking) */
  sessionId: string;
  /** Human-readable agent name written to generation_events */
  agentName: string;
  systemPrompt: string;
  userPrompt: string;
  /** Override the default model for this call */
  model?: string;
  /** Max tokens to generate. Defaults to 4096. */
  maxTokens?: number;
}

export interface ModelCallResult {
  /** Raw text content from the model */
  content: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
  provider: SupportedProvider;
}

export interface ModelAdapter {
  call(params: ModelCallParams): Promise<ModelCallResult>;
  readonly defaultModel: string;
  readonly provider: SupportedProvider;
}
