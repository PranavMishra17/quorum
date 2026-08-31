import { redirect } from 'next/navigation';
import { getActor } from '@/lib/db/server';
import { isConfigured } from '@/config';
import { SetupNotice } from './_components/setup-notice';
import { DEV_USERS, devLoginEnabled } from '@/lib/auth/dev-users';
import { SignIn } from './_components/sign-in';
import { Redacted } from './_components/clearance';

export const metadata = {
  title: 'Quorum',
  description:
    'A chat workspace with one agent in every conversation. It decides for itself when to speak, and what it learns in one room never turns up in another.',
};

/**
 * The landing page.
 *
 * The hero is not a headline about the product — it is the product's central
 * object, shown working. Two lines of a transcript, the same fact, one room
 * where the agent may repeat it and one where it may not, with the second
 * struck out in ink. Anyone who reads those six lines understands the thesis
 * before they reach a paragraph, which is more than a paragraph can do.
 *
 * It is also the honest version: the redaction bars on this page contain no
 * text, exactly as they do everywhere else in the app.
 */
export default async function Landing() {
  // A fresh clone with no .env.local is ordinary, not exceptional. Say what is
  // missing instead of throwing out of the env schema.
  if (!isConfigured()) return <SetupNotice />;

  const actor = await getActor();
  if (actor) redirect('/chats');

  return (
    <main className="mx-auto w-full max-w-6xl px-5 py-12">
      <p className="label text-muted">Quorum</p>

      <div className="mt-10 grid gap-14 lg:grid-cols-[1.15fr_20rem] lg:gap-16">
        <div>
          <h1 className="max-w-2xl font-display text-4xl font-semibold leading-[1.08] sm:text-5xl">
            One agent, in every room. What it learns with you stays with you.
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-relaxed text-muted">
            Quorum sits in every direct message and group chat, watching
            quietly and speaking when it has something worth saying. Tell it
            something in private, and it remembers it in private — the fact
            never turns up somewhere the people who should know about it
            weren&rsquo;t in the room to hear it.
          </p>

          <Demonstration />

          <div className="mt-12 grid max-w-3xl gap-8 sm:grid-cols-2">
            <div>
              <h2 className="label mb-2 text-foreground">Say it once, where it belongs</h2>
              <p className="text-sm leading-relaxed text-muted">
                Mention your schedule in a DM and the agent can act on it next
                time you talk. Say it in a group instead, and it stays scoped
                to that group. Nothing you tell it in one conversation quietly
                becomes something it happens to know in another.
              </p>
            </div>
            <div>
              <h2 className="label mb-2 text-foreground">Checked every time, not just once</h2>
              <p className="text-sm leading-relaxed text-muted">
                Before the agent brings anything up, it checks who is actually
                in the room right now and what they&rsquo;re cleared to see —
                on every reply, not only when the fact was first learned. Leave
                a room, and it stops seeing you in it immediately.
              </p>
            </div>
          </div>
        </div>

        <div className="lg:pt-4">
          <div className="border border-border bg-surface p-6">
            <h2 className="label mb-1 text-foreground">Sign in</h2>
            <p className="mb-6 text-xs leading-relaxed text-muted">
              One click, and you&rsquo;re in a room with the agent.
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
      </div>
    </main>
  );
}

/**
 * The signature element: the same question, asked in two rooms.
 *
 * Static markup, not an animation. The comparison is the argument, and an
 * animation would make the reader wait for it.
 */
function Demonstration() {
  return (
    <div className="mt-10 grid max-w-3xl gap-px border border-border bg-border sm:grid-cols-2">
      <Room
        label="Direct message · Alice and Quorum"
        stamp="Learned here"
        stampColor="var(--c1)"
      >
        <Line who="Alice">I only review contracts on Fridays.</Line>
        <Line who="Quorum" agent>
          Noted.
        </Line>
        <Line who="Alice">When do I review contracts?</Line>
        <Line who="Quorum" agent>
          Fridays.
        </Line>
      </Room>

      <Room
        label="Group · Alice, Bob, Dana and Quorum"
        stamp="Withheld here"
        stampColor="var(--c3)"
      >
        <Line who="Alice">When do I review contracts?</Line>
        <Line who="Quorum" agent>
          {/* No text behind the bar — on this page for the same reason as
              everywhere else in the app. */}
          <span className="inline-flex w-full flex-col gap-1">
            <Redacted width="82%" label="Withheld: not everyone here was in the audience" />
            <Redacted width="46%" label="Withheld: not everyone here was in the audience" />
          </span>
        </Line>
        <p className="px-4 pb-4 pt-1 text-xs leading-relaxed text-muted">
          Bob and Dana were not in that conversation, so the fact is never
          retrieved and never reaches the model. Nothing is asked to keep a
          secret.
        </p>
      </Room>
    </div>
  );
}

function Room({
  label,
  stamp,
  stampColor,
  children,
}: {
  label: string;
  stamp: string;
  stampColor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <span className="label min-w-0 truncate text-muted">{label}</span>
        <span
          className="label shrink-0 border px-1.5 py-0.5"
          style={{ color: stampColor, borderColor: stampColor }}
        >
          {stamp}
        </span>
      </div>
      <div className="space-y-2 p-4">{children}</div>
    </div>
  );
}

function Line({
  who,
  agent = false,
  children,
}: {
  who: string;
  agent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <p className={`flex gap-2 text-sm ${agent ? 'text-foreground' : ''}`}>
      <span
        className={`w-16 shrink-0 ${agent ? 'label pt-1 text-agent' : 'text-muted'}`}
        style={agent ? undefined : { fontSize: '0.75rem', paddingTop: '0.15rem' }}
      >
        {agent ? 'QUORUM' : who}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  );
}
