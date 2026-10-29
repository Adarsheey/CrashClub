import { access, readFile, writeFile } from 'node:fs/promises';

const generatedClient = new URL('../src/generated/prisma/internal/class.ts', import.meta.url);
const runtimeDirectory = new URL('../../node_modules/@prisma/client/runtime/', import.meta.url);

const runtimeImports = [
  'query_compiler_fast_bg.postgresql.mjs',
  'query_compiler_fast_bg.postgresql.wasm-base64.mjs',
];

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

let source = await readFile(generatedClient, 'utf8');
let replacements = 0;

for (const esmFile of runtimeImports) {
  const commonJsFile = esmFile.replace(/\.mjs$/, '.js');
  const esmPath = new URL(esmFile, runtimeDirectory);
  const commonJsPath = new URL(commonJsFile, runtimeDirectory);
  const esmSpecifier = `@prisma/client/runtime/${esmFile}`;
  const commonJsSpecifier = `@prisma/client/runtime/${commonJsFile}`;

  if (await exists(esmPath) || !source.includes(esmSpecifier)) continue;
  if (!(await exists(commonJsPath))) {
    throw new Error(`Prisma runtime module is missing: ${commonJsFile}`);
  }

  source = source.replaceAll(esmSpecifier, commonJsSpecifier);
  replacements += 1;
}

if (replacements > 0) {
  await writeFile(generatedClient, source, 'utf8');
  console.log(`Applied ${replacements} local Prisma runtime compatibility import(s).`);
} else {
  console.log('Prisma runtime imports are already available; no compatibility patch needed.');
}

