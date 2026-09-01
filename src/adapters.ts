export interface Adapter {
  name: string;
  skillRoot: string;
}

export const adapters: readonly Adapter[] = [
  { name: "agents", skillRoot: ".agents/skills" },
  { name: "claude", skillRoot: ".claude/skills" },
];

export function adapterSkillPath(adapter: Adapter, skill: string): string {
  return `${adapter.skillRoot}/${skill}`;
}

export function isAdapterSkillPath(path: string, skill: string): boolean {
  return adapters.some((adapter) => path === adapterSkillPath(adapter, skill));
}
