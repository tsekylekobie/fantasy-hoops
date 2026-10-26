// Each user's punt weights for the players page (users.category_weights, migration 0012).
import type { Pool } from "pg";
import { DEFAULT_WEIGHTS, type CategoryWeights } from "../types";
import { toWeights } from "./params";

/** The user's saved weights, or the defaults when never saved (or saved before a category existed). */
export async function getWeights(db: Pool, userId: number): Promise<CategoryWeights> {
  const { rows } = await db.query<{ category_weights: unknown }>(
    `SELECT category_weights FROM users WHERE id = $1`,
    [userId],
  );
  return toWeights(rows[0]?.category_weights) ?? { ...DEFAULT_WEIGHTS };
}

export async function saveWeights(db: Pool, userId: number, weights: CategoryWeights): Promise<void> {
  await db.query(`UPDATE users SET category_weights = $2 WHERE id = $1`, [userId, JSON.stringify(weights)]);
}
