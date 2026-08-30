# R5 — When should an agent speak?

**Band:** A · **Closes:** the gate judge design (D-008 implementation detail — the
deterministic chain in D-008 is settled; this report is scoped to the judge that
runs when the chain falls through) · **Status:** complete

## Question

The deterministic chain in `config/agent.ts` / `lib/agent/gate.ts` (rules 1–6,
README lines 142–157) is settled and out of scope here. What is unsettled is the
judge that runs when none of the six rules fire: what context it sees, what
shape its verdict takes, whether `GATE.judgeSpeakThreshold = 0.7` is a real
number or theatre, and — because the judge is the one non-deterministic
component in an otherwise provable pipeline — how it can be tested at all
inside a 12-hour build. This matters specifically for Quorum because the
project's whole pitch is that the risky decisions are structural and provable;
the judge is the one place that claim cannot be made, so the honest scope of
that exception needs to be stated precisely rather than glossed.

## Findings

**1. Addressee detection in multi-party conversation predates LLMs, and the
finding is bad news for a text-only, LLM-judged design.**
Bohus & Horvitz's turn-taking and engagement work (*Learning to Predict
Engagement with a Spoken Dialog System in Open-World Settings*, SIGDIAL 2009;
*Computational Models for Multiparty Turn-Taking*, MSR-TR-2010-115) and the
addressee-detection line (Tsai et al., *Multimodal Addressee Detection in
Multiparty Dialogue Systems*, Microsoft Research / IEEE) established that the
strongest signals are non-textual: gaze, proximity, acoustic prosody, and
system-state — with acoustic features cited as "by far the most important."
Lexical content (word choice, questions) is a real but weaker signal used in
combination, not alone. None of the gaze/prosody/proximity signal classes exist
in a text chat product — Quorum has no channel to synthesize them from.
[Microsoft Research](https://www.microsoft.com/en-us/research/publication/multimodal-addressee-detection-in-multiparty-dialogue-systems/),
[Semantic Scholar — Computational Models for Multiparty Turn-Taking](https://www.semanticscholar.org/paper/Computational-Models-for-Multiparty-Turn-Taking-Dan-Bohus-Horvitz/c216ca6bdc4e18198da4afeeaa8291a9db8afda9)

The direct, text-only, LLM-era test of this question is even more discouraging.
Ozaki et al., *An LLM Benchmark for Addressee Recognition in Multi-modal
Multi-party Dialogue* (IWSDS 2025 / arXiv:2501.16643), gave GPT-4o five turns of
dialogue context plus a forced 4-way choice (three named speakers or "no one in
particular") and measured **80.9% accuracy against an 80.1% majority-class
baseline** — i.e., statistically indistinguishable from always guessing the
modal answer. Adding gaze-derived features (via OpenFace 2.0) *decreased*
accuracy to 75.2%. The authors' conclusion, quoted directly: text-only signals
were insufficient and the model struggled with subtle, context-dependent
address cues. This is a primary, adversarially-designed benchmark measuring
almost exactly Quorum's judge task (a labeled multi-party transcript, forced
choice, LLM asked to identify the addressee), and it should be read as a direct
warning against expecting the judge to be a reliable addressee-detector on
transcript alone.
[arXiv:2501.16643](https://arxiv.org/html/2501.16643v1)

A 2025 survey (*Multi-Party Conversational Agents: A Survey*, arXiv:2505.18845)
confirms the LLM-era state of the art is role-aware transformers and
attention-based addressee-selection models purpose-trained on large labeled
corpora (best reported: ASRG, 84.65% on the Ubuntu IRC benchmark) — not a
zero-shot general-purpose LLM prompted once per message. That gap (a trained,
task-specific classifier vs. a single zero-shot judge call) is exactly the gap
between what the literature validates and what a 12-hour budget can build.
[arXiv:2505.18845](https://arxiv.org/html/2505.18845v1)

**2. Deployed multi-party bots overwhelmingly avoid the addressee-detection
problem rather than solve it — they require explicit invocation.** Slack's own
guidance (`app_mention` events plus keyword/phrase matching on `message.channels`
text) treats explicit @mention as the primary trigger, and pushes anything more
implicit toward stateful "conversation tracking" (a stored thread/session the
bot considers itself already part of) rather than per-message inference.
[Slack — bot users](https://docs.slack.dev/legacy/legacy-bot-users)
Community Discord bot-development guidance is more blunt: *"Bots should not
activate on normal chat. Instead, use a command prefix or only respond when
your bot is directly @mentioned"* — and explicitly warns that mentioning a user
in a bot's own reply risks reply loops.
[Discord bot best practices](https://github.com/Lord-Ptolemy/discord-bot-best-practices)
Read together with finding 1, this is the load-bearing conclusion of this
report: **the actual state of the art in production is explicit mention, not
inferred addressing.** Nobody ships passive-listening addressee inference at
scale, and the one benchmark that tried to measure whether an LLM can do it
found it can't, reliably, from text alone.

**3. Minimal judge context.** No source gives a principled number for "how many
turns are enough" for a speak/silent judgment specifically (as opposed to
addressee *identification*, which is a harder task). The addressee-recognition
benchmark used 5 prior turns + the current utterance and still landed near
chance (finding 1) — which is weak evidence that more context alone does not
rescue the task; the bottleneck is signal, not context length. `GATE.judgeContextMessages = 8` in `config/agent.ts` is in the same range and is
not contradicted by any source, but nothing found makes 8 a *derived* number —
it is a reasonable, defensible guess, not a result. This sub-question is not
settled by available evidence; see Recommendation.

**4. Structured verdict design: boolean+reason beats a thresholded confidence
score, on calibration grounds.** Anthropic's own tool-use mechanism
(`tool_choice: {"type": "tool", "name": "..."}`, forcing a specific tool call)
is the documented, primary way to get schema-constrained structured output from
Claude — this is the mechanism `lib/llm/provider.ts`'s `structured()` method
should use for the judge call.
[Claude docs — implement tool use](https://docs.claude.com/en/docs/agents-and-tools/tool-use/implement-tool-use)
Separately, and more importantly for the `judgeSpeakThreshold = 0.7` question:
multiple 2025 papers on LLM confidence calibration converge on the same finding
— verbalized confidence scores from LLMs tend to **saturate at coarse values
(0.9, 1.0)** and are not intrinsically well-calibrated (a score of 0.7 does not
reliably mean "correct 70% of the time"); thresholding on such a score without
first measuring calibration on your own task/distribution "systematically
misroute[s] traffic and the errors [are] invisible."
[When Can We Trust LLM Graders? (arXiv:2603.29559)](https://arxiv.org/html/2603.29559),
[Claim-Level Confidence Calibration (arXiv:2608.22483)](https://arxiv.org/html/2608.22483)
**This is a direct, confirmed finding against the current config value**:
`judgeSpeakThreshold: 0.7` is stated as a fixed number with no calibration
procedure attached, and the literature says exactly that pattern is unreliable.
The safer structured-output design is a **discrete verdict plus a short reason
string** (`{verdict: "respond" | "silent", reason: string}`), not a continuous
score compared against a hardcoded float — a categorical decision from a forced
tool call is something the model is actually asked to commit to, rather than a
number invited to be miscalibrated.

**5. Cost asymmetry between false-positive interjection and false-negative
silence is asserted broadly in the proactive-agent literature but is not
quantified anywhere found.** The general framing recurs across sources: a
"speak or remain silent" decision under asymmetric costs, where "false alarms
erode trust and add cognitive load, while misses [only] forgo timely
assistance" (PRISM, arXiv:2602.01532); *Proactive Conversational Agents with
Inner Thoughts* (CHI 2025) frames unwanted interjection as an "interruption"
that breaks turn allocation and models it with an explicit override threshold
rather than a fixed rule. No source found puts a number on *how much* worse a
false positive is than a false negative (e.g., "3x", "10x") — this sub-question
is **not settled** by the literature; it is a directional, widely-repeated but
unquantified claim. Quorum's own bias-toward-silence design (D-008) is
consistent with the directional finding but cannot be defended with a specific
multiplier, and the report should not manufacture one.
[PRISM (arXiv:2602.01532)](https://arxiv.org/pdf/2602.01532),
[Proactive Conversational Agents with Inner Thoughts (CHI 2025)](https://dl.acm.org/doi/full/10.1145/3706598.3713760)

**6. Testing a non-deterministic gate: fixed-transcript fixtures against a
stubbed provider, not a live accuracy bar.** Current LLM-eval practice
(Langfuse, Confident AI/DeepEval) distinguishes exact-match testing (works for
deterministic code) from **golden-dataset regression testing**: a fixed,
version-controlled set of representative + edge-case + known-failure-mode
transcripts, each scored against an expected outcome, re-run on every change.
[Langfuse — LLM regression testing](https://langfuse.com/resources/engineering/llm-regression-testing),
[Confident AI — test cases, goldens, datasets](https://www.confident-ai.com/docs/llm-evaluation/core-concepts/test-cases-goldens-datasets)
The honest, 12-hour-budget version of this for Quorum is exactly what
`tests/agent/gate.test.ts` already scaffolds: the judge is tested at the
`lib/llm/provider.ts` boundary with a **stubbed provider returning fixed
verdicts**, never a live model call (the supplied key is short-lived — a suite
that depends on it is not a suite). That proves the *pipeline* (judge called
only when the chain falls through; silence on error/timeout/malformed output;
event always written) deterministically and cheaply. It does **not** and
cannot prove the judge is *accurate* at the underlying task — a live accuracy
bar would need a held-out labeled transcript set and is out of scope for this
build. **What would be honest to claim in the README:** "the gate's
deterministic behavior (which rules fire, fail-closed on judge error, cooldown
suppression) is unit-tested and provable; the judge's real-world accuracy at
distinguishing addressed-vs-not is not measured in this submission — the
literature (finding 1) suggests it would be modest for a zero-shot model on
text alone." That sentence is more defensible under questioning than silence
on the gap.

**7. Cooldown-based suppression is a named pattern: throttling (not
debouncing).** In UI/systems terminology, **debounce** delays execution until
activity *stops* for a window (used for search-as-you-type, resize handlers);
**throttle** allows at most one execution per fixed interval regardless of
continued activity, ignoring triggers inside the window until it reopens.
`GATE.cooldownSeconds = 90` — "after the agent speaks, stay silent for this
long unless addressed" — is a throttle, not a debounce: it fires immediately
once (the first response), then suppresses for a fixed window, exactly the
throttle definition.
[Debounce or Throttle? — rate limiting strategy](https://medium.com/@rains.dwivedi98/debounce-or-throttle-your-rate-limiting-strategy-d5f8937accfb)
(This particular citation is a blog post and is used here only for
terminology/orientation, per the research-plan rule that blog posts carry no
load-bearing authority — the underlying throttle/debounce distinction is
standard and uncontested CS vocabulary, not a claim needing a stronger
source.) **Known failure mode, reasoned from the definition rather than found
in a citation**: a pure time-based throttle with an "unless addressed" escape
hatch (which is what rule 6 already has — an explicit mention overrides the
cooldown per `tests/agent/gate.test.ts`) avoids the throttle's classic failure
(suppressing a second *genuinely new and relevant* trigage inside the window)
specifically because addressed messages bypass it. The remaining, unmitigated
failure mode is a burst of *unaddressed* but individually judge-worthy messages
inside the 90s window — e.g., three different people ask three different
implicit questions in quick succession; the agent answers the first and goes
silent on the other two even though each would independently have passed the
judge. Whether that is correct behavior (bias toward silence, per D-008) or a
gap is a product judgment, not a testing gap — but it should be named as a
known, deliberate tradeoff rather than an unnoticed side effect.

## Application to Quorum

- **`config/agent.ts`, `GATE.judgeSpeakThreshold: 0.7`** — finding 4 is a direct
  hit on this value. Recommend replacing the threshold-on-a-float design with a
  forced-tool-call discrete verdict (`respond` | `silent` + `reason`), which is
  closer to what `lib/llm/provider.ts`'s planned `structured()` method
  (`docs/ARCHITECTURE.md` §4, `lib/llm/`) already implies. If a numeric
  confidence is still wanted for the internal view / logging, keep it as a
  **display field only**, never as the compared value — i.e. still let the
  model commit to a categorical verdict via forced tool use, and treat any
  accompanying number as color, not gate logic.
- **`GATE.judgeContextMessages: 8`** — not contradicted by evidence; keep, but
  the README/D-008 write-up should say "chosen, not derived" rather than
  imply it came from a benchmark, since finding 3 found no principled number
  for this specific sub-task.
- **`GATE.cooldownSeconds: 90`** — correctly named as a throttle in any writeup
  (finding 7); the existing "mention overrides cooldown" behavior in rule 6
  (`tests/agent/gate.test.ts`, `it.todo('an explicit mention overrides the
  cooldown')`) already covers the main throttle failure mode. No code change
  needed; naming/documentation only.
- **`lib/agent/gate.ts` judge prompt** — per findings 1–2, the judge's system
  prompt should NOT be framed as "detect who this message is addressed to" (a
  task the cited benchmark shows LLMs do at ~chance on text alone). It should
  be framed narrower and more tractable: "given this transcript, is it
  plausible/expected that *the agent specifically* — as opposed to another
  human participant — should respond next," which is closer to a
  relevance/expectation judgment than true addressee attribution, and is the
  framing implicit in D-008's "genuine ambiguity" scope already.
- **`tests/agent/gate.test.ts`** — the existing scaffold (`it.todo('a judge
  verdict below the speak threshold results in silence')`) should be rewritten
  once the threshold is replaced with a discrete verdict:
  `it.todo('a "silent" verdict from the judge results in silence')`,
  `it.todo('the judge is invoked via a forced tool call, never free-text
  parsing')`. Keep the existing stub-at-`lib/llm/provider.ts` boundary approach
  (finding 6) — it is already the right design, not a live-accuracy suite.
- **README / `docs/DECISIONS.md` D-008 entry** — should add one sentence
  making the scope of the untested claim explicit (finding 6's suggested
  sentence), so the one non-deterministic, unprovable piece of an otherwise
  provable pipeline is named rather than implied away.
- **No change implied to `lib/agent/gate.ts`'s deterministic chain** (rules
  1–6) — none of this research bears on it; it was out of scope by design
  (Question section) and nothing found argues otherwise.

## Recommendation

**Closes:** the judge's verdict-schema design question left open under D-008
("what it returns" — README line 154, `docs/DECISIONS.md` D-008).

**Option chosen:** discrete verdict via a forced Claude tool call
(`{"type":"tool","name":"gate_verdict"}`, schema `{verdict: "respond"|"silent",
reason: string}`), replacing the compare-a-float-to-0.7 design implied by
`GATE.judgeSpeakThreshold`. Tested by stubbing `lib/llm/provider.ts` with fixed
transcript→verdict fixtures, never a live model call in CI.

**Strongest argument against this choice, stated fairly:** a discrete
respond/silent verdict throws away exactly the gradient information a
confidence score would carry, and forecloses cheap future tuning (e.g.,
"only speak above 0.85 in large groups, above 0.5 in DMs" — a policy this
design cannot express without a second field). The calibration critique in
finding 4 argues against *trusting* a threshold blindly, not against a
threshold *existing* — a more sophisticated system could ask for both a
verdict and a score, log the score for later calibration analysis, but gate
only on the discrete field, getting most of the discrete design's safety while
keeping the option to introduce a properly-calibrated threshold later once
real transcript data exists to calibrate against. Quorum's 12-hour budget is
the reason this report recommends the simpler all-discrete version now rather
than the score-plus-verdict hybrid — that is a resource-constraint argument,
not a strictly-better-design argument, and a reviewer could reasonably push
back on it.

**What is NOT settled, stated plainly:** sub-question 5 (the actual magnitude
of the false-positive/false-negative cost asymmetry) has no quantified answer
in the literature reviewed. Quorum's bias-toward-silence is directionally
supported but not numerically justified, and the README/decision log should
not claim otherwise. What would settle it: either a domain-specific user study
(not feasible in 12 hours) or, more practically for this project, an honest
statement that the asymmetry is a design *stance* (consistent with how
production bots behave per finding 2 — mention-gated, not inference-gated) and
not a measured tradeoff.

## Sources

- Tsai et al., [Multimodal Addressee Detection in Multiparty Dialogue Systems](https://www.microsoft.com/en-us/research/publication/multimodal-addressee-detection-in-multiparty-dialogue-systems/) — Microsoft Research / IEEE
- [Computational Models for Multiparty Turn-Taking](https://www.semanticscholar.org/paper/Computational-Models-for-Multiparty-Turn-Taking-Dan-Bohus-Horvitz/c216ca6bdc4e18198da4afeeaa8291a9db8afda9) — Bohus & Horvitz, MSR-TR-2010-115
- Ozaki et al., [An LLM Benchmark for Addressee Recognition in Multi-modal Multi-party Dialogue](https://arxiv.org/html/2501.16643v1) — IWSDS 2025 / arXiv:2501.16643 (also [ACL Anthology](https://aclanthology.org/2025.iwsds-1.36/))
- [Multi-Party Conversational Agents: A Survey](https://arxiv.org/html/2505.18845v1) — arXiv:2505.18845
- Slack, [Enabling interactions with bots / bot users](https://docs.slack.dev/legacy/legacy-bot-users) — official Slack docs
- [Discord bot best practices](https://github.com/Lord-Ptolemy/discord-bot-best-practices) — community reference, orientation only
- Anthropic, [How to implement tool use](https://docs.claude.com/en/docs/agents-and-tools/tool-use/implement-tool-use) — official Claude API docs (`tool_choice`)
- [When Can We Trust LLM Graders? Calibrating Confidence for Automated Assessment](https://arxiv.org/html/2603.29559) — arXiv:2603.29559
- [Claim-Level Confidence Calibration for Reliable Decision Making with Large Language Models](https://arxiv.org/html/2608.22483) — arXiv:2608.22483
- PRISM: [Festina Lente Proactivity — Risk-Sensitive, Uncertainty-Aware Deliberation for Proactive Agents](https://arxiv.org/pdf/2602.01532) — arXiv:2602.01532
- [Proactive Conversational Agents with Inner Thoughts](https://dl.acm.org/doi/full/10.1145/3706598.3713760) — CHI 2025 / ACM
- Langfuse, [LLM regression testing: fail CI before regressions ship](https://langfuse.com/resources/engineering/llm-regression-testing) — vendor doc, orientation only
- Confident AI, [Test Cases, Goldens, and Datasets](https://www.confident-ai.com/docs/llm-evaluation/core-concepts/test-cases-goldens-datasets) — vendor doc, orientation only
- [Debounce or Throttle? Your Rate Limiting Strategy](https://medium.com/@rains.dwivedi98/debounce-or-throttle-your-rate-limiting-strategy-d5f8937accfb) — blog post, terminology orientation only, not load-bearing alone
