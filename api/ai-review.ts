import { createAiReview } from "./_ai-review-core";

type VercelRequest = {
  method?: string;
  body?: {
    signal?: unknown;
    market?: unknown;
    report?: unknown;
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

  const result = await createAiReview(request.body ?? {}, process.env);
  response.status(result.status).json(result.body);
}
