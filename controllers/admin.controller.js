import pool from "../db/postgres.js";
import { emitNotificationToUser } from "../services/socket.js";

{/*export const getDashboardStats = async (req, res) => {
  try {
    const studentsResult = await pool.query(
      "SELECT COUNT(*) FROM users WHERE role = 'student'",
    );
    const instructorsResult = await pool.query(
      "SELECT COUNT(*) FROM users WHERE role = 'instructor'",
    );
    const pendingCoursesResult = await pool.query(
      "SELECT COUNT(*) FROM courses WHERE status = 'pending'",
    );
    res.status(200).json({
      totalStudents: Number(studentsResult.rows[0].count),
      totalInstructors: Number(instructorsResult.rows[0].count),
      pendingCourses: Number(pendingCoursesResult.rows[0].count),
    });
  } catch (error) {
    console.error("Admin dashboard stats error:", error);
    res.status(500).json({ message: "Failed to load dashboard stats" });
  }
};*/}

export const getDashboardStats = async (req, res) => {
  try {
    let { startDate, endDate } = req.query;
    
    // If no date filters provided, return all-time totals
    if (!startDate || !endDate) {
      const studentsResult = await pool.query(
        `SELECT COUNT(*) FROM users WHERE role = 'student'`
      );
      const instructorsResult = await pool.query(
        `SELECT COUNT(*) FROM users WHERE role = 'instructor'`
      );
      const pendingCoursesResult = await pool.query(
        `SELECT COUNT(*) FROM courses WHERE status IN ('review', 'pending')`
      );
      
      const certificatesRes = await pool.query(
        `
        SELECT COUNT(*)
        FROM certificates c
        JOIN exams e ON e.exam_id = c.exam_id
        WHERE e.exam_type = 'exam'
        `
      );
      const certificates = Number(certificatesRes.rows[0].count || 0);

      // --- RECENT ACTIVITY ---
      // 1. New students
      const newStudents = await pool.query(`
          SELECT full_name as user, 'New student joined' as action, created_at, 'student' as type 
          FROM users 
          WHERE role = 'student' 
          ORDER BY created_at DESC LIMIT 5
      `);
      
      // 2. New instructors
      const newInstructors = await pool.query(`
          SELECT full_name as user, 'New instructor joined' as action, created_at, 'instructor' as type 
          FROM users 
          WHERE role = 'instructor' 
          ORDER BY created_at DESC LIMIT 5
      `);
      
      // 3. Courses pending review
      const pendingCoursesAct = await pool.query(`
          SELECT u.full_name as user, 'Course submitted: ' || c.title as action, c.created_at, 'course_pending' as type 
          FROM courses c
          JOIN users u ON c.instructor_id = u.user_id
          WHERE c.status = 'review' OR c.status = 'pending'
          ORDER BY c.created_at DESC LIMIT 5
      `);
      
      // 4. Courses approved
      const approvedCoursesAct = await pool.query(`
          SELECT u.full_name as user, 'Course approved: ' || c.title as action, c.created_at, 'course_approved' as type 
          FROM courses c
          JOIN users u ON c.instructor_id = u.user_id
          WHERE c.status = 'approved'
          ORDER BY c.created_at DESC LIMIT 5
      `);

      let recentActivity = [
          ...newStudents.rows, 
          ...newInstructors.rows, 
          ...pendingCoursesAct.rows, 
          ...approvedCoursesAct.rows
      ];
      
      recentActivity.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      recentActivity = recentActivity.slice(0, 10);

      // --- CHART DATA (Last 7 Days Assignments/Lessons) ---
      const chartQuery = `
          SELECT 
              TO_CHAR(d.date, 'Dy') as name,
              COUNT(ca.assigned_at) as lessons
          FROM (
              SELECT current_date - i as date
              FROM generate_series(6, 0, -1) i
          ) d
          LEFT JOIN course_assignments ca ON DATE(ca.assigned_at) = d.date
          GROUP BY d.date
          ORDER BY d.date ASC;
      `;
      const chartDataRes = await pool.query(chartQuery);
      const chartData = chartDataRes.rows.map(row => ({
          name: row.name,
          lessons: Number(row.lessons)
      }));

      return res.status(200).json({
        totalStudents: Number(studentsResult.rows[0].count),
        totalInstructors: Number(instructorsResult.rows[0].count),
        pendingCourses: Number(pendingCoursesResult.rows[0].count),
        certificates,
        studentsChange: 0,
        instructorsChange: 0,
        pendingCoursesChange: 0,
        startDate: null,
        endDate: null,
        recentActivity,
        chartData
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

    // Current period - Students created in this period
    const studentsResult = await pool.query(
      `SELECT COUNT(*) FROM users WHERE role = 'student' AND created_at::date BETWEEN $1 AND $2`,
      [startDate, endDate]
    );
    // Previous period - Students created in previous period
    const prevStudentsResult = await pool.query(
      `SELECT COUNT(*) FROM users WHERE role = 'student' AND created_at::date BETWEEN $1 AND $2`,
      [prevStartDate, prevEndDate]
    );

    // Current period - Instructors created in this period
    const instructorsResult = await pool.query(
      `SELECT COUNT(*) FROM users WHERE role = 'instructor' AND created_at::date BETWEEN $1 AND $2`,
      [startDate, endDate]
    );
    // Previous period - Instructors created in previous period
    const prevInstructorsResult = await pool.query(
      `SELECT COUNT(*) FROM users WHERE role = 'instructor' AND created_at::date BETWEEN $1 AND $2`,
      [prevStartDate, prevEndDate]
    );

    // Current period - Pending courses
    const pendingCoursesResult = await pool.query(
      `SELECT COUNT(*) FROM courses WHERE status IN ('review', 'pending') AND created_at::date BETWEEN $1 AND $2`,
      [startDate, endDate]
    );
    // Previous period - Pending courses
    const prevPendingCoursesResult = await pool.query(
      `SELECT COUNT(*) FROM courses WHERE status IN ('review', 'pending') AND created_at::date BETWEEN $1 AND $2`,
      [prevStartDate, prevEndDate]
    );

    // Calculate percentage changes
    const calculateChange = (current, previous) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / previous) * 100);
    };

    const totalStudents = Number(studentsResult.rows[0].count);
    const prevStudents = Number(prevStudentsResult.rows[0].count);
    const totalInstructors = Number(instructorsResult.rows[0].count);
    const prevInstructors = Number(prevInstructorsResult.rows[0].count);
    const pendingCourses = Number(pendingCoursesResult.rows[0].count);
    const prevPendingCourses = Number(prevPendingCoursesResult.rows[0].count);

    const certificatesRes = await pool.query(
      `
      SELECT COUNT(*)
      FROM certificates c
      JOIN exams e ON e.exam_id = c.exam_id
      WHERE e.exam_type = 'exam'
        AND c.issued_at::date BETWEEN $1 AND $2
      `,
      [startDate, endDate]
    );
    const certificates = Number(certificatesRes.rows[0].count || 0);

    // --- RECENT ACTIVITY ---
    const newStudentsAct = await pool.query(`
        SELECT full_name as user, 'New student joined' as action, created_at, 'student' as type 
        FROM users 
        WHERE role = 'student' 
        ORDER BY created_at DESC LIMIT 5
    `);
    const newInstructorsAct = await pool.query(`
        SELECT full_name as user, 'New instructor joined' as action, created_at, 'instructor' as type 
        FROM users 
        WHERE role = 'instructor' 
        ORDER BY created_at DESC LIMIT 5
    `);
    const pendingCoursesActFiltered = await pool.query(`
        SELECT u.full_name as user, 'Course submitted: ' || c.title as action, c.created_at, 'course_pending' as type 
        FROM courses c
        JOIN users u ON c.instructor_id = u.user_id
        WHERE c.status = 'review' OR c.status = 'pending'
        ORDER BY c.created_at DESC LIMIT 5
    `);
    const approvedCoursesActFiltered = await pool.query(`
        SELECT u.full_name as user, 'Course approved: ' || c.title as action, c.created_at, 'course_approved' as type 
        FROM courses c
        JOIN users u ON c.instructor_id = u.user_id
        WHERE c.status = 'approved'
        ORDER BY c.created_at DESC LIMIT 5
    `);

    let recentActivityFiltered = [
        ...newStudentsAct.rows, 
        ...newInstructorsAct.rows, 
        ...pendingCoursesActFiltered.rows, 
        ...approvedCoursesActFiltered.rows
    ];
    
    recentActivityFiltered.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    recentActivityFiltered = recentActivityFiltered.slice(0, 10);

    // --- CHART DATA (Last 7 Days Assignments/Lessons) ---
    const chartQuery = `
        SELECT 
            TO_CHAR(d.date, 'Dy') as name,
            COUNT(ca.assigned_at) as lessons
        FROM (
            SELECT current_date - i as date
            FROM generate_series(6, 0, -1) i
        ) d
        LEFT JOIN course_assignments ca ON DATE(ca.assigned_at) = d.date
        GROUP BY d.date
        ORDER BY d.date ASC;
    `;
    const chartDataRes = await pool.query(chartQuery);
    const chartData = chartDataRes.rows.map(row => ({
        name: row.name,
        lessons: Number(row.lessons)
    }));

    res.status(200).json({
      totalStudents,
      totalInstructors,
      pendingCourses,
      certificates,
      studentsChange: calculateChange(totalStudents, prevStudents),
      instructorsChange: calculateChange(totalInstructors, prevInstructors),
      pendingCoursesChange: calculateChange(pendingCourses, prevPendingCourses),
      startDate,
      endDate,
      recentActivity: recentActivityFiltered,
      chartData
    });
  } catch (error) {
    console.error("Admin dashboard stats error:", error);
    res.status(500).json({ message: "Failed to load dashboard stats" });
  }
};

