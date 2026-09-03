#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { ZodError } from "zod";
import { registerAddCommands } from "./commands/add.js";
import { registerDeactivateCommand } from "./commands/deactivate.js";
import { registerEnvCommand } from "./commands/env.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerUseCommand } from "./commands/use.js";
import { SkillenvError } from "./errors.js";

const program = new Command();
const arguments_ = process.argv.slice(2);
const jsonAddMode = arguments_.includes("add") && arguments_.includes("--json");

function printJsonError(code: string, message: string, details?: unknown): void {
  console.log(JSON.stringify({ status: "error", error: { code, message, ...(details === undefined ? {} : { details }) } }, null, 2));
}

program
  .name("skillenv")
  .description("Virtual environments for agent skills")
  .version("0.1.0")
  .showSuggestionAfterError()
  .exitOverride()
  .configureOutput({
    writeErr: (value) => {
      if (!jsonAddMode) process.stderr.write(value);
    },
  });

registerAddCommands(program);
registerEnvCommand(program);
registerUseCommand(program);
registerStatusCommand(program);
registerDeactivateCommand(program);

program.parseAsync().catch((error: unknown) => {
  if (error instanceof CommanderError) {
    if (error.code === "commander.helpDisplayed" || error.code === "commander.version") return;
    if (jsonAddMode) printJsonError("INVALID_INPUT", error.message.replace(/^error:\s*/i, ""));
    process.exitCode = error.exitCode || 1;
    return;
  }
  if (error instanceof SkillenvError || error instanceof ZodError) {
    const message = error instanceof ZodError ? error.issues.map((issue) => issue.message).join("; ") : error.message;
    if (jsonAddMode) printJsonError(error instanceof SkillenvError ? error.code : "INVALID_INPUT", message, error instanceof SkillenvError ? error.details : undefined);
    else console.error(`Error: ${message}`);
    process.exitCode = 1;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
