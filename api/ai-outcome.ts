import { createAiOutcomeReview } from "./_ai-outcome-core";

type VercelRequest = {
  method?: string;
  body?: {
    trade?: unknown;
    counterpart?: unknown;
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

  if (!request.body?.trade) {
    response.status(400).json({ error: "trade is required" });
    return;
  }

  const result = await createAiOutcomeReview(request.body, process.env);
  response.status(result.status).json(result.body);
}
