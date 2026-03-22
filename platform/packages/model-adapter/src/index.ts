export { createAnthropicAdapter } from "./anthropic.js";
export type { ModelAdapter, ModelCallParams, ModelCallResult, SupportedProvider } from "./types.js";

/**
 * Extracts JSON from a model response that may be wrapped in markdown code fences.
 * Claude sometimes wraps JSON in ```json ... ``` even when told not to.
 */
export function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1]!.trim();
  // Find the first { or [ and take from there to the last } or ]
  const startBrace = raw.indexOf("{");
  const startBracket = raw.indexOf("[");
  const start =
    startBrace === -1
      ? startBracket
      : startBracket === -1
        ? startBrace
        : Math.min(startBrace, startBracket);
  if (start === -1) return raw.trim();
  const isObj = raw[start] === "{";
  const end = isObj ? raw.lastIndexOf("}") : raw.lastIndexOf("]");
  if (end === -1) return raw.trim();
  return raw.slice(start, end + 1);
}

/**
 * Extracts raw code from a model response, stripping markdown fences.
 */
export function extractCode(raw: string): string {
  const fenced = raw.match(/```(?:javascript|js)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1]!.trim();
  return raw.trim();
}
