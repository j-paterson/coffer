import { z } from "zod";

export const SimpleFinConfig = z.object({
  access_url_env: z.string().min(1).default("SIMPLEFIN_ACCESS_URL"),
  lookback_days: z.number().int().positive().default(90),
  include_pending: z.boolean().default(false),
  account_overrides: z.record(
    z.string().min(1),
    z.object({
      type:         z.string().min(1).optional(),
      display_name: z.string().min(1).optional(),
      institution:  z.string().min(1).optional(),
    }),
  ).default({}),
});

export type SimpleFinConfig = z.infer<typeof SimpleFinConfig>;
