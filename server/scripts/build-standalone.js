'use strict';
// Builds double-clickable, no-install admin server executables for Windows and Ubuntu.
// Node.js itself is bundled INSIDE the executable, so the machine that RUNS it needs
// nothing installed - not Node, not npm, nothing. (Building still needs Node/npm once,
// here, on the machine doing the build.)
//
// Output (in server/dist-standalone/):
//   ExamServer-win.exe             single-institute server  (double-click, edit settings.txt)
//   ExamServer-linux               single-institute server
//   ExamServerCentral-win.exe      multi-institute central server (edit central-settings.txt)
//   ExamServerCentral-linux        multi-institute central server
//
// After building, copy the matching .exe/binary PLUS the "config" folder (and, for the
// central build, nothing extra - institutes.json is created automatically) into one folder
// and hand that folder to the admin. See README "Run the server with no installation".

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist-standalone');
fs.mkdirSync(outDir, { recursive: true });

// pkg can only cross-compile to targets it has a prebuilt Node binary for; building a Windows
// .exe reliably needs to run ON Windows (or in CI on a windows-latest runner - see
// .github/workflows/build-client.yml, which does this). Default to just this machine's own
// OS; pass "--all" to attempt every target anyway.
const wantAll = process.argv.includes('--all');
const platformTarget = process.platform === 'win32' ? 'win-x64' : process.platform === 'darwin' ? 'macos-x64' : 'linux-x64';
const ALL = [
  { entry: 'server.js', outBase: 'ExamServer', node: 'node18-win-x64', ext: '.exe' },
  { entry: 'server.js', outBase: 'ExamServer', node: 'node18-linux-x64', ext: '' },
  { entry: 'server.js', outBase: 'ExamServer', node: 'node18-macos-x64', ext: '' },
  { entry: 'central.js', outBase: 'ExamServerCentral', node: 'node18-win-x64', ext: '.exe' },
  { entry: 'central.js', outBase: 'ExamServerCentral', node: 'node18-linux-x64', ext: '' },
  { entry: 'central.js', outBase: 'ExamServerCentral', node: 'node18-macos-x64', ext: '' },
];
const targets = (wantAll ? ALL : ALL.filter((t) => t.node.endsWith(platformTarget)))
  .map((t) => ({ ...t, outName: `${t.outBase}-${t.node.replace('node18-', '')}${t.ext}` }));

const pkgBin = require.resolve('@yao-pkg/pkg/lib-es5/bin.js', { paths: [root] });

for (const t of targets) {
  console.log(`\n==> Building ${t.outName}`);
  execFileSync(process.execPath, [pkgBin, t.entry, '--target', t.node, '--output', path.join(outDir, t.outName)], {
    cwd: root, stdio: 'inherit',
  });
}

// Seed the folder the admin will actually run things from: settings + starter config next to
// the executables, so double-clicking works immediately with something sane to edit.
fs.mkdirSync(path.join(outDir, 'config'), { recursive: true });
fs.copyFileSync(path.join(root, 'settings.txt'), path.join(outDir, 'settings.txt'));
if (fs.existsSync(path.join(root, 'config', 'exams.json'))) {
  fs.copyFileSync(path.join(root, 'config', 'exams.json'), path.join(outDir, 'config', 'exams.json'));
}
fs.writeFileSync(path.join(outDir, 'central-settings.txt'), [
  '# Central server settings (multi-institute mode). Edit with Notepad, then restart.',
  '# Login for the platform-admin page at /super/ where you create each institute.',
  'SUPER_ADMIN_PASSWORD=change-me-please',
  'SUPER_ADMIN_USER=super',
  'PORT=8443',
].join('\n') + '\n');

console.log(`\nDone. Files are in: ${outDir}`);
console.log('Copy that whole folder to the server machine and double-click ExamServer(.exe)');
console.log('or ExamServerCentral(.exe) - see README "Run the server with no installation".');
