import type { Step } from "./types.js";

/**
 * Group steps into parallel batches by dependency level.
 * Steps at same level have no dependencies between them.
 *
 * PRECONDITION: sortedSteps must be topologically sorted (use topoSort() first).
 * This ensures all deps are processed before dependents, making levels.get(d)! safe.
 *
 * Algorithm:
 * - Level 0: steps with no deps
 * - Level N: max(levels of deps) + 1
 *
 * Example: `a → b, a → c, b → d, c → d` produces `[[a], [b, c], [d]]`
 */
export function groupIntoBatches(sortedSteps: Step[]): Step[][] {
  if (sortedSteps.length === 0) return [];

  const levels = new Map<string, number>();

  for (const step of sortedSteps) {
    if (step.deps.length === 0) {
      levels.set(step.id, 0);
    } else {
      // Safe: topo-sort guarantees all deps processed before this step
      // biome-ignore lint/style/noNonNullAssertion: topo-sort ensures deps exist in levels
      const maxDepLevel = Math.max(...step.deps.map((d) => levels.get(d)!));
      levels.set(step.id, maxDepLevel + 1);
    }
  }

  // Group by level
  const batches = new Map<number, Step[]>();
  for (const step of sortedSteps) {
    // biome-ignore lint/style/noNonNullAssertion: level was set in previous loop
    const level = levels.get(step.id)!;
    if (!batches.has(level)) batches.set(level, []);
    // biome-ignore lint/style/noNonNullAssertion: we just ensured batches.has(level)
    batches.get(level)!.push(step);
  }

  // Return in level order
  const maxLevel = Math.max(...levels.values());
  return Array.from({ length: maxLevel + 1 }, (_, i) => batches.get(i) ?? []);
}
