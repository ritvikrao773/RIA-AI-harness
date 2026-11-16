// Shim used by bench/measure.mjs to report the fixed request payload.
import { discoverSkills, defaultSkillsDirs } from "../src/skills.js";
import { buildTools } from "../src/tools.js";
import { SYSTEM_PROMPT } from "../src/agent.js";
import { estimateTokens, type ChatMessage } from "../src/llm.js";
import { dropBulkContext, estimateHistory, trimCutoff } from "../src/compact.js";
import { basename } from "node:path";

export function measure() {
  const skills = discoverSkills(defaultSkillsDirs());
  const tools = buildTools(skills);
  const sys = SYSTEM_PROMPT(skills, basename(process.cwd()));
  const toolsJson = JSON.stringify(tools.map((t) => ({ type: "function", function: t })));

  return {
    systemPromptTokens: estimateTokens(sys),
    toolsTokens: estimateTokens(toolsJson),
    totalFixedPerRequest: estimateTokens(sys) + estimateTokens(toolsJson),
    toolCount: tools.length,
    perTool: tools.map((t) => ({
      name: t.name,
      descTokens: estimateTokens(t.description),
      schemaTokens: estimateTokens(JSON.stringify(t.parameters)),
    })),
    skillLinesTokens: estimateTokens(skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")),
    skillNames: skills.map((s) => `${s.name} (${s.description.length} chars desc)`),
  };
}

/**
 * Replay a stored conversation through the free-release path and report what
 * it would cost before and after. `secondPassFreed` must be 0 — a non-zero
 * value means release is not idempotent and would keep invalidating caches.
 */
export function measureSession(messages: ChatMessage[], cutoffTail = 8) {
  const copy = JSON.parse(JSON.stringify(messages)) as ChatMessage[];
  const before = estimateHistory(copy);
  const cutoff = trimCutoff(copy, cutoffTail, 1_500);
  const freed = dropBulkContext(copy, 200, cutoff);
  const after = estimateHistory(copy);
  const secondPassFreed = dropBulkContext(copy, 200, trimCutoff(copy, cutoffTail, 1_500));
  return { messages: copy.length, before, freed, after, secondPassFreed };
}
