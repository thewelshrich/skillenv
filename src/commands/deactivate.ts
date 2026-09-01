import type { Command } from "commander";
import { deactivate } from "../materialize.js";

export function registerDeactivateCommand(program: Command): void {
  program.command("deactivate").description("Remove the active environment from the current project").action(async () => {
    const result = await deactivate();
    console.log(result.environment ? `Deactivated ${result.environment}` : "No environment was active.");
  });
}
