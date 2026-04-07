import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import QRCode from "qrcode";
import axios from "axios";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const imageSourceCache = new Map();

const firstExistingPath = (paths = []) => {
  for (const candidate of paths) {
    if (!candidate) continue;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

const loadImageSource = async (value) => {
  if (!value) return null;

  if (Buffer.isBuffer(value)) return value;

  const text = String(value).trim();
  if (!text) return null;

  if (imageSourceCache.has(text)) {
    return imageSourceCache.get(text);
  }

  if (text.startsWith("data:image")) {
    if (text.startsWith("data:image/svg")) {
      return null;
    }
    const parts = text.split(",");
    if (parts.length === 2) {
      const parsed = Buffer.from(parts[1], "base64");
      imageSourceCache.set(text, parsed);
      return parsed;
    }
    return null;
  }

  if (/^https?:\/\//i.test(text)) {
    if (/\.svg(\?|$)/i.test(text)) {
      return null;
    }
    try {
      const response = await axios.get(text, {
        responseType: "arraybuffer",
        timeout: 7000,
      });
      const fetched = Buffer.from(response.data);
      imageSourceCache.set(text, fetched);
      return fetched;
    } catch (_) {
      return null;
    }
  }

  const localPath = firstExistingPath([
    text,
    path.resolve(process.cwd(), text),
    path.resolve(__dirname, text),
  ]);

  if (!localPath) return null;

  try {
    if (/\.svg$/i.test(localPath)) {
      return null;
    }
    const fileBuffer = fs.readFileSync(localPath);
    imageSourceCache.set(text, fileBuffer);
    return fileBuffer;
  } catch (_) {
    return null;
  }
};

const generatePDF = async (
  resOrExamName,
  examName,
  score,
  userId,
  percentage = null,
  studentName = null,
  options = {}
) => {
  const hasResponse =
    resOrExamName && typeof resOrExamName.setHeader === "function";

  const res = hasResponse ? resOrExamName : null;
  const exam_name = hasResponse ? examName : resOrExamName;
  const scoreValue = hasResponse ? score : examName;
  const user_id = hasResponse ? userId : score;
  const percentageValue = hasResponse ? percentage : userId;
  const student_name = hasResponse ? studentName : percentage;
  const finalOptions = hasResponse ? options : studentName || {};

  const certificateId = finalOptions.certificateId || `cert_${Date.now()}`;
  const normalizedCertificateId = String(certificateId).replace(/\.pdf$/i, "");
  const verifyUrl = finalOptions.verifyUrl || "";
  const configuredTitle = finalOptions.title || "CERTIFICATE OF ACHIEVEMENT";
  const configuredIssuerName = finalOptions.issuerName || "SHNOOR LMS";
  const configuredAuthorityName = finalOptions.authorityName || "Authorized Signature";

  const numericScore = Number(scoreValue);
  const numericPercentage =
    percentageValue !== null && percentageValue !== undefined
      ? Number(percentageValue)
      : null;

  if (
    isNaN(numericScore) &&
    (numericPercentage === null || isNaN(numericPercentage))
  ) {
    if (res) {
      return res.status(400).json({
        success: false,
        message: "Invalid score"
      });
    }

    return { generated: false, message: "Invalid score" };
  }

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 72, bottom: 72, left: 72, right: 72 }
  });

  let outputStream = null;
  let filePath = null;
  const responseChunks = [];

  if (res) {
    doc.on("data", (chunk) => responseChunks.push(chunk));
  } else {
    const certDir = path.join(process.cwd(), "certificates");
    fs.mkdirSync(certDir, { recursive: true });
    const fileName = `${normalizedCertificateId}.pdf`;
    filePath = path.join(certDir, fileName);
    outputStream = fs.createWriteStream(filePath);
    doc.pipe(outputStream);
  }

  const [logoSource, signatureSource, footerLogoSource, templateSource] = await Promise.all([
    loadImageSource(
      finalOptions.logoUrl
      || process.env.CERTIFICATE_LOGO_PATH
      || path.resolve(process.cwd(), "frontend/src/assets/just_logo.jpeg")
      || path.resolve(__dirname, "../../frontend/src/assets/just_logo.jpeg")
    ),
    loadImageSource(
      finalOptions.signatureUrl
      || process.env.CERTIFICATE_SIGNATURE_PATH
      || path.resolve(process.cwd(), "frontend/public/signatures/sign.png")
      || path.resolve(__dirname, "../../frontend/public/signatures/sign.png")
    ),
    loadImageSource(
      process.env.CERTIFICATE_FOOTER_LOGO_PATH
      || path.resolve(process.cwd(), "frontend/public/nasscom.jpg")
      || path.resolve(__dirname, "../../frontend/public/nasscom.jpg")
    ),
    loadImageSource(finalOptions.templateUrl || null),
  ]);

  let qrImage = null;
  if (verifyUrl) {
    try {
      qrImage = await QRCode.toBuffer(verifyUrl, {
        type: "png",
        width: 48,
        margin: 0,
        errorCorrectionLevel: "L"
      });
    } catch (_) {
      qrImage = null;
    }
  }

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const frameX = 26;
  const frameY = 26;
  const frameW = pageWidth - 52;
  const frameH = pageHeight - 52;
  const cornerSize = 46;

  doc
    .lineWidth(4)
    .strokeColor("#1f3f95")
    .rect(frameX, frameY, frameW, frameH)
    .stroke();

  doc.save().fillColor("#1f3f95")
    .polygon(
      frameX,
      frameY,
      frameX + cornerSize,
      frameY,
      frameX,
      frameY + cornerSize
    )
    .fill().restore();

  doc.save().fillColor("#1f3f95")
    .polygon(
      frameX + frameW,
      frameY + frameH,
      frameX + frameW - cornerSize,
      frameY + frameH,
      frameX + frameW,
      frameY + frameH - cornerSize
    )
    .fill().restore();

  if (templateSource) {
    try {
      doc.save();
      doc.opacity(0.12).image(templateSource, frameX + 4, frameY + 4, {
        fit: [frameW - 8, frameH - 8],
        align: "center",
        valign: "center",
      });
      doc.restore();
    } catch (_) { }
  }

  if (qrImage) {
    try {
      doc.image(qrImage, frameX + frameW - 54, frameY + 18, { width: 36, height: 36 });
    } catch (_) { }
  }

  doc
    .font("Helvetica")
    .fontSize(7)
    .fillColor("#8a97ad")
    .text(
      `ID: ${String(certificateId)}`,
      frameX + frameW - 250,
      frameY + 50,
      { width: 230, align: "right" }
    );

  if (logoSource) {
    try {
      doc.image(logoSource, pageWidth / 2 - 26, 130, { width: 52, height: 52 });
    } catch (_) { }
  }

  doc
    .font("Times-BoldItalic")
    .fontSize(28)
    .fillColor("#1f2f56")
    .text(
    configuredTitle,
    0,
    212,
    { align: "center" }
    );

  doc
    .font("Times-Roman")
    .fontSize(22)
    .fillColor("#243a63")
    .text("This is to certify that", 0, 278, { align: "center" });

  const studentLabel = student_name || "Student";
  doc
    .font("Times-Bold")
    .fontSize(40)
    .fillColor("#0aa27b")
    .text(studentLabel, 0, 334, { align: "center" });

  doc
    .lineWidth(1)
    .strokeColor("#9fb1cb")
    .moveTo(pageWidth / 2 - 150, 388)
    .lineTo(pageWidth / 2 + 150, 388)
    .stroke();

  doc
    .font("Times-Roman")
    .fontSize(22)
    .fillColor("#243a63")
    .text("has successfully completed the training program with", 0, 425, { align: "center" });

  doc
    .font("Times-Bold")
    .fontSize(30)
    .fillColor("#173c91")
    .text(configuredIssuerName, 0, 465, { align: "center" });

  doc
    .font("Times-Roman")
    .fontSize(20)
    .fillColor("#415b8c")
    .text(`Issued on: ${new Date().toLocaleDateString()}`, 0, 528, { align: "center" });

  if (signatureSource) {
    try {
      doc.image(signatureSource, pageWidth - 160, pageHeight - 173, { width: 55, height: 28 });
    } catch (_) { }
  }

  if (footerLogoSource) {
    try {
      doc.image(footerLogoSource, 88, pageHeight - 154, { width: 58, height: 22 });
    } catch (_) { }
  }

  doc
    .font("Times-Bold")
    .fontSize(13)
    .fillColor("#bc1f2d")
    .text("NASSCOM", 88, pageHeight - 127);
  doc
    .font("Times-Bold")
    .fontSize(10)
    .fillColor("#344d77")
    .text("CERTIFIED MEMBER", 88, pageHeight - 105);

  doc
    .lineWidth(1)
    .strokeColor("#223c65")
    .moveTo(pageWidth - 185, pageHeight - 124)
    .lineTo(pageWidth - 58, pageHeight - 124)
    .stroke();

  doc
    .font("Times-Bold")
    .fontSize(11)
    .fillColor("#1f335c")
    .text("AUTHORIZED SIGNATURE", pageWidth - 185, pageHeight - 116, {
      width: 127,
      align: "center",
    });
  doc
    .font("Times-Roman")
    .fontSize(9)
    .fillColor("#445d87")
    .text(configuredAuthorityName, pageWidth - 185, pageHeight - 99, {
      width: 127,
      align: "center",
    });

  const waitForFileStream = () => new Promise((resolve, reject) => {
    let settled = false;

    const done = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    outputStream.on("finish", () => done({ generated: true, filePath: filePath || null }));
    outputStream.on("close", () => done({ generated: true, filePath: filePath || null }));
    outputStream.on("error", fail);
    doc.on("error", fail);

    doc.end();
  });

  if (res) {
    const pdfBuffer = await new Promise((resolve, reject) => {
      doc.on("error", reject);
      doc.on("end", () => resolve(Buffer.concat(responseChunks)));
      doc.end();
    });

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(pdfBuffer.length));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=certificate_${String(exam_name || "certificate").replace(/[^a-z0-9_\- ]/gi, "")}.pdf`
    );
    res.end(pdfBuffer);

    return { generated: true, filePath: null };
  }

  return waitForFileStream();
};

export default generatePDF;
