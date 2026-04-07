console.log("certificateRoutes.js loaded");

import express from "express";
import pool from "../db/postgres.js";
import fs from "fs";
import {
  generateQuizCertificate,
  issueExamCertificate,
  resolveExamByName
} from "../controllers/certificate.controller.js";
import generatePDF from "../utils/generateCertificate.js";
import {
  downloadCertificatePdfFromSupabase,
  uploadCertificatePdfFileToSupabase,
  removeLocalFileSafe,
} from "../services/supabaseStorage.service.js";
import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";

const router = express.Router();

const ensureCertificateSettingsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS certificate_settings (
      id INTEGER PRIMARY KEY DEFAULT 1,
      title TEXT,
      logo_url TEXT,
      template_url TEXT,
      signature_url TEXT,
      authority_name TEXT,
      issuer_name TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT certificate_settings_singleton CHECK (id = 1)
    )
  `);
};

const mapSettingsFromDb = (row = {}) => ({
  title: row.title || "Certificate of Achievement",
  logoUrl: row.logo_url || "",
  templateUrl: row.template_url || "",
  signatureUrl: row.signature_url || "",
  authorityName: row.authority_name || "Director of Education",
  issuerName: row.issuer_name || "Shnoor LMS",
});

router.get("/settings/config", async (_req, res) => {
  try {
    await ensureCertificateSettingsTable();

    const result = await pool.query(
      `SELECT * FROM certificate_settings WHERE id = 1 LIMIT 1`
    );

    if (!result.rows.length) {
      return res.json(mapSettingsFromDb());
    }

    return res.json(mapSettingsFromDb(result.rows[0]));
  } catch (err) {
    console.error("GET /settings/config error:", err.message);
    return res.status(500).json({ message: "Failed to load certificate configuration" });
  }
});

router.post(
  "/settings/config",
  firebaseAuth,
  attachUser,
  roleGuard("admin"),
  async (req, res) => {
    try {
      await ensureCertificateSettingsTable();

      const {
        title,
        logoUrl,
        templateUrl,
        signatureUrl,
        authorityName,
        issuerName,
      } = req.body || {};

      await pool.query(
        `
        INSERT INTO certificate_settings
          (id, title, logo_url, template_url, signature_url, authority_name, issuer_name, updated_at)
        VALUES
          (1, $1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
        ON CONFLICT (id)
        DO UPDATE SET
          title = EXCLUDED.title,
          logo_url = EXCLUDED.logo_url,
          template_url = EXCLUDED.template_url,
          signature_url = EXCLUDED.signature_url,
          authority_name = EXCLUDED.authority_name,
          issuer_name = EXCLUDED.issuer_name,
          updated_at = CURRENT_TIMESTAMP
        `,
        [
          title || null,
          logoUrl || null,
          templateUrl || null,
          signatureUrl || null,
          authorityName || null,
          issuerName || null,
        ]
      );

      return res.json({ success: true, message: "Configuration saved" });
    } catch (err) {
      console.error("POST /settings/config error:", err.message);
      return res.status(500).json({ message: "Failed to save certificate configuration" });
    }
  }
);

router.get(
  "/download/:certificate_id",
  firebaseAuth,
  attachUser,
  async (req, res) => {
    try {
      const { certificate_id } = req.params;
      const rawCertificateId = String(certificate_id || "").trim();
      const certIdWithPdf = /\.pdf$/i.test(rawCertificateId)
        ? rawCertificateId
        : `${rawCertificateId}.pdf`;

      const certRes = await pool.query(
        `
        SELECT c.id, c.user_id, c.certificate_id, c.exam_name, c.score
        FROM certificates c
        JOIN exams e ON e.exam_id = c.exam_id
          WHERE (c.certificate_id = $1
            OR c.certificate_id = $2)
          AND e.exam_type = 'exam'
        LIMIT 1
        `,
        [rawCertificateId, certIdWithPdf]
      );

      if (!certRes.rows.length) {
        return res.status(404).json({ message: "Certificate not found" });
      }

      const cert = certRes.rows[0];
      const isOwner = String(cert.user_id) === String(req.user.id);
      const isAdmin = req.user.role === "admin";

      if (!isOwner && !isAdmin) {
        return res.status(403).json({ message: "Access denied" });
      }

      const userRes = await pool.query(
        `SELECT full_name FROM users WHERE user_id = $1 LIMIT 1`,
        [cert.user_id]
      );

      const settingsRes = await pool.query(
        `SELECT title, logo_url, template_url, signature_url, authority_name, issuer_name FROM certificate_settings WHERE id = 1 LIMIT 1`
      ).catch(() => ({ rows: [] }));

      const settings = settingsRes.rows[0] || {};
      const verifyBase = process.env.CERTIFICATE_VERIFY_BASE_URL || process.env.FRONTEND_URL || "http://localhost:5173";
      const verifyUrl = `${String(verifyBase).replace(/\/$/, "")}/verify/${cert.certificate_id}`;

      const normalizedCertId = String(cert.certificate_id || rawCertificateId).replace(/\.pdf$/i, "");

      let pdfBuffer = await downloadCertificatePdfFromSupabase(normalizedCertId);

      if (!pdfBuffer) {
        const generated = await generatePDF(
          cert.exam_name || "Certificate",
          Number(cert.score || 0),
          cert.user_id,
          Number(cert.score || 0),
          userRes.rows[0]?.full_name || "Student",
          {
            certificateId: normalizedCertId,
            verifyUrl,
            title: settings.title || null,
            logoUrl: settings.logo_url || null,
            templateUrl: settings.template_url || null,
            signatureUrl: settings.signature_url || null,
            authorityName: settings.authority_name || null,
            issuerName: settings.issuer_name || null,
          }
        );

        if (!generated?.generated || !generated?.filePath) {
          return res.status(500).json({ message: "Failed to generate certificate PDF" });
        }

        await uploadCertificatePdfFileToSupabase(generated.filePath, normalizedCertId);
        pdfBuffer = await fs.promises.readFile(generated.filePath);
        await removeLocalFileSafe(generated.filePath);
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(pdfBuffer.length));
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=certificate_${String(cert.exam_name || "certificate").replace(/[^a-z0-9_\- ]/gi, "")}.pdf`
      );
      res.end(pdfBuffer);

      return;
    } catch (err) {
      console.error("GET /download/:certificate_id error:", err.message);
      return res.status(500).json({ message: err.message || "Failed to download certificate" });
    }
  }
);

