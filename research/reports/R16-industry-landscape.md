# R16 — How the industry scopes AI memory and permissions

**Band:** C · **Closes:** no D-0xx (ammunition/interview track; strengthens the
rationale behind D-005/D-006 but does not gate them) · **Status:** complete

## Question

Quorum's central claim is that memory surfacing is an authorisation problem
solved by a filter-before-rank rule evaluated against a learn-time audience
snapshot. Is this rule idiosyncratic, or does it match how deployed
enterprise-AI systems (Glean, Slack AI, Microsoft Copilot, Notion AI) actually
scope permission-aware retrieval? Where have such systems publicly failed, and
does the failure mode indict the same weak point Quorum is designed against
(filtering after ranking, or trusting the model to self-censor)? Is there a
published name for the audience-containment-plus-clearance-floor rule? This
matters because the interview is the graded artifact for this track — the
value is being able to say "this is how Glean frames it, and here is where
Quorum differs (or doesn't)" without bluffing.

## Findings

1. **How Glean scopes retrieval.** Glean builds an "Enterprise Graph" that
   mirrors source-system ACLs (Slack channel membership, Google Drive sharing,
   Confluence space permissions, etc.) into permission edges between a User
   node and Document nodes. Glean's own material states the search/retrieval
   layer filters candidates by these permission edges **before** the query
   reaches the model — "if you don't have a direct relationship to that
   document's security group in the graph, the search engine physically
   cannot retrieve it" (Glean, "Enhancing AI security with permissions-aware
   frameworks," glean.com/perspectives/security-permissions-aware-ai, and a
   secondary summary at knostic.ai/blog/glean-data-security). This is the
   same **filter-before-rank** structure Quorum's README states as its
   retrieval order, applied to a different data model (ACL mirroring from
   external systems vs. a learn-time membership snapshot native to the
   product). I could not independently verify Glean's ranking internals — the
   above is vendor-published, treated as orientation, not authority.

2. **Where this fails in practice: not the filter design, the permission
   data feeding it.** Every documented enterprise-AI oversharing incident
   found for this report is a **permission-data problem**, not a
   filter-vs-rank-ordering problem. Microsoft 365 Copilot's well-documented
   "oversharing" failure mode is that Copilot enforces the *existing*
   SharePoint/Teams permission model faithfully — the incident is that the
   underlying permission model itself is sloppy (years of overly broad
   sharing grants), so Copilot's fast natural-language search surfaces
   whatever a user *technically* had access to but never used. One cited
   internal case (Microsoft incident CW1226324, reported via nhimg.org and
   corroborated by multiple secondary write-ups — I did not locate a
   Microsoft-primary incident report, so treat the specific number/case ID as
   secondary-sourced) had Teams Copilot surfacing HR investigation and
   executive-comp threads to users who held standing but unused access. This
   is directly relevant to Quorum's audience-*snapshot* design (finding 6
   below): a live-membership check without snapshotting would have the same
   failure shape — "technically still a member, practically shouldn't see
   this" is exactly the oversharing pattern, just inverted (Quorum's problem
   is stale membership, Copilot's is stale grants).

