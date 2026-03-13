module.exports = {
  packagerConfig: {
    asar: true,
    name: "PojangbossLauncher",
    executableName: "PojangbossLauncher",
    icon: "./assets/icon",
    ignore: [
      /^\/\.git/,
      /^\/node_modules\/\.cache/,
    ],
  },
  rebuildConfig: {},
  makers: [
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
