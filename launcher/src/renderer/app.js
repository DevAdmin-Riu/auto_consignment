// ==================== 상태 관리 ====================

let currentLogTab = "all";
let logs = []; // { source, message }
const MAX_LOGS = 500;
let wfConfigItems = []; // 설정 모달에서 사용하는 워크플로우 목록 (임시)

// ==================== 초기화 ====================

document.addEventListener("DOMContentLoaded", async () => {
  await initEnvironmentSelect();
  await refreshStatus();
  await loadWorkflows();
  setupEventListeners();
  startStatusPolling();
  setupLogListener();
});

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

// ==================== 워크플로우 ====================

async function loadWorkflows() {
  const list = document.getElementById("workflow-list");

  try {
    const workflows = await window.api.getWorkflows();
    const config = await window.api.getConfig();
    const visible = config.visibleWorkflows || [];

    if (!workflows || workflows.length === 0) {
      list.innerHTML =
        '<div class="placeholder">워크플로우가 없거나 API 키가 설정되지 않았습니다</div>';
      return;
    }

    // visibleWorkflows 설정이 있으면 필터링 + 번호 매기기
    let displayList;
    if (visible.length > 0) {
      displayList = visible
        .map((v, idx) => {
          const wf = workflows.find((w) => w.id === v.id);
          if (!wf) return null;
          return { ...wf, order: idx + 1, description: v.description || "" };
        })
        .filter(Boolean);
    } else {
      // 설정 없으면 전체 표시 (번호 없음)
      displayList = workflows.map((wf) => ({ ...wf, order: 0, description: "" }));
    }

    if (displayList.length === 0) {
      list.innerHTML = '<div class="placeholder">표시할 워크플로우가 없습니다</div>';
      return;
    }

    list.innerHTML = "";
    for (const wf of displayList) {
      const card = document.createElement("div");
      card.className = "workflow-card";
      const orderHtml = wf.order > 0 ? `<span class="wf-order">${wf.order}.</span>` : "";
      const descHtml = wf.description ? `<div class="wf-desc">${wf.description}</div>` : "";
      card.innerHTML = `
        <div class="workflow-card-header">
          <span class="wf-status ${wf.active ? "active" : ""}"></span>
          ${orderHtml}
          <span class="wf-name" data-wf-open="${wf.id}" title="n8n에서 열기">${wf.name}</span>
        </div>
        ${descHtml}
        <button class="btn btn-sm btn-start" data-wf-id="${wf.id}">실행</button>
      `;
      list.appendChild(card);
    }
  } catch (e) {
    list.innerHTML = `<div class="placeholder">워크플로우 로드 실패: ${e.message}</div>`;
  }
}

// ==================== 워크플로우 설정 (모달) ====================

async function loadWfConfig() {
  const config = await window.api.getConfig();
  const visible = config.visibleWorkflows || [];
  try {
    const allWfs = await window.api.getWorkflows();
    if (!allWfs || allWfs.length === 0) {
      wfConfigItems = [];
      renderWfConfig();
      return;
    }
    // 선택된 것 먼저 (순서 유지), 나머지는 뒤에
    const checkedIds = visible.map((v) => v.id);
    const checked = visible
      .map((v) => {
        const wf = allWfs.find((w) => w.id === v.id);
        if (!wf) return null;
        return { id: wf.id, name: wf.name, checked: true, description: v.description || "" };
      })
      .filter(Boolean);
    const unchecked = allWfs
      .filter((wf) => !checkedIds.includes(wf.id))
      .map((wf) => ({ id: wf.id, name: wf.name, checked: false, description: "" }));
    wfConfigItems = [...checked, ...unchecked];
  } catch (e) {
    wfConfigItems = [];
  }
  renderWfConfig();
}

function renderWfConfig() {
  const container = document.getElementById("wf-config-list");
  if (wfConfigItems.length === 0) {
    container.innerHTML = '<div class="placeholder">n8n에서 불러오기를 클릭하세요</div>';
    return;
  }

  container.innerHTML = "";
  let orderNum = 1;

  wfConfigItems.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = `wf-config-item${item.checked ? " checked" : ""}`;

    const orderLabel = item.checked ? `${orderNum}` : "-";
    if (item.checked) orderNum++;

    row.innerHTML = `
      <input type="checkbox" data-wf-cfg-idx="${idx}" ${item.checked ? "checked" : ""}>
      <span class="wf-config-order">${orderLabel}</span>
      <span class="wf-config-name">${item.name}</span>
      <input type="text" class="wf-config-desc" data-wf-desc-idx="${idx}" value="${item.description}" placeholder="설명">
      <div class="wf-config-arrows">
        <button data-wf-move="up" data-wf-idx="${idx}">&uarr;</button>
        <button data-wf-move="down" data-wf-idx="${idx}">&darr;</button>
      </div>
    `;
    container.appendChild(row);
  });
}

