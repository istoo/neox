import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envelopeSource = resolve(packageRoot, "src/validation/ws-outbound-envelope.ts");
const source = resolve(packageRoot, "codegen/generated/ws-outbound.compile.ts");
const runtimeSchemaMetadata = resolve(
  packageRoot,
  "src/generated/validation/ws-outbound-schema-metadata.ts",
);
const output = resolve(packageRoot, "src/generated/validation/ws-outbound.aot.ts");

/**
 * Write in one step: a test or the daemon may import these files while the
 * generator runs, and a half-written generated file surfaces as a schema
 * being undefined at module load (the `_zod` crash).
 */
async function writeAtomic(filePath, contents) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents);
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

const require = createRequire(import.meta.url);
const zodAotEntry = require.resolve("zod-aot");
const zodAotRoot = resolve(dirname(zodAotEntry), "..");
const emitterPath = resolve(zodAotRoot, "dist/cli/emitter.js");
const discriminatedUnionPath = resolve(
  zodAotRoot,
  "dist/core/codegen/schemas/discriminated-union.js",
);

async function ensureZodAotRuntimeImportExtensionPatch() {
  const emitter = await readFile(emitterPath, "utf8");
  if (emitter.includes('sourceRelPath.endsWith(".js")')) {
    return;
  }

  const before = 'let importPath = sourceRelPath.replace(/\\.[cm]?[jt]sx?$/, "");';
  const after =
    'let importPath = sourceRelPath.endsWith(".js")\n        ? sourceRelPath\n        : sourceRelPath.replace(/\\.[cm]?[jt]sx?$/, "");';
  if (!emitter.includes(before)) {
    throw new Error("zod-aot emitter shape changed; update the runtime import extension patch");
  }
  await writeFile(emitterPath, emitter.replace(before, after));
}

async function ensureZodAotDiscriminatedUnionOutputPatch() {
  let discriminatedUnionEmitter = await readFile(discriminatedUnionPath, "utf8");
  if (
    discriminatedUnionEmitter.includes(
      "const needsOutputPropagation = ir.options.some(hasMutation);",
    )
  ) {
    return;
  }

  const importBefore = 'import { escapeString } from "../context.js";';
  const importAfter = 'import { escapeString, hasMutation } from "../context.js";';
  const outputFlagBefore = "const discKey = escapeString(ir.discriminator);\n    let code = emit `";
  const outputFlagAfter =
    "const discKey = escapeString(ir.discriminator);\n    const needsOutputPropagation = ir.options.some(hasMutation);\n    let code = emit `";
  const propagationBefore =
    "        ${g.visit(option, { input: objVar, output: objVar })}\n        break;`;";
  const propagationAfter =
    '        ${g.visit(option, { input: objVar, output: objVar })}\n        ${needsOutputPropagation ? `${g.output}=${objVar};` : ""}\n        break;`;';

  if (
    !discriminatedUnionEmitter.includes(importBefore) ||
    !discriminatedUnionEmitter.includes(outputFlagBefore) ||
    !discriminatedUnionEmitter.includes(propagationBefore)
  ) {
    throw new Error("zod-aot discriminated-union emitter shape changed; update the output patch");
  }

  discriminatedUnionEmitter = discriminatedUnionEmitter
    .replace(importBefore, importAfter)
    .replace(outputFlagBefore, outputFlagAfter)
    .replace(propagationBefore, propagationAfter);
  await writeFile(discriminatedUnionPath, discriminatedUnionEmitter);
}

await Promise.all([
  ensureZodAotRuntimeImportExtensionPatch(),
  ensureZodAotDiscriminatedUnionOutputPatch(),
]);

const [
  { loadSourceFile },
  { discoverSchemas },
  { compileSchemas },
  { generateCompiledFileContent },
] = await Promise.all([
  import(pathToFileURL(resolve(zodAotRoot, "dist/loader.js")).href),
  import(pathToFileURL(resolve(zodAotRoot, "dist/discovery.js")).href),
  import(pathToFileURL(resolve(zodAotRoot, "dist/core/pipeline.js")).href),
  import(pathToFileURL(resolve(zodAotRoot, "dist/cli/emitter.js")).href),
]);

// One compiled validator per session message plus a tag-only envelope. zod-aot emits one function
// per compiled schema, so this keeps every generated function small enough for V8 to optimize cheaply.
const { sessionOutboundMessageOptions } = await loadSourceFile(envelopeSource, { cacheBust: true });
const sessionTags = sessionOutboundMessageOptions.map((option) => option.shape.type.value);
function sessionExport(index) {
  return `SessionOutboundMessage${index}`;
}
const envelopeImport = relative(dirname(source), envelopeSource)
  .replace(/\.ts$/, ".js")
  .split(sep)
  .join("/");
