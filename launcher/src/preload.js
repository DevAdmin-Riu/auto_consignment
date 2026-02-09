const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // 서비스 상태
  getStatus: () => ipcRenderer.invoke("get-status"),

  // 전체 시작/중지
  startAll: () => ipcRenderer.invoke("start-all"),
  stopAll: () => ipcRenderer.invoke("stop-all"),

  // 개별 서비스 제어
  startService: (name) => ipcRenderer.invoke("start-service", name),
  stopService: (name) => ipcRenderer.invoke("stop-service", name),
  restartService: (name) => ipcRenderer.invoke("restart-service", name),

  // 환경 전환
  getEnvironment: () => ipcRenderer.invoke("get-environment"),
  getEnvironments: () => ipcRenderer.invoke("get-environments"),
  switchEnvironment: (env) => ipcRenderer.invoke("switch-environment", env),

  // n8n 열기
  openN8n: () => ipcRenderer.invoke("open-n8n"),

  // 워크플로우
  getWorkflows: () => ipcRenderer.invoke("get-workflows"),
  executeWorkflow: (id) => ipcRenderer.invoke("execute-workflow", id),
  openWorkflow: (id) => ipcRenderer.invoke("open-workflow", id),

  // 설정
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (config) => ipcRenderer.invoke("save-config", config),

  // 로그 수신
  onLog: (callback) => {
    ipcRenderer.on("log", (_, data) => callback(data));
  },
});
