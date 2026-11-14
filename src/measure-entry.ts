// Shim used by bench/measure.mjs to report the fixed request payload.
import { discoverSkills, defaultSkillsDirs } from "../src/skills.js";
import { buildTools } from "../src/tools.js";
import { SYSTEM_PROMPT } from "../src/agent.js";
import { estimateTokens } from "../src/llm.js";
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
