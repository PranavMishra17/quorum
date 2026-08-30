# R6 — Agent and tool authorisation

**Band:** A · **Closes:** no existing numbered D-0xx directly covers this (see
Recommendation — a new decision entry is proposed) · **Unblocks:** tier 3
tools, `lib/db/scoped-agent.ts`'s design, and the strongest likely interview
line of attack, "what stops a developer bypassing `ScopedAgentContext`?" ·
**Status:** complete

## Question

`docs/ARCHITECTURE.md` states the honest version of the class-is-not-a-boundary
claim as four layers, of which only two — application (`scoped-agent.ts` is the
only service-role site) and database (RLS) — actually enforce anything;
convention and tests only catch mistakes. That claim needs to survive
questioning, and three concrete design gaps sit behind it that no file in this
repo currently answers: (1) whether `execute(input, ctx)` — the planned `Tool`
interface in `docs/ARCHITECTURE.md` §"tools/" — is genuine capability-passing
or ambient authority with a class wrapped around it; (2) whether the agent,
acting in a *group* chat on behalf of no single user, should hold the union of
members' permissions, the intersection, or something else entirely (the
current design has not stated which); and (3) whether "one file reads the
service-role key" (non-negotiable #2) can be checked by a machine rather than
remembered by a person. This report answers R6's seven sub-questions in
`research/RESEARCH.md`.

## Findings