export const getAllStudents = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT user_id, full_name AS name, email
FROM users
WHERE role = 'student' AND status = 'active'
ORDER BY created_at DESC;
`,
    );
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("Get students error:", error);
    res.status(500).json({ message: "Failed to fetch students" });
  }
};

export const getManagersList = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         user_id,
         full_name,
         email,
         college,
         created_at,
         last_login
       FROM users
       WHERE role = 'manager'
       ORDER BY created_at DESC`,
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("Get managers list error:", error);
    return res.status(500).json({ message: "Failed to fetch managers" });
  }
};



export const assignCourses = async (req, res) => {
  const { studentIds = [], groupIds = [], courseIds } = req.body;

  if (!courseIds?.length) {
    return res.status(400).json({
      message: "courseIds are required",
    });
  }

  if (studentIds.length === 0 && groupIds.length === 0) {
    return res.status(400).json({
      message: "At least one studentId or groupId is required",
    });
  }

  try {
    // 1️⃣ Collect all student IDs from selected groups
    let allStudentIds = [...studentIds];

    if (groupIds.length > 0) {
      const groupsRes = await pool.query(
        `SELECT group_id, group_name, start_date, end_date, created_by 
         FROM groups WHERE group_id = ANY($1::uuid[])`,
        [groupIds]
      );

      for (const group of groupsRes.rows) {
        if (group.created_by) {
          // Manual group
          const res = await pool.query(
            `SELECT DISTINCT gu.user_id
             FROM group_users gu
             JOIN users u ON gu.user_id = u.user_id
             WHERE gu.group_id = $1
               AND u.role = 'student'
               AND u.status = 'active'`,
            [group.group_id]
          );
          res.rows.forEach(r => allStudentIds.push(r.user_id));
        } else if (group.start_date && group.end_date) {
          // Timestamp group
          const res = await pool.query(
            `SELECT user_id FROM users u
             WHERE u.created_at >= $1 AND u.created_at <= $2
               AND u.role = 'student' AND u.status = 'active'`,
            [group.start_date, group.end_date]
          );
          res.rows.forEach(r => allStudentIds.push(r.user_id));
        } else {
          // College group
          const res = await pool.query(
            `SELECT user_id FROM users u
             WHERE u."college" IS NOT NULL
               AND REGEXP_REPLACE(UPPER(TRIM(u."college")), '[,.\\-_() ]+', ' ', 'g') = 
                   REGEXP_REPLACE(UPPER(TRIM($1)), '[,.\\-_() ]+', ' ', 'g')
               AND u.role = 'student' AND u.status = 'active'`,
             [group.group_name]
          );
          res.rows.forEach(r => allStudentIds.push(r.user_id));
        }
      }

      allStudentIds = [...new Set(allStudentIds)]; // Remove duplicates
    }

    if (allStudentIds.length === 0) {
      return res.status(400).json({
        message: "No active students found in the selected groups/students",
      });
    }

    // 2️⃣ Assign courses to all collected students
    const query = `
      INSERT INTO course_assignments (student_id, course_id)
      SELECT s_id, c_id
      FROM UNNEST($1::uuid[]) AS s_id
      CROSS JOIN UNNEST($2::uuid[]) AS c_id
      ON CONFLICT DO NOTHING;
    `;

    await pool.query(query, [allStudentIds, courseIds]);

    // 3️⃣ Fetch course titles once for notifications
    const coursesRes = await pool.query(
      `SELECT courses_id, title FROM courses WHERE courses_id = ANY($1::uuid[])`,
      [courseIds],
    );
    const courseTitleById = new Map(
      coursesRes.rows.map((c) => [c.courses_id, c.title]),
    );

    // 4️⃣ Create notifications and send emails to all students
    console.log("Starting notification creation for students:", allStudentIds);

    for (const studentId of allStudentIds) {
      try {
        // Fetch student email and name from database
        const studentResult = await pool.query(
          `SELECT email, full_name FROM users WHERE user_id = $1`,
          [studentId],
        );

        if (studentResult.rows.length > 0) {
          const { email, full_name } = studentResult.rows[0];

          // Create notification and log the inserted row
          for (const courseId of courseIds) {
            try {
              const courseTitle =
                courseTitleById.get(courseId) || "a new course";
              const message = `🎓 New course assigned: ${courseTitle}. Enroll now.`;

              const notifRes = await pool.query(
                `INSERT INTO notifications (user_id, message, link)
                 VALUES ($1, $2, $3)
                 RETURNING *`,
                [studentId, message, `/student/course/${courseId}`],
              );
              console.log(
                `Notification created for student ${studentId} (course ${courseId}):`,
                notifRes.rows[0],
              );

              // 🚀 EMIT REAL-TIME SOCKET NOTIFICATION
              emitNotificationToUser(studentId, {
                id: notifRes.rows[0].id,
                message: message,
                link: `/student/course/${courseId}`,
                type: "COURSE_ASSIGNED",
                is_read: false,
                created_at: notifRes.rows[0].created_at,
              });

              // 🚀 EMIT DASHBOARD UPDATE
              if (global.io) {
                global.io.to(`user_${studentId}`).emit("dashboard_update", {
                  type: "course_assigned",
                  courseId,
                });
              }
            } catch (insertErr) {
              console.error(
                `Failed to insert notification for ${studentId} (course ${courseId}):`,
                insertErr,
              );
            }
          }
        }
      } catch (notifError) {
        console.error(`Failed to process student ${studentId}:`, notifError);
      }
    }

    res.status(200).json({
      message: `Courses assigned successfully to ${allStudentIds.length} student(s)`,
      students_count: allStudentIds.length,
    });
  } catch (error) {
    console.error("Assign courses error:", error);
    res.status(500).json({ message: "Failed to assign courses" });
  }
};

