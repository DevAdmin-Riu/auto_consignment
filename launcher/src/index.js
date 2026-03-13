const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn, exec } = require("child_process");
const http = require("http");
const https = require("https");
const setup = require("./setup");

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require("electron-squirrel-startup")) {
  app.quit();
}

// ==================== 경로 설정 (개발/패키징 모드 자동 감지) ====================

const IS_PACKAGED = app.isPackaged;
const LAUNCHER_ROOT = IS_PACKAGED
  ? path.dirname(app.getPath("exe"))
  : path.resolve(__dirname, "..");
const PROJECT_ROOT = IS_PACKAGED
  ? path.join(app.getPath("userData"), "project")
  : path.resolve(LAUNCHER_ROOT, "..");
const COMPOSE_FILE = path.join(PROJECT_ROOT, "docker-compose-window.yml");
const ENVIRONMENTS_FILE = IS_PACKAGED
  ? path.join(app.getPath("userData"), "environments.json")
  : path.join(LAUNCHER_ROOT, "environments.json");
const CONFIG_FILE = IS_PACKAGED
  ? path.join(app.getPath("userData"), "launcher-config.json")
  : path.join(LAUNCHER_ROOT, "launcher-config.json");
const GITHUB_REPO = "https://github.com/riu-dohyun/riu-puppeteer.git";

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
  return { environment: "production", n8nApiKey: "", poEmail: "xdswwwj@riupack.com", smtpPassword: "", graphqlUrl: "" };
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

function loadEnvironments() {
  return JSON.parse(fs.readFileSync(ENVIRONMENTS_FILE, "utf-8"));
}

function saveEnvironments(environments) {
  fs.writeFileSync(ENVIRONMENTS_FILE, JSON.stringify(environments, null, 2), "utf-8");
}

// ==================== Docker Compose 파일 생성 ====================

