import { createClient } from "@supabase/supabase-js";
import fs from "fs/promises";
import path from "path";

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_BUCKET_MODULES,
  SUPABASE_BUCKET_CERTIFICATES,
  SUPABASE_STORAGE_PUBLIC,
} = process.env;

const bucketName = SUPABASE_BUCKET_MODULES || "modules-media";
const certificateBucketName = SUPABASE_BUCKET_CERTIFICATES || bucketName;
const isPublicBucket = String(SUPABASE_STORAGE_PUBLIC || "true").toLowerCase() === "true";

let supabaseClient = null;

const getClient = () => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }

  if (!supabaseClient) {
    supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }

  return supabaseClient;
};

const sanitizeName = (name = "file") => {
  return name
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 120) || "file";
};

export const resolveModuleStorageFolder = ({ type, mimeType, originalName } = {}) => {
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

const getPublicOrSignedUrl = async (storage, objectPath) => {
  if (isPublicBucket) {
    const { data } = storage.getPublicUrl(objectPath);
    if (!data?.publicUrl) {
      throw new Error("Failed to get public URL from Supabase storage.");
    }
    return data.publicUrl;
  }

  const { data, error } = await storage.createSignedUrl(objectPath, 60 * 60 * 24 * 30);
  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "Failed to create signed URL from Supabase storage.");
  }
  return data.signedUrl;
};

export const uploadBufferToSupabase = async (
  buffer,
  { originalName = "file", mimeType, folder = "modules" } = {}
) => {
  const client = getClient();
  const storage = client.storage.from(bucketName);

  const ext = path.extname(originalName) || "";
  const base = sanitizeName(path.basename(originalName, ext));
  const objectPath = `${folder}/${Date.now()}-${Math.round(Math.random() * 1e9)}-${base}${ext}`;

  const { error } = await storage.upload(objectPath, buffer, {
    contentType: mimeType || undefined,
    upsert: false,
  });

  if (error) {
    throw new Error(`Supabase upload failed: ${error.message}`);
  }

  const url = await getPublicOrSignedUrl(storage, objectPath);
  return { objectPath, url, bucket: bucketName };
};

export const uploadLocalFileToSupabase = async (
  filePath,
  { originalName, mimeType, folder = "modules" } = {}
) => {
  const buffer = await fs.readFile(filePath);
  return uploadBufferToSupabase(buffer, {
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

const normalizeCertificateId = (certificateId = "") =>
  String(certificateId || "").trim().replace(/\.pdf$/i, "");

export const getCertificateObjectPath = (certificateId) => {
  const normalized = normalizeCertificateId(certificateId);
  return `certificates/${normalized}.pdf`;
};

export const uploadCertificatePdfBufferToSupabase = async (buffer, certificateId) => {
  const normalized = normalizeCertificateId(certificateId);
  if (!normalized) {
    throw new Error("certificateId is required for Supabase upload");
  }

  const client = getClient();
  const storage = client.storage.from(certificateBucketName);
  const objectPath = getCertificateObjectPath(normalized);

  const { error } = await storage.upload(objectPath, buffer, {
    contentType: "application/pdf",
    upsert: true,
  });

  if (error) {
    throw new Error(`Supabase certificate upload failed: ${error.message}`);
  }

  const url = await getPublicOrSignedUrl(storage, objectPath);
  return { objectPath, url, bucket: certificateBucketName };
};

export const uploadCertificatePdfFileToSupabase = async (filePath, certificateId) => {
  const buffer = await fs.readFile(filePath);
  return uploadCertificatePdfBufferToSupabase(buffer, certificateId);
};

export const downloadCertificatePdfFromSupabase = async (certificateId) => {
  const normalized = normalizeCertificateId(certificateId);
  if (!normalized) {
    throw new Error("certificateId is required for Supabase download");
  }

  const client = getClient();
  const storage = client.storage.from(certificateBucketName);
  const objectPath = getCertificateObjectPath(normalized);

  const { data, error } = await storage.download(objectPath);
  if (error || !data) {
    return null;
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
};
