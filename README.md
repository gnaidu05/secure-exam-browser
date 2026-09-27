# Secure Exam Browser

A locked-down kiosk browser for proctored online exams, plus the admin server it reports to.

* **Only whitelisted domains and ports load.** Everything else is blocked (including `file:`, `ftp:`, `view-source:`, extensions).
* **No plugins or extensions**: it is Chromium (Electron) with extensions never enabled, no DevTools, no address bar, no new windows, no downloads, no printing.
* **Violations are reported automatically** to the admin server with a **full-screen screenshot of every display**, an exam-window capture, session details and a recent-event log. The admin sees them live on a dashboard and can end a session remotely.
* **Runs on Windows and Ubuntu** from one codebase (Electron).

```
 Student PC (Windows / Ubuntu)                       Admin server (Node)
┌───────────────────────────────┐   HTTPS        ┌────────────────────────────────┐
│ Secure Exam Browser           │ ─────────────▶ │ POST /api/session/start        │
│  • fetches SIGNED policy      │ ◀───────────── │   returns whitelist, signed    │
│  • enforces whitelist         │                │ POST /api/alerts (+screenshots)│
│  • watches focus / keys /     │ ─────────────▶ │ heartbeat, remote terminate    │
│    displays / processes       │                │ /admin  live dashboard, CSV    │
└───────────────────────────────┘                └────────────────────────────────┘
```

## What counts as malpractice (all report + screenshot unless noted)

| Trigger | Report type | Severity |
|---|---|---|
| Navigation, redirect or iframe to a non-whitelisted **domain** | `BLOCKED_DOMAIN` | medium |
| Whitelisted domain on a non-whitelisted **port** (or wrong scheme) | `BLOCKED_PORT` | medium |
| `window.open` / `target=_blank` to a blocked site (whitelisted ones open in place) | `POPUP_BLOCKED` | medium |
| Download attempt | `DOWNLOAD_BLOCKED` | medium |
| Window loses focus (Alt+Tab, other app), minimized | `FOCUS_LOST` / `MINIMIZED` (+ `FOCUS_RESTORED`, no screenshot) | high |
| Leaves fullscreen | `FULLSCREEN_EXIT` | high |
| Print Screen key | `PRINTSCREEN` | high |
| F12, Ctrl+Shift+I/J/C, Cmd+Opt+I | `DEVTOOLS_ATTEMPT` | high |
| Ctrl/Cmd + C/X/V, Ctrl+Insert, Shift+Insert (unless `allowClipboard`) | `CLIPBOARD_ATTEMPT` | medium |
| Ctrl+U/S/P/N/T/W…, Alt+Tab, Alt+F4, F11 | `SHORTCUT_BLOCKED` | low |
| Windows/Super key, close window | `WINDOWS_KEY`, `CLOSE_ATTEMPT` | medium |
| Extra monitor connected | `MULTI_MONITOR` | high |
| Screen-share / remote-desktop / recorder process running (list is configurable) | `BLOCKED_PROCESS` | high |
| Client stops sending heartbeats (network cut, app killed) | `CONNECTION_LOST` (server-side, no screenshot) | high |
| Same student signs in again elsewhere | `DUPLICATE_LOGIN` | medium |

Blocked *sub-resources* (an ad, a font from a CDN) are blocked and logged but **not** alerted, so ordinary pages do not cause false alarms. Set `strictSubresources: true` to alert on those too.

Every alert includes: student ID/name, exam, hostname, OS user, OS, IP and MAC addresses, display layout, current URL, focus state, app version, the last 40 events, and screenshots. Alerts are written to a disk outbox first and retried until delivered, so a network blip does not lose evidence.

## Run the server with no installation (recommended for non-technical admins)

You do **not** need to know Node.js, npm, or the command line to run the admin server day-to-day.
Someone technical builds it **once** into a plain double-clickable program; after that, running it
is: double-click, edit a text file, open a dashboard link.

**One-time build** (needs Node.js 18+ and normal internet access, on any OS):
```bash
cd server
npm install
npm run build:standalone
```
This creates `server/dist-standalone/` containing:
- `ExamServer-<platform>` (or `.exe` on Windows) — one institute, one server. This is what most
  people want.
- `ExamServerCentral-<platform>` — the multi-institute version (see next section).
- `settings.txt`, `config/exams.json` — plain-text files to edit, pre-filled with working defaults.

It only builds for the OS it runs on (cross-building a `.exe` from Linux/macOS needs a prebuilt
Node binary that isn't always available; build on Windows for the `.exe`, or let the included
GitHub Actions workflow build it in the cloud with a click — no local install needed either way).

**Every day after that**, the admin:
1. Copies the `dist-standalone` folder to the server machine (or just keeps it there).
2. Opens `settings.txt` in Notepad, sets a real password, saves.
3. Opens `config/exams.json` in Notepad, sets the exam code / allowed websites / duration, saves.
4. Double-clicks `ExamServer` (or `ExamServer.exe`). A window opens and prints the dashboard link,
   login, and the file to hand to whoever installs the student browsers — see the printed banner.
