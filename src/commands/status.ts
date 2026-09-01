import type { Command } from "commander";
import { getStatus } from "../materialize.js";

export function registerStatusCommand(program: Command): void {
  program.command("status").description("Show the active environment in the current project").action(async () => {
    const result = await getStatus();
    if (!result.state) {
      console.log(`No environment active in ${result.project.root}`);
      return;
    }
    const skills = [...new Set(result.state.managed.map((entry) => entry.skill))];
    console.log(`Environment: ${result.state.environment}\nProject: ${result.project.root}\nSkills: ${skills.join(", ") || "(none)"}`);
    if (result.drifted.length) console.log(`Warning: ${result.drifted.length} managed path${result.drifted.length === 1 ? " has" : "s have"} drifted.`);
  });
}
