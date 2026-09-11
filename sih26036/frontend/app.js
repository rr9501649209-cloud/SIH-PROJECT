const API_BASE = window.API_BASE_URL || ''; // same-origin by default; set window.API_BASE_URL to point at a separately-deployed backend

// ================= session =================

const OFFICER_ROLES = ['LMO', 'GATC', 'STATE_ADMIN', 'CENTRAL_ADMIN'];
let officerPhotoPreviewUrl = null;
let queueSyncInProgress = false;

function getSession() {
  const raw = sessionStorage.getItem('setu-session');
  return raw ? JSON.parse(raw) : null;
}
function saveSession(session) {
  sessionStorage.setItem('setu-session', JSON.stringify(session));
  applySessionToUI();
}


function isOfficerSession(session) {
  return session && OFFICER_ROLES.includes(session.stakeholder.role);
}

function clearPhotoPreview() {
  const preview = document.getElementById('officer-photo-preview');
  if (officerPhotoPreviewUrl) {
    URL.revokeObjectURL(officerPhotoPreviewUrl);
    officerPhotoPreviewUrl = null;
  }
  preview.removeAttribute('src');
  preview.hidden = true;
}

function clearOfficerState() {
  applications = [];
  document.getElementById('officer-application').innerHTML = '';
  document.getElementById('officer-observation-fields').innerHTML = '';
  document.getElementById('officer-verify-form').reset();
  clearPhotoPreview();
  document.getElementById('officer-result').innerHTML = '';
  document.getElementById('routes-result').innerHTML = '';
  const queueStatus = document.getElementById('queue-status');
  queueStatus.hidden = true;
  queueStatus.innerHTML = '';
}

function clearUserSpecificUIState() {
  document.getElementById('session-label').textContent = '';
  document.getElementById('login-form').reset();
  document.getElementById('apply-form').reset();
  document.getElementById('apply-result').innerHTML = '';
  document.getElementById('import-instruments-csv').value = '';
  document.getElementById('import-instruments-result').innerHTML = '';
  document.getElementById('import-stakeholders-csv').value = '';
  document.getElementById('import-stakeholders-result').innerHTML = '';
  clearOfficerState();
}

function clearSession() {
  sessionStorage.removeItem('setu-session');
  clearUserSpecificUIState();
  applySessionToUI();
}

function applySessionToUI() {
  const session = getSession();
  document.getElementById('login-form').hidden = !!session;
  document.getElementById('session-info').hidden = !session;
  if (session) {
    document.getElementById('session-label').textContent = `${session.stakeholder.name} (${session.stakeholder.role})`;
  } else {
    document.getElementById('session-label').textContent = '';
  }
  document.querySelectorAll('.tab[data-roles]').forEach((tab) => {
    const allowed = tab.dataset.roles.split(',');
    const visible = session && allowed.includes(session.stakeholder.role);
    tab.hidden = !visible;
    if (!visible && tab.classList.contains('active')) switchTab('apply');
  });
  if (isOfficerSession(session)) {
    loadApplications();
  } else {
    clearOfficerState();
  }
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ phone: document.getElementById('login-phone').value }),
      skipAuth: true,
    });
    clearUserSpecificUIState();
    saveSession(data);
    if (navigator.onLine) drainQueue();
  } catch (err) {
    alert(err.message);
  }
});
document.getElementById('logout-btn').addEventListener('click', clearSession);

// ================= tabs =================
document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
}

// ================= helpers =================
async function api(path, options = {}) {
  const session = getSession();
  const headers = { 'Content-Type': 'application/json' };
  if (session && !options.skipAuth) headers.Authorization = `Bearer ${session.token}`;
  const res = await fetch(`${API_BASE}${path}`, { headers, ...options });
  const data = await res.json().catch(() => ({}));
  // if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  if (!res.ok) {
  const error = new Error(
    data.error || `Request failed (${res.status})`
  );

  error.status = res.status;

  throw error;
}
  return data;
}

function getCurrentQueueOwner() {
  const session = getSession();
  if (!isOfficerSession(session)) return null;
  return {
    stakeholderId: session.stakeholder.id,
    stakeholderRole: session.stakeholder.role,
  };
}

function recordBelongsToOwner(record, owner) {
  return !!(
    owner &&
    record.stakeholderId &&
    record.stakeholderRole &&
    record.stakeholderId === owner.stakeholderId &&
    record.stakeholderRole === owner.stakeholderRole
  );
}

