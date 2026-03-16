#!/usr/bin/env node
import path from "node:path";
import { scaffoldWorkspace } from "./workspace-contract.mjs";

function parseArgs(argv) {
  const args = {
    parentRoot: null,
    workspaceName: "Content Shotgun",
    workspaceSlug: null,
    workspaceTitle: null,
    channels: [],
    topicName: null,
    topicSlug: null
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--parent") {
      args.parentRoot = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token === "--workspace") {
      args.workspaceName = argv[i + 1] ?? args.workspaceName;
      i += 1;
      continue;
    }
    if (token === "--slug") {
      args.workspaceSlug = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token === "--title") {
      args.workspaceTitle = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token === "--channels") {
      const raw = argv[i + 1] ?? "";
      args.channels = raw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    if (token === "--topic") {
      args.topicName = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (token === "--topic-slug") {
      args.topicSlug = argv[i + 1] ?? null;
      i += 1;
    }
  }

  return args;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const result = await scaffoldWorkspace({
    parentRoot: parsed.parentRoot,
    workspaceName: parsed.workspaceName,
    workspaceSlug: parsed.workspaceSlug,
    workspaceTitle: parsed.workspaceTitle,
    channels: parsed.channels,
    topicName: parsed.topicName,
    topicSlug: parsed.topicSlug
  });

  const rel = (target) => path.relative(process.cwd(), target) || ".";
  console.log(`Scaffolded workspace '${result.workspaceSlug}'`);
  console.log(`parent: ${rel(result.parentRoot)}`);
  console.log(`workspace: ${rel(result.workspaceRoot)}`);
  console.log(`created: ${result.created.length}`);

  for (const createdPath of result.created) {
    console.log(` + ${rel(createdPath)}`);
  }
}

main().catch((error) => {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
});
