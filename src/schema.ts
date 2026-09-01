import { z } from "zod";

export const nameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "must contain only letters, numbers, dots, underscores, and hyphens");

export const environmentSchema = z.object({
  version: z.literal(1),
  name: nameSchema,
  skills: z.array(nameSchema),
});

export type Environment = z.infer<typeof environmentSchema>;

export const managedEntrySchema = z.object({
  skill: nameSchema,
  path: z.string().min(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const projectStateSchema = z.object({
  version: z.literal(1),
  hashVersion: z.literal(2).optional(),
  environment: nameSchema,
  activatedAt: z.string(),
  managed: z.array(managedEntrySchema),
});

export type ProjectState = z.infer<typeof projectStateSchema>;

export const skillMetadataSchema = z.object({
  version: z.literal(1),
  name: nameSchema,
  description: z.string(),
  source: z.string().min(1),
  sourceKind: z.enum(["local", "git"]),
  sourcePath: z.string(),
  revision: z.string().nullable(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  installedAt: z.string(),
});

export type SkillMetadata = z.infer<typeof skillMetadataSchema>;
