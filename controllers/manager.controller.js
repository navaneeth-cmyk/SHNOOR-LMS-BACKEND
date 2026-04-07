import pool from "../db/postgres.js";

const getManagerCollege = async (managerId) => {
  const managerResult = await pool.query(
    `SELECT college
     FROM users
     WHERE user_id = $1 AND role = 'manager'
     LIMIT 1`,
    [managerId],
  );

  if (managerResult.rows.length === 0) {
    return null;
  }

  return (managerResult.rows[0].college || "").trim();
};

export const getManagerCollegeStudents = async (req, res) => {
  try {
    const managerCollege = await getManagerCollege(req.user.id);

    if (managerCollege === null) {
      return res.status(404).json({ message: "Manager profile not found" });
    }

    if (!managerCollege) {
      return res.status(200).json([]);
    }

    const studentsResult = await pool.query(
      `SELECT
         user_id,
         full_name,
         email,
         COALESCE(xp, 0) AS xp,
         COALESCE(streak, 0) AS streak,
         created_at,
         last_login
       FROM users
       WHERE role = 'student'
         AND status = 'active'
         AND REGEXP_REPLACE(UPPER(TRIM(COALESCE(college, ''))), '[,.\\-_() ]+', ' ', 'g') =
             REGEXP_REPLACE(UPPER(TRIM($1)), '[,.\\-_() ]+', ' ', 'g')
       ORDER BY created_at DESC`,
      [managerCollege],
    );

    return res.status(200).json(studentsResult.rows);
  } catch (error) {
    console.error("getManagerCollegeStudents error:", error);
    return res.status(500).json({ message: "Failed to fetch students" });
  }
};

