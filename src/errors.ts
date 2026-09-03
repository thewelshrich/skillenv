export class SkillenvError extends Error {
  constructor(message: string, readonly code = "SKILLENV_ERROR", readonly details?: unknown) {
    super(message);
    this.name = "SkillenvError";
  }
}

export class CancelledError extends Error {
  constructor() {
    super("Operation cancelled");
    this.name = "CancelledError";
  }
}
