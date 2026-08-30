# R4 — Memory architecture, and the graph verdict

**Band:** A · **Closes:** D-007 · **Status:** complete

## Question

Two jobs. First, ground Quorum's memory design (`memory_items` / `memory_audience`,
`config/agent.ts` → `MEMORY`) in what is actually known about agent memory —
episodic vs semantic, extraction, decay, contradiction handling, poisoning.
Second, settle D-007: does `memory_nodes`/`memory_edges` earn its place, or does
the provisional cut hold? The cut is only confirmed if this report can show real
reasoning, not a concession to a reviewer — concretely, by naming three plausible
product queries a graph answers well and relational answers badly, or by showing
that three cannot be named.

## Findings

### 1. Episodic vs semantic memory — which is Quorum storing?

CoALA (Sumers, Yao, Narasimhan & Griffiths, *Cognitive Architectures for
Language Agents*, arXiv:2309.02427, first submitted Sept 2023, revised
Mar 2024) is the standard reference vocabulary here. It defines **episodic
memory** as "experience from earlier decision cycles" — time-stamped records
of what happened — and **semantic memory** as an agent's "knowledge about the
world and itself," i.e. facts and inferences abstracted away from any single
event. Its own example: "visited kitchen at 3pm" is episodic; "kitchens
contain appliances" is semantic.

Quorum's `memory_items` table (`content`, `subject_user_id`, `confidence`,
`status`) stores facts about a person — "Client requires Delaware governing
law" — which is **semantic**, not episodic. Quorum already has an episodic
log, it's just not called that: `messages` (the verbatim chat history) and
`agent_events` (the agent's own action trace) are both episodic in CoALA's
sense — ordered records of what happened, not abstracted facts. This is worth
one sentence in `docs/ARCHITECTURE.md` §2: *"`memory_items` is semantic
memory; `messages` and `agent_events` are the episodic layer it is built on
top of."* No schema change follows from this — it is a naming/framing finding,
not a structural one, but it answers a question an interviewer is likely to
ask directly ("is this episodic or semantic memory, and do you know the
difference?").

### 2. Extraction: what production systems extract, and how confidence is scored

Mem0 (Chhikara et al., *Mem0: Building Production-Ready AI Agents with
Scalable Long-Term Memory*, arXiv:2504.19413, 2025) is the most detailed
public description of a production extraction pipeline. Its extraction step
conditions an LLM call on (a) a conversation summary, (b) the last *m=10*
messages, and (c) the new message pair, and asks it to emit "a set of salient
memories … specifically from the new exchange." The update step then retrieves
the *s=10* most similar existing memories and has the LLM choose one of four
operations via function-calling: **ADD** (no semantic equivalent exists),
**UPDATE** (augments an existing memory), **DELETE** (contradicted), **NOOP**.

**Finding, stated plainly:** the paper documents no explicit numeric
confidence score. Decisions are made by LLM reasoning directly, not by a
threshold on a probability. I could not find a confidence-threshold mechanism
in either the Mem0 paper or OpenAI's public description of ChatGPT's memory
feature (below). This is a real gap in the literature relative to Quorum's
design: `config/agent.ts` → `MEMORY.extraction.confidenceThreshold = 0.6`
implies the extraction call *returns* a confidence value that a deterministic
threshold then gates. That is a Quorum-specific design choice, not an
industry-observed pattern — it should be described in `docs/DECISIONS.md` as
such (an extension beyond what Mem0/OpenAI do), not as "how everyone does
extraction." The mechanism itself (ask the model for a structured
`{content, subject_user_id, source_type, confidence}` object, then apply the
threshold in TypeScript, never in the prompt) is sound and consistent with
D-014's principle that binary/ordinal decisions should be deterministic code,
not model discretion — Quorum is more conservative here than the two
production systems surveyed, and that divergence is defensible and worth
stating explicitly rather than silently assuming it's standard practice.

### 3. What should NOT be remembered

No single principled algorithm exists in the literature; every source that
addresses this converges on the same shape of answer: **a short, explicit,
domain-specific exclusion list, applied at write time, plus data-minimization
framing to justify it.**

- **GDPR Art. 5(1)(c)** (official consolidated text, gdpr-info.eu/art-5-gdpr/)
  states the governing legal principle directly: personal data must be
  "adequate, relevant and limited to what is necessary" for a stated purpose.
  This is the right frame for *why* a filter exists, not what specifically to
  filter — the purpose has to be named first ("this product surfaces
  work-relevant facts to a legal team's shared agent," not "personalization").
- **Anthropic's own consumer memory feature** (claude.com/blog,
  "Claude's memory works everywhere, and you decide what's in it," and the
  Memory FAQ) states a concrete, shipped list: by default it does **not**
  store health, race, ethnicity, religious beliefs, politics, or gender
  identity, and **never** stores government ID numbers, criminal history, or
  immigration status, "even when sensitive topic retention is enabled." This
  is a directly comparable primary precedent — a memory-carrying product built
  by the same lab whose model Quorum uses, shipping a hard-coded category
  list rather than a general classifier.
- **Eunhae Lee, "Towards Ethical Personal AI Applications: Practical
  Considerations for AI Assistants with Long-Term Memory"** (arXiv:2409.11192,
  Sept 2024) recommends security-based restrictions on data "enabling
  impersonation and misuse" (financial details, health records) and
  "forgetting mechanisms that mimic human memory" rather than unbounded
  retention. The paper's own **stated limitation** is directly relevant: it
  "prescribes what values should guide storage decisions but provides limited
  concrete technical specifications for implementation" — i.e. even a paper
  dedicated to this question does not derive a decidable filter from first
  principles.

