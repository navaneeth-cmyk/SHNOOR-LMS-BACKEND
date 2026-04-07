import pool from "../db/postgres.js";
export const getStudentDashboard = async (req, res) => {
  try {
    const studentId = req.user.id;

    // 1️⃣ Update streak
    await pool.query(
      `
      UPDATE users
      SET
        streak = CASE
          WHEN last_active_date = CURRENT_DATE THEN streak
          WHEN last_active_date = CURRENT_DATE - INTERVAL '1 day' THEN streak + 1
          ELSE 1
        END,
        last_active_date = CURRENT_DATE
      WHERE user_id = $1
      `,
      [studentId],
    );

    // 2️⃣ Fetch basic stats
    const statsResult = await pool.query(
      `
      SELECT
        u.xp,
        u.streak,
        (
          SELECT COUNT(*)
          FROM (
            SELECT student_id, course_id FROM student_courses
            UNION
            SELECT student_id, course_id FROM course_assignments
          ) combined
          WHERE student_id = u.user_id
        ) AS enrolled_count,
        (
          SELECT json_build_object(
            'id', c.courses_id,
            'title', c.title,
            'thumbnail', c.thumbnail_url,
            'progress', (
               SELECT ROUND((COUNT(mp_inner.module_id)::float / NULLIF((SELECT COUNT(*) FROM modules WHERE course_id = c.courses_id), 0)) * 100)
               FROM module_progress mp_inner
               WHERE mp_inner.student_id = u.user_id AND mp_inner.course_id = c.courses_id AND mp_inner.completed_at IS NOT NULL
            ),
            'last_module_title', (
               SELECT m_inner.title FROM modules m_inner 
               WHERE m_inner.module_id = mp.module_id
            )
          )
          FROM module_progress mp
          JOIN courses c ON c.courses_id = mp.course_id
          WHERE mp.student_id = u.user_id
          ORDER BY mp.last_accessed_at DESC NULLS LAST
          LIMIT 1
        ) AS last_learning
      FROM users u
      WHERE u.user_id = $1
      `,
      [studentId],
    );

    // 3️⃣ Fetch Recent Activity
    const activityResult = await pool.query(
      `
      WITH enrollment_events AS (
        SELECT
          sc.student_id,
          sc.course_id,
          sc.created_at,
          ROW_NUMBER() OVER (
            PARTITION BY sc.student_id, sc.course_id
            ORDER BY sc.created_at DESC
          ) AS rn
        FROM (
          SELECT student_id, course_id, enrolled_at AS created_at FROM student_courses
          UNION ALL
          SELECT student_id, course_id, assigned_at AS created_at FROM course_assignments
        ) sc
        WHERE sc.student_id = $1
      )

      (SELECT 
        'enrollment' AS type,
        c.title AS title,
        ee.created_at AS date,
        NULL::float AS score,
        ee.course_id::text AS id
       FROM enrollment_events ee
       JOIN courses c ON ee.course_id = c.courses_id
       WHERE ee.rn = 1)
      
      UNION ALL

      (SELECT 
        'module' AS type,
        m.title AS title,
        mp.completed_at AS date,
        NULL::float AS score,
        mp.module_id::text AS id
       FROM module_progress mp
       JOIN modules m ON mp.module_id = m.module_id
       WHERE mp.student_id = $1 AND mp.completed_at IS NOT NULL)

      UNION ALL

      (SELECT 
        'quiz' AS type,
        e.title AS title,
        er.evaluated_at AS date,
        er.percentage AS score,
        er.exam_id::text AS id
       FROM exam_results er
       JOIN exams e ON er.exam_id = e.exam_id
       WHERE er.student_id = $1)

      ORDER BY date DESC
      LIMIT 10
      `,
      [studentId]
    );

    // 4️⃣ Fetch Deadlines (Course Expiry)
    const deadlinesResult = await pool.query(
      `
      SELECT 
        c.courses_id AS id,
        c.title,
        c.expires_at AS "dueDate",
        c.title AS course,
        (c.expires_at < NOW() + INTERVAL '3 days') AS "isUrgent"
      FROM (
          SELECT student_id, course_id FROM student_courses
          UNION
          SELECT student_id, course_id FROM course_assignments
      ) sc
      JOIN courses c ON sc.course_id = c.courses_id
      WHERE sc.student_id = $1 AND c.expires_at IS NOT NULL AND c.expires_at > NOW()
      ORDER BY c.expires_at ASC
      LIMIT 5
      `,
      [studentId]
    );

    // 5️⃣ Fetch Recent Videos
    const recentVideosResult = await pool.query(
      `
      SELECT
        mp.module_id AS id,
        m.title,
        c.courses_id AS course_id,
        c.title AS course_title,
        COALESCE(mp.last_position_seconds, 0) AS last_position_seconds,
        mp.last_accessed_at AS viewed_at,
        COALESCE(m.duration_mins, 0) AS duration_mins,
        CASE
          WHEN COALESCE(m.duration_mins, 0) > 0 THEN LEAST(
            100,
            ROUND((COALESCE(mp.last_position_seconds, 0) / (m.duration_mins * 60.0)) * 100)
          )
          ELSE 0
        END AS progress_percent
      FROM module_progress mp
      JOIN modules m ON m.module_id = mp.module_id
      JOIN courses c ON c.courses_id = mp.course_id
      WHERE mp.student_id = $1
        AND m.type = 'video'
        AND mp.last_accessed_at IS NOT NULL
      ORDER BY mp.last_accessed_at DESC
      LIMIT 6
      `,
      [studentId]
    );

    const dedupedRecentActivity = Array.from(
      new Map(
        activityResult.rows
          .map((a) => ({
            ...a,
            id: `${a.type}-${a.id}`,
            score: a.score === null || a.score === undefined ? null : Number(a.score),
          }))
          .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
          .map((a) => [a.id, a])
      ).values()
    ).slice(0, 10);

    return res.json({
      ...statsResult.rows[0],
      assignments_count: 0,
      recent_activity: dedupedRecentActivity,
      deadlines: deadlinesResult.rows,
      recent_videos: recentVideosResult.rows
    });
  } catch (err) {
    console.error("Student dashboard error:", err);
    return res.status(500).json({
      message: "Failed to load student dashboard",
    });
  }
};

