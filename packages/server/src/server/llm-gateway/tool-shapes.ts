/**
 * Tool schemas as each vendor's API reads them, shaped on the way upstream
 * (myna's chat_tool_shape.go, object_root.go, oneof_schema.go,
 * grok_schema.go and additional_tools.go).
 *
 * Neolix translates tools through the IR, which writes the standard shape of
 * the target protocol. What is left are the shapes a client sent in another
 * API's spelling and the JSON Schema keywords a vendor refuses.
 */

import { fromLite } from "./codex-lite.js";

type Json = Record<string, unknown>;

const SCHEMA_MAPS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const SCHEMA_ONE = new Set([
  "items",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);
const SCHEMA_LIST = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

/**
 * A schema without boolean schemas or x- keywords, which Vertex's Schema
 * object can't hold: true is {}, false is left out. keep is false when the
 * schema itself is false.
 */
function cleanSchema(value: unknown): { value: unknown; keep: boolean } {
  if (value === true) {
    return { value: {}, keep: true };
  }
  if (value === false) {
    return { value: undefined, keep: false };
  }
  if (!isRecord(value)) {
    return { value, keep: true };
  }
  const out: Json = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.startsWith("x-")) {
      continue;
    }
    if (SCHEMA_MAPS.has(key) && isRecord(entry)) {
      const kept: Json = {};
      for (const [name, schema] of Object.entries(entry)) {
        const cleaned = cleanSchema(schema);
        if (cleaned.keep) {
          kept[name] = cleaned.value;
        }
      }
      out[key] = kept;
      continue;
    }
    if (SCHEMA_ONE.has(key)) {
      const cleaned = cleanSchema(entry);
      if (cleaned.keep) {
        out[key] = cleaned.value;
      }
      continue;
    }
    if (SCHEMA_LIST.has(key) && Array.isArray(entry)) {
      const kept: unknown[] = [];
      for (const schema of entry) {
        const cleaned = cleanSchema(schema);
        if (cleaned.keep) {
          kept.push(cleaned.value);
        }
      }
      out[key] = kept;
      continue;
    }
    out[key] = entry;
  }
  return { value: out, keep: true };
}

/** Every schema a tool's parameters hold, cleaned for Vertex. */
function cleanTools(tools: unknown[]): unknown[] {
  return tools.map((tool) => {
    if (!isRecord(tool)) {
      return tool;
    }
    if (Array.isArray(tool.functionDeclarations)) {
      return {
        ...tool,
        functionDeclarations: tool.functionDeclarations.map((entry) => {
          if (!isRecord(entry) || !isRecord(entry.parameters)) {
            return entry;
          }
          const cleaned = cleanSchema(entry.parameters);
          return { ...entry, parameters: cleaned.keep ? cleaned.value : {} };
        }),
      };
    }
    const fn = isRecord(tool.function) ? tool.function : tool;
    if (!isRecord(fn) || !isRecord(fn.parameters)) {
      return tool;
    }
    const cleaned = cleanSchema(fn.parameters);
    const parameters = cleaned.keep ? cleaned.value : {};
    return isRecord(tool.function)
      ? { ...tool, function: { ...tool.function, parameters } }
      : { ...tool, parameters };
  });
}

/** The one type an untyped enum has, undefined when its values differ. */
function enumSchemaType(schema: Json): unknown {
  const values = enumValues(schema);
  const keyword = keywordType(schema);
  if (keyword === "object" || keyword === "array") {
    return keyword;
  }
  const nonNull = values.filter((value) => value !== null);
  const type = valuesType(nonNull);
  if (type.length === 0) {
    return undefined;
  }
  return nonNull.length === values.length ? type : [type, "null"];
}

