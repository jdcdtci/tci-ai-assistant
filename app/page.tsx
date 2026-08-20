"use client";

import { useState, useRef, useEffect, FormEvent } from "react";
import styles from "./page.module.css";

type Message = {
  role: "user" | "assistant" | "error";
  content: string;
};

// This build only serves one seeded course; a course picker is future work.
const COURSE_ID = "cbd8d7e2-b787-446e-9bce-aac386dfaaae";

// Below this, the quick "Thinking…" indicator matches the normal fast-path
// experience. Past it, a request is very likely queued behind Voyage's
// rate limit (which can add up to ~2 minutes under contention) rather than
// just being a slow-but-normal response, so the UI should say so.
const LONG_WAIT_THRESHOLD_MS = 8_000;

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isLongWait, setIsLongWait] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;

    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setInput("");
    setIsLoading(true);
    setIsLongWait(false);

    const longWaitTimer = setTimeout(() => setIsLongWait(true), LONG_WAIT_THRESHOLD_MS);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, course_id: COURSE_ID }),
      });
      const data = await res.json();

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          { role: "error", content: data.error ?? "Something went wrong." },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.response },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "error", content: "Network error. Please try again." },
      ]);
    } finally {
      clearTimeout(longWaitTimer);
      setIsLoading(false);
      setIsLongWait(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.conversation} ref={scrollRef}>
        {messages.length === 0 ? (
          <p className={styles.empty}>Send a message to start the conversation.</p>
        ) : (
          messages.map((message, i) => (
            <div key={i} className={`${styles.message} ${styles[message.role]}`}>
              {message.content}
            </div>
          ))
        )}
        {isLoading && !isLongWait && <div className={styles.typing}>Thinking…</div>}
        {isLoading && isLongWait && (
          <div className={styles.longWait}>
            Still working on this, thanks for your patience.
          </div>
        )}
      </div>
      <form className={styles.inputRow} onSubmit={handleSubmit}>
        <input
          className={styles.input}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
          disabled={isLoading}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          autoFocus
        />
        <button className={styles.send} type="submit" disabled={isLoading || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
