/**
 * 첫 실행 셋업 모듈
 * - Docker Desktop 확인
 * - Node.js 확인
 * - Git 확인
 * - 프로젝트 클론 + npm install
 * - 기본 설정 파일 생성
 */

const { exec, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

async function checkCommand(cmd) {
  try {
    await execAsync(cmd);
    return true;
  } catch {
    return false;
  }
}

async function checkPrerequisites() {
  const results = {
    git: await checkCommand("git --version"),
    node: await checkCommand("node --version"),
    docker: await checkCommand("docker --version"),
    npm: await checkCommand("npm --version"),
  };
  return results;
}

function isProjectSetUp(projectRoot) {
  return (
    fs.existsSync(path.join(projectRoot, "server.js")) &&
    fs.existsSync(path.join(projectRoot, "package.json"))
  );
}

function isNpmInstalled(projectRoot) {
  return fs.existsSync(path.join(projectRoot, "node_modules"));
}

async function cloneProject(projectRoot, repoUrl, onProgress) {
  return new Promise((resolve, reject) => {
    const parentDir = path.dirname(projectRoot);
    const dirName = path.basename(projectRoot);

    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    onProgress("Git clone...");
    const proc = spawn("git", ["clone", repoUrl, dirName], {
      cwd: parentDir,
      shell: true,
    });

    let output = "";
    proc.stdout.on("data", (d) => {
      output += d.toString();
      onProgress(d.toString().trim());
    });
    proc.stderr.on("data", (d) => {
      output += d.toString();
      onProgress(d.toString().trim());
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`Git clone failed (code ${code}): ${output}`));
    });
    proc.on("error", reject);
  });
}

async function npmInstall(projectRoot, onProgress) {
  return new Promise((resolve, reject) => {
    onProgress("npm install...");
    const proc = spawn("npm", ["install"], {
      cwd: projectRoot,
      shell: true,
    });

    let output = "";
    proc.stdout.on("data", (d) => {
      output += d.toString();
      onProgress(d.toString().trim());
    });
    proc.stderr.on("data", (d) => {
      output += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`npm install failed (code ${code})`));
    });
    proc.on("error", reject);
  });
}

function createDefaultConfigs(configFile, environmentsFile) {
  if (!fs.existsSync(configFile)) {
    const defaultConfig = {
      environment: "production",
      n8nApiKey: "",
      n8nEmail: "",
      n8nPassword: "",
      visibleWorkflows: [],
      vendorSelections: { global: [] },
      poEmail: "",
      graphqlUrl: "",
      smtpPassword: "",
    };
    fs.writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2), "utf-8");
  }

  if (!fs.existsSync(environmentsFile)) {
    const defaultEnv = {
      local: {
        label: "로컬",
        GRAPHQL_URL: "",
        MALL_URL: "http://localhost:7000",
        AUTH_TOKEN: "",
      },
      production: {
        label: "프로덕션",
        GRAPHQL_URL: "https://api.pojangboss.com/graphql/",
        MALL_URL: "https://pojangboss.com",
        AUTH_TOKEN: "",
      },
    };
    fs.writeFileSync(environmentsFile, JSON.stringify(defaultEnv, null, 2), "utf-8");
  }
}

module.exports = {
  checkPrerequisites,
  isProjectSetUp,
  isNpmInstalled,
  cloneProject,
  npmInstall,
  createDefaultConfigs,
};
