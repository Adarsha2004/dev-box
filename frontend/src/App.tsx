import "./index.css";
import { useEffect, useMemo, useRef, useState } from "react";

const API = ((import.meta as { env?: { API_URL?: string } }).env?.API_URL) ?? "http://localhost:3000";
const WS = ((import.meta as { env?: { WS_URL?: string } }).env?.WS_URL) ?? "ws://localhost:8080";

type ToolEntry = {
  id: string;
  name: string;
  args: string;
  result?: string;
  isError?: boolean;
  done: boolean;
};

type AgentTrace = {
  agentId: string;
  depth: number;
  text: string;
  tools: ToolEntry[];
  turns: number;
};

type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

type WireEvent = {
  type: string;
  agentId?: string;
  depth?: number;
  delta?: string;
  call?: { id: string; name: string; arguments: Record<string, unknown> };
  result?: string;
  isError?: boolean;
  message?: { usage?: { input: number; output: number }; stopReason?: string };
  summary?: string;
  error?: string;
  branch?: string;
};

export function App() {
  const [repo, setRepo] = useState("");
  const [pat, setPat] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connError, setConnError] = useState("");

  const [sessionId, setSessionId] = useState<number | null>(null);
  const [repoId, setRepoId] = useState<number | null>(null);

  const [wsState, setWsState] = useState<"connecting" | "open" | "closed">("closed");
  const [running, setRunning] = useState(false);
  const [agents, setAgents] = useState<AgentTrace[]>([]);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pushChanges, setPushChanges] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const traceRef = useRef<HTMLDivElement>(null);
  const [wsAttempt, setWsAttempt] = useState(0);

  useEffect(() => {
    if (traceRef.current) traceRef.current.scrollTop = traceRef.current.scrollHeight;
  }, [agents, chat]);

  useEffect(() => {
    if (!sessionId) return;
    let closed = false;
    const ws = new WebSocket(`${WS}/ws?sessionId=${sessionId}`);
    wsRef.current = ws;
    setWsState("connecting");
    ws.onopen = () => setWsState("open");
    ws.onclose = () => {
      setWsState("closed");
      if (!closed) setTimeout(() => setWsAttempt((a) => a + 1), 1500); // reconnect
    };
    ws.onmessage = (m) => handleEvent(JSON.parse(String(m.data)) as WireEvent);
    return () => {
      closed = true;
      ws.close();
    };
  }, [sessionId, wsAttempt]);

  // load the persisted conversation when a session opens
  useEffect(() => {
    if (!sessionId || !repoId) return;
    fetch(`${API}/api/repos/${repoId}/sessions/${sessionId}/messages`)
      .then((r) => r.json())
      .then((b: { messages?: { role: string; content: string }[] }) =>
        setChat((b.messages ?? []).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }))),
      )
      .catch(() => {});
  }, [sessionId, repoId]);

  function handleEvent(e: WireEvent) {
    if (e.type === "connected") return;
    if (e.type === "done") {
      setRunning(false);
      setChat((c) => [...c, { role: "assistant", content: e.summary ?? "" }]);
      return;
    }
    if (e.type === "pushing") {
      setChat((c) => [...c, { role: "system", content: "pushing branch…" }]);
      return;
    }
    if (e.type === "pushed") {
      setChat((c) => [...c, { role: "system", content: `pushed ${e.branch}` }]);
      return;
    }
    if (e.type === "push_failed") {
      setChat((c) => [...c, { role: "system", content: `push failed: ${e.error}` }]);
      return;
    }
    if (e.type === "error") {
      setRunning(false);
      setAgents((a) => [...a, { agentId: "error", depth: 0, text: e.error ?? "unknown error", tools: [], turns: 0 }]);
      return;
    }

    setAgents((list) => {
      const next = [...list];
      const agentId = e.agentId ?? "?";
      let idx = next.findIndex((a) => a.agentId === agentId);
      if (idx === -1) {
        next.push({ agentId, depth: e.depth ?? 0, text: "", tools: [], turns: 0 });
        idx = next.length - 1;
      }
      const agent = { ...next[idx]!, tools: [...next[idx]!.tools] };

      if (e.type === "text") agent.text += e.delta ?? "";
      else if (e.type === "tool_start")
        agent.tools.push({
          id: e.call?.id ?? String(agent.tools.length),
          name: e.call?.name ?? "?",
          args: JSON.stringify(e.call?.arguments ?? {}),
          done: false,
        });
      else if (e.type === "tool_end") {
        const t = agent.tools.find((t) => !t.done && t.id === e.call?.id);
        if (t) {
          t.result = e.result ?? "";
          t.isError = e.isError;
          t.done = true;
        }
      } else if (e.type === "turn_end") agent.turns += 1;

      next[idx] = agent;
      return next;
    });
  }

  async function connect() {
    setConnecting(true);
    setConnError("");
    try {
      let r = await fetch(`${API}/api/repos`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo, pat }),
      });
      const body = (await r.json()) as { repo?: { id: number }; error?: string };
      if (!r.ok || !body.repo) throw new Error(body.error ?? `register failed (${r.status})`);

      r = await fetch(`${API}/api/repos/${body.repo.id}/sessions`, { method: "POST" });
      const s = (await r.json()) as { sessionId?: number; error?: string };
      if (!r.ok) throw new Error(s.error ?? `session failed (${r.status})`);

      setRepoId(body.repo.id);
      setSessionId(s.sessionId!);
      setAgents([]);
      setChat([]);
    } catch (e) {
      setConnError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }

  async function send() {
    if (!input.trim() || !repoId || !sessionId) return;
    const content = input.trim();
    setInput("");
    setChat((c) => [...c, { role: "user", content }]);
    setAgents([]);
    setRunning(true);
    const r = await fetch(`${API}/api/repos/${repoId}/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, role: "user", push: pushChanges }),
    });
    if (r.status === 201) setRunning(false); // brain didn't kick in (no sandbox)
  }

  const status = useMemo(() => {
    if (!sessionId) return "offline";
    if (wsState !== "open") return `ws ${wsState}`;
    return running ? "agents running" : "idle";
  }, [sessionId, wsState, running]);

  if (!sessionId) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-8">
        <h1 className="text-2xl font-semibold text-zinc-100">dev-box control plane</h1>
        <p className="text-sm text-zinc-400">Connect a GitHub repo to start a session</p>
        <input
          className="rounded bg-zinc-900 p-2 text-zinc-100 outline-none ring-1 ring-zinc-700 focus:ring-zinc-500"
          placeholder="owner/repo"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
        />
        <input
          className="rounded bg-zinc-900 p-2 text-zinc-100 outline-none ring-1 ring-zinc-700 focus:ring-zinc-500"
          placeholder="GitHub PAT"
          type="password"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
        />
        <button
          className="rounded bg-zinc-100 p-2 font-medium text-zinc-900 disabled:opacity-50"
          disabled={!repo || !pat || connecting}
          onClick={connect}
        >
          {connecting ? "creating sandbox…" : "connect"}
        </button>
        {connError && <p className="text-sm text-red-400">{connError}</p>}
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-zinc-950 text-zinc-200">
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2 text-sm">
        <span className="font-semibold text-zinc-100">dev-box · session {sessionId}</span>
        <span className={running ? "text-emerald-400" : wsState === "open" ? "text-zinc-500" : "text-amber-400"}>
          ● {status}
        </span>
      </header>

      <div ref={traceRef} className="flex-1 space-y-6 overflow-y-auto p-4">
        {chat.map((m, i) => (
          <div
            key={`c${i}`}
            className={
              m.role === "user"
                ? "text-zinc-400"
                : m.role === "system"
                  ? "font-mono text-xs text-sky-400"
                  : "font-mono text-sm whitespace-pre-wrap text-zinc-100"
            }
          >
            {m.role === "user" ? `> ${m.content}` : m.content}
          </div>
        ))}

        {agents.map((a) => (
          <AgentCard key={a.agentId} agent={a} />
        ))}
      </div>

      <div className="flex items-center gap-3 border-t border-zinc-800 p-4">
        <input
          className="flex-1 rounded bg-zinc-900 p-2 outline-none ring-1 ring-zinc-700 focus:ring-zinc-500"
          placeholder="task…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <label className="flex items-center gap-1.5 text-xs text-zinc-400">
          <input type="checkbox" checked={pushChanges} onChange={(e) => setPushChanges(e.target.checked)} />
          push branch
        </label>
        <button
          className="rounded bg-zinc-100 p-2 px-4 font-medium text-zinc-900 disabled:opacity-50"
          disabled={!input.trim() || running}
          onClick={send}
        >
          run
        </button>
      </div>
    </div>
  );
}

function AgentCard({ agent }: { agent: AgentTrace }) {
  const isPrimary = agent.depth === 0;
  const pending = agent.tools.filter((t) => !t.done).length;
  return (
    <div
      className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
      style={{ marginLeft: agent.depth * 24 }}
    >
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span
          className={`rounded px-1.5 py-0.5 font-mono ${
            isPrimary ? "bg-sky-900 text-sky-300" : "bg-violet-900 text-violet-300"
          }`}
        >
          {agent.agentId}
        </span>
        <span className="text-zinc-500">
          {agent.turns} turn{agent.turns === 1 ? "" : "s"} · {agent.tools.length} tools
          {pending ? ` · ${pending} running` : ""}
        </span>
      </div>

      {agent.text && <div className="whitespace-pre-wrap font-mono text-xs text-zinc-300">{agent.text}</div>}

      <div className="mt-2 space-y-1">
        {agent.tools.map((t) => (
          <details key={t.id} className="rounded bg-zinc-950/60 font-mono text-xs">
            <summary className="cursor-pointer px-2 py-1">
              <span className={t.isError ? "text-red-400" : "text-emerald-400"}>$</span>{" "}
              <span className="text-zinc-300">{t.name}</span>{" "}
              <span className="text-zinc-500">{t.args.slice(0, 100)}</span>
              {!t.done && <span className="ml-2 animate-pulse text-amber-400">running…</span>}
            </summary>
            {t.result && <ResultView result={t.result} />}
          </details>
        ))}
      </div>
    </div>
  );
}

function ResultView({ result }: { result: string }) {
  const diffIdx = result.indexOf("<diff>");
  if (diffIdx === -1)
    return (
      <pre className="max-h-64 overflow-auto border-t border-zinc-800 px-2 py-1 text-zinc-400">{result}</pre>
    );

  const before = result.slice(0, diffIdx);
  const diff = result.slice(diffIdx + 6, result.indexOf("</diff>"));
  return (
    <div className="border-t border-zinc-800">
      {before && <pre className="px-2 py-1 text-zinc-400">{before}</pre>}
      <pre className="max-h-64 overflow-auto px-2 py-1 font-mono text-xs">
        {diff.split("\n").map((line, i) => (
          <div
            key={i}
            className={
              line.startsWith("+") && !line.startsWith("+++")
                ? "text-emerald-400"
                : line.startsWith("-") && !line.startsWith("---")
                  ? "text-red-400"
                  : "text-zinc-500"
            }
          >
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

export default App;
