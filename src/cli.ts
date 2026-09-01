#!/usr/bin/env node
import { Command } from "commander";
import { ZodError } from "zod";
import { registerAddCommands } from "./commands/add.js";
import { registerDeactivateCommand } from "./commands/deactivate.js";
import { registerEnvCommand } from "./commands/env.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerUseCommand } from "./commands/use.js";
import { SkillenvError } from "./errors.js";

const program = new Command();

program
  .name("skillenv")
  .description("Virtual environments for agent skills")
  .version("0.1.0")
  .showSuggestionAfterError();

registerAddCommands(program);
registerEnvCommand(program);
registerUseCommand(program);
registerStatusCommand(program);
registerDeactivateCommand(program);

program.parseAsync().catch((error: unknown) => {
  if (error instanceof SkillenvError || error instanceof ZodError) {
    const message = error instanceof ZodError ? error.issues.map((issue) => issue.message).join("; ") : error.message;
    console.error(`Error: ${message}`);
    process.exitCode = 1;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
