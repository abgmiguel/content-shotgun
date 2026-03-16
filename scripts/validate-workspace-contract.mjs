#!/usr/bin/env node
import { formatValidationErrors, validateWorkspaceContract } from "./workspace-contract.mjs";

function parseArgs(argv) {
  const args = {
    repoRoot: null,
    parentRoot: null,
    checkLayer1: true,
    asJson: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--repo-root") {
      args.repoRoot = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token === "--parent") {
      args.parentRoot = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token === "--no-layer1") {
      args.checkLayer1 = false;
      continue;
    }
    if (token === "--json") {
      args.asJson = true;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await validateWorkspaceContract({
    repoRoot: args.repoRoot,
    parentRoot: args.parentRoot,
    checkLayer1: args.checkLayer1
  });

  if (args.asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.errors.length > 0) {
    console.error("Workspace contract validation failed:");
    for (const line of formatValidationErrors(result.errors)) {
      console.error(` - ${line}`);
    }
  } else {
    console.log("Workspace contract valid.");
  }

  if (result.errors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
});