/** A tool as a Chat Completions tool, from whichever shape it came in. */
function chatTool(tool: Json): Json {
  if (isRecord(tool.function)) {
    return tool;
  }
  const type = tool.type;
  if (type !== undefined && type !== "function") {
    return tool;
  }
  if (typeof tool.name !== "string" || tool.name.length === 0) {
    return tool;
  }
  const fn: Json = { name: tool.name };
  if (tool.description !== undefined) {
    fn.description = tool.description;
  }
  if (tool.strict !== undefined) {
    fn.strict = tool.strict;
  }
  for (const key of ["parameters", "inputSchema", "input_schema"]) {
    if (tool[key] !== undefined && fn.parameters === undefined) {
      fn.parameters = tool[key];
    }
  }
  const rest: Json = {};
  for (const [key, value] of Object.entries(tool)) {
    if (
      key !== "name" &&
      key !== "description" &&
      key !== "strict" &&
      key !== "parameters" &&
      key !== "inputSchema" &&
      key !== "input_schema"
    ) {
      rest[key] = value;
    }
  }
  return { ...rest, type: "function", function: fn };
}

/** Every function tool's parameters, wherever a protocol nests them. */
function forEachSchema(protocol: string, tools: unknown, visit: (schema: Json) => Json): unknown {
  if (!Array.isArray(tools)) {
    return tools;
  }
  return tools.map((tool) => {
    if (!isRecord(tool)) {
      return tool;
    }
    if (protocol === "openai-responses" && tool.type === "namespace") {
      return { ...tool, tools: forEachSchema(protocol, tool.tools, visit) };
    }
    if (protocol === "anthropic") {
      if (!isRecord(tool.input_schema)) {
        return tool;
      }
      const schema = visit(tool.input_schema);
      return schema === tool.input_schema ? tool : { ...tool, input_schema: schema };
    }
    const fn = protocol === "openai" && isRecord(tool.function) ? tool.function : tool;
    if (!isRecord(fn) || !isRecord(fn.parameters)) {
      return tool;
    }
    const schema = visit(fn.parameters);
    if (schema === fn.parameters) {
      return tool;
    }
    return protocol === "openai" && isRecord(tool.function)
      ? { ...tool, function: { ...tool.function, parameters: schema } }
      : { ...tool, parameters: schema };
  });
}

