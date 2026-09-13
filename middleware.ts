import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Temporary, blunt whole-site gate for testing, in front of everything
// else including the per-course access_mode system already specced --
// not a replacement for it, just keeps the site closed to anyone without
// the shared password while this is still being tested. Standard HTTP
// Basic Auth: browsers prompt for credentials natively, and it applies
// uniformly to page loads and direct API requests alike (curl -u works
// the same way a browser's prompt does).
//
// If SITE_PASSWORD isn't set, the gate is a no-op (open access) rather
// than locking everyone out by default -- deliberate, so a clone of this
// repo without the var configured isn't permanently sealed. Set it in
// .env.local and in Vercel's environment variables to actually turn the
// gate on.
function checkSitePassword(request: NextRequest): NextResponse | null {
  const password = process.env.SITE_PASSWORD;
  if (!password) return null;

  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    const decoded = atob(auth.slice("Basic ".length));
    // Basic Auth carries "user:password"; the username is unused here,
    // only the password after the first colon is checked.
    const suppliedPassword = decoded.slice(decoded.indexOf(":") + 1);
    if (suppliedPassword === password) return null;
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="TCI Assistant"' },
  });
}

// Exempt from the site-password gate: the escalation sweep endpoint.
//
// The gate applies to API routes as well as pages, so the pg_cron scheduler
// cannot reach the sweep without either an exemption or a copy of
// SITE_PASSWORD inside the database. This is the exemption, and it is
// deliberately narrow.
//
// SCOPE: exactly one path prefix, /api/internal/, and nothing else. It is a
// prefix rather than an exact match only so a second internal job can be
// added without touching this file again.
//
// This REPLACES one credential with another, it does not remove
// authentication. A request here must carry NOTIFY_SWEEP_SECRET as a bearer
// token or it is refused with the same 401 the gate would have given. The
// secret grants exactly one capability, triggering a sweep, and is useless
// for reaching any page or any other route.
//
// The comparison is constant time: a plain === leaks length and prefix
// information through response timing. That is a stretch for a
// ten-minute-interval endpoint, but it is free to do correctly.
//
// It does NOT use node:crypto's timingSafeEqual. Middleware runs in the Edge
// Runtime, where node:crypto does not exist, and importing it does not fail
// at the call site: it fails at module evaluation, taking down EVERY route in
// the application with a 500, including the pages. tsc does not catch this
// because it is a runtime constraint, not a type error. Learned by doing it.
//
// Hashing both values first is better than comparing the raw strings anyway:
// the digests are always 32 bytes, so the loop below cannot leak the secret's
// length the way a max-length loop over the inputs would.
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const x = new Uint8Array(digestA);
  const y = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
async function checkInternalBearer(request: NextRequest): Promise<NextResponse | null> {
  const expected = process.env.NOTIFY_SWEEP_SECRET;

  // No secret configured means the endpoint is CLOSED, not open. The
  // opposite of SITE_PASSWORD's deliberate fail-open, and deliberately so:
  // an unset site password locks nobody out of a public site, while an
  // unset sweep secret would otherwise expose an internal trigger to
  // anyone who found the path.
  if (!expected) {
    return new NextResponse("Not found.", { status: 404 });
  }

  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  if (!(await constantTimeEqual(supplied, expected))) {
    return new NextResponse("Unauthorized.", { status: 401 });
  }
  return null;
}

// Required by @supabase/ssr: refreshes the auth session cookie on every
// request so it doesn't silently expire between the browser and the
// server-side clients used in Route Handlers.
export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/internal/")) {
    const bearerCheck = await checkInternalBearer(request);
    if (bearerCheck) return bearerCheck;
    // Falls through to the session refresh below, never to the password gate.
  } else {
    const passwordCheck = checkSitePassword(request);
    if (passwordCheck) return passwordCheck;
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
