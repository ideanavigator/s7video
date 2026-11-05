// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// The rules behind `pnpm licenses:check`: SPDX expressions against the allowlist, dual-licence
// elections, reviewed exceptions and package overrides. Pure functions; scripts/licenses-check.ts
// gathers the input from `pnpm licenses list`.

export type DependencyScope = "production" | "development";

export interface ScannedPackage {
  readonly name: string;
  readonly version: string;
  /** What the package declares, as `pnpm licenses list` reports it ("Unknown" when absent). */
  readonly license: string;
  /** Install path, relative to the repository root. */
  readonly path: string;
  readonly scope: DependencyScope;
  readonly repositoryUrl?: string | undefined;
}

export interface LicenceAllowlist {
  /** Allowed SPDX ids, most permissive first; a dual licence elects the earliest allowed option. */
  readonly allowed: ReadonlyArray<string>;
  /** Extra ids accepted only for packages that never ship (build and test tooling). */
  readonly devOnly: ReadonlyArray<{ readonly license: string; readonly reason: string }>;
  /** Reviewed dual-licence choices by package name. */
  readonly elections: Readonly<Record<string, string>>;
  /** Non-SPDX spellings seen in package metadata, mapped to SPDX ids. */
  readonly aliases: Readonly<Record<string, string>>;
}

export interface LicenceException {
  readonly name: string;
  readonly version?: string | undefined;
  readonly license?: string | undefined;
  readonly adr?: string | undefined;
  readonly reason?: string | undefined;
}

/** The `license` a `packageOverrides` entry of third-party-licenses.config.json supplies. */
export interface LicenceOverride {
  readonly name?: string | undefined;
  readonly version?: string | undefined;
  readonly repositoryUrl?: string | undefined;
  readonly license: string;
}

export interface LicenceProblem {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly path: string;
  readonly scope: DependencyScope;
  readonly message: string;
}

export interface LicenceElection {
  readonly name: string;
  readonly version: string;
  readonly declared: string;
  readonly elected: string;
}

export interface AcceptedException {
  readonly name: string;
  readonly version: string;
  readonly adr: string;
  readonly path: string;
}

export interface LicenceCheckResult {
  readonly checked: number;
  readonly problems: ReadonlyArray<LicenceProblem>;
  readonly elections: ReadonlyArray<LicenceElection>;
  readonly exceptions: ReadonlyArray<AcceptedException>;
  readonly configErrors: ReadonlyArray<string>;
}

type Expression =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "and" | "or"; readonly left: Expression; readonly right: Expression };

const ADR_PATTERN = /^ADR-\d{3}$/;

function tokenize(expression: string): ReadonlyArray<string> | null {
  const tokens = expression.match(/\(|\)|[^\s()]+/g);
  return tokens && tokens.length > 0 ? tokens : null;
}

/** Parses an SPDX licence expression (AND, OR, WITH, parentheses). Returns null when it is not one. */
export function parseLicenceExpression(expression: string): Expression | null {
  const tokens = tokenize(expression.trim());
  if (!tokens) return null;
  let position = 0;
  const peek = () => tokens[position];
  const isOperator = (token: string | undefined, operator: string) =>
    token !== undefined && token.toUpperCase() === operator;

  const parseAtom = (): Expression | null => {
    const token = peek();
    if (token === undefined || token === ")") return null;
    if (token === "(") {
      position += 1;
      const inner = parseOr();
      if (!inner || peek() !== ")") return null;
      position += 1;
      return inner;
    }
    if (["AND", "OR", "WITH"].some((operator) => isOperator(token, operator))) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9.+/:-]*$/.test(token)) return null;
    position += 1;
    if (isOperator(peek(), "WITH")) {
      position += 1;
      const exception = peek();
      if (exception === undefined || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(exception)) return null;
      position += 1;
      return { kind: "id", id: `${token} WITH ${exception}` };
    }
    return { kind: "id", id: token };
  };
  const parseBinary = (
    operator: "AND" | "OR",
    parseOperand: () => Expression | null,
  ): Expression | null => {
    let left = parseOperand();
    while (left && isOperator(peek(), operator)) {
      position += 1;
      const right = parseOperand();
      if (!right) return null;
      left = { kind: operator === "AND" ? "and" : "or", left, right };
    }
    return left;
  };
  const parseAnd = () => parseBinary("AND", parseAtom);
  const parseOr = (): Expression | null => parseBinary("OR", parseAnd);

  const parsed = parseOr();
  return parsed && position === tokens.length ? parsed : null;
}

function canonicalId(id: string, allowlist: LicenceAllowlist, known: ReadonlyArray<string>) {
  const alias = Object.entries(allowlist.aliases).find(
    ([spelling]) => spelling.toLowerCase() === id.toLowerCase(),
  );
  const resolved = alias ? alias[1] : id;
  return known.find((candidate) => candidate.toLowerCase() === resolved.toLowerCase()) ?? resolved;
}

