import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

// Ranked directory suggestions for the new-agent picker: a bounded BFS crawl
// under $HOME with a short-lived cache. Queries match by
// tiers (exact basename > prefix > substring > subsequence); path-looking
// queries ("~/Des", "/opt/x") resolve against the filesystem directly.

const MAX_DEPTH = 6;
const MAX_SCANNED = 20_000;
const CACHE_TTL_MS = 8_000;
const DEFAULT_LIMIT = 12;

const IGNORED = new Set([
  "node_modules",
  ".git",
  ".Trash",
  "Library",
  ".cache",
  ".npm",
  ".cargo",
  "dist",
  "build",
  ".build",
  "DerivedData",
  ".treehouse"
]);

type CrawlCache = {
  at: number;
  dirs: string[];
};

let cache: CrawlCache | undefined;

export function suggestDirectories(
  query: string,
  options: { home?: string; limit?: number } = {}
): string[] {
  const home = options.home ?? homedir();
  const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIMIT, 50));
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return [];
  }

  // Path-shaped queries list the target directory directly.
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) {
    return completePath(trimmed, home, limit);
  }

  const needle = trimmed.toLowerCase();
  const scored: Array<{ path: string; score: number }> = [];
  for (const dir of crawl(home)) {
    const name = basename(dir).toLowerCase();
    let score: number | undefined;
    if (name === needle) {
      score = 0;
    } else if (name.startsWith(needle)) {
      score = 1;
    } else if (name.includes(needle)) {
      score = 2;
    } else if (isSubsequence(needle, name)) {
      score = 3;
    }
    if (score !== undefined) {
      // Shallower matches first within a tier.
      scored.push({ path: dir, score: score * 100 + depthOf(dir, home) });
    }
  }
  scored.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((entry) => entry.path);
}

// "~/Des" -> children of ~ whose name starts with "Des"; "~/Desktop/" -> its
// subdirectories.
function completePath(query: string, home: string, limit: number): string[] {
  const expanded = query.startsWith("~") ? join(home, query.slice(1)) : query;
  const endsWithSep = expanded.endsWith(sep);
  const dir = endsWithSep ? expanded : join(expanded, "..");
  const prefix = endsWithSep ? "" : basename(expanded).toLowerCase();
  try {
    return readdirSync(resolve(dir), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          entry.name.toLowerCase().startsWith(prefix)
      )
      .slice(0, limit)
      .map((entry) => join(resolve(dir), entry.name));
  } catch {
    return [];
  }
}

function crawl(home: string): string[] {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) {
    return cache.dirs;
  }

  const dirs: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: home, depth: 0 }];
  let scanned = 0;

  while (queue.length > 0 && scanned < MAX_SCANNED) {
    const { path, depth } = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || IGNORED.has(entry.name)) {
        continue;
      }
      scanned += 1;
      const child = join(path, entry.name);
      dirs.push(child);
      if (depth + 1 < MAX_DEPTH) {
        queue.push({ path: child, depth: depth + 1 });
      }
      if (scanned >= MAX_SCANNED) {
        break;
      }
    }
  }

  cache = { at: now, dirs };
  return dirs;
}

function depthOf(path: string, home: string): number {
  return path.slice(home.length).split(sep).length;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const char of haystack) {
    if (char === needle[i]) {
      i += 1;
      if (i === needle.length) {
        return true;
      }
    }
  }
  return false;
}

// Test seam: drop the crawl cache.
export function resetSuggestCache(): void {
  cache = undefined;
}