function generateComposeFile(envKey) {
  const environments = loadEnvironments();
  const env = environments[envKey];
  if (!env) throw new Error(`환경을 찾을 수 없습니다: ${envKey}`);

  const config = loadConfig();
  const poEmail = config.poEmail || 'xdswwwj@riupack.com';
  const smtpPassword = config.smtpPassword || '';

  let graphqlUrl = env.GRAPHQL_URL;
  // /graphql/ 경로 자동 보정
  if (graphqlUrl && !graphqlUrl.endsWith("/graphql/")) {
    graphqlUrl = graphqlUrl.replace(/\/+$/, "") + "/graphql/";
  }

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
      - WEBHOOK_URL=https://settings-themselves-gulf-ink.trycloudflare.com/
      - N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=false
      - N8N_ALLOW_ENV_ACCESS=AUTH_TOKEN,GRAPHQL_URL,CONTENT_TYPE,MALL_URL,SMTP_PASSWORD,PO_EMAIL
      - N8N_BLOCK_ENV_ACCESS_IN_NODE=false
      - NODE_FUNCTION_ALLOW_EXTERNAL=xlsx,xlsx-js-style,exceljs,axios,nodemailer
      - GRAPHQL_URL=${graphqlUrl}
      - MALL_URL=${env.MALL_URL}
      - AUTH_TOKEN=${env.AUTH_TOKEN}
      - SMTP_PASSWORD=${smtpPassword}
      - PO_EMAIL=${poEmail}
`;

  fs.writeFileSync(COMPOSE_FILE, content, "utf-8");
  return env.label;
}

// ==================== 명령어 실행 ====================

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const fullCmd = [command, ...args].join(" ");
    const proc = spawn(fullCmd, {
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
  const ok = await checkHttpHealth(3002, "/health");
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

/**
 * Docker Desktop 실행 여부 확인 및 자동 시작
 */
async function ensureDockerRunning() {
  try {
    await runCommand("docker", ["info"]);
    return; // Docker가 이미 실행 중
  } catch (e) {
    // Docker가 실행되지 않음
  }

  sendLog("system", "[시스템] Docker Desktop이 꺼져있어 자동 시작합니다...");

  // Docker Desktop 실행
  try {
    spawn("cmd /c start \"\" \"C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe\"", {
      shell: true,
      windowsHide: true,
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch (e) {
    sendLog("system", "[시스템] Docker Desktop 실행 실패: " + e.message);
    throw new Error("Docker Desktop을 시작할 수 없습니다. 수동으로 실행해주세요.");
  }

  // Docker 준비될 때까지 대기 (최대 120초)
  sendLog("system", "[시스템] Docker Desktop 시작 대기 중...");
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      await runCommand("docker", ["info"]);
      sendLog("system", "[시스템] Docker Desktop 준비 완료");
      return;
    } catch (e) {
      if (i % 5 === 4) {
        sendLog("system", `[시스템] Docker Desktop 대기 중... (${(i + 1) * 3}초)`);
      }
    }
  }

  throw new Error("Docker Desktop 시작 시간 초과 (120초). 수동으로 실행해주세요.");
}

async function startN8n() {
  sendLog("system", "[시스템] n8n 컨테이너 시작 중...");
  // 최신 config로 compose 파일 갱신
  const config = loadConfig();
  try {
    generateComposeFile(config.environment);
  } catch (e) {
    sendLog("system", `[시스템] compose 파일 갱신 실패: ${e.message}`);
  }
  await ensureDockerRunning();
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

async function startService(name) {
  sendLog("system", `[시스템] ${name} 서버 시작 중...`);
  await runCommand("npx", ["pm2", "start", "ecosystem.config.cjs", "--only", name]);
  sendLog("system", `[시스템] ${name} 서버 시작됨`);
  // 이미 pm2 로그 스트림이 있으면 재시작하지 않음 (중복 방지)
  if (!logProcesses.pm2) {
    startLogStream("pm2");
  }
}

async function stopService(name) {
  sendLog("system", `[시스템] ${name} 서버 중지 중...`);
  await runCommand("npx", ["pm2", "stop", name]);
  sendLog("system", `[시스템] ${name} 서버 중지됨`);
}

async function restartService(name) {
  sendLog("system", `[시스템] ${name} 서버 재시작 중...`);
  await runCommand("npx", ["pm2", "restart", name]);
  sendLog("system", `[시스템] ${name} 서버 재시작됨`);
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
    const proc = spawn("docker logs -f --tail 100 n8n", {
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
    const proc = spawn("npx pm2 logs --raw --lines 100", {
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
      // Windows에서 shell 자식 프로세스까지 전부 종료 (프로세스 트리 kill)
      spawn("taskkill", ["/F", "/T", "/PID", String(logProcesses[type].pid)], {
        shell: true,
        windowsHide: true,
      });
    } catch (e) {
      // ignore
    }
    delete logProcesses[type];
  }
}

// ==================== n8n API ====================

function n8nApiRequest(method, apiPath, body = null) {
  const config = loadConfig();
  if (!config.n8nApiKey) {
    return Promise.reject(new Error("n8n API 키가 설정되지 않았습니다"));
  }

  return new Promise((resolve, reject) => {
    const url = `http://localhost:5678/api/v1${apiPath}`;
    const urlObj = new URL(url);
    const bodyStr = body ? JSON.stringify(body) : null;

    const headers = {
      "X-N8N-API-KEY": config.n8nApiKey,
      "Content-Type": "application/json",
    };
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);

    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method,
        headers,
        timeout: 30000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }

          if (res.statusCode >= 200 && res.statusCode < 400) {
            resolve(parsed);
          } else {
            const msg =
              typeof parsed === "object"
                ? JSON.stringify(parsed)
                : String(parsed);
            reject(new Error(`HTTP ${res.statusCode}: ${msg.substring(0, 500)}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("요청 시간 초과"));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// n8n 내부 REST API (/rest/) - 세션 쿠키 인증
function n8nInternalRequest(method, restPath, body = null, cookie = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json" };
    if (cookie) headers["Cookie"] = cookie;
    if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr);

    const req = http.request(
      {
        hostname: "localhost",
        port: 5678,
        path: `/rest${restPath}`,
        method,
        headers,
        timeout: 60000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }

          if (res.statusCode >= 200 && res.statusCode < 400) {
            resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
          } else {
            const msg =
              typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed);
            reject(new Error(`HTTP ${res.statusCode}: ${msg.substring(0, 500)}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("n8n 내부 API 요청 시간 초과"));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// n8n 세션 관리
let n8nSessionCookie = null;

async function n8nLogin() {
  const config = loadConfig();
  if (!config.n8nEmail || !config.n8nPassword) {
    throw new Error("n8n 로그인 정보를 설정에서 입력해주세요 (이메일/비밀번호)");
  }

  sendLog("system", `[시스템] n8n 로그인 시도: ${config.n8nEmail}`);
  const result = await n8nInternalRequest("POST", "/login", {
    emailOrLdapLoginId: config.n8nEmail,
    password: config.n8nPassword,
  });

  const setCookies = result.headers["set-cookie"];
  if (setCookies) {
    n8nSessionCookie = setCookies.map((c) => c.split(";")[0]).join("; ");
  }

  if (!n8nSessionCookie) {
    throw new Error("n8n 로그인 성공했지만 세션 쿠키를 받지 못했습니다");
  }

  return n8nSessionCookie;
}

async function getN8nSession() {
  if (n8nSessionCookie) return n8nSessionCookie;
  return await n8nLogin();
}

// ==================== 워크플로우 ====================

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

async function pollExecutionStatus(workflowId, executionId) {
  const MAX_POLL = 120; // 최대 10분 (5초 간격 × 120회)
  const POLL_INTERVAL = 5000;

  for (let i = 0; i < MAX_POLL; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    try {
      const exec = await n8nApiRequest("GET", `/executions/${executionId}`);
      const status = exec?.status || exec?.data?.status;
      const finished = exec?.finished ?? exec?.data?.finished;

      if (status === "success" || finished === true) {
        sendLog(
          "system",
          `[시스템] 워크플로우 #${workflowId} 실행 완료 ✔ [execution: ${executionId}]`
        );
        return;
      }
      if (status === "error" || status === "crashed") {
        const errData = exec?.data?.resultData || {};
        const errMsg = errData.error?.message || "알 수 없는 에러";
        const lastNode = errData.lastNodeExecuted || "";
        const runData = errData.runData || {};
        // 실패한 노드의 상세 에러 수집
        const nodeErrors = [];
        for (const [nodeName, runs] of Object.entries(runData)) {
          for (const run of runs) {
            if (run.error) {
              const desc = run.error.description ? ` - ${run.error.description}` : "";
              nodeErrors.push(`[${nodeName}] ${run.error.message}${desc}`);
            }
          }
        }
        sendLog(
          "system",
          `[에러] 워크플로우 #${workflowId} 실행 실패 [execution: ${executionId}]`
        );
        sendLog("system", `  원인: ${errMsg}`);
        if (lastNode) sendLog("system", `  실패 노드: ${lastNode}`);
        for (const ne of nodeErrors) {
          sendLog("system", `  ${ne}`);
        }
        return;
      }
      // status = "running" / "waiting" / "new" → 계속 폴링
    } catch (err) {
      // 조회 실패해도 폴링 계속 (일시적 네트워크 오류 등)
      console.error(`Execution ${executionId} poll error:`, err.message);
    }
  }

  sendLog(
    "system",
    `[시스템] 워크플로우 #${workflowId} 실행 상태 추적 시간 초과 (10분) [execution: ${executionId}]`
  );
}

async function updateWorkflowVendors(id, vendors) {
  if (!vendors || vendors.length === 0) return;

  sendLog("system", `[시스템] 워크플로우 #${id} 협력사 필터 업데이트: ${vendors.join(", ")}`);

  const workflow = await n8nApiRequest("GET", `/workflows/${id}`);
  if (!workflow || !workflow.nodes) {
    throw new Error("워크플로우 데이터를 가져올 수 없습니다");
  }

  // completeVendorList가 포함된 Code 노드 찾기
  const codeNode = workflow.nodes.find(
    (n) =>
      (n.type === "n8n-nodes-base.code" || n.type === "n8n-nodes-base.function") &&
      n.parameters?.jsCode?.includes("completeVendorList")
  );

  if (!codeNode) {
    sendLog("system", `[시스템] completeVendorList Code 노드를 찾을 수 없어 필터 미적용`);
    return;
  }

  // completeVendorList 배열을 선택된 협력사로 교체
  const vendorArrayStr = JSON.stringify(vendors);
  const originalCode = codeNode.parameters.jsCode;
  const updatedCode = originalCode.replace(
    /const\s+completeVendorList\s*=\s*\[[\s\S]*?\];/,
    `const completeVendorList = ${vendorArrayStr};`
  );

  if (updatedCode === originalCode) {
    sendLog("system", `[시스템] completeVendorList 패턴 매칭 실패, 필터 미적용`);
    return;
  }

  codeNode.parameters.jsCode = updatedCode;

  // 워크플로우 저장 (PUT) - n8n API가 허용하는 필드만 전송
  const updateBody = {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings || {},
  };
  await n8nApiRequest("PUT", `/workflows/${id}`, updateBody);
  sendLog("system", `[시스템] 워크플로우 #${id} 협력사 필터 적용 완료`);
}

async function executeWorkflow(id, vendors) {
  sendLog("system", `[시스템] 워크플로우 #${id} 실행 시작...`);

  try {
    // 협력사 필터가 있으면 워크플로우 Code 노드 업데이트
    if (vendors && vendors.length > 0) {
      await updateWorkflowVendors(id, vendors);
    }

    // 방법 1: Public API 실행 엔드포인트 (n8n 최신 버전)
    try {
      const result = await n8nApiRequest("POST", `/workflows/${id}/execute`);
      const executionId = result?.data?.executionId || result?.executionId;
      sendLog(
        "system",
        `[시스템] 워크플로우 #${id} 실행됨 (Public API)${executionId ? ` [execution: ${executionId}]` : ""}`
      );
      if (executionId) {
        pollExecutionStatus(id, executionId).then(() => {
          sendWorkflowDone(id);
        }).catch(() => {
          sendWorkflowDone(id);
        });
      }
      return { success: true, executionId };
    } catch (pubErr) {
      // 404/405 = 엔드포인트 미지원 → Internal API로 fallback
      if (!pubErr.message.includes("404") && !pubErr.message.includes("405")) throw pubErr;
      sendLog("system", `[시스템] Public API 실행 미지원 → Internal API로 시도...`);
    }

    // 방법 2: Internal REST API (/rest/workflows/:id/run) - 세션 인증 필요
    const workflow = await n8nApiRequest("GET", `/workflows/${id}`);
    if (!workflow || !workflow.nodes) {
      throw new Error("워크플로우 데이터를 가져올 수 없습니다");
    }

    const triggerNodes = workflow.nodes
      .filter((n) => n.type.toLowerCase().includes("trigger"));

    if (triggerNodes.length === 0) {
      throw new Error("트리거 노드가 없는 워크플로우입니다. n8n에서 직접 실행해주세요.");
    }

    let cookie = await getN8nSession();
    const runPath = `/workflows/${id}/run`;

    // isFullExecutionFromKnownTrigger: workflowData + triggerToStartFrom (runData 없이!)
    const runBody = {
      workflowData: workflow,
      triggerToStartFrom: { name: triggerNodes[0].name },
    };

    let result;
    try {
      result = await n8nInternalRequest("POST", runPath, runBody, cookie);
    } catch (err) {
      if (err.message.includes("401")) {
        n8nSessionCookie = null;
        cookie = await n8nLogin();
        result = await n8nInternalRequest("POST", runPath, runBody, cookie);
      } else {
        throw err;
      }
    }

    const executionId = result.body?.data?.executionId;
    sendLog(
      "system",
      `[시스템] 워크플로우 #${id} 실행됨 (Internal API)${executionId ? ` [execution: ${executionId}]` : ""}`
    );
    if (executionId) {
      pollExecutionStatus(id, executionId).then(() => {
        sendWorkflowDone(id);
      }).catch(() => {
        sendWorkflowDone(id);
      });
    }
    return { success: true, executionId };
  } catch (error) {
    sendLog("system", `[에러] 워크플로우 실행 실패: ${error.message}`);
    return { success: false, error: error.message };
  }
}

function sendWorkflowDone(workflowId) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("workflow-done", { workflowId });
  }
}