function render(expression: Expression): string {
  if (expression.kind === "id") return expression.id;
  const side = (child: Expression) =>
    child.kind !== "id" && child.kind !== expression.kind ? `(${render(child)})` : render(child);
  return `${side(expression.left)} ${expression.kind.toUpperCase()} ${side(expression.right)}`;
}

/** The ids every alternative under `expression` mentions, for checking an explicit election. */
function optionIds(expression: Expression): ReadonlyArray<string> {
  return expression.kind === "id"
    ? [expression.id]
    : [...optionIds(expression.left), ...optionIds(expression.right)];
}

interface Evaluation {
  readonly elected: string;
  /** Worst position in the allowlist among the licences the elected option needs. */
  readonly rank: number;
}

function evaluate(
  expression: Expression,
  rankOf: (id: string) => number | undefined,
): Evaluation | null {
  if (expression.kind === "id") {
    const rank = rankOf(expression.id);
    return rank === undefined ? null : { elected: expression.id, rank };
  }
  const left = evaluate(expression.left, rankOf);
  const right = evaluate(expression.right, rankOf);
  if (expression.kind === "and") {
    if (!left || !right) return null;
    return {
      elected: `${left.elected} AND ${right.elected}`,
      rank: Math.max(left.rank, right.rank),
    };
  }
  if (!left) return right;
  if (!right) return left;
  return right.rank < left.rank ? right : left;
}

export interface LicenceVerdict {
  readonly ok: boolean;
  /** The option taken: the whole expression for a single licence, one branch for a dual licence. */
  readonly elected?: string;
  readonly reason?: string;
}

/** Decides one declared licence against the allowlist, electing the permissive option of a choice. */
export function judgeLicence(
  declared: string,
  scope: DependencyScope,
  allowlist: LicenceAllowlist,
  election?: string,
): LicenceVerdict {
  const parsed = parseLicenceExpression(declared);
  if (!parsed || /^(unknown|unlicensed|proprietary|none)$/i.test(declared.trim())) {
    return { ok: false, reason: "has no SPDX licence" };
  }
  const devOnly = scope === "development" ? allowlist.devOnly.map((entry) => entry.license) : [];
  const ranked = [...allowlist.allowed, ...devOnly];
  const canonicalise = (expression: Expression): Expression =>
    expression.kind === "id"
      ? { kind: "id", id: canonicalId(expression.id, allowlist, ranked) }
      : {
          kind: expression.kind,
          left: canonicalise(expression.left),
          right: canonicalise(expression.right),
        };
  const expression = canonicalise(parsed);
  const rankOf = (id: string) => {
    const index = ranked.indexOf(id);
    return index === -1 ? undefined : index;
  };

  if (election !== undefined) {
    const elected = canonicalId(election, allowlist, ranked);
    if (!optionIds(expression).includes(elected)) {
      return { ok: false, reason: `elected ${election}, which is not one of its options` };
    }
    if (rankOf(elected) === undefined) {
      return { ok: false, reason: `elected ${election}, which is not on the allowlist` };
    }
    return { ok: true, elected };
  }
  const verdict = evaluate(expression, rankOf);
  return verdict
    ? { ok: true, elected: verdict.elected }
    : { ok: false, reason: `${render(expression)} is not on the allowlist` };
}

function normaliseRepository(url: string | undefined): string | undefined {
  return url
    ?.trim()
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^(?:git|ssh):\/\/(?:git@)?github\.com\//, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/#.*$/, "")
    .toLowerCase();
}

function findOverride(
  overrides: ReadonlyArray<LicenceOverride>,
  scanned: ScannedPackage,
): LicenceOverride | undefined {
  const repository = normaliseRepository(scanned.repositoryUrl);
  const versionMatches = (override: LicenceOverride) =>
    override.version === undefined || override.version === scanned.version;
  return (
    overrides.find((override) => override.name === scanned.name && versionMatches(override)) ??
    overrides.find(
      (override) =>
        override.name === undefined &&
        repository !== undefined &&
        normaliseRepository(override.repositoryUrl) === repository &&
        versionMatches(override),
    )
  );
}

export function validateExceptions(exceptions: ReadonlyArray<LicenceException>): string[] {
  return exceptions.flatMap((exception, index) => {
    const label = `licenses.exceptions.json entry ${String(index + 1)} (${exception.name || "unnamed"})`;
    const errors: string[] = [];
    if (!exception.name) errors.push(`${label} has no package name`);
    if (!exception.adr || !ADR_PATTERN.test(exception.adr)) {
      errors.push(`${label} must name the ADR that accepted it, as "ADR-NNN"`);
    }
    if (!exception.reason || exception.reason.trim().length === 0) {
      errors.push(`${label} has no reason`);
    }
    return errors;
  });
}

