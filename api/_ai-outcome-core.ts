type OutcomeReview = {
  headline: string;
  summary: string;
  lesson: string;
  nextAction: string;
};

type OutcomeBody = {
  trade?: unknown;
  counterpart?: unknown;
};

type OutcomeEnv = {
  BITGET_QWEN_API_KEY?: string;
  QWEN_BASE_URL?: string;
  QWEN_MODEL?: string;
  QWEN_OUTCOME_MODEL?: string;
};

const DEFAULT_QWEN_BASE_URL = "https://hackathon.bitgetops.com/v1";
const DEFAULT_QWEN_MODEL = "qwen3.6-plus";

const FALLBACK_REVIEW: OutcomeReview = {
  headline: "Outcome recorded",
  summary: "TradeLens recorded the paper outcome, but the AI review could not be structured.",
  lesson: "Judge the setup by whether its risk rules were followed, not by profit alone.",
  nextAction: "Review the entry, stop placement, and outcome before considering another setup.",
};

function createPrompt(body: OutcomeBody) {
  return [
    "You are TradeLens, a crypto paper-trade outcome coach.",
    "Review the completed or invalidated paper trade without hindsight bias and without promising profit.",
    "Explain whether the plan followed disciplined risk structure. A losing trade can still be well-managed; a winning trade can still be reckless.",
    "This is simulated evidence. Refer to paper balance and paper risk, not verified real-account risk.",
    "When a counterpart plan is supplied, compare original and safer plans using status, realized or open PnL, entry, stop, target, and quantity.",
    "Return only valid JSON with this exact shape:",
    '{"headline":"string","summary":"string","lesson":"string","nextAction":"string"}',
    "Keep every field concise and understandable to a new trader.",
    "",
    `Completed trade: ${JSON.stringify(body.trade ?? null)}`,
    `Counterpart plan: ${JSON.stringify(body.counterpart ?? null)}`,
  ].join("\n");
}

function extractText(payload: any): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  if (typeof payload.text === "string") return payload.text;

  const content = payload.output?.flatMap((item: any) => item.content ?? []) ?? [];
  const textPart = content.find((item: any) => typeof item.text === "string");
  if (textPart?.text) return textPart.text;

  const messagePart = content.find((item: any) => typeof item.content === "string");
  return messagePart?.content ?? "";
}

function normalizeReview(value: unknown): OutcomeReview {
  if (!value || typeof value !== "object") return FALLBACK_REVIEW;
  const candidate = value as Partial<OutcomeReview>;

  return {
    headline: typeof candidate.headline === "string" ? candidate.headline : FALLBACK_REVIEW.headline,
    summary: typeof candidate.summary === "string" ? candidate.summary : FALLBACK_REVIEW.summary,
    lesson: typeof candidate.lesson === "string" ? candidate.lesson : FALLBACK_REVIEW.lesson,
    nextAction: typeof candidate.nextAction === "string" ? candidate.nextAction : FALLBACK_REVIEW.nextAction,
  };
}

function parseReview(payload: unknown) {
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

export async function createAiOutcomeReview(body: OutcomeBody, env: OutcomeEnv) {
  const apiKey = env.BITGET_QWEN_API_KEY;
  const baseUrl = env.QWEN_BASE_URL ?? DEFAULT_QWEN_BASE_URL;
  const model = env.QWEN_OUTCOME_MODEL ?? env.QWEN_MODEL ?? DEFAULT_QWEN_MODEL;

  if (!apiKey) {
    return { status: 501, body: { error: "Qwen is not configured for outcome reviews." } };
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
        text: { format: { type: "json_object" } },
      }),
    });

    const payload = await qwenResponse.json();
    if (!qwenResponse.ok) {
      return {
        status: qwenResponse.status,
        body: { error: payload.error?.message ?? "Qwen outcome review failed" },
      };
    }

    return { status: 200, body: { review: parseReview(payload), model } };
  } catch (error) {
    return {
      status: 502,
      body: { error: error instanceof Error ? error.message : "Unable to reach Qwen" },
    };
  }
}
