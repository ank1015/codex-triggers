import { ValidationError } from "../domain/validation.js";

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError("request body must contain valid JSON");
  }
}

export function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ValidationError("limit must be an integer between 1 and 500");
  }
  return limit;
}
