import type { Command } from "commander";
import {
  addEnvironmentSkill,
  createEnvironment,
  deleteEnvironment,
  listEnvironments,
  readEnvironment,
  removeEnvironmentSkill,
} from "../environments.js";

export function registerEnvCommand(program: Command): void {
  const env = program.command("env").description("Manage named skill environments");

  env.command("create").argument("<name>").description("Create an empty environment").action(async (name) => {
    await createEnvironment(name);
    console.log(`Created ${name}`);
  });

  env.command("add").argument("<environment>").argument("<skill>").description("Add a library skill to an environment").action(async (environment, skill) => {
    await addEnvironmentSkill(environment, skill);
    console.log(`Added ${skill} to ${environment}`);
  });

  env.command("remove").argument("<environment>").argument("<skill>").description("Remove a skill from an environment").action(async (environment, skill) => {
    await removeEnvironmentSkill(environment, skill);
    console.log(`Removed ${skill} from ${environment}`);
  });

  env.command("delete").argument("<name>").description("Delete an environment definition").action(async (name) => {
    await deleteEnvironment(name);
    console.log(`Deleted ${name}`);
  });

  env.command("show").argument("<name>").description("Show an environment").action(async (name) => {
    const environment = await readEnvironment(name);
    console.log(`${environment.name}\n${environment.skills.map((skill) => `  ${skill}`).join("\n") || "  (empty)"}`);
  });

  env.command("list").alias("ls").description("List environments").action(async () => {
    const environments = await listEnvironments();
    console.log(environments.length ? environments.map((environment) => `${environment.name} (${environment.skills.length})`).join("\n") : "No environments defined.");
  });
}
