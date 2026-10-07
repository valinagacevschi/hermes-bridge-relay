// Generated from expo-hermes; edit the private source, not this mirror.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function filesUnder(dir) {
  return readdirSync(dir)
    .filter((name) => ![".git", "node_modules", "dist", ".expo", ".relay-build"].includes(name))
    .flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
    });
}

describe("public distribution boundary", () => {
  it("contains only files recorded in the generated allowlist manifest", () => {
    const listed = new Set(JSON.parse(readFileSync(".relay-mirror-files.json", "utf8")));
    const actual = filesUnder(".")
      .filter((path) => path !== "./expo-env.d.ts")
      .map((path) => path.replace(/^\.\//, ""));
    expect(actual.sort()).toEqual([...listed].sort());
  });

  it("does not include private, mobile, or secret files", () => {
    const actual = filesUnder(".")
      .filter((path) => path !== "./expo-env.d.ts")
      .map((path) => path.replace(/^\.\//, ""));
    expect(actual.some((path) => /(^|\/)(components|assets|PRD_[^/]*|\.env(?:\.|$))/.test(path))).toBe(false);
    expect(actual.some((path) => /(^|\/)(secret\.ya?ml|CLAUDE\.md|CONTEXT\.md)$/.test(path))).toBe(false);
  });
});
