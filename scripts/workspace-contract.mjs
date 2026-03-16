import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const TEMPLATE_ROOT = path.join(REPO_ROOT, "contracts", "templates");

const REQUIRED_WORKSPACE_DIRS = ["knowledge", "inbox", "projects", "exports", "data"];

function normalizePath(inputPath) {
  return path.resolve(String(inputPath));
}

export function slugify(input) {
  const raw = String(input ?? "").trim().toLowerCase();
  return raw
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

export function humanizeSlug(input) {
  return String(input)
    .split("-")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function statSafe(targetPath) {
  try {
    return await fs.stat(targetPath);
  } catch {
    return null;
  }
}

async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

async function ensureFile(targetPath, content) {
  if (await pathExists(targetPath)) {
    return false;
  }
  await ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, content, "utf8");
  return true;
}

async function readTemplate(name) {
  const templatePath = path.join(TEMPLATE_ROOT, name);
  return fs.readFile(templatePath, "utf8");
}

function normalizeChannels(inputChannels) {
  const seen = new Set();
  const out = [];
  for (const channel of inputChannels ?? []) {
    const trimmed = String(channel).trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

export async function scaffoldWorkspace(options = {}) {
  const repoRoot = normalizePath(options.repoRoot ?? REPO_ROOT);
  const parentRoot = normalizePath(options.parentRoot ?? path.join(repoRoot, "workspace"));
  const workspaceName = String(options.workspaceName ?? "Content Shotgun").trim() || "Content Shotgun";
  const workspaceSlug = String(options.workspaceSlug ?? slugify(workspaceName)).trim();
  if (!workspaceSlug) {
    throw new Error("workspace slug resolved empty; provide --workspace or --slug with letters/numbers");
  }

  const channels = normalizeChannels(options.channels ?? []);
  const workspaceTitle = String(options.workspaceTitle ?? humanizeSlug(workspaceSlug)).trim() || humanizeSlug(workspaceSlug);

  const created = [];
  const touched = [];

  await ensureDir(parentRoot);
  const instructionsPath = path.join(parentRoot, "instructions.md");
  if (await ensureFile(instructionsPath, await readTemplate("instructions.md"))) {
    created.push(instructionsPath);
  }
  touched.push(instructionsPath);

  const workspacesRoot = path.join(parentRoot, "workspaces");
  await ensureDir(workspacesRoot);

  const workspaceRoot = path.join(workspacesRoot, workspaceSlug);
  await ensureDir(workspaceRoot);
  touched.push(workspaceRoot);

  for (const dirName of REQUIRED_WORKSPACE_DIRS) {
    const dirPath = path.join(workspaceRoot, dirName);
    await ensureDir(dirPath);
    touched.push(dirPath);
  }

  const workspaceBriefPath = path.join(workspaceRoot, "knowledge", "workspace.md");
  if (await ensureFile(workspaceBriefPath, await readTemplate("workspace.md"))) {
    created.push(workspaceBriefPath);
  }
  touched.push(workspaceBriefPath);

  const workspaceConfigPath = path.join(workspaceRoot, "workspace.json");
  if (!(await pathExists(workspaceConfigPath))) {
    await fs.writeFile(
      workspaceConfigPath,
      `${JSON.stringify({ title: workspaceTitle, channels }, null, 2)}\n`,
      "utf8"
    );
    created.push(workspaceConfigPath);
  }
  touched.push(workspaceConfigPath);

  if (options.topicName || options.topicSlug) {
    const topicName = options.topicName ?? options.topicSlug;
    const topicSlug = String(options.topicSlug ?? slugify(topicName)).trim();
    if (!topicSlug) {
      throw new Error("topic slug resolved empty; provide --topic or --topic-slug with letters/numbers");
    }
    const topicRoot = path.join(workspaceRoot, "inbox", topicSlug);
    await ensureDir(topicRoot);
    await ensureDir(path.join(topicRoot, "assets"));

    const masterPath = path.join(topicRoot, "master.md");
    const masterTemplate = (await readTemplate("master.md"))
      .replaceAll("{{TOPIC_TITLE}}", humanizeSlug(topicSlug))
      .replaceAll("{{TOPIC_SLUG}}", topicSlug);
    if (await ensureFile(masterPath, masterTemplate)) {
      created.push(masterPath);
    }

    const topicJsonPath = path.join(topicRoot, "topic.json");
    if (await ensureFile(topicJsonPath, await readTemplate("topic.json"))) {
      created.push(topicJsonPath);
    }

    touched.push(topicRoot, path.join(topicRoot, "assets"), masterPath, topicJsonPath);
  }

  return {
    repoRoot,
    parentRoot,
    workspaceSlug,
    workspaceRoot,
    created: Array.from(new Set(created)).sort(),
    touched: Array.from(new Set(touched)).sort()
  };
}

function pushError(errors, code, targetPath, message) {
  errors.push({ code, path: targetPath, message });
}

function sortErrors(errors) {
  return [...errors].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.code.localeCompare(b.code);
  });
}

async function readDirSafe(targetPath) {
  try {
    return await fs.readdir(targetPath, { withFileTypes: true });
  } catch {
    return null;
  }
}

async function checkExactName(parentDir, expectedName) {
  const entries = await readDirSafe(parentDir);
  if (!entries) {
    return { status: "missing", misnamed: null };
  }

  const exact = entries.find((entry) => entry.name === expectedName);
  if (exact) {
    return {
      status: "ok",
      misnamed: null,
      entry: exact,
      path: path.join(parentDir, exact.name)
    };
  }

  const expectedLower = expectedName.toLowerCase();
  const near = entries.find((entry) => entry.name.toLowerCase() === expectedLower);
  if (near) {
    return {
      status: "misnamed",
      misnamed: near.name,
      entry: near,
      path: path.join(parentDir, near.name)
    };
  }

  return { status: "missing", misnamed: null };
}

async function validateTopicContract(topicRoot, errors) {
  const masterCheck = await checkExactName(topicRoot, "master.md");
  if (masterCheck.status === "missing") {
    pushError(
      errors,
      "L2_TOPIC_MISSING_MASTER",
      path.join(topicRoot, "master.md"),
      "Topic contract requires a file named 'master.md'."
    );
  } else if (masterCheck.status === "misnamed") {
    pushError(
      errors,
      "L2_TOPIC_MISNAMED_MASTER",
      masterCheck.path,
      `Found '${masterCheck.misnamed}'. Rename it to 'master.md'.`
    );
  }

  const topicJsonCheck = await checkExactName(topicRoot, "topic.json");
  if (topicJsonCheck.status === "missing") {
    pushError(
      errors,
      "L2_TOPIC_MISSING_TOPIC_JSON",
      path.join(topicRoot, "topic.json"),
      "Topic contract requires a file named 'topic.json'."
    );
  } else if (topicJsonCheck.status === "misnamed") {
    pushError(
      errors,
      "L2_TOPIC_MISNAMED_TOPIC_JSON",
      topicJsonCheck.path,
      `Found '${topicJsonCheck.misnamed}'. Rename it to 'topic.json'.`
    );
  }

  const assetsCheck = await checkExactName(topicRoot, "assets");
  if (assetsCheck.status === "missing") {
    pushError(
      errors,
      "L2_TOPIC_MISSING_ASSETS",
      path.join(topicRoot, "assets"),
      "Topic contract requires an 'assets/' directory."
    );
  } else if (assetsCheck.status === "misnamed") {
    pushError(
      errors,
      "L2_TOPIC_MISNAMED_ASSETS",
      assetsCheck.path,
      `Found '${assetsCheck.misnamed}'. Rename it to 'assets'.`
    );
  } else if (assetsCheck.status === "ok" && !(assetsCheck.entry?.isDirectory?.())) {
    pushError(
      errors,
      "L2_TOPIC_INVALID_ASSETS",
      assetsCheck.path,
      "Expected 'assets' to be a directory."
    );
  }
}

async function validateWorkspaceContractForPath(workspaceRoot, errors) {
  const workspaceJson = path.join(workspaceRoot, "workspace.json");
  if (!(await pathExists(workspaceJson))) {
    pushError(
      errors,
      "L2_MISSING_WORKSPACE_JSON",
      workspaceJson,
      "Workspace is missing 'workspace.json'."
    );
  }

  const requiredDirs = {
    knowledge: "L2_MISSING_WORKSPACE_KNOWLEDGE",
    inbox: "L2_MISSING_WORKSPACE_INBOX",
    projects: "L2_MISSING_WORKSPACE_PROJECTS",
    exports: "L2_MISSING_WORKSPACE_EXPORTS",
    data: "L2_MISSING_WORKSPACE_DATA"
  };

  for (const [dirName, code] of Object.entries(requiredDirs)) {
    const dirPath = path.join(workspaceRoot, dirName);
    const dirStat = await statSafe(dirPath);
    if (!dirStat) {
      pushError(errors, code, dirPath, `Workspace is missing required '${dirName}/' directory.`);
      continue;
    }
    if (!dirStat.isDirectory()) {
      pushError(errors, `${code}_NOT_DIR`, dirPath, `Expected '${dirName}' to be a directory.`);
    }
  }

  const workspaceBriefCheck = await checkExactName(path.join(workspaceRoot, "knowledge"), "workspace.md");
  if (workspaceBriefCheck.status === "missing") {
    pushError(
      errors,
      "L2_MISSING_WORKSPACE_BRIEF",
      path.join(workspaceRoot, "knowledge", "workspace.md"),
      "Workspace contract requires 'knowledge/workspace.md'."
    );
  } else if (workspaceBriefCheck.status === "misnamed") {
    pushError(
      errors,
      "L2_MISNAMED_WORKSPACE_BRIEF",
      workspaceBriefCheck.path,
      `Found '${workspaceBriefCheck.misnamed}'. Rename it to 'workspace.md'.`
    );
  }

  const inboxPath = path.join(workspaceRoot, "inbox");
  const inboxEntries = await readDirSafe(inboxPath);
  if (!inboxEntries) {
    return;
  }

  const topicDirs = inboxEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(inboxPath, entry.name))
    .sort((a, b) => a.localeCompare(b));

  for (const topicRoot of topicDirs) {
    await validateTopicContract(topicRoot, errors);
  }
}

