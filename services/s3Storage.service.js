import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import fs from "fs/promises";
import path from "path";

const {
  AWS_S3_BUCKET,
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
} = process.env;

let s3Client = null;

const getS3Client = () => {
  if (!AWS_S3_BUCKET || !AWS_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    throw new Error(
      "AWS S3 is not configured. Set AWS_S3_BUCKET, AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY."
    );
  }

  if (!s3Client) {
    s3Client = new S3Client({
      region: AWS_REGION,
      credentials: {
        accessKeyId: AWS_ACCESS_KEY_ID,
        secretAccessKey: AWS_SECRET_ACCESS_KEY,
      },
    });
  }

  return s3Client;
};

const sanitizeName = (name = "file") => {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120) || "file";
};

export const resolveS3StorageFolder = ({ type, mimeType, originalName } = {}) => {
  const normalizedType = String(type || "").toLowerCase();
  const ext = path.extname(String(originalName || "")).toLowerCase();

  if (
    normalizedType === "pdf" ||
    mimeType === "application/pdf" ||
    ext === ".pdf"
  ) {
    return "pdfs";
  }

  if (
    normalizedType === "text_stream" ||
    [".txt", ".md", ".html", ".htm"].includes(ext) ||
    String(mimeType || "").startsWith("text/")
  ) {
    return "docs";
  }

  return "videos";
};

const getSignedUrlForObject = async (objectPath) => {
  const client = getS3Client();
  const command = new GetObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: objectPath,
  });

  try {
    // AWS SigV4 presigned URLs max expiration: 7 days = 604800 seconds
    const MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
    const url = await getSignedUrl(client, command, { expiresIn: MAX_EXPIRY_SECONDS });
    return url;
  } catch (error) {
    throw new Error(`Failed to create signed URL for S3 object: ${error.message}`);
  }
};

/**
 * Generate signed URL with expiration based on course expiry date
 * AWS limit: 7 days = 604800 seconds maximum
 * @param {string} objectPath - S3 object path
 * @param {Date} courseExpiresAt - When the course expires
 * @returns {Promise<string>} - Signed URL (valid until course expires or 7 days, whichever is sooner)
 */
const getSignedUrlForObjectWithExpiry = async (objectPath, courseExpiresAt) => {
  const client = getS3Client();
  
  // AWS SigV4 maximum: 7 days = 604800 seconds
  const AWS_MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
  const BUFFER_SECONDS = 60 * 60; // 1 hour buffer
  
  let expiresInSeconds = AWS_MAX_EXPIRY_SECONDS; // Default to AWS max

  if (courseExpiresAt) {
    const now = new Date();
    const expiryDate = new Date(courseExpiresAt);
    const diffMs = expiryDate.getTime() - now.getTime();
    const diffSeconds = Math.floor(diffMs / 1000);
    
    // Calculate URL expiry: course expiry + 1 hour buffer
    let calculatedExpiry = diffSeconds + BUFFER_SECONDS;
    
    // Ensure it never exceeds AWS limit
    expiresInSeconds = Math.min(calculatedExpiry, AWS_MAX_EXPIRY_SECONDS);
    
    // Minimum 1 hour to avoid URLs expiring immediately
    expiresInSeconds = Math.max(expiresInSeconds, 3600);
  }

  const command = new GetObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: objectPath,
  });

  try {
    const url = await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    return url;
  } catch (error) {
    throw new Error(`Failed to create signed URL for S3 object: ${error.message}`);
  }
};

export { getSignedUrlForObject, getSignedUrlForObjectWithExpiry };

export const uploadBufferToS3 = async (
  buffer,
  { originalName = "file", mimeType, folder = "modules" } = {}
) => {
  const client = getS3Client();

  const ext = path.extname(originalName) || "";
  const base = sanitizeName(path.basename(originalName, ext));
  const objectPath = `${folder}/${Date.now()}-${Math.round(Math.random() * 1e9)}-${base}${ext}`;

  const command = new PutObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: objectPath,
    Body: buffer,
    ContentType: mimeType || "application/octet-stream",
    // Add caching metadata for faster downloads
    Metadata: {
      "Cache-Control": "public, max-age=31536000", // Cache for 1 year
    },
    CacheControl: "public, max-age=31536000", // Cache for 1 year
  });

  try {
    await client.send(command);
  } catch (error) {
    throw new Error(`S3 upload failed: ${error.message}`);
  }

  const url = await getSignedUrlForObject(objectPath);
  return { objectPath, url, bucket: AWS_S3_BUCKET };
};

export const uploadLocalFileToS3 = async (
  filePath,
  { originalName, mimeType, folder = "modules" } = {}
) => {
  const buffer = await fs.readFile(filePath);
  return uploadBufferToS3(buffer, {
    originalName: originalName || path.basename(filePath),
    mimeType,
    folder,
  });
};

export const removeLocalFileSafe = async (filePath) => {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (_err) {
    // no-op
  }
};

const normalizeObjectPath = (objectPath = "") =>
  String(objectPath || "").trim().replace(/\.pdf$/i, "");

export const getS3ObjectPath = (objectId) => {
  const normalized = normalizeObjectPath(objectId);
  return `${normalized}.pdf`;
};

export const uploadPdfBufferToS3 = async (buffer, objectId, folder = "certificates") => {
  const normalized = normalizeObjectPath(objectId);
  if (!normalized) {
    throw new Error("objectId is required for S3 upload");
  }

  const client = getS3Client();
  const objectPath = `${folder}/${normalized}.pdf`;

  const command = new PutObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: objectPath,
    Body: buffer,
    ContentType: "application/pdf",
  });

  try {
    await client.send(command);
  } catch (error) {
    throw new Error(`S3 PDF upload failed: ${error.message}`);
  }

  const url = await getSignedUrlForObject(objectPath);
  return { objectPath, url, bucket: AWS_S3_BUCKET };
};

export const uploadPdfFileToS3 = async (filePath, objectId, folder = "certificates") => {
  const buffer = await fs.readFile(filePath);
  return uploadPdfBufferToS3(buffer, objectId, folder);
};

export const downloadPdfFromS3 = async (objectId, folder = "certificates") => {
  const normalized = normalizeObjectPath(objectId);
  if (!normalized) {
    throw new Error("objectId is required for S3 download");
  }

  const client = getS3Client();
  const objectPath = `${folder}/${normalized}.pdf`;

  const command = new GetObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: objectPath,
  });

  try {
    const response = await client.send(command);
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    console.error(`S3 download failed: ${error.message}`);
    return null;
  }
};
