export type AiParsedSignal = {
  pair?: string;
  side?: "long" | "short";
  entry?: number;
  entryMode?: "exact" | "current" | "range" | "wait";
  stopLoss?: number;
  takeProfits: number[];
  leverage?: number;
  timeframe?: "5m" | "15m" | "30m" | "1H" | "4H" | "1D";
  confidence: number;
  missingInfo: string[];
  notes: string;
};

type ParseEnv = {
  BITGET_QWEN_API_KEY?: string;
  QWEN_BASE_URL?: string;
  QWEN_MODEL?: string;
  QWEN_PARSE_MODEL?: string;
};

const DEFAULT_QWEN_BASE_URL = "https://hackathon.bitgetops.com/v1";
const DEFAULT_QWEN_MODEL = "qwen3.6-flash";

function createPrompt(rawSignal: string) {
  return [
    "You are TradeLens, an AI parser for crypto trade signals.",
    "Extract a structured signal from messy trader text. Do not invent exact prices that are not present.",
    "If the user says current price, around here, market, or now, set entryMode to current and leave entry null.",
    "If the text lacks a required field, include it in missingInfo.",
    "Return only valid JSON with this exact shape:",
    '{"pair":"BTCUSDT","side":"long","entry":63900,"entryMode":"exact","stopLoss":63480,"takeProfits":[64650],"leverage":5,"timeframe":"1H","confidence":0.8,"missingInfo":["string"],"notes":"string"}',
    "Use null for unknown numeric fields. pair should end in USDT when a common token like BTC, ETH, or SOL is mentioned.",
    "Normalize timeframe to one of 5m, 15m, 30m, 1H, 4H, or 1D. Use null when the signal does not provide one.",
    "",
    `Raw signal: ${rawSignal}`,
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

function numberOrUndefined(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function normalizePair(value: unknown) {
  if (typeof value !== "string") return undefined;
  const cleaned = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return undefined;
  if (cleaned.endsWith("USDT")) return cleaned;

  const aliases: Record<string, string> = {
    BTC: "BTCUSDT",
    ETH: "ETHUSDT",
    SOL: "SOLUSDT",
    BNB: "BNBUSDT",
    XRP: "XRPUSDT",
    DOGE: "DOGEUSDT",
  };

  return aliases[cleaned];
}

function normalizeTimeframe(value: unknown): AiParsedSignal["timeframe"] {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().toLowerCase();
  const aliases: Record<string, AiParsedSignal["timeframe"]> = {
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1h": "1H",
    "4h": "4H",
    "1d": "1D",
  };
  return aliases[cleaned];
}

function inferConfidence(candidate: Partial<AiParsedSignal>) {
  let confidence = Number(candidate.confidence);
  if (Number.isFinite(confidence) && confidence > 0) return Math.max(0, Math.min(1, confidence));

  confidence = 0;
  if (normalizePair(candidate.pair)) confidence += 0.25;
  if (candidate.side === "long" || candidate.side === "short") confidence += 0.2;
  if (numberOrUndefined(candidate.entry) || candidate.entryMode === "current") confidence += 0.2;
  if (numberOrUndefined(candidate.stopLoss)) confidence += 0.15;
  if (Array.isArray(candidate.takeProfits) && candidate.takeProfits.some(numberOrUndefined)) confidence += 0.15;
  if (numberOrUndefined(candidate.leverage)) confidence += 0.05;

  return Math.max(0, Math.min(0.95, confidence));
}

function normalizeParsedSignal(value: unknown): AiParsedSignal {
  const candidate = value && typeof value === "object" ? (value as Partial<AiParsedSignal>) : {};
  const side = candidate.side === "long" || candidate.side === "short" ? candidate.side : undefined;
  const entryMode =
    candidate.entryMode === "current" || candidate.entryMode === "range" || candidate.entryMode === "wait"
      ? candidate.entryMode
      : "exact";

  return {
    pair: normalizePair(candidate.pair),
    side,
    entry: numberOrUndefined(candidate.entry),
    entryMode,
    stopLoss: numberOrUndefined(candidate.stopLoss),
    takeProfits: Array.isArray(candidate.takeProfits)
      ? candidate.takeProfits.map(numberOrUndefined).filter((item): item is number => Boolean(item))
      : [],
    leverage: numberOrUndefined(candidate.leverage),
    timeframe: normalizeTimeframe(candidate.timeframe),
    confidence: inferConfidence(candidate),
    missingInfo: Array.isArray(candidate.missingInfo)
      ? candidate.missingInfo.filter((item): item is string => typeof item === "string").slice(0, 6)
      : [],
    notes: typeof candidate.notes === "string" ? candidate.notes : "",
  };
}

function parseJsonPayload(payload: unknown): AiParsedSignal {
  const text = extractText(payload);
  if (!text) return normalizeParsedSignal({});

  try {
    return normalizeParsedSignal(JSON.parse(text));
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return normalizeParsedSignal({});

    try {
      return normalizeParsedSignal(JSON.parse(jsonMatch[0]));
    } catch {
      return normalizeParsedSignal({});
    }
  }
}

export async function createAiParse(rawSignal: string, env: ParseEnv) {
  const apiKey = env.BITGET_QWEN_API_KEY;
  const baseUrl = env.QWEN_BASE_URL ?? DEFAULT_QWEN_BASE_URL;
  const model = env.QWEN_PARSE_MODEL ?? env.QWEN_MODEL ?? DEFAULT_QWEN_MODEL;

  if (!apiKey) {
    return {
      status: 501,
      body: {
        error: "Qwen is not configured yet. Add BITGET_QWEN_API_KEY on the server to enable AI parsing.",
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
        input: createPrompt(rawSignal),
        max_output_tokens: 300,
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
          error: payload.error?.message ?? "Qwen signal parsing failed",
        },
      };
    }

    return {
      status: 200,
      body: {
        parsed: parseJsonPayload(payload),
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
