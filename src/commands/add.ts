import type { Command } from "commander";
import pc from "picocolors";
import { SkillenvError } from "../errors.js";
import { install, type InstallRequest, type SkillSelection } from "../install.js";
import { listSkills } from "../library.js";
import { ClackInteraction, type TargetDecision } from "../prompts.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerAddCommands(program: Command): void {
  program
    .command("add")
    .description("Discover and install skills into your library and environments")
    .argument("[source]", "local directory, owner/repo, or Git URL")
    .option("-s, --skill <name>", "skill to install (repeatable)", collect, [])
    .option("--all", "install every discovered skill")
    .option("-e, --env <name>", "add to an existing environment")
    .option("--create-env <name>", "create and target a new environment")
    .option("--library-only", "install without changing an environment")
    .option("--activate", "activate or refresh the target environment here")
    .option("--no-activate", "leave project activation unchanged")
    .option("-f, --force", "replace conflicting library skills")
    .option("-y, --yes", "do not prompt; fail when a decision is missing")
    .option("--dry-run", "show the installation plan without writing")
    .option("--json", "print machine-readable output; implies --yes")
    .action(async (source, options, command) => {
      if (options.all && options.skill.length) throw new SkillenvError("--skill and --all are mutually exclusive", "INVALID_INPUT");
      const targets = [options.env, options.createEnv, options.libraryOnly].filter(Boolean);
      if (targets.length > 1) throw new SkillenvError("--env, --create-env, and --library-only are mutually exclusive", "INVALID_INPUT");
      if (options.activate && options.libraryOnly) throw new SkillenvError("--activate requires an environment target", "INVALID_INPUT");

      const selection: SkillSelection | undefined = options.all
        ? { kind: "all" }
        : options.skill.length ? { kind: "named", names: options.skill } : undefined;
      const target: TargetDecision | undefined = options.env
        ? { kind: "environment", name: options.env, create: false }
        : options.createEnv ? { kind: "environment", name: options.createEnv, create: true }
          : options.libraryOnly ? { kind: "library" } : undefined;
      const activationWasSpecified = command.getOptionValueSource("activate") === "cli";
      const request: InstallRequest = {
        source,
        selection,
        target,
        activate: activationWasSpecified ? options.activate : undefined,
        replace: options.force,
        yes: options.yes || options.json,
        dryRun: options.dryRun,
      };
      const interactive = process.stdin.isTTY && process.stdout.isTTY && !request.yes && !options.json;
      const result = await install(request, interactive ? new ClackInteraction() : undefined);
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (!interactive && result.status === "planned") {
        console.log(`${pc.bold("Installation plan")}\n${result.plan.skills.map((name) => `  ${name}`).join("\n")}`);
      } else if (!interactive && result.status === "installed") {
        console.log(`${pc.green("Installed")} ${result.plan.skills.join(", ")}`);
        if (result.plan.target.kind === "environment") console.log(`${result.plan.target.create ? "Created" : "Updated"} environment ${result.plan.target.name}`);
        if (result.plan.activate && result.plan.projectRoot) console.log(`Activated in ${result.plan.projectRoot}`);
      }
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
