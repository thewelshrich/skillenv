export class SkillenvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillenvError";
  }
}