export const updateCourseStatus = async (req, res) => {
  const { courses_id } = req.params;
  const { status } = req.body;

  const allowedStatuses = ["approved", "rejected", "pending"];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      message: "Invalid status value",
    });
  }

  try {
    // ✅ Check if course exists
    const courseCheck = await pool.query(
      `SELECT courses_id FROM courses WHERE courses_id = $1`,
      [courses_id],
    );

    if (courseCheck.rows.length === 0) {
      return res.status(404).json({
        message: "Course not found",
      });
    }

    // ✅ Update course status
    const result = await pool.query(
      `UPDATE courses
       SET status = $1
       WHERE courses_id = $2
       RETURNING courses_id, title, status`,
      [status, courses_id],
    );

    res.status(200).json({
      message: `Course ${status} successfully`,
      course: result.rows[0],
    });
  } catch (error) {
    console.error("Update course status error:", error);
    res.status(500).json({
      message: "Failed to update course status",
    });
  }
};

export const getNotificationsForUser = async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [userId],
    );
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("getNotificationsForUser error:", error);
    res.status(500).json({ message: "Failed to fetch notifications for user" });
  }
};

export const getCoursesByStatus = async (req, res) => {
  const { status } = req.query;

  const allowedStatuses = ["pending", "approved", "rejected"];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      message: "Invalid or missing status",
    });
  }

  try {
    const result = await pool.query(
      `
      SELECT
        c.courses_id,
        c.title,
        c.description,
        c.category,
        c.status,
        c.created_at,
        u.full_name AS instructor_name
      FROM courses c
      JOIN users u ON c.instructor_id = u.user_id
      WHERE c.status = $1
      ORDER BY c.created_at DESC
      `,
      [status],
    );

    res.status(200).json({
      courses: result.rows,
    });
  } catch (error) {
    console.error("getCoursesByStatus error:", error);
    res.status(500).json({ message: "Failed to fetch courses" });
  }
};