5. Opens that dashboard link in a browser to watch the exam live.

No Node, no npm, no terminal, ever, on the machine actually running the exam.

## Central server for multiple institutes

If **one server should serve several institutes** (a university running it for each department, a
company hosting it for several client schools), run `central.js` / `ExamServerCentral` instead of
`server.js`. One running process, one URL — each institute gets its **own** signing key, its own
exam list, its own dashboard login, and its own sessions/alerts, fully separated from every other
institute on the same server.

```bash
cd server && npm install
SUPER_ADMIN_PASSWORD=choose-one npm run central   # or double-click ExamServerCentral(.exe)
```

1. Open the printed platform-admin link (`.../super/`) and log in with the super-admin password.
2. Fill in an institute's name and click **Create institute**. You instantly get:
   - that institute's dashboard link (`.../i/<code>/admin/`) and its own login — give these to
     that institute's exam admin;
   - a **Download key** button — give that file to whoever builds *that institute's* exam browser
     installer (each institute's students get a browser signed with a different key, so one
     institute's server can never issue policies for another's).
3. Repeat per institute. Reset a forgotten password or disable an institute (e.g. a lapsed
   contract) from the same page, any time — no restart needed.

Institutes are added and managed live; you never edit a config file or restart the server to add
one. `central-settings.txt` only holds the platform-wide super-admin password, port and HTTPS
certificate.

## Quick start (development)

Requires Node 20+ (tested on 22).

```bash
./scripts/dev-setup.sh                                  # installs both, creates the signing key, copies the public key to the client
cd server && ADMIN_PASSWORD=choose-one npm start        # dashboard: http://localhost:8443/admin/  (user: admin)
cd client && npm run dev                                # windowed dev mode: no kiosk lock, no always-on-top
```

Sign in with exam code `DEMO101` (edit `server/config/exams.json`). In dev mode the window is not locked, so you can still close it.

> **Never run `npm start` on your own machine with a real exam config unless you can end the session from the dashboard.** Kiosk mode deliberately traps you (that is the point). Use `npm run dev` while developing.

## Configure exams (`server/config/exams.json`)

Re-read on every sign-in, so you can edit it without restarting the server.

```jsonc
{
  "CS101-MIDTERM": {
    "title": "CS101 Midterm",
    "startUrl": "https://exam.college.edu/cs101",
    "allow": [
      { "host": "exam.college.edu",   "ports": [443] },                       // exact host
      { "host": "*.cdn.college.edu",  "ports": [443] },                       // any subdomain (not the bare domain)
      { "host": "lab.college.edu",    "ports": [8080], "schemes": ["http"] }, // plain HTTP must be explicit
      { "host": "10.20.0.5",          "ports": [3000], "schemes": ["http"] }  // IPs only if listed
    ],
    "durationMinutes": 90,          // countdown shown; browser closes at 0. A relaunch keeps the ORIGINAL end time
    "opensAt": "2026-10-01T09:00:00+05:30",
    "closesAt": "2026-10-01T12:00:00+05:30",
    "exitCode": "FINISH-7731",      // invigilator tells students this when they may finish
    "students": ["S001", "S002"],   // optional roster; omit to allow any ID
    "settings": {                   // all optional; defaults in server/server.js
      "allowClipboard": false,
      "allowMultipleDisplays": false,
      "focusGraceMs": 800,
      "allowedPermissions": []      // e.g. ["media"] if the exam page needs camera/mic
    },
    "blockedProcesses": null        // null = built-in list (TeamViewer, AnyDesk, OBS, Zoom, snipping tools…), or your own array
  }
}
```

Defaults: `ports` = `[443]`, `schemes` = `["https","wss"]`. Anything not matched is denied.

## Deploy the server

```bash
cd server && npm ci --omit=dev
ADMIN_USER=admin ADMIN_PASSWORD='long-random-password' \
TLS_KEY=/etc/ssl/exam.key TLS_CERT=/etc/ssl/exam.crt PORT=443 node server.js
```

* Use **HTTPS** (`TLS_KEY`/`TLS_CERT`, or a reverse proxy with `TRUST_PROXY=1`). The client refuses a non-HTTPS server URL except `localhost`.
* Data lives in `server/data/` (`sessions.json`, `alerts.jsonl`, `shots/`, `keys/`). Back it up; it is your evidence. **Never share `keys/private.pem`.**
* Run under systemd/pm2 so it restarts. Watch disk space: a screenshot is roughly 100–400 KB.

## Build the installers

Do this once per institution:

1. Start the server once (it creates `server/data/keys/`).
2. `cp server/data/keys/public.pem client/config/public-key.pem`
3. Set your `https://` server URL in `client/config/config.json`.
4. Build **on the target OS** (or use the included GitHub Actions workflow, which builds both):

