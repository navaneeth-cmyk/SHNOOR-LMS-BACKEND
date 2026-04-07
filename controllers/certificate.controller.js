import pool from "../db/postgres.js";
import generatePDF from "../utils/generateCertificate.js";
import path from "path";
import { fileURLToPath } from "url";
import {
  uploadPdfFileToS3,
  removeLocalFileSafe,
} from "../services/s3Storage.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("CERTIFICATE CONTROLLER LOADED");

const PRACTICE_QUIZ_ALIASES = [
  "PRACTICE QUIZ",
  "Practice Quiz",
  "React Fundamentals Quiz",
];

const normalizeExamName = (examName) => String(examName || "").trim();

const resolveExamByName = async (examName) => {
  const normalizedName = normalizeExamName(examName);

  if (!normalizedName) {
    return null;
  }

  const exactMatch = await pool.query(
    `SELECT exam_id, title FROM exams WHERE title = $1 AND exam_type = 'exam' LIMIT 1`,
    [normalizedName]
  );

  if (exactMatch.rows.length > 0) {
    return exactMatch.rows[0];
  }

  if (PRACTICE_QUIZ_ALIASES.includes(normalizedName)) {
    const practiceMatch = await pool.query(
      `SELECT exam_id, title FROM exams WHERE title = ANY($1::text[]) AND exam_type = 'exam' LIMIT 1`,
      [PRACTICE_QUIZ_ALIASES]
    );

    if (practiceMatch.rows.length > 0) {
      return practiceMatch.rows[0];
    }

    // Auto-create the PRACTICE QUIZ exam record if it doesn't exist in the DB
    const insertResult = await pool.query(`
      INSERT INTO exams (title, description, duration, pass_percentage, exam_type)
      SELECT 'PRACTICE QUIZ', 'General practice assessment for students.', 30, 40, 'exam'
      WHERE NOT EXISTS (SELECT 1 FROM exams WHERE title = 'PRACTICE QUIZ')
      RETURNING exam_id, title
    `);

    if (insertResult.rows.length > 0) {
      return insertResult.rows[0];
    }

    const retryMatch = await pool.query(
      `SELECT exam_id, title FROM exams WHERE title = 'PRACTICE QUIZ' AND exam_type = 'exam' LIMIT 1`
    );
    return retryMatch.rows[0] || null;
  }

  return null;
};

const generateDateBasedCertificateId = async () => {
  const sequenceRes = await pool.query(
    `
    SELECT
      TO_CHAR(CURRENT_DATE, 'DDMMYYYY') AS date_part,
      COUNT(*)::int + 1 AS next_count
    FROM certificates
    WHERE issued_at::date = CURRENT_DATE
    `
  );

  const datePart = sequenceRes.rows[0]?.date_part;
  const nextCount = Number(sequenceRes.rows[0]?.next_count || 1);
  return `${datePart}${String(nextCount).padStart(2, "0")}`;
};


const generateCertificate = async (user_id) => {
  try {
    console.log("Generate Certificate Triggered:", user_id);

    // Fetch latest passed exam for user
    const result = await pool.query(
      `
      SELECT e.id AS exam_id, e.exam_name, e.score
      FROM certificates c
      JOIN exams e ON c.exam_id = e.id
      WHERE c.user_id = $1
      ORDER BY c.issued_at DESC
      LIMIT 1
      `,
      [user_id]
    );

    if (result.rows.length === 0) {
      console.log("No certificate data found for user:", user_id);
      return;
    }

    const { exam_name, score } = result.rows[0];

    // Eligibility check
    if (Number(score) < 50) {
      console.log(`Score ${score} < 50 → Not eligible`);
      return;
    }

    // Generate PDF
    const pdfResult = await generatePDF(exam_name, score, user_id);

    if (pdfResult?.generated) {
      console.log("Certificate PDF Generated:", pdfResult.filePath);
    }

  } catch (err) {
    console.error("generateCertificate Error:", err.message);
  }
};

