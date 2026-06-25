import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { createAiParse } from "./api/_ai-parse-core";
import { createAiReview } from "./api/_ai-review-core";
import { createAiOutcomeReview } from "./api/_ai-outcome-core";

async function readJsonBody(request: any) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (!chunks.length) return {};

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [
      react(),
      {
        name: "tradelens-local-api",
        configureServer(server) {
          server.middlewares.use("/api/ai-parse", async (request: any, response: any) => {
            if (request.method !== "POST") {
              response.statusCode = 405;
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ error: "Method not allowed" }));
              return;
            }

            try {
              const body = await readJsonBody(request);
              const result = await createAiParse(body.rawSignal, env);
              response.statusCode = result.status;
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify(result.body));
            } catch (error) {
              response.statusCode = 400;
              response.setHeader("Content-Type", "application/json");
              response.end(
                JSON.stringify({
                  error: error instanceof Error ? error.message : "Invalid request body",
                }),
              );
            }
          });

          server.middlewares.use("/api/ai-review", async (request: any, response: any) => {
            if (request.method !== "POST") {
              response.statusCode = 405;
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ error: "Method not allowed" }));
              return;
            }

            try {
              const body = await readJsonBody(request);
              const result = await createAiReview(body, env);
              response.statusCode = result.status;
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify(result.body));
            } catch (error) {
              response.statusCode = 400;
              response.setHeader("Content-Type", "application/json");
              response.end(
                JSON.stringify({
                  error: error instanceof Error ? error.message : "Invalid request body",
                }),
              );
            }
          });

          server.middlewares.use("/api/ai-outcome", async (request: any, response: any) => {
            if (request.method !== "POST") {
              response.statusCode = 405;
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify({ error: "Method not allowed" }));
              return;
            }

            try {
              const body = await readJsonBody(request);
              const result = await createAiOutcomeReview(body, env);
              response.statusCode = result.status;
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify(result.body));
            } catch (error) {
              response.statusCode = 400;
              response.setHeader("Content-Type", "application/json");
              response.end(
                JSON.stringify({
                  error: error instanceof Error ? error.message : "Invalid request body",
                }),
              );
            }
          });

        },
      },
    ],
  };
});
