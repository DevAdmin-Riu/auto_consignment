// ==================== 상태 관리 ====================

let currentLogTab = "all";
let logs = []; // { source, message }
const MAX_LOGS = 500;

// ==================== 초기화 ====================

document.addEventListener("DOMContentLoaded", async () => {
  // 패키징 모드 셋업 체크
  try {
    const setupInfo = await window.api.checkSetup();
    if (setupInfo.needsSetup) {
      showSetupWizard(setupInfo);
      return; // 셋업 완료 후 앱 초기화
    }
  } catch (e) {
    // checkSetup 실패 시 (개발 모드 등) 무시하고 진행
    console.log("Setup check skipped:", e.message);
  }

  initApp();
});

function initApp() {
  initEnvironmentSelect();
  refreshStatus();
  setupEventListeners();
  startStatusPolling();
  setupLogListener();
}

// ==================== 셋업 위자드 ====================

async function showSetupWizard(setupInfo) {
  const wizard = document.getElementById("setup-wizard");
  const mainApp = document.getElementById("main-app");
  wizard.style.display = "flex";
  mainApp.style.display = "none";

  await runPrerequisiteCheck(setupInfo.prerequisites);
}

async function runPrerequisiteCheck(prerequisites) {
  const PREREQ_NAMES = { git: "Git", node: "Node.js", npm: "npm", docker: "Docker" };
  const PREREQ_URLS = {
    git: "https://git-scm.com/downloads",
    node: "https://nodejs.org/ (LTS)",
    docker: "https://www.docker.com/products/docker-desktop",
  };

  let allOk = true;
  const missing = [];

  for (const [key, ok] of Object.entries(prerequisites)) {
    const el = document.getElementById(`check-${key}`);
    if (!el) continue;
    const icon = el.querySelector(".setup-icon");
    if (ok) {
      icon.textContent = "\u2705";
      el.classList.add("ok");
    } else {
      icon.textContent = "\u274C";
      el.classList.add("fail");
      allOk = false;
      if (PREREQ_URLS[key]) {
        missing.push(`${PREREQ_NAMES[key]}: ${PREREQ_URLS[key]}`);
      }
    }
  }

  if (!allOk) {
    const missingDiv = document.getElementById("setup-missing");
    const missingList = document.getElementById("setup-missing-list");
    missingDiv.style.display = "block";
    missingList.innerHTML = missing.map((m) => `<li>${m}</li>`).join("");

    document.getElementById("btn-setup-recheck").addEventListener("click", async () => {
      // 리체크
      const info = await window.api.checkSetup();
      // 리셋 UI
      for (const key of Object.keys(info.prerequisites)) {
        const el = document.getElementById(`check-${key}`);
        if (el) {
          el.classList.remove("ok", "fail");
          el.querySelector(".setup-icon").textContent = "\u23F3";
        }
      }
      document.getElementById("setup-missing").style.display = "none";
      await runPrerequisiteCheck(info.prerequisites);
    });
  } else {
    // 모든 필수 프로그램 설치됨 → 설치 시작 버튼
    document.getElementById("setup-ready").style.display = "block";

    document.getElementById("btn-run-setup").addEventListener("click", async () => {
      document.getElementById("setup-ready").style.display = "none";
      await runSetup();
    });
  }
}

async function runSetup() {
  const progressDiv = document.getElementById("setup-progress");
  const progressText = document.getElementById("setup-progress-text");
  const progressFill = document.getElementById("setup-progress-fill");
  progressDiv.style.display = "block";

  // 진행 상황 수신
  let step = 0;
  const totalSteps = 3; // clone, npm install, config
  window.api.onSetupProgress((msg) => {
    progressText.textContent = msg;
    if (msg.includes("clone") || msg.includes("다운로드")) {
      step = 1;
    } else if (msg.includes("npm") || msg.includes("의존성")) {
      step = 2;
    } else if (msg.includes("설정") || msg.includes("완료")) {
      step = 3;
    }
    progressFill.style.width = `${Math.min((step / totalSteps) * 100, 100)}%`;
  });

  try {
    const result = await window.api.runSetup({});
    progressDiv.style.display = "none";

    if (result.success) {
      document.getElementById("setup-done").style.display = "block";
      document.getElementById("btn-setup-finish").addEventListener("click", () => {
        document.getElementById("setup-wizard").style.display = "none";
        document.getElementById("main-app").style.display = "flex";
        initApp();
      });
    } else {
      document.getElementById("setup-error").style.display = "block";
      document.getElementById("setup-error-text").textContent = result.error;
      document.getElementById("btn-setup-retry").addEventListener("click", async () => {
        document.getElementById("setup-error").style.display = "none";
        await runSetup();
      });
    }
  } catch (err) {
    progressDiv.style.display = "none";
    document.getElementById("setup-error").style.display = "block";
    document.getElementById("setup-error-text").textContent = err.message;
    document.getElementById("btn-setup-retry").addEventListener("click", async () => {
      document.getElementById("setup-error").style.display = "none";
      await runSetup();
    });
  }
}

