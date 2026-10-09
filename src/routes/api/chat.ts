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

const shellProp = (description: string) => ({ type: "string", description });

const TOOLS = [
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Run a bash command in a persistent sandboxed Debian Linux VM (sudo, internet access). Files, installed packages and state persist across calls in this chat request. Nix-installed binaries are on PATH automatically.",
      parameters: {
        type: "object",
        properties: {
          command: shellProp("Bash command to execute"),
          timeout: { type: "number", description: "Seconds, default 120, max 300" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_python",
      description: "Execute Python 3 code in the sandbox VM and return stdout/stderr.",
      parameters: {
        type: "object",
        properties: { code: shellProp("Python source code") },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "install_packages",
      description:
        "Instantly install any language, compiler, runtime or tool from nixpkgs (100k+ packages, e.g. rustc, cargo, go, nodejs_22, ruby, ghc, lua, zig, julia, ffmpeg, postgresql) with Nix into the sandbox. Afterwards use them via run_shell.",
      parameters: {
        type: "object",
        properties: {
          packages: {
            type: "array",
            items: { type: "string" },
            description: "nixpkgs attribute names, e.g. [\"go\", \"rustc\"]",
          },
        },
        required: ["packages"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a text file in the sandbox VM.",
      parameters: {
        type: "object",
        properties: { path: shellProp("Absolute or relative path"), content: shellProp("File content") },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the sandbox VM (first 20000 characters).",
      parameters: {
        type: "object",
        properties: { path: shellProp("File path") },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "expose_port",
      description:
        "Get a public HTTPS URL for a server listening on a port inside the sandbox VM (start the server in the background with run_shell first, binding 0.0.0.0).",
      parameters: {
        type: "object",
        properties: { port: { type: "number", description: "Port number" } },
        required: ["port"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse_url",
      description:
        "Open a web page in a real headless browser in the cloud and return its readable text content and links.",
      parameters: {
        type: "object",
        properties: { url: shellProp("Full URL to open") },
        required: ["url"],
      },
    },
  },
];

function jsonError(message: string, status: number) {
  return Response.json({ error: { message } }, { status });
}

function systemPrompt() {
  const now = new Date();
  const fmt = (timeZone: string) =>
    new Intl.DateTimeFormat("hu-HU", { timeZone, dateStyle: "full", timeStyle: "long" }).format(now);
  return [
    `Aktuális időpont: ${fmt("Europe/Budapest")} (Europe/Budapest). UTC: ${now.toISOString()}. Unix: ${Math.floor(now.getTime() / 1000)}.`,
    "Ezt az időt tekintsd pontosnak; ne kérdezd le eszközzel.",
    "Rendelkezésedre áll egy izolált Linux VM (InstaVM) eszközökön keresztül: shell, Python, fájlírás/olvasás, Nix-alapú csomagtelepítés bármely nyelvhez, porttovábbítás nyilvános URL-re és valódi böngésző. Ha kód futtatása vagy ellenőrzése segít, használd őket.",
  ].join("\n");
}

const NIX_BOOTSTRAP = `if [ ! -e "$HOME/.nix-profile/etc/profile.d/nix.sh" ]; then sudo install -d -m755 -o $(id -u) -g $(id -g) /nix && curl -sSfL https://nixos.org/nix/install -o /tmp/nix-install.sh && sh /tmp/nix-install.sh --no-daemon >/tmp/nix-install.log 2>&1 || { tail -20 /tmp/nix-install.log; exit 1; }; fi; . "$HOME/.nix-profile/etc/profile.d/nix.sh"`;
const NIX_PATH_PREFIX = `[ -e "$HOME/.nix-profile/etc/profile.d/nix.sh" ] && . "$HOME/.nix-profile/etc/profile.d/nix.sh"; export PATH=$HOME/.nix-profile/bin:$PATH; `;

function b64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

class Sandbox {
  private sessionId: string | null = null;
  private browserId: string | null = null;
  constructor(
    private apiKey: string,
    private signal: AbortSignal,
  ) {}

  private async api(path: string, body?: unknown, method = "POST") {
    const res = await fetch(`${INSTAVM_URL}${path}`, {
      method,
      signal: this.signal,
      headers: { "Content-Type": "application/json", "X-API-Key": this.apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`InstaVM HTTP ${res.status}: ${text.slice(0, 1000)}`);
    try {
      return JSON.parse(text);
    } catch {
      return { output: text.slice(0, 8000) };
    }
  }

  private async session() {
    if (!this.sessionId) {
      const data = await this.api("/v1/sessions/session", {
        api_key: this.apiKey,
        vm_lifetime_seconds: 900,
      });
      if (!data.session_id) throw new Error("Sandbox indítása sikertelen");
      this.sessionId = data.session_id as string;
    }
    return this.sessionId;
  }

  async exec(command: string, language: "bash" | "python" = "bash", timeout = 120) {
    const session_id = await this.session();
    const t = Math.min(Math.max(timeout, 5), 300);
    return this.api("/execute", {
      command: language === "bash" ? NIX_PATH_PREFIX + command : command,
      language,
      session_id,
      timeout: t,
    });
  }

  install(packages: string[]) {
    const clean = packages.filter((p) => /^[A-Za-z0-9_.+-]+$/.test(p));
    if (clean.length === 0) return Promise.resolve({ error: "Nincs érvényes csomagnév." });
    const refs = clean.map((p) => `nixpkgs#${p}`).join(" ");
    return this.exec(
      `${NIX_BOOTSTRAP}; nix --extra-experimental-features 'nix-command flakes' profile add ${refs} 2>&1 | tail -15 && echo "Telepítve: ${clean.join(", ")}"`,
      "bash",
      300,
    );
  }

  writeFile(path: string, content: string) {
    return this.exec(
      `mkdir -p "$(dirname ${q(path)})" && echo ${q(b64(content))} | base64 -d > ${q(path)} && wc -c ${q(path)}`,
    );
  }

  readFile(path: string) {
    return this.exec(`head -c 20000 ${q(path)}`);
  }

  async exposePort(port: number) {
    const sid = await this.session();
    return this.api(`/v1/sessions/app-url/${encodeURIComponent(sid)}?port=${Math.floor(port)}`, undefined, "GET");
  }

  async browse(url: string) {
    if (!this.browserId) {
      const s = await this.api("/v1/browser/sessions/", { viewport_width: 1280, viewport_height: 900 });
      if (!s.session_id) throw new Error("Böngésző indítása sikertelen");
      this.browserId = s.session_id as string;
    }
    await this.api("/v1/browser/interactions/navigate", {
      url,
      wait_timeout: 30000,
      session_id: this.browserId,
    });
    return this.api("/v1/browser/interactions/content", {
      session_id: this.browserId,
      include_interactive: false,
      include_anchors: true,
      max_anchors: 30,
    });
  }

  async close() {
    if (this.browserId)
      await this.api(`/v1/browser/sessions/${encodeURIComponent(this.browserId)}`, undefined, "DELETE").catch(
        () => undefined,
      );
  }
}

async function runTool(sandbox: Sandbox | null, name: string, args: Record<string, unknown>) {
  if (!sandbox) return { error: "A sandbox nincs beállítva." };
  const str = (k: string) => String(args[k] ?? "");
  switch (name) {
    case "run_shell":
      return sandbox.exec(str("command"), "bash", Number(args["timeout"]) || 120);
    case "run_python":
      return sandbox.exec(str("code"), "python");
    case "install_packages":
      return sandbox.install(Array.isArray(args["packages"]) ? args["packages"].map(String) : []);
    case "write_file":
      return sandbox.writeFile(str("path"), str("content"));
    case "read_file":
      return sandbox.readFile(str("path"));
    case "expose_port":
      return sandbox.exposePort(Number(args["port"]));
    case "browse_url":
      return sandbox.browse(str("url"));
    default:
      return { error: `Ismeretlen eszköz: ${name}` };
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
        messages.unshift({ role: "system", content: systemPrompt() });

        const tools = instaKey ? TOOLS : undefined;
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
                  body: JSON.stringify({ model: MODEL, messages, ...(tools ? { tools } : {}), stream: true }),
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
                    output = await runTool(sandbox, name, args);
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
              await sandbox?.close();
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