const issueExamCertificate = async ({ userId, examId, score }) => {
  if (!userId || !examId || score === undefined) {
    return { issued: false, reason: "invalid_input" };
  }

  const examRes = await pool.query(
    `SELECT exam_id, title, pass_percentage, exam_type FROM exams WHERE exam_id = $1`,
    [examId]
  );

  if (examRes.rows.length === 0) {
    return { issued: false, reason: "exam_not_found" };
  }

  const exam = examRes.rows[0];
  if (String(exam.exam_type || "").toLowerCase() !== "exam") {
    return { issued: false, reason: "not_exam_type" };
  }
  const passPercentage = Number(exam.pass_percentage);
  const numericScore = Number(score);

  if (Number.isNaN(numericScore)) {
    return { issued: false, reason: "invalid_score" };
  }

  const codingCheck = await pool.query(
    `
    SELECT 1
    FROM exam_questions
    WHERE exam_id = $1 AND question_type = 'coding'
    LIMIT 1
    `,
    [examId]
  );

  if (codingCheck.rows.length > 0) {
    return { issued: false, reason: "coding_present" };
  }

  if (numericScore < passPercentage) {
    return { issued: false, reason: "not_passed" };
  }

  const existingCert = await pool.query(
    `SELECT * FROM certificates WHERE user_id = $1 AND exam_id = $2`,
    [userId, examId]
  );

  if (existingCert.rows.length > 0) {
    return {
      issued: true,
      certificate: existingCert.rows[0],
      filePath: existingCert.rows[0].certificate_id || null,
      alreadyExisted: true
    };
  }

  const userRes = await pool.query(
    `SELECT full_name FROM users WHERE user_id = $1`,
    [userId]
  );

  const studentName = userRes.rows[0]?.full_name || null;

  let certificateSettings = null;
  try {
    const settingsRes = await pool.query(
      `SELECT title, logo_url, template_url, signature_url, authority_name, issuer_name FROM certificate_settings WHERE id = 1 LIMIT 1`
    );
    if (settingsRes.rows.length) {
      certificateSettings = settingsRes.rows[0];
    }
  } catch (_) {
    certificateSettings = null;
  }

  const verifyBase =
    process.env.CERTIFICATE_VERIFY_BASE_URL ||
    process.env.FRONTEND_URL ||
    "http://localhost:5173";

  let insertRes = null;
  let certificateId = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    certificateId = await generateDateBasedCertificateId();

    try {
      insertRes = await pool.query(
        `
        INSERT INTO certificates
          (user_id, exam_id, exam_name, score, certificate_id, issued_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        RETURNING *
        `,
        [userId, examId, exam.title, numericScore, certificateId]
      );
      break;
    } catch (insertError) {
      const constraintName = String(insertError?.constraint || "");
      if (insertError?.code === "23505" && constraintName.includes("user_id") && constraintName.includes("exam_id")) {
        const certRes = await pool.query(
          `SELECT * FROM certificates WHERE user_id = $1 AND exam_id = $2 LIMIT 1`,
          [userId, examId]
        );

        if (certRes.rows.length > 0) {
          return {
            issued: true,
            certificate: certRes.rows[0],
            filePath: certRes.rows[0].certificate_id || null,
            alreadyExisted: true
          };
        }
      }

      if (insertError?.code === "23505" && constraintName.includes("certificate_id")) {
        continue;
      }

      throw insertError;
    }
  }

  if (!insertRes?.rows?.length || !certificateId) {
    return { issued: false, reason: "certificate_id_conflict" };
  }

  const verifyUrl = `${String(verifyBase).replace(/\/$/, "")}/verify/${certificateId}`;

  const pdfResult = await generatePDF(
    exam.title,
    numericScore,
    userId,
    numericScore,
    studentName,
    {
      certificateId,
      verifyUrl,
      title: certificateSettings?.title || null,
      logoUrl: certificateSettings?.logo_url || null,
      templateUrl: certificateSettings?.template_url || null,
      signatureUrl: certificateSettings?.signature_url || null,
      authorityName: certificateSettings?.authority_name || null,
      issuerName: certificateSettings?.issuer_name || null,
    }
  );

  if (!pdfResult?.generated) {
    await pool.query(`DELETE FROM certificates WHERE id = $1`, [insertRes.rows[0].id]).catch(() => {});
    return { issued: false, reason: "pdf_failed" };
  }

  try {
    if (pdfResult?.filePath) {
      await uploadPdfFileToS3(pdfResult.filePath, certificateId, "certificates");
      await removeLocalFileSafe(pdfResult.filePath);
    }
  } catch (uploadError) {
    await pool.query(`DELETE FROM certificates WHERE id = $1`, [insertRes.rows[0].id]).catch(() => {});
    console.error("Certificate S3 upload failed:", uploadError.message);
    return { issued: false, reason: "pdf_upload_failed" };
  }

  return {
    issued: true,
    certificate: insertRes.rows[0],
    filePath: pdfResult.filePath || null
  };
};


const generateQuizCertificate = async (req, res) => {
  try {
    const userRes = await pool.query(
      `SELECT user_id, full_name FROM users WHERE firebase_uid = $1`,
      [req.firebase.uid]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const { user_id, full_name } = userRes.rows[0];

    const { exam_name, percentage } = req.body;

    if (!exam_name || percentage === undefined) {
      return res.status(400).json({
        message: "exam_name and percentage are required"
      });
    }

    const score = Number(percentage);

    if (isNaN(score)) {
      return res.status(400).json({
        message: "Invalid score"
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
        success: false,
        message: messageMap[reason] || "Certificate not eligible"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Certificate generated successfully",
      filePath: certificateResult.filePath,
      certificate: certificateResult.certificate
    });

  } catch (err) {
    console.error("generateQuizCertificate Error:", err);
    res.status(500).json({
      message: "Internal server error",
      error: err.message
    });
  }
};


export {
  generateCertificate,
  issueExamCertificate,
  generateQuizCertificate,
  resolveExamByName
};
