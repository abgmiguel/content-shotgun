import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { scaffoldWorkspace, validateWorkspaceContract } from "../scripts/workspace-contract.mjs";

const execFileAsync = promisify(execFile);

async function mkTmp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function writeLayer1(repoRoot) {
  await fs.writeFile(path.join(repoRoot, "CLAUDE.md"), "# contract\n", "utf8");
  await fs.writeFile(path.join(repoRoot, "AGENTS.md"), "see CLAUDE.md\n", "utf8");
}

test("valid Layer 1 + Layer 2 tree passes validator", async () => {
  const repoRoot = await mkTmp("contract-valid-");
  const parentRoot = path.join(repoRoot, "workspace-parent");
  await writeLayer1(repoRoot);

  await scaffoldWorkspace({
    repoRoot,
    parentRoot,
    workspaceName: "Acme Workspace",
    topicName: "Summer Launch"
  });

  const result = await validateWorkspaceContract({ repoRoot, parentRoot, checkLayer1: true });
  assert.equal(result.errors.length, 0);
});

test("missing Layer 1 and Layer 2 files return specific error codes", async () => {
  const repoRoot = await mkTmp("contract-missing-");
  const parentRoot = path.join(repoRoot, "workspace-parent");

  const result = await validateWorkspaceContract({ repoRoot, parentRoot, checkLayer1: true });
  const codes = result.errors.map((entry) => entry.code);

  assert.ok(codes.includes("L1_MISSING_CLAUDE_MD"));
  assert.ok(codes.includes("L1_MISSING_AGENTS_MD"));
  assert.ok(codes.includes("L2_MISSING_PARENT_INSTRUCTIONS"));
  assert.ok(codes.includes("L2_MISSING_WORKSPACES_DIR"));
});

test("misnamed topic contract files produce deterministic diagnostics", async () => {
  const repoRoot = await mkTmp("contract-misnamed-");
  const parentRoot = path.join(repoRoot, "workspace-parent");
  await writeLayer1(repoRoot);

  const scaffold = await scaffoldWorkspace({
    repoRoot,
    parentRoot,
    workspaceName: "Acme Workspace"
  });

  const topicRoot = path.join(scaffold.workspaceRoot, "inbox", "bad-topic");
  await fs.mkdir(path.join(topicRoot, "Assets"), { recursive: true });
  await fs.writeFile(path.join(topicRoot, "Master.md"), "# wrong casing\n", "utf8");
  await fs.writeFile(path.join(topicRoot, "Topic.json"), "{}\n", "utf8");

  const result = await validateWorkspaceContract({ repoRoot, parentRoot, checkLayer1: true });
  const codes = result.errors.map((entry) => entry.code);

  assert.deepEqual(
    codes,
    [
      "L2_TOPIC_MISNAMED_ASSETS",
      "L2_TOPIC_MISNAMED_MASTER",
      "L2_TOPIC_MISNAMED_TOPIC_JSON"
    ]
  );
});

test("scaffold command creates expected structure from empty directory", async () => {
  const parentRoot = await mkTmp("scaffold-cli-");
  const scriptPath = path.resolve(process.cwd(), "scripts", "scaffold-workspace.mjs");

  await execFileAsync("node", [
    scriptPath,
    "--parent",
    parentRoot,
    "--workspace",
    "Field Ops",
    "--topic",
    "Launch Topic"
  ]);

  const workspaceRoot = path.join(parentRoot, "workspaces", "field-ops");
  assert.equal(await exists(path.join(parentRoot, "instructions.md")), true);
  assert.equal(await exists(path.join(workspaceRoot, "workspace.json")), true);
  assert.equal(await exists(path.join(workspaceRoot, "knowledge", "workspace.md")), true);
  assert.equal(await exists(path.join(workspaceRoot, "inbox", "launch-topic", "master.md")), true);
  assert.equal(await exists(path.join(workspaceRoot, "inbox", "launch-topic", "topic.json")), true);
  assert.equal(await exists(path.join(workspaceRoot, "inbox", "launch-topic", "assets")), true);
});
