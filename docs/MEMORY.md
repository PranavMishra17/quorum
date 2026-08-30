# How memory works

End to end: what gets stored, when, how it is fetched, and what happens when two
facts disagree. This is the part of the system the project exists for, so it is
written out in full rather than left to be inferred from the code.

---

## 1. What a memory item is

One row in `memory_items`, plus a set of rows in `memory_audience`.

```
memory_items
  id
  subject_user_id     who the fact is ABOUT
  origin_chat_id      where it was learned          — provenance
  origin_message_id   which turn produced it        — provenance
  content             the fact, as text (≤300 chars)
  search_vector       generated tsvector of content — the lexical index
  clearance_level     FROZEN at write time          — axis two
  source_type         'stated' | 'inferred'         — provenance
  confidence          0..1, from extraction
  status              'candidate' | 'active' | 'superseded' | 'stale'
  superseded_by       → memory_items.id
  expires_at          nullable; set for volatile facts
  created_at

memory_audience
  memory_item_id
  user_id             one row per person who was IN THE ROOM at learn time
```

Two fields carry most of the weight.

**`memory_audience` is the thesis.** It is a snapshot of who was an *active
member* of the origin chat at the instant of the write — not who is in it now.
It is written in the same transaction as the item and never updated afterwards.
A member leaving later does not shrink it, because they *did* hear the thing.

**`clearance_level` is frozen, not looked up.** It records the origin chat's
level at write time. If it were resolved live, lowering a chat's requirement
would retroactively widen every fact ever learned there. It is also **not a
parameter** the caller may supply — `lib/memory/audience.ts` reads it from the
context's own chat, because an extraction bug that marked an exec fact as
level 0 would let the clearance floor wave it into every general chat.

---

## 2. How memory is written

Extraction runs **after** the agent's reply is persisted and broadcast — never
inline (D-013). By that point the user already has their answer, so a slow or
failing extraction costs nothing user-visible.

```
reply delivered
  └─ extractMemory()
       ├─ re-read the active member set   (not cached — time has passed)
       ├─ model call: "extract durable facts, or return an empty list"
       ├─ per item:
       │    ├─ REJECT if subject_user_id is not an active member
       │    ├─ force to inferred + candidate if the turn touched untrusted content
       │    ├─ force to candidate if confidence < 0.6
       │    ├─ set expires_at if the model marked it volatile
       │    └─ write_memory_item()  ← item + audience snapshot, ONE transaction
       └─ event: memory_written  (per item, and a summary)
```

### Four checks the model does not get to bypass

1. **The subject must be an active member.** A crafted message could otherwise
   plant a fact against someone who is not even in the room — and the audience
   snapshot would authorise it perfectly.
2. **The clearance level comes from the chat**, not from the model.
3. **Untrusted-content turns are forced to `inferred` + `candidate`** (T10).
   Applied *after* the model has spoken, so no phrasing can evade it. See §6.
4. **Below the confidence threshold lands as `candidate`**, and candidates are
   never retrieved. They still exist and are visible in the internal view, so a
   low-confidence extraction is auditable rather than silently discarded.

### Why item and audience are one transaction

If the item lands and the snapshot does not, the item has an *empty* audience.
Under the surfacing rule that means it surfaces nowhere — safe, but invisible,
and an item that can never be retrieved is silent data loss. So
`write_memory_item()` does both, and **refuses outright** to learn from a chat
with no active members.

---

## 3. How memory is fetched

Three steps, and the order is the design.

```
1. FILTER   private.memory_visible_in_chat(chat_id)   ← IN SQL, before anything
2. RANK     ts_rank · 0.6 + recency · 0.2 + speakerPresence · 0.2
3. CAP      24 items globally, 3 per subject
```

### Step 1 — the filter, in SQL

```sql
(select count(*) from active_members) > 0        -- ← the fail-closed guard
and i.status = 'active'
and (i.expires_at is null or i.expires_at > now())
and i.clearance_level <= chat_clearance.level    -- (b) clearance floor
and not exists (                                 -- (a) audience containment
  select 1 from active_members a
  where not exists (
    select 1 from public.memory_audience ma
    where ma.memory_item_id = i.id and ma.user_id = a.user_id
  )
)
```

Read the first line before anything else. **"Every active member of C2 was in
the snapshot" is vacuously TRUE when C2 has no active members** — `NOT EXISTS`
over an empty set in SQL, `Array.every` over an empty array in JavaScript.
Without that guard, a vacated chat matches *every memory item in the system*:
the exact leak this project exists to prevent, arriving through the front door
of its own central rule. It is verified by negative control — removing the line
makes three tests fail.

**Why the filter is in SQL and not in TypeScript.** Nothing in the ranking code
can cause a leak, because it only ever sees rows that already passed. Change the
weights however you like and the worst outcome is a worse answer, never a wrong
audience. Retrieving the top 20 by relevance and discarding the unauthorised 5
would be a different program with the same output most of the time — and a leak
the rest of the time. Authorisation is not a relevance-ranking problem.

### Step 2 — ranking

Lexical, not semantic. D-004 closed against wiring an embedding provider:
Anthropic ships none, and a second vendor was not worth the cost for a candidate
set the filter has already cut to tens of items. `lib/memory/embed.ts` is an
unimplemented interface so the upgrade stays a one-file change.

