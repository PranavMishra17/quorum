# Vercel setup — exact steps

Do this at **hour 0**, immediately after [SETUP-SUPABASE.md](SETUP-SUPABASE.md),
with the scaffold and nothing else. About 10 minutes.

The point is not to deploy the finished app. The point is to prove the pipeline
works while it is still empty and any failure is trivially diagnosable.

---

## 1. Push to GitHub — 3 min

```bash
gh repo create quorum --private --source=. --remote=origin --push
```

Or manually: create an empty private repo on GitHub, then

```bash
git remote add origin https://github.com/YOUR-USERNAME/quorum.git
git push -u origin main
```

Confirm `.env.local` is **not** in the push. It is gitignored; verify anyway:

```bash
git ls-files | grep -i env
```

That should list `.env.example` and nothing else.

## 2. Import to Vercel — 2 min

1. <https://vercel.com/new> → sign in with GitHub.
2. **Import** the `quorum` repository.
3. Vercel detects Next.js. Leave build command, output directory, and install
   command on their defaults — the scaffold is standard.
4. **Do not deploy yet.** Add the environment variables first (next step). A
   deploy without them fails at build time, because `config/env.ts` validates
   the client variables at module load.

## 3. Environment variables — 3 min

In the import screen (or later under **Project → Settings → Environment
Variables**), add each of these to **Production, Preview, and Development**:

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | from Supabase → Data API |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | from Supabase → API Keys |
| `SUPABASE_SECRET_KEY` | from Supabase → API Keys (**secret**) |
| `ANTHROPIC_API_KEY` | your Anthropic key |
| `AGENT_ENABLED` | `true` |
| `MEMORY_WRITE_ENABLED` | `true` |
| `TOOLS_ENABLED` | `true` |

**Do not add `ALLOW_DEV_LOGIN` to Vercel.** It opens a route that hands out
sessions for the seeded accounts. `NODE_ENV` is `production` on Vercel so the
route stays closed regardless, but the variable has no business being there.

Two things worth knowing:

- **`NEXT_PUBLIC_*` variables are inlined at build time**, not read at runtime.
  Changing one requires a **redeploy**, not a restart. If you edit one and
  nothing changes, that is why.
- **Nothing else may take a `NEXT_PUBLIC_` prefix.** `SUPABASE_SECRET_KEY` and
  `ANTHROPIC_API_KEY` with that prefix would be compiled into the browser
  bundle and published to the world.

## 4. Deploy — 2 min

Hit **Deploy**. Wait for the build. Open the production URL and confirm the
scaffold page renders.

If the build fails on missing environment variables, that is `config/env.ts`
doing its job — add the variable and redeploy.

## 5. Close the auth loop — 2 min

You now have a production URL. Go back to Supabase:

**Authentication → URL Configuration**

- **Site URL** → `https://YOUR-APP.vercel.app`
- **Redirect URLs** → ensure both are present:
  ```
  http://localhost:3000/**
  https://YOUR-APP.vercel.app/**
  ```

Preview deployments get their own generated URLs. If you want OAuth to work on
previews too, add `https://YOUR-APP-*.vercel.app/**` — otherwise expect sign-in
to fail on preview branches and only test auth on production and localhost.

## 6. Verify the whole pipeline — 1 min

```bash
git commit --allow-empty -m "chore: verify deploy pipeline"
git push
```

Watch it deploy. If that works, hosting is no longer a risk for the rest of the
build.

---

## Kill switches

`AGENT_ENABLED`, `MEMORY_WRITE_ENABLED`, and `TOOLS_ENABLED` exist so that a
dead API key, a rate limit, or a misbehaving extraction pass can be switched off
from the Vercel dashboard without a code change.

Set the variable to `false` and redeploy. The app degrades to a plain chat; it
does not error.

## Things that will bite you

| Symptom | Cause |
|---|---|
| Build fails on a missing env var | `config/env.ts` validating. Add it, redeploy. |
| Changed a `NEXT_PUBLIC_` var, nothing happened | They are build-time. Redeploy. |
| Auth works locally, fails on Vercel | Vercel URL missing from Supabase redirect URLs. |
| Auth works on production, fails on preview | Preview URLs are generated per deployment; add a wildcard or skip preview auth. |
| Agent turn times out in production but not locally | Serverless function limits. Stream the response and keep extraction deferred — that is why it is deferred. |
| Secret visible in the browser | A `NEXT_PUBLIC_` prefix on something that should not have one. Rotate the key immediately, then fix the name. |