/** oneOf named anyOf: xgrammar-backed routers refuse oneOf. */
// debt: the keyword walk is one branch per JSON Schema keyword, as myna's
// collectOneOf; split it by keyword family if a second caller needs it.
// eslint-disable-next-line complexity
function renameOneOf(node: unknown, inSchema: boolean): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => renameOneOf(entry, inSchema));
  }
  if (!isRecord(node)) {
    return node;
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (!inSchema && key === "function") {
      out[key] = renameOneOf(value, false);
      continue;
    }
    if (!inSchema && (key === "parameters" || key === "input_schema")) {
      out[key] = renameOneOf(value, true);
      continue;
    }
    if (!inSchema) {
      out[key] = value;
      continue;
    }
    if (
      key === "properties" ||
      key === "$defs" ||
      key === "definitions" ||
      key === "dependentSchemas" ||
      key === "patternProperties"
    ) {
      out[key] = isRecord(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, schema]) => [name, renameOneOf(schema, true)]),
          )
        : value;
      continue;
    }
    if (key === "oneOf") {
      out.anyOf = renameOneOf(value, true);
      continue;
    }
    if (
      key === "items" ||
      key === "additionalProperties" ||
      key === "contains" ||
      key === "propertyNames" ||
      key === "not" ||
      key === "if" ||
      key === "then" ||
      key === "else" ||
      key === "allOf" ||
      key === "anyOf" ||
      key === "prefixItems" ||
      key === "unevaluatedProperties" ||
      key === "unevaluatedItems" ||
      key === "contentSchema"
    ) {
      out[key] = renameOneOf(value, true);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * A schema whose root is a union, folded to an object root (myna's
 * provider.ObjectRoot): allOf's branches merged, anyOf's and oneOf's object
 * branches folded into one object whose fields take any of theirs, a branch
 * that is a union itself folded first (depth at most 8), and local $refs
 * resolved against the schema's $defs/definitions.
 */
function foldRoot(schema: Json): Json {
  return objectRootIn(schema, schema, 0);
}

// debt: myna's ObjectRoot merges allOf and the anyOf/oneOf branches in one
// pass; it stays one function until another caller needs a part of it.
// eslint-disable-next-line complexity
function objectRootIn(root: Json, schema: Json, depth: number): Json {
  const hasUnion =
    schema.anyOf !== undefined || schema.oneOf !== undefined || schema.allOf !== undefined;
  if (schema.type === "object" && !hasUnion) {
    return schema;
  }
  const properties: Json = isRecord(schema.properties) ? { ...schema.properties } : {};
  const required: unknown[] = Array.isArray(schema.required) ? [...schema.required] : [];

  const allOf = Array.isArray(schema.allOf) ? schema.allOf : [];
  for (const branch of allOf) {
    const resolved = isRecord(branch) ? resolveLocalRef(root, branch) : null;
    if (resolved === null) {
      continue;
    }
    if (isRecord(resolved.properties)) {
      for (const [key, value] of Object.entries(resolved.properties)) {
        properties[key] = properties[key] ?? value;
      }
    }
    if (Array.isArray(resolved.required)) {
      required.push(...resolved.required);
    }
  }

  const branches: Json[] = [];
  for (const key of ["anyOf", "oneOf"]) {
    const list = schema[key];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const raw of list) {
      if (!isRecord(raw)) {
        continue;
      }
      let branch = resolveLocalRef(root, raw);
      if (branch === null) {
        continue;
      }
      if (hasNestedUnion(branch) && depth < 8) {
        // Folded on a copy: the branch may be a $def another branch names.
        branch = objectRootIn(root, structuredClone(branch), depth + 1);
      }
      if (branch.type !== "object" && !isRecord(branch.properties)) {
        continue;
      }
      branches.push(branch);
    }
  }

  const from = new Map<string, unknown[]>();
  const order: string[] = [];
  for (const branch of branches) {
    const branchProperties = isRecord(branch.properties) ? branch.properties : {};
    for (const key of Object.keys(branchProperties).sort()) {
      if (properties[key] !== undefined) {
        continue;
      }
      if (!from.has(key)) {
        order.push(key);
      }
      from.set(key, appendDistinct(from.get(key) ?? [], branchProperties[key]));
    }
  }
  for (const key of order) {
    const values = from.get(key) ?? [];
    properties[key] = values.length === 1 ? values[0] : { anyOf: values };
  }

  let common: unknown[] | null = null;
  for (const branch of branches) {
    const names = Array.isArray(branch.required) ? branch.required : [];
    common = common === null ? [...names] : common.filter((name) => names.includes(name));
  }
  for (const name of common ?? []) {
    if (!required.includes(name)) {
      required.push(name);
    }
  }

  const merged: unknown[] = [];
  const seen = new Set<string>();
  for (const name of required) {
    if (typeof name === "string") {
      if (seen.has(name)) {
        continue;
      }
      seen.add(name);
    }
    merged.push(name);
  }

  const out: Json = { ...schema, type: "object", properties };
  delete out.anyOf;
  delete out.oneOf;
  delete out.allOf;
  if (merged.length > 0) {
    out.required = merged;
  } else {
    delete out.required;
  }
  return out;
}

/** A branch, or what its local $ref names in the schema's $defs. */
function resolveLocalRef(root: Json, branch: Json): Json | null {
  const ref = branch.$ref;
  if (typeof ref !== "string" || ref.length === 0) {
    return branch;
  }
  for (const key of ["$defs", "definitions"]) {
    const prefix = `#/${key}/`;
    if (!ref.startsWith(prefix)) {
      continue;
    }
    const name = ref.slice(prefix.length);
    const defs = root[key];
    if (!isRecord(defs) || !isRecord(defs[name])) {
      return null;
    }
    return defs[name];
  }
  return null;
}

function hasNestedUnion(schema: Json): boolean {
  return schema.anyOf !== undefined || schema.oneOf !== undefined || schema.allOf !== undefined;
}

/** Adds a schema unless one already there is the same, key order aside. */
function appendDistinct(values: unknown[], value: unknown): unknown[] {
  const encoded = stableJSON(value);
  return values.some((entry) => stableJSON(entry) === encoded) ? values : [...values, value];
}