function hasQueueOwnership(record) {
  return !!(record.stakeholderId && record.stakeholderRole);
}

function toVerificationPayload(record) {
  return {
    applicationId: record.applicationId,
    observations: record.observations,
    photoData: record.photoData,
    gpsLat: record.gpsLat,
    gpsLng: record.gpsLng,
    capturedAt: record.capturedAt,
    clientSubmissionId: record.clientSubmissionId,
  };
}

function classifySyncError(err) {
  if (err?.code === 'OFFLINE' || err?.name === 'TypeError' || !err?.status) {
    return { retryable: true, needsLogin: false, label: 'network failure' };
  }

  if (err.status === 401) {
    return { retryable: false, needsLogin: true, label: 'HTTP 401' };
  }

  if ([400, 403, 404, 422].includes(err.status)) {
    return { retryable: false, needsLogin: false, label: `HTTP ${err.status}` };
  }

  if (err.status === 409) {
    return { retryable: false, needsLogin: false, label: 'HTTP 409' };
  }

  if (err.status >= 500) {
    return { retryable: true, needsLogin: false, label: `HTTP ${err.status}` };
  }

  return { retryable: false, needsLogin: false, label: `HTTP ${err.status}` };
}

function nextRetryAt(retryCount) {
  const delays = [30, 120, 300, 900, 1800];
  const delaySeconds = delays[Math.min(retryCount, delays.length - 1)];
  return new Date(Date.now() + delaySeconds * 1000).toISOString();
}

function canRetryRecord(record, now = new Date()) {
  return record.syncStatus !== 'syncing' && (!record.nextRetryAt || new Date(record.nextRetryAt) <= now);
}

function useLocation(latInput, lngInput) {
  if (!navigator.geolocation) return alert('Geolocation is not available in this browser.');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      latInput.value = pos.coords.latitude.toFixed(6);
      lngInput.value = pos.coords.longitude.toFixed(6);
    },
    () => alert('Could not read location — enter it manually.')
  );
}

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read photo'));

    reader.readAsDataURL(file);
  });
}

// ================= instrument types =================
let instrumentTypes = [];
async function loadInstrumentTypes() {
  instrumentTypes = await api('/api/instrument-types', { skipAuth: true });
  const select = document.getElementById('apply-instrument-type');
  select.innerHTML = instrumentTypes.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
}

// ================= Apply =================
document.getElementById('apply-use-location').addEventListener('click', () =>
  useLocation(document.getElementById('apply-lat'), document.getElementById('apply-lng'))
);

document.getElementById('apply-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = document.getElementById('apply-result');
  out.textContent = 'Submitting…';
  try {
    let session = getSession();
    let ownerId;
    if (session) {
      ownerId = session.stakeholder.id;
    } else {
      await api('/api/stakeholders', {
        method: 'POST',
        skipAuth: true,
        body: JSON.stringify({
          role: 'APPLICANT',
          name: document.getElementById('apply-name').value,
          phone: document.getElementById('apply-phone').value,
          state: document.getElementById('apply-state').value,
          district: document.getElementById('apply-district').value,
        }),
      });
      const login = await api('/api/auth/login', {
        method: 'POST',
        skipAuth: true,
        body: JSON.stringify({ phone: document.getElementById('apply-phone').value }),
      });
      saveSession(login);
      session = login;
      ownerId = login.stakeholder.id;
    }

    const instrument = await api('/api/instruments', {
      method: 'POST',
      body: JSON.stringify({
        serialNumber: document.getElementById('apply-serial').value,
        instrumentTypeId: document.getElementById('apply-instrument-type').value,
        location: document.getElementById('apply-location').value,
        latitude: parseFloat(document.getElementById('apply-lat').value) || null,
        longitude: parseFloat(document.getElementById('apply-lng').value) || null,
      }),
    });
    const application = await api('/api/applications', {
      method: 'POST',
      body: JSON.stringify({ instrumentId: instrument.id }),
    });
    out.innerHTML = `<p class="ok">Application submitted.</p><p>Application ID:<br><code>${application.id}</code></p>`;
  } catch (err) {
    out.innerHTML = `<p class="err">${err.message}</p>`;
  }
});

// ================= Officer console =================
let applications = [];

function renderApplicationOptions() {
  const select = document.getElementById('officer-application');
  select.innerHTML = applications
    .map((a) => `<option value="${a.id}">${a.instrument_type} · ${a.serial_number} · ${a.applicant_name} · ${a.status}</option>`)
    .join('');
}