**Application-specific answer for Quorum, a legal product:** the useful
distinction is not sensitivity in the abstract, it's **whether the fact is
instrumental to legal/work product** versus personal trivia. *"Client requires
Delaware governing law"* is high-value and needs provenance precisely because
it will be *acted on*; *"John hates Mondays"* is noise regardless of
sensitivity level. The two axes (sensitive-category exclusion, work-relevance
inclusion) are independent and both matter — a fact can be work-relevant *and*
sensitive (a client's immigration status affecting a filing) and that case
should route to human review, not silent extraction. I could not find a source
that resolves this tension algorithmically; treat it as **unresolved by the
literature**, and settle it in Quorum with a short, named, reviewable list —
see Application below — rather than pretending a general filter exists.

### 4. Consolidation and decay

Park et al., *Generative Agents: Interactive Simulacra of Human Behavior*
(ACM UIST 2023, dl.acm.org/doi/fullHtml/10.1145/3586183.3606763) is the
canonical design here. Retrieval scores every memory as a weighted sum of
**recency** (exponential decay, γ=0.995/hour, over *last access* time, not
creation time), **importance** (an LLM-assigned integer at write time), and
**relevance** (embedding similarity to the current context). Separately,
**reflection** periodically synthesizes many raw observations into
higher-level inferences, triggered when the sum of recent importance scores
crosses a threshold — this is the actual "consolidation" step; decay alone
does not consolidate, it only deprioritizes.

Quorum's `config/agent.ts` → `MEMORY.retrieval.weights` (similarity 0.6,
recency 0.2, speakerPresence 0.2) and `recencyHalfLifeDays: 30` are the same
*shape* of formula — a weighted blend including a recency-decay term — but
substitute `speakerPresence` (is the subject active in the current
conversation) for Park et al.'s `importance` (an LLM-assigned salience score).
That substitution is a reasonable adaptation for a multi-party chat context
(topical relevance to who's talking now is a stronger signal than a
context-free importance rating) and should be described as a deliberate
adaptation in `docs/DECISIONS.md`, not left implicit.

**Genuine gap, flagged as uncertain rather than smoothed over:** Quorum has no
reflection/consolidation step. `MEMORY.lifecycle.volatileTtlDays: 30` handles
*decay* (an item stops being retrieved) but nothing in the current design
*merges* many small facts into a summary the way Park et al.'s reflection
does. Given the D-007 cut is about scope discipline, omitting reflection is
consistent with that same discipline — but it is a real absence, not a
confirmed non-requirement, and `tests/memory/lifecycle.test.ts` (already
scaffolded, all `it.todo`) currently tests status-gating and conflict
resolution, not consolidation. This should be named as an explicit v1
non-goal in `docs/DECISIONS.md`, the same way D-007 names the graph cut, so it
reads as a decision rather than an oversight.

