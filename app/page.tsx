import { redirect } from 'next/navigation';
import { getActor } from '@/lib/db/server';
import { isConfigured } from '@/config';
import { SetupNotice } from './_components/setup-notice';
import { DEV_USERS, devLoginEnabled } from '@/lib/auth/dev-users';
import { SignIn } from './_components/sign-in';

export const metadata = {
  title: 'Quorum',
  description:
    'A chat workspace where one agent is present everywhere, decides for itself whether to speak, and never carries what it learns across an authorisation boundary.',
};

export default async function Landing() {
  // A fresh clone with no .env.local is ordinary, not exceptional. Say what is
  // missing instead of throwing out of the env schema.
  if (!isConfigured()) return <SetupNotice />;

  // Signed in already? Skip the marketing page.
  const actor = await getActor();
  if (actor) redirect('/chats');

  return (
    <main className="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center gap-12 px-6 py-16 lg:flex-row lg:items-center lg:gap-20">
      <div className="max-w-xl">
        <p className="mb-3 text-xs uppercase tracking-[0.2em] text-muted">
          Quorum
        </p>
        <h1 className="text-3xl font-semibold leading-tight sm:text-4xl">
          One agent, present in every conversation — and it never carries what
          it learns across a boundary.
        </h1>

        <p className="mt-6 text-sm leading-relaxed text-muted">
          A multi-user chat workspace. The agent decides for itself whether a
          message deserves a reply, learns about the people it talks to, and is
          structurally prevented from repeating something in the wrong room.
        </p>

        <div className="mt-8 space-y-4 border-l-2 border-border pl-5">
          <div>
            <h2 className="text-sm font-medium">The leak the brief invites</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              &ldquo;The agent learns about users and can use it in future
              conversations.&rdquo; Taken literally, something told in a DM
              becomes usable in a group of twelve. A naive schema produces that
              by default, and the demo still looks like it works.
            </p>
          </div>
          <div>
            <h2 className="text-sm font-medium">The rule that closes it</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              A memory learned in one chat may surface in another only if every
              active member of the second was present when it was learned,{' '}
              <em>and</em> the second chat&rsquo;s clearance is at least as high.
              Both conditions, evaluated in SQL before ranking — so the model
              never receives what it must not repeat.
            </p>
          </div>
        </div>
      </div>

      <div className="lg:w-[22rem] lg:shrink-0">
        <div className="rounded-xl border border-border bg-surface p-6">
          <h2 className="mb-1 text-sm font-medium">Sign in</h2>
          <p className="mb-6 text-xs text-muted">
            Authentication is deliberately simple. Authorisation is where the
            work went.
          </p>
          <SignIn
            devEnabled={devLoginEnabled()}
            devUsers={DEV_USERS.map((u) => ({
              key: u.key,
              displayName: u.displayName,
              clearance: u.clearance,
              note: u.note,
            }))}
          />
        </div>
      </div>
    </main>
  );
}
