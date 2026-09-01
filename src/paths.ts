import { homedir } from "node:os";
import { join } from "node:path";

export function skillenvHome(): string {
  return process.env.SKILLENV_HOME || join(homedir(), ".skillenv");
}

export function libraryDir(): string {
  return join(skillenvHome(), "skills");
}

export function environmentsDir(): string {
  return join(skillenvHome(), "environments");
}
