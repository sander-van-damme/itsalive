import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function buildInfo() {
  const git = (...args: string[]) => {
    try {
      return execFileSync("git", args, {
        cwd: import.meta.dirname,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  };
  const pkg = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return {
    version: pkg.version,
    commit:
      process.env.CF_PAGES_COMMIT_SHA ||
      process.env.GITHUB_SHA ||
      git("rev-parse", "HEAD") ||
      "unknown",
    subject: git("log", "-1", "--format=%s"),
    builtAt: new Date().toISOString(),
    dirty: Boolean(git("status", "--porcelain", "--untracked-files=no")),
  };
}