// ==================== 환경 선택 ====================

async function initEnvironmentSelect() {
  const select = document.getElementById("env-select");
  const environments = await window.api.getEnvironments();
  const currentEnv = await window.api.getEnvironment();

  select.innerHTML = "";
  for (const env of environments) {
    const option = document.createElement("option");
    option.value = env.key;
    option.textContent = env.label;
    if (env.key === currentEnv) option.selected = true;
    select.appendChild(option);
  }
}

// ==================== 서비스 상태 ====================

async function refreshStatus() {
  try {
    const status = await window.api.getStatus();
    updateStatusDot("n8n", status.n8n);
    updateStatusDot("order", status.order);
    updateStatusDot("tracking", status.tracking);
  } catch (e) {
    console.error("상태 조회 실패:", e);
  }
}

function updateStatusDot(service, status) {
  const dot = document.getElementById(`status-${service}`);
  if (dot) {
    dot.className = `status-dot ${status}`;
  }
  // 카드 border도 상태에 따라 변경
  const card = document.querySelector(`.service-card[data-service="${service}"]`);
  if (card) {
    card.classList.remove("service-running", "service-stopped");
    if (status === "running") card.classList.add("service-running");
    else if (status === "stopped") card.classList.add("service-stopped");
  }
}

function startStatusPolling() {
  setInterval(refreshStatus, 5000);
}

// ==================== 로그 ====================

function setupLogListener() {
  window.api.onLog((data) => {
    logs.push(data);
    if (logs.length > MAX_LOGS) {
      logs = logs.slice(-MAX_LOGS);
    }
    renderLogLine(data);
  });
}

function renderLogLine(data) {
  if (currentLogTab !== "all" && data.source !== currentLogTab) return;

  const container = document.getElementById("log-container");
  const line = document.createElement("div");
  line.className = `log-line source-${data.source}`;

  const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
  line.textContent = `[${time}] ${data.message}`;

  container.appendChild(line);

  // 최대 줄 수 유지
  while (container.children.length > MAX_LOGS) {
    container.removeChild(container.firstChild);
  }

  // 자동 스크롤 (하단 근처에 있을 때만)
  const isNearBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 100;
  if (isNearBottom) {
    container.scrollTop = container.scrollHeight;
  }
}

function renderAllLogs() {
  const container = document.getElementById("log-container");
  container.innerHTML = "";

  const filtered =
    currentLogTab === "all"
      ? logs
      : logs.filter((l) => l.source === currentLogTab);

  for (const data of filtered) {
    const line = document.createElement("div");
    line.className = `log-line source-${data.source}`;
    const time = new Date().toLocaleTimeString("ko-KR", { hour12: false });
    line.textContent = `[${time}] ${data.message}`;
    container.appendChild(line);
  }

  container.scrollTop = container.scrollHeight;
}

// ==================== 이벤트 리스너 ====================

