import * as p from "@clack/prompts";
import pc from "picocolors";
import { CancelledError } from "./errors.js";
import type { Environment } from "./schema.js";
import type { SkillCandidate } from "./sources.js";

export type TargetDecision =
  | { kind: "library" }
  | { kind: "environment"; name: string; create: boolean };

export interface InstallInteraction {
  intro(): void;
  source(): Promise<string>;
  task<T>(message: string, operation: () => Promise<T>): Promise<T>;
  skills(candidates: readonly SkillCandidate[]): Promise<string[]>;
  replace(conflicts: readonly string[]): Promise<boolean>;
  target(environments: readonly Environment[], activeEnvironment: string | null): Promise<TargetDecision>;
  environmentName(): Promise<string>;
  activate(environment: string, projectRoot: string, currentlyActive: boolean): Promise<boolean>;
  preview(lines: readonly string[]): void;
  confirm(lines: readonly string[]): Promise<boolean>;
  success(message: string): void;
  cancel(): void;
}

function value<T>(answer: T | symbol): T {
  if (p.isCancel(answer)) throw new CancelledError();
  return answer as T;
}

export class ClackInteraction implements InstallInteraction {
  intro(): void {
    p.intro(pc.bgCyan(pc.black(" skillenv ")));
  }

  async source(): Promise<string> {
    return value(await p.text({
      message: "Where should we look for skills?",
      placeholder: "owner/repo or ./local-directory",
      validate: (input) => input?.trim() ? undefined : "Enter a local directory or Git repository",
    }));
  }

  async task<T>(message: string, operation: () => Promise<T>): Promise<T> {
    const spinner = p.spinner();
    spinner.start(message);
    try {
      const result = await operation();
      spinner.stop(message.replace(/…$/, ""));
      return result;
    } catch (error) {
      spinner.stop(pc.red("Failed"));
      throw error;
    }
  }

  async skills(candidates: readonly SkillCandidate[]): Promise<string[]> {
    return value(await p.autocompleteMultiselect({
      message: "Select skills to install",
      placeholder: "Type to search…",
      options: candidates.map((candidate) => ({
        value: candidate.name,
        label: candidate.name,
        hint: candidate.description.length > 72 ? `${candidate.description.slice(0, 69)}…` : candidate.description,
      })),
      maxItems: 12,
      required: true,
    }));
  }

  async replace(conflicts: readonly string[]): Promise<boolean> {
    return value(await p.confirm({
      message: `Replace ${conflicts.length === 1 ? conflicts[0] : `${conflicts.length} existing skills`}?`,
      initialValue: false,
    }));
  }

  async target(environments: readonly Environment[], activeEnvironment: string | null): Promise<TargetDecision> {
    const ordered = [...environments].sort((a, b) => {
      if (a.name === activeEnvironment) return -1;
      if (b.name === activeEnvironment) return 1;
      return a.name.localeCompare(b.name);
    });
    const selected = value(await p.select({
      message: "Where should these skills live?",
      options: [
        ...ordered.map((environment) => ({
          value: `environment:${environment.name}`,
          label: environment.name,
          hint: environment.name === activeEnvironment ? "active in this project" : `${environment.skills.length} skills`,
        })),
        { value: "create", label: "Create a new environment…" },
        { value: "library", label: "Library only", hint: "organize later" },
      ],
      initialValue: activeEnvironment ? `environment:${activeEnvironment}` : ordered.length === 1 ? `environment:${ordered[0]!.name}` : "create",
    }));
    if (selected === "library") return { kind: "library" };
    if (selected === "create") return { kind: "environment", name: await this.environmentName(), create: true };
    return { kind: "environment", name: selected.slice("environment:".length), create: false };
  }

  async environmentName(): Promise<string> {
    return value(await p.text({
      message: "Name the environment",
      placeholder: "frontend",
      validate: (input) => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input ?? "") ? undefined : "Use letters, numbers, dots, underscores, or hyphens",
    })).trim();
  }

  async activate(environment: string, projectRoot: string, currentlyActive: boolean): Promise<boolean> {
    return value(await p.confirm({
      message: currentlyActive ? `Refresh ${environment} in ${projectRoot}?` : `Activate ${environment} in ${projectRoot}?`,
      initialValue: true,
    }));
  }

  async confirm(lines: readonly string[]): Promise<boolean> {
    p.note(lines.join("\n"), "Ready");
    return value(await p.confirm({ message: "Continue?", initialValue: true }));
  }

  preview(lines: readonly string[]): void {
    p.note(lines.join("\n"), "Installation plan");
    p.outro("No changes made");
  }

  success(message: string): void {
    p.outro(`${pc.green(message)}${pc.dim("  Review skills before use; they run with your agent's permissions.")}`);
  }

  cancel(): void {
    p.cancel("Installation cancelled");
  }
}
