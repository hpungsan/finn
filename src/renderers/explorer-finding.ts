import type { ExplorerFinding } from "../schemas/index.js";

/**
 * Renders an ExplorerFinding as markdown for LLM consumption.
 *
 * Output is structured for the stitcher to:
 * - Identify high-priority files quickly (grouped by relevance)
 * - Understand patterns and concerns
 * - Assess confidence level
 */
export function renderExplorerFinding(data: ExplorerFinding): string {
  const sections: string[] = [];

  // Confidence (always present)
  sections.push(`**Confidence:** ${data.confidence.toFixed(2)}`);

  // Files grouped by relevance
  const fileSection = renderFilesSection(data.files);
  if (fileSection) {
    sections.push(fileSection);
  }

  // Patterns
  if (data.patterns.length > 0) {
    sections.push(renderListSection("Patterns", data.patterns));
  }

  // Concerns
  if (data.concerns.length > 0) {
    sections.push(renderListSection("Concerns", data.concerns));
  }

  return sections.join("\n\n");
}

function renderFilesSection(files: ExplorerFinding["files"]): string | null {
  if (files.length === 0) return null;

  const byRelevance = {
    high: files.filter((f) => f.relevance === "high"),
    medium: files.filter((f) => f.relevance === "medium"),
    low: files.filter((f) => f.relevance === "low"),
  };

  const parts: string[] = ["### Files"];

  if (byRelevance.high.length > 0) {
    parts.push("\n**High Relevance:**");
    for (const f of byRelevance.high) {
      parts.push(`- \`${f.path}\` - ${f.summary}`);
    }
  }

  if (byRelevance.medium.length > 0) {
    parts.push("\n**Medium Relevance:**");
    for (const f of byRelevance.medium) {
      parts.push(`- \`${f.path}\` - ${f.summary}`);
    }
  }

  if (byRelevance.low.length > 0) {
    parts.push("\n**Low Relevance:**");
    for (const f of byRelevance.low) {
      parts.push(`- \`${f.path}\` - ${f.summary}`);
    }
  }

  return parts.join("\n");
}

function renderListSection(title: string, items: string[]): string {
  const bullets = items.map((item) => `- ${item}`).join("\n");
  return `### ${title}\n${bullets}`;
}
