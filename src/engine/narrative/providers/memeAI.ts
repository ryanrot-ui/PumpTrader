import Anthropic from "@anthropic-ai/sdk";
import type { MemeAssessment } from "../types";

/**
 * AI-assisted meme quality assessment — OPTIONAL. Requires ANTHROPIC_API_KEY;
 * without it the meme score falls back to the heuristic components only and
 * this provider reports null.
 *
 * Called at most once per token (the result is cached by the engine): a
 * single small structured-output request judging originality, humor, current
 * trend relevance, and branding appeal from the token's name/symbol and
 * social presence. The model returns an explanation so the score stays
 * transparent. This is an opinion signal, not a prediction of profit.
 */

// Default per the platform guidance; override with ANTHROPIC_MODEL (e.g.
// claude-haiku-4-5 to cut evaluation cost on high-volume scanning).
const DEFAULT_MODEL = "claude-opus-4-8";

const SCHEMA = {
  type: "object",
  properties: {
    originality: { type: "integer", description: "0-100: is this meme concept original vs a tired derivative (copies of dog/pepe coins score low)" },
    humor: { type: "integer", description: "0-100: funny or memorable enough to be shared" },
    trendRelevance: { type: "integer", description: "0-100: tied to a CURRENT trend, viral event, or live internet culture (as of your knowledge)" },
    brandAppeal: { type: "integer", description: "0-100: name/ticker likely to catch attention in a fast-scrolling feed" },
    reasoning: { type: "string", description: "2-3 sentences explaining the scores, mentioning the strongest and weakest factor" },
  },
  required: ["originality", "humor", "trendRelevance", "brandAppeal", "reasoning"],
  additionalProperties: false,
} as const;

let client: Anthropic | null | undefined;

function getClient(): Anthropic | null {
  if (client !== undefined) return client;
  client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  return client;
}

export function memeAiEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const clamp = (v: unknown): number =>
  Math.max(0, Math.min(100, Math.round(typeof v === "number" ? v : 50)));

export async function assessMemeQuality(
  symbol: string | null,
  name: string | null,
  context: { hasTwitter: boolean; hasTelegram: boolean; hasWebsite: boolean; description?: string | null }
): Promise<MemeAssessment | null> {
  const anthropic = getClient();
  if (!anthropic || (!symbol && !name)) return null;

  try {
    const response = await anthropic.messages.create(
      {
        model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
        max_tokens: 1024,
        system:
          "You evaluate newly launched Solana meme coins for meme quality only — not price, not investment advice. " +
          "Judge whether the meme itself has viral potential. Be skeptical: most meme coins are low-effort derivatives " +
          "and should score low. Reserve high scores for genuinely original, funny, or trend-connected concepts.",
        messages: [
          {
            role: "user",
            content:
              `Token symbol: ${symbol ?? "(unknown)"}\n` +
              `Token name: ${name ?? "(unknown)"}\n` +
              `Has X/Twitter: ${context.hasTwitter} · Telegram: ${context.hasTelegram} · Website: ${context.hasWebsite}\n` +
              (context.description ? `Listed description: ${context.description}\n` : "") +
              "Assess this meme coin's meme quality.",
          },
        ],
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
      },
      { timeout: 30_000, maxRetries: 1 }
    );

    if (response.stop_reason === "refusal") return null;
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return null;
    const parsed = JSON.parse(text.text) as Record<string, unknown>;
    return {
      originality: clamp(parsed.originality),
      humor: clamp(parsed.humor),
      trendRelevance: clamp(parsed.trendRelevance),
      brandAppeal: clamp(parsed.brandAppeal),
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch (e) {
    // Degrade to heuristics-only; never let the AI provider block scanning.
    console.warn(`[narrative] meme AI assessment failed: ${(e as Error).message}`);
    return null;
  }
}
