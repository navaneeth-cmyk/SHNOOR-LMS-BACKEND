import pool from "../db/postgres.js";

// ─── CREATE a new Learning Path ───────────────────────────────────────────────
export const createLearningPath = async (req, res) => {
    const instructorId = req.user.id;
    const { name, description } = req.body;
    const normalizedName = String(name || "").trim();

    if (!normalizedName) return res.status(400).json({ message: "Name is required" });

    try {
        const duplicateCheck = await pool.query(
            `SELECT id
       FROM learning_paths
       WHERE lower(trim(name)) = lower(trim($1))
       LIMIT 1`,
            [normalizedName]
        );

        if (duplicateCheck.rows.length > 0) {
            return res.status(409).json({ message: "Learning path already existed" });
        }

        const result = await pool.query(
            `INSERT INTO learning_paths (name, description, instructor_id)
       VALUES ($1, $2, $3) RETURNING *`,
            [normalizedName, description || null, instructorId]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error("createLearningPath error:", err);
        if (err.code === "23505") {
            return res.status(409).json({ message: "Learning path already existed" });
        }
        res.status(500).json({ message: "Server error" });
    }
};

// ─── GET all Learning Paths for the logged-in instructor ──────────────────────
export const getMyLearningPaths = async (req, res) => {
    const instructorId = req.user.id;
    try {
        const result = await pool.query(
            `SELECT lp.id, lp.name, lp.description, lp.created_at,
              COUNT(lpc.id)::int AS course_count
       FROM learning_paths lp
       LEFT JOIN learning_path_courses lpc ON lpc.learning_path_id = lp.id
       WHERE lp.instructor_id = $1
       GROUP BY lp.id, lp.name, lp.description, lp.created_at
       ORDER BY lp.created_at DESC`,
            [instructorId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("getMyLearningPaths error:", err);
        res.status(500).json({ message: "Server error" });
    }
};

// ─── ADD a course to a Learning Path ─────────────────────────────────────────
export const addCourseToLearningPath = async (req, res) => {
    const { learningPathId, courseId, orderIndex } = req.body;

    if (!learningPathId || !courseId) {
        return res.status(400).json({ message: "learningPathId and courseId are required" });
    }

    try {
        await pool.query(
            `INSERT INTO learning_path_courses (learning_path_id, course_id, order_index)
       VALUES ($1, $2, $3)
       ON CONFLICT (learning_path_id, course_id)
       DO UPDATE SET order_index = $3`,
            [learningPathId, courseId, orderIndex || 1]
        );
        res.json({ success: true, message: "Course added to learning path" });
    } catch (err) {
        console.error("addCourseToLearningPath error:", err);
        res.status(500).json({ message: "Server error" });
    }
};

// ─── REMOVE a course from a Learning Path ────────────────────────────────────
export const removeCourseFromLearningPath = async (req, res) => {
    const { learningPathId, courseId } = req.params;
    try {
        await pool.query(
            `DELETE FROM learning_path_courses
       WHERE learning_path_id = $1 AND course_id = $2`,
            [learningPathId, courseId]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("removeCourseFromLearningPath error:", err);
        res.status(500).json({ message: "Server error" });
    }
};

// ─── GET courses inside a Learning Path (ordered) ────────────────────────────
export const getLearningPathCourses = async (req, res) => {
    const { learningPathId } = req.params;
    try {
        const result = await pool.query(
            `SELECT
         c.courses_id,
         c.title,
         c.description,
         c.category,
         c.difficulty,
         c.price_type,
         c.price_amount,
         c.thumbnail_url,
         c.instructor_id,
         u.full_name AS instructor_name,
         lpc.order_index
       FROM learning_path_courses lpc
       JOIN courses c ON c.courses_id = lpc.course_id
       LEFT JOIN users u ON u.user_id = c.instructor_id
       WHERE lpc.learning_path_id = $1
       ORDER BY lpc.order_index ASC`,
            [learningPathId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("getLearningPathCourses error:", err);
        res.status(500).json({ message: "Server error" });
    }
};

// ─── STUDENT: Search learning paths by name + return their ordered courses ────
export const searchLearningPaths = async (req, res) => {
    const studentId = req.user.id;
    const { q } = req.query; // search query

    if (!q) return res.json([]);

    try {
        // Find matching learning paths
        const lpResult = await pool.query(
            `SELECT id, name, description FROM learning_paths
       WHERE LOWER(name) LIKE $1`,
            [`%${q.toLowerCase()}%`]
        );

        if (lpResult.rows.length === 0) return res.json([]);

        // For each learning path, get its ordered courses
        const paths = await Promise.all(
            lpResult.rows.map(async (lp) => {
                const coursesResult = await pool.query(
                    `SELECT
             c.courses_id,
             c.title,
             c.description,
             c.category,
             c.difficulty,
             c.price_type,
             c.price_amount,
             c.thumbnail_url,
             c.instructor_id,
             u.full_name AS instructor_name,
             lpc.order_index,
             (
               EXISTS(SELECT 1 FROM student_courses sc WHERE sc.course_id = c.courses_id AND sc.student_id = $2)
               OR EXISTS(SELECT 1 FROM course_assignments ca WHERE ca.course_id = c.courses_id AND ca.student_id = $2)
             ) AS is_enrolled,
             CASE
               WHEN (SELECT COUNT(*) FROM modules m WHERE m.course_id = c.courses_id) > 0
                 AND (SELECT COUNT(*) FROM modules m WHERE m.course_id = c.courses_id)
                     = (SELECT COUNT(*) FROM module_progress mp
                        WHERE mp.course_id = c.courses_id AND mp.student_id = $2)
               THEN true ELSE false END AS is_completed
           FROM learning_path_courses lpc
           JOIN courses c ON c.courses_id = lpc.course_id
           LEFT JOIN users u ON u.user_id = c.instructor_id
           WHERE lpc.learning_path_id = $1
             AND c.status = 'approved'
           ORDER BY lpc.order_index ASC`,
                    [lp.id, studentId]
                );
                return { ...lp, courses: coursesResult.rows };
            })
        );

        res.json(paths);
    } catch (err) {
        console.error("searchLearningPaths error:", err);
        res.status(500).json({ message: "Server error" });
    }
};

// ─── GET all approved learning paths (for student browsing) ──────────────────
export const getAllLearningPaths = async (req, res) => {
    const studentId = req.user.id;
    try {
        const lpResult = await pool.query(
            `SELECT id, name, description FROM learning_paths ORDER BY created_at DESC`
        );

        const paths = await Promise.all(
            lpResult.rows.map(async (lp) => {
                const coursesResult = await pool.query(
                    `SELECT
             c.courses_id,
             c.title,
             c.description,
             c.category,
             c.difficulty,
             c.price_type,
             c.price_amount,
             c.thumbnail_url,
             c.instructor_id,
             u.full_name AS instructor_name,
             lpc.order_index,
             (
               EXISTS(SELECT 1 FROM student_courses sc WHERE sc.course_id = c.courses_id AND sc.student_id = $2)
               OR EXISTS(SELECT 1 FROM course_assignments ca WHERE ca.course_id = c.courses_id AND ca.student_id = $2)
             ) AS is_enrolled,
             CASE
               WHEN (SELECT COUNT(*) FROM modules m WHERE m.course_id = c.courses_id) > 0
                 AND (SELECT COUNT(*) FROM modules m WHERE m.course_id = c.courses_id)
                     = (SELECT COUNT(*) FROM module_progress mp
                        WHERE mp.course_id = c.courses_id AND mp.student_id = $2)
               THEN true ELSE false END AS is_completed
           FROM learning_path_courses lpc
           JOIN courses c ON c.courses_id = lpc.course_id
           LEFT JOIN users u ON u.user_id = c.instructor_id
           WHERE lpc.learning_path_id = $1
             AND c.status = 'approved'
           ORDER BY lpc.order_index ASC`,
                    [lp.id, studentId]
                );
                return { ...lp, courses: coursesResult.rows };
            })
        );

        res.json(paths.filter(p => p.courses.length > 0));
    } catch (err) {
        console.error("getAllLearningPaths error:", err);
        res.status(500).json({ message: "Server error" });
    }
};