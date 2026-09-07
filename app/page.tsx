"use client";

import { useState, useRef, useEffect, useCallback, FormEvent } from "react";
import styles from "./page.module.css";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type Message = {
  role: "user" | "assistant" | "error";
  content: string;
  // A turn that was never stored in this transcript. Carries no content by
  // construction: public.messages holds a marker row with content NULL.
  redacted?: boolean;
};

type AuthUser = { id: string; email: string };

type Section = { id: string; label: string; courseName: string };

type ConversationSummary = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

// Below this, the quick "Thinking…" indicator matches the normal fast-path
// experience. Past it, a request is very likely queued behind Voyage's
// rate limit (which can add up to ~2 minutes under contention) rather than
// just being a slow-but-normal response, so the UI should say so.
const LONG_WAIT_THRESHOLD_MS = 8_000;

// Shown in place of an exchange that is not stored in this transcript.
//
// Deliberately says nothing about distress, crisis or wellbeing. A student
// rereading their own transcript should not be told which disclosure was
// singled out for special handling. It also avoids "deleted", which would be
// untrue: the content lives in distress_events under its own clock, and the
// crisis response already tells the student the conversation is recorded.
const REDACTED_NOTE = "This part of the conversation isn't shown here.";

export default function Home() {
  const [user, setUser] = useState<AuthUser | null | "loading">("loading");
  const [section, setSection] = useState<Section | null>(null);
  const [joinCode, setJoinCode] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [isRestoring, setIsRestoring] = useState(true);

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);

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

  // Restore the section from the enrollment the student already has, rather
  // than asking again for a join code they have already used. Entitlement is
  // still decided server-side: /api/enrollment returns only sections that
  // can_access_section currently allows, so a closed section does not come
  // back and the join screen is shown instead.
  useEffect(() => {
    if (user === "loading") return;
    if (!user) {
      setIsRestoring(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/enrollment");
        const data = await res.json();
        if (!cancelled && res.ok && Array.isArray(data.sections) && data.sections.length > 0) {
          setSection(data.sections[0]);
        }
      } catch {
        // A failed restore is not an error state: it just means the join
        // screen is shown, which is the pre-existing behaviour.
      } finally {
        if (!cancelled) setIsRestoring(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  const loadConversations = useCallback(async (sectionId: string) => {
    try {
      const res = await fetch(`/api/conversations?section_id=${encodeURIComponent(sectionId)}`);
      const data = await res.json();
      if (res.ok && Array.isArray(data.conversations)) {
        setConversations(data.conversations);
      }
    } catch {
      // The transcript list is not required to hold a conversation.
    }
  }, []);

  useEffect(() => {
    if (section) void loadConversations(section.id);
  }, [section, loadConversations]);

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
        setJoinError(data.error ?? "Could not join.");
      } else {
        setSection(data.section);
      }
    } catch {
      setJoinError("Network error. Please try again.");
    } finally {
      setIsJoining(false);
    }
  }

  function startNewConversation() {
    // No row is created until the first message is sent, so a student
    // clicking this repeatedly does not litter the sidebar with empties.
    setConversationId(null);
    setMessages([]);
    setInput("");
  }

  async function openConversation(id: string) {
    if (isLoading) return;
    setConversationId(id);
    setMessages([]);

    try {
      const res = await fetch(`/api/conversations/${id}`);
      const data = await res.json();
      if (!res.ok) {
        setMessages([{ role: "error", content: data.error ?? "Could not load that conversation." }]);
        return;
      }
      setMessages(
        (data.messages as { role: string; content: string | null; redacted: boolean }[]).map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.content ?? "",
          redacted: m.redacted,
        })),
      );
    } catch {
      setMessages([{ role: "error", content: "Network error. Please try again." }]);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || isLoading || !section || user === "loading" || !user) return;

    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setInput("");
    setIsLoading(true);
    setIsLongWait(false);

    const longWaitTimer = setTimeout(() => setIsLongWait(true), LONG_WAIT_THRESHOLD_MS);

    try {
      // A conversation row is created lazily, on the first message, so the
      // sidebar never fills with empty threads.
      let activeId = conversationId;
      if (!activeId) {
        const created = await fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ section_id: section.id }),
        });
        const createdData = await created.json();
        if (created.ok && createdData.conversation?.id) {
          activeId = createdData.conversation.id;
          setConversationId(activeId);
        }
        // If creation failed, the turn still goes through unpersisted rather
        // than blocking the student's question on a storage problem.
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          // Section, not course: entitlement is section-scoped and the
          // course is derived server-side. student_id is no longer sent at
          // all; the server reads identity from the verified session.
          section_id: section.id,
          ...(activeId ? { conversation_id: activeId } : {}),
          // Error bubbles are UI-only, never part of the tutoring transcript.
          //
          // Redaction markers are dropped too, and must be: they carry no
          // content, so sending them would put empty turns in front of the
          // model. Their absence is exactly why first-versus-repeat crisis
          // detection is decided in the database for a persisted
          // conversation rather than by matching this array.
          history: messages
            .filter((m) => m.role !== "error" && !m.redacted)
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
        if (data.conversation_id) setConversationId(data.conversation_id);
        // Picks up the title the server derives from the first stored turn.
        void loadConversations(section.id);
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

  if (user === "loading" || isRestoring) {
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

  if (!section) {
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
      <div className={styles.shell}>
        <aside className={styles.sidebar}>
          <button
            className={styles.newConversation}
            onClick={startNewConversation}
            disabled={isLoading || (conversationId === null && messages.length === 0)}
          >
            New conversation
          </button>
          <div className={styles.sidebarList}>
            {conversations.map((c) => (
              <button
                key={c.id}
                className={`${styles.conversationItem} ${
                  c.id === conversationId ? styles.conversationItemActive : ""
                }`}
                onClick={() => openConversation(c.id)}
                disabled={isLoading}
                title={c.title ?? "Conversation"}
              >
                {c.title ?? "Conversation"}
              </button>
            ))}
          </div>
        </aside>

        <div className={styles.main}>
          <div className={styles.conversation} ref={scrollRef}>
            {messages.length === 0 ? (
              <p className={styles.empty}>Send a message to start the conversation.</p>
            ) : (
              messages.map((message, i) =>
                message.redacted ? (
                  <div key={i} className={styles.redacted}>
                    {REDACTED_NOTE}
                  </div>
                ) : (
                  <div key={i} className={`${styles.message} ${styles[message.role]}`}>
                    {message.content}
                  </div>
                ),
              )
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
      </div>
    </div>
  );
}
