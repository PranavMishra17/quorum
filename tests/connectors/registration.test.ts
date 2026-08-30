import { describe, it, expect } from 'vitest';
import { allTools } from '@/lib/agent/tools';
import { emailSearch, calendarList, boundWindow } from '@/lib/agent/tools/connectors';
import { CONNECTORS } from '@/config';
import { googleConnectorConfigured } from '@/lib/connectors/google';

/**
 * Where the connectors may be offered, and what they declare.
 *
 * The rule under test — DMs and agent chats only — is enforced at REGISTRATION
 * rather than inside the tool. The difference matters: the model is never shown
 * the tool in a group, instead of being shown it and asked to decline. Asking
 * an agent to be careful is not a control.
 *
 * Why the restriction exists at all: memory has an audience snapshot, so a fact
 * learned in a DM cannot surface where a non-participant would read it. A
 * mailbox has no such thing — it has one owner and no notion of a room. An
 * email search in a group would put one person's mail in front of everyone in
 * it, and nothing downstream could undo that.
 */

const names = (chatType: string) => allTools(chatType).map((t) => t.name);

describe('registration is gated on chat type', () => {
  it('never offers the connectors in a GROUP, configured or not', () => {
    expect(names('group')).not.toContain('email_search');
    expect(names('group')).not.toContain('calendar_list');
  });

  it('still offers the chat-scoped tools in a group — this is not a blanket ban', () => {
    // Without this, the test above would pass just as well if registration were
    // broken entirely, which is the same vacuous-pass shape as the empty-audience
    // trap the project exists to avoid.
    for (const expected of ['file_list', 'file_read', 'document_extract', 'web_fetch']) {
      expect(names('group'), expected).toContain(expected);
    }
  });

  it('offers them in a DM only when the connector is actually configured', () => {
    // The suite must not require Google credentials, so this asserts the
    // IMPLICATION rather than the presence: configured ⇒ offered in a DM.
    if (googleConnectorConfigured()) {
      expect(names('dm')).toContain('email_search');
      expect(names('dm')).toContain('calendar_list');
    } else {
      expect(names('dm')).not.toContain('email_search');
    }
  });

  it('the permitted chat types are DM and agent, from config', () => {
    expect([...CONNECTORS.chatTypes].sort()).toEqual(['agent', 'dm']);
  });

  it('an unknown chat type gets nothing extra — the list is an allowlist', () => {
    expect(names('something-new')).not.toContain('email_search');
  });
});

describe('the flags, which decide what D-022 and T10 do', () => {
  it('email_search is externally observable — the query reaches Google', () => {
    // The query is model-authored, so a search for subject:"<everything I know
    // about Alice>" is a working exfiltration channel. D-022 must be able to
    // shut it once the turn has read untrusted content.
    expect(emailSearch.externallyObservable).toBe(true);
    expect(calendarList.externallyObservable).toBe(true);
  });

  it('email_search returns untrusted content — anyone can email you', () => {
    // Email is the cheapest way in the world to put text in front of someone
    // else's assistant. This flag is what forces T10's memory downgrade.
    expect(emailSearch.returnsUntrustedContent).toBe(true);
  });

  it('calendar entries are untrusted too — anyone can put an event on your calendar', () => {
    expect(calendarList.returnsUntrustedContent).toBe(true);
  });
});

describe('input bounds', () => {
  it('caps the model-authored search query, which is interpolated into a URL', () => {
    const tooLong = 'a'.repeat(CONNECTORS.email.maxQueryChars + 1);
    expect(emailSearch.inputSchema.safeParse({ query: tooLong }).success).toBe(false);
    expect(emailSearch.inputSchema.safeParse({ query: 'from:beta.example.com' }).success).toBe(true);
  });

  it('refuses an empty query rather than listing an inbox', () => {
    expect(emailSearch.inputSchema.safeParse({ query: '' }).success).toBe(false);
  });

  it('refuses extra keys on both connector tools', () => {
    expect(emailSearch.inputSchema.safeParse({ query: 'x', userId: 'someone' }).success).toBe(false);
    expect(
      calendarList.inputSchema.safeParse({
        startDate: '2026-01-01', endDate: '2026-01-02', calendarId: 'other',
      }).success,
    ).toBe(false);
  });
});

describe('the calendar window is bounded', () => {
  it('accepts a normal week', () => {
    const w = boundWindow('2026-03-02', '2026-03-08');
    expect('timeMin' in w).toBe(true);
  });

  it('REFUSES an unbounded range — that is an export, not an answer', () => {
    const w = boundWindow('2000-01-01', '2030-01-01');
    expect(w).toEqual({ error: expect.stringContaining('narrower') });
  });

  it('refuses a backwards window', () => {
    expect(boundWindow('2026-03-08', '2026-03-02')).toEqual({
      error: expect.stringContaining('before'),
    });
  });

  it('refuses dates it cannot understand', () => {
    expect(boundWindow('2026-13-45', '2026-13-46')).toEqual({
      error: expect.stringContaining('understood'),
    });
  });

  it('is exclusive at exactly one day past the ceiling', () => {
    const days = CONNECTORS.calendar.maxWindowDays;
    const start = new Date('2026-01-01T00:00:00Z');
    const within = new Date(start.getTime() + (days - 1) * 86_400_000);
    const beyond = new Date(start.getTime() + (days + 1) * 86_400_000);
    const iso = (d: Date) => d.toISOString().slice(0, 10);

    expect('timeMin' in boundWindow(iso(start), iso(within))).toBe(true);
    expect('error' in boundWindow(iso(start), iso(beyond))).toBe(true);
  });
});
