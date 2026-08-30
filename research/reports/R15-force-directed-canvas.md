# R15 — Force-directed canvas rendering

**Band:** C · **Closes:** none open (informs D-017 scope) · **Status:** complete

## Question

D-017 ships the space view last, and D-016 schedules it as tier-3 "only if the
space view survives." Given that it may get built, five implementation
questions need answers before anyone opens `app/(app)/space/page.tsx`: SVG vs
canvas as the rendering surface, how to cluster nodes by group without a
bespoke force, how to animate a people/groups toggle without a jarring
restart, what "a few hundred nodes" costs in practice, and what a blind or
screen-reader user gets in place of the canvas. Getting these wrong late in a
12-hour build (D-016) means either a visible stutter in a demo feature or
silently shipping an inaccessible screen with no fallback — both bad given
D-017's own rationale that this feature is graded on polish, not substance.

## Findings

1. **Canvas vs SVG.** D3 force simulations don't render anything themselves —
   `simulation.on("tick", ...)` is just a callback, and the developer chooses
   whether it mutates SVG DOM nodes or draws to a `<canvas>` 2D context. The
   official d3-force docs' own worked examples pair the simulation with a
   `<canvas>` render loop for exactly this reason (github.com/d3/d3, d3-force
   simulation.md). Community benchmarking (Scott Logic's WebGL/D3 writeup,
   Reintech's D3 performance guide) is consistent: SVG performance degrades
   noticeably past roughly 1,000–2,000 DOM elements because each tick forces a
   layout/paint on every node element, while canvas repaints a single bitmap
   per frame and holds 60fps well past 10,000 points. For Quorum's stated
   scale ("a few hundred nodes") SVG would likely still run, but canvas is the
   correct choice on the actual constraint: **the simulation forces run every
   tick regardless of renderer, so the choice is pure rendering cost, and
   canvas eliminates a full category of it (DOM reflow) for a mechanical
   trade-off** (no per-node DOM element, so no native `onClick`/`title`
   tooltip, and hit-testing on click must be re-derived manually — d3-force
   community docs / Starlog "Why Canvas Beats the DOM for Network
   Visualization").

2. **Cluster via `forceX`/`forceY`, not a bespoke force.** D3 ships
   `forceX(x)` / `forceY(y)` as per-node target forces with a configurable
   `strength()`; pointing every node's `x`/`y` accessor at its group's
   centroid (mean position of members currently in that group) and adding a
   `forceCollide` for separation is the standard "clustered bubbles" pattern
   documented on Observable (`@d3/clustered-bubbles`) and in Mike Bostock's
   original "Clustered Force Layout" gist. This needs no custom force plugin
   — `forceX`/`forceY` are core d3-force. Third-party cluster-attraction
   plugins (`d3-force-clustering`, `forceInABox`) exist but solve a harder
   problem (automatic layout of many small clusters); Quorum only has two
   known groupings (chats, or people) so the plain `forceX`/`forceY`-toward-
   centroid approach is sufficient and keeps the dependency surface at
   `d3-force` alone.

3. **Toggling views without rebuilding the simulation.** The official
   d3-force docs describe `simulation.alphaTarget(target)` precisely for this
   case: setting a nonzero `alphaTarget` "gradually warms" the simulation
   instead of restarting it from `alpha=1`, and `simulation.restart()`
   resumes the internal timer if it had cooled to a stop (d3.js docs,
   `d3-force/simulation.md`, and Stamen's "Forcing Functions" writeup on the
   v4 transition). The correct pattern for a people/groups toggle is: keep
   one long-lived `forceSimulation` instance across the toggle, mutate the
   `forceX`/`forceY` target accessors (or the underlying centroid data) in
   place, call `simulation.alphaTarget(0.3).restart()` to reheat gently, then
   set `alphaTarget(0)` back after a short timeout so it settles. Rebuilding
   the simulation object on toggle would reset velocities and forces and
   produce the "jump to life" behavior the docs explicitly warn against.

4. **Performance at a few hundred nodes.** At Quorum's stated scale (a few
   hundred, not thousands), both SVG and canvas are computationally fine per
   the same sources in (1) — the crossover point community benchmarks cite is
   roughly 1,000–2,000 elements. The uncertain part, and *not settled by the
   general-web sources found here*, is a Quorum-specific number: how many
   chats and members a target user actually has. No source in this research
   pass established that; it would need to come from the product's own usage
   assumptions, not from d3 benchmarks.

5. **Accessibility fallback.** MDN's own canvas documentation is blunt: "the
   canvas element on its own is just a bitmap and does not provide
   information about any drawn objects... In general, you should avoid using
   canvas in an accessible website or app" (MDN, `<canvas>` element,
   Accessibility Concerns section). MDN's two concrete mitigations are (a)
   fallback content nested inside the `<canvas>...</canvas>` tags, read by
   screen readers and rendered when JS/canvas is unavailable, and (b)
   `role="img"` plus `aria-label`/`aria-describedby` if the canvas is treated
   as a single non-interactive image. Neither actually exposes individual
   nodes/edges to assistive tech — a canvas force-graph is fundamentally a
   single opaque image to a screen reader no matter what ARIA is added
   (MDN; corroborated by Vispero and the W3C canvas accessibility use-cases
   page MDN cites). D-017 already establishes the answer structurally: the
   list view (`app/(app)/chats/page.tsx`) is "the fallback" for tier 1 and
   "remains the fallback" per that decision's own wording — the space view
   should never be the only path to any piece of information or action, and
   the accessible fallback for R15 is simply "the list view already is one,"
   not a bespoke ARIA re-implementation of the canvas.

