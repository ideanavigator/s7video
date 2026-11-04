// SPDX-FileCopyrightText: 2026 s7video contributors
// SPDX-License-Identifier: MIT
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a small synchronous CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const HELP = `Usage: node scripts/check-doc-links.ts [file.md ...]

Checks every relative link in the repository's tracked Markdown files (or only the
files given): the target file or folder must exist, and a #fragment pointing into a
Markdown file must match one of its headings or <a id> anchors. Full URLs (http,
https, mailto) are not fetched.`;

export interface DocLink {
  readonly line: number;
  readonly target: string;
}

const INLINE_LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/;

/** Links outside fenced code blocks and inline code spans. */
export function extractLinks(markdown: string): DocLink[] {
  const links: DocLink[] = [];
  let fence: string | null = null;
  markdown.split("\n").forEach((rawLine, index) => {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(rawLine);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const line = rawLine.replace(/`[^`]*`/g, "");
    const definition = REFERENCE_DEFINITION.exec(line);
    if (definition) {
      links.push({ line: index + 1, target: definition[1]! });
      return;
    }
    for (const match of line.matchAll(INLINE_LINK)) {
      links.push({ line: index + 1, target: match[1]! });
    }
  });
  return links;
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to hyphens. */
export function headingSlug(heading: string): string {
  return (
    heading
      .trim()
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      // GitHub keeps underscores in anchors, so `Foo_bar` becomes `foo_bar`.
      .replace(/[`*~]/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-")
  );
}

export function anchorsOf(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    for (const match of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(match[1]!);
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const slug = headingSlug(heading[1]!);
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count === 0 ? slug : `${slug}-${count}`);
  }
  return anchors;
}

function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

/** Problems with one file's links, as "line: message" strings. */
export function checkFile(root: string, file: string): string[] {
  const absolute = NodePath.join(root, file);
  const problems: string[] = [];
  for (const { line, target } of extractLinks(NodeFS.readFileSync(absolute, "utf8"))) {
    if (isExternal(target)) continue;
    const [rawPath = "", fragment] = target.split("#", 2);
    let pathPart: string;
    try {
      pathPart = decodeURIComponent(rawPath);
    } catch {
      problems.push(`${line}: ${target} (malformed URL encoding)`);
      continue;
    }
    const resolved =
      pathPart === ""
        ? absolute
        : pathPart.startsWith("/")
          ? NodePath.join(root, pathPart)
          : NodePath.resolve(NodePath.dirname(absolute), pathPart);
    if (!NodeFS.existsSync(resolved)) {
      problems.push(`${line}: ${target} (no such file)`);
      continue;
    }
    if (fragment && resolved.endsWith(".md") && NodeFS.statSync(resolved).isFile()) {
      if (!anchorsOf(NodeFS.readFileSync(resolved, "utf8")).has(fragment)) {
        problems.push(`${line}: ${target} (no heading or anchor "#${fragment}")`);
      }
    }
  }
  return problems;
}

function trackedMarkdown(root: string): string[] {
  const output = NodeChildProcess.execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
    cwd: root,
    encoding: "utf8",
  });
  return output
    .split("\0")
    .filter((file) => file !== "" && NodeFS.existsSync(NodePath.join(root, file)));
}

function main(args: readonly string[]): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return 0;
  }
  const root = NodePath.resolve(import.meta.dirname, "..");
  const files =
    args.length > 0
      ? args.map((file) => NodePath.relative(root, NodePath.resolve(file)))
      : trackedMarkdown(root);
  let broken = 0;
  for (const file of files) {
    for (const problem of checkFile(root, file)) {
      console.error(`${file}:${problem}`);
      broken += 1;
    }
  }
  if (broken > 0) {
    console.error(`\n${broken} broken link(s) in ${files.length} Markdown file(s).`);
    return 1;
  }
  console.log(`All relative links resolve in ${files.length} Markdown file(s).`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
