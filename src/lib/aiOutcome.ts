import type { OutcomeReview, PaperTrade } from "./types";

type OutcomeReviewResponse = Omit<OutcomeReview, "generatedAt">;

export async function fetchAiOutcomeReview(trade: PaperTrade, counterpart?: PaperTrade): Promise<OutcomeReview> {
  const response = await fetch("/api/ai-outcome", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ trade, counterpart }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error ?? "AI outcome review is not available yet.");
  }

  const review = payload.review as OutcomeReviewResponse;
  return {
    ...review,
    generatedAt: new Date().toISOString(),
  };
}
