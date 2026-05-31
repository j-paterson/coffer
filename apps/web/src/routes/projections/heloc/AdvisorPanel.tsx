import { useEffect, useRef, useState } from "react";
import type { ChatMessage, ProjectionRunResponse, Scenario } from "../../../../../../packages/shared/types";
import { useAdvisorModel } from "../../../lib/queries";

type Props = {
  scenario: Scenario;
  runResult: ProjectionRunResponse;
};

const STORAGE_KEY = "advisor:messages";

function loadStoredMessages(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is ChatMessage =>
        m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    );
  } catch {
    return [];
  }
}

function persistMessages(msgs: ChatMessage[]) {
  try {
    if (msgs.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(msgs));
  } catch {
    // Quota exceeded or storage disabled — silently skip; chat still works.
  }
}

export function AdvisorPanel({ scenario, runResult }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>(loadStoredMessages);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const modelQ = useAdvisorModel();
  const model = modelQ.data?.model ?? null;
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // DOM-sync effect: keep the chat log scrolled to the latest message.
  // Legitimate per react.dev — synchronizing with the DOM after render.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, streaming]);

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    let latest: ChatMessage[] = [
      ...messages,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ];
    setMessages(latest);
    setInput("");
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/advisor/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: latest.filter((m) => m.content),
          scenario,
          runResult,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "");
        latest = updateLast(latest, `(error ${res.status}: ${errText || "no response"})`);
        setMessages(latest);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        latest = appendToLast(latest, chunk);
        setMessages(latest);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        latest = updateLast(latest, `(error: ${(e as Error).message})`);
        setMessages(latest);
      }
    } finally {
      persistMessages(latest);
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function reset() {
    setMessages([]);
    persistMessages([]);
  }

  return (
    <div className="rounded-md border border-stone-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-semibold text-stone-900">Financial advisor</div>
        <div className="flex items-center gap-2 text-xs text-stone-500">
          {model && <span className="rounded bg-stone-100 px-2 py-0.5 font-mono">{model}</span>}
          {messages.length > 0 && (
            <button onClick={reset} className="rounded border border-stone-200 px-2 py-0.5 hover:bg-stone-50">Clear</button>
          )}
        </div>
      </div>
      <div ref={logRef} className="mb-3 h-72 overflow-y-auto rounded border border-stone-100 bg-stone-50 p-3 text-sm">
        {messages.length === 0 && (
          <div className="text-stone-400">
            Ask about your scenario — e.g. <em>"Is this break-even return realistic given my market assumptions?"</em> or <em>"What's my downside in the 10th percentile MC path?"</em>
          </div>
        )}
        {messages.map((m, i) => (
          <Bubble key={i} role={m.role} content={m.content} streaming={streaming && i === messages.length - 1 && m.role === "assistant"} />
        ))}
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask a question… (Enter to send, Shift+Enter for newline)"
          rows={2}
          className="flex-1 resize-none rounded border border-stone-200 px-2 py-1 text-sm focus:border-stone-400 focus:outline-none"
          disabled={streaming}
        />
        {streaming ? (
          <button onClick={stop} className="rounded border border-stone-300 bg-stone-50 px-3 py-1.5 text-sm hover:bg-stone-100">Stop</button>
        ) : (
          <button onClick={send} disabled={!input.trim()} className="rounded bg-stone-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">Send</button>
        )}
      </div>
    </div>
  );
}

function Bubble({ role, content, streaming }: { role: string; content: string; streaming: boolean }) {
  const isUser = role === "user";
  return (
    <div className={`mb-2 flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] whitespace-pre-wrap rounded px-3 py-2 text-sm ${isUser ? "bg-stone-900 text-white" : "bg-white text-stone-900 border border-stone-200"}`}>
        {content || (streaming ? <span className="text-stone-400">…</span> : "")}
        {streaming && content && <span className="ml-0.5 inline-block h-4 w-1 animate-pulse bg-stone-400 align-middle" />}
      </div>
    </div>
  );
}

function updateLast(messages: ChatMessage[], content: string): ChatMessage[] {
  if (messages.length === 0) return messages;
  const copy = messages.slice();
  copy[copy.length - 1] = { ...copy[copy.length - 1], content };
  return copy;
}

function appendToLast(messages: ChatMessage[], chunk: string): ChatMessage[] {
  if (messages.length === 0) return messages;
  const copy = messages.slice();
  const last = copy[copy.length - 1];
  copy[copy.length - 1] = { ...last, content: last.content + chunk };
  return copy;
}