export const searchCourses = async (req, res) => {
  try {
    const { query } = req.query;

    if (!query || !query.trim()) {
      return res.json([]);
    }

    const searchTerm = `%${query.trim()}%`;

    // Search courses and modules with course details
    const result = await pool.query(
      `SELECT * FROM (
        -- Search Courses
        SELECT 
          c.courses_id AS id,
          c.courses_id AS course_id,
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
          u.full_name AS instructor_name,
          'course' AS type,
          NULL AS course_title
        FROM courses c
        LEFT JOIN users u ON c.instructor_id = u.user_id
        WHERE c.status = 'approved'
          AND (LOWER(c.title) LIKE LOWER($1)
            OR LOWER(COALESCE(c.description, '')) LIKE LOWER($1)
            OR LOWER(COALESCE(c.category, '')) LIKE LOWER($1))
        
        UNION ALL
        
        -- Search Modules in approved courses
        SELECT 
          m.module_id AS id,
          c.courses_id AS course_id,
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
          u.full_name AS instructor_name,
          'module' AS type,
          c.title AS course_title
        FROM modules m
        JOIN courses c ON m.course_id = c.courses_id
        LEFT JOIN users u ON c.instructor_id = u.user_id
        WHERE c.status = 'approved'
          AND (LOWER(m.title) LIKE LOWER($1)
            OR LOWER(COALESCE(m.notes, '')) LIKE LOWER($1))
      ) AS combined_results
      ORDER BY created_at DESC
      LIMIT 20`,
      [searchTerm]
    );

    res.json(result.rows);

  } catch (error) {
    console.error('Student search error:', error);
    res.status(500).json({
      error: 'Failed to search courses and modules',
      message: error.message
    });
  }
};