## Application to Quorum

- `app/(app)/space/page.tsx` (t3, per `docs/ARCHITECTURE.md` line 223): build
  the force graph on `<canvas>`, not SVG, one `forceSimulation` instance
  persisted across the people/groups toggle (e.g. in a `useRef`), driven by
  `forceX`/`forceY` targeting per-group centroids plus `forceCollide` for
  separation. On toggle, mutate the centroid targets and call
  `simulation.alphaTarget(0.3).restart()`, then `alphaTarget(0)` after
  ~300ms — do not construct a new `forceSimulation`.
- Manual hit-testing is required for click/hover on canvas (no per-node DOM
  element gets a native click handler) — budget for this in the t3 estimate;
  it is extra work relative to SVG, not free.
- No new dependency beyond `d3-force` itself is needed for clustering — do
  not add `d3-force-clustering` or `forceInABox` for two-group clustering.
- Accessibility: no bespoke canvas ARIA layer is recommended. The space view
  should carry a visible "switch to list" affordance to
  `app/(app)/chats/page.tsx`, and nothing available only via the canvas
  (state, an action, information) should lack an equivalent path through the
  list view — this is already the shape D-017 committed to, R15 just confirms
  it's also the accessibility answer, not an incidental one.
- Node/chat count at which canvas is warranted: not settled by this pass (see
  Findings §4) — if research time allows, R15 should be revisited with an
  actual estimate of chats-per-user for the assessment's demo data before
  the space view is built, so effort isn't spent optimizing for a node count
  that never occurs.

## Recommendation

R15 closes no currently-open decision in `docs/DECISIONS.md` (D-017 already
settled *that* the space view ships last; R15 only settles *how*). It should
be logged as a new settled decision, e.g. "D-019 — Space view renders on
canvas with a persistent simulation," with the options below.

**Recommended option:** canvas rendering with a single long-lived
`forceSimulation`, `forceX`/`forceY`-toward-centroid clustering, and the list
view as the accessibility fallback (no bespoke canvas ARIA).

**Strongest argument against this option:** at "a few hundred nodes," SVG is
not actually the performance risk the canvas choice implies — the
1,000–2,000-element crossover cited in the benchmarks (Finding 1) is above
Quorum's likely scale, so the SVG path would probably also hit 60fps, and SVG
would have given native DOM hit-testing, native `title` tooltips, and CSS
styling for free, all of which canvas now has to reimplement by hand. Given
this is a t3, lowest-priority, "may not survive" feature (D-016, D-017), the
lower-implementation-cost choice (SVG) may be the better fit for the time
budget even though canvas is the theoretically more scalable choice — this is
a real trade-off, not a clear win either way, and the evidence gathered here
does not conclusively settle it because Quorum's actual node count was never
established (Finding 4).

**What would settle it:** an actual estimate or hard cap on chats-per-user in
the demo/seed data. If that number is confidently under ~200, SVG's lower
implementation cost may outweigh canvas's headroom; if it's expected to climb
into the low thousands (e.g. a large seeded org), canvas is the clear call.

## Sources

- D3 force simulation official docs — https://github.com/d3/d3/blob/main/docs/d3-force/simulation.md (alphaTarget/restart semantics)
- D3 force docs (mirror) — https://d3js.org/d3-force/simulation
- MDN, `<canvas>` element, Accessibility Concerns — https://developer.mozilla.org/en-US/docs/Web/HTML/Element/canvas
- Scott Logic, "Rendering One Million Datapoints with D3 and WebGL" — https://blog.scottlogic.com/2020/05/01/rendering-one-million-points-with-d3.html
- Reintech, "Optimizing D3 Chart Performance for Large Data Sets" — https://reintech.io/blog/optimizing-d3-chart-performance-large-data
- Starlog, "Force-Graph: Why Canvas Beats the DOM for Network Visualization" — https://starlog.is/articles/data-knowledge/vasturiano-force-graph/
- Observable, "Clustered Bubbles" (`@d3/clustered-bubbles`) — https://observablehq.com/@d3/clustered-bubbles
- Mike Bostock, "Clustered Force Layout III" gist — https://gist.github.com/mbostock/7881887
- Stamen, "Forcing Functions: Inside D3.v4 forces and layout transitions" — https://stamen.com/forcing-functions-inside-d3-v4-forces-and-layout-transitions-f3e89ee02d12/
- `d3-force-clustering` (evaluated, not selected) — https://github.com/vasturiano/d3-force-clustering
- `forceInABox` (evaluated, not selected) — https://github.com/john-guerra/forceInABox
