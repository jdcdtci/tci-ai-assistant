"use client";

import { useState, useRef, useEffect, FormEvent } from "react";
import styles from "./page.module.css";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type Message = {
  role: "user" | "assistant" | "error";
  content: string;
};

type AuthUser = { id: string; email: string };

// Below this, the quick "Thinking…" indicator matches the normal fast-path
// experience. Past it, a request is very likely queued behind Voyage's
// rate limit (which can add up to ~2 minutes under contention) rather than
// just being a slow-but-normal response, so the UI should say so.
const LONG_WAIT_THRESHOLD_MS = 8_000;

export default function Home() {
  const [user, setUser] = useState<AuthUser | null | "loading">("loading");
  const [course, setCourse] = useState<{ id: string; name: string } | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isLongWait, setIsLongWait] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const supabase = getSupabaseBrowserClient();

    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user && data.user.email ? { id: data.user.id, email: data.user.email } : null);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user?.email ? { id: session.user.id, email: session.user.email } : null);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function handleSignIn() {
    const supabase = getSupabaseBrowserClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
  }

  async function handleJoin(e: FormEvent) {
    e.preventDefault();
    const trimmed = joinCode.trim();
    if (!trimmed || isJoining) return;

    setIsJoining(true);
    setJoinError(null);

    try {
      const res = await fetch("/api/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ join_code: trimmed }),
      });
      const data = await res.json();

      if (!res.ok) {
        setJoinError(data.error ?? "Something went wrong.");
      } else {
        setCourse(data.course);
      }
    } catch {
      setJoinError("Network error. Please try again.");
    } finally {
      setIsJoining(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading || !course || user === "loading" || !user) return;

    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setInput("");
    setIsLoading(true);
    setIsLongWait(false);

    const longWaitTimer = setTimeout(() => setIsLongWait(true), LONG_WAIT_THRESHOLD_MS);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          course_id: course.id,
          student_id: user.id,
          // Error bubbles are UI-only, never part of the tutoring transcript.
          history: messages
            .filter((m) => m.role !== "error")
            .map((m) => ({ role: m.role, content: m.content })),
        }),
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

  if (user === "loading") {
    return <div className={styles.page} />;
  }

  if (!user) {
    return (
      <div className={styles.page}>
        <div className={styles.centeredScreen}>
          <p className={styles.empty}>Sign in to continue.</p>
          <button className={styles.send} onClick={handleSignIn}>
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  if (!course) {
    return (
      <div className={styles.page}>
        <div className={styles.centeredScreen}>
          <p className={styles.empty}>Enter your course join code.</p>
          <form className={styles.inputRow} onSubmit={handleJoin}>
            <input
              className={styles.input}
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value)}
              placeholder="Join code…"
              disabled={isJoining}
              autoFocus
            />
            <button className={styles.send} type="submit" disabled={isJoining || !joinCode.trim()}>
              Join
            </button>
          </form>
          {joinError && <div className={styles.error}>{joinError}</div>}
        </div>
      </div>
    );
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
