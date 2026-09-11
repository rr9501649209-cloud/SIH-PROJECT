// backend/server.ts
import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { Pool } from 'pg';
import crypto from 'crypto';
import QRCode from 'qrcode';
import { parse as parseCsv } from 'csv-parse/sync';
import { authenticate, requireRole, signSession, AuthedRequest } from './middleware/auth';
import { clusterByProximity } from './lib/geo';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const certEngine = require('./certificate-engine.js') as {
  issueCertificate: (cert: Record<string, string>, privateKeyPem: string) => string;
  verifyCertificate: (
    token: string,
    publicKeyPem: string
  ) => { valid: boolean; reason: string; payload?: Record<string, string> };
};

const PORT = process.env.PORT || 3000;
const PUBLIC_VERIFY_BASE = process.env.PUBLIC_VERIFY_BASE || `http://localhost:${PORT}/verify`;
const SIGNING_KEY_ID = 'authority-2026-v1';

const privateKey = fs.readFileSync(path.join(__dirname, 'keys', 'authority-private.pem'), 'utf8');
const publicKey = fs.readFileSync(path.join(__dirname, 'keys', 'authority-public.pem'), 'utf8');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:sih26036@localhost:5432/sih26036',
});

const app = express();
const uploadsDir = path.join(__dirname, 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use('/uploads', express.static(uploadsDir));

// ================= public =================

app.get('/api/health', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch {
    res.status(500).json({ status: 'error', db: 'unreachable' });
  }
});

app.get('/api/instrument-types', async (_req: Request, res: Response) => {
  const result = await pool.query(
    'SELECT id, name, category, parameter_schema, default_validity_days FROM instrument_types ORDER BY name'
  );
  res.json(result.rows);
});

app.post('/api/stakeholders', async (req: Request, res: Response) => {
  const { role, name, phone, email, state, district, preferredLang, sourceRegistry } = req.body;
  if (!role || !name || !phone || !state || !district) {
    return res.status(400).json({ error: 'role, name, phone, state, district are required' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO stakeholders (role, name, phone, email, state, district, preferred_lang, source_registry)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'en'),$8) RETURNING *`,
      [role, name, phone, email || null, state, district, preferredLang || null, sourceRegistry || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'phone already registered' });
    throw err;
  }
});

// Simplified login: phone lookup only. In production this is preceded by a
// real OTP send/verify (or DigiLocker/Aadhaar eKYC) — see middleware/auth.ts.
app.post('/api/auth/login', async (req: Request, res: Response) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  const result = await pool.query('SELECT id, role, name, phone FROM stakeholders WHERE phone=$1 LIMIT 1', [phone]);
  if (!result.rows.length) return res.status(404).json({ error: 'No stakeholder registered with this phone number' });
  const stakeholder = result.rows[0];
  const token = signSession(stakeholder.id, stakeholder.role);
  res.json({ token, stakeholder });
});

app.get('/api/verify', async (req: Request, res: Response) => {
  const token = String(req.query.t || '');
  if (!token) return res.status(400).json({ valid: false, reason: 'missing token' });

  const cryptoResult = certEngine.verifyCertificate(token, publicKey);
  if (!cryptoResult.valid) return res.json(cryptoResult);

  const dbRow = await pool.query('SELECT revoked FROM certificates WHERE signed_token = $1', [token]);
  if (dbRow.rows.length === 0) {
    return res.json({ valid: false, reason: 'Signature is authentic but this certificate is not on record' });
  }
  if (dbRow.rows[0].revoked) {
    return res.json({
      valid: false,
      reason: 'Certificate has been revoked by the issuing authority',
      payload: cryptoResult.payload,
    });
  }
  res.json(cryptoResult);
});

// ================= authenticated (any registered stakeholder) =================

app.post('/api/instruments', authenticate, async (req: AuthedRequest, res: Response) => {
  const {
    serialNumber,
    instrumentTypeId,
    location,
    latitude,
    longitude,
  } = req.body;

  if (!serialNumber || !instrumentTypeId || !location) {
    return res.status(400).json({
      error: 'serialNumber, instrumentTypeId, location are required',
    });
  }

  if (!req.user) {
    return res.status(401).json({
      error: 'Not authenticated',
    });
  }

  const ownerId = req.user.id;

  try {
    const result = await pool.query(
      `INSERT INTO instruments
        (serial_number, owner_id, instrument_type_id, location, latitude, longitude)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        serialNumber,
        ownerId,
        instrumentTypeId,
        location,
        latitude ?? null,
        longitude ?? null,
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'serialNumber already registered',
      });
    }

    throw err;
  }
});

