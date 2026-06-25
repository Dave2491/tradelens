export type AiReview = {
  recommendedVerdict?: "Accept" | "Modify" | "Avoid";
  confidence: number;
  summary: string;
  mainRisks: string[];
  saferPlan: string;
  missingInfo: string[];
};

type ReviewBody = {
  signal?: unknown;
  market?: unknown;
  report?: unknown;
};

type ReviewEnv = {
  BITGET_QWEN_API_KEY?: string;
  QWEN_BASE_URL?: string;
  QWEN_MODEL?: string;
  QWEN_REVIEW_MODEL?: string;
};

const DEFAULT_QWEN_BASE_URL = "https://hackathon.bitgetops.com/v1";
const DEFAULT_QWEN_MODEL = "qwen3.6-flash";
const FALLBACK_REVIEW: AiReview = {
  confidence: 0,
  summary: "AI review was unavailable, so TradeLens is showing deterministic risk output only.",
  mainRisks: ["Qwen did not return a structured review."],
  saferPlan: "Use the deterministic safer plan until AI review is available.",
  missingInfo: [],
};

function createPrompt(body: ReviewBody) {
  return [
    "You are TradeLens, an AI crypto trade-risk analyst.",
    "Explain the trade verdict in plain language for a retail crypto trader.",
    "Be direct. Do not promise profit. Do not encourage overleverage.",
    "Be technically precise: leverage magnifies PnL, margin pressure, and liquidation risk, but it does not make the market price touch a stop-loss sooner. Never claim that leverage itself increases the probability of a stop being hit.",
    "A stop-loss execution is not a liquidation. Never call an ordinary stop-out a liquidation unless an actual liquidation price is supplied and crossed.",
    "No real account balance is supplied. Refer to simulated sizing as a paper-risk cap, never as verified account risk.",
    "Ground all RSI, EMA, ATR, trend, and stop-placement claims in the market timeframe provided. Never claim to use another timeframe or an indicator that is absent from the risk report.",
    "The supplied indicators use completed Bitget candles. volatilityPct is Wilder ATR expressed as a percentage of live price, not a prediction of the next move.",
    "Use derivatives fields only when present. Funding can indicate crowded positioning; current open interest gives scale but not whether participation is rising or falling; order-book imbalance is a short-lived liquidity snapshot, not a prediction.",
    "BTC context is broad same-timeframe market context from completed Bitget candles. It can support or conflict with an altcoin setup, but it is not proof that the altcoin will follow Bitcoin.",
    "Entry guidance is deterministic order guidance based on live distance, ATR, and the final risk verdict. Do not contradict it unless you name a concrete risk found in the supplied data.",
    "Do not call funding crowded unless its absolute rate is at least 0.03%. Smaller values may identify who pays whom, but are not evidence of crowding.",
    "Never claim that fees, spread, funding, or slippage exceed the expected reward unless explicit numeric costs are supplied and support that calculation. When costs are missing, say they may reduce net reward and cannot be quantified precisely.",
    "The deterministic safer stop is derived from ATR distance. Do not call it support, resistance, a swing high, or a swing low unless those market-structure levels are explicitly supplied.",
    "If timeframeSource is inferred, call it TradeLens's best-fit estimate from the trade structure and live volatility; do not claim the user supplied it. If timeframeSource is default, clearly call it an assumption.",
    "Recommend one verdict: Accept, Modify, or Avoid. Use Avoid for invalid stop/target placement or severe risk. Use Modify for thin risk/reward, high leverage, or incomplete context.",
    "Return only valid JSON with this exact shape:",
    '{"recommendedVerdict":"Modify","confidence":0.82,"summary":"string","mainRisks":["string"],"saferPlan":"string","missingInfo":["string"]}',
    "Keep the review compact: one summary sentence under 35 words, exactly 2 main risks under 30 words each, a safer plan under 60 words, and no more than 2 missing-info items.",
    "",
    `Signal: ${JSON.stringify(body.signal ?? null)}`,
    `Market: ${JSON.stringify(body.market ?? null)}`,
    `Risk report: ${JSON.stringify(body.report ?? null)}`,
  ].join("\n");
}

function extractText(payload: any): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  if (typeof payload.text === "string") return payload.text;

  const content = payload.output?.flatMap((item: any) => item.content ?? []) ?? [];
  const textPart = content.find((item: any) => typeof item.text === "string");
  if (textPart?.text) return textPart.text;

  const messagePart = content.find((item: any) => typeof item.content === "string");
  if (messagePart?.content) return messagePart.content;

  return "";
}

function normalizeReview(value: unknown): AiReview {
  if (!value || typeof value !== "object") return FALLBACK_REVIEW;

  const candidate = value as Partial<AiReview>;
  const recommendedVerdict =
    candidate.recommendedVerdict === "Accept" || candidate.recommendedVerdict === "Modify" || candidate.recommendedVerdict === "Avoid"
      ? candidate.recommendedVerdict
      : undefined;
  const confidence = Math.max(0, Math.min(1, Number(candidate.confidence) || 0));

  return {
    recommendedVerdict,
    confidence,
    summary: typeof candidate.summary === "string" ? candidate.summary : FALLBACK_REVIEW.summary,
    mainRisks: Array.isArray(candidate.mainRisks)
      ? candidate.mainRisks.filter((item): item is string => typeof item === "string").slice(0, 2)
      : FALLBACK_REVIEW.mainRisks,
    saferPlan: typeof candidate.saferPlan === "string" ? candidate.saferPlan : FALLBACK_REVIEW.saferPlan,
    missingInfo: Array.isArray(candidate.missingInfo)
      ? candidate.missingInfo.filter((item): item is string => typeof item === "string").slice(0, 2)
      : [],
  };
}

function parseReview(payload: unknown): AiReview {
  const text = extractText(payload);
  if (!text) return FALLBACK_REVIEW;

  try {
    return normalizeReview(JSON.parse(text));
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return FALLBACK_REVIEW;

    try {
      return normalizeReview(JSON.parse(jsonMatch[0]));
    } catch {
      return FALLBACK_REVIEW;
    }
  }
}

export async function createAiReview(body: ReviewBody, env: ReviewEnv) {
  const apiKey = env.BITGET_QWEN_API_KEY;
  const baseUrl = env.QWEN_BASE_URL ?? DEFAULT_QWEN_BASE_URL;
  const model = env.QWEN_REVIEW_MODEL ?? env.QWEN_MODEL ?? DEFAULT_QWEN_MODEL;

  if (!apiKey) {
    return {
      status: 501,
      body: {
        error: "Qwen is not configured yet. Add BITGET_QWEN_API_KEY on the server to enable AI review.",
      },
    };
  }

  try {
    const qwenResponse = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: createPrompt(body),
        max_output_tokens: 500,
        text: {
          format: {
            type: "json_object",
          },
        },
      }),
    });

    const payload = await qwenResponse.json();

    if (!qwenResponse.ok) {
      return {
        status: qwenResponse.status,
        body: {
          error: payload.error?.message ?? "Qwen review failed",
        },
      };
    }

    return {
      status: 200,
      body: {
        review: parseReview(payload),
        model,
      },
    };
  } catch (error) {
    return {
      status: 502,
      body: {
        error: error instanceof Error ? error.message : "Unable to reach Qwen",
      },
    };
  }
}
