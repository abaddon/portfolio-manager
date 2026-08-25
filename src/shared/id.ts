import { randomUUID } from "node:crypto";

/** Generates unique identifiers. Wrapped so tests can rely on uniqueness only, never on format. */
export function newId(prefix?: string): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}
