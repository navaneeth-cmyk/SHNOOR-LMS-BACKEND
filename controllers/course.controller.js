import pool from "../db/postgres.js";
import csv from "csv-parser";
import { Readable } from "stream";
import axios from "axios";
import fs from "fs";
import {
  uploadLocalFileToS3,
  resolveS3StorageFolder,
  removeLocalFileSafe,
} from "../services/s3Storage.service.js";

const baseUrl = process.env.BACKEND_URL;

const toISTTimestamp = (value) => {
  if (!value) return null;

  const raw = String(value).trim();
  const localDateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

  if (localDateTimePattern.test(raw)) {
    const [datePart, timePartRaw] = raw.split("T");
    const timePart = timePartRaw.length === 5 ? `${timePartRaw}:00` : timePartRaw;
    return `${datePart} ${timePart}`;
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(parsed);

  const partValue = (type) => parts.find((part) => part.type === type)?.value;
  const year = partValue("year");
  const month = partValue("month");
  const day = partValue("day");
  const hour = partValue("hour");
  const minute = partValue("minute");
  const second = partValue("second");

  if (!year || !month || !day || !hour || !minute || !second) return null;

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
};

const extractTextStreamContent = async ({ notes, contentUrl, file }) => {
  // 🚫 COMMENTED OUT: text_stream support removed - only PDFs supported
  /*
  let text = String(notes || "").trim();

  // If a file was just uploaded, read it directly from disk (most reliable)
  if (!text && file && file.path) {
    try {
      if (fs.existsSync(file.path)) {
        text = fs.readFileSync(file.path, "utf-8");
      }
    } catch (err) {
      console.warn("Could not read uploaded text_stream file from disk:", err.message);
    }
  }

  // Fallback: fetch contentUrl if it's an external link
  if (!text && contentUrl && /^https?:\/\//i.test(contentUrl)) {
    try {
      const response = await axios.get(contentUrl, {
        responseType: "text",
        transformResponse: [(data) => data],
      });
      const contentType = String(response.headers?.["content-type"] || "").toLowerCase();
      const isTextLike =
        contentType.includes("text/plain") ||
        contentType.includes("text/markdown") ||
        contentType.includes("text/html") ||
        /\.txt($|\?)/i.test(contentUrl) ||
        /\.md($|\?)/i.test(contentUrl) ||
        /\.html?($|\?)/i.test(contentUrl);

      if (isTextLike && typeof response.data === "string") {
        text = response.data;
      }
    } catch (err) {
      console.warn("Could not fetch text_stream content from URL:", err?.message || err);
    }
  }

  // Strip HTML tags if content is HTML
  if (text && (/\.html?($|\?)/i.test(String(contentUrl || "")) || /<[a-z][\s\S]*>/i.test(text))) {
    text = text.replace(/<[^>]*>?/gm, " ").replace(/\s+/g, " ").trim();
  }

  return text;
  */
  return "";
};

const rebuildTextChunks = async (moduleId, textContent) => {
  // 🚫 COMMENTED OUT: text_stream support removed - only PDFs supported
  /*
  await pool.query(`DELETE FROM module_text_chunks WHERE module_id = $1`, [moduleId]);

  const allWords = String(textContent || "")
    .split(/\s+/)
    .filter((c) => c.length > 0);

  if (!allWords.length) return 0;

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
    // roughly 1 second per 5 words
    const duration = Math.max(1, Math.ceil(c.wordCount / 5));
    chunkVals.push(moduleId, c.content, k, duration);
    const o = k * 4;
    chunkPlaceholders.push(`($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4})`);
  }

  await pool.query(
    `INSERT INTO module_text_chunks (module_id, content, chunk_order, duration_seconds)
     VALUES ${chunkPlaceholders.join(", ")}`,
    chunkVals
  );

  return chunks.length;
  */
  return 0;
};

export const addCourse = async (req, res) => {
  const instructor_id = req.user.id;
  const {
    title,
    description,
    category,
    thumbnail_url,
    difficulty,
    status,
    validity_value,
    validity_unit,
    schedule_start_at,
    price_type,
    price_amount,
    prereq_description,
    // 🚫 COMMENTED OUT: Video URLs no longer supported
    // prereq_video_urls,
    prereq_pdf_url,
  } = req.body || {};

  try {
    // ✅ CALCULATE expires_at IN JS (no Postgres interval issues)
    let expiresAt = null;
    let normalizedScheduleStartAt = null;

    if (validity_value && validity_unit) {
      const now = new Date();

      if (validity_unit === "days") {
        now.setDate(now.getDate() + Number(validity_value));
      } else if (validity_unit === "months") {
        now.setMonth(now.getMonth() + Number(validity_value));
      } else if (validity_unit === "years") {
        now.setFullYear(now.getFullYear() + Number(validity_value));
      }

      expiresAt = now;
    }

    normalizedScheduleStartAt = toISTTimestamp(schedule_start_at);

    const query = `
      INSERT INTO courses (
        instructor_id,
        title,
        description,
        category,
        thumbnail_url,
        difficulty,
        status,
        validity_value,
        validity_unit,
        expires_at,
        schedule_start_at,
        price_type,
        price_amount,
        prereq_description,
        prereq_pdf_url
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
      )
      RETURNING *
    `;

    const values = [
      instructor_id, // $1
      title, // $2
      description, // $3
      category, // $4
      thumbnail_url || null, // $5
      difficulty || null, // $6
      status === "pending" ? "pending" : "draft", // $7
      validity_value || null, // $8
      validity_unit || null, // $9
      expiresAt, // $10 ✅ SIMPLE TIMESTAMP
      normalizedScheduleStartAt, // $11 (IST-normalized)
      price_type, // $12
      price_type === "paid" ? price_amount : null, // $13
      prereq_description || null,
      prereq_pdf_url || null, // Only PDF URL, no video URLs
    ];

    const result = await pool.query(query, values);

    res.status(201).json({
      message: "Course created successfully",
      course: result.rows[0],
    });
  } catch (error) {
    console.error("addCourse error:", error);
    res.status(400).json({ message: error.message });
  }
};

export const getInstructorCourses = async (req, res) => {
  try {
    const result = await pool.query(
      `
  SELECT
    c.courses_id,
    c.title,
    c.description,
    c.category,
    c.status,
    c.difficulty,
    c.created_at,
    COALESCE(
      json_agg(
        json_build_object(
          'module_id', m.module_id,
          'title', m.title,
          'type', m.type,
          'duration', m.duration_mins,
          'order', m.module_order,
          'content_url', CASE 
            WHEN m.pdf_filename IS NOT NULL THEN '${baseUrl}/api/modules/' || m.module_id || '/pdf'
            ELSE m.content_url 
          END
        )
        ORDER BY m.module_order
      ) FILTER (WHERE m.module_id IS NOT NULL),
      '[]'
    ) AS modules
  FROM courses c
  LEFT JOIN modules m ON m.course_id = c.courses_id
  WHERE c.instructor_id = $1
  GROUP BY c.courses_id, c.title, c.description, c.category, 
         c.status, c.difficulty, c.created_at
  ORDER BY c.created_at DESC
  `,
      [req.user.id],
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("getInstructorCourses error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const getPendingCourses = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, u.full_name AS instructor_name
       FROM courses c
       JOIN users u ON c.instructor_id = u.user_id
       WHERE c.status IN ('pending', 'review')
       ORDER BY c.created_at DESC`,
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("getPendingCourses error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const approveCourse = async (req, res) => {
  const { courseId } = req.params;
  const { status } = req.body; // approved | rejected

  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({
      message: "Invalid status value",
    });
  }

  try {
    const result = await pool.query(
      `UPDATE courses
       SET status = $1
       WHERE courses_id = $2
       RETURNING *`,
      [status, courseId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "Course not found",
      });
    }

    res.status(200).json({
      message: `Course ${status} successfully`,
      course: result.rows[0],
    });
  } catch (error) {
    console.error("approveCourse error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const getApprovedCourses = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, u.full_name AS instructor_name
       FROM courses c
       JOIN users u ON c.instructor_id = u.user_id
       WHERE c.status = 'approved'
       ORDER BY c.created_at DESC`,
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("getApprovedCourses error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const deleteCourse = async (req, res) => {
  const { courseId } = req.params;

  if (!courseId) {
    return res.status(400).json({ message: "courseId is required" });
  }

  try {
    /* 🔐 CHECK OWNERSHIP */
    const courseCheck = await pool.query(
      `
      SELECT courses_id
      FROM courses
      WHERE courses_id = $1 AND instructor_id = $2
      `,
      [courseId, req.user.id],
    );

    if (courseCheck.rows.length === 0) {
      return res.status(403).json({
        message: "You are not allowed to delete this course",
      });
    }

    /* 🧹 DELETE DEPENDENT DATA */
    await pool.query(`DELETE FROM modules WHERE course_id = $1`, [courseId]);

    await pool.query(`DELETE FROM course_assignments WHERE course_id = $1`, [
      courseId,
    ]);

    /* 🗑 DELETE COURSE */
    await pool.query(`DELETE FROM courses WHERE courses_id = $1`, [courseId]);

    res.status(200).json({
      message: "Course deleted successfully",
    });
  } catch (error) {
    console.error("deleteCourse error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const getApprovedCoursesForInstructor = async (req, res) => {
  try {
    const instructorId = req.user.id;

    const result = await pool.query(
      `
      SELECT c.courses_id, c.title
      FROM courses c
      WHERE c.status = 'approved'
        AND c.instructor_id = $1
      ORDER BY c.created_at DESC
      `,
      [instructorId],
    );

    res.status(200).json(result.rows);
  } catch (error) {
    console.error("getApprovedCoursesForInstructor error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const getInstructorCourseStats = async (req, res) => {
  try {
    const instructorId = req.user.id;
    let { startDate, endDate } = req.query;
    const performanceDataRes = await pool.query(
      `SELECT TO_CHAR(CURRENT_DATE - gs.day, 'Mon DD') as name, COUNT(DISTINCT mp.student_id) as students 
       FROM generate_series(6, 0, -1) as gs(day) 
       LEFT JOIN module_progress mp ON DATE(COALESCE(mp.last_accessed_at, mp.completed_at)) = (CURRENT_DATE - gs.day) 
         AND mp.course_id IN (SELECT courses_id FROM courses WHERE instructor_id = $1) 
       GROUP BY gs.day 
       ORDER BY gs.day DESC`,
      [instructorId]
    );

    // If no date filters provided, return all-time totals
    if (!startDate || !endDate) {
      const { rows } = await pool.query(
        `
        SELECT 
          COUNT(*) AS total_courses,
          (SELECT AVG(rating) FROM instructor_reviews WHERE instructor_id = $1) AS avg_rating
        FROM courses
        WHERE instructor_id = $1
        `,
        [instructorId],
      );

      return res.json({
        total_courses: rows[0].total_courses || 0,
        avg_rating: Number(rows[0].avg_rating || 5.0).toFixed(1),
        coursesChange: 0,
        performanceData: performanceDataRes.rows
      });
    }

    // Calculate previous period (same duration) for change percentages
    const start = new Date(startDate);
    const end = new Date(endDate);
    const durationMs = end - start;
    const prevEnd = new Date(start.getTime() - 86400000); // 1 day before start
    const prevStart = new Date(prevEnd.getTime() - durationMs);
    const prevStartDate = prevStart.toISOString().slice(0, 10);
    const prevEndDate = prevEnd.toISOString().slice(0, 10);
    
    // Add AVG rating to the filtered query as well
    const ratingRes = await pool.query(
      `SELECT AVG(rating) as avg_rating FROM instructor_reviews WHERE instructor_id = $1`,
      [instructorId]
    );

    const { rows: currentStats } = await pool.query(
      `SELECT COUNT(*) AS total_courses FROM courses WHERE instructor_id = $1 AND created_at::date BETWEEN $2 AND $3`,
      [instructorId, startDate, endDate]
    );

    const { rows: prevStats } = await pool.query(
      `SELECT COUNT(*) AS total_courses FROM courses WHERE instructor_id = $1 AND created_at::date BETWEEN $2 AND $3`,
      [instructorId, prevStartDate, prevEndDate]
    );

    const currentCourses = Number(currentStats[0].total_courses) || 0;
    const prevCourses = Number(prevStats[0].total_courses) || 0;
    const coursesChange = prevCourses > 0 ? ((currentCourses - prevCourses) / prevCourses * 100).toFixed(2) : 0;

    return res.json({
      total_courses: currentCourses,
      avg_rating: Number(ratingRes.rows[0].avg_rating || 5.0).toFixed(1),
      coursesChange,
      performanceData: performanceDataRes.rows
    });
  } catch (err) {
    console.error("Instructor course stats error:", err);
    res.status(500).json({ message: "Failed to fetch course stats" });
  }
};

export const getCourseById = async (req, res) => {
  try {
    const { courseId } = req.params;

    const { rows } = await pool.query(
      `
      SELECT
        c.courses_id,
        c.title,
        c.description,
        c.category,
        c.difficulty AS level,        -- 👈 FIX LEVEL
        c.created_at AS updatedAt, 
         c.prereq_description,
        -- 🚫 COMMENTED OUT: Video URLs no longer supported
        -- c.prereq_video_urls,
        c.prereq_pdf_url,

        json_build_object(            -- 👈 FIX INSTRUCTOR
          'name', u.full_name,
          'email', u.email
        ) AS instructor

      FROM courses c
      LEFT JOIN users u
        ON u.user_id = c.instructor_id

      WHERE c.courses_id = $1
      `,
      [courseId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Course not found" });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("getCourseById error:", err);
    res.status(500).json({ message: "Failed to fetch course" });
  }
};

export const exploreCourses = async (req, res) => {
  try {
    const studentId = req.user.id;

    const { rows } = await pool.query(
      `
      SELECT * FROM (
        SELECT DISTINCT
          c.courses_id,
          c.title,
          c.description,
          c.category,
          c.difficulty,
          c.created_at,
          c.price_type,
          c.price_amount,
          c.schedule_start_at,
          c.thumbnail_url,
          c.instructor_id,
          u.full_name AS instructor_name,
          CASE WHEN ca.student_id IS NOT NULL THEN true ELSE false END AS is_assigned,
          CASE WHEN sc.student_id IS NOT NULL THEN true ELSE false END AS is_enrolled,
          CASE WHEN c.price_type = 'paid' THEN true ELSE false END AS is_paid,
          false AS is_completed,
          CASE WHEN ca.student_id IS NOT NULL THEN 0 ELSE 1 END AS assigned_sort
        FROM courses c
        LEFT JOIN users u ON u.user_id = c.instructor_id
        LEFT JOIN student_courses sc
          ON sc.course_id = c.courses_id
         AND sc.student_id = $1
        LEFT JOIN course_assignments ca
          ON ca.course_id = c.courses_id
         AND ca.student_id = $1
        WHERE c.status = 'approved'
        AND (c.schedule_start_at IS NULL OR c.schedule_start_at <= (NOW() AT TIME ZONE 'Asia/Kolkata'))
        AND sc.student_id IS NULL
      ) AS subquery
      ORDER BY
        assigned_sort ASC,
        created_at DESC
      `,
      [studentId],
    );

    res.json(rows);
  } catch (err) {
    console.error("Explore courses error:", err);
    res.status(500).json({ message: "Failed to load explore courses" });
  }
};

export const bulkUploadCourses = async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No CSV file uploaded" });
  }

  const results = [];
  const errors = [];
  let successCount = 0;

  try {
    // Parse CSV from buffer
    const stream = Readable.from(req.file.buffer.toString("utf-8"));

    await new Promise((resolve, reject) => {
      stream
        .pipe(csv())
        .on("data", (data) => results.push(data))
        .on("error", (err) => reject(err))
        .on("end", async () => {
          try {
            if (results.length === 0) {
              return reject(new Error("CSV file is empty"));
            }

            // Group by course_title
            const coursesMap = {};

            results.forEach((row, index) => {
              const courseTitle = row.course_title?.trim();
              if (!courseTitle) {
                errors.push({ row: index + 2, message: "Missing course_title" });
                return;
              }

              if (!coursesMap[courseTitle]) {
                coursesMap[courseTitle] = {
                  details: {
                    title: courseTitle,
                    category: row.category,
                    level: row.level,
                    validity: row.validity,
                    description: row.description,
                    thumbnail_url: row.thumbnail_url,
                    price_type: row.price_type,
                  },
                  modules: [],
                };
              }

              if (row.module_name) {
                coursesMap[courseTitle].modules.push({
                  title: row.module_name,
                  type: row.module_type,
                  duration: row.module_duration,
                  content_url: row.module_source,
                  notes: row.module_notes,
                });
              }
            });

            const client = await pool.connect();
            try {
              for (const courseTitle in coursesMap) {
                const courseData = coursesMap[courseTitle];
                const details = courseData.details;

                await client.query("BEGIN");
                try {
                  const isPaid = details.price_type?.toLowerCase() === "paid";
                  let difficulty = details.level || "Beginner";
                  difficulty = difficulty.charAt(0).toUpperCase() + difficulty.slice(1).toLowerCase();
                  if (!["Beginner", "Intermediate", "Advanced"].includes(difficulty)) {
                    difficulty = "Beginner";
                  }

                  let validityValue = details.validity ? parseInt(details.validity) : null;
                  let validityUnit = 'days';

                  // Safe interval construction
                  const expiresAtFragment = validityValue ? `NOW() + INTERVAL '${validityValue} days'` : "NULL";

                  const insertCourseQuery = `
                    INSERT INTO courses (
                      instructor_id, title, description, category, thumbnail_url, 
                      difficulty, status, validity_value, validity_unit, expires_at, 
                      price_type, price_amount
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ${expiresAtFragment}, $10, $11)
                    RETURNING courses_id
                  `;

                  const courseRes = await client.query(insertCourseQuery, [
                    req.user.id,
                    details.title,
                    details.description,
                    details.category,
                    details.thumbnail_url,
                    difficulty,
                    "pending",
                    validityValue,
                    validityUnit,
                    isPaid ? "paid" : "free",
                    0
                  ]);

                  const courseId = courseRes.rows[0].courses_id;

                  for (let i = 0; i < courseData.modules.length; i++) {
                    const mod = courseData.modules[i];
                    let type = mod.type?.toLowerCase();
                    if (!['video', 'pdf', 'text_stream'].includes(type)) type = 'video';

                    let moduleId;

                    if (type === 'text_stream') {
                      // Text Stream Handling
                      let textContent = mod.content_url || "";
                      const isUrl = textContent.match(/^https?:\/\//i);

                      if (isUrl) {
                        // If it's a URL (Gamma, HTML, etc.), use fallback text for the stream
                        textContent = "This module contains a visual presentation or external document. Please refer to the content area below.";
                      }

                      // Split into chunks (simple space-based split for typewriter effect)
                      const chunks = textContent.split(/\s+/).filter(c => c.length > 0).map(c => c + " ");

                      const modRes = await client.query(
                        `INSERT INTO modules (course_id, title, type, content_url, duration_mins, module_order, notes)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)
                         RETURNING module_id`,
                        [
                          courseId,
                          mod.title,
                          type,
                          mod.content_url, // Keep original URL/Content in module record
                          mod.duration ? parseInt(mod.duration) : 0,
                          i + 1,
                          mod.notes || null
                        ]
                      );
                      moduleId = modRes.rows[0].module_id;

                      if (chunks.length > 0) {
                        const values = [];
                        const placeholders = [];
                        for (let k = 0; k < chunks.length; k++) {
                          values.push(moduleId, chunks[k], k, 1); // 1 sec duration per chunk
                          const offset = k * 4;
                          placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
                        }

                        const insertChunkQuery = `
                          INSERT INTO module_text_chunks (module_id, content, chunk_order, duration_seconds)
                          VALUES ${placeholders.join(', ')}
                        `;
                        await client.query(insertChunkQuery, values);
                      }

                    } else {
                      // Standard Video/PDF Handling
                      await client.query(
                        `INSERT INTO modules (course_id, title, type, content_url, duration_mins, module_order, notes)
                         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                        [
                          courseId,
                          mod.title,
                          type,
                          mod.content_url,
                          mod.duration ? parseInt(mod.duration) : 0,
                          i + 1,
                          mod.notes || null
                        ]
                      );
                    }
                  }

                  await client.query("COMMIT");
                  successCount++;
                } catch (err) {
                  await client.query("ROLLBACK");
                  console.error(`Error creating course ${courseTitle}:`, err);
                  errors.push({ course: courseTitle, message: err.message });
                }
              }
            } finally {
              client.release();
            }
            resolve();
          } catch (err) {
            reject(err);
          }
        });
    });

    res.json({
      message: "Bulk upload processed",
      successCount,
      errors,
    });

  } catch (err) {
    console.error("Bulk upload error:", err);
    res.status(err.message === "CSV file is empty" ? 400 : 500).json({
      message: err.message || "Server error during bulk upload"
    });
  }
};

export const searchInstructorCoursesAndModules = async (req, res) => {
  try {
    const { query } = req.query;
    const instructorId = req.user.id;

    if (!query || !query.trim()) {
      return res.json([]);
    }

    const searchTerm = `%${query.trim()}%`;

    // Search instructor's courses and modules
    const result = await pool.query(
      `SELECT * FROM (
        -- Search Instructor's Courses
        SELECT 
          c.courses_id AS id,
          c.title,
          c.description,
          c.category,
          c.status,
          c.difficulty,
          c.thumbnail_url,
          c.validity_value,
          c.validity_unit,
          c.expires_at,
          c.created_at,
          c.instructor_id,
          $2::TEXT AS instructor_name,
          'course' AS type,
          NULL AS course_title
        FROM courses c
        WHERE c.instructor_id = $3
          AND (LOWER(c.title) LIKE LOWER($1)
            OR LOWER(COALESCE(c.description, '')) LIKE LOWER($1)
            OR LOWER(COALESCE(c.category, '')) LIKE LOWER($1))
        
        UNION ALL
        
        -- Search Instructor's Modules
        SELECT 
          m.module_id AS id,
          m.title,
          c.description,
          c.category,
          c.status,
          c.difficulty,
          c.thumbnail_url,
          c.validity_value,
          c.validity_unit,
          c.expires_at,
          m.created_at,
          c.instructor_id,
          $2::TEXT AS instructor_name,
          'module' AS type,
          c.title AS course_title
        FROM modules m
        JOIN courses c ON m.course_id = c.courses_id
        WHERE c.instructor_id = $3
          AND (LOWER(m.title) LIKE LOWER($1)
            OR LOWER(COALESCE(m.notes, '')) LIKE LOWER($1))
      ) AS combined_results
      ORDER BY created_at DESC
      LIMIT 20`,
      [searchTerm, req.user.full_name || 'Instructor', instructorId]
    );

    res.json(result.rows);

  } catch (error) {
    console.error('Instructor search error:', error);
    res.status(500).json({
      error: 'Failed to search courses and modules',
      message: error.message
    });
  }
};

export const submitForReview = async (req, res) => {
  try {
    const { courseId } = req.params;
    const instructorId = req.user.id;

    // Verify ownership and current status
    const courseCheck = await pool.query(
      `SELECT courses_id, status, title FROM courses 
       WHERE courses_id = $1 AND instructor_id = $2`,
      [courseId, instructorId]
    );

    if (courseCheck.rows.length === 0) {
      return res.status(404).json({
        message: "Course not found or you don't have permission"
      });
    }

    const course = courseCheck.rows[0];

    // Validate state transition
    if (course.status !== 'pending') {
      return res.status(400).json({
        message: `Cannot submit course in '${course.status}' status. Only draft courses can be submitted.`
      });
    }

    // Check if course has at least one module
    const moduleCheck = await pool.query(
      `SELECT COUNT(*) as module_count FROM modules WHERE course_id = $1`,
      [courseId]
    );

    if (Number(moduleCheck.rows[0].module_count) === 0) {
      return res.status(400).json({
        message: "Course must have at least one module before submission"
      });
    }

    // Update status to 'review'
    const result = await pool.query(
      `UPDATE courses 
       SET status = 'review', submitted_at = NOW()
       WHERE courses_id = $1
       RETURNING *`,
      [courseId]
    );

    res.status(200).json({
      message: "Course submitted for review successfully",
      course: result.rows[0],
    });
  } catch (error) {
    console.error("submitForReview error:", error);
    res.status(500).json({ message: "Failed to submit course for review" });
  }
};

export const publishCourse = async (req, res) => {
  try {
    const { courseId } = req.params;

    // Verify course exists and is in review status
    const courseCheck = await pool.query(
      `SELECT courses_id, status, title FROM courses WHERE courses_id = $1`,
      [courseId]
    );

    if (courseCheck.rows.length === 0) {
      return res.status(404).json({ message: "Course not found" });
    }

    const course = courseCheck.rows[0];

    if (course.status !== 'review') {
      return res.status(400).json({
        message: `Cannot approve course in '${course.status}' status. Only courses under review can be approved.`
      });
    }

    // Update status to 'approved'
    const result = await pool.query(
      `UPDATE courses 
       SET status = 'approved'
       WHERE courses_id = $1
       RETURNING *`,
      [courseId]
    );

    res.status(200).json({
      message: "Course approved successfully",
      course: result.rows[0],
    });
  } catch (error) {
    console.error("publishCourse error:", error);
    res.status(500).json({ message: "Failed to approve course" });
  }
};

export const rejectCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { reason } = req.body; // Optional rejection reason

    // Verify course exists and is in review status
    const courseCheck = await pool.query(
      `SELECT courses_id, status, title FROM courses WHERE courses_id = $1`,
      [courseId]
    );

    if (courseCheck.rows.length === 0) {
      return res.status(404).json({ message: "Course not found" });
    }

    const course = courseCheck.rows[0];

    if (course.status !== 'review') {
      return res.status(400).json({
        message: `Cannot reject course in '${course.status}' status. Only courses under review can be rejected.`
      });
    }

    // Update status back to 'draft'
    const result = await pool.query(
      `UPDATE courses 
       SET status = 'pending', submitted_at = NULL
       WHERE courses_id = $1
       RETURNING *`,
      [courseId]
    );

    res.status(200).json({
      message: reason ? `Course rejected: ${reason}` : "Course rejected and returned to draft",
      course: result.rows[0],
    });
  } catch (error) {
    console.error("rejectCourse error:", error);
    res.status(500).json({ message: "Failed to reject course" });
  }
};

export const archiveCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Verify course exists and ownership
    const courseCheck = await pool.query(
      `SELECT courses_id, status, instructor_id, title FROM courses WHERE courses_id = $1`,
      [courseId]
    );

    if (courseCheck.rows.length === 0) {
      return res.status(404).json({ message: "Course not found" });
    }

    const course = courseCheck.rows[0];

    // Check permission (admin or course owner)
    if (userRole !== 'admin' && course.instructor_id !== userId) {
      return res.status(403).json({
        message: "You don't have permission to archive this course"
      });
    }

    if (course.status !== 'approved') {
      return res.status(400).json({
        message: `Cannot archive course in '${course.status}' status. Only approved courses can be archived.`
      });
    }

    // Update status to 'archived'
    const result = await pool.query(
      `UPDATE courses 
       SET status = 'archived'
       WHERE courses_id = $1
       RETURNING *`,
      [courseId]
    );

    res.status(200).json({
      message: "Course archived successfully. It is now completely hidden from all users including enrolled students.",
      course: result.rows[0],
    });
  } catch (error) {
    console.error("archiveCourse error:", error);
    res.status(500).json({ message: "Failed to archive course" });
  }
};

export const unarchiveCourse = async (req, res) => {
  try {
    const { courseId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role;

    // Verify course exists and ownership
    const courseCheck = await pool.query(
      `SELECT courses_id, status, instructor_id, title FROM courses WHERE courses_id = $1`,
      [courseId]
    );

    if (courseCheck.rows.length === 0) {
      return res.status(404).json({ message: "Course not found" });
    }

    const course = courseCheck.rows[0];

    // Check permission (admin or course owner)
    if (userRole !== 'admin' && course.instructor_id !== userId) {
      return res.status(403).json({
        message: "You don't have permission to unarchive this course"
      });
    }

    if (course.status !== 'archived') {
      return res.status(400).json({
        message: `Cannot unarchive course in '${course.status}' status. Only archived courses can be unarchived.`
      });
    }

    // Update status back to 'published'
    const result = await pool.query(
      `UPDATE courses 
       SET status = 'approved'
       WHERE courses_id = $1
       RETURNING *`,
      [courseId]
    );

    res.status(200).json({
      message: "Course unarchived successfully. It's now live in the marketplace.",
      course: result.rows[0],
    });
  } catch (error) {
    console.error("unarchiveCourse error:", error);
    res.status(500).json({ message: "Failed to unarchive course" });
  }
};

export const editModule = async (req, res) => {
  try {
    const { moduleId } = req.params;
    const instructorId = req.user.id;

    const ownerCheck = await pool.query(
      `SELECT m.module_id, m.course_id
       FROM modules m
       JOIN courses c ON c.courses_id = m.course_id
       WHERE m.module_id = $1 AND c.instructor_id = $2`,
      [moduleId, instructorId]
    );

    if (ownerCheck.rows.length === 0) {
      return res.status(403).json({ message: "Not authorized to edit this module" });
    }

    const currentModuleResult = await pool.query(
      `SELECT title, type, content_url, notes, duration_mins
       FROM modules
       WHERE module_id = $1`,
      [moduleId]
    );

    if (currentModuleResult.rows.length === 0) {
      return res.status(404).json({ message: "Module not found" });
    }

    const currentModule = currentModuleResult.rows[0];

    const { title, type, content_url, notes, duration_mins } = req.body;
    let finalContentUrl = content_url;

    if (req.file) {
      const ext = req.file.originalname.slice(req.file.originalname.lastIndexOf('.')).toLowerCase();
      if (ext.toLowerCase() === ".pdf" || req.file.mimetype === "application/pdf") {
        try {
          const { url, objectPath } = await uploadLocalFileToS3(
            req.file.path,
            {
              originalName: req.file.originalname,
              mimeType: req.file.mimetype,
              folder: "pdfs",
            }
          );
          finalContentUrl = url;
          await removeLocalFileSafe(req.file.path);
        } catch (uploadErr) {
          console.error("Error uploading PDF to S3:", uploadErr.message);
          throw uploadErr;
        }
      } else {
        throw new Error("Only PDF files are supported for course module content.");
      }
    }

    const effectiveTitle = title !== undefined ? title : currentModule.title;
    const effectiveType = type !== undefined ? type : currentModule.type;
    const effectiveContentUrl =
      finalContentUrl !== undefined ? finalContentUrl : currentModule.content_url;
    const effectiveNotes = notes !== undefined ? notes : currentModule.notes;

    if (!effectiveTitle || !effectiveType) {
      return res.status(400).json({ message: "Title and type are required" });
    }
    if ((effectiveType === "video" || effectiveType === "pdf" || effectiveType === "html") && !effectiveContentUrl) {
      return res.status(400).json({ message: "Please provide a file or valid URL for this module type" });
    }
    if (effectiveType === "text_stream" && !effectiveNotes && !effectiveContentUrl) {
      return res.status(400).json({ message: "Text stream requires notes text or a text/HTML URL" });
    }

    const fields = [];
    const values = [];
    let idx = 1;

    if (title !== undefined) {
      fields.push(`title = $${idx++}`);
      values.push(title);
    }

    if (type !== undefined) {
      fields.push(`type = $${idx++}`);
      values.push(type);
    }

    if (notes !== undefined) {
      fields.push(`notes = $${idx++}`);
      values.push(notes || null);
    }

    if (duration_mins !== undefined && duration_mins !== "") {
      fields.push(`duration_mins = $${idx++}`);
      values.push(Number(duration_mins));
    }

    if (finalContentUrl !== undefined) {
      fields.push(`content_url = $${idx++}`); values.push(finalContentUrl);
      fields.push(`pdf_data = $${idx++}`); values.push(null);
      fields.push(`pdf_filename = $${idx++}`); values.push(null);
      fields.push(`pdf_mime = $${idx++}`); values.push(null);
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: "No changes provided" });
    }

    if (effectiveType === "text_stream") {
      const textContent = await extractTextStreamContent({
        notes: effectiveNotes,
        contentUrl: effectiveContentUrl,
        file: req.file,
      });
      await rebuildTextChunks(moduleId, textContent);
    }

    values.push(moduleId);
    const result = await pool.query(
      `UPDATE modules SET ${fields.join(", ")} WHERE module_id = $${idx}
       RETURNING module_id, course_id, title, type, content_url,
                 duration_mins AS duration, module_order, notes, pdf_filename, created_at,
                 CASE 
                   WHEN type = 'pdf' OR pdf_filename IS NOT NULL THEN '${baseUrl}/api/modules/' || module_id || '/pdf'
                   ELSE content_url 
                 END AS resolved_url`,
      values
    );

    const updatedModule = result.rows[0];
    if (updatedModule.resolved_url) {
      updatedModule.content_url = updatedModule.resolved_url;
    }

    res.status(200).json(updatedModule);
  } catch (error) {
    console.error("editModule error:", error);
    res.status(500).json({ message: "Failed to update module" });
  }
};


// ─── PATCH: addModule in course.controller.js ──────────────────────────────
// Same unified "file" field name for all upload types.

export const addModule = async (req, res) => {
  try {
    const { courseId } = req.params;
    const instructorId = req.user.id;

    const courseCheck = await pool.query(
      `SELECT courses_id FROM courses WHERE courses_id = $1 AND instructor_id = $2`,
      [courseId, instructorId]
    );
    if (courseCheck.rows.length === 0) {
      return res.status(403).json({ message: "Not authorized to add modules to this course" });
    }

    const { title, type, content_url, notes, duration_mins } = req.body;
    let finalContentUrl = content_url || null;

    if (req.file) {
      const ext = req.file.originalname.slice(req.file.originalname.lastIndexOf('.')).toLowerCase();
      if (ext.toLowerCase() === ".pdf" || req.file.mimetype === "application/pdf") {
        try {
          const { url, objectPath } = await uploadLocalFileToS3(
            req.file.path,
            {
              originalName: req.file.originalname,
              mimeType: req.file.mimetype,
              folder: "pdfs",
            }
          );
          finalContentUrl = url;
          await removeLocalFileSafe(req.file.path);
        } catch (uploadErr) {
          console.error("Error uploading PDF to S3:", uploadErr.message);
          throw uploadErr;
        }
      } else {
        throw new Error("Only PDF files are supported for course module content.");
      }
    }

    if (!title || !type) {
      return res.status(400).json({ message: "Title and type are required" });
    }
    if ((type === "video" || type === "pdf" || type === "html") && !finalContentUrl) {
      return res.status(400).json({ message: "Please provide a file or valid URL for this module type" });
    }
    if (type === "text_stream" && !notes && !finalContentUrl) {
      return res.status(400).json({ message: "Text stream requires notes text or a text/HTML URL" });
    }

    const orderResult = await pool.query(
      `SELECT COALESCE(MAX(module_order), 0) + 1 AS next_order FROM modules WHERE course_id = $1`,
      [courseId]
    );
    const nextOrder = orderResult.rows[0].next_order;

    const result = await pool.query(
      `INSERT INTO modules
         (course_id, title, type, content_url, duration_mins, module_order, notes, pdf_data, pdf_filename, pdf_mime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING module_id, course_id, title, type, content_url,
                 duration_mins AS duration, module_order, notes, pdf_filename, created_at,
                 CASE 
                   WHEN pdf_filename IS NOT NULL THEN '${baseUrl}/api/modules/' || module_id || '/pdf'
                   ELSE content_url 
                 END AS resolved_url`,
      [courseId, title, type, finalContentUrl,
        duration_mins ? Number(duration_mins) : null,
        nextOrder, notes || null, null, null, null]
    );

    const newModule = result.rows[0];
    if (newModule.resolved_url) {
      newModule.content_url = newModule.resolved_url;
    }

    if (type === "text_stream") {
      const moduleId = result.rows[0].module_id;
      const textContent = await extractTextStreamContent({
        notes,
        contentUrl: finalContentUrl,
        file: req.file,
      });
      await rebuildTextChunks(moduleId, textContent);
    }

    res.status(201).json(newModule);
  } catch (error) {
    console.error("addModule error:", error);
    res.status(500).json({ message: "Failed to add module" });
  }
};