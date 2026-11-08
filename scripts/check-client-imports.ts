// Fails the build when a server component imports a function from a "use client"
// module. Next.js replaces such a function with a stub on the server, so calling
// it passes typecheck and `next build` and only throws when the page renders.
// Components (capitalized imports) are fine: the server renders them, never calls them.
//   npm run check:client-imports       # also run by `npm run build`
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SRC = path.resolve("src");

const sources = new Map<string, ts.SourceFile>();
for (const entry of fs.readdirSync(SRC, { recursive: true, encoding: "utf8" })) {
  if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
  const file = path.join(SRC, entry);
  sources.set(file, ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false));
}

/** Directives are the string literals at the very top of a file. */
function isClientModule(source: ts.SourceFile): boolean {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === "use client") return true;
  }
  return false;
}

/** The source file an import points at, or null for a package. */
function resolve(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? path.join(SRC, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(from), specifier)
      : null;
  if (!base) return null;
  const match = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"].map((ext) => base + ext).find((f) => sources.has(f));
  return match ?? null;
}

/** The value imports (not types) named like functions rather than components. */
function functionImports(clause: ts.ImportClause): string[] {
  if (clause.isTypeOnly) return [];
  const names = clause.name ? [clause.name.text] : [];
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
    }
  }
  return names.filter((name) => /^[a-z]/.test(name));
}

const problems: string[] = [];
for (const [file, source] of sources) {
  if (isClientModule(source)) continue;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
    const target = resolve(file, specifier);
    if (!target || !isClientModule(sources.get(target)!)) continue;
    for (const name of functionImports(statement.importClause)) {
      problems.push(`  ${path.relative(process.cwd(), file)}: ${name} from ${specifier}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Server code imports functions from "use client" modules (they throw when called on the server):`);
  console.error(problems.join("\n"));
  console.error(`Move them to a module without "use client", or make the importing file a client component.`);
  process.exit(1);
}
console.log(`Client imports OK (${sources.size} files).`);