export function checkLicences(input: {
  readonly packages: ReadonlyArray<ScannedPackage>;
  readonly allowlist: LicenceAllowlist;
  readonly exceptions: ReadonlyArray<LicenceException>;
  readonly overrides: ReadonlyArray<LicenceOverride>;
  /** `name@version` of packages changed through pnpm patchedDependencies. */
  readonly patched?: ReadonlySet<string>;
}): LicenceCheckResult {
  const configErrors = validateExceptions(input.exceptions);
  const validExceptions = input.exceptions.filter(
    (exception) => exception.name && exception.adr && ADR_PATTERN.test(exception.adr),
  );
  const usedExceptions = new Set<LicenceException>();
  const problems: LicenceProblem[] = [];
  const elections: LicenceElection[] = [];
  const accepted: AcceptedException[] = [];

  for (const scanned of input.packages) {
    const exception = validExceptions.find(
      (candidate) =>
        candidate.name === scanned.name &&
        (candidate.version === undefined || candidate.version === scanned.version),
    );
    if (exception) {
      usedExceptions.add(exception);
      accepted.push({
        name: scanned.name,
        version: scanned.version,
        adr: exception.adr!,
        path: scanned.path,
      });
      continue;
    }
    const override = findOverride(input.overrides, scanned);
    const declared = override?.license ?? scanned.license;
    const verdict = judgeLicence(
      declared,
      scanned.scope,
      input.allowlist,
      input.allowlist.elections[scanned.name],
    );
    const problem = (message: string) =>
      problems.push({
        name: scanned.name,
        version: scanned.version,
        license: declared,
        path: scanned.path,
        scope: scanned.scope,
        message,
      });
    if (!verdict.ok) {
      problem(verdict.reason ?? "is not on the allowlist");
      continue;
    }
    const elected = verdict.elected ?? declared;
    if (/\bMPL-2\.0\b/.test(elected) && input.patched?.has(`${scanned.name}@${scanned.version}`)) {
      problem("is MPL-2.0 and patched; MPL code may only be used unmodified");
      continue;
    }
    if (/\sOR\s/i.test(declared)) {
      elections.push({ name: scanned.name, version: scanned.version, declared, elected });
    }
  }

  for (const exception of validExceptions) {
    if (!usedExceptions.has(exception)) {
      configErrors.push(
        `licenses.exceptions.json lists ${exception.name}${exception.version ? `@${exception.version}` : ""}, which is not installed; remove the entry`,
      );
    }
  }

  return {
    checked: input.packages.length,
    problems,
    elections,
    exceptions: accepted,
    configErrors,
  };
}

interface PnpmLicenceEntry {
  readonly name: string;
  readonly versions: ReadonlyArray<string>;
  readonly paths: ReadonlyArray<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePnpmEntries(value: unknown): Array<{ license: string; entry: PnpmLicenceEntry }> {
  if (!isRecord(value)) throw new Error("`pnpm licenses list --json` did not return an object.");
  return Object.entries(value).flatMap(([license, entries]) => {
    if (!Array.isArray(entries)) throw new Error(`pnpm licence group ${license} is not a list.`);
    return entries.map((entry: unknown) => {
      if (
        !isRecord(entry) ||
        typeof entry.name !== "string" ||
        !Array.isArray(entry.versions) ||
        !Array.isArray(entry.paths)
      ) {
        throw new Error(`pnpm licence group ${license} has an entry of an unknown shape.`);
      }
      return {
        license,
        entry: {
          name: entry.name,
          versions: entry.versions.map(String),
          paths: entry.paths.map(String),
        },
      };
    });
  });
}

function versionForPath(entry: PnpmLicenceEntry, path: string, index: number): string {
  const storeName = entry.name.replace("/", "+");
  const match = entry.versions.find((version) => path.includes(`/${storeName}@${version}`));
  return match ?? entry.versions[index] ?? entry.versions[0] ?? "unknown";
}

/**
 * Turns `pnpm licenses list --json -r` (the whole tree) and the same with `--prod` into one row
 * per installed copy, marking copies that only development tooling pulls in.
 */
export function packagesFromPnpm(input: {
  readonly all: unknown;
  readonly production: unknown;
  readonly root: string;
}): ScannedPackage[] {
  const productionPaths = new Set(
    decodePnpmEntries(input.production).flatMap(({ entry }) => entry.paths),
  );
  const rootPrefix = input.root.endsWith("/") ? input.root : `${input.root}/`;
  const seen = new Set<string>();
  const packages: ScannedPackage[] = [];
  for (const { license, entry } of decodePnpmEntries(input.all)) {
    entry.paths.forEach((path, index) => {
      if (seen.has(path)) return;
      seen.add(path);
      packages.push({
        name: entry.name,
        version: versionForPath(entry, path, index),
        license,
        path: path.startsWith(rootPrefix) ? path.slice(rootPrefix.length) : path,
        scope: productionPaths.has(path) ? "production" : "development",
      });
    });
  }
  return packages.sort(
    (left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path),
  );
}