app.post('/api/applications', authenticate, async (req: AuthedRequest, res: Response) => {
  const { instrumentId } = req.body;

  if (!instrumentId) {
    return res.status(400).json({
      error: 'instrumentId is required',
    });
  }

  if (!req.user) {
    return res.status(401).json({
      error: 'Not authenticated',
    });
  }

  const applicantId = req.user.id;

  try {
    // Make sure the instrument belongs to the logged-in user
    const instrumentResult = await pool.query(
      `SELECT id
       FROM instruments
       WHERE id = $1 AND owner_id = $2`,
      [instrumentId, applicantId]
    );

    if (instrumentResult.rows.length === 0) {
      return res.status(403).json({
        error: 'You can only create an application for your own instrument',
      });
    }

    const result = await pool.query(
      `INSERT INTO applications
        (applicant_id, instrument_id)
       VALUES ($1, $2)
       RETURNING *`,
      [applicantId, instrumentId]
    );

    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: 'Application already exists for this instrument',
      });
    }

    throw err;
  }
});

// ================= officers only (LMO / GATC) =================

const OFFICER_ROLES = ['LMO', 'GATC', 'STATE_ADMIN', 'CENTRAL_ADMIN'];

function applicationScopeWhere(req: AuthedRequest, applicantAlias = 's') {
  return {
    clause: `(
      $1 = 'CENTRAL_ADMIN'
      OR ($1 = 'STATE_ADMIN' AND ${applicantAlias}.state = current_user_scope.state)
      OR ($1 IN ('LMO', 'GATC') AND ${applicantAlias}.state = current_user_scope.state AND ${applicantAlias}.district = current_user_scope.district)
    )`,
    params: [req.user!.role, req.user!.id],
  };
}

app.get('/api/applications', authenticate, requireRole(...OFFICER_ROLES), async (req: AuthedRequest, res: Response) => {
  const scope = applicationScopeWhere(req);
  const result = await pool.query(
    `SELECT a.id, a.status, a.submitted_at,
            i.serial_number, i.location, it.name AS instrument_type,
            s.name AS applicant_name
     FROM applications a
     JOIN instruments i ON i.id = a.instrument_id
     JOIN instrument_types it ON it.id = i.instrument_type_id
     JOIN stakeholders s ON s.id = a.applicant_id
     JOIN stakeholders current_user_scope ON current_user_scope.id = $2
     WHERE ${scope.clause}
     ORDER BY a.submitted_at DESC`,
    scope.params
  );
  res.json(result.rows);
});

// app.post('/api/verifications', authenticate, requireRole('LMO', 'GATC'), async (req: AuthedRequest, res: Response) => {
//   const { applicationId, observations, photoUrls, gpsLat, gpsLng, capturedAt, clientSubmissionId } = req.body;
//   if (!applicationId || !observations || gpsLat == null || gpsLng == null || !capturedAt || !clientSubmissionId) {
//     return res.status(400).json({
//       error: 'applicationId, observations, gpsLat, gpsLng, capturedAt, clientSubmissionId are required',
//     });
//   }

//   // idempotent: an offline-queued submission replayed on sync must not double-write
//   const existing = await pool.query('SELECT * FROM verification_records WHERE client_submission_id = $1', [
//     clientSubmissionId,
//   ]);

//     // Make sure the application exists and is eligible for verification
//   const applicationResult = await pool.query(
//     `SELECT id, status
//      FROM applications
//      WHERE id = $1`,
//     [applicationId]
//   );

//   if (applicationResult.rows.length === 0) {
//     return res.status(404).json({
//       error: 'Application not found',
//     });
//   }

//   const application = applicationResult.rows[0];

//   if (application.status === 'VERIFIED') {
//     return res.status(409).json({
//       error: 'Application has already been verified',
//     });
//   }

//   if (application.status === 'REJECTED') {
//     return res.status(409).json({
//       error: 'Rejected application cannot be verified',
//     });
//   }

//   if (existing.rows.length > 0) {
//     return res.status(200).json({ ...existing.rows[0], deduped: true });
//   }

