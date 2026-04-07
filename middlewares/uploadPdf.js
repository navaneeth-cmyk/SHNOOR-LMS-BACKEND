// middlewares/uploadPdf.js
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const pdfsDir = path.join(__dirname, "..", "uploads", "pdfs");
if (!fs.existsSync(pdfsDir)) fs.mkdirSync(pdfsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, pdfsDir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  },
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname || "").toLowerCase();
  
  // Allow video and PDF files
  const allowedVideoMimes = ["video/mp4", "video/webm", "video/quicktime", "video/x-matroska", "video/x-msvideo", "video/ogg"];
  const allowedVideoExts = [".mp4", ".mkv", ".webm", ".mov", ".avi", ".ogg"];
  const isPdf = ext === ".pdf" || file.mimetype === "application/pdf";
  const isVideo = allowedVideoMimes.includes(file.mimetype) || allowedVideoExts.includes(ext);

  if (isPdf || isVideo) {
    cb(null, true);
  } else {
    cb(new Error(`Only PDF and video files are allowed. Received: ${file.originalname}`), false);
  }
};

const uploadPdf = multer({
  storage,
  fileFilter,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

export default uploadPdf;