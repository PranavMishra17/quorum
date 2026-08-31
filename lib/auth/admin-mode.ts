/**
 * Admin mode — the demo affordance, and the gate that keeps it one.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES, SAID PLAINLY
 *
 * It lets a signed-in user grant themselves any clearance and add themselves to
 * any group. In a project whose entire thesis is that clearance is enforced,
 * that is a self-service privilege escalation, and there is no way to describe
 * it that makes it sound harmless.
 *
 * It exists because demonstrating a two-axis authorisation model from a single
 * browser otherwise means three Google accounts and three profiles. The
 * alternative — a reviewer who cannot see the difference between "member but
 * uncleared" and "cleared but not a member" — makes the graded claim
 * unverifiable, which is a worse outcome than a clearly-fenced dev tool.
 *
 * ---------------------------------------------------------------------------
 * THE GATE IS THE SAME THREE-WAY ONE AS DEV LOGIN, AND FOR THE SAME REASON
 *
 * Non-production AND an explicit opt-in flag. Opt-IN, so that forgetting to set
 * something can never be what opens it — the failure mode of an opt-out flag is
 * silent and total.
 *
 * Two further properties make this defensible rather than merely gated:
 *
 *   - **It is not a bypass.** Every action goes through the same
 *     `grant_clearance()` / membership RPCs a normal user calls, so RLS and the
 *     delegation rules still run. Admin mode changes WHAT THE USER HOLDS; it
 *     never changes what holding it means. Nothing here can read a chat the
 *     authorisation rules would refuse — it can only make you someone the rules
 *     permit, visibly.
 *   - **It is audited.** Every self-grant writes an `agent_events` row, so the
 *     internal view shows that the clearance was self-issued rather than
 *     granted. A reviewer who suspects the demo was rigged can check.
 */
export function adminModeEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.ALLOW_ADMIN_MODE === 'true'
  );
}