function openWorkflowInEditor(id) {
  shell.openExternal(`http://localhost:5678/workflow/${id}`);
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
      else await startService(name);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("stop-service", async (_, name) => {
    try {
      if (name === "n8n") await stopN8n();
      else await stopService(name);
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
      } else {
        await restartService(name);
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
      // 로컬 전환 시 GRAPHQL_URL 체크
      if (envKey === "local") {
        const environments = loadEnvironments();
        const localUrl = environments.local?.GRAPHQL_URL || "";
        if (!localUrl) {
          sendLog("system", "[시스템] ⚠️ 로컬 GRAPHQL_URL이 설정되지 않았습니다. 설정에서 URL 입력 후 n8n을 재시작하세요.");
          const config = loadConfig();
          config.environment = envKey;
          saveConfig(config);
          return;
        }
      }
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
  ipcMain.handle("execute-workflow", (_, id, vendors) => executeWorkflow(id, vendors));
  ipcMain.handle("open-workflow", (_, id) => openWorkflowInEditor(id));

  // 설정
  ipcMain.handle("get-config", () => loadConfig());
  ipcMain.handle("save-config", (_, config) => {
    // graphqlUrl 입력 시 environments.json 로컬 항목 업데이트
    if (config.graphqlUrl) {
      const environments = loadEnvironments();
      let url = config.graphqlUrl.trim();
      if (url && !url.endsWith("/graphql/")) {
        url = url.replace(/\/+$/, "") + "/graphql/";
      }
      if (environments.local) {
        environments.local.GRAPHQL_URL = url;
        saveEnvironments(environments);
        sendLog("system", `[시스템] 로컬 GRAPHQL_URL 업데이트: ${url}`);
      }
    }
    const current = loadConfig();
    Object.assign(current, config);
    saveConfig(current);
    return { success: true };
  });

  // ==================== 셋업 관련 IPC ====================

  ipcMain.handle("check-setup", async () => {
    const prerequisites = await setup.checkPrerequisites();
    const projectReady = setup.isProjectSetUp(PROJECT_ROOT);
    const npmReady = projectReady && setup.isNpmInstalled(PROJECT_ROOT);
    return {
      isPackaged: IS_PACKAGED,
      prerequisites,
      projectReady,
      npmReady,
      projectRoot: PROJECT_ROOT,
      needsSetup: IS_PACKAGED && (!projectReady || !npmReady),
    };
  });

  ipcMain.handle("run-setup", async (_, options) => {
    try {
      const onProgress = (msg) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("setup-progress", msg);
        }
      };

      // 1. 프로젝트 클론
      if (!setup.isProjectSetUp(PROJECT_ROOT)) {
        onProgress("프로젝트 다운로드 중...");
        await setup.cloneProject(PROJECT_ROOT, GITHUB_REPO, onProgress);
      }

      // 2. npm install
      if (!setup.isNpmInstalled(PROJECT_ROOT)) {
        onProgress("의존성 설치 중 (npm install)...");
        await setup.npmInstall(PROJECT_ROOT, onProgress);
      }

      // 3. 기본 설정 파일 생성
      onProgress("설정 파일 생성 중...");
      setup.createDefaultConfigs(CONFIG_FILE, ENVIRONMENTS_FILE);

      onProgress("셋업 완료!");
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
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
    icon: path.join(LAUNCHER_ROOT, "assets", "icon.ico"),
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
