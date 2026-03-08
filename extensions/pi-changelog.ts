/**
 * pi-changelog — auto-generate changelogs from git history.
 * /changelog               → generate from last tag to HEAD
 * /changelog v1.0.0..HEAD  → specific range
 * /changelog --write       → write CHANGELOG.md
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const RST = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

interface Commit { hash: string; date: string; author: string; subject: string; type: string; scope: string; message: string; breaking: boolean }

function parseCommits(range: string): Commit[] {
  try {
    const log = execSync(`git log ${range} --pretty=format:"%H|%ai|%an|%s" --no-merges`, { encoding: "utf-8", timeout: 10000 }).trim();
    if (!log) return [];
    return log.split("\n").map(line => {
      const [hash, date, author, subject] = line.split("|");
      const convMatch = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)/);
      const type = convMatch?.[1]?.toLowerCase() || "other";
      const scope = convMatch?.[2] || "";
      const breaking = !!convMatch?.[3];
      const message = convMatch?.[4] || subject;
      return { hash: hash.slice(0, 7), date: date.slice(0, 10), author, subject, type, scope, message, breaking };
    });
  } catch { return []; }
}

function getLastTag(): string {
  try { return execSync("git describe --tags --abbrev=0 2>/dev/null", { encoding: "utf-8" }).trim(); } catch { return ""; }
}

function getRepoUrl(): string {
  try {
    const url = execSync("git remote get-url origin", { encoding: "utf-8" }).trim();
    return url.replace(/\.git$/, "").replace(/^git@github.com:/, "https://github.com/");
  } catch { return ""; }
}

const TYPE_ORDER: Record<string, { label: string; emoji: string; color: string }> = {
  feat: { label: "Features", emoji: "✨", color: GREEN },
  fix: { label: "Bug Fixes", emoji: "🐛", color: RED },
  perf: { label: "Performance", emoji: "⚡", color: YELLOW },
  refactor: { label: "Refactoring", emoji: "♻️", color: CYAN },
  docs: { label: "Documentation", emoji: "📚", color: D },
  style: { label: "Style", emoji: "💄", color: D },
  test: { label: "Tests", emoji: "✅", color: D },
  build: { label: "Build", emoji: "📦", color: D },
  ci: { label: "CI", emoji: "🔧", color: D },
  chore: { label: "Chores", emoji: "🧹", color: D },
  other: { label: "Other", emoji: "📝", color: D },
};

function formatAnsi(commits: Commit[], range: string, repoUrl: string): string {
  const lines: string[] = [];
  lines.push(`${B}${CYAN}Changelog${RST} ${D}(${range})${RST}\n`);

  // Group by type
  const groups = new Map<string, Commit[]>();
  const breaking: Commit[] = [];
  for (const c of commits) {
    if (c.breaking) breaking.push(c);
    const key = TYPE_ORDER[c.type] ? c.type : "other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  // Breaking changes first
  if (breaking.length > 0) {
    lines.push(`${RED}${B}⚠️  BREAKING CHANGES${RST}`);
    for (const c of breaking) {
      lines.push(`  ${RED}•${RST} ${c.message} ${D}(${c.hash})${RST}`);
    }
    lines.push("");
  }

  // Each type group
  for (const [type, meta] of Object.entries(TYPE_ORDER)) {
    const group = groups.get(type);
    if (!group || group.length === 0) continue;
    lines.push(`${meta.color}${B}${meta.emoji} ${meta.label}${RST}`);
    for (const c of group) {
      const scope = c.scope ? `${D}(${c.scope})${RST} ` : "";
      lines.push(`  ${meta.color}•${RST} ${scope}${c.message} ${D}(${c.hash})${RST}`);
    }
    lines.push("");
  }

  lines.push(`${D}${commits.length} commits${RST}`);
  return lines.join("\n");
}

function formatMarkdown(commits: Commit[], range: string, repoUrl: string): string {
  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 10);
  lines.push(`## ${range} (${date})\n`);

  const groups = new Map<string, Commit[]>();
  const breaking: Commit[] = [];
  for (const c of commits) {
    if (c.breaking) breaking.push(c);
    const key = TYPE_ORDER[c.type] ? c.type : "other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  if (breaking.length > 0) {
    lines.push(`### ⚠️ BREAKING CHANGES\n`);
    for (const c of breaking) {
      const link = repoUrl ? `[${c.hash}](${repoUrl}/commit/${c.hash})` : c.hash;
      lines.push(`- ${c.message} (${link})`);
    }
    lines.push("");
  }

  for (const [type, meta] of Object.entries(TYPE_ORDER)) {
    const group = groups.get(type);
    if (!group || group.length === 0) continue;
    lines.push(`### ${meta.emoji} ${meta.label}\n`);
    for (const c of group) {
      const scope = c.scope ? `**${c.scope}:** ` : "";
      const link = repoUrl ? `[${c.hash}](${repoUrl}/commit/${c.hash})` : c.hash;
      lines.push(`- ${scope}${c.message} (${link})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export default function piChangelog(pi: ExtensionAPI) {
  pi.registerCommand("changes", {
    description: "Auto-generate changelog from git. /changes [range] [--write]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const doWrite = parts.includes("--write") || parts.includes("-w");
      const rangeArg = parts.find(p => !p.startsWith("-"));

      const lastTag = getLastTag();
      const range = rangeArg || (lastTag ? `${lastTag}..HEAD` : "HEAD~20..HEAD");
      const repoUrl = getRepoUrl();
      const commits = parseCommits(range);

      if (commits.length === 0) {
        ctx.ui.notify(`No commits found in range: ${range}`, "warn");
        return;
      }

      const ansi = formatAnsi(commits, range, repoUrl);
      ctx.ui.notify(ansi, "info");

      if (doWrite) {
        const md = formatMarkdown(commits, range, repoUrl);
        const clPath = resolve("CHANGELOG.md");
        const existing = existsSync(clPath) ? readFileSync(clPath, "utf-8") : "";
        writeFileSync(clPath, md + "\n" + existing);
        ctx.ui.notify(`${GREEN}✅ Written to CHANGELOG.md${RST}`, "info");
      }
    },
  });
}
