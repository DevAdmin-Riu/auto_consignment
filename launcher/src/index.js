const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, exec } = require("child_process");
const http = require("http");
const https = require("https");

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require("electron-squirrel-startup")) {
  app.quit();
}

// 프로젝트 루트 디렉토리 (launcher/src/ → launcher/ → project root)
const LAUNCHER_ROOT = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(LAUNCHER_ROOT, "..");
const COMPOSE_FILE = path.join(PROJECT_ROOT, "docker-compose-window.yml");
const ENVIRONMENTS_FILE = path.join(LAUNCHER_ROOT, "environments.json");
const CONFIG_FILE = path.join(LAUNCHER_ROOT, "launcher-config.json");

let mainWindow;
let logProcesses = {};

// ==================== 설정 관리 ====================

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("설정 로드 실패:", e.message);
  }
  return { environment: "production", n8nApiKey: "" };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

function loadEnvironments() {
  return JSON.parse(fs.readFileSync(ENVIRONMENTS_FILE, "utf-8"));
}

// ==================== Docker Compose 파일 생성 ====================

function generateComposeFile(envKey) {
  const environments = loadEnvironments();
  const env = environments[envKey];
  if (!env) throw new Error(`환경을 찾을 수 없습니다: ${envKey}`);

  const content = `services:
  n8n:
    build:
      context: .
      dockerfile: Dockerfile.n8n
    container_name: n8n
    restart: unless-stopped
    ports:
      - "5678:5678"
    volumes:
      - ./data:/home/node/.n8n
      - .:/home/node/vendor-automation
    environment:
      - TZ=Asia/Seoul
      - WEBHOOK_URL=https://resolutive-naoma-unideographically.ngrok-free.dev/
      - N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=false
      - N8N_ALLOW_ENV_ACCESS=AUTH_TOKEN,GRAPHQL_URL,CONTENT_TYPE,MALL_URL
      - N8N_BLOCK_ENV_ACCESS_IN_NODE=false
      - NODE_FUNCTION_ALLOW_EXTERNAL=xlsx,xlsx-js-style
      - GRAPHQL_URL=${env.GRAPHQL_URL}
      - MALL_URL=${env.MALL_URL}
      - AUTH_TOKEN=${env.AUTH_TOKEN}
`;

  fs.writeFileSync(COMPOSE_FILE, content, "utf-8");
  return env.label;
}

// ==================== 명령어 실행 ====================

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd || PROJECT_ROOT,
      shell: true,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr || stdout || `Exit code: ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}

// ==================== 서비스 상태 확인 ====================

function checkHttpHealth(port, healthPath) {
  return new Promise((resolve) => {
    const req = http.get(
      `http://localhost:${port}${healthPath}`,
      { timeout: 3000 },
      (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function getN8nStatus() {
  try {
    const result = await runCommand("docker", [
      "ps",
      "--filter",
      "name=n8n",
      "--format",
      "{{.Status}}",
    ]);
    return result.includes("Up") ? "running" : "stopped";
  } catch {
    return "stopped";
  }
}

async function getOrderStatus() {
  const ok = await checkHttpHealth(3000, "/health");
  return ok ? "running" : "stopped";
}

async function getTrackingStatus() {
  const ok = await checkHttpHealth(3001, "/api/vendor/tracking/status");
  return ok ? "running" : "stopped";
}

async function getAllStatus() {
  const [n8n, order, tracking] = await Promise.all([
    getN8nStatus(),
    getOrderStatus(),
    getTrackingStatus(),
  ]);
  return { n8n, order, tracking };
}

// ==================== 서비스 제어 ====================

async function startN8n() {
  sendLog("system", "[시스템] n8n 컨테이너 시작 중...");
  await runCommand("docker", [
    "compose",
    "-f",
    "docker-compose-window.yml",
    "up",
    "-d",
    "--build",
  ]);
  sendLog("system", "[시스템] n8n 컨테이너 시작됨");
  startLogStream("n8n");
}

async function stopN8n() {
  sendLog("system", "[시스템] n8n 컨테이너 중지 중...");
  stopLogStream("n8n");
  await runCommand("docker", [
    "compose",
    "-f",
    "docker-compose-window.yml",
    "down",
  ]);
  sendLog("system", "[시스템] n8n 컨테이너 중지됨");
}

async function startPm2() {
  sendLog("system", "[시스템] PM2 서버 시작 중...");
  await runCommand("npx", ["pm2", "start", "ecosystem.config.cjs"]);
  sendLog("system", "[시스템] PM2 서버 시작됨");
  startLogStream("pm2");
}

async function stopPm2() {
  sendLog("system", "[시스템] PM2 서버 중지 중...");
  stopLogStream("pm2");
  await runCommand("npx", ["pm2", "stop", "all"]);
  sendLog("system", "[시스템] PM2 서버 중지됨");
}

async function restartOrder() {
  sendLog("system", "[시스템] 주문 서버 재시작 중...");
  await runCommand("npx", ["pm2", "restart", "order"]);
  sendLog("system", "[시스템] 주문 서버 재시작됨");
}

async function restartTracking() {
  sendLog("system", "[시스템] 송장 서버 재시작 중...");
  await runCommand("npx", ["pm2", "restart", "tracking"]);
  sendLog("system", "[시스템] 송장 서버 재시작됨");
}

// ==================== 로그 스트리밍 ====================

function sendLog(source, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("log", { source, message });
  }
}

