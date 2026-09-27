'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.seb;
  let endsAt = null;
  let skewMs = 0;
  let timerHandle = null;
  let warnHandle = null;

  // Text fields need normal editing; everything else in the shell is inert.
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  function showError(el, msg) { el.textContent = msg; el.hidden = !msg; }

  // ---- startup info --------------------------------------------------------
  api.info().then((info) => {
    $('ver').textContent = `Secure Exam Browser v${info.version}`;
    const notes = [];
    if (info.wayland) notes.push('This Linux session uses Wayland. Screen capture may be blank; ask your invigilator to log in with "Ubuntu on Xorg".');
    if (info.displays > 1) notes.push(`${info.displays} displays detected. Disconnect extra monitors before starting.`);
    if (notes.length) { $('envWarn').textContent = notes.join(' '); $('envWarn').hidden = false; }
  });

  // ---- sign in ---------------------------------------------------------------
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    showError($('error'), '');
    $('startBtn').disabled = true;
    $('startBtn').textContent = 'Connecting…';
    const res = await api.start({
      examCode: $('examCode').value,
      studentId: $('studentId').value,
      studentName: $('studentName').value,
      consent: $('consent').checked,
    });
    $('startBtn').disabled = false;
    $('startBtn').textContent = 'Start exam';
    if (!res.ok) return showError($('error'), res.error);

    $('login').hidden = true;
    $('bar').hidden = false;
    $('examTitle').textContent = res.title || 'Exam';
    $('who').textContent = res.studentName;
    if (res.endsAt) { endsAt = res.endsAt; skewMs = res.skewMs || 0; startTimer(); }
  });
  $('quitBtn').addEventListener('click', () => api.quit());

  // ---- countdown ---------------------------------------------------------------
  function startTimer() {
    const el = $('timer');
    el.hidden = false;
    const render = () => {
      const left = Math.max(0, Math.round((endsAt - (Date.now() + skewMs)) / 1000));
      const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
      el.textContent = (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(s).padStart(2, '0');
      el.classList.toggle('low', left <= 300);
    };
    render();
    timerHandle = setInterval(render, 1000);
  }

  // ---- toolbar -------------------------------------------------------------------
  for (const id of ['back', 'forward', 'reload', 'home']) $(id).addEventListener('click', () => api.nav(id));

  $('finish').addEventListener('click', async () => {
    await api.promptExit();
    showError($('exitError'), '');
    $('exitCode').value = '';
    $('exitModal').hidden = false;
    $('exitCode').focus();
  });
  $('exitCancel').addEventListener('click', async () => {
    $('exitModal').hidden = true;
    await api.cancelExit();
  });
  async function submitExit() {
    $('exitOk').disabled = true;
    const res = await api.confirmExit($('exitCode').value);
    $('exitOk').disabled = false;
    if (!res.ok) showError($('exitError'), res.error);
  }
  $('exitOk').addEventListener('click', submitExit);
  $('exitCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitExit(); });

  // ---- events from the main process ----------------------------------------------
  api.onUi((msg) => {
    if (msg.kind === 'warn') {
      const w = $('warn');
      w.textContent = msg.text + (msg.reported ? ' (reported)' : '');
      w.classList.add('show');
      clearTimeout(warnHandle);
      warnHandle = setTimeout(() => w.classList.remove('show'), 4500);
    } else if (msg.kind === 'status') {
      $('conn').classList.toggle('bad', !msg.online);
      $('connText').textContent = msg.online ? 'connected' : 'offline (retrying)';
    } else if (msg.kind === 'ended') {
      clearInterval(timerHandle);
      $('exitModal').hidden = true;
      $('bar').hidden = true;
      $('endText').textContent = msg.text || '';
      $('endScreen').hidden = false;
    }
  });
})();