// ---------------------------
// POST → Add certificate data
// ---------------------------
router.post("/add", async (req, res) => {
  try {
    const { user_id, exam_name, score, certificate_id } = req.body;

    // basic validation
    if (!user_id || !exam_name || score === undefined) {
      return res.status(400).json({
        message: "user_id, exam_name and score are required",
      });
    }

    const exam = await resolveExamByName(exam_name);

    if (!exam) {
      return res.status(404).json({ message: "Exam not found" });
    }

    const exam_id = exam.exam_id;

    const certificateResult = await issueExamCertificate({
      userId: user_id,
      examId: exam_id,
      score
    });

    if (!certificateResult.issued) {
      const reason = certificateResult.reason || "not_eligible";
      const messageMap = {
        coding_present: "Coding questions are not eligible for certificates yet",
        not_passed: "Score below pass percentage. Certificate not eligible.",
        not_exam_type: "Certificates are issued only for exams, not contests",
        already_issued: "Certificate already issued for this exam",
        certificate_id_conflict: "Please retry certificate generation",
        pdf_failed: "PDF generation failed",
        pdf_upload_failed: "Certificate storage upload failed"
      };

      return res.status(400).json({
        generated: false,
        message: messageMap[reason] || "Certificate not eligible"
      });
    }

    if (certificate_id) {
      await pool.query(
        `
        UPDATE certificates
        SET certificate_id = $1
        WHERE user_id = $2 AND exam_id = $3
        `,
        [certificate_id, user_id, exam_id]
      );
    }

    res.status(201).json({
      message: "Certificate generated successfully",
      generated: true,
      data: certificateResult.certificate,
      filePath: certificateResult.filePath
    });
  } catch (err) {
    console.error("POST /add error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------
// GET → Fetch my certificates (authenticated user) - MUST come before /:user_id
// ---------------------------
router.get(
  "/my",
  firebaseAuth,
  attachUser,
  async (req, res) => {
    try {
      const userId = req.user.id;

      if (!userId) {
        return res.status(401).json({
          message: "Unauthorized: user ID not found"
        });
      }

      const result = await pool.query(
        `SELECT c.*
         FROM certificates c
         JOIN exams e ON e.exam_id = c.exam_id
         WHERE c.user_id = $1
           AND e.exam_type = 'exam'
         ORDER BY issued_at DESC`,
        [userId]
      );

      res.json(result.rows);
    } catch (err) {
      console.error("GET /my error:", err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

router.get("/verify/:certificate_id", async (req, res) => {
  try {
    const { certificate_id } = req.params;

    if (!certificate_id) {
      return res.status(400).json({ message: "certificate_id is required" });
    }

    const result = await pool.query(
      `
      SELECT
        c.id,
        c.certificate_id,
        c.exam_name,
        c.score,
        c.issued_at,
        u.full_name AS student_name
      FROM certificates c
      LEFT JOIN users u ON u.user_id = c.user_id
      JOIN exams e ON e.exam_id = c.exam_id
      WHERE c.certificate_id = $1
        AND e.exam_type = 'exam'
      LIMIT 1
      `,
      [certificate_id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Invalid certificate" });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error("GET /verify/:certificate_id error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------
// GET → Fetch certificate by user_id
// ---------------------------
router.get("/:user_id", async (req, res) => {
  try {
    const { user_id } = req.params;

    // Update any certificates with null or zero scores
    await pool.query(
      `UPDATE certificates 
       SET score = CASE 
         WHEN exam_name LIKE '%Quiz%' THEN 80 
         ELSE 90 
       END
       WHERE score IS NULL OR score = 0`
    );

    const result = await pool.query(
      `SELECT c.*
       FROM certificates c
       JOIN exams e ON e.exam_id = c.exam_id
       WHERE e.exam_type = 'exam'
         AND (
           c.user_id::text = $1 
           OR c.user_id::text = (SELECT firebase_uid FROM users WHERE user_id::text = $1 OR firebase_uid = $1)
         )`,
      [user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Certificate not found for this user",
      });
    }

    // Return all certificates for the user
    res.json(result.rows);
  } catch (err) {
    console.error("GET /:user_id error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------
// POST → Generate quiz certificate
// ---------------------------
router.post(
  "/quiz/generate",
  firebaseAuth,
  attachUser,
  generateQuizCertificate
);

export default router;