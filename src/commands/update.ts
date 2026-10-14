import type { Command } from "commander";
import pc from "picocolors";
import { update, type SkillUpdate } from "../update.js";

function shortRevision(revision: string | null): string {
  return revision ? revision.slice(0, 7) : "local";
}

function describe(skill: SkillUpdate, dryRun: boolean): string {
  switch (skill.status) {
    case "updated": {
      const revisions = skill.from === skill.to ? "" : ` (${shortRevision(skill.from)} → ${shortRevision(skill.to)})`;
      return `${pc.green(dryRun ? "Would update" : "Updated")} ${skill.name}${revisions}`;
    }
    case "current":
      return `${pc.dim("Current")} ${skill.name}`;
    case "skipped":
      return `${pc.yellow("Skipped")} ${skill.name}: ${skill.reason}`;
    case "failed":
      return `${pc.red("Failed")} ${skill.name}: ${skill.reason}`;
  }
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .argument("[skills...]", "library skills to update (default: all)")
    .description("Update library skills from their recorded sources")
    .option("-f, --force", "discard local changes made to library copies")
    .option("--dry-run", "show what would change without writing")
    .option("--json", "print machine-readable output")
    .action(async (skills: string[], options) => {
      const result = await update({ skills, force: options.force, dryRun: options.dryRun });
      if (result.skills.some((skill) => skill.status === "failed")) process.exitCode = 1;
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (!result.skills.length) {
        console.log("No skills in your library.");
        return;
      }
      for (const skill of result.skills) console.log(describe(skill, result.dryRun));
      if (result.environments.length && !result.dryRun) {
        console.log(`\nRun ${pc.bold("skillenv use <environment>")} in projects using ${result.environments.join(", ")} to deploy these updates.`);
      }
    });
}
