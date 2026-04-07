import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsRoot = path.join(__dirname, "..", "uploads");

const ensureDir = (dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        let subFolder;
        if (file.fieldname === "file") {
            // CSV file goes to temp folder
            subFolder = "temp";
        } else {
            // Resource files routed by type
            const ext = path.extname(file.originalname).toLowerCase();
            if ((file.mimetype || "").startsWith("video/") || [".mp4", ".mkv", ".webm", ".mov", ".avi", ".ogg"].includes(ext)) {
                subFolder = "videos";
            } else if (file.mimetype === "application/pdf" || ext === ".pdf") {
                subFolder = "pdfs";
            } else {
                subFolder = "docs";
            }
        }
        const dir = path.join(uploadsRoot, subFolder);
        ensureDir(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, unique + path.extname(file.originalname));
    },
});

const fileFilter = (req, file, cb) => {
    // Allow CSV
    if (file.mimetype === "text/csv" || file.mimetype === "application/vnd.ms-excel" || path.extname(file.originalname).toLowerCase() === ".csv") {
        return cb(null, true);
    }

    // Allow video and PDF files
    const allowedTypes = [
        "video/mp4", "video/webm", "video/quicktime", "video/x-matroska", "video/x-msvideo", "video/ogg",
        "application/pdf"
    ];
    const allowedExts = [
        ".mp4", ".mkv", ".webm", ".mov", ".avi", ".ogg",
        ".pdf"
    ];

    const ext = path.extname(file.originalname || "").toLowerCase();
    if (allowedTypes.includes(file.mimetype) || allowedExts.includes(ext)) {
        return cb(null, true);
    }

    cb(new Error(`Invalid file type: ${file.originalname}. Only video and PDF files are allowed.`), false);
};

const upload = multer({
    storage,
    fileFilter: fileFilter,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

// Expecting 'file' (CSV) and 'resources' (Multiple files)
export const uploadBulk = upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'resources', maxCount: 20 }
]);