function startLogStream(type) {
  stopLogStream(type);

  if (type === "n8n") {
    const proc = spawn("docker", ["logs", "-f", "--tail", "100", "n8n"], {
      cwd: PROJECT_ROOT,
      shell: true,
      windowsHide: true,
    });

    proc.stdout.on("data", (data) => {
      data
        .toString()
        .split("\n")
        .filter(Boolean)
        .forEach((line) => sendLog("n8n", line));
    });

    proc.stderr.on("data", (data) => {
      data
        .toString()
        .split("\n")
        .filter(Boolean)
        .forEach((line) => sendLog("n8n", line));
    });

    logProcesses.n8n = proc;
  }

  if (type === "pm2") {
    const proc = spawn("npx", ["pm2", "logs", "--raw", "--lines", "100"], {
      cwd: PROJECT_ROOT,
      shell: true,
      windowsHide: true,
    });

    proc.stdout.on("data", (data) => {
      data
        .toString()
        .split("\n")
        .filter(Boolean)
        .forEach((line) => {
          // PM2 로그에서 서비스 구분
          if (line.includes("order|") || line.includes("0|order")) {
            sendLog("order", line);
          } else if (
            line.includes("tracking|") ||
            line.includes("1|tracking")
          ) {
            sendLog("tracking", line);
          } else {
            sendLog("pm2", line);
          }
        });
    });

    proc.stderr.on("data", (data) => {
      data
        .toString()
        .split("\n")
        .filter(Boolean)
        .forEach((line) => sendLog("pm2", line));
    });

    logProcesses.pm2 = proc;
  }
}

function stopLogStream(type) {
  if (logProcesses[type]) {
    try {
      logProcesses[type].kill();
    } catch (e) {
      // ignore
    }
    delete logProcesses[type];
  }
}

// ==================== n8n 워크플로우 API ====================

