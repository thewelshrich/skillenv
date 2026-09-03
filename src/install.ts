import { environmentExists, listEnvironments, putEnvironmentSkills, readEnvironment, type EnvironmentChange } from "./environments.js";
import { CancelledError, SkillenvError } from "./errors.js";
import { inspectLibrary, installLibrarySkills, type LibraryChange } from "./library.js";
import { activate, getStatus, type StatusResult } from "./materialize.js";
import type { InstallInteraction, TargetDecision } from "./prompts.js";
import { nameSchema } from "./schema.js";
import { resolveSource, sanitizeSourceInput, type ResolvedSource, type SkillCandidate } from "./sources.js";

export type SkillSelection = { kind: "all" } | { kind: "named"; names: string[] };

export interface InstallRequest {
  source?: string;
  path?: string;
  selection?: SkillSelection;
  target?: TargetDecision;
  activate?: boolean;
  replace?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  cwd?: string;
}

export interface InstallPlan {
  source: string;
  path: string | null;
  skills: string[];
  replacing: string[];
  unchanged: string[];
  target: TargetDecision;
  activate: boolean;
  projectRoot: string | null;
  projectGitExclude: boolean | null;
}

export type InstallResult =
  | { status: "cancelled" }
  | { status: "planned"; plan: InstallPlan }
  | { status: "installed"; plan: InstallPlan; installed: string[]; replaced: string[]; unchanged: string[] };

function requireInput(message: string): never {
  throw new SkillenvError(message, "INPUT_REQUIRED");
}

function selectCandidates(source: ResolvedSource, selection: SkillSelection | undefined, interaction?: InstallInteraction): Promise<SkillCandidate[]> | SkillCandidate[] {
  if (selection?.kind === "all") return source.skills;
  if (selection?.kind === "named") {
    const requested = new Set(selection.names);
    const selected = source.skills.filter((skill) => requested.has(skill.name));
    const missing = selection.names.filter((name) => !selected.some((skill) => skill.name === name));
    if (missing.length) throw new SkillenvError(`Unknown skills: ${missing.join(", ")}. Available: ${source.skills.map((skill) => skill.name).join(", ")}`, "SKILL_SELECTION_INVALID");
    return selected;
  }
  if (source.skills.length === 1) return source.skills;
  if (!interaction) requireInput(`Source contains ${source.skills.length} skills; use --skill <name> or --all`);
  return interaction.skills(source.skills).then((names) => source.skills.filter((skill) => names.includes(skill.name)));
}

export function installPlanLines(plan: InstallPlan): string[] {
  const lines = [`Skills (${plan.skills.length}): ${plan.skills.join(", ")}`, "Target: personal library"];
  if (plan.path) lines.splice(1, 0, `Path: ${plan.path}`);
  if (plan.replacing.length) lines.push(`Replace: ${plan.replacing.join(", ")}`);
  if (plan.unchanged.length) lines.push(`Already current: ${plan.unchanged.join(", ")}`);
  if (plan.target.kind === "environment") lines.push(`Environment: ${plan.target.create ? "create" : "update"} ${plan.target.name}`);
  else lines.push("Environment: unchanged (library only)");
  lines.push(plan.activate && plan.projectRoot ? `Activation: ${plan.projectRoot}` : "Activation: unchanged");
  return lines;
}

