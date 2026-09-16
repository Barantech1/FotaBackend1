/**
 * The entire admin UI as one inline HTML/CSS/JS string, served by
 * routes/admin-ui.ts at GET /admin. Kept as a single dependency-free file
 * (no bundler, no frontend framework) to match this repo's MVP philosophy
 * - see README's "why node:sqlite instead of better-sqlite3" for the same
 * reasoning applied here. Adapted from the reviewed wireframe
 * (FOTA_admin_UI_wireframe.html): same visual design, but every screen now
 * calls the real /admin/api/* endpoints instead of showing mock data.
 */
export const ADMIN_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FOTA Backend Admin</title>
<style>
  :root {
    --dark: #403A38;
    --slate: #737B8A;
    --slate-bg: #737B8A1A;
    --teal: #55C1CB;
    --teal-bright: #00DBDB;
    --teal-bg: #00DBDB14;
    --error: #FF5B7C;
    --error-bg: #FF5B7C14;
    --border: #E3E1DF;
    --bg: #F5F4F2;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--dark);
  }
  .stage { min-height: 100vh; position: relative; }

  /* --- Login screen --- */
  .login-wrap {
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px 20px;
  }
  .login-card {
    background: #fff; border: 1px solid var(--border); border-radius: 16px; padding: 36px;
    width: 100%; max-width: 360px; box-shadow: 0 8px 24px rgba(64,58,56,0.06);
  }
  .brand-mark { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
  .brand-badge {
    width: 34px; height: 34px; border-radius: 9px;
    background: linear-gradient(135deg, #403A38, #4E3872, #2B5173, #066E6D);
    display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 13px;
  }
  .brand-mark .name { font-weight: 700; font-size: 14.5px; }
  .brand-mark .name .tag { display: block; font-size: 10.5px; font-weight: 600; color: var(--slate); letter-spacing: 0.04em; text-transform: uppercase; }
  .login-card h2 { font-size: 18px; margin: 0 0 4px; }
  .login-card p.hint { font-size: 12.5px; color: var(--slate); margin: 0 0 20px; }
  .field { margin-bottom: 14px; }
  .field label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 5px; color: var(--dark); }
  .field input, .field select {
    width: 100%; font-size: 13.5px; border: 1px solid var(--border); border-radius: 9px; padding: 9px 11px;
    font-family: inherit; background: #fff;
  }
  .password-wrap { position: relative; }
  .password-wrap input { padding-right: 54px; }
  .password-toggle {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    font-size: 11px; font-weight: 700; color: var(--slate); background: none; border: none;
    cursor: pointer; font-family: inherit; padding: 4px 6px;
  }
  .password-toggle:hover { color: var(--dark); }
  .btn-primary {
    width: 100%; border: none; background: var(--teal); color: #fff; font-weight: 700; font-size: 13.5px;
    padding: 11px; border-radius: 9px; cursor: pointer; font-family: inherit; margin-top: 4px;
  }
  .btn-primary:disabled { opacity: 0.6; cursor: default; }
  .login-foot { font-size: 11px; color: var(--slate); text-align: center; margin-top: 16px; line-height: 1.5; max-width: 360px; margin-left: auto; margin-right: auto; }
  .form-error { font-size: 12px; color: var(--error); margin: -6px 0 14px; min-height: 14px; }

  /* --- Dashboard shell --- */
  .topbar {
    background: #fff; border-bottom: 1px solid var(--border); padding: 0 24px; height: 56px;
    display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 10;
  }
  .topbar .who { font-size: 12px; color: var(--slate); display: flex; align-items: center; gap: 10px; }
  .who .signout { font-size: 11.5px; font-weight: 700; color: var(--dark); background: none; border: 1px solid var(--border); border-radius: 7px; padding: 5px 10px; cursor: pointer; font-family: inherit; }
  .content { max-width: 1080px; margin: 0 auto; padding: 26px 24px 60px; }
  .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 20px; }
  .tab {
    font-size: 13px; font-weight: 700; padding: 10px 16px; border: none; background: none; cursor: pointer;
    color: var(--slate); border-bottom: 2px solid transparent; margin-bottom: -1px; font-family: inherit;
  }
  .tab.active { color: var(--dark); border-bottom-color: var(--teal); }
  .panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; gap: 16px; }
  .panel-head h3 { font-size: 15px; margin: 0; }
  .panel-head .desc { font-size: 12px; color: var(--slate); margin: 3px 0 0; }
  .btn-action {
    display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 700; color: #fff;
    background: var(--teal); border: none; border-radius: 8px; padding: 8px 14px; cursor: pointer; font-family: inherit;
    white-space: nowrap;
  }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  thead th {
    text-align: left; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
    color: var(--slate); padding: 10px 14px; border-bottom: 1px solid var(--border); background: #FAFAF9;
  }
  tbody td { padding: 12px 14px; font-size: 13px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: none; }
  .mono { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12px; color: var(--slate); }
  .badge {
    display: inline-block; font-size: 10.5px; font-weight: 700; padding: 3px 9px; border-radius: 20px;
    border: 1px solid transparent;
  }
  .badge.active { background: var(--teal-bg); color: #04898f; border-color: #55c1cb55; }
  .badge.inactive { background: var(--slate-bg); color: var(--slate); border-color: #737B8A33; }
  .badge.unknown { background: var(--slate-bg); color: var(--slate); border-color: #737B8A33; font-style: italic; }
  .row-link { font-size: 12px; font-weight: 700; color: var(--teal); background: none; border: none; cursor: pointer; font-family: inherit; padding: 0; }
  .sort-header { cursor: pointer; user-select: none; }
  .sort-header:hover { color: var(--dark); }

  /* --- Modal --- */
  .modal-backdrop {
    position: fixed; inset: 0; background: rgba(64,58,56,0.35); display: flex; align-items: center;
    justify-content: center; padding: 20px; z-index: 30;
  }
  .modal {
    background: #fff; border-radius: 14px; padding: 24px; width: 100%; max-width: 420px;
    box-shadow: 0 16px 40px rgba(0,0,0,0.18);
  }
  .modal h3 { font-size: 15.5px; margin: 0 0 4px; }
  .modal p.hint { font-size: 12px; color: var(--slate); margin: 0 0 18px; line-height: 1.5; }
  .file-drop-input { width: 100%; font-size: 12.5px; }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  .btn-secondary {
    font-size: 12.5px; font-weight: 700; color: var(--dark); background: none; border: 1px solid var(--border);
    border-radius: 8px; padding: 9px 14px; cursor: pointer; font-family: inherit;
  }
  .empty-note {
    background: #fff; border: 1px dashed var(--border); border-radius: 12px; padding: 30px; text-align: center;
    color: var(--slate); font-size: 12.5px;
  }
</style>
</head>
<body>
<div class="stage" id="stage">Loading...</div>

<script>
(function () {
  var state = { session: null, tab: 'firmware', modal: null, error: '', activitySort: { key: 'checkedInAt', dir: 'desc' } };

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    if (opts.jsonBody) {
      opts.headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
      opts.body = JSON.stringify(opts.jsonBody);
      delete opts.jsonBody;
    }
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok) throw new Error(body.message || (res.status + ' ' + res.statusText));
        return body;
      });
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso.replace(' ', 'T') + 'Z');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso.replace(' ', 'T') + 'Z');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function render() {
    document.getElementById('stage').innerHTML = state.session && state.session.signedIn
      ? renderDashboard()
      : renderLogin();
    wireEvents();
  }

  // ---------- Login ----------
  function renderLogin() {
    return '<div class="login-wrap"><div class="login-card">'
      + '<div class="brand-mark"><div class="brand-badge">FB</div><div class="name">FOTA Backend<span class="tag">Barantech</span></div></div>'
      + '<h2>Sign in</h2><p class="hint">FOTA backend admin - Barantech internal use only.</p>'
      + '<div class="field"><label>Email</label><input type="email" id="loginEmail" autocomplete="username" /></div>'
      + '<div class="field"><label>Password</label><div class="password-wrap">'
      + '<input type="password" id="loginPassword" autocomplete="current-password" />'
      + '<button type="button" class="password-toggle" id="loginPasswordToggle">Show</button>'
      + '</div></div>'
      + '<div class="form-error">' + esc(state.error) + '</div>'
      + '<button class="btn-primary" id="loginSubmit">Sign in</button>'
      + '</div></div>'
      + '<p class="login-foot">No self-service signup - accounts are a small, fixed list configured directly in the deployment.</p>';
  }

  function submitLogin() {
    var email = document.getElementById('loginEmail').value.trim();
    var password = document.getElementById('loginPassword').value;
    var btn = document.getElementById('loginSubmit');
    btn.disabled = true;
    state.error = '';
    api('/admin/api/login', { method: 'POST', jsonBody: { email: email, password: password } })
      .then(function () { return loadSession(); })
      .catch(function (err) {
        state.error = err.message || 'Sign in failed.';
        render();
      });
  }

  // ---------- Dashboard shell ----------
  var TABS = [
    ['firmware', 'Firmware'],
    ['assignments', 'Assignments'],
    ['tenants', 'Tenants'],
    ['activity', 'User Activity'],
    ['admins', 'Admins'],
  ];

  function renderDashboard() {
    var html = '<div class="topbar">'
      + '<div style="display:flex;align-items:center;gap:8px;"><div class="brand-badge" style="width:26px;height:26px;font-size:10px;">FB</div>'
      + '<span style="font-weight:700;font-size:13px;">FOTA Backend Admin</span></div>'
      + '<div class="who">' + esc(state.session.email) + ' <button class="signout" id="signOutBtn">Sign out</button></div>'
      + '</div>'
      + '<div class="content">'
      + '<div class="tabs">' + TABS.map(function (t) {
          return '<button class="tab' + (t[0] === state.tab ? ' active' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>';
        }).join('') + '</div>'
      + '<div id="panel">Loading...</div>'
      + '</div>';
    if (state.modal) html += renderModal();
    return html;
  }

  function panelHead(title, desc, actionLabel, actionId) {
    return '<div class="panel-head"><div><h3>' + esc(title) + '</h3><p class="desc">' + desc + '</p></div>'
      + (actionLabel ? '<button class="btn-action" id="' + actionId + '">+ ' + esc(actionLabel) + '</button>' : '') + '</div>';
  }
  function table(headers, rows) {
    if (!rows.length) return '<div class="empty-note">Nothing here yet.</div>';
    var head = '<thead><tr>' + headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead>';
    var body = '<tbody>' + rows.map(function (r) {
      return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
    }).join('') + '</tbody>';
    return '<table>' + head + body + '</table>';
  }
  function badge(cls, label) { return '<span class="badge ' + cls + '">' + esc(label) + '</span>'; }
  function mono(text) { return '<span class="mono">' + esc(text) + '</span>'; }

  function loadPanel() {
    var panel = document.getElementById('panel');
    if (!panel) return;
    if (state.tab === 'firmware') return loadFirmwarePanel(panel);
    if (state.tab === 'assignments') return loadAssignmentsPanel(panel);
    if (state.tab === 'tenants') return loadTenantsPanel(panel);
    if (state.tab === 'activity') return loadActivityPanel(panel);
    if (state.tab === 'admins') return loadAdminsPanel(panel);
  }

  // ---------- Firmware ----------
  function loadFirmwarePanel(panel) {
    api('/admin/api/firmware').then(function (rows) {
      panel.innerHTML = panelHead('Firmware', 'Uploaded firmware files available to assign to a user.', 'Upload firmware', 'uploadFirmwareBtn')
        + table(['Filename', 'Version', 'Size', 'Checksum', 'Uploaded', 'Status'], rows.map(function (f) {
            return [esc(f.filename), esc(f.version), fmtSize(f.fileSizeBytes), mono(f.checksumSha256.slice(0, 12) + '...'), fmtDate(f.uploadedAt), badge(f.isActive ? 'active' : 'inactive', f.isActive ? 'Active' : 'Inactive')];
          }));
      var btn = document.getElementById('uploadFirmwareBtn');
      if (btn) btn.addEventListener('click', function () { state.modal = 'firmware-upload'; render(); });
    });
  }
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    return (bytes / 1024).toFixed(1) + ' KB';
  }

  // ---------- Assignments ----------
  function loadAssignmentsPanel(panel) {
    api('/admin/api/assignments').then(function (rows) {
      panel.innerHTML = panelHead('Assignments', 'Which firmware each user is currently set to receive. Prior assignments are kept, never deleted, when superseded.', 'New assignment', 'newAssignmentBtn')
        + table(['User email', 'Firmware', 'Assigned', ''], rows.map(function (a) {
            return [esc(a.userEmail), esc(a.firmwareVersion), fmtDate(a.assignedAt), '<button class="row-link" data-edit-email="' + esc(a.userEmail) + '" data-edit-firmware="' + a.firmwareId + '">Edit</button>'];
          }));
      var newBtn = document.getElementById('newAssignmentBtn');
      if (newBtn) newBtn.addEventListener('click', function () { state.modal = 'assignment-new'; render(); });
      panel.querySelectorAll('[data-edit-email]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          state.modal = { type: 'assignment-edit', email: btn.getAttribute('data-edit-email'), firmwareId: Number(btn.getAttribute('data-edit-firmware')) };
          render();
        });
      });
    });
  }

  // ---------- Tenants ----------
  function loadTenantsPanel(panel) {
    api('/admin/api/tenants').then(function (rows) {
      panel.innerHTML = panelHead('Tenants', "Emails you've deliberately added as eligible to receive firmware assignments - a curated list, not the raw check-in log, so a New Assignment dropdown can never point at a typo or a one-off log artifact.", 'Add tenant', 'addTenantBtn')
        + table(['Email', 'Added'], rows.map(function (t) { return [esc(t.email), fmtDate(t.addedAt)]; }));
      var btn = document.getElementById('addTenantBtn');
      if (btn) btn.addEventListener('click', function () { state.modal = 'tenant-add'; render(); });
    });
  }

  // ---------- User Activity ----------
  function loadActivityPanel(panel) {
    var params = new URLSearchParams({ sortKey: state.activitySort.key === 'email' ? 'email' : 'time', sortDir: state.activitySort.dir });
    api('/admin/api/activity?sortKey=' + (state.activitySort.key === 'email' ? 'email' : 'time') + '&sortDir=' + state.activitySort.dir).then(function (rows) {
      function arrow(key) {
        if (state.activitySort.key !== key) return '';
        return state.activitySort.dir === 'asc' ? ' ↑' : ' ↓';
      }
      var head = '<thead><tr>'
        + '<th class="sort-header" data-sort-key="email">Email' + arrow('email') + '</th>'
        + '<th class="sort-header" data-sort-key="checkedInAt">Checked in' + arrow('checkedInAt') + '</th>'
        + '<th>Downloaded</th>'
        + '<th>Written to lock</th>'
        + '</tr></thead>';
      var body = rows.length
        ? '<tbody>' + rows.map(function (r) {
            var downloaded = r.downloaded === null ? '<span class="badge inactive">No update pending</span>' : badge(r.downloaded ? 'active' : 'inactive', r.downloaded ? 'Yes' : 'Not yet');
            return '<tr><td>' + esc(r.email) + '</td><td>' + fmtDateTime(r.checkedInAt) + '</td><td>' + downloaded + '</td><td>' + badge('unknown', 'Unknown') + '</td></tr>';
          }).join('') + '</tbody>'
        : '<tbody><tr><td colspan="4" style="text-align:center;color:var(--slate);">No check-ins recorded yet.</td></tr></tbody>';

      panel.innerHTML = panelHead('User Activity', 'Every time a real Lockfinity customer\\'s app checks in for updates - an activity log, not a one-row-per-person directory. Sortable by either column. "Written to lock" is always Unknown today: the mobile app doesn\\'t yet report that outcome back to this backend (see README).', null)
        + '<table>' + head + body + '</table>';

      panel.querySelectorAll('.sort-header').forEach(function (th) {
        th.addEventListener('click', function () {
          var key = th.getAttribute('data-sort-key');
          if (state.activitySort.key === key) {
            state.activitySort.dir = state.activitySort.dir === 'asc' ? 'desc' : 'asc';
          } else {
            state.activitySort.key = key;
            state.activitySort.dir = 'asc';
          }
          loadActivityPanel(panel);
        });
      });
    });
  }

  // ---------- Admins ----------
  function loadAdminsPanel(panel) {
    api('/admin/api/admins').then(function (emails) {
      panel.innerHTML = panelHead('Admins', 'Who can sign in to this panel. Read-only here - the list itself is a small, fixed set configured directly in the deployment, changed by redeploying, not through this UI.', null)
        + table(['Email'], emails.map(function (e) {
            return [esc(e) + (e === state.session.email ? ' ' + badge('active', 'You') : '')];
          }));
    });
  }

  // ---------- Modals ----------
  function renderModal() {
    var m = state.modal;
    var type = typeof m === 'string' ? m : m.type;
    if (type === 'firmware-upload') return modalFirmwareUpload();
    if (type === 'assignment-new') return modalAssignment(null);
    if (type === 'assignment-edit') return modalAssignment(m);
    if (type === 'tenant-add') return modalTenantAdd();
    return '';
  }
  function modalShell(title, hint, body, actionLabel, submitId) {
    return '<div class="modal-backdrop" id="modalBackdrop"><div class="modal"><h3>' + esc(title) + '</h3><p class="hint">' + hint + '</p>'
      + '<div class="form-error" id="modalError"></div>'
      + body
      + '<div class="modal-actions"><button class="btn-secondary" id="modalCancel">Cancel</button><button class="btn-primary" style="width:auto;margin-top:0;" id="' + submitId + '">' + esc(actionLabel) + '</button></div>'
      + '</div></div>';
  }
  function modalFirmwareUpload() {
    return modalShell('Upload firmware', 'Stored as-is and checksummed server-side (SHA-256) - the checksum shown to the mobile app is always computed here, never trusted from the upload.', ''
      + '<div class="field"><label>Version</label><input type="text" id="fwVersion" placeholder="2.4.2" /></div>'
      + '<div class="field"><label>File</label><input type="file" id="fwFile" class="file-drop-input" /></div>'
      , 'Upload', 'fwUploadSubmit');
  }
  function modalAssignment(editing) {
    var tenantsPromiseHtml = '<div class="field"><label>Tenant</label><select id="asgTenant"' + (editing ? ' disabled' : '') + '></select></div>';
    var firmwarePromiseHtml = '<div class="field"><label>Firmware</label><select id="asgFirmware"></select></div>';
    setTimeout(function () {
      Promise.all([api('/admin/api/tenants'), api('/admin/api/firmware')]).then(function (results) {
        var tenants = results[0], firmwares = results[1];
        var tenantSel = document.getElementById('asgTenant');
        var fwSel = document.getElementById('asgFirmware');
        if (!tenantSel || !fwSel) return;
        if (editing) {
          tenantSel.innerHTML = '<option>' + esc(editing.email) + '</option>';
        } else {
          tenantSel.innerHTML = tenants.map(function (t) { return '<option value="' + esc(t.email) + '">' + esc(t.email) + '</option>'; }).join('');
        }
        fwSel.innerHTML = firmwares.map(function (f) {
          var selected = editing && f.id === editing.firmwareId ? ' selected' : '';
          return '<option value="' + f.id + '"' + selected + '>' + esc(f.version) + ' - ' + esc(f.filename) + '</option>';
        }).join('');
      });
    }, 0);
    return modalShell(
      editing ? 'Edit assignment' : 'New assignment',
      editing
        ? 'Changes what ' + esc(editing.email) + ' receives next. Under the hood this is still "assign new firmware" - the current one gets superseded, not overwritten - it just starts from their existing assignment instead of a blank form.'
        : "Deactivates that user's current assignment (if any) and makes this the active one - history is preserved, not deleted.",
      tenantsPromiseHtml + firmwarePromiseHtml,
      editing ? 'Save' : 'Assign',
      'asgSubmit',
    );
  }
  function modalTenantAdd() {
    return modalShell('Add tenant', 'Double-check this against the User Activity check-in log before adding - this is the one place a typo would actually matter, since it becomes selectable for real firmware assignments.', ''
      + '<div class="field"><label>Email</label><input type="email" id="tenantEmail" placeholder="dana@example.com" /></div>'
      , 'Add', 'tenantAddSubmit');
  }

  function closeModal() { state.modal = null; render(); }
  function modalErr(msg) {
    var el = document.getElementById('modalError');
    if (el) el.textContent = msg;
  }

  function submitFirmwareUpload() {
    var version = document.getElementById('fwVersion').value.trim();
    var fileInput = document.getElementById('fwFile');
    var file = fileInput.files[0];
    if (!version || !file) { modalErr('Version and file are required.'); return; }
    var fd = new FormData();
    fd.append('version', version);
    fd.append('file', file);
    fetch('/admin/firmware', { method: 'POST', credentials: 'same-origin', body: fd })
      .then(function (res) { return res.json().then(function (b) { if (!res.ok) throw new Error(b.message || 'Upload failed.'); return b; }); })
      .then(function () { closeModal(); loadPanel(); })
      .catch(function (err) { modalErr(err.message); });
  }
  function submitAssignment(editing) {
    var userEmail = editing ? editing.email : document.getElementById('asgTenant').value;
    var firmwareId = Number(document.getElementById('asgFirmware').value);
    if (!userEmail || !firmwareId) { modalErr('Tenant and firmware are required.'); return; }
    api('/admin/assignments', { method: 'POST', jsonBody: { userEmail: userEmail, firmwareId: firmwareId } })
      .then(function () { closeModal(); loadPanel(); })
      .catch(function (err) { modalErr(err.message); });
  }
  function submitTenantAdd() {
    var email = document.getElementById('tenantEmail').value.trim();
    if (!email) { modalErr('Email is required.'); return; }
    api('/admin/api/tenants', { method: 'POST', jsonBody: { email: email } })
      .then(function () { closeModal(); loadPanel(); })
      .catch(function (err) { modalErr(err.message); });
  }

  // ---------- Event wiring ----------
  function wireEvents() {
    var loginSubmit = document.getElementById('loginSubmit');
    if (loginSubmit) loginSubmit.addEventListener('click', submitLogin);
    var loginPassword = document.getElementById('loginPassword');
    if (loginPassword) loginPassword.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitLogin(); });
    var loginPasswordToggle = document.getElementById('loginPasswordToggle');
    if (loginPasswordToggle) loginPasswordToggle.addEventListener('click', function () {
      var showing = loginPassword.type === 'text';
      loginPassword.type = showing ? 'password' : 'text';
      loginPasswordToggle.textContent = showing ? 'Show' : 'Hide';
    });

    var signOutBtn = document.getElementById('signOutBtn');
    if (signOutBtn) signOutBtn.addEventListener('click', function () {
      api('/admin/api/logout', { method: 'POST' }).then(function () { loadSession(); });
    });

    document.querySelectorAll('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        state.tab = tab.getAttribute('data-tab');
        render();
        loadPanel();
      });
    });

    var modalCancel = document.getElementById('modalCancel');
    if (modalCancel) modalCancel.addEventListener('click', closeModal);
    var backdrop = document.getElementById('modalBackdrop');
    if (backdrop) backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeModal(); });

    var fwUploadSubmit = document.getElementById('fwUploadSubmit');
    if (fwUploadSubmit) fwUploadSubmit.addEventListener('click', submitFirmwareUpload);
    var asgSubmit = document.getElementById('asgSubmit');
    if (asgSubmit) asgSubmit.addEventListener('click', function () {
      var m = state.modal;
      submitAssignment(typeof m === 'object' ? m : null);
    });
    var tenantAddSubmit = document.getElementById('tenantAddSubmit');
    if (tenantAddSubmit) tenantAddSubmit.addEventListener('click', submitTenantAdd);

    if (state.session && state.session.signedIn && !state.modal) loadPanel();
  }

  function loadSession() {
    return api('/admin/api/session').then(function (session) {
      state.session = session;
      state.error = '';
      render();
    });
  }

  loadSession();
})();
</script>
</body>
</html>
`;