The honest weakness: lexical matching finds lexemes, not meaning. "Delaware
governing law" and "the client's choice-of-law clause" are the same fact and
share no words.

`ts_rank` is computed by `websearch_to_tsquery`, which tolerates arbitrary
punctuation — the query is a chat message, so it is arbitrary by definition, and
`plainto_tsquery` would raise on it.

### Step 3 — two caps, doing different jobs

- **Global (24)** is the token budget.
- **Per subject (3)** is the twenty-person-group problem: without it, one
  heavily-discussed member fills the entire budget and the other nineteen are
  invisible.

Applying the per-subject cap first is what makes the budget spread across people
rather than concentrate on one.

### Step 4 — the numbers are reported separately

`memory_retrieved` carries `kept`, `filtered_out` and `capped_out` as three
distinct fields. Conflating "withheld because not everyone here was in the
audience" with "dropped by the budget" would make the internal view's headline
number a lie.

---

## 4. How a contradiction is handled

**The model detects; the code decides.** That split is the whole design.

Deciding two facts *might* contradict is a language judgement, and the model is
good at it. Deciding *which one wins* is policy — and asking a model that gives
different answers on different days, which means the same inputs produce
different memory and no test can pin it down (D-014).

So extraction may **nominate** an existing item as contradicted, and
`lib/memory/conflict.ts` resolves it from **provenance and time alone** — no
content, no model call:

| # | Rule | Example |
|---|---|---|
| 1 | **stated beats inferred**, regardless of age | "I moved to Berlin" beats a colleague's later guess |
| 2 | within the same source type, **newer beats older** | a fresher self-report wins |
| 3 | a genuine tie is **flagged, not hidden** | two stated facts disagreeing: newer wins, `memory_conflict` fires |
| — | identical timestamps | **refuse to choose** — keep the existing one |

Rule 3 is what makes overwrites visible. The newer fact still wins (people
change their minds and say so), but a `memory_conflict` event records that
something was superseded rather than merged, and the internal view shows it.

Identical timestamps deliberately decline rather than pick: with no ordering
signal, preferring one would be a coin toss dressed up as a rule.

Two further guards on superseding, because the model supplies the id:

- only an **active** item may be superseded
- only an item about the **same subject** — otherwise the model could retire an
  arbitrary fact by id

The loser becomes `status = 'superseded'` with `superseded_by` pointing at the
winner. It is never deleted: the history of what was believed, and when, is
part of the audit trail.

---

## 5. Lifecycle

```
candidate ──accepted──▶ active ──contradicted──▶ superseded
                          │
                          └──expires_at passes──▶ stale
```

Only **`active`** is ever retrieved. Everything else remains readable in the
internal view, so nothing disappears silently.

- `candidate` — below the confidence threshold, or from an untrusted turn
- `superseded` — lost a conflict; `superseded_by` names the winner
- `stale` — `expires_at` has passed. Set for facts the model marked volatile
  (where someone is this week, what they are working on now), TTL 30 days

There is **no consolidation or reflection step** (D-021, a named non-goal).
Memory decays and supersedes; it does not merge related facts into higher-order
summaries. That is where memory systems get expensive and unpredictable, and it
is not on the path to anything the brief asks for.

---

## 6. Memory-write planting — the failure unique to remembering

Extraction reads the *model's own reply*. An injected instruction in a fetched
document that makes the model assert a false fact about a user would plant that
lie into `memory_items` — correctly authorised, surfacing indefinitely, in every
chat the audience rule permits.

The generic prompt-injection literature does not cover this, because generic
systems do not persist.

**Mitigation:** anything extracted from a turn that touched untrusted tool
content is forced to `inferred` + `candidate` regardless of how confidently the
model phrased it. Candidates are never retrieved. The item still exists and is
visible in the internal view, so the attempt is *auditable* rather than merely
dropped.

This is a structural control, not a prompt asking the model to be careful: it is
applied after the model has spoken, in code, so no phrasing can evade it.

---

## 7. What this does not solve

Stated plainly, because a README that only lists strengths is not trustworthy.

- **Fabricated-but-authorised memory.** `source_type` defends against
  *misattribution*, not *fabrication*. A user asserting a false claim about a
  colleague produces a correctly-authorised `inferred` item.
- **Aggregation.** Item-level filtering does not stop a human combining two
  separately-authorised answers into a third, unauthorised inference. No system
  surveyed claims to solve this.
- **Mid-turn staleness.** Membership and clearance are live state. No design
  keeping the model call outside a transaction can stop a reply being generated
  from data that went stale mid-turn. The guarantee is that a revocation takes
  effect on the **next privileged read** (D-009).
- **Paraphrase.** Lexical ranking misses it. See D-004.

---

## Where the code is

| Concern | File |
|---|---|
| The filter | `supabase/migrations/0006_memory.sql` → `private.memory_visible_in_chat()` |
| Retrieval, rank, cap | `lib/memory/retrieve.ts` |
| Writing + audience snapshot | `lib/memory/audience.ts`, `0010_memory_rpc.sql` |
| Extraction | `lib/memory/extract.ts` |
| Conflict resolution | `lib/memory/conflict.ts` |
| Isolation tests | `tests/memory/isolation.test.ts` (23 assertions) |
| Rank/cap/conflict tests | `tests/memory/ranking.test.ts`, `conflict.test.ts` |
| RPC surface tests | `tests/memory/rpc.test.ts` |
