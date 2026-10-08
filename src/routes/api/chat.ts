import { createFileRoute } from "@tanstack/react-router";
import { readSseData } from "@/lib/chat-stream";

const ORCAROUTER_URL = "https://api.orcarouter.ai/v1/chat/completions";
const MODEL = "tencent/hy4-preview-free";
const INSTAVM_URL = "https://api.instavm.io";
const MAX_STEPS = 8;

type ChatMessage = {
  role: string;
  content: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
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
      description:
        "Get the current date and time. Optionally in a given IANA timezone (e.g. Europe/Budapest).",
      parameters: {
        type: "object",
        properties: {
          timezone: { type: "string", description: "IANA timezone, default Europe/Budapest" },
        },
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
  constructor(
    private apiKey: string,
    private signal: AbortSignal,
  ) {}

  private async start() {
    const res = await fetch(`${INSTAVM_URL}/v1/sessions/session`, {
      method: "POST",
      signal: this.signal,
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
      signal: this.signal,
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
          .filter(
            (m) =>
              m && typeof m.role === "string" && ["system", "user", "assistant"].includes(m.role),
          )
          .map((m) => ({ role: m.role, content: m.content }))
          .slice(-60);

        const tools = instaKey ? TOOLS : TOOLS.filter((t) => t.function.name !== "run_shell");
        const abort = new AbortController();
        const onAbort = () => abort.abort();
        request.signal.addEventListener("abort", onAbort, { once: true });
        if (request.signal.aborted) abort.abort();
        const sandbox = instaKey ? new Sandbox(instaKey, abort.signal) : null;

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (obj: unknown) => {
              if (!abort.signal.aborted)
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            };
            try {
              for (let step = 0; step < MAX_STEPS; step++) {
                if (abort.signal.aborted) break;
                const upstream = await fetch(ORCAROUTER_URL, {
                  method: "POST",
                  signal: abort.signal,
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                  },
                  body: JSON.stringify({ model: MODEL, messages, tools, stream: true }),
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
                if (!upstream.body) throw new Error("A modell nem küldött streamet.");
                let content = "";
                let reasoning = "";
                let finished = false;
                const callParts = new Map<number, ToolCall>();
                for await (const data of readSseData(upstream.body)) {
                  if (data === "[DONE]") {
                    finished = true;
                    break;
                  }
                  const chunk = JSON.parse(data);
                  if (chunk.error)
                    throw new Error(chunk.error.message || "A modell streamelése megszakadt.");
                  const choice = chunk.choices?.[0];
                  const delta = choice?.delta;
                  if (choice?.finish_reason) finished = true;
                  if (!delta) continue;
                  const thought = delta.reasoning_content ?? delta.reasoning;
                  if (typeof thought === "string" && thought) {
                    reasoning += thought;
                    send({ type: "delta", reasoning_content: thought });
                  }
                  if (typeof delta.content === "string" && delta.content) {
                    content += delta.content;
                    send({ type: "delta", content: delta.content });
                  }
                  for (const part of delta.tool_calls ?? []) {
                    const index = part.index ?? 0;
                    const call = callParts.get(index) ?? {
                      id: "",
                      type: "function" as const,
                      function: { name: "", arguments: "" },
                    };
                    if (part.id) call.id = part.id;
                    if (part.function?.name) call.function.name += part.function.name;
                    if (part.function?.arguments)
                      call.function.arguments += part.function.arguments;
                    callParts.set(index, call);
                  }
                }
                if (abort.signal.aborted) break;
                if (!finished) throw new Error("A modell streamelése idő előtt megszakadt.");
                const calls = [...callParts.entries()]
                  .sort(([a], [b]) => a - b)
                  .map(([, call]) => call);
                if (calls.length === 0) {
                  send({ type: "done" });
                  break;
                }

                messages.push({
                  role: "assistant",
                  content,
                  reasoning_content: reasoning,
                  tool_calls: calls,
                });
                for (const call of calls) {
                  if (abort.signal.aborted) break;
                  if (!call.id || !call.function.name)
                    throw new Error("Hiányos eszközhívás érkezett.");
                  const name = call.function?.name;
                  send({
                    type: "agent_event",
                    event: {
                      type: "tool_start",
                      tool: name,
                      call_id: call.id,
                      input: call.function.arguments,
                    },
                  });
                  let args: Record<string, unknown> = {};
                  try {
                    args = JSON.parse(call.function?.arguments || "{}");
                  } catch {
                    // Invalid arguments are handled as a failed tool invocation below.
                  }
                  let output: unknown;
                  try {
                    if (name === "get_datetime")
                      output = getDatetime(args["timezone"] as string | undefined);
                    else if (name === "run_shell" && sandbox)
                      output = await sandbox.run(String(args["command"] ?? ""));
                    else output = { error: `Ismeretlen eszköz: ${name}` };
                  } catch (e) {
                    output = { error: e instanceof Error ? e.message : String(e) };
                  }
                  const serializedOutput = JSON.stringify(output).slice(0, 12000);
                  const failed = typeof output === "object" && output !== null && "error" in output;
                  send({
                    type: "agent_event",
                    event: {
                      type: "tool_result",
                      tool: name,
                      call_id: call.id,
                      output: serializedOutput,
                      status: failed ? "error" : "completed",
                    },
                  });
                  messages.push({
                    role: "tool",
                    tool_call_id: call.id,
                    content: serializedOutput,
                  });
                }
                if (step === MAX_STEPS - 1) {
                  send({ type: "delta", content: "_(Elértem a lépésszám-korlátot.)_" });
                  send({ type: "done" });
                }
              }
            } catch (e) {
              send({ type: "error", message: e instanceof Error ? e.message : "Hiba történt." });
            } finally {
              request.signal.removeEventListener("abort", onAbort);
              if (!abort.signal.aborted) {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              }
            }
          },
          cancel() {
            abort.abort();
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