### 5. Contradiction handling in production — is delegating to the model the norm?

Yes, and this is useful evidence *for* Quorum's existing D-014, which is
already settled but under-defended. Both systems surveyed delegate:

- **Mem0**: the ADD/UPDATE/DELETE/NOOP choice is made by LLM function-calling
  reasoning over the candidate fact and its nearest neighbors — "no explicit
  confidence scoring mechanism, decisions derive from LLM reasoning rather
  than probabilistic scoring" (finding from the full paper, §"Update
  Mechanism").
- **OpenAI ChatGPT memory** (OpenAI Help Center, "Memory FAQ",
  help.openai.com/en/articles/8590148-memory-faq, and the Feb 2025 product
  announcement openai.com/index/memory-and-new-controls-for-chatgpt): the
  documented example is exactly Quorum's worst case — "I'm training for a
  marathon" vs "I sprained my ankle" — and the stated fix is that the system
  "automatically manages this by updating memories intelligently." No
  deterministic rule is published; the resolution is opaque by design.

**What goes wrong, per the record:** neither company publishes a reproducible
rule, which means neither is falsifiable, testable, or explainable to an end
user or auditor when it picks wrong. That absence of a stated rule *is* the
failure mode D-014 was written to avoid, and it is now backed by a citable
gap in both of the two production systems surveyed, not just an assertion.
This is a legitimate point for the README: "the field's two most-visible
production memory systems both delegate conflict resolution to model
reasoning and publish no deterministic rule; Quorum's ordered rule
(stated > inferred, newer > older, tie → `memory_conflict` event) is a
minority position, deliberately taken because delegation is not
reproducible or testable" — `tests/memory/lifecycle.test.ts` under
"conflict resolution is deterministic" is exactly the artifact that
substantiates this claim.

### 6. Memory poisoning: what does `source_type` actually buy?

Real and current. MINJA (Dong et al., *Memory Injection Attacks on LLM Agents
via Query-Only Interaction*, arXiv:2503.03704) demonstrates a query-only
attack achieving reported >95% injection success and ~70% attack success under
tested conditions, without any privileged write access — an attacker only
needs to be a normal conversational participant. A broader systematic study,
*From Untrusted Input to Trusted Memory: A Systematic Study of Memory
Poisoning Attacks in LLM Agents* (arXiv:2606.04329), builds a six-class attack
taxonomy and is explicit that **source/provenance tracking alone is not a
sufficient defense**: it names "Source Attribution Failure" (V-M2) as a core
vulnerability — "the model cannot reliably determine the origin of the
content" — and argues defenses must act at the *write path*, not just tag
inputs, because low-signal attacks carry no syntactic anomaly to detect.

**What `source_type` buys Quorum, concretely, and what it does not:**
`memory_items.source_type` (`'stated'|'inferred'`) is stronger than the
typical case in these papers because Quorum's provenance is a **database
fact**, not a model self-report — `origin_message_id` joins to
`messages.sender_id`, so "who said this" is not something the model asserts
about itself, it's a foreign key. `tests/memory/lifecycle.test.ts` already
encodes the right invariant: *"an item asserted by a third party is stored as
inferred, not stated."* That closes the most direct poisoning vector (Alice
cannot make the agent treat a claim as Bob's own stated fact about himself).

What it does **not** close: a false claim asserted *about* someone else by a
third party is still stored, just at `source_type = 'inferred'` — which,
per `MEMORY.extraction.confidenceThreshold`, is still eligible for storage and
eventual surfacing if confidence clears 0.6. `source_type` distinguishes *who*
said it, not *whether it's true*. A malicious but plausible-sounding false
statement about a colleague ("Bob told me Alice missed the filing deadline")
passes the stated/inferred check cleanly. This is the taxonomy paper's V-M2
point applied directly to Quorum: attribution ≠ verification. There is no
cheap deterministic fix for this within a 12-hour build; the honest position
is that `source_type` is a defense against **misattribution**, not against
**fabrication**, and the README should say exactly that rather than imply
provenance solves poisoning generally.

### 7. Scoped/partitioned memory: who else has solved cross-audience leakage

Two comparisons, one strong and primary, one orientation-only:

