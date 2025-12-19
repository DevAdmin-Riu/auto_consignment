/**
 * PM2 Ecosystem 설정
 *
 * 두 개의 독립 프로세스:
 * - order: 발주 서버 (포트 3000)
 * - tracking: 송장조회 서버 (포트 3001)
 */

module.exports = {
  apps: [
    {
      name: "order",
      script: "server.js",
      env: {
        PORT: 3000,
        NODE_ENV: "production",
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
    },
    {
      name: "tracking",
      script: "tracking-server.js",
      env: {
        TRACKING_PORT: 3001,
        NODE_ENV: "production",
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
    },
  ],
};