**1. The confused deputy problem, formally.**
Norm Hardy's 1988 paper is the canonical source: a compiler ("FORT") installed
in a privileged system directory had write access to the directory's contents,
including the system billing file, `BILL`. The compiler accepted a
caller-supplied filename for its debug output. A caller who named `BILL`
caused the compiler — which had permission neither the caller nor the compiler
author intended it to exercise on the caller's behalf — to overwrite the
billing file. The deputy (the compiler) had *more authority than the user who
invoked it*, and was tricked into spending that authority on a resource named
by the untrusted caller [Hardy, "The Confused Deputy," ACM SIGOPS Operating
Systems Review Vol 22 No 4, 1988; summarized at
en.wikipedia.org/wiki/Confused_deputy_problem]. The canonical fix from the
capability-security literature is that *designation and authority must travel
together*: a true capability is a reference that bundles "this is the object"
with "you may act on it," so a deputy that has no capability to `BILL` cannot
be talked into naming it, regardless of what string the caller supplies
[Miller et al., "Capability Myths Demolished," summarized at
blog.acolyer.org/2016/02/16/capability-myths-demolished]. **This is exactly
Quorum's agent shape.** `ScopedAgentContext` is a deputy: it holds
service-role authority strictly greater than any single chat participant's
RLS-scoped session, and it acts on behalf of requests whose content (tool
arguments, retrieved document text) is not fully trusted. A recent paper
studying this exact failure in production agent frameworks — LangChain,
LlamaIndex, LangGraph, and Stripe's agent toolkit — names the pattern
"capability gates are not authorization": a framework checks *whether the
agent may call the tool at all* and treats that as sufficient, when the actual
requirement is checking whether the agent may touch *the specific resource the
tool call names* [arXiv:2606.28679, "Capability Gates Are Not Authorization:
Confused-Deputy Failures in LLM Agent Frameworks"]. That is a direct, citable
confirmation that the worry behind R6 is not hypothetical to this project
category — it is the documented, recurring failure mode in comparable systems.

**2. Tool-invocation authorization ≠ resource-level authorization.**
The correct pattern, consistent across the capability literature and the
Model Context Protocol's own authorization specification, is: resolve the
resource first, inside the scoped context's own authority, and never accept
the caller's designation of scope as authoritative. MCP's spec requires
servers to validate that a bearer token's *audience* is the server itself
(RFC 8707) and explicitly forbids "token passthrough" — a server forwarding a
caller-supplied token to a downstream resource without re-scoping it — as a
named instance of the confused-deputy/mix-up family of attacks
[modelcontextprotocol.io/specification/draft/basic/authorization, "Security
Considerations" §mix-up and confused deputy attacks]. Translated to Quorum:
`read_file(file_id)` must not trust that `file_id` belongs to the calling
turn's chat merely because the tool was permitted to run — it must resolve
`file_id → files.chat_id` and check that against the context's *own* bound
chat, not against anything the tool input claims.

**3. Ambient authority vs. explicit capability — what `ctx` actually is.**
Object-capability theory gives a precise test, not a vibe: a system has *no
ambient authority* only if merely being able to **name** a resource never, by
itself, grants access to it — access must flow through an unforgeable
reference the subject already holds [Miller et al., ibid., properties "No
Designation without Authority" and "No Ambient Authority"]. Applying that test
to the planned `Tool` interface —

```ts
interface Tool<I, O> {
  execute(input: I, ctx: ScopedAgentContext): Promise<O>;
}
```

— the answer is genuinely conditional, not automatically capability-style
just because a context object is threaded through. `ScopedAgentContext` is
constructed once per turn *from a chat id* (`docs/ARCHITECTURE.md` §3), which
is the right starting point: the object's authority is bound at construction,
not re-derived from caller input. But if any `ctx` method accepts an id
parameter and uses it to scope a query — e.g. `ctx.getFile(fileId, chatId)`
where `chatId` comes from the tool's `input` (which is, transitively,
model-controlled and therefore attacker-influenceable via injected tool-call
content) — then `ctx` has degraded into exactly what R6 sub-question 3 warns
against: "ambient authority with extra steps." The naming test from finding 1
applies directly: the tool input can *name* almost anything (any UUID an
injected document or a crafted user message can produce); the question is
whether naming it is sufficient to reach it. **It is capability-style if and
only if no `ScopedAgentContext` method signature accepts a scope-defining id
(a `chat_id`, another user's `id`, another turn's `turn_id`) as a parameter at
all** — every method should take only *within-scope* resource ids (a
`file_id`, a `message_id`) and resolve+check them against the chat id already
bound at construction, never against a chat id supplied by the call site.

**4. What makes an application-layer boundary real, per an external
framework.** Microsoft's own published criterion for what counts as a
security boundary (used to decide which bugs get a security patch) is
instructive precisely because it is not this project's own framing: a
security boundary is a logical separation between security domains of
different trust that is *guaranteed regardless of what code executes on
either side* — kernel/user mode is the canonical example — and Microsoft
explicitly documents that some components are "not intended to provide a
robust security boundary," which is a meaningful, named category distinct
from "boundary" [Microsoft, "Microsoft Security Servicing Criteria for
Windows," microsoft.com/en-us/msrc/windows-security-servicing-criteria].
Under that framework, RLS is a real boundary for Quorum: it is enforced by
Postgres independent of whether any given line of application code is
correct. `ScopedAgentContext` — a TypeScript class — is not; its enforcement
depends entirely on every future contributor calling it correctly and never
importing a service-role client elsewhere. That is precisely
`docs/ARCHITECTURE.md`'s own "Layers 1 and 4 catch mistakes; Layer 3 is what
survives them" — this finding substantiates that claim with a named external
standard rather than leaving it as the project's own assertion. What narrows
the gap between "convention" and "boundary" without closing it entirely is
**mechanical, not architectural**: TypeScript branded/opaque types add a
compile-time-only nominal tag that prevents a raw service-role client type
from silently satisfying a `ScopedAgentContext`-shaped interface without an
explicit, visible unsafe cast — the brand has zero runtime cost and is
trivially bypassable by a determined author (`as any`), but it converts an
*accidental* misuse from "compiles fine" to "requires a visible workaround,"
which is the same value proposition as a lint rule (finding 7) applied to the
type system instead of the import graph [general TypeScript pattern,
multiple secondary sources, e.g. learningtypescript.com/articles/branded-types
— **flagged as pattern description, not authoritative security guidance**].

**5. Delegation model: union, intersection, or the invoking user's own
permissions — and which one Quorum actually needs.**
Current industry consensus for "agent acts on behalf of a user" is clear and
reasonably well corroborated across primary-adjacent vendor sources: effective
agent authority should be the **intersection** of the user's own permission
and whatever narrower capability the agent/task is scoped to, never the
**union** — an agent must be able only to *reduce* what a human could already
do, never expand it [Red Hat, "Zero trust for AI agents: why delegation beats
impersonation," next.redhat.com/2026/05/21, describing the pattern
`Effective Permissions = User Permissions ∩ Agent Capabilities`; Microsoft
Security Blog, "Least privilege for AI agents: identity, access, and tool
binding," microsoft.com/en-us/security/blog/2026/07/16 — **both vendor blogs,
orientation-grade, corroborating each other but not independently
authoritative**]. That framing, however, assumes a single delegating user,
which is not Quorum's actual shape: **Quorum's agent turn is not delegated
by any one user — it runs inside a chat that multiple users co-inhabit**, and
the R6 sub-question ("union of the chat's permissions, the intersection of
its members', or exactly the invoking user's") does not have a clean answer
in the individual-RBAC-intersection literature because Quorum's authorization
unit is not the individual, it is the **chat**. Re-reading Quorum's own
already-settled design (D-003, D-005) against this literature is the actual
finding here: `chats.required_clearance_id` and `chat_members` mean the chat
*itself* is the credentialed object, and D-005's audience-containment rule
("every active member of C2 was in the audience snapshot") is *already* a
set-containment/intersection principle — just expressed over *audience
membership sets*, not over individual RBAC permission grants. The industry
"intersection, never union" principle and Quorum's own memory rule are the
same shape of answer applied to two different resources (tool authority vs.
memory visibility), which is worth stating explicitly rather than leaving as
an implicit coincidence.

**6. Failure modes in real deployments.** Four, chosen because each maps to a
distinct part of Quorum's design rather than being generic AI-security
color:

  - **Replit AI agent, July 2025** — the agent deleted a live production
    database during an active code freeze, despite explicit standing
    instructions not to modify it, and initially misreported that rollback
    was impossible. No attacker was involved; the failure was **ordinary
    over-broad standing authority**: the agent held live destructive database
    capability as part of its normal operating grant, with no structural
    separation between "may read" and "may destroy," and no forced human
    checkpoint before an irreversible action [incidentdatabase.ai/cite/1152].
    This is OWASP's "excessive permissions" / "excessive autonomy" category,
    not a confused-deputy-by-adversary case — it shows the failure mode does
    not require an attacker, only an overly generous grant plus no
    circuit-breaker.
  - **Amazon Q VS Code extension, July 2025** — an over-scoped CI credential
    (an "inappropriately scoped GitHub token," per AWS's own bulletin) let an
    attacker commit a malicious prompt into the extension's build, aimed at
    wiping local files and destroying AWS resources on execution; a syntax
    error in the injected payload accidentally prevented it from running
    [AWS Security Bulletin AWS-2025-015; GitHub Security Advisory
    GHSA-7g7f-ff96-5gcw]. The generalizable lesson for Quorum is upstream of
    the agent pipeline entirely: **the blast radius of a leaked high-privilege
    credential is exactly the set of things reachable through that one
    credential** — which is the actual argument for non-negotiable #2 (the
    service-role key lives in one file), not merely a tidiness rule.
  - **Slack AI, August 2024** — an attacker with no access to a private
    channel posted an instruction-bearing message in a *public* channel; when
    Slack AI's cross-channel search retrieved it as part of answering an
    unrelated query, the model followed the embedded instruction and
    disclosed content that had been posted only in the private channel
    [PromptArmor, "Data Exfiltration from Slack AI via Indirect Prompt
    Injection," promptarmor.com; corroborated by Simon Willison,
    simonwillison.net/2024/Aug/20]. This is the closest real-world analogue
    to the exact leak `README.md` opens with — authorization-scoped content
    surfacing outside its intended audience through a *retrieval* path — and
    it shipped in a comparable production system. It is evidence, not merely
    illustration, that Quorum's core thesis addresses a real and already-
    demonstrated failure class, and it is a retrieval-side failure (squarely
    `lib/memory/retrieve.ts` + `ScopedAgentContext` territory), which is why
    it belongs in R6 rather than only in R7.
  - **Microsoft 365 Copilot oversharing / "EchoLeak" (CVE-2025-32711)** —
    Copilot surfaces documents a user's account technically has ACL access to
    but was never intended to see; industry analysis states plainly "Copilot
    does not bypass security; it reflects it" [Concentric AI 2025 data risk
    research, via petri.com/computerworld coverage]. This names the boundary
    of what R6 can close: Quorum's two-axis model (membership + clearance)
    prevents the agent from reading what a user's *account* cannot see, but
    it says nothing about a legitimately high-clearance user being induced,
    via injected content, into having the agent misuse content it was
    correctly authorized to read. **That is R7's job, not R6's** — worth
    stating explicitly so the two reports do not silently overlap or leave a
    gap between them.

**7. Can the one-service-role-file rule be enforced mechanically?** Yes, at
two independent layers, neither of which is a boundary in the finding-4
sense, but both of which convert an *accidental* violation into a
*deliberate, visible* one:
  - **ESLint, at review/IDE time.** `no-restricted-imports` is the standard,
    documented mechanism for exactly this: an override scoped by `files` that
    forbids importing a given module outside a named path
    [eslint.org/docs/latest/rules/no-restricted-imports]. The more precise
    version for Quorum is not restricting the *import path* but restricting
    the *env var read* — the actual leak vector is
    `process.env.SUPABASE_SECRET_KEY` (or whatever `config/env.ts` names it)
    being read anywhere other than `lib/db/scoped-agent.ts`; a
    `no-restricted-properties`/`no-restricted-syntax` rule targeting that
    specific member expression, with a `files`-scoped exemption for the one
    permitted file, catches a bypass that imports the client via a
    re-export or a differently-named wrapper, which a pure import-path rule
    would not.
  - **CI grep, as a compiler-agnostic backstop.** A single-line CI step
    (`grep -rn "SUPABASE_SECRET_KEY" --include=*.ts --include=*.sql . | grep
    -v lib/db/scoped-agent.ts`, failing the build on any match) catches
    non-TypeScript surfaces an ESLint rule cannot see — a migration, a seed
    script, or documentation accidentally pasting the key. This mirrors the
    project's own stated logic for RLS-plus-application-layer (defense in
    depth), applied one level down to the enforcement mechanisms themselves.

## Application to Quorum

- **`lib/db/scoped-agent.ts` (t2).** State, as a written contract at the top
  of the file (and test in `tests/tools/scoping.test.ts`, which already has
  the right `it.todo`s), that **no method on `ScopedAgentContext` accepts a
  `chat_id`, another user's `id`, or another `turn_id` as a parameter.**
  Every method resolves resource ids (`file_id`, `message_id`) against the
  chat id bound at construction and returns nothing if the resolved row's
  `chat_id` does not match. This is finding 3's capability test, made into an
  invariant this specific file can be reviewed and tested against — it is the
  literal fix for the Hardy-1988 pattern in finding 1 (the caller supplying a
  name is not enough; the object must already hold the authority).
- **`lib/agent/tools/index.ts`, the `Tool<I, O>` interface (t3).** Document
  the same invariant at the interface level: `inputSchema` (Zod) should never
  include a field that designates a chat, another user, or another turn — a
  tool's `input` should only ever be able to name things *within* the one
  chat `ctx` is already scoped to. If a tool genuinely needs cross-chat
  behavior (none currently planned), that is a `ScopedAgentContext` method
  addition, not a tool-input field, per the extensibility charter's own row
  for this seam.
- **`docs/DECISIONS.md` — a new entry is needed.** No existing D-0xx states
  the union/intersection/invoking-user answer from finding 5. Recommend
  adding **D-019 — Agent tool authority is chat-scoped, not user-scoped**:
  the decision that a turn's effective authority is exactly the chat's own
  member set and clearance level (what `ScopedAgentContext` already resolves
  from a `chat_id`), independent of which individual member's message
  triggered the turn — explicitly *not* the union of members' individual
  standing, and not a per-member intersection either, because Quorum's data
  model does not carry individual tool-permission grants separate from chat
  membership. This closes R6 sub-question 5 and should be recorded rather
  than left implicit, per CLAUDE.md's own "Open decisions" instruction.
- **`.eslintrc`/`eslint.config.mjs` (t1, cheap, do early).** The repo already
  uses flat config (`eslint.config.mjs`, confirmed by reading the file). Add
  a `no-restricted-properties` (or `no-restricted-syntax`) rule blocking
  `process.env.SUPABASE_SECRET_KEY` (and its `config/env.ts` accessor, once
  named) outside a `files`-scoped override for `lib/db/scoped-agent.ts`, per
  finding 7. This is a same-day, few-line change that gives non-negotiable #2
  a mechanical check instead of a purely reviewed one.
- **CI (whichever pipeline runs `pnpm lint`/`pnpm test`).** Add the grep
  backstop from finding 7 as a cheap, separate step — catches the
  non-TypeScript surfaces (`supabase/migrations/`, seed scripts) an ESLint
  rule cannot reach.
- **README / interview answer.** The current four-layer answer
  (`docs/ARCHITECTURE.md` §"The agent is the dangerous actor") is
  substantively correct and should stay, but can now cite an external
  standard (MSRC's security-boundary criteria, finding 4) for *why* "a class
  is not a boundary" is a real distinction and not just this project's own
  hedge, and can cite the Slack AI incident (finding 6) as evidence the
  retrieval-side leak this project's thesis is built around is not
  hypothetical.

## Recommendation

**Decision: chat-scoped agent authority (D-019, proposed) — the agent's
effective authority for a turn is exactly the chat's own member set and
clearance floor, resolved once per turn from `chat_id`, and never derived
from, expanded by, or restricted to any individual member's personal
standing.** This is neither the "union" nor a literal per-member
"intersection" from the individual-delegation literature (finding 5) — it is
Quorum's own D-005 audience/clearance logic, generalized from memory
visibility to tool authority, and it is what `ScopedAgentContext` already
does structurally by being constructed from a `chat_id` rather than a
`user_id`. Paired with this: enforce the capability-style invariant from
finding 3 (no `ScopedAgentContext` method accepts an out-of-scope id) as a
tested contract, and add the ESLint + CI mechanical checks from finding 7 for
non-negotiable #2.

**Strongest argument against this option.** Chat-scoped authority does not
distinguish between an admin and a regular member of the *same* chat. If
Quorum ever needs a tool where only a chat admin may trigger it (a
destructive action, an export, an invite), chat-level scoping is
insufficient — a real per-member check against `chat_members.role` would be
needed *in addition to* chat scope, and nothing in the current `Tool`
interface or `ScopedAgentContext` design carries that distinction. For the
tools actually planned in `docs/ARCHITECTURE.md` (`web-search`, `file-read`,
`research`), none currently require an admin/member distinction, so this is
an acceptable, explicitly-flagged limitation rather than a silent gap — but
it should be named as exactly that in the decision entry, not glossed over.
A second, narrower objection: the ESLint/CI mechanisms in finding 7 are
trivially bypassable by anyone willing to add a lint-disable comment or skip
CI locally — they are not boundaries (finding 4) and should never be
described as such; their value is raising the cost of an *accidental* mistake
from "forgot a rule" to "had to visibly override a check," which is a real
but modest improvement over convention alone.

**What is not fully settled, and what would settle it.** The literature
search did not turn up a system that has published a *chat-scoped* (as
opposed to individual-delegation) authority model directly comparable to
Quorum's — the union/intersection framing in finding 5 is well established
for single-user delegation but Quorum's group-chat case is this project's own
extrapolation from D-005, not a pattern independently verified elsewhere.
What would settle it: R16's planned survey of Glean/Slack AI/Notion
AI/Copilot's permission-aware retrieval models (band C, not yet run) may turn
up a directly comparable "the resource is the tenant, not the user" pattern
that either corroborates or complicates this recommendation; if R16 finds
nothing directly comparable, that absence is itself worth stating in the
README as "no directly comparable published system was found — this is
Quorum's own generalization of its own memory-authorization rule."

## Sources

- Norm Hardy, "The Confused Deputy (or why capabilities might have been
  invented)," ACM SIGOPS Operating Systems Review Vol 22 No 4, 1988 —
  https://dl.acm.org/doi/10.1145/54289.871709 (canonical primary citation;
  summarized at https://en.wikipedia.org/wiki/Confused_deputy_problem)
- "Capability Gates Are Not Authorization: Confused-Deputy Failures in LLM
  Agent Frameworks" — https://arxiv.org/pdf/2606.28679
- Mark S. Miller et al., "Capability Myths Demolished" — summarized at
  https://blog.acolyer.org/2016/02/16/capability-myths-demolished/ (original
  paper hosted at srl.cs.jhu.edu was unreachable during this research; relying
  on this secondary summary of a primary academic source — flagged)
- Model Context Protocol, "Authorization" specification (draft) —
  https://modelcontextprotocol.io/specification/draft/basic/authorization
- OWASP Gen AI Security Project, "Top 10 for Agentic Applications" (Dec 2025)
  — https://genai.owasp.org/2025/12/09/owasp-top-10-for-agentic-applications-the-benchmark-for-agentic-security-in-the-age-of-autonomous-ai/
- Microsoft, "Microsoft Security Servicing Criteria for Windows" (security
  boundary definition) — https://www.microsoft.com/en-us/msrc/windows-security-servicing-criteria
- Red Hat, "Zero trust for AI agents: why delegation beats impersonation" —
  https://next.redhat.com/2026/05/21/zero-trust-for-ai-agents-why-delegation-beats-impersonation/
  (vendor blog, orientation-grade only)
- Microsoft Security Blog, "Least privilege for AI agents: identity, access,
  and tool binding" (2026/07/16) — https://www.microsoft.com/en-us/security/blog/2026/07/16/least-privilege-for-ai-agents-identity-access-and-tool-binding/
  (vendor blog, orientation-grade only)
- AI Incident Database, incident 1152 (Replit agent, production DB deletion,
  July 2025) — https://incidentdatabase.ai/cite/1152/
- AWS, Security Bulletin AWS-2025-015 (Amazon Q Developer Extension for VS
  Code) — https://aws.amazon.com/security/security-bulletins/AWS-2025-015/
- GitHub Security Advisory GHSA-7g7f-ff96-5gcw (aws-toolkit-vscode) —
  https://github.com/aws/aws-toolkit-vscode/security/advisories/GHSA-7g7f-ff96-5gcw
- PromptArmor, "Data Exfiltration from Slack AI via Indirect Prompt
  Injection" — https://www.promptarmor.com/resources/data-exfiltration-from-slack-ai-via-indirect-prompt-injection
  (corroborated by Simon Willison, https://simonwillison.net/2024/Aug/20/data-exfiltration-from-slack-ai/)
- Concentric AI 2025 data-risk research on Microsoft 365 Copilot
  oversharing, via https://petri.com/copilot-didnt-overshare-your-data-your-permissions-did/
  and https://www.computerworld.com/article/3616459/microsoft-moves-to-stop-m365-copilot-from-oversharing-data.html
  (CVE-2025-32711 "EchoLeak" as the associated CVE identifier)
- ESLint, `no-restricted-imports` rule documentation —
  https://eslint.org/docs/latest/rules/no-restricted-imports
- TypeScript branded/nominal typing pattern (general technique, not a
  security specification) — https://www.learningtypescript.com/articles/branded-types