3. **Slack AI's 2024 leak was a prompt-injection bypass of the trust
   boundary, not a filter-ordering bug.** PromptArmor's disclosure (via
   simonwillison.net/2024/Aug/20/data-exfiltration-from-slack-ai/ and
   theregister.com/2024/08/21/slack_ai_prompt_injection/) found that Slack
   AI's retrieval correctly scoped *which channels* a query could pull from,
   but a message posted in an *attacker-controlled public channel* could
   contain injected instructions that, once retrieved alongside a victim's
   legitimate private-channel content in the same context window, caused the
   model to exfiltrate the private content by embedding it in a
   phishing-style link the model was tricked into constructing. The
   authorisation filter worked; the leak happened downstream of retrieval,
   inside the model's context, because untrusted retrieved content was not
   separated from the "instructions" channel. This is a direct hit on
   Quorum's R7 concern (tool/content trust boundary) rather than R16's
   memory-scoping concern, but it is the sharpest available evidence that
   **"filter what's retrieved" and "prevent what the model does with what
   it retrieves" are two different problems that both must be solved** —
   Quorum solves the first structurally (SQL filter) but the README does not
   yet make an equivalent structural claim about the second for tool content
   (that's R7's job, not this report's).

4. **No named term found for the specific audience-snapshot-plus-clearance
   rule.** Searches for the access-control literature (NIST SP 800-162 on
   ABAC, NIST SP 1800-3B) surface the general vocabulary Quorum's rule is an
   instance of: this is an **attribute-based access control (ABAC)** policy —
   membership and clearance are both attributes evaluated per-request against
   a resource, rather than a static role grant. "Filter before rank" in RAG
   security literature is sometimes called ensuring the retrieval index
   itself is permission-scoped (as opposed to post-hoc redaction) — the arXiv
   survey "Towards Secure Retrieval-Augmented Generation" (arxiv.org/pdf/2603.21654)
   frames access control as "the most fundamental and critical first line of
   defense in the RAG security architecture" and separately warns that even
   correct document-level ACLs can be bypassed by an LLM's cross-document
   inference ("aggregation" attacks) — i.e., a model can reconstruct a
   forbidden fact from several individually-authorised fragments. I found
   **no published name specific to "learn-time audience snapshot that only
   narrows"** — this appears to be closer to a capability/attenuation
   pattern from the capability-security literature (a capability, once
   granted, is not silently revoked by later state changes) than to anything
   named in enterprise-RAG vendor material. This sub-question is **not
   settled**: I did not find a paper or spec using this exact framing, and I
   would not claim one exists in the README. What would settle it: a
   full-text search of access-control conference proceedings (SACMAT, ACM
   CCS) for "provenance-scoped" or "snapshot-scoped" retrieval — out of scope
   for a 4-source pass.

5. **Notion AI / other vendors** were not reached with a primary source in
   this pass (time-boxed to 4 sources; budget spent on Glean, Copilot, Slack,
   and the ABAC/RAG-security literature, which is where the load-bearing
   claims live). This is a real gap, flagged rather than smoothed over — if
   this track is revisited, Notion AI's published permission model
   (notion.so trust/security docs) is the next primary source to pull.

6. **The aggregation-attack point (finding 4) is the strongest thing this
   track surfaces for Quorum specifically.** Quorum's filter operates on
   whole memory *items*, each with one audience snapshot. It does not defend
   against a user asking two separately-authorised questions in the same
   chat and inferring a third, unauthorised fact by combining the answers
   in their own head — no system reviewed here claims to solve that either;
   the arXiv survey names it as an open problem, not a solved one.

## Application to Quorum

- **README wording.** The current sentence "Structural prevention, not
  probabilistic mitigation" (README, "The surfacing rule") is defensible and
  matches how Glean frames its own architecture — cite it there:
  `README.md` around line 62 could add one clause: *"This is the same
  filter-before-rank structure Glean's Enterprise Graph uses for
  permission-aware search (Glean, 2025)."* That is a claim this report can
  support without overreach, because it's about retrieval-ordering, not
  about matching Glean's implementation.
- **`docs/DECISIONS.md` D-006 (audience is a learn-time snapshot)** gets a
  stronger "why": the Copilot oversharing pattern is evidence that a
  *live*-membership check (rather than a snapshot) reproduces the same class
  of bug Copilot ships today, just triggered by membership growth instead of
  permission-grant sprawl. Worth one added sentence in D-006's **Why**.
- **`research/RESEARCH.md` R7 (prompt injection through tools)** should cite
  the Slack AI incident directly — it is a primary example of exactly the
  exfiltration channel R7 sub-question 4 asks to enumerate ("a rendered link
  with data in the query string" — this is *precisely* what the Slack AI
  attack did). When R7 is written, `lib/agent/tools/` should treat this as a
  concrete precedent, not a hypothetical.
- **No schema or config change is implied by this track.** R16 is Band C —
  ammunition for the interview, not a build input. It does not touch
  `lib/memory/retrieve.ts` or any migration.

## Recommendation

This track closes no open decision in `docs/DECISIONS.md` (R16 is explicitly
Band C / ammunition per `research/RESEARCH.md`). The closest thing to a
recommendation: **keep D-005/D-006 as written** (filter-before-rank,
learn-time snapshot) — the industry evidence, thin as it is, is
directionally consistent rather than contradictory.

**Strongest argument against relying on this comparison at all:** every
primary incident found here (Copilot, Slack AI) is evidence about what goes
wrong in systems with *orders of magnitude* more surface area — federated
connectors across a dozen SaaS products, years of accumulated permission
grants, and models generating free-form links and summaries. Quorum's
schema is closed-world (one Postgres instance, memory items with one
audience snapshot each), so the comparison is suggestive, not
load-bearing — an interviewer could reasonably say "you're citing enterprise
incidents to validate a toy-scale system," and that objection is fair. The
honest framing is: these incidents describe the *shape* of the failure mode
this design defends against, not proof that Quorum's specific implementation
would have avoided them.

**What would settle the unresolved sub-question (a published name for the
snapshot-narrows-only rule):** a targeted search of access-control academic
venues (SACMAT/CCS proceedings, not general web search) for "attenuating
capability" or "provenance-bound" access patterns — not done here due to the
4-source budget.

## Sources

- Glean, "Enhancing AI security with permissions-aware frameworks" — https://www.glean.com/perspectives/security-permissions-aware-ai (vendor primary, orientation-level authority)
- Knostic.ai, "Glean Secures LLM Search. Who Stops Oversharing?" — https://www.knostic.ai/blog/glean-data-security (secondary, corroborating)
- nhimg.org, "Microsoft 365 Copilot oversharing: what IAM and data teams must fix" (cites Microsoft incident CW1226324) — https://nhimg.org/community/cybersecurity-beyond-identity/microsoft-365-copilot-oversharing-what-iam-and-data-teams-must-fix/
- Simon Willison, "Data Exfiltration from Slack AI via indirect prompt injection" (summarizing PromptArmor's disclosure) — https://simonwillison.net/2024/Aug/20/data-exfiltration-from-slack-ai/
- The Register, "Slack AI can leak private data via prompt injection" — https://www.theregister.com/2024/08/21/slack_ai_prompt_injection/
- "Towards Secure Retrieval-Augmented Generation: A Comprehensive Review of Threats, Defenses and Benchmarks" (arXiv) — https://arxiv.org/pdf/2603.21654
- NIST SP 800-162 / SP 1800-3B, Attribute-Based Access Control — https://www.nccoe.nist.gov/sites/default/files/legacy-files/abac-nist-sp1800-3b-draft.pdf
