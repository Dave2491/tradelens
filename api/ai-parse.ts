import { createAiParse } from "./_ai-parse-core";

type VercelRequest = {
  method?: string;
  body?: {
    rawSignal?: string;
  };
};

type VercelResponse = {
  status: (code: number) => VercelResponse;
  json: (body: unknown) => void;
};

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method && request.method !== "POST") {
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rawSignal = request.body?.rawSignal;

  if (!rawSignal || typeof rawSignal !== "string") {
    response.status(400).json({ error: "rawSignal is required" });
    return;
  }

  const result = await createAiParse(rawSignal, process.env);
  response.status(result.status).json(result.body);
}
