import { createFileRoute } from "@tanstack/react-router";

const ORCAROUTER_URL = "https://api.orcarouter.ai/v1/chat/completions";
const MODEL = "tencent/hy4-preview-free";

type ChatMessage = {
  role: string;
  content: unknown;
};

function jsonError(message: string, status: number) {
  return Response.json({ error: { message } }, { status });
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env["ORCAROUTER_API_KEY"];
        if (!apiKey) {
          return jsonError("Az ORCAROUTER_API_KEY nincs beállítva.", 500);
        }

        let body: { messages?: ChatMessage[]; stream?: boolean };
        try {
          body = await request.json();
        } catch {
          return jsonError("Érvénytelen kérés.", 400);
        }

        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          return jsonError("Hiányzó üzenetek.", 400);
        }

        const messages = body.messages
          .filter(
            (m) =>
              m &&
              typeof m.role === "string" &&
              ["system", "user", "assistant"].includes(m.role),
          )
          .slice(-60);

        const wantsStream = body.stream !== false;

        let upstream: Response;
        try {
          upstream = await fetch(ORCAROUTER_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: MODEL,
              messages,
              stream: wantsStream,
            }),
          });
        } catch {
          return jsonError("Nem sikerült csatlakozni a modellhez.", 502);
        }

        if (!upstream.ok) {
          const detail = await upstream.text().catch(() => "");
          let message = "A modell nem válaszolt.";
          try {
            const parsed = JSON.parse(detail);
            if (parsed?.error?.message) message = parsed.error.message;
          } catch {
            if (detail) message = detail.slice(0, 300);
          }
          return jsonError(message, upstream.status);
        }

        if (wantsStream && upstream.body) {
          return new Response(upstream.body, {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
            },
          });
        }

        const result = await upstream.json();
        return Response.json(result);
      },
    },
  },
});