async function loadApplications() {
  const session = getSession();
  if (!isOfficerSession(session)) {
    clearOfficerState();
    return;
  }

  const sessionToken = session.token;
  applications = [];
  renderApplicationOptions();
  renderObservationFields();

  let loadedApplications = [];
  try {
    loadedApplications = await api('/api/applications');
  } catch {
    loadedApplications = [];
  }

  const latestSession = getSession();
  if (!isOfficerSession(latestSession) || latestSession.token !== sessionToken) return;

  applications = loadedApplications;
  renderApplicationOptions();
  renderObservationFields();
}

function renderObservationFields() {
  const select = document.getElementById('officer-application');
  const chosen = applications.find((a) => a.id === select.value);
  const container = document.getElementById('officer-observation-fields');
  container.innerHTML = '';
  if (!chosen) return;
  const type = instrumentTypes.find((t) => t.name === chosen.instrument_type);
  const fields = (type && type.parameter_schema && type.parameter_schema.fields) || [];
  fields.forEach((f) => {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    wrap.innerHTML = `<span>${f.label}</span><input type="${f.type === 'number' ? 'number' : 'text'}" step="any" data-key="${f.key}">`;
    container.appendChild(wrap);
  });
}
document.getElementById('officer-application').addEventListener('change', renderObservationFields);
document.getElementById('officer-use-location').addEventListener('click', () =>
  useLocation(document.getElementById('officer-lat'), document.getElementById('officer-lng'))
);

document.getElementById('officer-photo').addEventListener('change', (e) => {
  const file = e.target.files[0];
  const preview = document.getElementById('officer-photo-preview');
  if (officerPhotoPreviewUrl) URL.revokeObjectURL(officerPhotoPreviewUrl);
  officerPhotoPreviewUrl = null;
  if (!file) return clearPhotoPreview();
  officerPhotoPreviewUrl = URL.createObjectURL(file);
  preview.src = officerPhotoPreviewUrl;
  preview.hidden = false;
});

// ---- suggested routes ----
document.getElementById('load-routes-btn').addEventListener('click', async () => {
  const out = document.getElementById('routes-result');
  out.textContent = 'Loading…';
  try {
    const data = await api('/api/scheduling/preview?radiusKm=15&maxPerCluster=6');
    if (!data.clusters.length) return (out.innerHTML = '<p>No pending applications with location data.</p>');
    out.innerHTML = data.clusters
      .map(
        (cluster, i) =>
          `<div class="route-cluster"><strong>Route ${i + 1}</strong> — ${cluster.length} stop(s)<ul>${cluster
            .map((c) => `<li>${c.instrument_type} · ${c.serial_number} · ${c.location}</li>`)
            .join('')}</ul></div>`
      )
      .join('');
  } catch (err) {
    out.innerHTML = `<p class="err">${err.message}</p>`;
  }
});

// ---- record verification (online direct, or queued offline) ----
async function completeVerification(record) {
  // runs the verification -> certificate chain once we know we have connectivity
  const saved = await api('/api/verifications', { method: 'POST', body: JSON.stringify(toVerificationPayload(record)) });
  const cert = await api('/api/certificates', { method: 'POST', body: JSON.stringify({ verificationId: saved.id }) });
  return cert;
}

async function refreshQueueStatus() {
  const box = document.getElementById('queue-status');
  const queued = await window.offlineQueue.getQueuedSubmissions();
  const owner = getCurrentQueueOwner();
  const owned = owner ? queued.filter((record) => recordBelongsToOwner(record, owner)) : [];
  const pending = owned.filter((record) => !record.syncStatus || record.syncStatus === 'pending');
  const syncing = owned.filter((record) => record.syncStatus === 'syncing');
  const failed = owned.filter((record) => record.syncStatus === 'failed');
  const blocked = queued.filter((record) =>
    !hasQueueOwnership(record) ||
    (recordBelongsToOwner(record, owner) && record.syncStatus === 'blocked')
  );
  if (!pending.length && !syncing.length && !failed.length && !blocked.length) return (box.hidden = true);
  box.hidden = false;
  box.innerHTML = [
    pending.length ? `<strong>${pending.length}</strong> pending` : '',
    syncing.length ? `<strong>${syncing.length}</strong> syncing` : '',
    failed.length ? `<strong>${failed.length}</strong> failed` : '',
    blocked.length ? `<strong>${blocked.length}</strong> queued verification(s) need attention and were not deleted.` : '',
  ].filter(Boolean).join(' · ');
}