export const getPendingCourses = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
  c.courses_id,
  c.title,
  c.description,
  c.category,
  c.status,
  c.created_at,
  u.full_name AS instructor_name
FROM courses c
JOIN users u ON c.instructor_id = u.user_id
WHERE c.status = 'pending'
ORDER BY c.created_at DESC`,
    );

    res.status(200).json({
      courses: result.rows,
    });
  } catch (error) {
    console.error("Get pending courses error:", error);
    res.status(500).json({
      message: "Failed to fetch pending courses",
    });
  }
};

export const approveUser = async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await pool.query(
      `SELECT user_id, full_name, role, status, created_at, headline FROM users WHERE user_id = $1`,
      [userId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    const user = result.rows[0];

    if (user.role === "admin") {
      return res.status(403).json({
        message: "Admin accounts cannot be approved here",
      });
    }

    if (user.status === "active") {
      return res.status(400).json({
        message: "User is already approved",
      });
    }

    if (user.status === "blocked" || user.status === "rejected") {
      return res.status(400).json({
        message: "User cannot be approved",
      });
    }

    const updatedUser = await pool.query(
      `UPDATE users
       SET status = 'active'
       WHERE user_id = $1
       RETURNING user_id, role, status`,
      [userId],
    );

    // 🚀 AUTO-ASSIGN USER TO APPROPRIATE GROUPS
    let assignedGroups = [];
    if (user.role === "student") {
      try {
        console.log(`🔍 Starting group assignment for user ${userId}`);
        console.log(
          `   User Info: ${user.full_name}, Created at: ${user.created_at}, Headline: ${user.headline}`,
        );

        // Get all groups for debugging
        const allGroups = await pool.query(
          `SELECT group_id, group_name, start_date, end_date FROM groups`,
        );
        console.log(`📊 Total groups in DB: ${allGroups.rows.length}`);
        allGroups.rows.forEach((g) => {
          console.log(
            `   - ${g.group_name}: dates ${g.start_date ? "✅" : "❌"} start=${g.start_date}, end=${g.end_date}`,
          );
        });

        // Strategy 1: Timestamp-based groups (date-based cohorts)
        // Find groups where user registration date falls within group date range
        if (user.created_at) {
          try {
            const timestampGroups = await pool.query(
              `SELECT group_id, group_name FROM groups 
               WHERE start_date IS NOT NULL 
               AND end_date IS NOT NULL
               AND start_date <= $1::timestamp
               AND end_date >= $1::timestamp`,
              [user.created_at],
            );

            console.log(
              `📅 Found ${timestampGroups.rows.length} matching timestamp groups`,
            );

            for (const group of timestampGroups.rows) {
              try {
                console.log(
                  `   ➕ Adding user to timestamp group: ${group.group_name}`,
                );
                await pool.query(
                  `INSERT INTO group_users (group_id, user_id, assigned_at)
                   VALUES ($1, $2, NOW())
                   ON CONFLICT (group_id, user_id) DO NOTHING`,
                  [group.group_id, userId],
                );
                assignedGroups.push(group.group_name);
                console.log(`   ✅ Added to ${group.group_name}`);
              } catch (insertErr) {
                console.error(
                  `   ❌ Failed to add to ${group.group_name}:`,
                  insertErr.message,
                );
              }
            }
          } catch (err) {
            console.error(
              `   ❌ Error checking timestamp groups:`,
              err.message,
            );
          }
        }

        // If timestamp-based assignments found none, run fallback assignment
        if (assignedGroups.length === 0) {
          console.log(
            `🔄 No timestamp groups matched; trying fallback: assign to manual or most-recent group...`,
          );
          try {
            const anyGroup = await pool.query(
              `SELECT group_id, group_name FROM groups 
               WHERE start_date IS NULL OR end_date IS NULL
               LIMIT 1`,
            );

            if (anyGroup.rows.length > 0) {
              console.log(
                `   💡 Found manual group: ${anyGroup.rows[0].group_name}`,
              );
              try {
                await pool.query(
                  `INSERT INTO group_users (group_id, user_id, assigned_at)
                   VALUES ($1, $2, NOW())
                   ON CONFLICT (group_id, user_id) DO NOTHING`,
                  [anyGroup.rows[0].group_id, userId],
                );
                assignedGroups.push(anyGroup.rows[0].group_name);
                console.log(
                  `   ✅ Added to fallback group: ${anyGroup.rows[0].group_name}`,
                );
              } catch (insertErr) {
                console.error(
                  `   ❌ Failed to add to fallback group:`,
                  insertErr.message,
                );
              }
            } else {
              console.log(
                `   ⚠️  No manual groups available (no null-date groups found)`,
              );
              // As an additional fallback, pick the most-recent group (by start_date or creation)
              try {
                const recentGroup = await pool.query(
                  `SELECT group_id, group_name, start_date, end_date FROM groups
                   ORDER BY start_date DESC NULLS LAST, group_id DESC
                   LIMIT 1`,
                );

                if (recentGroup.rows.length > 0) {
                  const rg = recentGroup.rows[0];
                  console.log(
                    `   🔎 Found recent group as final fallback: ${rg.group_name} (start=${rg.start_date}, end=${rg.end_date})`,
                  );
                  try {
                    await pool.query(
                      `INSERT INTO group_users (group_id, user_id, assigned_at)
                       VALUES ($1, $2, NOW())
                       ON CONFLICT (group_id, user_id) DO NOTHING`,
                      [rg.group_id, userId],
                    );
                    assignedGroups.push(rg.group_name);
                    console.log(
                      `   ✅ Added to recent fallback group: ${rg.group_name}`,
                    );
                  } catch (insErr) {
                    console.error(
                      `   ❌ Failed to add to recent fallback group:`,
                      insErr.message,
                    );
                  }
                } else {
                  console.log(`   ⚠️  No groups exist in DB at all.`);
                }
              } catch (err) {
                console.error(
                  `   ❌ Error checking recent groups:`,
                  err.message,
                );
              }
            }
          } catch (err) {
            console.error(`   ❌ Error checking fallback groups:`, err.message);
          }
        }

        console.log(
          `✅ Group assignment completed. Total groups assigned: ${assignedGroups.length}`,
        );
        if (assignedGroups.length > 0) {
          console.log(`   Groups: ${assignedGroups.join(", ")}`);
        }
      } catch (error) {
        console.error("❌ Error auto-assigning user to groups:", error.message);
      }
    }

    res.json({
      message: "User approved successfully",
      user: updatedUser.rows[0],
    });
  } catch (error) {
    console.error("approveUser error:", error);
    res.status(500).json({
      message: "Failed to approve user",
    });
  }
};

export const getPendingUsers = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         user_id,
         full_name,
         email,
         role,
         status,
         created_at
       FROM users
       WHERE status = 'pending'
       ORDER BY created_at DESC`,
    );

    res.json({
      users: result.rows,
    });
  } catch (error) {
    console.error("getPendingUsers error:", error);
    res.status(500).json({
      message: "Failed to fetch pending users",
    });
  }
};

