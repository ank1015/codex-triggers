import type { JsonValue, TriggerOutput } from "../../domain/types.js";

export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateRenderError";
  }
}

const exactExpression = /^\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/;
const interpolatedExpression = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

function resolvePath(output: TriggerOutput, path: string): JsonValue {
  const segments = path.split(".");
  let current: unknown = { message: output.message, data: output.data };
  for (const segment of segments) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
    } else if (
      typeof current === "object" &&
      current !== null &&
      Object.hasOwn(current, segment)
    ) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new TemplateRenderError(`Template value ${path} does not exist`);
    }
  }
  if (current === undefined) {
    throw new TemplateRenderError(`Template value ${path} does not exist`);
  }
  return current as JsonValue;
}

function stringifyInterpolation(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function renderTemplateValue(
  template: JsonValue,
  output: TriggerOutput,
): JsonValue {
  if (typeof template === "string") {
    const exact = exactExpression.exec(template);
    if (exact?.[1]) return structuredClone(resolvePath(output, exact[1]));
    return template.replace(interpolatedExpression, (_match, path: string) =>
      stringifyInterpolation(resolvePath(output, path)),
    );
  }
  if (Array.isArray(template)) {
    return template.map((value) => renderTemplateValue(value, output));
  }
  if (typeof template === "object" && template !== null) {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [
        key,
        renderTemplateValue(value, output),
      ]),
    );
  }
  return template;
}

export function renderDeliveryInput(
  template: Record<string, JsonValue>,
  output: TriggerOutput,
): Record<string, JsonValue> {
  return renderTemplateValue(template, output) as Record<string, JsonValue>;
}
