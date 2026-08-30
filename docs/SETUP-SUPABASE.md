# Supabase setup — exact steps

Do this at **hour 0**, before writing application code. Configuration fails in
boring, time-consuming ways; find those failures while they are cheap.

Roughly 25 minutes, most of it Google's OAuth consent screen.

Where a dashboard label has moved (Supabase renames things), the value you want
is named in **bold** — search the settings page for that.

---

## 1. Create the project — 3 min

1. Go to <https://supabase.com/dashboard> and sign in.
2. **New project**.
   - **Name:** `quorum`
   - **Database password:** generate one and save it to your password manager.
     You will need it for the CLI, and it is not retrievable later.
   - **Region:** pick the one nearest you *and* nearest your Vercel region.
     Cross-continent round trips are the single easiest latency mistake here.
   - **Plan:** Free.
3. Wait for provisioning (~2 min).

## 2. Collect the three values `.env.local` needs — 2 min

**Project Settings → Data API**

- Copy **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
  (looks like `https://abcdefghijklm.supabase.co`)

**Project Settings → API Keys**

- Copy the **publishable** key (`sb_publishable_…`; older projects call this
  **anon / public**) → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- Reveal and copy the **secret** key (`sb_secret_…`; older projects call this
  **service_role**) → `SUPABASE_SECRET_KEY`

> The secret key bypasses row-level security completely. It goes in
> `.env.local` and in Vercel's environment variables — nowhere else, and never
> with a `NEXT_PUBLIC_` prefix. In this codebase it is read from exactly one
> file, `lib/db/scoped-agent.ts`.

Also note your **project ref** — the `abcdefghijklm` part of the URL. The CLI
wants it.

## 3. Google OAuth — 12 min

Two systems, and they point at each other. Do them in this order or you will
paste an empty string.

### 3a. Google Cloud Console

1. <https://console.cloud.google.com> → create a project (`quorum`).
2. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - App name `Quorum`, your email for both support and developer contact.
   - Scopes: the defaults (`email`, `profile`, `openid`) are enough. Do not add
     Gmail scopes — that integration is cut.
   - **Test users:** add every Google account you intend to demo with. While the
     app is unpublished, only listed accounts can sign in — and you need at
     least **three** accounts to demonstrate the authorisation tests (member,
     non-member, and a second member).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - **Authorised redirect URIs** — add exactly:
     ```
     https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback
     ```
     Note this points at **Supabase**, not at your app. Supabase is the OAuth
     client; your app never sees Google directly. This is the step people get
     wrong.
4. Copy the **Client ID** and **Client secret**.

### 3b. Supabase

1. **Authentication → Sign In / Providers → Google** (older UI: *Providers*).
2. Enable it, paste the Client ID and Client secret, save.
3. **Authentication → URL Configuration**
   - **Site URL:** `http://localhost:3000` for now. Change it to the Vercel
     production URL once you have one — see [SETUP-VERCEL.md](SETUP-VERCEL.md).
   - **Redirect URLs:** add both, so local and deployed both work:
     ```
     http://localhost:3000/**
     https://YOUR-APP.vercel.app/**
     ```

## 4. Enable the `vector` extension — 1 min

**Database → Extensions**, search `vector`, enable it.

Needed for semantic memory ranking. Note that the embedding *provider* is still
an open decision (D-004 / research R3) — but enabling the extension now costs
nothing and avoids a migration failing at hour 7.

## 5. Storage bucket — 2 min

**Storage → New bucket**

- Name: `chat-files`
- **Public: OFF.** This matters. A public bucket makes every uploaded file
  readable by URL to anyone, which defeats the entire authorisation model.

Bucket access policies mirroring chat membership are written in migration
`0007_files.sql`, not in the dashboard.

## 6. Wire up the CLI — 4 min

From the repository root:

```bash
pnpm add -D supabase
pnpm supabase login
pnpm supabase link --project-ref YOUR-PROJECT-REF
```

It will prompt for the database password from step 1.

Apply migrations (once they exist):

```bash
pnpm supabase db push
```

Regenerate types after any schema change:

```bash
pnpm supabase gen types typescript --linked > lib/db/types.ts
```

`lib/db/types.ts` is generated output. Never hand-edit it.

## 7. Write `.env.local` — 1 min

```bash
cp .env.example .env.local
```

Fill in the three Supabase values and your `ANTHROPIC_API_KEY`. Leave the
optional keys blank; those features degrade gracefully when absent.

## 8. Verify — 2 min

```bash
pnpm dev
```

Open <http://localhost:3000>. Once auth is wired (hour 1), the check that
actually matters is: **sign in with Google in a normal window and again in a
private window with a different account.** Two identities is the minimum to see
anything about authorisation, and a logged-in tab hides most auth bugs.

---

## Things that will bite you

| Symptom | Cause |
|---|---|
| `redirect_uri_mismatch` from Google | The redirect URI must be the **Supabase** callback, not your app's URL. Exact string, including `https://` and no trailing slash. |
| Sign-in works locally, fails on Vercel | Vercel's URL is not in Supabase → Authentication → URL Configuration → Redirect URLs. |
| Only your own Google account can sign in | The consent screen is unpublished. Add every demo account under **Test users**. |
| Client-side queries return `[]` for data you can see in the dashboard | RLS is working. The dashboard uses the secret key; your app does not. Check the policy, not the query. |
| Client-side queries return rows they should not | **Stop.** Either RLS is disabled on that table or the policy is wrong. This is the one bug that matters in this project. |
| `infinite recursion detected in policy` | A `chat_members` policy that queries `chat_members`. Use a `security definer` predicate function — research track R1. |
| `pnpm supabase db push` asks for a password you do not have | Reset it under Project Settings → Database. |