export const updateUserStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { status } = req.body; // 'active' | 'blocked'

    if (!["active", "blocked"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const result = await pool.query(
      `
      UPDATE users
      SET status = $1
      WHERE user_id = $2
      `,
      [status, userId],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    res.json({ message: `User ${status} successfully` });
  } catch (err) {
    console.error("updateUserStatus error:", err);
    res.status(500).json({ message: "Server error" });
  }
};
// 🔍 DEBUG ENDPOINT: Check what groups a user should be assigned to
export const debugUserGroups = async (req, res) => {
  try {
    const { userId } = req.params;

    // Get user info
    const userResult = await pool.query(
      `SELECT user_id, full_name, created_at, headline FROM users WHERE user_id = $1`,
      [userId],
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const user = userResult.rows[0];

    // Get all groups
    const allGroups = await pool.query(
      `SELECT group_id, group_name, start_date, end_date, created_by FROM groups`,
    );

    // Check timestamp groups
    const timestampMatches = [];
    for (const group of allGroups.rows) {
      if (group.created_by === null && group.start_date && group.end_date) {
        const isMatch =
          user.created_at >= group.start_date &&
          user.created_at <= group.end_date;
        timestampMatches.push({
          group_id: group.group_id,
          group_name: group.group_name,
          user_created_at: user.created_at,
          group_start_date: group.start_date,
          group_end_date: group.end_date,
          isMatch: isMatch,
        });
      }
    }

    // College/headline matching disabled — handled by fallback only
    let collegeMatch = null;

    // Get current group assignments
    const currentGroups = await pool.query(
      `SELECT gu.group_id, g.group_name FROM group_users gu 
       JOIN groups g ON gu.group_id = g.group_id 
       WHERE gu.user_id = $1`,
      [userId],
    );

    res.json({
      user: user,
      timestampGroupMatches: timestampMatches,
      collegeMatch: collegeMatch,
      currentAssignments: currentGroups.rows,
      allGroups: allGroups.rows,
    });
  } catch (error) {
    console.error("debugUserGroups error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// 🔍 DATABASE SCHEMA DIAGNOSTIC: Check all tables and their structure
export const diagnosticDatabaseSchema = async (req, res) => {
  try {
    const diagnostics = {};

    // 1. Check if tables exist and their structure
    const tables = [
      "users",
      "groups",
      "group_users",
      "courses",
      "course_assignments",
    ];

    for (const tableName of tables) {
      try {
        const tableInfo = await pool.query(
          `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
           WHERE table_name = $1
           ORDER BY ordinal_position`,
          [tableName],
        );

        if (tableInfo.rows.length > 0) {
          diagnostics[tableName] = {
            exists: true,
            columns: tableInfo.rows,
            columnNames: tableInfo.rows.map((c) => c.column_name),
          };
        } else {
          diagnostics[tableName] = { exists: false };
        }
      } catch (err) {
        diagnostics[tableName] = { exists: false, error: err.message };
      }
    }

    // 2. Count records in each table
    try {
      const userCount = await pool.query(`SELECT COUNT(*) as count FROM users`);
      diagnostics.userCount = userCount.rows[0].count;
    } catch (e) {
      diagnostics.userCount = "Error";
    }

    try {
      const groupCount = await pool.query(
        `SELECT COUNT(*) as count FROM groups`,
      );
      diagnostics.groupCount = groupCount.rows[0].count;
    } catch (e) {
      diagnostics.groupCount = "Error";
    }

    try {
      const groupUsersCount = await pool.query(
        `SELECT COUNT(*) as count FROM group_users`,
      );
      diagnostics.groupUsersCount = groupUsersCount.rows[0].count;
    } catch (e) {
      diagnostics.groupUsersCount = "Error";
    }

    // 3. Show sample data
    try {
      const sampleGroups = await pool.query(`SELECT * FROM groups LIMIT 5`);
      diagnostics.sampleGroups = sampleGroups.rows;
    } catch (e) {
      diagnostics.sampleGroups = [];
    }

    try {
      const sampleGroupUsers = await pool.query(
        `SELECT * FROM group_users LIMIT 5`,
      );
      diagnostics.sampleGroupUsers = sampleGroupUsers.rows;
    } catch (e) {
      diagnostics.sampleGroupUsers = [];
    }

    try {
      const pendingStudents = await pool.query(
        `SELECT user_id, full_name, email, created_at FROM users WHERE role = 'student' AND status = 'pending' LIMIT 5`,
      );
      diagnostics.pendingStudents = pendingStudents.rows;
    } catch (e) {
      diagnostics.pendingStudents = [];
    }

    // 4. Check constraints and indexes
    try {
      const constraints = await pool.query(
        `SELECT constraint_name, constraint_type
         FROM information_schema.table_constraints
         WHERE table_name IN ('group_users', 'groups', 'users')`,
      );
      diagnostics.constraints = constraints.rows;
    } catch (e) {
      diagnostics.constraints = [];
    }

    res.json({
      timestamp: new Date().toISOString(),
      diagnostics: diagnostics,
      recommendations: generateRecommendations(diagnostics),
    });
  } catch (error) {
    console.error("diagnosticDatabaseSchema error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ✅ HELPER: Bulk assign all active students to a group
export const bulkAssignStudentsToGroup = async (req, res) => {
  try {
    const { groupId } = req.params;

    // Verify group exists
    const groupCheck = await pool.query(
      `SELECT group_id, group_name FROM groups WHERE group_id = $1`,
      [groupId],
    );

    if (groupCheck.rows.length === 0) {
      return res.status(404).json({ message: "Group not found" });
    }

    const group = groupCheck.rows[0];

    // Get all active students (not including pending)
    const activeStudents = await pool.query(
      `SELECT user_id FROM users WHERE role = 'student' AND status = 'active'`,
    );

    console.log(
      `📊 Found ${activeStudents.rows.length} active students to assign to group ${group.group_name}`,
    );

    let assignedCount = 0;
    for (const student of activeStudents.rows) {
      try {
        await pool.query(
          `INSERT INTO group_users (group_id, user_id, assigned_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (group_id, user_id) DO NOTHING`,
          [groupId, student.user_id],
        );
        assignedCount++;
      } catch (err) {
        console.error(
          `Failed to assign student ${student.user_id}:`,
          err.message,
        );
      }
    }

    console.log(
      `✅ Successfully assigned ${assignedCount} students to group ${group.group_name}`,
    );

    res.json({
      message: `Successfully assigned ${assignedCount} students to group: ${group.group_name}`,
      groupId: groupId,
      groupName: group.group_name,
      studentsAssigned: assignedCount,
    });
  } catch (error) {
    console.error("bulkAssignStudentsToGroup error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Helper function to generate recommendations
function generateRecommendations(diagnostics) {
  const recommendations = [];

  if (!diagnostics.group_users?.exists) {
    recommendations.push({
      severity: "CRITICAL",
      message: "group_users table does not exist!",
      action:
        "You need to create the group_users table with columns: group_id, user_id, assigned_at",
    });
  }

  if (diagnostics.groupCount === 0 || diagnostics.groupCount === "0") {
    recommendations.push({
      severity: "WARNING",
      message: "No groups exist in the database",
      action: "Create at least one group before assigning users",
    });
  }

  if (
    diagnostics.groupUsersCount === 0 ||
    diagnostics.groupUsersCount === "0"
  ) {
    recommendations.push({
      severity: "INFO",
      message: "No users have been assigned to groups yet",
      action:
        "This is normal - assignments should happen when admin approves users",
    });
  }

  const requiredColumns = {
    users: [
      "user_id",
      "full_name",
      "email",
      "role",
      "status",
      "created_at",
      "headline",
    ],
    groups: ["group_id", "group_name", "start_date", "end_date", "created_by"],
    group_users: ["group_id", "user_id", "assigned_at"],
  };

  for (const [table, columns] of Object.entries(requiredColumns)) {
    if (diagnostics[table]?.exists) {
      const tableColumns = diagnostics[table].columnNames;
      const missing = columns.filter((col) => !tableColumns.includes(col));
      if (missing.length > 0) {
        recommendations.push({
          severity: "ERROR",
          message: `Table '${table}' is missing columns: ${missing.join(", ")}`,
          action: `Add these columns to the ${table} table`,
        });
      }
    }
  }

  return recommendations;
}

export const getAllViolations = async (req, res) => {
  try {
    console.log(`\n--- [ADMIN] Fetching All Violations (User: ${req.user?.email}) ---`);
    const result = await pool.query(
      `SELECT 
        v.violation_id,
        v.violation_type,
        v.details,
        v.created_at,
        v.student_id,
        v.exam_id,
        u.full_name AS student_name,
        u.email AS student_email,
        COALESCE(e.title, v.exam_id::text) AS exam_title,
        er.obtained_marks,
        er.total_marks,
        er.percentage AS exam_score,
        er.passed AS exam_status
      FROM exam_violations v
      LEFT JOIN users u ON v.student_id = u.user_id
      LEFT JOIN exams e ON v.exam_id::text = e.exam_id::text
      LEFT JOIN exam_results er ON v.student_id = er.student_id AND v.exam_id::text = er.exam_id::text
      ORDER BY v.created_at DESC`
    );

    console.log(`✅ Found ${result.rows.length} violations in database.`);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("❌ getAllViolations error:", error.message);
    res.status(500).json({ message: "Failed to fetch violations" });
  }
};

export const getViolationsSummary = async (req, res) => {
  try {
    console.log("\n--- [ADMIN] Fetching Violations Summary ---");
    const result = await pool.query(
      `SELECT 
        u.user_id,
        u.full_name AS student_name,
        u.email AS student_email,
        COUNT(CASE WHEN v.violation_type IN ('NO_FACE', 'no_face') THEN 1 END) AS no_face_count,
        COUNT(CASE WHEN v.violation_type IN ('MULTIPLE_FACES', 'multiple_faces') THEN 1 END) AS multiple_faces_count,
        COUNT(CASE WHEN v.violation_type IN ('PHONE_DETECTED', 'OBJECT_DETECTION', 'phone_detected', 'object_detection') THEN 1 END) AS phone_detected_count,
        COUNT(CASE WHEN v.violation_type IN ('LOUD_NOISE', 'loud_noise') THEN 1 END) AS loud_noise_count,
        COUNT(CASE WHEN v.violation_type IN ('VOICE_DETECTION', 'voice_detection') THEN 1 END) AS voice_detected_count,
        COUNT(CASE WHEN v.violation_type NOT IN ('NO_FACE', 'no_face', 'MULTIPLE_FACES', 'multiple_faces', 'PHONE_DETECTED', 'phone_detected', 'OBJECT_DETECTION', 'object_detection', 'LOUD_NOISE', 'loud_noise', 'VOICE_DETECTION', 'voice_detection') THEN 1 END) AS others_count,
        COUNT(v.violation_id) AS total_count
      FROM users u
      JOIN exam_violations v ON u.user_id = v.student_id
      WHERE u.role IN ('student', 'user', 'learner')
      GROUP BY u.user_id, u.full_name, u.email
      ORDER BY total_count DESC`
    );

    console.log(`✅ Found ${result.rows.length} students with violations.`);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("❌ getViolationsSummary error:", error.message);
    res.status(500).json({ message: "Failed to fetch violations summary" });
  }
};

export const getDetailedViolationsReport = async (req, res) => {
  try {
    console.log("\n--- [ADMIN] Fetching Detailed Violations Report ---");
    const result = await pool.query(
      `SELECT 
          u.user_id AS student_id,
          u.full_name AS student_name,
          u.email,
          COALESCE(e.title, v.exam_id::text) AS exam_name,
          er.evaluated_at AS exam_date,
          COALESCE(er.obtained_marks, 0) AS marks_obtained,
          COALESCE(er.total_marks, 0) AS total_marks,
          COALESCE(er.percentage, 0) AS percentage,
          CASE WHEN er.passed IS TRUE THEN 'Pass' WHEN er.passed IS FALSE THEN 'Fail' ELSE '---' END AS status,
          COALESCE(v.no_face_count, 0) AS no_face,
          COALESCE(v.multiple_faces_count, 0) AS multiple_faces,
          COALESCE(v.phone_detected_count, 0) AS phone_detected,
          COALESCE(v.loud_noise_count, 0) AS loud_noise,
          COALESCE(v.voice_detected_count, 0) AS voice_detected,
          COALESCE(v.total_count, 0) AS total_violations,
          CASE WHEN v.total_count > 0 THEN 'Yes' ELSE 'No' END AS flagged
      FROM users u
      JOIN (
          SELECT 
              student_id, 
              exam_id,
              COUNT(CASE WHEN violation_type IN ('NO_FACE', 'no_face') THEN 1 END) AS no_face_count,
              COUNT(CASE WHEN violation_type IN ('MULTIPLE_FACES', 'multiple_faces') THEN 1 END) AS multiple_faces_count,
              COUNT(CASE WHEN violation_type IN ('PHONE_DETECTED', 'OBJECT_DETECTION', 'phone_detected', 'object_detection') THEN 1 END) AS phone_detected_count,
              COUNT(CASE WHEN violation_type IN ('LOUD_NOISE', 'loud_noise') THEN 1 END) AS loud_noise_count,
              COUNT(CASE WHEN violation_type IN ('VOICE_DETECTION', 'voice_detection') THEN 1 END) AS voice_detected_count,
              COUNT(*) AS total_count
          FROM exam_violations
          GROUP BY student_id, exam_id
      ) v ON u.user_id = v.student_id
      LEFT JOIN exams e ON v.exam_id::text = e.exam_id::text
      LEFT JOIN exam_results er ON u.user_id = er.student_id AND v.exam_id::text = er.exam_id::text
      WHERE u.role = 'student'
      ORDER BY u.full_name, exam_name`
    );

    console.log(`✅ Generated report with ${result.rows.length} records.`);
    res.status(200).json(result.rows);
  } catch (error) {
    console.error("❌ getDetailedViolationsReport error:", error.message);
    res.status(500).json({ message: "Failed to fetch detailed report" });
  }
};