// async function drainQueue() {
//   const queued = await window.offlineQueue.getQueuedSubmissions();
//   for (const record of queued) {
//     try {
//       await completeVerification(record);
//       await window.offlineQueue.removeQueuedSubmission(record.clientSubmissionId);
//     } catch {
//       break; // still offline or server unreachable — stop, try again on the next 'online' event
//     }
//   }
//   await refreshQueueStatus();
//   loadApplications();
// }

// -------------------------------- new code -----------------------------------

async function drainQueue() {
  if (queueSyncInProgress) return;

  const owner = getCurrentQueueOwner();
  if (!owner) {
    await refreshQueueStatus();
    return;
  }

  queueSyncInProgress = true;
  await refreshQueueStatus();
  const queued = await window.offlineQueue.getQueuedSubmissions();
  const now = new Date();

  try {
    for (const record of queued) {
      if (!hasQueueOwnership(record)) {
        await window.offlineQueue.updateQueuedSubmission({
          ...record,
          syncStatus: 'blocked',
          lastSyncError: 'Missing queue ownership metadata; this legacy record was not submitted as another user.',
          lastSyncAt: new Date().toISOString(),
        });
        continue;
      }

      if (
        !recordBelongsToOwner(record, owner) ||
        record.syncStatus === 'failed' ||
        record.syncStatus === 'blocked' ||
        record.syncStatus === 'completed' ||
        !canRetryRecord(record, now)
      ) {
        continue;
      }

      const syncingRecord = {
        ...record,
        syncStatus: 'syncing',
        lastSyncAt: new Date().toISOString(),
      };
      await window.offlineQueue.updateQueuedSubmission(syncingRecord);
      await refreshQueueStatus();

      try {
        await completeVerification(syncingRecord);

        await window.offlineQueue.updateQueuedSubmission({
          ...syncingRecord,
          syncStatus: 'completed',
          completedAt: new Date().toISOString(),
          lastSyncError: null,
        });

        await window.offlineQueue.removeQueuedSubmission(
          syncingRecord.clientSubmissionId
        );
      } catch (err) {

        const syncError = classifySyncError(err);
        const retryCount = (syncingRecord.retryCount || 0) + (syncError.retryable ? 1 : 0);
        await window.offlineQueue.updateQueuedSubmission({
          ...syncingRecord,
          syncStatus: syncError.retryable || syncError.needsLogin ? 'pending' : 'failed',
          retryCount,
          nextRetryAt: syncError.retryable ? nextRetryAt(retryCount) : null,
          lastSyncStatus: err?.status || null,
          lastSyncError: syncError.needsLogin
            ? 'Session expired. Log in again as the same user to retry this queued verification.'
            : `${syncError.label}: ${err?.message || 'Sync failed'}`,
          lastSyncAt: new Date().toISOString(),
        });

        if (syncError.retryable) {
          console.log('Queued verification sync will retry:', syncError.label);
          break;
        }

        if (syncError.needsLogin) {
          console.warn('Queued verification sync paused: session expired.');
          break;
        }

        console.error(
          'Queued verification failed:',
          err.status,
          err.message
        );
      }
    }
  } finally {
    queueSyncInProgress = false;
    await refreshQueueStatus();
    loadApplications();
  }
}

window.addEventListener('online', () => {
  document.getElementById('offline-banner').hidden = true;
  drainQueue();
});
window.addEventListener('offline', () => {
  document.getElementById('offline-banner').hidden = false;
});

// document.getElementById('officer-verify-form').addEventListener('submit', async (e) => {
//   e.preventDefault();
//   const out = document.getElementById('officer-result');
//   out.textContent = 'Recording…';
//   try {
//     const observations = {};
//     document.querySelectorAll('#officer-observation-fields [data-key]').forEach((el) => {
//       observations[el.dataset.key] = el.value;
//     });
//     const photoFile = document.getElementById('officer-photo').files[0];

//     const photoData = photoFile
//     ? await fileToDataUrl(photoFile)
//     : null;
//     const record = {
//       applicationId: document.getElementById('officer-application').value,
//       observations,
//       // Photo bytes are not uploaded in this prototype — object storage
//       // (S3/MinIO, per the architecture doc) is the next integration point.
//       // We record that evidence was captured so the workflow is provably real.
//       // photoUrls: photoFile ? [`captured:${photoFile.name}`] : [],
//       photoData,