export async function validateWorkspaceContract(options = {}) {
  const repoRoot = normalizePath(options.repoRoot ?? REPO_ROOT);
  const parentRoot = normalizePath(options.parentRoot ?? path.join(repoRoot, "workspace"));
  const checkLayer1 = options.checkLayer1 !== false;
  const errors = [];

  if (checkLayer1) {
    const layer1Files = [
      {
        name: "CLAUDE.md",
        code: "L1_MISSING_CLAUDE_MD",
        message: "Layer 1 contract file missing: 'CLAUDE.md'."
      },
      {
        name: "AGENTS.md",
        code: "L1_MISSING_AGENTS_MD",
        message: "Layer 1 compatibility pointer missing: 'AGENTS.md'."
      }
    ];

    for (const file of layer1Files) {
      const target = path.join(repoRoot, file.name);
      if (!(await pathExists(target))) {
        pushError(errors, file.code, target, file.message);
      }
    }
  }

  const instructionsPath = path.join(parentRoot, "instructions.md");
  if (!(await pathExists(instructionsPath))) {
    pushError(
      errors,
      "L2_MISSING_PARENT_INSTRUCTIONS",
      instructionsPath,
      "Workspace parent is missing 'instructions.md'."
    );
  }

  const workspacesRoot = path.join(parentRoot, "workspaces");
  const workspacesStat = await statSafe(workspacesRoot);
  if (!workspacesStat) {
    pushError(
      errors,
      "L2_MISSING_WORKSPACES_DIR",
      workspacesRoot,
      "Workspace parent is missing 'workspaces/' directory."
    );
  } else if (!workspacesStat.isDirectory()) {
    pushError(
      errors,
      "L2_WORKSPACES_NOT_DIR",
      workspacesRoot,
      "Expected 'workspaces' to be a directory."
    );
  } else {
    const workspaceEntries = (await fs.readdir(workspacesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(workspacesRoot, entry.name))
      .sort((a, b) => a.localeCompare(b));

    for (const workspaceRoot of workspaceEntries) {
      await validateWorkspaceContractForPath(workspaceRoot, errors);
    }
  }

  return {
    repoRoot,
    parentRoot,
    errors: sortErrors(errors)
  };
}

export function formatValidationErrors(errors) {
  return errors.map((error) => `[${error.code}] ${error.message} (${error.path})`);
}