//   const result = await pool.query(
//     `INSERT INTO verification_records
//       (application_id, observations, photo_urls, gps_lat, gps_lng, captured_at, client_submission_id)
//      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
//     [applicationId, JSON.stringify(observations), photoUrls || [], gpsLat, gpsLng, capturedAt, clientSubmissionId]
//   );
//   await pool.query(`UPDATE applications SET status = 'IN_PROGRESS' WHERE id = $1`, [applicationId]);
//   res.status(201).json(result.rows[0]);
// });

// NEW CODE FOR VERIFICATION 

app.post(
  '/api/verifications',
  authenticate,
  requireRole('LMO', 'GATC'),
  async (req: AuthedRequest, res: Response) => {
    const {
      applicationId,
      observations,
      photoData,
      gpsLat,
      gpsLng,
      capturedAt,
      clientSubmissionId,
    } = req.body;

    if (
      !applicationId ||
      !observations ||
      gpsLat == null ||
      gpsLng == null ||
      !capturedAt ||
      !clientSubmissionId
    ) {
      return res.status(400).json({
        error:
          'applicationId, observations, gpsLat, gpsLng, capturedAt, clientSubmissionId are required',
      });
    }

    // Validate GPS coordinates
    if (
      typeof gpsLat !== 'number' ||
      typeof gpsLng !== 'number' ||
      gpsLat < -90 ||
      gpsLat > 90 ||
      gpsLng < -180 ||
      gpsLng > 180
    ) {
      return res.status(400).json({
        error: 'Invalid GPS coordinates',
      });
    }

    const scope = applicationScopeWhere(req);
    const applicationResult = await pool.query(
      `SELECT a.id, a.status
       FROM applications a
       JOIN stakeholders s ON s.id = a.applicant_id
       JOIN stakeholders current_user_scope ON current_user_scope.id = $2
       WHERE a.id = $3 AND ${scope.clause}`,
      [...scope.params, applicationId]
    );

    if (applicationResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Application not found',
      });
    }

    const application = applicationResult.rows[0];

    if (application.status === 'VERIFIED') {
      return res.status(409).json({
        error: 'Application has already been verified',
      });
    }

    if (application.status === 'REJECTED') {
      return res.status(409).json({
        error: 'Rejected application cannot be verified',
      });
    }

    // Idempotency: don't create duplicate verification records
    // when the same offline submission is replayed.
    const existing = await pool.query(
      'SELECT * FROM verification_records WHERE client_submission_id = $1 AND application_id = $2',
      [clientSubmissionId, applicationId]
    );

    if (existing.rows.length > 0) {
      return res.status(200).json({
        ...existing.rows[0],
        deduped: true,
      });
    }

    let photoUrls: string[] = [];

    // Handle actual photo upload
    if (photoData) {
      if (typeof photoData !== 'string') {
        return res.status(400).json({
          error: 'Invalid photo data',
        });
      }

      const match = photoData.match(
        /^data:(image\/jpeg|image\/png|image\/webp);base64,(.+)$/
      );

      if (!match) {
        return res.status(400).json({
          error: 'Photo must be JPEG, PNG, or WebP',
        });
      }

      const mimeType = match[1];
      const base64Data = match[2];

      const extension =
        mimeType === 'image/jpeg'
          ? 'jpg'
          : mimeType === 'image/png'
            ? 'png'
            : 'webp';

      const imageBuffer = Buffer.from(base64Data, 'base64');

      const MAX_PHOTO_SIZE = 2 * 1024 * 1024;

      if (imageBuffer.length > MAX_PHOTO_SIZE) {
        return res.status(400).json({
          error: 'Photo size must be 2 MB or less',
        });
      }

      const fileName = `${crypto.randomUUID()}.${extension}`;
      const filePath = path.join(uploadsDir, fileName);

      fs.writeFileSync(filePath, imageBuffer);

      photoUrls.push(`/uploads/${fileName}`);
    }

    const result = await pool.query(
      `INSERT INTO verification_records
        (application_id, observations, photo_urls, gps_lat, gps_lng, captured_at, client_submission_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        applicationId,
        JSON.stringify(observations),
        photoUrls,
        gpsLat,
        gpsLng,
        capturedAt,
        clientSubmissionId,
      ]
    );

    await pool.query(
      `UPDATE applications SET status = 'IN_PROGRESS' WHERE id = $1`,
      [applicationId]
    );

    res.status(201).json(result.rows[0]);
  }
);

app.post('/api/certificates', authenticate, requireRole('LMO', 'GATC'), async (req: AuthedRequest, res: Response) => {
  const { verificationId } = req.body;
  if (!verificationId) return res.status(400).json({ error: 'verificationId is required' });

  const scope = applicationScopeWhere(req);
  const vr = await pool.query(
    `SELECT vr.id AS verification_id, a.id AS application_id, i.serial_number, it.name AS instrument_type,
            it.default_validity_days
     FROM verification_records vr
     JOIN applications a ON a.id = vr.application_id
     JOIN instruments i ON i.id = a.instrument_id
     JOIN instrument_types it ON it.id = i.instrument_type_id
     JOIN stakeholders s ON s.id = a.applicant_id
     JOIN stakeholders current_user_scope ON current_user_scope.id = $2
     WHERE vr.id = $3 AND ${scope.clause}`,
    [...scope.params, verificationId]
  );
  if (vr.rows.length === 0) return res.status(404).json({ error: 'verification record not found' });
  const row = vr.rows[0];

  // already-issued? return the existing certificate instead of a duplicate
  const already = await pool.query('SELECT * FROM certificates WHERE verification_id=$1', [verificationId]);
  if (already.rows.length) {
    const verifyUrl = `${PUBLIC_VERIFY_BASE}?t=${already.rows[0].signed_token}`;
    const qrDataUrl = await QRCode.toDataURL(verifyUrl, { errorCorrectionLevel: 'M', width: 320 });
    return res.status(200).json({ ...already.rows[0], verifyUrl, qrDataUrl, deduped: true });
  }

  const verifiedDate = new Date();
  const expiryDate = new Date(verifiedDate.getTime() + row.default_validity_days * 24 * 60 * 60 * 1000);
  const certId = `CERT-${verifiedDate.getFullYear()}-${row.verification_id.slice(0, 8).toUpperCase()}`;

  const token = certEngine.issueCertificate(
    {
      certId,
      instrumentSerial: row.serial_number,
      instrumentType: row.instrument_type,
      verifiedDate: verifiedDate.toISOString().slice(0, 10),
      expiryDate: expiryDate.toISOString().slice(0, 10),
      officerId: req.user!.id,
    },
    privateKey
  );

  const insert = await pool.query(
    `INSERT INTO certificates (verification_id, verified_date, expiry_date, signed_token, signing_key_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [verificationId, verifiedDate, expiryDate, token, SIGNING_KEY_ID]
  );
  await pool.query(`UPDATE applications SET status = 'VERIFIED' WHERE id = $1`, [row.application_id]);

  const verifyUrl = `${PUBLIC_VERIFY_BASE}?t=${token}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, { errorCorrectionLevel: 'M', width: 320 });
  res.status(201).json({ ...insert.rows[0], verifyUrl, qrDataUrl });
});

// ---- geo-clustered scheduling ----

app.get(
  '/api/scheduling/preview',
  authenticate,
  requireRole(...OFFICER_ROLES),
  async (req: AuthedRequest, res: Response) => {
    const radiusKm = parseFloat(String(req.query.radiusKm || '')) || 15;
    const maxPerCluster = parseInt(String(req.query.maxPerCluster || ''), 10) || 6;
    const scope = applicationScopeWhere(req);
    const result = await pool.query(
      `
      SELECT a.id, a.status, i.serial_number, i.location,
             i.latitude AS lat, i.longitude AS lng, it.name AS instrument_type
      FROM applications a
      JOIN instruments i ON i.id = a.instrument_id
      JOIN instrument_types it ON it.id = i.instrument_type_id
      JOIN stakeholders s ON s.id = a.applicant_id
      JOIN stakeholders current_user_scope ON current_user_scope.id = $2
      WHERE a.status = 'SUBMITTED'
        AND i.latitude IS NOT NULL
        AND i.longitude IS NOT NULL
        AND ${scope.clause}
    `,
      scope.params
    );
    const clusters = clusterByProximity(result.rows as any, radiusKm, maxPerCluster);
    res.json({ radiusKm, maxPerCluster, clusterCount: clusters.length, clusters });
  }
);

app.post(
  '/api/scheduling/assign',
  authenticate,
  requireRole(...OFFICER_ROLES),
  async (req: AuthedRequest, res: Response) => {
    const { applicationIds, officerId, plannedDate } = req.body;

    if (!Array.isArray(applicationIds) || !applicationIds.length || !officerId || !plannedDate) {
      return res.status(400).json({
        error: 'applicationIds[], officerId, plannedDate are required',
      });
    }

    // Make sure the assigned person is actually an officer
    const officerResult = await pool.query(
      `SELECT id, role
       FROM stakeholders
       WHERE id = $1
         AND role IN ('LMO', 'GATC')`,
      [officerId]
    );

    if (officerResult.rows.length === 0) {
      return res.status(400).json({
        error: 'Invalid officerId. Officer must be a registered LMO or GATC.',
      });
    }

    const routeClusterId = `ROUTE-${plannedDate}-${Math.random().toString(36).slice(2, 7)}`;

    const created = [];

    for (const appId of applicationIds) {
      const r = await pool.query(
        `INSERT INTO schedule_slots (application_id, officer_id, planned_date, route_cluster_id)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [appId, officerId, plannedDate, routeClusterId]
      );

      await pool.query(
        `UPDATE applications SET status='SCHEDULED' WHERE id=$1`,
        [appId]
      );

      created.push(r.rows[0]);
    }

    res.status(201).json({
      routeClusterId,
      slots: created,
    });
  }
);

