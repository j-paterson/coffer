import { Hono } from "hono";
import type { Ctx } from "../ctx";
import { normalizeCategory } from "../../../../packages/shared/categories";

const route = new Hono();

// PATCH /api/items/:id
// Update an item's category and/or subcategory. When category is set, writes
// category_source='user' so re-classification never overwrites. Also extracts
// a learned keyword rule for auto-classifying future items with similar names.
// subcategory can be set independently; it is trimmed but not normalized.
route.patch("/:id", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const id = Number(c.req.param("id"));

  let body: { category?: string | null; subcategory?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }

  const hasCat = "category" in body;
  const hasSub = "subcategory" in body;
  if (!hasCat && !hasSub) {
    return c.json({ error: "category or subcategory required" }, 400);
  }

  const item = ctx.db
    .prepare(
      "SELECT id, name, short_name, category, transaction_v2_id "
      + "FROM transaction_items WHERE id = ?",
    )
    .get(id) as {
      id: number;
      name: string;
      short_name: string | null;
      category: string | null;
      transaction_v2_id: number | null;
    } | undefined;

  if (!item) {
    return c.json({ error: "item not found" }, 404);
  }

  if (hasCat && body.category !== null && typeof body.category !== "string") {
    return c.json({ error: "category must be a string or null" }, 400);
  }
  if (hasSub && body.subcategory !== null && typeof body.subcategory !== "string") {
    return c.json({ error: "subcategory must be a string or null" }, 400);
  }

  // Build the UPDATE dynamically based on which keys are present.
  const sets: string[] = [];
  const params: (string | number | null)[] = [];

  let normalizedCategory: string | null = null;
  if (hasCat) {
    normalizedCategory = body.category == null
      ? null
      : normalizeCategory(body.category);
    // We set category_source='user' for both setting and clearing the category —
    // both are deliberate user actions, and we don't want auto-classification to
    // overwrite a user's null choice.
    sets.push("category = ?", "category_source = 'user'");
    params.push(normalizedCategory);
  }
  if (hasSub) {
    const sub = body.subcategory == null ? null : body.subcategory.trim();
    sets.push("subcategory = ?");
    params.push(sub);
  }
  params.push(id);

  ctx.db
    .prepare(`UPDATE transaction_items SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params);

  // Extract a rule from the item's short_name (preferred) or raw name.
  // Pick the most distinctive token — longest non-stopword.
  // Only runs when category was set and non-null.
  let keyword: string | null = null;
  let reclassified = 0;

  if (hasCat && normalizedCategory) {
    const category = normalizedCategory;
    const target = item.short_name ?? item.name ?? "";
    keyword = extractDistinctiveToken(target);

    if (keyword) {
      ctx.db
        .prepare(
          `
          INSERT INTO user_item_rules (keyword, category, source_item_id)
          VALUES (?, ?, ?)
          ON CONFLICT(keyword, category) DO UPDATE SET
            hits = hits + 1,
            source_item_id = excluded.source_item_id
          `,
        )
        .run(keyword, category, id);

      // Propagate to matching items, but never overwrite user-categorized ones.
      const result = ctx.db
        .prepare(
          `
          UPDATE transaction_items
          SET category = ?, category_source = 'learned'
          WHERE id != ?
            AND (category_source IS NULL OR category_source != 'user')
            AND (LOWER(COALESCE(short_name, name)) LIKE ?)
          `,
        )
        .run(category, id, `%${keyword}%`);
      reclassified = result.changes;
    }

    // Second pass: merchant-key propagation. The token approach above misses
    // anything where the per-row noise (PPD ID, Web ID, dot-com fragment,
    // last-4 dots) wins as the "longest token" — the noise differs row to
    // row so LIKE %keyword% never matches across rows. Strip that noise from
    // the parent transaction's description and propagate to items whose
    // parent has the same normalized description.
    if (item.transaction_v2_id != null) {
      const parent = ctx.db
        .prepare("SELECT description FROM transactions_v2 WHERE id = ?")
        .get(item.transaction_v2_id) as { description: string | null } | undefined;
      const sourceKey = normalizeMerchantKey(parent?.description ?? null);
      if (sourceKey) {
        // Build a candidate set: items not user-tagged, not the source,
        // whose parent transaction's normalized description equals sourceKey.
        const candidates = ctx.db
          .prepare(
            `
            SELECT i.id, t.description
            FROM transaction_items i
            JOIN transactions_v2 t ON t.id = i.transaction_v2_id
            WHERE i.id != ?
              AND (i.category_source IS NULL OR i.category_source != 'user')
              AND t.description IS NOT NULL
            `,
          )
          .all(id) as { id: number; description: string }[];
        const matchIds = candidates
          .filter((r) => normalizeMerchantKey(r.description) === sourceKey)
          .map((r) => r.id);
        if (matchIds.length) {
          const placeholders = matchIds.map(() => "?").join(",");
          const merchantResult = ctx.db
            .prepare(
              `
              UPDATE transaction_items
              SET category = ?, category_source = 'learned'
              WHERE id IN (${placeholders})
                AND (category_source IS NULL OR category_source != 'user')
              `,
            )
            .run(category, ...matchIds);
          // Sum with the keyword pass; rows reachable by both still count once
          // because the user-guard prevents double-touching when the keyword
          // pass already moved them to 'learned'... actually it doesn't (both
          // passes write 'learned'). Subtract the intersection.
          const intersection = ctx.db
            .prepare(
              `
              SELECT COUNT(*) AS n FROM transaction_items
              WHERE id IN (${placeholders})
                AND LOWER(COALESCE(short_name, name)) LIKE ?
              `,
            )
            .get(...matchIds, `%${keyword}%`) as { n: number };
          reclassified += merchantResult.changes - intersection.n;
        }
      }
    }
  }

  return c.json({
    ok: true,
    id,
    ...(hasCat ? { category: normalizedCategory } : {}),
    keyword_learned: keyword,
    reclassified,
  });
});

// PATCH /api/items/categories/bulk
// Apply the same category and/or subcategory to many items in one shot. Used
// by multi-select recategorization on the spending page. Unlike the per-item
// PATCH this does NOT extract keyword rules or run merchant propagation —
// the user has already made an explicit choice for each row, so we'd just
// generate noisy auto-rules. category_source is still flipped to 'user' so
// later auto-classification doesn't overwrite these picks.
route.patch("/categories/bulk", async (c) => {
  const ctx = c.get("ctx") as Ctx;

  let body: {
    ids?: unknown;
    category?: string | null;
    subcategory?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "request body must be JSON" }, 400);
  }

  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return c.json({ error: "ids must be a non-empty array" }, 400);
  }
  const ids: number[] = [];
  for (const v of body.ids) {
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      return c.json({ error: "ids must be an array of positive integers" }, 400);
    }
    ids.push(v);
  }

  const hasCat = "category" in body;
  const hasSub = "subcategory" in body;
  if (!hasCat && !hasSub) {
    return c.json({ error: "category or subcategory required" }, 400);
  }
  if (hasCat && body.category !== null && typeof body.category !== "string") {
    return c.json({ error: "category must be a string or null" }, 400);
  }
  if (hasSub && body.subcategory !== null && typeof body.subcategory !== "string") {
    return c.json({ error: "subcategory must be a string or null" }, 400);
  }

  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (hasCat) {
    const normalized = body.category == null ? null : normalizeCategory(body.category);
    sets.push("category = ?", "category_source = 'user'");
    params.push(normalized);
  }
  if (hasSub) {
    const sub = body.subcategory == null ? null : body.subcategory.trim();
    sets.push("subcategory = ?");
    params.push(sub);
  }

  const placeholders = ids.map(() => "?").join(",");
  const result = ctx.db
    .prepare(
      `UPDATE transaction_items SET ${sets.join(", ")} WHERE id IN (${placeholders})`,
    )
    .run(...params, ...ids);

  return c.json({ ok: true, items_updated: result.changes });
});

route.patch("/categories/merge", async (c) => {
  const ctx = c.get("ctx") as Ctx;
  const body = await c.req.json<{ from: string; to: string }>();
  const from = normalizeCategory(body.from);
  const to = normalizeCategory(body.to);
  if (!from || !to || from === to) {
    return c.json({ error: "need distinct from and to" }, 400);
  }

  const result = ctx.db
    .prepare("UPDATE transaction_items SET category = ? WHERE category = ?")
    .run(to, from);

  ctx.db
    .prepare("UPDATE transaction_items SET subcategory = ? WHERE subcategory = ?")
    .run(to, from);

  return c.json({
    from,
    to,
    items_updated: result.changes,
  });
});

route.get("/categories", (c) => {
  const ctx = c.get("ctx") as Ctx;
  const rows = ctx.db
    .prepare(
      `SELECT category, subcategory, COUNT(*) AS n
       FROM transaction_items
       WHERE category IS NOT NULL
       GROUP BY category, subcategory
       ORDER BY category, n DESC`,
    )
    .all() as { category: string; subcategory: string | null; n: number }[];

  const usageByCat = new Map<string, number>();
  const subsByCat = new Map<string, string[]>();
  for (const r of rows) {
    usageByCat.set(r.category, (usageByCat.get(r.category) ?? 0) + r.n);
    if (r.subcategory) {
      const arr = subsByCat.get(r.category) ?? [];
      arr.push(r.subcategory);
      subsByCat.set(r.category, arr);
    }
  }

  const out = [...usageByCat.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([category]) => ({
      category,
      subcategories: subsByCat.get(category) ?? [],
    }));

  return c.json(out);
});

export default route;

// --- helpers ---

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "at",
  "by", "with", "from", "is", "it", "its", "was",
  // Packaging noise
  "oz", "lb", "ml", "ct", "pk", "pack", "count", "box", "bag", "can",
  "bottle", "jar", "roll", "sheet",
  // Marketing
  "premium", "organic", "natural", "fresh", "original", "classic",
  "free", "new", "best", "pro", "ultra", "super", "max", "plus",
  // Sizing
  "small", "medium", "large", "xl", "xxl",
]);

// Strip per-row noise from a transaction description so two transactions
// from the same merchant collapse to the same key. Drops PPD/Web/REF/Trace
// IDs (and the alphanumeric token following them), URL-shaped fragments
// like "help.uber.com", and "...524"-style last-4 markers.
export function normalizeMerchantKey(desc: string | null): string | null {
  if (!desc) return null;
  let s = desc;
  s = s.replace(/\b(PPD\s*ID|WEB\s*ID|REF\s*#?|TRACE)\s*:?\s*\S+/gi, "");
  s = s.replace(/\b\S*\.(com|net|org|io|co|app|us|biz|gov)\b\S*/gi, "");
  s = s.replace(/\.{2,}\d+/g, "");
  // Strip standalone 4+ digit numbers (invoice/order/auth numbers).
  // Per-row variation in these defeats cross-row merchant matching.
  s = s.replace(/\b\d{4,}\b/g, "");
  s = s.toLowerCase().replace(/\s+/g, " ").trim();
  return s || null;
}

function extractDistinctiveToken(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));

  if (tokens.length === 0) return null;

  // Pick the longest token — typically the brand or product type,
  // which is the most distinctive signal. E.g., "kodiak" from
  // "Kodiak Cakes" or "boresnake" from "Boresnake".
  tokens.sort((a, b) => b.length - a.length);
  return tokens[0];
}
