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
  /** The raw `license` field of the package's package.json, when it has one. */
  readonly manifestLicense?: string | undefined;
}

export interface DevOnlyAllowance {
  readonly license: string;
  /** The packages the allowance covers; any other package under this licence still fails. */
  readonly packages: ReadonlyArray<string>;
  readonly reason: string;
}

export interface LicenceAllowlist {
  /** Allowed SPDX ids, most permissive first; a dual licence elects the earliest allowed option. */
  readonly allowed: ReadonlyArray<string>;
  /** Extra ids accepted only for packages that never ship (build and test tooling). */
  readonly devOnly: ReadonlyArray<DevOnlyAllowance>;
  /** Reviewed dual-licence choices by package name. */
  readonly elections: Readonly<Record<string, string>>;
  /** Non-SPDX spellings seen in package metadata, mapped to SPDX ids. */
  readonly aliases: Readonly<Record<string, string>>;
}

export interface LicenceException {
  readonly name: string;
  /** An exact version or a range such as `>=0.3.276 <0.4.0`; a new release needs a fresh review. */
  readonly version?: string | undefined;
  /** The package.json `license` value the review saw; a different value fails the check. */
  readonly declared?: string | undefined;
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

function preferredExpression(evaluation: Evaluation): Expression {
  return parseLicenceExpression(evaluation.elected) ?? { kind: "id", id: evaluation.elected };
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
  packageName?: string,
): LicenceVerdict {
  const parsed = parseLicenceExpression(declared);
  if (!parsed || /^(unknown|unlicensed|proprietary|none)$/i.test(declared.trim())) {
    return { ok: false, reason: "has no SPDX licence" };
  }
  const devOnly =
    scope === "development" && packageName !== undefined
      ? allowlist.devOnly
          .filter((entry) => entry.packages.includes(packageName))
          .map((entry) => entry.license)
      : [];
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
    if (rankOf(elected) === undefined) {
      return { ok: false, reason: `elected ${election}, which is not on the allowlist` };
    }
    // Rank the election first and evaluate normally, so AND terms must all still be allowed.
    const preferred = evaluate(expression, (id) => (id === elected ? -1 : rankOf(id)));
    if (!preferred) {
      return { ok: false, reason: `${render(expression)} is not on the allowlist` };
    }
    if (
      !/\sOR\s/i.test(render(expression)) ||
      !optionIds(preferredExpression(preferred)).includes(elected)
    ) {
      return { ok: false, reason: `elected ${election}, which is not one of its OR options` };
    }
    return { ok: true, elected: preferred.elected };
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

function comparable(expression: string): string {
  return expression.replace(/[()\s]/g, "").toLowerCase();
}

function isUndeclared(license: string | undefined): boolean {
  return (
    license === undefined ||
    /^(unknown|none)$/i.test(license.trim()) ||
    parseLicenceExpression(license) === null
  );
}

/** An override agrees when it restates the declared licence or picks one option of its OR. */
function overrideAgrees(declared: string, override: string): boolean {
  if (comparable(declared) === comparable(override)) return true;
  const parsed = parseLicenceExpression(declared);
  return (
    parsed !== null &&
    /\sOR\s/i.test(declared) &&
    parseLicenceExpression(override)?.kind === "id" &&
    optionIds(parsed).some((id) => comparable(id) === comparable(override))
  );
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function compareVersions(left: string, right: string): number {
  const a = SEMVER.exec(left);
  const b = SEMVER.exec(right);
  if (!a || !b) return left.localeCompare(right);
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference;
  }
  const preA = left.includes("-");
  const preB = right.includes("-");
  return preA === preB ? left.localeCompare(right) : preA ? -1 : 1;
}

/** An exact version, or space-separated comparators (`>=1.2.0 <2.0.0`). */
function versionSatisfies(version: string, range: string): boolean {
  const comparators = range.trim().split(/\s+/);
  return comparators.every((comparator) => {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(comparator);
    if (!match) return false;
    const [, operator = "=", bound = ""] = match;
    const order = compareVersions(version, bound);
    if (operator === ">=") return order >= 0;
    if (operator === "<=") return order <= 0;
    if (operator === ">") return order > 0;
    if (operator === "<") return order < 0;
    return version === bound;
  });
}

/** True when a `patchedDependencies` key (`name`, `name@version` or `name@range`) covers the copy. */
export function isPatched(patched: ReadonlySet<string>, name: string, version: string): boolean {
  for (const key of patched) {
    const at = key.lastIndexOf("@");
    const keyName = at > 0 ? key.slice(0, at) : key;
    const keyVersion = at > 0 ? key.slice(at + 1) : undefined;
    if (keyName !== name) continue;
    if (keyVersion === undefined || keyVersion === version || !SEMVER.test(keyVersion)) return true;
  }
  return false;
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
  /** Keys of pnpm `patchedDependencies`: `name`, `name@version` or `name@range`. */
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
        (candidate.version === undefined || versionSatisfies(scanned.version, candidate.version)),
    );
    const problem = (license: string, message: string) =>
      problems.push({
        name: scanned.name,
        version: scanned.version,
        license,
        path: scanned.path,
        scope: scanned.scope,
        message,
      });
    if (!exception && validExceptions.some((candidate) => candidate.name === scanned.name)) {
      problem(scanned.license, "is outside the version range its exception was reviewed for");
      usedExceptions.add(validExceptions.find((candidate) => candidate.name === scanned.name)!);
      continue;
    }
    if (exception) {
      usedExceptions.add(exception);
      const installed = scanned.manifestLicense ?? scanned.license;
      if (exception.declared !== undefined && exception.declared !== installed) {
        problem(
          installed,
          `declares "${installed}", but its exception (${exception.adr}) was reviewed for "${exception.declared}"`,
        );
        continue;
      }
      accepted.push({
        name: scanned.name,
        version: scanned.version,
        adr: exception.adr!,
        path: scanned.path,
      });
      continue;
    }
    const override = findOverride(input.overrides, scanned);
    const own = scanned.manifestLicense ?? scanned.license;
    if (override && !isUndeclared(own) && !overrideAgrees(own, override.license)) {
      problem(
        own,
        `has an override saying "${override.license}" but declares "${own}"; review it and pin the override's version`,
      );
      continue;
    }
    const declared = override?.license ?? scanned.license;
    const verdict = judgeLicence(
      declared,
      scanned.scope,
      input.allowlist,
      input.allowlist.elections[scanned.name],
      scanned.name,
    );
    if (!verdict.ok) {
      problem(declared, verdict.reason ?? "is not on the allowlist");
      continue;
    }
    const elected = verdict.elected ?? declared;
    if (
      /\bMPL-2\.0\b/.test(elected) &&
      input.patched !== undefined &&
      isPatched(input.patched, scanned.name, scanned.version)
    ) {
      problem(declared, "is MPL-2.0 and patched; MPL code may only be used unmodified");
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
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = entry.versions.find((version) =>
    new RegExp(`/${escape(storeName)}@${escape(version)}(?:[/_]|$)`).test(path),
  );
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
