import pool from "../db/postgres.js";
import { emitNotificationToUser } from "../services/socket.js";


export const assignCourseToStudent = async (req, res) => {
  const { course_id, student_id } = req.body;

  try {
    // 1️⃣ Ensure course exists and is approved
    const courseResult = await pool.query(
      `SELECT course_id
       FROM courses
       WHERE course_id = $1 AND status = 'approved'`,
      [course_id]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({
        message: "Course not found or not approved",
      });
    }

    // 2️⃣ Ensure user exists and is a student
    const studentResult = await pool.query(
      `SELECT user_id
       FROM users
       WHERE user_id = $1 AND role = 'student' AND status = 'active'`,
      [student_id]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).json({
        message: "Student not found or inactive",
      });
    }

    const existingAssignment = await pool.query(
      `SELECT assignment_id
       FROM course_assignments
       WHERE course_id = $1 AND student_id = $2`,
      [course_id, student_id]
    );

    if (existingAssignment.rows.length > 0) {
      return res.status(409).json({
        message: "Course already assigned to this student",
      });
    }

    // 4️⃣ Assign course
    await pool.query(
      `INSERT INTO course_assignments (course_id, student_id)
       VALUES ($1, $2)`,
      [course_id, student_id]
    );
        // Notify Student
    const courseTitle = courseResult.rows[0]?.title || "a new course";
    await pool.query(
      `INSERT INTO notifications (user_id, message, link) VALUES ($1, $2, $3)`,
      [
        student_id,
        `New course assigned: ${courseTitle}. Enroll now.`,
        `/student/course/${course_id}`,
      ]
    );

    // [NEW] Trigger Real-time + Web Push
    try {
      // Need to fetch the notification ID just created to be precise, or just send payload
      // Ideally we should RETURNING * from the INSERT above.
      // For now, let's construct a payload. The ID might be missing but message/link are key.
      emitNotificationToUser(student_id, {
        id: Date.now(), // Temporary ID if we don't fetch it
        message: `New course assigned: ${courseTitle}`,
        link: `/student/course/${course_id}`,
        type: "COURSE_ASSIGNED",
        is_read: false,
        created_at: new Date().toISOString()
      });
    } catch (socketErr) {
      console.error("Socket emit failed:", socketErr);
    }

    res.status(201).json({
      message: "Course assigned to student successfully",
    });
  } catch (error) {
    console.error("assignCourseToStudent error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const assignCourseToGroup = async (req, res) => {
  const { course_id, group_id } = req.body;

  try {
    // 1️⃣ Ensure course exists and is approved
    const courseResult = await pool.query(
      `SELECT course_id, title
       FROM courses
       WHERE course_id = $1 AND status = 'approved'`,
      [course_id]
    );

    if (courseResult.rows.length === 0) {
      return res.status(404).json({
        message: "Course not found or not approved",
      });
    }

    const courseTitle = courseResult.rows[0].title;

    // 2️⃣ Ensure group exists
    const groupResult = await pool.query(
      `SELECT group_id, group_name
       FROM groups
       WHERE group_id = $1`,
      [group_id]
    );

    if (groupResult.rows.length === 0) {
      return res.status(404).json({
        message: "Group not found",
      });
    }

    const groupName = groupResult.rows[0].group_name;

    // 3️⃣ Get all students in the group
    const studentsResult = await pool.query(
      `SELECT DISTINCT gu.user_id
       FROM group_users gu
       JOIN users u ON gu.user_id = u.user_id
       WHERE gu.group_id = $1 AND u.role = 'student' AND u.status = 'active'`,
      [group_id]
    );

    if (studentsResult.rows.length === 0) {
      return res.status(400).json({
        message: "Group has no active students",
      });
    }

    const studentIds = studentsResult.rows.map(row => row.user_id);

    // 4️⃣ Assign course to all students in the group
    let assignedCount = 0;
    for (const student_id of studentIds) {
      try {
        // Check if already assigned
        const existingAssignment = await pool.query(
          `SELECT assignment_id
           FROM course_assignments
           WHERE course_id = $1 AND student_id = $2`,
          [course_id, student_id]
        );

        if (existingAssignment.rows.length === 0) {
          // Insert new assignment
          await pool.query(
            `INSERT INTO course_assignments (course_id, student_id)
             VALUES ($1, $2)`,
            [course_id, student_id]
          );

          assignedCount++;

          // Create notification for this student
          await pool.query(
            `INSERT INTO notifications (user_id, message, link) VALUES ($1, $2, $3)`,
            [
              student_id,
              `New course assigned: ${courseTitle} (via group: ${groupName})`,
              `/student/course/${course_id}`,
            ]
          );

          // Trigger Real-time + Web Push notification
          try {
            emitNotificationToUser(student_id, {
              id: Date.now(),
              message: `New course assigned: ${courseTitle} (via group: ${groupName})`,
              link: `/student/course/${course_id}`,
              type: "COURSE_ASSIGNED",
              is_read: false,
              created_at: new Date().toISOString()
            });
          } catch (socketErr) {
            console.error("Socket emit failed for student", student_id, ":", socketErr);
          }
        }
      } catch (studentError) {
        console.error(`Failed to assign course to student ${student_id}:`, studentError);
        // Continue with next student instead of failing entire operation
      }
    }

    res.status(201).json({
      message: `Course assigned to ${assignedCount} students in group "${groupName}"`,
      assigned_count: assignedCount,
      total_students: studentIds.length,
    });
  } catch (error) {
    console.error("assignCourseToGroup error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const getMyCourses = async (req, res) => {
  try {
    const studentId = req.user.id;

    const result = await pool.query(
      `
      SELECT
        c.courses_id,
        c.title,
        c.description,
        c.category,
        c.thumbnail_url,
        c.created_at,

        MAX(ca.assigned_at) AS assigned_at,
        COUNT(DISTINCT m.module_id) AS total_modules,
        COUNT(DISTINCT mp.module_id) AS completed_modules

      FROM course_assignments ca
      JOIN courses c
        ON ca.course_id = c.courses_id

      LEFT JOIN modules m
        ON m.course_id = c.courses_id

      LEFT JOIN module_progress mp
        ON mp.course_id = c.courses_id
       AND mp.student_id = ca.student_id
       AND mp.module_id = m.module_id

      WHERE ca.student_id = $1
        AND c.status = 'approved'

      GROUP BY c.courses_id
      ORDER BY assigned_at DESC
      `,
      [studentId]
    );

    const courses = result.rows.map(course => ({
      ...course,
      total_modules: Number(course.total_modules),
      completed_modules: Number(course.completed_modules),
      isCompleted:
        Number(course.total_modules) > 0 &&
        Number(course.total_modules) === Number(course.completed_modules),
    }));

    res.status(200).json(courses);
  } catch (error) {
    console.error("getMyCourses error:", error);
    res.status(500).json({ message: "Server error" });
  }
};


export const unassignCourse = async (req, res) => {
  const { course_id, student_id } = req.body;

  try {
    const result = await pool.query(
      `DELETE FROM course_assignments
       WHERE course_id = $1 AND student_id = $2`,
      [course_id, student_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        message: "Assignment not found",
      });
    }

    res.status(200).json({
      message: "Course unassigned successfully",
    });
  } catch (error) {
    console.error("unassignCourse error:", error);
    res.status(500).json({ message: "Server error" });
  }
};


export const getPublishedCourses = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        courses_id,
        title,
        category,
        difficulty
        FROM courses
      WHERE status = 'approved'
      ORDER BY created_at DESC
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error("getPublishedCourses error:", err);
    res.status(500).json({ message: "Server error" });
  }
};