// ---- bulk import (legacy cold-start + GATC/LMO roster federation) ----

app.post(
  '/api/import/instruments',
  authenticate,
  requireRole('STATE_ADMIN', 'CENTRAL_ADMIN'),
  async (req: AuthedRequest, res: Response) => {
    const csvText = req.body.csv;
    if (!csvText) return res.status(400).json({ error: 'body must be { "csv": "..." } — see README for columns' });
    const records = parseCsv(csvText, { columns: true, skip_empty_lines: true, trim: true }) as any[];
    const results = { imported: 0, skipped: 0, errors: [] as { row: number; error: string }[] };

    for (let idx = 0; idx < records.length; idx++) {
      const row = records[idx];
      try {
        let ownerId: string;
        const owner = await pool.query('SELECT id FROM stakeholders WHERE phone=$1', [row.ownerPhone]);
        if (owner.rows.length) {
          ownerId = owner.rows[0].id;
        } else {
          const createdOwner = await pool.query(
            `INSERT INTO stakeholders (role,name,phone,state,district) VALUES ('APPLICANT',$1,$2,$3,$4) RETURNING id`,
            [row.ownerName, row.ownerPhone, row.state, row.district]
          );
          ownerId = createdOwner.rows[0].id;
        }
        const type = await pool.query('SELECT id FROM instrument_types WHERE name=$1', [row.instrumentType]);
        if (!type.rows.length) throw new Error(`Unknown instrument type: ${row.instrumentType}`);
        await pool.query(
          `INSERT INTO instruments (serial_number, owner_id, instrument_type_id, location, latitude, longitude)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (serial_number) DO NOTHING`,
          [row.serialNumber, ownerId, type.rows[0].id, row.location, row.latitude || null, row.longitude || null]
        );
        results.imported++;
      } catch (err: any) {
        results.errors.push({ row: idx + 1, error: err.message });
        results.skipped++;
      }
    }
    res.json(results);
  }
);

app.post(
  '/api/import/stakeholders',
  authenticate,
  requireRole('STATE_ADMIN', 'CENTRAL_ADMIN'),
  async (req: AuthedRequest, res: Response) => {
    const csvText = req.body.csv;
    if (!csvText) return res.status(400).json({ error: 'body must be { "csv": "..." } — see README for columns' });
    const records = parseCsv(csvText, { columns: true, skip_empty_lines: true, trim: true }) as any[];
    const results = { imported: 0, skipped: 0, errors: [] as { row: number; error: string }[] };

    for (let idx = 0; idx < records.length; idx++) {
      const row = records[idx];
      try {
        await pool.query(
          `INSERT INTO stakeholders (role,name,phone,state,district,source_registry)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [row.role, row.name, row.phone, row.state, row.district, row.sourceRegistry || 'bulk-import']
        );
        results.imported++;
      } catch (err: any) {
        results.errors.push({ row: idx + 1, error: err.message });
        results.skipped++;
      }
    }
    res.json(results);
  }
);

// ================= frontend =================

app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('/verify', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`SIH26036 backend running on http://localhost:${PORT}`);
});
