export class ProtocolError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
    this.name = 'ProtocolError';
  }
}
export type RecordValue = Record<string, unknown>;
export function fail(code: string, message: string, status = 400): never {
  throw new ProtocolError(code, message, status);
}
export function object(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail('INVALID_SHAPE', `${label} must be a plain object`);
  }
  return value as RecordValue;
}
export function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail('UNSUPPORTED_FIELD', `${label}: unsupported field ${key}`);
  }
}
export function text(value: unknown, label: string, nonempty = false): string {
  if (typeof value !== 'string' || (nonempty && value.length === 0)) {
    fail('INVALID_SHAPE', `${label} must be ${nonempty ? 'nonempty ' : ''}text`);
  }
  return value;
}
export function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) fail('INVALID_SHAPE', `${label} must be an array`);
  return value;
}
export function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    fail('INVALID_SHAPE', `${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}
/** Reject prototype keys, cycles, exotic objects and pathological JSON before use. */
export function safeJson(value: unknown, maxDepth = 24): void {
  let nodes = 0;
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): void {
    if (++nodes > 20_000 || depth > maxDepth) fail('JSON_LIMIT', 'JSON complexity limit exceeded');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v !== 'object' || v === null) fail('INVALID_JSON', 'Only JSON values are accepted');
    if (seen.has(v)) fail('INVALID_JSON', 'Cyclic JSON is not accepted');
    seen.add(v);
    if (Array.isArray(v)) { for (const entry of v) visit(entry, depth + 1); }
    else {
      const record = object(v, 'JSON');
      for (const [key, entry] of Object.entries(record)) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('UNSAFE_JSON', 'Prototype-related JSON key rejected');
        visit(entry, depth + 1);
      }
    }
    seen.delete(v);
  }
  visit(value, 0);
}
export function parseJson(value: string, label: string): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch { fail('INVALID_JSON', `${label} is not complete valid JSON`); }
  // JSON.parse alone silently accepts duplicate object keys. Refuse ambiguity,
  // including escaped duplicate spellings, before any tool execution.
  const stack: Array<{ object: boolean; expectKey: boolean; names: Set<string> }> = [];
  for (const match of value.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\],:]/g)) {
    const token = match[0];
    if (token === '{' || token === '[') stack.push({ object: token === '{', expectKey: token === '{', names: new Set() });
    else if (token === '}' || token === ']') stack.pop();
    else {
      const current = stack.at(-1);
      if (token === ',' && current?.object) current.expectKey = true;
      else if (token.startsWith('"') && current?.object && current.expectKey) {
        const name = JSON.parse(token) as string;
        if (current.names.has(name)) fail('DUPLICATE_JSON_KEY', `${label} contains duplicate object keys`);
        current.names.add(name);
        current.expectKey = false;
      }
    }
  }
  safeJson(parsed);
  return parsed;
}

/** Deliberately bounded JSON-schema subset, not a general JSON-schema engine. */
export function checkSchema(raw: unknown, depth = 0): RecordValue {
  if (depth > 12) fail('SCHEMA_LIMIT', 'Schema nesting limit exceeded');
  const schema = object(raw, 'parameters');
  keys(schema, ['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minimum', 'maximum', 'default'], 'schema');
  if (!['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(String(schema.type))) {
    fail('UNSUPPORTED_SCHEMA', 'Schema must declare one supported type');
  }
  if (schema.description !== undefined) text(schema.description, 'schema.description');
  if (schema.enum !== undefined && array(schema.enum, 'schema.enum').length === 0) fail('INVALID_SCHEMA', 'Empty enum');
  for (const bound of ['minimum', 'maximum'] as const) {
    if (schema[bound] !== undefined && (typeof schema[bound] !== 'number' || !Number.isFinite(schema[bound]))) fail('INVALID_SCHEMA', 'Invalid numeric bound');
    if (schema[bound] !== undefined && !['number', 'integer'].includes(String(schema.type))) fail('INVALID_SCHEMA', 'Bounds require numeric schema');
  }
  if (schema.type === 'object') {
    if (schema.items !== undefined) fail('INVALID_SCHEMA', 'Object schema cannot declare items');
    const props = object(schema.properties, 'schema.properties');
    for (const prop of Object.values(props)) checkSchema(prop, depth + 1);
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') fail('UNSUPPORTED_SCHEMA', 'additionalProperties must be boolean');
    const required = schema.required === undefined ? [] : array(schema.required, 'schema.required');
    const unique = new Set<string>();
    for (const item of required) {
      const name = text(item, 'required property', true);
      if (!Object.hasOwn(props, name) || unique.has(name)) fail('INVALID_SCHEMA', 'Unknown or duplicate required property');
      unique.add(name);
    }
  } else if (schema.type === 'array') {
    if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) fail('INVALID_SCHEMA', 'Array schema has object keywords');
    checkSchema(schema.items, depth + 1);
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.items !== undefined || schema.additionalProperties !== undefined) {
    fail('INVALID_SCHEMA', 'Schema keyword incompatible with type');
  }
  return schema;
}
export function validateArguments(raw: unknown, schema: RecordValue): string {
  const encoded = text(raw, 'function.arguments');
  if (new TextEncoder().encode(encoded).byteLength > 65_536) fail('ARGUMENT_LIMIT', 'Function arguments exceed limit');
  const value = object(parseJson(encoded, 'function.arguments'), 'function.arguments');
  function validate(v: unknown, s: RecordValue): void {
    const type = s.type;
    const valid = type === 'null' ? v === null : type === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) :
      type === 'array' ? Array.isArray(v) : type === 'integer' ? typeof v === 'number' && Number.isSafeInteger(v) : typeof v === type;
    if (!valid) fail('INVALID_ARGUMENTS', 'Function argument type mismatch');
    if (s.enum !== undefined && !array(s.enum, 'enum').some(item => JSON.stringify(item) === JSON.stringify(v))) fail('INVALID_ARGUMENTS', 'Function argument outside enum');
    if (typeof v === 'number' && ((typeof s.minimum === 'number' && v < s.minimum) || (typeof s.maximum === 'number' && v > s.maximum))) fail('INVALID_ARGUMENTS', 'Function argument outside numeric bounds');
    if (type === 'object') {
      const rec = object(v, 'arguments');
      const props = object(s.properties, 'schema.properties');
      for (const required of (s.required ?? []) as string[]) if (!Object.hasOwn(rec, required)) fail('INVALID_ARGUMENTS', 'Missing required argument');
      // Unknown function arguments are always refused, even OV schemas without additionalProperties:false.
      for (const [name, entry] of Object.entries(rec)) {
        if (!Object.hasOwn(props, name)) fail('INVALID_ARGUMENTS', 'Unknown function argument');
        validate(entry, object(props[name], 'property schema'));
      }
    }
    if (type === 'array') for (const entry of array(v, 'argument array')) validate(entry, object(s.items, 'items schema'));
  }
  validate(value, schema);
  return encoded;
}
