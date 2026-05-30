import { z } from "zod";

export const ManualCsvConfig = z.object({
  account_id: z.string().min(1),
  files: z.array(z.string().min(1)).min(1),
  columns: z.object({
    date:        z.string().default("date"),
    description: z.string().default("description"),
    amount:      z.string().default("amount"),
  }).default({}),
  date_format: z.enum(["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY"])
    .default("YYYY-MM-DD"),
  sign_convention: z.enum(["debits-positive", "debits-negative"])
    .default("debits-negative"),
  account: z.object({
    display_name: z.string().min(1),
    institution:  z.string().default("manual"),
    type:         z.string().default("checking"),
    currency:     z.string().default("USD"),
  }),
});

export type ManualCsvConfig = z.infer<typeof ManualCsvConfig>;
