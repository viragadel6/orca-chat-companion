import { createFileRoute } from "@tanstack/react-router";

const ORCAROUTER_URL = "https://api.orcarouter.ai/v1/chat/completions";
const MODEL = "tencent/hy4-preview-free";
const INSTAVM_URL = "https://api.instavm.io";
const MAX_STEPS = 8;

type ChatMessage = {
  role: string;
  content: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

const TOOLS = [
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a bash shell command in a sandboxed Linux VM. Files and state persist between calls within one chat request. Returns stdout/stderr.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "Bash command to execute" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_datetime",
      description: "Get the current date and time. Optionally in a given IANA timezone (e.g. Europe/Budapest).",
      parameters: {
        type: "object",
        properties: { timezone: { type: "string", description: "IANA timezone, default Europe/Budapest" } },
      },
    },
  },
];

function jsonError(message: string, status: number) {
  return Response.json({ error: { message } }, { status });
}

function getDatetime(tz?: string) {
  const now = new Date();
  const timezone = tz || "Europe/Budapest";
  let local: string;
  try {
    local = new Intl.DateTimeFormat("hu-HU", {
      timeZone: timezone,
      dateStyle: "full",
      timeStyle: "long",
    }).format(now);
  } catch {
    return { error: `Ismeretlen időzóna: ${timezone}` };
  }
  return { iso_utc: now.toISOString(), unix: Math.floor(now.getTime() / 1000), timezone, local };
}

class Sandbox {
  private sessionId: string | null = null;
  constructor(private apiKey: string) {}

  private async start() {
    const res = await fetch(`${INSTAVM_URL}/v1/sessions/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": this.apiKey },
      body: JSON.stringify({ api_key: this.apiKey, vm_lifetime_seconds: 600 }),
    });
    const data = (await res.json().catch(() => ({}))) as { session_id?: string };
    if (!res.ok || !data.session_id) throw new Error(`Sandbox indítása sikertelen (${res.status})`);
    this.sessionId = data.session_id;
  }

  async run(command: string) {
    if (!this.sessionId) await this.start();
    const res = await fetch(`${INSTAVM_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": this.apiKey },
      body: JSON.stringify({ command, language: "bash", session_id: this.sessionId, timeout: 120 }),
    });
    const text = await res.text();
    if (!res.ok) return { error: `HTTP ${res.status}: ${text.slice(0, 2000)}` };
    try {
      return JSON.parse(text);
    } catch {
      return { output: text.slice(0, 8000) };
    }
  }
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env["ORCAROUTER_API_KEY"];
        if (!apiKey) return jsonError("Az ORCAROUTER_API_KEY nincs beállítva.", 500);
        const instaKey = process.env["INSTAVM_API_KEY"];

        let body: { messages?: ChatMessage[] };
        try {
          body = await request.json();
        } catch {
          return jsonError("Érvénytelen kérés.", 400);
        }
        if (!Array.isArray(body.messages) || body.messages.length === 0) {
          return jsonError("Hiányzó üzenetek.", 400);
        }

        const messages: ChatMessage[] = body.messages
          .filter((m) => m && typeof m.role === "string" && ["system", "user", "assistant"].includes(m.role))
          .map((m) => ({ role: m.role, content: m.content }))
          .slice(-60);

        const tools = instaKey ? TOOLS : TOOLS.filter((t) => t.function.name !== "run_shell");
        const sandbox = instaKey ? new Sandbox(instaKey) : null;

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (obj: unknown) =>
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            try {
              for (let step = 0; step < MAX_STEPS; step++) {
                const upstream = await fetch(ORCAROUTER_URL, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
                  body: JSON.stringify({ model: MODEL, messages, tools, stream: false }),
                });
                if (!upstream.ok) {
                  const detail = await upstream.text().catch(() => "");
                  let message = "A modell nem válaszolt.";
                  try {
                    message = JSON.parse(detail)?.error?.message || message;
                  } catch {
                    if (detail) message = detail.slice(0, 300);
                  }
                  send({ type: "error", message });
                  break;
                }
                const result = await upstream.json();
                const msg = result?.choices?.[0]?.message ?? {};
                const reasoning = msg.reasoning_content ?? msg.reasoning;
                if (typeof reasoning === "string" && reasoning) send({ type: "delta", reasoning_content: reasoning });

                const calls: ToolCall[] = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
                if (calls.length === 0) {
                  send({ type: "delta", content: typeof msg.content === "string" ? msg.content : "" });
                  send({ type: "done" });
                  break;
                }

                messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
                for (const call of calls) {
                  const name = call.function?.name;
                  send({ type: "agent_event", event: { type: "tool_start", tool: name } });
                  let args: Record<string, unknown> = {};
                  try {
                    args = JSON.parse(call.function?.arguments || "{}");
                  } catch {}
                  let output: unknown;
                  try {
                    if (name === "get_datetime") output = getDatetime(args.timezone as string | undefined);
                    else if (name === "run_shell" && sandbox) output = await sandbox.run(String(args.command ?? ""));
                    else output = { error: `Ismeretlen eszköz: ${name}` };
                  } catch (e) {
                    output = { error: e instanceof Error ? e.message : String(e) };
                  }
                  send({ type: "agent_event", event: { type: "tool_result", tool: name } });
                  messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    content: JSON.stringify(output).slice(0, 12000),
                  });
                }
                if (step === MAX_STEPS - 1) {
                  send({ type: "delta", content: "_(Elértem a lépésszám-korlátot.)_" });
                  send({ type: "done" });
                }
              }
            } catch (e) {
              send({ type: "error", message: e instanceof Error ? e.message : "Hiba történt." });
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
          },
        });
      },
    },
  },
});