- **Anthropic's own memory tool** (platform.claude.com/docs — "Memory tool")
  is the single most load-bearing citation in this report for Quorum's
  overall architecture, because it is the vendor of the model Quorum calls
  stating, in its own documentation, that scoping is entirely **not** the
  model's job: *"The memory tool operates client-side… Your application
  executes each request against storage you control… Memory lives entirely in
  your application."* Anthropic ships no cross-conversation authorization
  logic at all — it is explicitly out of scope for the API and pushed to the
  caller. This directly validates Quorum's core architectural bet
  (`lib/db/scoped-agent.ts` + `memory_audience` doing the scoping, never the
  model): it is not an invented precaution, it is the documented gap the
  model provider itself says the application must fill.
- **Enterprise search / RAG access control** ("early binding" vs "late
  binding," a pre-LLM enterprise-search term revived by vendors like Glean):
  early binding applies the permission filter *at retrieval time, before
  ranking*; late binding ranks first and filters after, which the sources
  describe as "computationally expensive and dangerous" and prone to serving
  content a user's access was already revoked for. This is orientation-level
  evidence only (the sources found were vendor blogs, not a spec or paper) —
  it is *consistent with* Quorum's FILTER→RANK→CAP ordering and gives that
  ordering a name from an adjacent field, but it should not be cited in the
  README as an authority, only as "this pattern has a name elsewhere and
  Quorum follows the same ordering for the same reason."

### 8. The graph question, concretely — three product queries

This is the deliberately decisive sub-question. Three candidate queries,
evaluated against what relational Postgres can and cannot do, and against
what the graph-memory literature itself reports:

1. **"What does the agent know about Alice?"** — a single-hop lookup by
   `subject_user_id`. Trivial in SQL (`WHERE subject_user_id = ? AND status =
   'active'`). Mem0's own benchmark (LOCOMO, from the arXiv:2504.19413 paper)
   shows its flat/vector variant *beating* its graph variant here (single-hop
   J=67.13 vs 65.71 for Mem0g) — the graph adds overhead with no benefit on
   exactly this query shape.
2. **"Through what chain of people/chats did this fact reach this
   conversation?"** — a genuine multi-hop provenance-chain query, the shape
   graphs are built for. But it is not a feature the brief, the README, or
   `docs/ARCHITECTURE.md` asks for anywhere — Quorum's authorization model
   deliberately reduces this to a single set-containment check against a
   frozen `memory_audience` snapshot, not a path query. Nothing in the product
   surface currently asks "how did this fact travel," only "may this chat see
   it," and those are different questions with different costs.
3. **"How has the client's requirement changed over time?"** — temporal
   reasoning, the one category where the literature's own numbers show a real
   graph advantage: Mem0g beats Mem0 on temporal reasoning (J=58.13 vs 55.51),
   and Zep/Graphiti (Rasmussen et al., *Zep: A Temporal Knowledge Graph
   Architecture for Agent Memory*, arXiv:2501.13956) was purpose-built for
   exactly this, reporting up to 18.5% accuracy gains on temporal/cross-session
   tasks in the LongMemEval benchmark. This is the strongest case *for*
   reopening D-007 that the literature offers. But Quorum's relational schema
   already has a mechanism for it without graph edges: `memory_items
   .superseded_by` is a self-referencing chain — each fact points at the fact
   that replaced it, ordered by `created_at` — which is a linked list, not a
   graph, and answers "what did we used to believe, and when did that change"
   by walking one foreign key per hop. For the scale this product runs at
   (dozens to low hundreds of memory items per subject, not thousands), that
   chain is a correct, cheap substitute for the one case the evidence
   actually supports.

**Verdict basis:** query 1 is relational's clear win by the literature's own
numbers. Query 2 is real in the abstract but not asked for by this product —
it would be reopened the instant a feature like "show me the trail this fact
traveled" appears in the brief or a stakeholder request, and not before. Query
3 is the literature's genuine graph-favoring case, but is already answered by
`superseded_by`, a relational mechanism that predates this report. **Three
graph-favoring queries cannot be named for this product as currently
specified** — one is answered better without a graph, one is unrequested, and
one is already handled relationally. That is the finding, not an assumption.

If Quorum's product surface ever adds a first-class "show provenance/lineage"
feature (query 2, made real), or if `memory_items` volume grows into the
range where `WITH RECURSIVE` walks over `superseded_by` chains stop being O(1)
(Postgres recursive CTE performance references — e.g. sheshbabu.com/posts/
graph-retrieval-using-postgres-recursive-ctes/ and general practitioner
guidance — note visible degradation into "nested loop joins over exponentially
growing working sets" past roughly 5 hops on multi-million-row tables), that
is the concrete trigger condition for reopening D-007. Neither condition holds
today. This source (Postgres CTE performance) is practitioner-level, cited
for the shape of the degradation curve only, not as an authoritative bound —
flagged as such.

## Application to Quorum

- **`docs/ARCHITECTURE.md` §2** — add one clarifying sentence: `memory_items`
  is semantic memory (CoALA sense); `messages` and `agent_events` are the
  existing episodic layer. No schema change; a naming/framing fix that
  preempts an obvious interview question.
- **`docs/DECISIONS.md`** — add a line (new decision or amend D-013/D-014)
  stating explicitly that Quorum's confidence-threshold gate on extraction
  (`config/agent.ts MEMORY.extraction.confidenceThreshold`) is a deliberate
  departure from the two production systems surveyed (Mem0, ChatGPT memory),
  neither of which publishes a numeric confidence mechanism — so this reads
  as an informed choice, not an assumed norm.
- **`docs/DECISIONS.md`** — add an explicit v1 non-goal: no reflection /
  consolidation step (Park et al.'s sense). `MEMORY.lifecycle` handles decay
  (TTL, supersession) but not merging many small facts into a summary. Naming
  this as a decision, not an oversight, matches the pattern already used for
  D-007.
- **`config/agent.ts` → `MEMORY.extraction`** — add a short, named,
  reviewable exclusion list for what is *never* auto-extracted regardless of
  confidence, modeled on Anthropic's own shipped list (health, government ID
  numbers, immigration status, criminal history) as the sensitive-category
  floor, paired with the positive framing that legal-instrumental facts
  ("governing law," "deadline," "conflict of interest") are exactly the
  in-scope category this product exists to capture. This is a values list in
  code, not a classifier — consistent with every source found (§3), none of
  which derives a general filter.
- **`lib/memory/extract.ts` (t2)** — when writing a `memory_written` event to
  `agent_events`, include `asserted_by_user_id` explicitly in the jsonb
  `payload` (derived from `messages.sender_id` via `origin_message_id`), even
  though it's technically derivable by a join. This costs no migration (the
  extensibility charter already treats `agent_events.payload` as free-form)
  and makes the stated/inferred distinction auditable in the internal view
  without requiring a join at read time — directly answers §6's "attribution
  ≠ verification" gap by making attribution visible, which is the part
  Quorum *can* close even though verification is out of scope for a
  12-hour build.
- **`memory_items.superseded_by`** — keep as-is; document it explicitly as
  the relational substitute for the one graph-favoring case the evidence
  supports (temporal chains, §8 finding 3), so the D-007 write-up in
  `docs/DECISIONS.md` can point at a concrete mechanism rather than an
  assertion that "relational is enough."
- **`tests/memory/lifecycle.test.ts`** — the existing `it.todo` list already
  covers status-gating, deterministic conflict resolution, and the
  stated-vs-third-party-inferred provenance rule (§6). No new test file is
  required by this report; flag that consolidation/reflection (§4) has no
  corresponding test because it has no corresponding feature — consistent
  once the non-goal is written down in `docs/DECISIONS.md`.

## Recommendation

**Closes D-007.** **Confirm the cut.** Ship `memory_items` / `memory_audience`
as a purely relational model; do not build `memory_nodes` / `memory_edges`.

**Reasoning, not concession:** §8 required three concrete product queries a
relational model answers badly and a graph answers well. Only one candidate
(temporal "how did this change over time") has real support in the literature
(Mem0g and Zep both show measurable gains there), and Quorum already answers
it relationally via `superseded_by`. The other plausible candidate
(multi-hop provenance/lineage) is real in the abstract but is not a feature
this product's brief, README, or architecture doc asks for anywhere. Three
cannot be named for *this* product as specified — that is the finding the
research plan asked this report to either produce or fail to produce, and it
failed to produce them, honestly.

**The strongest argument against this recommendation, stated fairly:** the
same evidence that supports the cut also shows graphs winning specifically on
temporal and complex multi-hop relational reasoning (Mem0g: +2.6 points on
temporal J-score; Zep: up to 18.5% accuracy gain on temporal/cross-session
tasks in LongMemEval) — and a legal product is unusually likely to eventually
want exactly that ("how did the client's position evolve," "trace this
instruction back to who authorized it"). The `superseded_by` self-reference
handles the *simple* version of the temporal case (linear supersession) but
would not gracefully handle a genuinely branching provenance question (a fact
partially derived from two others, or a chain that needs to explain *why* it
changed, not just *that* it changed and in what order) — that is a real
ceiling on the relational substitute, not a hypothetical one. If Quorum's
product scope grows to include an explicit provenance/lineage feature as a
selling point rather than an internal audit convenience, the honest position
is that this cut should be revisited then, with a concrete feature to design
against, rather than pre-built now against a feature that does not exist yet.

**What would settle it more conclusively than this report does:** a real
product requirement — a stakeholder or a later assignment revision explicitly
asking for a "show me how this fact traveled" or "chain of custody" view —
would immediately supply the third query this report could not find, and
should trigger reopening D-007 rather than retrofitting the relational schema
under pressure.

## Sources

- Sumers, Yao, Narasimhan, Griffiths — *Cognitive Architectures for Language
  Agents* (CoALA). arXiv:2309.02427. https://arxiv.org/abs/2309.02427 /
  full text via https://ar5iv.labs.arxiv.org/html/2309.02427
- Chhikara et al. — *Mem0: Building Production-Ready AI Agents with Scalable
  Long-Term Memory*. arXiv:2504.19413.
  https://arxiv.org/abs/2504.19413 / full text https://arxiv.org/html/2504.19413
- Rasmussen et al. — *Zep: A Temporal Knowledge Graph Architecture for Agent
  Memory*. arXiv:2501.13956. https://arxiv.org/abs/2501.13956
- Park et al. — *Generative Agents: Interactive Simulacra of Human Behavior*.
  ACM UIST 2023. https://dl.acm.org/doi/fullHtml/10.1145/3586183.3606763
- *From Untrusted Input to Trusted Memory: A Systematic Study of Memory
  Poisoning Attacks in LLM Agents*. arXiv:2606.04329.
  https://arxiv.org/abs/2606.04329 / https://arxiv.org/html/2606.04329v1
- Dong et al. — *Memory Injection Attacks on LLM Agents via Query-Only
  Interaction* (MINJA). arXiv:2503.03704. https://arxiv.org/html/2503.03704
- Anthropic — *Memory tool*, Claude Platform Docs.
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Anthropic — *Claude's memory works everywhere, and you decide what's in
  it*. https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it
- OpenAI — *Memory FAQ*, OpenAI Help Center.
  https://help.openai.com/en/articles/8590148-memory-faq ; and *Memory and new
  controls for ChatGPT*. https://openai.com/index/memory-and-new-controls-for-chatgpt/
- GDPR Article 5 (official consolidated text).
  https://gdpr-info.eu/art-5-gdpr/
- Lee, Eunhae — *Towards Ethical Personal AI Applications: Practical
  Considerations for AI Assistants with Long-Term Memory*. arXiv:2409.11192.
  https://arxiv.org/html/2409.11192v1
- Enterprise-search "early binding vs late binding" access-control retrieval —
  orientation only, vendor sources, not load-bearing alone:
  https://www.luigisbox.com/search-glossary/early-binding/ ;
  https://atlan.com/know/ai-agent/data-for-ai/enterprise-search-with-ai/
- Postgres `WITH RECURSIVE` performance characteristics at depth —
  practitioner-level, cited for the shape of the degradation curve only:
  https://www.sheshbabu.com/posts/graph-retrieval-using-postgres-recursive-ctes/
- This repository: `README.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`
  (D-007, D-013, D-014), `config/agent.ts` (`MEMORY`), `tests/memory/
  isolation.test.ts`, `tests/memory/lifecycle.test.ts`.
