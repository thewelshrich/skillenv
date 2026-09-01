import type { Command } from "commander";
import { addSkill, listSkills } from "../library.js";

export function registerAddCommands(program: Command): void {
  program
    .command("add")
    .description("Add a local skill directory to your library")
    .argument("<source>", "directory containing SKILL.md")
    .option("-n, --name <name>", "library name")
    .option("-f, --force", "replace an existing library skill")
    .action(async (source, options) => {
      const name = await addSkill(source, options);
      console.log(`Added ${name}`);
    });

  program
    .command("list")
    .alias("ls")
    .description("List skills in your library")
    .action(async () => {
      const skills = await listSkills();
      console.log(skills.length ? skills.join("\n") : "No skills in your library.");
    });
}