function n8nApiRequest(method, apiPath, body = null) {
  const config = loadConfig();
  if (!config.n8nApiKey) {
    return Promise.reject(new Error("n8n API 키가 설정되지 않았습니다"));
  }

  return new Promise((resolve, reject) => {
    const url = `http://localhost:5678/api/v1${apiPath}`;
    const urlObj = new URL(url);

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        "X-N8N-API-KEY": config.n8nApiKey,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("요청 시간 초과"));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

async function getWorkflows() {
  try {
    const result = await n8nApiRequest("GET", "/workflows?limit=100");
    if (result.data) {
      return result.data.map((wf) => ({
        id: wf.id,
        name: wf.name,
        active: wf.active,
      }));
    }
    return [];
  } catch (error) {
    console.error("워크플로우 목록 조회 실패:", error.message);
    return [];
  }
}

async function executeWorkflow(id) {
  try {
    sendLog("system", `[시스템] 워크플로우 #${id} 실행 중...`);
    const result = await n8nApiRequest("POST", `/workflows/${id}/run`);
    sendLog("system", `[시스템] 워크플로우 #${id} 실행 완료`);
    return { success: true, result };
  } catch (error) {
    sendLog("system", `[시스템] 워크플로우 실행 실패: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// ==================== IPC 핸들러 ====================

function setupIpcHandlers() {
  // 서비스 상태
  ipcMain.handle("get-status", getAllStatus);

  // 전체 시작/중지
  ipcMain.handle("start-all", async () => {
    try {
      await startN8n();
      await startPm2();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("stop-all", async () => {
    try {
      await stopPm2();
      await stopN8n();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 개별 서비스 제어
  ipcMain.handle("start-service", async (_, name) => {
    try {
      if (name === "n8n") await startN8n();
      else if (name === "order") await startPm2();
      else if (name === "tracking") await startPm2();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("stop-service", async (_, name) => {
    try {
      if (name === "n8n") await stopN8n();
      else if (name === "order" || name === "tracking") await stopPm2();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("restart-service", async (_, name) => {
    try {
      if (name === "n8n") {
        await stopN8n();
        await startN8n();
      } else if (name === "order") {
        await restartOrder();
      } else if (name === "tracking") {
        await restartTracking();
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // 환경 전환
  ipcMain.handle("get-environment", () => {
    const config = loadConfig();
    return config.environment;
  });

  ipcMain.handle("get-environments", () => {
    const environments = loadEnvironments();
    return Object.entries(environments).map(([key, val]) => ({
      key,
      label: val.label,
    }));
  });

  ipcMain.handle("switch-environment", async (_, envKey) => {
    try {
      const label = generateComposeFile(envKey);
      const config = loadConfig();
      config.environment = envKey;
      saveConfig(config);
      sendLog("system", `[시스템] 환경 전환: ${label}`);

      // n8n이 실행 중이면 재시작
      const n8nStatus = await getN8nStatus();
      if (n8nStatus === "running") {
        sendLog("system", "[시스템] n8n 재시작 중 (환경 변경)...");
        await runCommand("docker", [
          "compose",
          "-f",
          "docker-compose-window.yml",
          "down",
        ]);
        await runCommand("docker", [
          "compose",
          "-f",
          "docker-compose-window.yml",
          "up",
          "-d",
          "--build",
        ]);
        sendLog("system", "[시스템] n8n 재시작 완료");
        startLogStream("n8n");
      }

      return { success: true, label };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // n8n 열기
  ipcMain.handle("open-n8n", () => {
    shell.openExternal("http://localhost:5678");
  });

  // 워크플로우
  ipcMain.handle("get-workflows", getWorkflows);
  ipcMain.handle("execute-workflow", (_, id) => executeWorkflow(id));

  // 설정
  ipcMain.handle("get-config", () => loadConfig());
  ipcMain.handle("save-config", (_, config) => {
    const current = loadConfig();
    Object.assign(current, config);
    saveConfig(current);
    return { success: true };
  });
}

// ==================== 윈도우 생성 ====================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    title: "포장보스 자동화 관리자",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    autoHideMenuBar: true,
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  // 현재 환경으로 compose 파일 생성
  const config = loadConfig();
  try {
    generateComposeFile(config.environment);
  } catch (e) {
    console.error("초기 compose 파일 생성 실패:", e.message);
  }
}

// ==================== 앱 시작 ====================

app.whenReady().then(() => {
  setupIpcHandlers();
  createWindow();
});

app.on("window-all-closed", () => {
  // 로그 스트림 정리
  Object.keys(logProcesses).forEach(stopLogStream);
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
