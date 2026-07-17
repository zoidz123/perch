#!/usr/bin/env node

import { constants, copyFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const canonicalReadme = join(root, "README.md");
const packageReadme = join(root, "npm/README.md");
const backupReadme = join(root, ".npm-readme-backup.md");
const action = process.argv[2];

if (action === "stage") {
  if (existsSync(backupReadme)) {
    throw new Error("an npm README backup already exists; run `node scripts/npm-readme.mjs restore` before packing again");
  }
  copyFileSync(canonicalReadme, backupReadme, constants.COPYFILE_EXCL);
  copyFileSync(packageReadme, canonicalReadme);
} else if (action === "restore") {
  if (existsSync(backupReadme)) {
    copyFileSync(backupReadme, canonicalReadme);
    rmSync(backupReadme);
  }
} else {
  throw new Error("usage: node scripts/npm-readme.mjs <stage|restore>");
}