| Where | Command | Output (`client/dist/`) |
|---|---|---|
| Windows | `cd client && npm ci && npm run dist:win` | `SecureExamBrowser-1.0.0-win-x64.exe` (NSIS installer) |
| Ubuntu | `cd client && npm ci && npm run dist:linux` | `…-linux-amd64.deb` and `.AppImage` |

The public key and server URL are baked into the installer's read-only app package. The browser **only accepts whitelist policies signed by your server's private key**, so a student cannot point it at a fake server that returns a permissive whitelist.

### Lab deployment notes

* **Windows**: install with the `.exe` (silent: `/S`). Give students a **standard (non-admin) account**.
* **Ubuntu**: install the **`.deb`** (`sudo apt install ./SecureExamBrowser-*.deb`). It sets up the Chromium sandbox correctly on Ubuntu 22.04 and 24.04. The AppImage needs `--no-sandbox` on 24.04, so avoid it in labs.
* **Ubuntu: log in with "Ubuntu on Xorg"**, not the Wayland session. On Wayland the whole-screen capture can come back blank. The browser detects Wayland, warns on the sign-in screen and sends an `ENV_WARNING` to the admin. The browser itself runs on X11 automatically.
* Machines need outbound HTTPS to the admin server plus the exam site, nothing else.
* macOS works too but needs "Screen Recording" permission granted once; it is not part of the build matrix.

## Privacy and consent

The sign-in screen shows a monitoring notice (screenshots of the whole screen, name, ID, computer name, network address, activity log) and students must tick a box to start; the server refuses sessions without it. Screenshots can contain private on-screen content from other windows. Keep `server/data/` access restricted, define a retention period, and make sure your institution's policy or applicable data-protection law (e.g. India's DPDP Act) is covered in your exam terms. Consider deleting `shots/` after the review window closes.

## Tests

```bash
cd server && npm test                    # single-institute API lifecycle + central multi-institute isolation
cd client && npm test                    # whitelist matcher (domains, ports, schemes, look-alikes) + key rules
cd client && xvfb-run -a -s "-screen 0 1280x800x24" node scripts/smoke.js
                                         # real Electron + real server, headless (Linux; needs `pip install python-xlib`):
                                         # blocked domain/port, popup, download, copy, F12/Alt+Tab/Ctrl+C key events,
                                         # screenshots on disk, heartbeat, remote terminate
```

## Honest limits: read before high-stakes use

A locked-down browser **raises the cost of cheating; it cannot make it impossible** on a machine the student controls.

* **Keys the OS swallows** (Ctrl+Alt+Del, Win+L on Windows, some Super combos on Ubuntu) never reach the app. Focus loss right after them is still detected and reported.
* **Alt+Tab is detected, not prevented**: the app reports it (after `focusGraceMs`, default 0.8 s) with a screenshot of what the student switched to, and keeps pulling itself back to the front. Very quick switches under the grace period are logged in the event trail but do not raise an alert.
* **A student with admin/root rights** can kill the process, run a VM, use a second device (phone, second PC) or an HDMI capture card. Mitigate with locked-down lab accounts, invigilators, and (for remote exams) camera proctoring. None of this is in scope here.
* **Process blocking matches names**; a renamed executable evades it.
* **Wayland**: see above. **Windows content protection** hides the exam window from other apps' captures, so the full-screen grab shows the desktop *behind* it; the separate "exam window" image shows what the exam displayed.
* The exam website itself is trusted: anything it links to that is not whitelisted is blocked, but a whitelisted site with its own open redirect or embedded chat could still be misused. Whitelist narrowly.
* Fuses in the packaged build disable `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect`. Code-signing the Windows installer is recommended so students can verify authenticity (not configured here).

## Layout

```
server/server.js       Single-institute admin server (CLI entry). Thin wrapper around lib/tenant.js.
server/central.js      Multi-institute central server (CLI entry): super-admin API + per-institute
                       tenants mounted at /i/<slug>, public-super/ (platform-admin page).
server/lib/tenant.js   The actual API for one institute (policy signing, sessions, alerts,
                       dashboard) as an Express Router - shared by both entry points above.
server/lib/institutes.js, passwords.js   Central server's institute registry + password hashing.
server/lib/settings-file.js   Loads settings.txt / central-settings.txt (Notepad-editable config).
server/public/          Dashboard UI (one institute's sessions/alerts, live via SSE).
server/public-super/     Platform-admin UI (create/manage institutes) - central server only.
server/scripts/build-standalone.js   Builds double-clickable executables with pkg (no Node needed
                       to run them - see README "Run the server with no installation").
client/src/        main.js (window, whitelist enforcement, violation pipeline), whitelist.js, input-rules.js,
                   monitors.js (focus/displays/processes/clipboard), reporter.js (screenshots + outbox),
                   preload-*.js, shell/ (sign-in + top bar UI)
client/build/      afterPack.js (flips Electron fuses in the packaged binary)
client/scripts/    dev.js, smoke.js, xkey.py (test tooling)
.github/workflows/ Windows + Ubuntu installer builds
```
