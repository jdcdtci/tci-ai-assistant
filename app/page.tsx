"use client";

import { useState, useRef, useEffect, FormEvent } from "react";
import styles from "./page.module.css";

type Message = {
  role: "user" | "assistant" | "error";
  content: string;
};

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
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

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
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
      setIsLoading(false);
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
        {isLoading && <div className={styles.typing}>Thinking…</div>}
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