function stableJSON(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJSON).join(",")}]`;
  }
  if (!isRecord(value)) {
    return JSON.stringify(value) ?? "null";
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJSON(value[key])}`).join(",")}}`;
}

/** ECMAScript character classes spelled so a Rust regex reads them the same. */
function ecmaClassForRust(pattern: string): string {
  let out = "";
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "\\" && index + 1 < pattern.length) {
      out += char + (pattern[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (!inClass && char === "[") {
      inClass = true;
    } else if (inClass && char === "]") {
      inClass = false;
    } else if (inClass && char === "[") {
      out += "\\[";
      continue;
    } else if (
      inClass &&
      (char === "&" || char === "-" || char === "~") &&
      pattern[index + 1] === char
    ) {
      out += `${char}\\${char}`;
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** Every pattern in the tool schemas, escaped by fix. */
function fixPatterns(node: unknown, inSchema: boolean, fix: (pattern: string) => string): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => fixPatterns(entry, inSchema, fix));
  }
  if (!isRecord(node)) {
    return node;
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    if (!inSchema && key === "function") {
      out[key] = fixPatterns(value, false, fix);
      continue;
    }
    if (!inSchema && (key === "parameters" || key === "input_schema")) {
      out[key] = fixPatterns(value, true, fix);
      continue;
    }
    if (inSchema && key === "pattern" && typeof value === "string") {
      out[key] = fix(value);
      continue;
    }
    out[key] = inSchema || key === "tools" ? fixPatterns(value, inSchema, fix) : value;
  }
  return out;
}

/** A JSON type's name for a value, "" when it isn't one. */
function valueType(value: unknown): string {
  if (typeof value === "string") {
    return "string";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return isRecord(value) ? "object" : "";
}

/** The one type all values share, "" when there are none or they differ. */
function valuesType(values: unknown[]): string {
  const types = new Set(values.map(valueType).filter((type) => type.length > 0));
  if (types.has("number") && types.has("integer")) {
    types.delete("integer");
  }
  return types.size === 1 ? ([...types][0] ?? "") : "";
}

/** The type a schema's own keywords say, before its values do. */
function keywordType(schema: Json): string {
  const has = (...keys: string[]) => keys.some((key) => schema[key] !== undefined);
  if (
    has(
      "properties",
      "required",
      "additionalProperties",
      "patternProperties",
      "minProperties",
      "maxProperties",
      "propertyNames",
      "dependentRequired",
      "dependentSchemas",
      "unevaluatedProperties",
    )
  ) {
    return "object";
  }
  if (
    has(
      "items",
      "prefixItems",
      "minItems",
      "maxItems",
      "uniqueItems",
      "contains",
      "unevaluatedItems",
    )
  ) {
    return "array";
  }
  if (has("minLength", "maxLength", "pattern", "format", "contentEncoding", "contentMediaType")) {
    return "string";
  }
  if (has("minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf")) {
    return "number";
  }
  return "";
}

/** The one type a schema's branches agree on, "" otherwise. */
function branchType(schema: Json): string {
  const branches = ["anyOf", "oneOf", "allOf"]
    .map((key) => schema[key])
    .filter((value): value is unknown[] => Array.isArray(value));
  if (branches.length === 0) {
    return "";
  }
  const types = new Set<string>();
  for (const branch of branches.flat()) {
    if (!isRecord(branch)) {
      return "";
    }
    const type = inferredType(branch, false, 0);
    if (type.length === 0) {
      return "";
    }
    types.add(type);
  }
  return types.size === 1 ? ([...types][0] ?? "") : "";
}

/**
 * The type Vertex is told for an untyped schema, "" when no one type is
 * right for it (myna's geminiSchemaType, without $ref resolution).
 */
function inferredType(schema: Json, isRoot: boolean, depth: number): string {
  if (depth > 8) {
    return "";
  }
  const keyword = keywordType(schema);
  if (keyword === "object" || keyword === "array") {
    return keyword;
  }
  if (schema.enum !== undefined || schema.const !== undefined) {
    const values = schema.enum !== undefined ? schema.enum : [schema.const];
    if (!Array.isArray(values)) {
      return "";
    }
    return valuesType(values.filter((value) => value !== null));
  }
  const branch = branchType(schema);
  if (branch.length > 0) {
    return branch;
  }
  if (isRoot) {
    return "object";
  }
  if (schema.$ref !== undefined) {
    return "";
  }
  return "string";
}

/** Every schema of a Gemini request's tools, typed where Vertex needs it. */
function typeGeminiSchemas(node: unknown, isRoot: boolean, depth: number): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => typeGeminiSchemas(entry, false, depth));
  }
  if (!isRecord(node)) {
    return node;
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = value;
  }
  if (out.type === undefined && depth <= 8) {
    const type = inferredType(node, isRoot, depth);
    if (type.length > 0) {
      out.type = type;
    }
  }
  const NAMED_SCHEMAS = new Set([
    "properties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "patternProperties",
  ]);
  for (const key of [
    "properties",
    "$defs",
    "definitions",
    "dependentSchemas",
    "patternProperties",
    "items",
    "additionalProperties",
    "contains",
    "propertyNames",
    "then",
    "else",
    "allOf",
    "anyOf",
    "oneOf",
    "prefixItems",
    "unevaluatedProperties",
    "unevaluatedItems",
    "contentSchema",
  ]) {
    const value = out[key];
    if (value === undefined) {
      continue;
    }
    out[key] =
      NAMED_SCHEMAS.has(key) && isRecord(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, schema]) => [
              name,
              typeGeminiSchemas(schema, false, depth + 1),
            ]),
          )
        : typeGeminiSchemas(value, false, depth + 1);
  }
  return out;
}

/** Gemini tools (functionDeclarations, or a relayed Chat tool's) typed. */
function geminiToolTypes(body: Json, model: string): Json {
  if (!geminiNamed(model) || !Array.isArray(body.tools)) {
    return body;
  }
  let changed = false;
  const tools = body.tools.map((tool) => {
    if (!isRecord(tool)) {
      return tool;
    }
    if (Array.isArray(tool.functionDeclarations)) {
      changed = true;
      return {
        ...tool,
        functionDeclarations: tool.functionDeclarations.map((declaration) =>
          isRecord(declaration) && isRecord(declaration.parameters)
            ? { ...declaration, parameters: typeGeminiSchemas(declaration.parameters, true, 0) }
            : declaration,
        ),
      };
    }
    const fn = isRecord(tool.function) ? tool.function : tool;
    if (!isRecord(fn) || !isRecord(fn.parameters)) {
      return tool;
    }
    changed = true;
    const parameters = typeGeminiSchemas(fn.parameters, true, 0) as Json;
    return isRecord(tool.function)
      ? { ...tool, function: { ...tool.function, parameters } }
      : { ...tool, parameters };
  });
  return changed ? { ...body, tools } : body;
}

function geminiNamed(model: string): boolean {
  const id = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
  return id.startsWith("gemini");
}

/** The type every untyped enum or const schema of a tree is given. */
function addEnumTypes(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => addEnumTypes(entry));
  }
  if (!isRecord(node)) {
    return node;
  }
  const out: Json = { ...node };
  if (out.type === undefined && (out.enum !== undefined || out.const !== undefined)) {
    const type = enumSchemaType(node);
    if (type !== undefined) {
      out.type = type;
    }
  }
  for (const [key, value] of Object.entries(out)) {
    if (SCHEMA_MAPS.has(key) && isRecord(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, addEnumTypes(schema)]),
      );
    } else if (SCHEMA_ONE.has(key)) {
      out[key] = addEnumTypes(value);
    } else if (SCHEMA_LIST.has(key) && Array.isArray(value)) {
      out[key] = value.map((schema) => addEnumTypes(schema));
    }
  }
  return out;
}

function enumValues(schema: Json): unknown[] {
  if (Array.isArray(schema.enum)) {
    return schema.enum;
  }
  return schema.const !== undefined ? [schema.const] : [];
}

const ALL_KIMI_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"];

/** The type Kimi is given for an untyped $ref target. */
function kimiRefType(target: Json): unknown {
  const keyword = keywordType(target);
  if (keyword.length > 0) {
    return keyword;
  }
  if (target.enum !== undefined || target.const !== undefined) {
    const type = enumSchemaType(target);
    if (type !== undefined) {
      return type;
    }
  }
  return ALL_KIMI_TYPES;
}

/** The schema a local $ref names, following a chain of refs (at most 16). */
function resolveRefChain(root: Json, ref: string): Json | null {
  let current: Json | null = ref === "#" ? root : null;
  let path = ref;
  for (let step = 0; step <= 16; step += 1) {
    current ??= localRefTarget(root, path);
    if (current === null) {
      return null;
    }
    const next = current.$ref;
    if (typeof next !== "string") {
      return current;
    }
    path = next;
    current = null;
  }
  return null;
}

function localRefTarget(root: Json, ref: string): Json | null {
  if (!ref.startsWith("#/")) {
    return null;
  }
  let current: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const token = decodeURIComponent(raw.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (!isRecord(current) || !isRecord(current[token])) {
      return null;
    }
    current = current[token];
  }
  return isRecord(current) ? current : null;
}

function untypedForKimi(schema: Json): boolean {
  if (schema.type !== undefined || schema.anyOf !== undefined) {
    return false;
  }
  const keys = Object.keys(schema);
  if (keys.length === 0) {
    return false;
  }
  const notes = new Set(["$ref", "description", "title", "default", "examples", "$comment"]);
  const onlyNotes = keys.every((key) => notes.has(key));
  return !(onlyNotes && schema.$ref !== undefined);
}

/** Types every local $ref target Kimi would refuse untyped. */
function addKimiRefTypes(schema: Json): Json {
  const clone = structuredClone(schema);
  const seen = new Set<Json>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    if (typeof node.$ref === "string") {
      const target = resolveRefChain(clone, node.$ref);
      if (target !== null && untypedForKimi(target)) {
        target.type = kimiRefType(target);
      }
    }
    for (const key of [...SCHEMA_MAPS, ...SCHEMA_ONE, ...SCHEMA_LIST]) {
      const value = node[key];
      if (value === undefined) {
        continue;
      }
      if (SCHEMA_MAPS.has(key) && isRecord(value)) {
        Object.values(value).forEach(visit);
      } else if (SCHEMA_ONE.has(key)) {
        visit(value);
      } else if (SCHEMA_LIST.has(key) && Array.isArray(value)) {
        value.forEach(visit);
      }
    }
  };
  visit(clone);
  return clone;
}

const KIMI_HOSTS = new Set(["api.moonshot.ai", "api.moonshot.cn", "api.kimi.com", "api.kimi.ai"]);

export interface ToolShapeInput {
  protocol: string;
  provider: { baseUrl: string };
  body: Json;
}

/**
 * The body's tools in the shape the target API takes: Chat tools with their
 * function object, object-rooted schemas where the vendor refuses unions,
 * anyOf where its grammar refuses oneOf, Rust-readable patterns for Grok,
 * and Responses Lite lifted out.
 */
export function shapeTools(input: ToolShapeInput): Json {
  const host = hostOf(input.provider.baseUrl);
  let body = input.body;
  if (input.protocol === "openai-responses" && host !== "api.openai.com") {
    body = fromLite(body).body;
  }
  const tools = body.tools;
  if (!Array.isArray(tools)) {
    return body;
  }
  const model = typeof body.model === "string" ? body.model : "";
  let shaped: unknown = tools;
  if (geminiNamed(model)) {
    shaped = cleanTools(shaped as unknown[]);
  }
  if (input.protocol === "openai") {
    shaped = (shaped as unknown[]).map((tool) => (isRecord(tool) ? chatTool(tool) : tool));
  }
  if (
    input.protocol === "openai" ||
    input.protocol === "openai-responses" ||
    input.protocol === "anthropic" ||
    host === "api.x.ai"
  ) {
    shaped = forEachSchema(input.protocol, shaped, (schema) => foldRoot(schema));
  }
  if (host === "openrouter.ai") {
    shaped = forEachSchema(input.protocol, shaped, (schema) => renameOneOf(schema, true) as Json);
  }
  if (host === "api.x.ai") {
    shaped = forEachSchema(
      input.protocol,
      shaped,
      (schema) => fixPatterns(schema, true, ecmaClassForRust) as Json,
    );
  }
  if (host === "api.deepseek.com") {
    shaped = forEachSchema(
      input.protocol,
      shaped,
      (schema) =>
        fixPatterns(schema, true, (pattern) => pattern.replaceAll("\\0", "\\u0000")) as Json,
    );
  }
  if (KIMI_HOSTS.has(host)) {
    shaped = forEachSchema(input.protocol, shaped, (schema) =>
      addKimiRefTypes(addEnumTypes(schema) as Json),
    );
  }
  const typed = geminiToolTypes({ ...body, tools: shaped }, model);
  return { ...body, tools: typed.tools };
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