function getVisibleWorkflowsFromConfig() {
  return wfConfigItems
    .filter((item) => item.checked)
    .map((item) => ({ id: item.id, description: item.description }));
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

  // n8n 열기
  document.getElementById("btn-open-n8n").addEventListener("click", () => {
    window.api.openN8n();
  });

  // 워크플로우 새로고침
  document.getElementById("btn-refresh-workflows").addEventListener("click", loadWorkflows);

  // 워크플로우 이름 클릭 → n8n 에디터에서 열기
  document.getElementById("workflow-list").addEventListener("click", (e) => {
    const nameEl = e.target.closest("[data-wf-open]");
    if (nameEl) {
      window.api.openWorkflow(nameEl.dataset.wfOpen);
      return;
    }
  });

  // 워크플로우 실행 (이벤트 위임)
  document.getElementById("workflow-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-wf-id]");
    if (!btn || btn.disabled) return;

    const id = btn.dataset.wfId;
    btn.disabled = true;
    btn.textContent = "실행 중...";

    try {
      const result = await window.api.executeWorkflow(id);
      if (!result.success) {
        alert(`실행 실패: ${result.error}`);
      }
    } catch (e) {
      alert(`실행 실패: ${e.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "실행";
    }
  });

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
    document.getElementById("settings-modal").style.display = "flex";
    await loadWfConfig();
  });

  document.getElementById("btn-close-settings").addEventListener("click", () => {
    document.getElementById("settings-modal").style.display = "none";
  });

  // n8n에서 불러오기 버튼
  document.getElementById("btn-load-workflows").addEventListener("click", async () => {
    const btn = document.getElementById("btn-load-workflows");
    btn.disabled = true;
    btn.textContent = "불러오는 중...";
    await loadWfConfig();
    btn.disabled = false;
    btn.textContent = "n8n에서 불러오기";
  });

  // 워크플로우 설정 리스트 이벤트 위임 (체크박스, 설명, 화살표)
  document.getElementById("wf-config-list").addEventListener("change", (e) => {
    const chk = e.target.closest("[data-wf-cfg-idx]");
    if (chk && chk.type === "checkbox") {
      const idx = parseInt(chk.dataset.wfCfgIdx);
      wfConfigItems[idx].checked = chk.checked;
      // 체크된 것 위로, 안된 것 아래로 재정렬
      const checked = wfConfigItems.filter((i) => i.checked);
      const unchecked = wfConfigItems.filter((i) => !i.checked);
      wfConfigItems = [...checked, ...unchecked];
      renderWfConfig();
      return;
    }
    const desc = e.target.closest("[data-wf-desc-idx]");
    if (desc) {
      const idx = parseInt(desc.dataset.wfDescIdx);
      wfConfigItems[idx].description = desc.value;
    }
  });

  document.getElementById("wf-config-list").addEventListener("input", (e) => {
    const desc = e.target.closest("[data-wf-desc-idx]");
    if (desc) {
      const idx = parseInt(desc.dataset.wfDescIdx);
      wfConfigItems[idx].description = desc.value;
    }
  });

  document.getElementById("wf-config-list").addEventListener("click", (e) => {
    const moveBtn = e.target.closest("[data-wf-move]");
    if (!moveBtn) return;
    const idx = parseInt(moveBtn.dataset.wfIdx);
    const direction = moveBtn.dataset.wfMove;
    // 체크된 항목끼리만 이동 가능
    if (!wfConfigItems[idx].checked) return;
    const checkedCount = wfConfigItems.filter((i) => i.checked).length;
    if (direction === "up" && idx > 0 && wfConfigItems[idx - 1].checked) {
      [wfConfigItems[idx], wfConfigItems[idx - 1]] = [wfConfigItems[idx - 1], wfConfigItems[idx]];
      renderWfConfig();
    } else if (direction === "down" && idx < checkedCount - 1 && wfConfigItems[idx + 1].checked) {
      [wfConfigItems[idx], wfConfigItems[idx + 1]] = [wfConfigItems[idx + 1], wfConfigItems[idx]];
      renderWfConfig();
    }
  });

  document.getElementById("btn-save-settings").addEventListener("click", async () => {
    const apiKey = document.getElementById("input-api-key").value.trim();
    const email = document.getElementById("input-n8n-email").value.trim();
    const password = document.getElementById("input-n8n-password").value;
    const visibleWorkflows = getVisibleWorkflowsFromConfig();
    await window.api.saveConfig({
      n8nApiKey: apiKey,
      n8nEmail: email,
      n8nPassword: password,
      visibleWorkflows,
    });
    document.getElementById("settings-modal").style.display = "none";
    await loadWorkflows();
  });

  // 모달 바깥 클릭으로 닫기
  document.getElementById("settings-modal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.style.display = "none";
    }
  });
}
