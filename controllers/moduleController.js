import pool from "../db/postgres.js";
import axios from "axios";
import fs from "fs";
import {
  uploadLocalFileToS3,
  resolveS3StorageFolder,
  removeLocalFileSafe,
  getSignedUrlForObject,
  getSignedUrlForObjectWithExpiry,
} from "../services/s3Storage.service.js";

export const addModules = async (req, res) => {
  try {
    const { courseId } = req.body;

    if (!courseId) {
      return res.status(400).json({ message: "courseId is required" });
    }

    // ✅ SAFE PARSING
    let modules = [];

    if (typeof req.body.modules === "string") {
      modules = JSON.parse(req.body.modules);
    } else if (Array.isArray(req.body.modules)) {
      modules = req.body.modules;
    }

    const pdfFiles = req.files || [];

    if (modules.length === 0) {
      return res.status(200).json({
        message: "Course created without modules",
      });
    }

    for (let i = 0; i < modules.length; i++) {
      const m = modules[i];
      const pdf = pdfFiles[i] || null;
      let finalContentUrl = m.content_url || null;
      let s3ObjectPath = null;
      let uploadProvider = null;

      if (pdf) {
        // ✅ Upload PDF or video to S3
        const ext = pdf.originalname.slice(pdf.originalname.lastIndexOf('.')).toLowerCase();
        const allowedVideoExts = [".mp4", ".mkv", ".webm", ".mov", ".avi", ".ogg"];
        const isPdf = ext === ".pdf" || pdf.mimetype === "application/pdf";
        const isVideo = pdf.mimetype.startsWith("video/") || allowedVideoExts.includes(ext);
        
        if (isPdf || isVideo) {
          try {
            const folder = isPdf ? "pdfs" : "videos";
            const { url, objectPath } = await uploadLocalFileToS3(
              pdf.path,
              {
                originalName: pdf.originalname,
                mimeType: pdf.mimetype,
                folder: folder,
              }
            );
            finalContentUrl = url;
            s3ObjectPath = objectPath;
            uploadProvider = "s3";
          } catch (uploadErr) {
            console.error("Error uploading file to S3:", uploadErr.message);
            throw uploadErr;
          }
        } else {
          throw new Error("Only PDF and video files are supported for module content.");
        }
      }

      let result;
      try {
        // Try INSERT with s3_object_path (new schema)
        result = await pool.query(
          `
          INSERT INTO modules (
            course_id,
            title,
            type,
            content_url,
            s3_object_path,
            duration_mins,
            module_order,
            notes,
            pdf_data,
            pdf_filename,
            pdf_mime
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          RETURNING module_id
          `,
          [
            courseId,
            m.title,
            m.type,
            finalContentUrl,
            s3ObjectPath,
            m.duration || 0,
            m.order_index || i + 1,
            m.notes || null,
            null,
            null,
            null,
          ]
        );
      } catch (err) {
        if (err.message && err.message.includes('s3_object_path')) {
          // Column doesn't exist yet - use old schema
          console.warn("s3_object_path column not found, using fallback INSERT");
          result = await pool.query(
            `
            INSERT INTO modules (
              course_id,
              title,
              type,
              content_url,
              duration_mins,
              module_order,
              notes,
              pdf_data,
              pdf_filename,
              pdf_mime
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            RETURNING module_id
            `,
            [
              courseId,
              m.title,
              m.type,
              finalContentUrl,
              m.duration || 0,
              m.order_index || i + 1,
              m.notes || null,
              null,
              null,
              null,
            ]
          );
        } else {
          throw err;
        }
      }

      // 🚫 COMMENTED OUT: text_stream support removed - only PDFs supported
      /* if (m.type === "text_stream") {
        const moduleId = result.rows[0].module_id;
        let textToChunk = m.notes || "";

        // Read text content from disk file if available, else fetch remote URL.
        if (!textToChunk && pdf && pdf.path) {
          try {
            textToChunk = fs.readFileSync(pdf.path, "utf-8");
          } catch (readErr) {
            console.error("Error reading text file from disk:", readErr.message);
          }
        }
        if (!textToChunk && finalContentUrl && finalContentUrl.startsWith("http")) {
          try {
            const textRes = await axios.get(finalContentUrl, {
              responseType: "text",
              transformResponse: [(data) => data],
            });
            const contentType = String(textRes.headers?.["content-type"] || "").toLowerCase();
            const isTextLike =
              contentType.includes("text/plain") ||
              contentType.includes("text/markdown") ||
              contentType.includes("text/html") ||
              /\.txt($|\?)/i.test(finalContentUrl) ||
              /\.md($|\?)/i.test(finalContentUrl) ||
              /\.html?($|\?)/i.test(finalContentUrl);
            if (isTextLike && typeof textRes.data === "string") {
              textToChunk = textRes.data;
            }
          } catch (fetchError) {
            console.error("Error fetching remote text stream file:", fetchError.message);
          }
        }

        const isHtmlContent = (textResData) => /<[a-z][\s\S]*>/i.test(textResData || "");
        const shouldStripTags = 
          /\.html?($|\?)/i.test(finalContentUrl || "") || 
          isHtmlContent(textToChunk);

        if (textToChunk && shouldStripTags && !finalContentUrl?.includes("i=open")) {
          textToChunk = textToChunk.replace(/<[^>]*>?/gm, " ").replace(/\s+/g, " ").trim();
        }

        if (textToChunk) {
          const allWords = textToChunk.split(/\s+/).filter((c) => c.length > 0);
          if (allWords.length > 0) {
            // Group words into blocks of 50
            const chunks = [];
            const wordsPerChunk = 50;
            for (let i = 0; i < allWords.length; i += wordsPerChunk) {
              const chunkText = allWords.slice(i, i + wordsPerChunk).join(" ") + " ";
              chunks.push({
                content: chunkText,
                wordCount: allWords.slice(i, i + wordsPerChunk).length,
              });
            }

            const chunkVals = [];
            const chunkPlaceholders = [];
            for (let k = 0; k < chunks.length; k++) {
              const c = chunks[k];
              const duration = Math.max(1, Math.ceil(c.wordCount / 5)); // ~1 sec per 5 words
              chunkVals.push(moduleId, c.content, k, duration);
              const o = k * 4;
              chunkPlaceholders.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4})`);
            }

            const batchSize = 100;
            for (let i = 0; i < chunkPlaceholders.length; i += batchSize) {
              const pBatch = chunkPlaceholders.slice(i, i + batchSize);
              const vBatch = chunkVals.slice(i * 4, (i + batchSize) * 4);
              const rebindexedPlaceholders = pBatch.map((_, idx) => {
                const base = idx * 4;
                return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
              });

              await pool.query(
                `INSERT INTO module_text_chunks (module_id, content, chunk_order, duration_seconds)
                 VALUES ${rebindexedPlaceholders.join(", ")}`,
                vBatch
              );
            }
          }
        }
      } */
      // END: text_stream support removed

      if (pdf?.path) {
        if (!uploadProvider || uploadProvider === "supabase") {
          await removeLocalFileSafe(pdf.path);
        }
      }
    }

    res.status(201).json({
      message: "Modules added successfully",
      count: modules.length,
    });
  } catch (error) {
    console.error("addModules error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

const baseUrl = process.env.BACKEND_URL;

export const getModulesByCourse = async (req, res) => {
  const { courseId } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT
        module_id,
        title,
        type,
        -- ✅ Return Supabase URL directly for PDFs
        content_url,
        duration_mins,
        module_order,
        notes,
        pdf_filename,
        created_at
      FROM modules
      WHERE course_id = $1
      ORDER BY module_order ASC
      `,
      [courseId]
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("getModulesByCourse error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const getModuleView = async (req, res) => {
  const { moduleId } = req.params;
  const { type: queryType } = req.query;

  try {
    let result;
    try {
      // Try query with s3_object_path (new schema)
      result = await pool.query(
        `
        SELECT m.content_url, m.s3_object_path, m.type, c.expires_at
        FROM modules m
        JOIN courses c ON m.course_id = c.courses_id
        WHERE m.module_id = $1
        `,
        [moduleId]
      );
    } catch (err) {
      if (err.message && err.message.includes('s3_object_path')) {
        // Column doesn't exist - use fallback query
        console.warn("s3_object_path column not found, using fallback query");
        result = await pool.query(
          `
          SELECT m.content_url, NULL as s3_object_path, m.type, c.expires_at
          FROM modules m
          JOIN courses c ON m.course_id = c.courses_id
          WHERE m.module_id = $1
          `,
          [moduleId]
        );
      } else {
        throw err;
      }
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Module not found" });
    }

    const moduleData = result.rows[0];

    // Check if course has expired
    if (moduleData.expires_at && new Date(moduleData.expires_at) < new Date()) {
      return res.status(410).json({ message: "Course access has expired" });
    }

    // ✅ Set security headers for iframe compatibility
    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Security-Policy", "frame-ancestors 'self' *");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
    
    // ✅ Set caching headers for faster loading
    res.setHeader("Cache-Control", "public, max-age=86400"); // Cache for 24 hours
    res.setHeader("ETag", `"${moduleId}"`);

    // Generate fresh signed URL if this is an S3 object
    let streamUrl = moduleData.content_url;
    if (moduleData.s3_object_path && !streamUrl) {
      try {
        // Generate URL with expiration matching course validity
        streamUrl = await getSignedUrlForObjectWithExpiry(
          moduleData.s3_object_path,
          moduleData.expires_at
        );
      } catch (err) {
        console.warn("Failed to generate S3 signed URL:", err.message);
        return res.status(500).json({ message: "Failed to generate content URL" });
      }
    }

    // URL — stream the content directly (faster than proxy)
    if (streamUrl) {
      try {
        const urlObj = new URL(streamUrl);
        const fileName = urlObj.pathname.split("/").pop() || "document";
        const isHtml = queryType === 'html' || fileName.match(/\.html?($|\?)/i) || moduleData.type === 'html';
        const isPdf = queryType === 'pdf' || fileName.match(/\.pdf($|\?)/i) || moduleData.type === 'pdf';
        const isVideo = fileName.match(/\.(mp4|webm|ogg|mov|avi|mkv)($|\?)/i) || moduleData.type === 'video';

        if (isHtml) {
          res.setHeader("Content-Type", "text/html");
        } else if (isPdf) {
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", "inline");
        } else if (isVideo) {
          res.setHeader("Content-Type", "video/mp4");
          res.setHeader("Accept-Ranges", "bytes");
        }

        const response = await axios.get(streamUrl, { 
          responseType: "stream",
          timeout: 30000 
        });
        
        // Forward important headers from source
        if (response.headers['content-length']) {
          res.setHeader('Content-Length', response.headers['content-length']);
        }
        if (response.headers['content-type'] && !isPdf && !isVideo) {
          res.setHeader('Content-Type', response.headers['content-type']);
        }
        
        return response.data.pipe(res);
      } catch (proxyErr) {
        console.warn("Stream failed, returning error:", proxyErr.message);
        return res.status(500).json({ message: "Failed to load content" });
      }
    }

    res.status(404).json({ message: "Content not found" });
  } catch (error) {
    console.error("getModuleView error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const deleteModule = async (req, res) => {
  const { moduleId } = req.params;

  try {
    // 🔐 Check instructor ownership via course
    const ownershipCheck = await pool.query(
      `SELECT m.module_id
       FROM modules m
       JOIN courses c ON m.course_id = c.course_id
       WHERE m.module_id = $1 AND c.instructor_id = $2`,
      [moduleId, req.user.id]
    );

    if (ownershipCheck.rows.length === 0) {
      return res.status(403).json({
        message: "You are not allowed to delete this module",
      });
    }

    await pool.query(
      `DELETE FROM modules WHERE module_id = $1`,
      [moduleId]
    );

    res.status(200).json({
      message: "Module deleted successfully",
    });
  } catch (error) {
    console.error("deleteModule error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const getModuleStream = async (req, res) => {
  try {
    const { moduleId } = req.params;
    const studentId = req.user.id;

    // 1. Get Progress
    let progress = await pool.query(
      `SELECT current_chunk_index, completed_at FROM module_progress 
       WHERE module_id = $1 AND student_id = $2`,
      [moduleId, studentId]
    );

    let currentIndex = 0;
    let isCompleted = false;

    if (progress.rows.length === 0) {
      // First access, create progress entry
      // Fetch course_id first to avoid subquery issues with UUIDs
      const courseRes = await pool.query(`SELECT course_id FROM modules WHERE module_id = $1`, [moduleId]);

      if (courseRes.rows.length > 0) {
        const courseId = courseRes.rows[0].course_id;
        await pool.query(
          `INSERT INTO module_progress (module_id, student_id, course_id, current_chunk_index, last_accessed_at)
           VALUES ($1, $2, $3, 0, NOW())
           ON CONFLICT (module_id, student_id) DO NOTHING`,
          [moduleId, studentId, courseId]
        );
      } else {
        console.warn(`Module ${moduleId} not found when initializing progress`);
        return res.status(404).json({ message: "Module not found" });
      }
    } else {
      currentIndex = progress.rows[0].current_chunk_index || 0;
      isCompleted = !!progress.rows[0].completed_at;
    }

    // 2. Check Total Chunks
    const chunksRes = await pool.query(
      `SELECT chunk_id, content, chunk_order, duration_seconds 
       FROM module_text_chunks 
       WHERE module_id = $1 
       ORDER BY chunk_order ASC`,
      [moduleId]
    );
    const allChunks = chunksRes.rows;

    if (allChunks.length === 0) {
      return res.status(404).json({ message: "No content found for this module" });
    }

    // 3. If Completed, Return ALL chunks (Review Mode)
    if (isCompleted || currentIndex >= allChunks.length) {
      return res.json({
        completed: true,
        chunks: allChunks
      });
    }

    // 4. Return Accumulated Chunks (Streaming Mode)
    const chunksSoFar = allChunks.slice(0, currentIndex + 1);
    const currentChunk = chunksSoFar[chunksSoFar.length - 1];

    res.json({
      completed: false,
      chunks: chunksSoFar,
      currentChunk: currentChunk,
      index: currentIndex,
      total: allChunks.length
    });

  } catch (err) {
    console.error("getModuleStream error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const advanceModuleStream = async (req, res) => {
  try {
    const { moduleId } = req.params;
    const studentId = req.user.id;

    // 1. Get Current Progress
    const progress = await pool.query(
      `SELECT current_chunk_index FROM module_progress 
       WHERE module_id = $1 AND student_id = $2`,
      [moduleId, studentId]
    );

    if (progress.rows.length === 0) {
      return res.status(400).json({ message: "No progress found. Start the module first." });
    }

    let currentIndex = progress.rows[0].current_chunk_index || 0;

    // 2. Get Total Chunks Count
    const countRes = await pool.query(
      `SELECT COUNT(*) as count FROM module_text_chunks WHERE module_id = $1`,
      [moduleId]
    );
    const totalChunks = parseInt(countRes.rows[0].count);

    // 3. Advance Index
    const nextIndex = currentIndex + 1;

    // 4. Update Progress
    console.log(`[AdvanceStream] Module: ${moduleId}, Student: ${studentId}, NextIndex: ${nextIndex}, Total: ${totalChunks}`);

    if (nextIndex >= totalChunks) {
      // Mark as Completed
      const updateRes = await pool.query(
        `UPDATE module_progress 
         SET current_chunk_index = $1, completed_at = NOW(), last_accessed_at = NOW()
         WHERE module_id = $2 AND student_id = $3
         RETURNING module_id, student_id`,
        [totalChunks, moduleId, studentId]
      );

      if (updateRes.rowCount === 0) {
        console.warn(`[AdvanceStream] No progress record found to update for M:${moduleId} S:${studentId}`);
        return res.status(404).json({ message: "Progress record not found" });
      }

      // Also mark module completion in course_progress if needed (logic might be separate, but good to know)
      res.json({ completed: true, message: "Module completed" });
    } else {
      // Just Advance
      const updateRes = await pool.query(
        `UPDATE module_progress 
         SET current_chunk_index = $1, last_accessed_at = NOW()
         WHERE module_id = $2 AND student_id = $3`,
        [nextIndex, moduleId, studentId]
      );

      if (updateRes.rowCount === 0) {
        console.warn(`[AdvanceStream] No progress record found to update for M:${moduleId} S:${studentId}`);
        return res.status(404).json({ message: "Progress record not found" });
      }

      res.json({ completed: false, nextIndex });
    }

  } catch (err) {
    console.error(`[AdvanceStream Error] Module: ${req.params?.moduleId} User: ${req.user?.id}`, err);
    res.status(500).json({ message: "Server error marking progress" });
  }
};

export const updateModuleTime = async (req, res) => {
  try {
    const { moduleId } = req.params;
    const { seconds } = req.body;
    const studentId = req.user.id;

    console.log(`[updateModuleTime] Received request for module ${moduleId} from student ${studentId} with ${seconds} seconds`);

    if (isNaN(seconds) || seconds <= 0) {
      console.log(`[updateModuleTime] Invalid seconds value: ${seconds}`);
      return res.status(400).json({ message: "Invalid seconds value" });
    }

    // Update or insert progress with updated time
    // We try to find the row first to get the course_id if it's missing
    const progress = await pool.query(
      `SELECT course_id FROM module_progress WHERE module_id = $1 AND student_id = $2`,
      [moduleId, studentId]
    );

    if (progress.rows.length > 0) {
      await pool.query(
        `UPDATE module_progress 
         SET time_spent_seconds = COALESCE(time_spent_seconds, 0) + $1, last_accessed_at = NOW()
         WHERE module_id = $2 AND student_id = $3`,
        [parseInt(seconds), moduleId, studentId]
      );
    } else {
      // If no progress exists, we need course_id
      const moduleRes = await pool.query(`SELECT course_id FROM modules WHERE module_id = $1`, [moduleId]);
      if (moduleRes.rows.length === 0) {
        return res.status(404).json({ message: "Module not found" });
      }

      const courseId = moduleRes.rows[0].course_id;
      await pool.query(
        `INSERT INTO module_progress (module_id, student_id, course_id, time_spent_seconds, last_accessed_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [moduleId, studentId, courseId, parseInt(seconds)]
      );
    }

    res.json({ success: true, message: "Time updated" });
  } catch (err) {
    console.error("updateModuleTime error:", err);
    res.status(500).json({ message: "Server error updating time" });
  }
};