export async function install(request: InstallRequest, interaction?: InstallInteraction): Promise<InstallResult> {
  let source: ResolvedSource | null = null;
  const cwd = request.cwd ?? process.cwd();
  try {
    interaction?.intro();
    const sourceInput = request.source ?? (interaction ? await interaction.source() : requireInput("A source is required"));
    if (!sourceInput.trim()) requireInput("A source is required");
    source = interaction
      ? await interaction.task("Resolving source…", () => resolveSource(sourceInput, { path: request.path }))
      : await resolveSource(sourceInput, { path: request.path });
    const selected = await selectCandidates(source, request.selection, interaction);
    if (!selected.length) throw new SkillenvError("Select at least one skill", "SKILL_SELECTION_INVALID");

    const inspection = await inspectLibrary(selected);
    let replace = request.replace ?? false;
    let allowedConflicts: string[] | undefined;
    if (inspection.conflicts.length && !replace) {
      if (!interaction) throw new SkillenvError(`Library conflicts: ${inspection.conflicts.join(", ")} (use --force to replace)`, "LIBRARY_CONFLICT");
      replace = await interaction.replace(inspection.conflicts);
      if (!replace) throw new CancelledError();
      allowedConflicts = inspection.conflicts;
    }

    const environments = !request.target ? await listEnvironments() : [];
    let status: StatusResult | null = null;
    let target = request.target;
    if (!target) {
      if (!interaction) requireInput("Choose --env <name>, --create-env <name>, or --library-only");
      status = await getStatus(cwd, { recover: !request.dryRun });
      target = await interaction.target(environments, status.state?.environment ?? null);
    }
    if (target.kind === "environment") {
      const name = nameSchema.parse(target.name);
      target = { ...target, name };
      const exists = request.target ? await environmentExists(name) : environments.some((environment) => environment.name === name);
      if (target.create && exists) throw new SkillenvError(`Environment '${target.name}' already exists`);
      if (!target.create && !exists) throw new SkillenvError(`Unknown environment '${target.name}'`);
      if (!target.create && request.target) await readEnvironment(name);
    }

    let shouldActivate = request.activate ?? false;
    if (target.kind === "environment" && request.activate === undefined && interaction) {
      status ??= await getStatus(cwd, { recover: !request.dryRun });
      shouldActivate = await interaction.activate(target.name, status.project.root, status.state?.environment === target.name);
    }
    if (target.kind === "library" && shouldActivate) throw new SkillenvError("--activate requires an environment target", "INVALID_INPUT");
    if (shouldActivate) status ??= await getStatus(cwd, { recover: !request.dryRun });

    const plan: InstallPlan = {
      source: sanitizeSourceInput(source.input),
      path: source.selectedPath,
      skills: selected.map((skill) => skill.name),
      replacing: inspection.conflicts,
      unchanged: inspection.unchanged,
      target,
      activate: shouldActivate,
      projectRoot: shouldActivate ? status!.project.root : null,
      projectGitExclude: shouldActivate ? Boolean(status!.project.gitExclude) : null,
    };

    if (request.dryRun) {
      interaction?.preview(installPlanLines(plan));
      return { status: "planned", plan };
    }
    if (!request.yes) {
      if (!interaction) requireInput("Confirmation required; pass --yes for non-interactive installation");
      if (!(await interaction.confirm(installPlanLines(plan)))) throw new CancelledError();
    }

    let libraryChange: LibraryChange | null = null;
    let environmentChange: EnvironmentChange | null = null;
    let transactionFinalized = false;
    try {
      const approvedState = Object.fromEntries(selected.map((skill) => [skill.name, {
        skill: inspection.existingFingerprints[skill.name] ?? null,
        metadata: inspection.metadataFingerprints[skill.name] ?? null,
      }]));
      libraryChange = await installLibrarySkills(
        selected,
        { input: source.input, kind: source.kind, revision: source.revision },
        { replace, allowedConflicts, approvedState },
      );
      if (target.kind === "environment") {
        environmentChange = await putEnvironmentSkills(target, selected.map((skill) => skill.name), {
          beforeWrite: (previous, next) => libraryChange!.recordEnvironment(previous, next),
        });
      }
      if (target.kind === "environment" && shouldActivate) {
        await libraryChange.finalize({ keepLock: true });
        transactionFinalized = true;
        try {
          await activate(target.name, cwd, { libraryLockHeld: true, expectedEnvironment: environmentChange!.environment });
        } finally {
          await libraryChange.release();
        }
      } else {
        await libraryChange.finalize();
        transactionFinalized = true;
      }
    } catch (error) {
      const recoveryErrors: unknown[] = [];
      if (!transactionFinalized) {
        await environmentChange?.rollback().catch((recoveryError) => recoveryErrors.push(recoveryError));
        await libraryChange?.rollback().catch((recoveryError) => recoveryErrors.push(recoveryError));
      }
      if (recoveryErrors.length) {
        const original = error instanceof Error ? error.message : String(error);
        const recovery = recoveryErrors.map((item) => item instanceof Error ? item.message : String(item)).join("; ");
        throw new SkillenvError(`Installation failed: ${original}. Automatic recovery was incomplete: ${recovery}`, "RECOVERY_REQUIRED");
      }
      throw error;
    }

    const result: InstallResult = {
      status: "installed",
      plan,
      installed: libraryChange.installed,
      replaced: libraryChange.replaced,
      unchanged: libraryChange.unchanged,
    };
    interaction?.success(`Installed ${plan.skills.length} skill${plan.skills.length === 1 ? "" : "s"}${target.kind === "environment" ? ` into ${target.name}` : ""}`);
    return result;
  } catch (error) {
    if (error instanceof CancelledError) {
      interaction?.cancel();
      return { status: "cancelled" };
    }
    throw error;
  } finally {
    await source?.cleanup().catch(() => {});
  }
}
