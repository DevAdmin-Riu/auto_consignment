module.exports = {
  packagerConfig: {
    asar: true,
    name: "포장보스 자동화 관리자",
    icon: "./assets/icon", // .ico (Windows), .icns (macOS), .png (Linux)
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      config: {},
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["win32"],
    },
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
  ],
};