//       gpsLat: parseFloat(document.getElementById('officer-lat').value),
//       gpsLng: parseFloat(document.getElementById('officer-lng').value),
//       capturedAt: new Date().toISOString(),
//       clientSubmissionId: crypto.randomUUID(),
//     };

//     if (!navigator.onLine) throw new Error('offline');

//     const cert = await completeVerification(record);
//     out.innerHTML = `
//       <p class="ok">Verified and certified.</p>
//       <div class="cert-preview">
//         <img src="${cert.qrDataUrl}" alt="Certificate QR code" width="180" height="180">
//         <a href="${cert.verifyUrl}" target="_blank" rel="noopener">${cert.verifyUrl}</a>
//       </div>`;
//     loadApplications();
//   } catch (err) {
//     // network failure OR navigator.onLine is false — queue it, don't lose the reading
//     const observations = {};
//     document.querySelectorAll('#officer-observation-fields [data-key]').forEach((el) => {
//       observations[el.dataset.key] = el.value;
//     });
//     // const photoFile = document.getElementById('officer-photo').files[0];
//     // await window.offlineQueue.queueSubmission({
//     //   applicationId: document.getElementById('officer-application').value,
//     //   observations,
//     //   photoUrls: photoFile ? [`captured:${photoFile.name}`] : [],
//     //   gpsLat: parseFloat(document.getElementById('officer-lat').value),
//     //   gpsLng: parseFloat(document.getElementById('officer-lng').value),
//     //   capturedAt: new Date().toISOString(),
//     //   clientSubmissionId: crypto.randomUUID(),
//     // });

//     // new changed code 

// const photoFile = document.getElementById('officer-photo').files[0];

// const photoData = photoFile
//   ? await fileToDataUrl(photoFile)
//   : null;

// await window.offlineQueue.queueSubmission({
//   applicationId: document.getElementById('officer-application').value,
//   observations,
//   photoData,
//   gpsLat: parseFloat(document.getElementById('officer-lat').value),
//   gpsLng: parseFloat(document.getElementById('officer-lng').value),
//   capturedAt: new Date().toISOString(),
//   clientSubmissionId: crypto.randomUUID(),
// });

      
//     out.innerHTML = `<p class="ok">No connection — reading saved on this device. It will sync automatically once you're back online.</p>`;
//     refreshQueueStatus();
//   }
// });

// ---------------- new code written by Rishav ---------------------------------
document.getElementById('officer-verify-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const out = document.getElementById('officer-result');
  out.textContent = 'Recording…';

  // 1. Collect observations
  const observations = {};

  document.querySelectorAll('#officer-observation-fields [data-key]').forEach((el) => {
    observations[el.dataset.key] = el.value;
  });

  // 2. Collect photo
  const photoFile = document.getElementById('officer-photo').files[0];

  let photoData = null;

  try {
    photoData = photoFile
      ? await fileToDataUrl(photoFile)
      : null;
  } catch (err) {
    out.innerHTML = `<p class="err">Could not read the selected photo.</p>`;
    return;
  }

  // 3. Create ONE record
  const owner = getCurrentQueueOwner();
  if (!owner) {
    out.innerHTML = `<p class="err">You must be logged in as an officer to record a verification.</p>`;
    return;
  }

  const record = {
    applicationId: document.getElementById('officer-application').value,
    observations,
    photoData,
    gpsLat: parseFloat(document.getElementById('officer-lat').value),
    gpsLng: parseFloat(document.getElementById('officer-lng').value),
    capturedAt: new Date().toISOString(),
    clientSubmissionId: crypto.randomUUID(),
    ...owner,
    syncStatus: 'pending',
  };

  try {
    // 4. Device is offline
    if (!navigator.onLine) {
      const offlineError = new Error('offline');
      offlineError.code = 'OFFLINE';
      throw offlineError;
    }

    // 5. Online → send the SAME record
    const cert = await completeVerification(record);

    out.innerHTML = `
      <p class="ok">Verified and certified.</p>
      <div class="cert-preview">
        <img src="${cert.qrDataUrl}" alt="Certificate QR code" width="180" height="180">
        <a href="${cert.verifyUrl}" target="_blank" rel="noopener">
          ${cert.verifyUrl}
        </a>
      </div>
    `;

    loadApplications();

  } catch (err) {

    const syncError = classifySyncError(err);

    // 7. Backend errors like 400 / 401 / 403 / 404
    // should NOT be treated as offline
    if (!syncError.retryable) {
      out.innerHTML = `
        <p class="err">
          ${err.message || 'Verification failed.'}
        </p>
      `;
      return;
    }

    // 8. Genuine offline/network error
    // Save the SAME record in IndexedDB
    try {
      await window.offlineQueue.queueSubmission({
        ...record,
        lastSyncStatus: err?.status || null,
        lastSyncError: `${syncError.label}: ${err?.message || 'Sync pending'}`,
        lastSyncAt: new Date().toISOString(),
      });

      out.innerHTML = `
        <p class="ok">
          No connection — reading saved on this device.
          It will sync automatically once you're back online.
        </p>
      `;

      refreshQueueStatus();

    } catch (queueErr) {
      out.innerHTML = `
        <p class="err">
          Could not save the reading on this device.
          Please try again.
        </p>
      `;

      console.error('Offline queue error:', queueErr);
    }
  }
});

