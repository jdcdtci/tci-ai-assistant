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

// Required by @supabase/ssr: refreshes the auth session cookie on every
// request so it doesn't silently expire between the browser and the
// server-side clients used in Route Handlers.
export async function middleware(request: NextRequest) {
  const passwordCheck = checkSitePassword(request);
  if (passwordCheck) return passwordCheck;

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
