'use strict';
// Builds a single-file, double-clickable executable using Node's built-in "Single Executable
// Application" feature. Unlike pkg, this needs NOTHING downloaded from the internet - it bundles
// the app with esbuild, then injects it into a COPY of the Node binary already on this machine.
// That also means the result only runs on the OS/architecture of the machine that builds it:
// build on Ubuntu -> a Linux executable; build on Windows -> a Windows .exe. There is no
// cross-building. To get a Windows .exe, run this same command on a Windows PC (with Node.js
// installed) or via the GitHub Actions workflow on a windows-latest runner.

const { execFileSync } = require('child_process');
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist-standalone');
fs.mkdirSync(outDir, { recursive: true });

const entry = process.argv[2] === 'central' ? 'central.js' : 'server.js';
const label = entry === 'central.js' ? 'ExamServerCentral' : 'ExamServer';
const isWin = process.platform === 'win32';
const exeName = label + (isWin ? '.exe' : process.platform === 'darwin' ? '-mac' : '-linux');

console.log(`==> Bundling ${entry}`);
esbuild.buildSync({
  entryPoints: [path.join(root, entry)],
  bundle: true,
  platform: 'node',
  target: 'node20',
  outfile: path.join(outDir, 'bundle.js'),
  legalComments: 'none',
  // Loaded lazily via process.pkg check; SEA has no equivalent flag, so make sure any
  // "process.pkg ? ... : ..." branches still resolve sensibly (they do: process.pkg stays
  // undefined under SEA too, so paths fall back to being relative to the executable via
  // require('node:sea') below instead - see server.js / central.js baseDir logic).
});

console.log('==> Writing SEA config');
const seaConfigPath = path.join(outDir, 'sea-config.json');
const blobPath = path.join(outDir, 'sea-prep.blob');
fs.writeFileSync(seaConfigPath, JSON.stringify({
  main: path.join(outDir, 'bundle.js'),
  output: blobPath,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
}, null, 2));

execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });

console.log('==> Injecting into a copy of the Node binary');
const outExe = path.join(outDir, exeName);
fs.copyFileSync(process.execPath, outExe);
fs.chmodSync(outExe, 0o755);

const postjectBin = require.resolve('postject/dist/cli.js', { paths: [root] });
const args = [postjectBin, outExe, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
execFileSync(process.execPath, args, { stdio: 'inherit' });

fs.rmSync(path.join(outDir, 'bundle.js'), { force: true });
fs.rmSync(blobPath, { force: true });
fs.rmSync(seaConfigPath, { force: true });

// Seed the folder the admin will actually run things from.
fs.mkdirSync(path.join(outDir, 'config'), { recursive: true });
const settingsSrc = entry === 'central.js' ? 'central-settings-template.txt' : 'settings.txt';
if (entry !== 'central.js' && fs.existsSync(path.join(root, 'settings.txt'))) {
  fs.copyFileSync(path.join(root, 'settings.txt'), path.join(outDir, 'settings.txt'));
}
if (entry === 'central.js') {
  fs.writeFileSync(path.join(outDir, 'central-settings.txt'), [
    '# Central server settings (multi-institute mode). Edit with Notepad, then restart.',
    'SUPER_ADMIN_PASSWORD=change-me-please',
    'SUPER_ADMIN_USER=super',
    'PORT=8443',
  ].join('\n') + '\n');
}
if (entry !== 'central.js' && fs.existsSync(path.join(root, 'config', 'exams.json'))) {
  fs.copyFileSync(path.join(root, 'config', 'exams.json'), path.join(outDir, 'config', 'exams.json'));
}

// The dashboard UI is plain static files read from disk next to the executable (esbuild can't
// usefully "bundle" HTML/CSS into the single-file blob), so copy them alongside it.
fs.cpSync(path.join(root, 'public'), path.join(outDir, 'public'), { recursive: true });
if (entry === 'central.js') fs.cpSync(path.join(root, 'public-super'), path.join(outDir, 'public-super'), { recursive: true });

console.log(`\nDone: ${outExe}`);
console.log('Copy the whole dist-standalone folder to the server machine and double-click it.');
