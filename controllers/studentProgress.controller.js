import pool from "../db/postgres.js";

const verifyCourseAccess = async (studentId, courseId) => {
  const access = await pool.query(
    `
    SELECT
      EXISTS (
        SELECT 1
        FROM student_courses sc
        WHERE sc.student_id = $1 AND sc.course_id = $2
      ) AS is_enrolled,
      EXISTS (
        SELECT 1
        FROM course_assignments ca
        WHERE ca.student_id = $1 AND ca.course_id = $2
      ) AS is_assigned
    `,
    [studentId, courseId]
  );

  const row = access.rows[0] || {};
  const isEnrolled = Boolean(row.is_enrolled);
  const isAssigned = Boolean(row.is_assigned);

  return {
    hasAccess: isEnrolled || isAssigned,
    isEnrolled,
    isAssigned,
  };
};

const verifyModuleInCourse = async (moduleId, courseId) => {
  const moduleCheck = await pool.query(
    `SELECT 1 FROM modules WHERE module_id = $1 AND course_id = $2`,
    [moduleId, courseId]
  );

  return moduleCheck.rowCount > 0;
};

export const markModuleCompleted = async (req, res) => {
  try {
    const studentId = req.user.id;
    const { courseId } = req.params;
    const { moduleId } = req.body;

    if (!moduleId) {
      return res.status(400).json({ message: "moduleId is required" });
    }

    const access = await verifyCourseAccess(studentId, courseId);
    if (!access.hasAccess) {
      return res.status(403).json({ message: "Course is not assigned/enrolled for this student" });
    }

    // If student is assigned but not yet in student_courses, materialize enrollment on first progress action.
    if (!access.isEnrolled) {
      await pool.query(
        `
        INSERT INTO student_courses (student_id, course_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        `,
        [studentId, courseId]
      );
    }

    const validModule = await verifyModuleInCourse(moduleId, courseId);
    if (!validModule) {
      return res.status(400).json({ message: "Invalid module for this course" });
    }

    const existingProgressRes = await pool.query(
      `
      SELECT completed_at
      FROM module_progress
      WHERE student_id = $1 AND module_id = $2
      `,
      [studentId, moduleId]
    );
    const wasAlreadyCompleted = Boolean(existingProgressRes.rows[0]?.completed_at);

    await pool.query(
      `
      INSERT INTO module_progress (student_id, course_id, module_id, completed_at, last_accessed_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (student_id,course_id, module_id)
      DO UPDATE SET completed_at = NOW(), last_accessed_at = NOW()
      `,
      [studentId, courseId, moduleId]
    );

    let totalXpEarned = 0;
    if (!wasAlreadyCompleted) {
      totalXpEarned += 20;
      await pool.query(
        `
        UPDATE users
        SET xp = COALESCE(xp, 0) + 20
        WHERE user_id = $1
        `,
        [studentId]
      );
    }

    const totalModulesRes = await pool.query(
      `SELECT COUNT(*) FROM modules WHERE course_id = $1`,
      [courseId]
    );
    const completedModulesRes = await pool.query(
      `
      SELECT COUNT(*)
      FROM module_progress
      WHERE course_id = $1
        AND student_id = $2
        AND completed_at IS NOT NULL
      `,
      [courseId, studentId]
    );

    const totalModules = Number(totalModulesRes.rows[0].count);
    const completedModules = Number(completedModulesRes.rows[0].count);

    let bonusXP = 0;
    let finalMessage = wasAlreadyCompleted
      ? "Module already completed."
      : "Module marked as completed and 20 XP awarded!";

    if (!wasAlreadyCompleted && totalModules > 0 && totalModules === completedModules) {
      bonusXP = 200;
      await pool.query(
        `UPDATE users SET xp = COALESCE(xp, 0) + $1 WHERE user_id = $2`,
        [bonusXP, studentId]
      );
      finalMessage = `Congratulations! You completed the course and earned a ${bonusXP} XP bonus!`;
    }
    totalXpEarned += bonusXP;

    if (global.io) {
      global.io.to(`user_${studentId}`).emit("dashboard_update", {
        type: bonusXP > 0 ? "course_completed" : "module_completed",
        moduleId,
        courseId,
        xpEarned: totalXpEarned
      });
    }

    res.json({
      message: finalMessage,
      xpEarned: totalXpEarned,
      completed: true,
      alreadyCompleted: wasAlreadyCompleted
    });
  } catch (error) {
    console.error("markModuleCompleted error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

export const updateModuleProgress = async (req, res) => {
  try {
    const studentId = req.user.id;
    const { courseId, moduleId } = req.params;
    const { timeSpentSeconds, lastPositionSeconds } = req.body;

    const access = await verifyCourseAccess(studentId, courseId);
    if (!access.hasAccess) {
      return res.status(403).json({ message: "Course is not assigned/enrolled for this student" });
    }

    if (!access.isEnrolled) {
      await pool.query(
        `
        INSERT INTO student_courses (student_id, course_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        `,
        [studentId, courseId]
      );
    }

    const validModule = await verifyModuleInCourse(moduleId, courseId);
    if (!validModule) {
      return res.status(400).json({ message: "Invalid module for this course" });
    }

    const result = await pool.query(
      `
      INSERT INTO module_progress (student_id, course_id, module_id, time_spent_seconds, last_position_seconds, last_accessed_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (student_id,course_id, module_id)
      DO UPDATE SET
        time_spent_seconds = COALESCE(module_progress.time_spent_seconds, 0) + $4,
        last_position_seconds = $5,
        last_accessed_at = NOW()
      RETURNING *
      `,
      [studentId, courseId, moduleId, timeSpentSeconds || 0, lastPositionSeconds || 0]
    );

    if (global.io) {
      global.io.to(`user_${studentId}`).emit("dashboard_update", {
        type: "progress_sync",
        moduleId,
        lastPositionSeconds
      });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error("updateModuleProgress error:", error);
    res.status(500).json({ message: "Server error" });
  }
};