const metadataImport = relative(dirname(runtimeSchemaMetadata), envelopeSource)
  .replace(/\.ts$/, ".js")
  .split(sep)
  .join("/");

await mkdir(dirname(source), { recursive: true });
await writeAtomic(
  source,
  [
    "// AUTO-GENERATED by generate-validation-aot.mjs — DO NOT EDIT",
    'import { compile } from "zod-aot";',
    `import { WSOutboundEnvelopeSchema, sessionOutboundMessageOptions } from "${envelopeImport}";`,
    "export const WSOutboundEnvelope = compile(WSOutboundEnvelopeSchema);",
    ...sessionTags.map(
      (_, index) =>
        `export const ${sessionExport(index)} = compile(sessionOutboundMessageOptions[${index}]);`,
    ),
    "",
  ].join("\n"),
);
await mkdir(dirname(runtimeSchemaMetadata), { recursive: true });
await writeAtomic(
  runtimeSchemaMetadata,
  [
    "// AUTO-GENERATED by generate-validation-aot.mjs — DO NOT EDIT",
    `import { WSOutboundEnvelopeSchema, sessionOutboundMessageOptions } from "${metadataImport}";`,
    "export const WSOutboundEnvelope = { schema: WSOutboundEnvelopeSchema };",
    ...sessionTags.map(
      (_, index) =>
        `export const ${sessionExport(index)} = { schema: sessionOutboundMessageOptions[${index}] };`,
    ),
    "",
  ].join("\n"),
);

const schemas = await discoverSchemas(source, { cacheBust: true });
if (schemas.length !== sessionTags.length + 1) {
  throw new Error(
    `Expected ${sessionTags.length + 1} zod-aot compile() exports in ${relative(packageRoot, source)}, found ${schemas.length}`,
  );
}

const compiled = compileSchemas(schemas, { mode: "inline" });
const runtimeImportPath = relative(dirname(output), runtimeSchemaMetadata)
  .replace(/\.[cm]?[jt]sx?$/, ".js")
  .split(sep)
  .join("/");

// The generated validators are one large module today; Metro's jest workers parse it whole,
// and a single 17 MB file exhausted the worker heap on the 7 GB CI runners. Emit bounded
// parts and keep this module as a re-exporting index so every existing import still works.
const PART_SIZE = 24;
const parts = [];
for (let start = 0; start < compiled.length; start += PART_SIZE) {
  parts.push(compiled.slice(start, start + PART_SIZE));
}

const outputDir = dirname(output);
await mkdir(outputDir, { recursive: true });
for (const entry of await readdir(outputDir).catch(() => [])) {
  if (/^ws-outbound\.aot\.part-\d+\.ts$/u.test(entry)) {
    await rm(resolve(outputDir, entry), { force: true });
  }
}

for (const [index, part] of parts.entries()) {
  const partContent = generateCompiledFileContent(part, runtimeImportPath, {
    zodCompat: false,
  }).replace(
    "// AUTO-GENERATED by zod-aot — DO NOT EDIT",
    "// @ts-nocheck\n// AUTO-GENERATED by zod-aot — DO NOT EDIT",
  );
  await writeAtomic(resolve(outputDir, `ws-outbound.aot.part-${index}.ts`), partContent);
}

const partExports = parts.map((part) => part.map((item) => item.exportName));
const sessionMessageValidators = [
  "export const SessionOutboundMessageValidators = {",
  ...sessionTags.map((tag, index) => `  ${JSON.stringify(tag)}: ${sessionExport(index)},`),
  "};",
  "",
].join("\n");
const indexContent = [
  "// @ts-nocheck",
  "// AUTO-GENERATED by generate-validation-aot.mjs — DO NOT EDIT",
  ...partExports.flatMap((names, index) => [
    `import { ${names.join(", ")} } from "./ws-outbound.aot.part-${index}.js";`,
  ]),
  ...partExports.flatMap((names) => [`export { ${names.join(", ")} };`]),
  "",
  sessionMessageValidators,
].join("\n");

await writeAtomic(output, indexContent);

console.info(
  `generated ${relative(packageRoot, output)}: envelope + ${sessionTags.length} session message validators in ${parts.length} parts`,
);
