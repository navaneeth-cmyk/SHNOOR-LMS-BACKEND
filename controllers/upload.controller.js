import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
    uploadLocalFileToS3,
    resolveS3StorageFolder,
    removeLocalFileSafe,
} from "../services/s3Storage.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadsRoot = path.join(__dirname, "..", "uploads");

const ensureDir = (dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        let subFolder;
        if (file.mimetype.startsWith("video/") || [".mp4", ".mkv", ".webm", ".mov", ".avi", ".ogg"].includes(ext)) {
            subFolder = "videos";
        } else if (file.mimetype === "application/pdf" || ext === ".pdf") {
            subFolder = "pdfs";
        } else {
            subFolder = "docs";
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

// File filter (Video & PDF only)
const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        "video/mp4", "video/webm", "video/quicktime",
        "video/x-matroska", "video/x-msvideo", "video/ogg",
        "application/pdf", "application/x-pdf"
    ];

    const ext = path.extname(file.originalname || "").toLowerCase();
    const allowedExts = [".mp4", ".mkv", ".webm", ".mov", ".avi", ".ogg", ".pdf"];

    const isAllowedMime = allowedTypes.includes(file.mimetype);
    const isAllowedByExt =
        (file.mimetype === "application/octet-stream" || !file.mimetype) &&
        allowedExts.includes(ext);

    console.log(`[Upload Debug] Filename: ${file.originalname}, Mimetype: ${file.mimetype}, Ext: ${ext}`);

    if (isAllowedMime || isAllowedByExt) {
        cb(null, true);
    } else {
        console.error(`[Upload Debug] Rejected file: ${file.originalname} (${file.mimetype})`);
        cb(new Error(`Invalid file type (${file.mimetype}). Only video and PDF files are allowed.`), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
});

export const uploadFile = upload.single("file");

export const handleUpload = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
    }

    try {
        const ext = path.extname(req.file.originalname).toLowerCase();
        let folder;
        const isVideo = req.file.mimetype.startsWith("video/") || [".mp4", ".mkv", ".webm", ".mov", ".avi", ".ogg"].includes(ext);
        const isPdf = req.file.mimetype === "application/pdf" || ext === ".pdf";
        
        if (isVideo) {
            folder = "videos";
        } else if (isPdf) {
            folder = "pdfs";
        } else {
            folder = "docs";
        }
        
        // Upload all files to S3
        console.log(`[Upload] Uploading ${req.file.originalname} to S3 folder: ${folder}`);
        const { objectPath, url } = await uploadLocalFileToS3(req.file.path, {
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            folder: folder,
        });

        // Delete local file after successful upload
        await removeLocalFileSafe(req.file.path);

        console.log(`[Upload] File uploaded to S3: ${url}`);
        res.status(200).json({
            message: "File uploaded successfully to S3",
            url: url,
            objectPath: objectPath,
            filename: req.file.originalname,
            mimetype: req.file.mimetype,
            storage: "s3",
        });
    } catch (error) {
        console.error(`[Upload] Error uploading file:`, error.message);
        await removeLocalFileSafe(req.file.path);
        return res.status(500).json({ message: error.message || "File upload failed" });
    }
};