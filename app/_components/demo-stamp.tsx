/**
 * The one visual marker every demo room carries, everywhere it can appear —
 * the Rooms list, a chat header, the Workspace groups grid, a floating panel.
 *
 * One component rather than four inline spans so the wording and styling
 * cannot drift between surfaces — the whole point of stamping a room is that a
 * reviewer learns to recognise it on sight, which only works if it looks
 * identical every time.
 */
export function DemoStamp() {
  return (
    <span className="label shrink-0 border px-1.5 py-0.5" style={{ color: 'var(--c1)', borderColor: 'var(--c1)' }}>
      Demo
    </span>
  );
}
