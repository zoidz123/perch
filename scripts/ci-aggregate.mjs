#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export function validateAggregate(results) {
  const failures = [];
  for (const result of results) {
    if (result.required && result.status !== "success") {
      failures.push(`${result.name} was ${result.status}`);
    }
    if (result.selected && result.status !== "success") {
      failures.push(`${result.name} was selected but ${result.status}`);
    }
    if (!result.required && !result.selected && !["skipped", "success"].includes(result.status)) {
      failures.push(`${result.name} was not selected but ${result.status}`);
    }
  }
  return failures;
}

function parseArgument(argument) {
  const [name, selected, status] = argument.split(":");
  if (!name || !["required", "true", "false"].includes(selected) || !status) {
    throw new Error(`invalid aggregate input: ${argument}`);
  }
  return { name, required: selected === "required", selected: selected === "true", status };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = process.argv.slice(2).map(parseArgument);
  const failures = validateAggregate(results);
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log("All required CI jobs passed");
}