// ================= Verify =================
document.getElementById('verify-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  runVerify(document.getElementById('verify-input').value.trim());
});

async function runVerify(raw) {
  const out = document.getElementById('verify-result');
  out.textContent = 'Checking…';
  let token = raw;
  const match = raw.match(/[?&]t=([^&]+)/);
  if (match) token = decodeURIComponent(match[1]);
  try {
    const result = await api(`/api/verify?t=${encodeURIComponent(token)}`, { skipAuth: true });
    renderCertificateCard(result);
  } catch (err) {
    out.innerHTML = `<p class="err">${err.message}</p>`;
  }
}

function renderCertificateCard(result) {
  const out = document.getElementById('verify-result');
  const sealClass = result.valid ? 'seal-valid' : 'seal-invalid';
  const sealLabel = result.valid ? '✓' : '✕';
  const p = result.payload;
  out.innerHTML = `
    <div class="cert-card">
      <div class="seal ${sealClass}">${sealLabel}</div>
      <h3>${result.valid ? 'Valid certificate' : 'Not valid'}</h3>
      <p class="reason">${result.reason}</p>
      ${
        p
          ? `<dl>
              <dt>Certificate ID</dt><dd>${p.certId}</dd>
              <dt>Instrument</dt><dd>${p.instrumentType} · ${p.instrumentSerial}</dd>
              <dt>Verified</dt><dd>${p.verifiedDate}</dd>
              <dt>Valid until</dt><dd>${p.expiryDate}</dd>
            </dl>`
          : ''
      }
    </div>`;
}

// ================= Admin =================
document.getElementById('import-instruments-btn').addEventListener('click', async () => {
  const out = document.getElementById('import-instruments-result');
  out.textContent = 'Importing…';
  try {
    const result = await api('/api/import/instruments', {
      method: 'POST',
      body: JSON.stringify({ csv: document.getElementById('import-instruments-csv').value }),
    });
    out.innerHTML = `<p class="ok">Imported ${result.imported}, skipped ${result.skipped}.</p>` +
      (result.errors.length ? `<pre>${JSON.stringify(result.errors, null, 2)}</pre>` : '');
  } catch (err) {
    out.innerHTML = `<p class="err">${err.message}</p>`;
  }
});

document.getElementById('import-stakeholders-btn').addEventListener('click', async () => {
  const out = document.getElementById('import-stakeholders-result');
  out.textContent = 'Importing…';
  try {
    const result = await api('/api/import/stakeholders', {
      method: 'POST',
      body: JSON.stringify({ csv: document.getElementById('import-stakeholders-csv').value }),
    });
    out.innerHTML = `<p class="ok">Imported ${result.imported}, skipped ${result.skipped}.</p>` +
      (result.errors.length ? `<pre>${JSON.stringify(result.errors, null, 2)}</pre>` : '');
  } catch (err) {
    out.innerHTML = `<p class="err">${err.message}</p>`;
  }
});

// ================= boot =================
(async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  applySessionToUI();
  await loadInstrumentTypes();
  // if (!navigator.onLine) document.getElementById('offline-banner').hidden = false;
  // refreshQueueStatus();

  if (!navigator.onLine) {
  document.getElementById('offline-banner').hidden = false;
  } else {
  drainQueue();
}

refreshQueueStatus();

  const params = new URLSearchParams(window.location.search);
  if (params.get('t')) {
    switchTab('verify');
    document.getElementById('verify-input').value = params.get('t');
    runVerify(params.get('t'));
  }
})();
