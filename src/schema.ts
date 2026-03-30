// ── Schema Validation ────────────────────────────────────────
// Optional schema enforcement for collections.
// Define field types, required fields, defaults, and custom validators.

import { SchemaError } from './errors.js';

/** Supported field types */
export type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any';

/** Schema definition for a single field */
export interface FieldDef {
  type: FieldType;
  required?: boolean;
  default?: any;
  min?: number;       // min value (numbers) or min length (strings/arrays)
  max?: number;       // max value (numbers) or max length (strings/arrays)
  enum?: any[];       // allowed values
  match?: RegExp;     // regex pattern for strings
  validate?: (value: any) => boolean | string; // custom validator
}

/** Full collection schema */
export interface CollectionSchema {
  fields: Record<string, FieldDef>;
  strict?: boolean; // reject unknown fields (default: false)
}

/**
 * Validate a document against a schema.
 * Applies defaults for missing optional fields.
 * Throws SchemaError on first violation.
 * Returns the validated (and possibly defaulted) document.
 */
export function validateDocument(
  doc: Record<string, any>,
  schema: CollectionSchema,
): Record<string, any> {
  const result = { ...doc };

  // Check for unknown fields in strict mode
  if (schema.strict) {
    for (const key of Object.keys(result)) {
      if (key === '_id' || key === '_ts') continue;
      if (!(key in schema.fields)) {
        throw new SchemaError(key, 'unknown field (strict mode)');
      }
    }
  }

  // Validate each field
  for (const [name, def] of Object.entries(schema.fields)) {
    let value = result[name];

    // Apply default
    if (value === undefined || value === null) {
      if (def.default !== undefined) {
        value = typeof def.default === 'function' ? def.default() : def.default;
        result[name] = value;
      }
    }

    // Required check
    if (def.required && (value === undefined || value === null)) {
      throw new SchemaError(name, 'required field is missing');
    }

    // Skip further validation if value is absent and not required
    if (value === undefined || value === null) continue;

    // Type check
    if (def.type !== 'any') {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== def.type) {
        throw new SchemaError(name, `expected ${def.type}, got ${actualType}`);
      }
    }

    // Min/max for numbers
    if (def.type === 'number' && typeof value === 'number') {
      if (def.min !== undefined && value < def.min) {
        throw new SchemaError(name, `value ${value} is below minimum ${def.min}`);
      }
      if (def.max !== undefined && value > def.max) {
        throw new SchemaError(name, `value ${value} exceeds maximum ${def.max}`);
      }
    }

    // Min/max for strings (length)
    if (def.type === 'string' && typeof value === 'string') {
      if (def.min !== undefined && value.length < def.min) {
        throw new SchemaError(name, `length ${value.length} is below minimum ${def.min}`);
      }
      if (def.max !== undefined && value.length > def.max) {
        throw new SchemaError(name, `length ${value.length} exceeds maximum ${def.max}`);
      }
    }

    // Min/max for arrays (length)
    if (def.type === 'array' && Array.isArray(value)) {
      if (def.min !== undefined && value.length < def.min) {
        throw new SchemaError(name, `array length ${value.length} is below minimum ${def.min}`);
      }
      if (def.max !== undefined && value.length > def.max) {
        throw new SchemaError(name, `array length ${value.length} exceeds maximum ${def.max}`);
      }
    }

    // Enum check
    if (def.enum && !def.enum.includes(value)) {
      throw new SchemaError(name, `value must be one of: ${def.enum.join(', ')}`);
    }

    // Regex match
    if (def.match && typeof value === 'string' && !def.match.test(value)) {
      throw new SchemaError(name, `value does not match pattern ${def.match}`);
    }

    // Custom validator
    if (def.validate) {
      const result = def.validate(value);
      if (result === false) {
        throw new SchemaError(name, 'custom validation failed');
      }
      if (typeof result === 'string') {
        throw new SchemaError(name, result);
      }
    }
  }

  return result;
}

/** Check if a schema is valid (doesn't throw on valid docs) */
export function isValid(doc: Record<string, any>, schema: CollectionSchema): boolean {
  try {
    validateDocument(doc, schema);
    return true;
  } catch {
    return false;
  }
}