function setupEventListeners() {
  // 전체 시작
  document.getElementById("btn-start-all").addEventListener("click", async function () {
    this.disabled = true;
    this.textContent = "시작 중...";
    try {
      await window.api.startAll();
    } catch (e) {
      console.error(e);
    } finally {
      this.disabled = false;
      this.innerHTML = "&#9654; 전체 시작";
      refreshStatus();
    }
  });

  // 전체 중지
  document.getElementById("btn-stop-all").addEventListener("click", async function () {
    this.disabled = true;
    this.textContent = "중지 중...";
    try {
      await window.api.stopAll();
    } catch (e) {
      console.error(e);
    } finally {
      this.disabled = false;
      this.innerHTML = "&#9632; 전체 중지";
      refreshStatus();
    }
  });

  // 개별 서비스 버튼
  document.querySelectorAll(".service-actions .btn").forEach((btn) => {
    btn.addEventListener("click", async function () {
      const action = this.dataset.action;
      const service = this.dataset.service;
      const originalText = this.textContent;

      this.disabled = true;
      this.textContent = "...";

      try {
        if (action === "start") await window.api.startService(service);
        else if (action === "stop") await window.api.stopService(service);
        else if (action === "restart") await window.api.restartService(service);
      } catch (e) {
        console.error(e);
      } finally {
        this.disabled = false;
        this.textContent = originalText;
        refreshStatus();
      }
    });
  });

  // 환경 전환
  document.getElementById("env-select").addEventListener("change", async function () {
    const envKey = this.value;
    const confirmed = confirm(
      `환경을 변경하시겠습니까?\nn8n이 실행 중이면 자동으로 재시작됩니다.`
    );

    if (!confirmed) {
      // 원래 값으로 되돌리기
      const currentEnv = await window.api.getEnvironment();
      this.value = currentEnv;
      return;
    }

    this.disabled = true;
    try {
      await window.api.switchEnvironment(envKey);
    } catch (e) {
      console.error(e);
    } finally {
      this.disabled = false;
      refreshStatus();
    }
  });

  // n8n 열기 (버튼이 있는 경우에만)
  const btnOpenN8n = document.getElementById("btn-open-n8n");
  if (btnOpenN8n) {
    btnOpenN8n.addEventListener("click", () => {
      window.api.openN8n();
    });
  }

  // 로그 탭
  document.querySelectorAll(".log-tab").forEach((tab) => {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".log-tab").forEach((t) => t.classList.remove("active"));
      this.classList.add("active");
      currentLogTab = this.dataset.tab;
      renderAllLogs();
    });
  });

  // 로그 지우기
  document.getElementById("btn-clear-logs").addEventListener("click", () => {
    logs = [];
    document.getElementById("log-container").innerHTML = "";
  });

  // 설정 모달
  document.getElementById("btn-settings").addEventListener("click", async () => {
    const config = await window.api.getConfig();
    document.getElementById("input-api-key").value = config.n8nApiKey || "";
    document.getElementById("input-n8n-email").value = config.n8nEmail || "";
    document.getElementById("input-n8n-password").value = config.n8nPassword || "";
    document.getElementById("input-po-email").value = config.poEmail || "";
    document.getElementById("input-smtp-password").value = config.smtpPassword || "";
    document.getElementById("input-graphql-url").value = config.graphqlUrl || "";
    // 결제 카드 라디오 버튼
    const cardType = config.paymentCardType || "shinhan";
    document.querySelectorAll('input[name="paymentCardType"]').forEach(r => {
      r.checked = r.value === cardType;
    });
    document.getElementById("settings-modal").style.display = "flex";
  });

  document.getElementById("btn-close-settings").addEventListener("click", () => {
    document.getElementById("settings-modal").style.display = "none";
  });

  document.getElementById("btn-save-settings").addEventListener("click", async () => {
    const apiKey = document.getElementById("input-api-key").value.trim();
    const email = document.getElementById("input-n8n-email").value.trim();
    const password = document.getElementById("input-n8n-password").value;
    const poEmail = document.getElementById("input-po-email").value.trim();
    const smtpPassword = document.getElementById("input-smtp-password").value;
    const graphqlUrl = document.getElementById("input-graphql-url").value.trim();
    const paymentCardType = document.querySelector('input[name="paymentCardType"]:checked')?.value || "shinhan";
    await window.api.saveConfig({
      n8nApiKey: apiKey,
      n8nEmail: email,
      n8nPassword: password,
      poEmail: poEmail,
      smtpPassword: smtpPassword,
      graphqlUrl: graphqlUrl,
      paymentCardType,
    });
    document.getElementById("settings-modal").style.display = "none";
  });

  // 모달 바깥 클릭으로 닫기
  document.getElementById("settings-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.style.display = "none";
    }
  });
}