export const getManagerCourseProgress = async (req, res) => {
  try {
    const managerCollege = await getManagerCollege(req.user.id);

    if (managerCollege === null) {
      return res.status(404).json({ message: "Manager profile not found" });
    }

    if (!managerCollege) {
      return res.status(200).json([]);
    }

    const result = await pool.query(
      `WITH manager_students AS (
         SELECT u.user_id, u.full_name, u.email
         FROM users u
         WHERE u.role = 'student'
           AND u.status = 'active'
           AND REGEXP_REPLACE(UPPER(TRIM(COALESCE(u.college, ''))), '[,.\\-_() ]+', ' ', 'g') =
               REGEXP_REPLACE(UPPER(TRIM($1)), '[,.\\-_() ]+', ' ', 'g')
       ), student_enrollments AS (
         SELECT student_id, course_id FROM student_courses
         UNION
         SELECT student_id, course_id FROM course_assignments
       ), course_totals AS (
         SELECT m.course_id, COUNT(*)::int AS total_modules
         FROM modules m
         GROUP BY m.course_id
       ), completed_modules AS (
         SELECT mp.student_id, mp.course_id, COUNT(*)::int AS completed_modules
         FROM module_progress mp
         WHERE mp.completed_at IS NOT NULL
         GROUP BY mp.student_id, mp.course_id
       )
       SELECT
         ms.user_id AS student_id,
         ms.full_name AS student_name,
         ms.email AS student_email,
         c.courses_id AS course_id,
         c.title AS course_name,
         COALESCE(ct.total_modules, 0) AS total_modules,
         COALESCE(cm.completed_modules, 0) AS completed_modules,
         CASE
           WHEN COALESCE(ct.total_modules, 0) = 0 THEN 0
           ELSE ROUND((COALESCE(cm.completed_modules, 0)::numeric / ct.total_modules::numeric) * 100, 1)
         END AS progress_percent
       FROM manager_students ms
       JOIN student_enrollments se ON se.student_id = ms.user_id
       JOIN courses c ON c.courses_id = se.course_id
       LEFT JOIN course_totals ct ON ct.course_id = c.courses_id
       LEFT JOIN completed_modules cm ON cm.student_id = ms.user_id AND cm.course_id = c.courses_id
       ORDER BY ms.full_name ASC, c.title ASC`,
      [managerCollege],
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getManagerCourseProgress error:", error);
    return res.status(500).json({ message: "Failed to fetch manager course progress" });
  }
};

export const getManagerExamProgress = async (req, res) => {
  try {
    const managerCollege = await getManagerCollege(req.user.id);

    if (managerCollege === null) {
      return res.status(404).json({ message: "Manager profile not found" });
    }

    if (!managerCollege) {
      return res.status(200).json([]);
    }

    try {
      const result = await pool.query(
        `WITH manager_students AS (
           SELECT u.user_id, u.full_name, u.email
           FROM users u
           WHERE u.role = 'student'
             AND u.status = 'active'
             AND REGEXP_REPLACE(UPPER(TRIM(COALESCE(u.college, ''))), '[,.\\-_() ]+', ' ', 'g') =
                 REGEXP_REPLACE(UPPER(TRIM($1)), '[,.\\-_() ]+', ' ', 'g')
         )
         SELECT
           ms.user_id AS student_id,
           ms.full_name AS student_name,
           ms.email AS student_email,
           ea.exam_id,
           COALESCE(e.title, ea.exam_id::text, '-') AS exam_name,
           er.percentage AS score,
           COALESCE(
             CASE
               WHEN er.passed IS TRUE THEN 'Pass'
               WHEN er.passed IS FALSE THEN 'Fail'
               ELSE NULL
             END,
             ea.status,
             'Not Attempted'
           ) AS status,
           COALESCE(vd.violations_count, 0) AS violations,
           COALESCE(vd.violation_details, '[]'::json) AS violation_details,
           COALESCE(er.evaluated_at, ea.submitted_at, ea.start_time) AS updated_at
         FROM manager_students ms
         LEFT JOIN exam_attempts ea ON ea.student_id = ms.user_id
         LEFT JOIN exams e ON e.exam_id::text = ea.exam_id::text
         LEFT JOIN exam_results er ON er.student_id = ms.user_id AND er.exam_id::text = ea.exam_id::text
         LEFT JOIN LATERAL (
           SELECT
             COUNT(*)::int AS violations_count,
             COALESCE(
               json_agg(
                 json_build_object(
                   'violation_type', v.violation_type,
                   'created_at', v.created_at
                 )
                 ORDER BY v.created_at DESC
               ),
               '[]'::json
             ) AS violation_details
           FROM exam_violations v
           WHERE v.student_id = ms.user_id
             AND ea.exam_id IS NOT NULL
             AND v.exam_id::text = ea.exam_id::text
         ) vd ON TRUE
         ORDER BY ms.full_name ASC, updated_at DESC NULLS LAST`,
        [managerCollege],
      );

      return res.status(200).json(result.rows);
    } catch (error) {
      if (error?.code !== "42P01") {
        throw error;
      }

      const fallbackResult = await pool.query(
        `WITH manager_students AS (
           SELECT u.user_id, u.full_name, u.email
           FROM users u
           WHERE u.role = 'student'
             AND u.status = 'active'
             AND REGEXP_REPLACE(UPPER(TRIM(COALESCE(u.college, ''))), '[,.\\-_() ]+', ' ', 'g') =
                 REGEXP_REPLACE(UPPER(TRIM($1)), '[,.\\-_() ]+', ' ', 'g')
         )
         SELECT
           ms.user_id AS student_id,
           ms.full_name AS student_name,
           ms.email AS student_email,
           ea.exam_id,
           COALESCE(e.title, ea.exam_id::text, '-') AS exam_name,
           er.percentage AS score,
           COALESCE(
             CASE
               WHEN er.passed IS TRUE THEN 'Pass'
               WHEN er.passed IS FALSE THEN 'Fail'
               ELSE NULL
             END,
             ea.status,
             'Not Attempted'
           ) AS status,
           0::int AS violations,
           '[]'::json AS violation_details,
           COALESCE(er.evaluated_at, ea.submitted_at, ea.start_time) AS updated_at
         FROM manager_students ms
         LEFT JOIN exam_attempts ea ON ea.student_id = ms.user_id
         LEFT JOIN exams e ON e.exam_id::text = ea.exam_id::text
         LEFT JOIN exam_results er ON er.student_id = ms.user_id AND er.exam_id::text = ea.exam_id::text
         ORDER BY ms.full_name ASC, updated_at DESC NULLS LAST`,
        [managerCollege],
      );

      return res.status(200).json(fallbackResult.rows);
    }
  } catch (error) {
    console.error("getManagerExamProgress error:", error);
    return res.status(500).json({ message: "Failed to fetch manager exam progress" });
  }
};

export const getManagerCertificates = async (req, res) => {
  try {
    const managerCollege = await getManagerCollege(req.user.id);

    if (managerCollege === null) {
      return res.status(404).json({ message: "Manager profile not found" });
    }

    if (!managerCollege) {
      return res.status(200).json([]);
    }

    const result = await pool.query(
      `WITH manager_students AS (
         SELECT u.user_id, u.full_name, u.email
         FROM users u
         WHERE u.role = 'student'
           AND u.status = 'active'
           AND REGEXP_REPLACE(UPPER(TRIM(COALESCE(u.college, ''))), '[,.\\-_() ]+', ' ', 'g') =
               REGEXP_REPLACE(UPPER(TRIM($1)), '[,.\\-_() ]+', ' ', 'g')
       )
       SELECT
         ms.user_id AS student_id,
         ms.full_name AS student_name,
         ms.email AS student_email,
         c.certificate_id,
         COALESCE(course.title, c.exam_name, '-') AS course_name,
         c.issued_at
       FROM manager_students ms
       LEFT JOIN certificates c ON c.user_id = ms.user_id
       LEFT JOIN exams e ON e.exam_id::text = c.exam_id::text
       LEFT JOIN courses course ON course.courses_id = e.course_id
       ORDER BY ms.full_name ASC, c.issued_at DESC NULLS LAST`,
      [managerCollege],
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getManagerCertificates error:", error);
    return res.status(500).json({ message: "Failed to fetch manager certificates" });
  }
};
