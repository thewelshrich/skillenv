import type { Command } from "commander";
import { adapters } from "../adapters.js";
import { activate } from "../materialize.js";

export function registerUseCommand(program: Command): void {
  program.command("use").argument("<environment>").description("Activate an environment in the current project").action(async (environment) => {
    const result = await activate(environment);
    const count = result.state.managed.length / adapters.length;
    console.log(`Activated ${environment} in ${result.project.root}\n${count} skill${count === 1 ? "" : "s"} available to supported agents.`);
    if (!result.project.gitExclude) console.log("Note: this is not a Git repository, so generated files could not be locally excluded.");
  });
}
