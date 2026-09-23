import { AgentSkillResources } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { z } from "zod";

const decodeResources = Schema.decodeUnknownExit(AgentSkillResources);

export const skillFields = {
  name: z.string().trim().min(1).max(200),
  description: z.string().max(1024),
  content: z.string().trim().min(1).max(64000),
  resources: z
    .array(
      z
        .object({
          path: z.string().max(240),
          contentBase64: z.string().max(1398104),
          executable: z.boolean().optional(),
        })
        .strict(),
    )
    .max(256)
    .superRefine((value, ctx) => {
      const result = decodeResources(value);
      if (result._tag === "Failure")
        ctx.addIssue({
          code: "custom",
          message:
            "Invalid skill resources: check paths, base64, collisions and the 2 MiB bundle limit.",
        });
    })
    .optional(),
};