export const enrollCourse = async (req, res) => {
  try {
    const studentId = req.user.id;
    const { courseId } = req.body;

    await pool.query(
      `
      INSERT INTO course_assignments (course_id, student_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      `,
      [courseId, studentId]
    );

    res.status(201).json({ message: "Enrolled successfully" });
  } catch (err) {
    console.error("enrollCourse error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const getInstructorStudentCount = async (req, res) => {
  try {
    const instructorId = req.user.id;
    let { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      const { rows } = await pool.query(
        `
        SELECT COUNT(DISTINCT student_id) AS total_students
        FROM (
          SELECT student_id, course_id FROM course_assignments
          UNION
          SELECT student_id, course_id FROM student_courses
        ) combined
        JOIN courses c ON combined.course_id = c.courses_id
        WHERE c.instructor_id = $1
        `,
        [instructorId]
      );

      return res.json({
        total_students: rows[0].total_students || 0,
        studentsChange: 0
      });
    }

    // Previous period
    const start = new Date(startDate);
    const end = new Date(endDate);
    const durationMs = end - start;
    const prevEnd = new Date(start.getTime() - 86400000);
    const prevStart = new Date(prevEnd.getTime() - durationMs);

    const prevStartDate = prevStart.toISOString().slice(0, 10);
    const prevEndDate = prevEnd.toISOString().slice(0, 10);

    // Current period students
    const currentResult = await pool.query(
      `
      SELECT COUNT(DISTINCT student_id) AS total_students
      FROM course_assignments ca
      JOIN courses c ON ca.course_id = c.courses_id
      WHERE c.instructor_id = $1 AND ca.assigned_at::date BETWEEN $2 AND $3
      `,
      [instructorId, startDate, endDate]
    );

    // Previous period students
    const prevResult = await pool.query(
      `
      SELECT COUNT(DISTINCT student_id) AS total_students
      FROM course_assignments ca
      JOIN courses c ON ca.course_id = c.courses_id
      WHERE c.instructor_id = $1 AND ca.assigned_at::date BETWEEN $2 AND $3
      `,
      [instructorId, prevStartDate, prevEndDate]
    );

    const currentStudents = Number(currentResult.rows[0].total_students) || 0;
    const prevStudents = Number(prevResult.rows[0].total_students) || 0;
    const studentsChange = prevStudents > 0 ? ((currentStudents - prevStudents) / prevStudents * 100).toFixed(2) : 0;

    res.json({
      total_students: currentStudents,
      studentsChange
    });
  } catch (err) {
    console.error("Instructor student count error:", err);
    res.status(500).json({ message: "Failed to fetch student count" });
  }
};;

export const getInstructorEnrolledStudents = async (req, res) => {
  try {
    const instructorId = req.user.id;

    const { rows } = await pool.query(
      `
      WITH enrollments AS (
        SELECT student_id, course_id FROM course_assignments
        UNION
        SELECT student_id, course_id FROM student_courses
      )
      SELECT
        u.user_id AS student_id,
        u.full_name AS student_name,
        c.courses_id AS course_id,
        c.title AS course_title,
        COUNT(DISTINCT m.module_id) AS total_modules,
        COUNT(DISTINCT CASE WHEN mp.completed_at IS NOT NULL THEN mp.module_id END) AS completed_modules,
        COALESCE(
          ROUND(
            (
              COUNT(DISTINCT CASE WHEN mp.completed_at IS NOT NULL THEN mp.module_id END)::numeric
              / NULLIF(COUNT(DISTINCT m.module_id), 0)::numeric
            ) * 100,
            0
          ),
          0
        ) AS progress,
        COALESCE(ROUND(AVG(er.percentage)::numeric, 1), 0) AS avg_score,
        COUNT(DISTINCT ea.exam_id) AS submitted_exam_count
      FROM enrollments e
      JOIN users u ON e.student_id = u.user_id
      JOIN courses c ON e.course_id = c.courses_id
      LEFT JOIN modules m ON m.course_id = c.courses_id
      LEFT JOIN module_progress mp
        ON mp.course_id = c.courses_id
       AND mp.student_id = u.user_id
       AND mp.module_id = m.module_id
      LEFT JOIN exams ex ON ex.course_id = c.courses_id
      LEFT JOIN exam_results er
        ON er.exam_id = ex.exam_id
       AND er.student_id = u.user_id
      LEFT JOIN exam_attempts ea
        ON ea.exam_id = ex.exam_id
       AND ea.student_id = u.user_id
       AND ea.status = 'submitted'
      WHERE c.instructor_id = $1
      GROUP BY u.user_id, u.full_name, c.courses_id, c.title
      ORDER BY u.full_name ASC, c.title ASC
      `,
      [instructorId]
    );

    const normalized = rows.map((row) => {
      const progress = Number(row.progress || 0);
      const avgScore = Number(row.avg_score || 0);
      const submittedExamCount = Number(row.submitted_exam_count || 0);
      const totalModules = Number(row.total_modules || 0);
      const completedModules = Number(row.completed_modules || 0);
      const isCourseCompleted = totalModules > 0 && completedModules >= totalModules;
      let status = "Not Started";
      if (isCourseCompleted || progress >= 100 || submittedExamCount > 0) status = "Completed";
      else if (progress > 0) status = "In Progress";

      return {
        ...row,
        progress,
        avg_score: avgScore,
        submitted_exam_count: submittedExamCount,
        total_modules: totalModules,
        completed_modules: completedModules,
        status,
      };
    });

    res.json(normalized);
  } catch (err) {
    console.error("Fetch instructor students error:", err);
    res.status(500).json({ message: "Failed to fetch enrolled students" });
  }
};