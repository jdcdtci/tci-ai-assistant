This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Environment variables

Core function (chat, retrieval, auth, distress handling) needs
`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `SUPABASE_URL` /
`SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL` /
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, and the Upstash `KV_REST_API_*` /
`REDIS_URL` variables used for rate limiting.

**Escalation email is built and verified end to end, but not yet live.**
Setting up its remaining four variables — `RESEND_API_KEY`,
`NOTIFY_FROM_ADDRESS`, `NOTIFY_SIGN_IN_URL`, `NOTIFY_SWEEP_SECRET` — plus the
two Supabase Vault secrets it also needs (`notify_sweep_url`,
`notify_sweep_secret`) is a **deliberately deferred decision**, not an
oversight: see `SESSION_NOTES.md` for the full accounting, the "DECISION:
Resend account and Vault secrets deliberately deferred" entry for why this
is safe to leave as-is, and the "CLOSED (pending live send)" entry above it
for what has already been verified without them. Until they're set, the
escalation sweep runs on schedule and does nothing, by design, with no data
loss in the interim.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
