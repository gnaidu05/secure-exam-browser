'use strict';
// electron-builder hook: flip Electron "fuses" in the packaged binary so students
// cannot re-use it as a Node runtime or attach an inspector.
//   - RunAsNode off                       (ELECTRON_RUN_AS_NODE=1 does nothing)
//   - NODE_OPTIONS env var ignored
//   - --inspect / --inspect-brk ignored
//   - App loads only from the signed-in asar
const path = require('path');

exports.default = async function afterPack(context) {
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  const { appOutDir, electronPlatformName, packager } = context;

  let binary;
  if (electronPlatformName === 'win32') binary = path.join(appOutDir, `${packager.appInfo.productFilename}.exe`);
  else if (electronPlatformName === 'darwin') binary = path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'MacOS', packager.appInfo.productFilename);
  else binary = path.join(appOutDir, packager.executableName);

  await flipFuses(binary, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  console.log(`  • fuses flipped on ${path.basename(binary)}`);
};
