import "dotenv/config";
import cron from "node-cron";
import pool from "../db/postgres.js";
import { emitNotificationToUser } from "./socket.js";

// Run every day at 9 AM
const inactivityCronJob = cron.schedule("0 9 * * *", async () => {
  console.log("\n📋 [CRON] Starting inactivity check at", new Date().toISOString());

  try {
    // Find users inactive for 1+ day
    const inactiveUsers = await pool.query(`
      SELECT user_id, full_name, email, last_active
      FROM users
      WHERE role = 'student'
        AND last_active < NOW() - INTERVAL '1 day'
        AND status = 'active'
      ORDER BY last_active ASC
    `);

    console.log(`Found ${inactiveUsers.rows.length} inactive students`);

    if (inactiveUsers.rows.length === 0) {
      console.log("✅ No inactive students found");
      return;
    }

    // Create and send notifications to inactive users
    for (const user of inactiveUsers.rows) {
      try {
        const message = "Your learning streak has expired. Get back to learning today!";

        // Insert into database only if no notification for this event exists today
        const notifRes = await pool.query(
          `INSERT INTO notifications (user_id, message, link, type)
           SELECT $1, $2, $3, $4
           WHERE NOT EXISTS (
             SELECT 1 FROM notifications
             WHERE user_id = $1
               AND type = $4
               AND created_at::date = CURRENT_DATE
           )
           RETURNING *`,
          [user.user_id, message, "/student/dashboard", "STREAK_EXPIRED"]
        );

        if (notifRes.rows.length > 0) {
          console.log(`📬 Notification inserted for ${user.full_name}`);

          // Emit real-time socket notification (if user is online)
          emitNotificationToUser(user.user_id, {
            id: notifRes.rows[0].id,
            message: message,
            link: "/student/dashboard",
            type: "STREAK_EXPIRED",
            is_read: false,
            created_at: notifRes.rows[0].created_at,
          });

          console.log(`📤 Socket notification sent to ${user.full_name} (if online)`);
        } else {
          console.log(`ℹ️ Notification already exists for ${user.full_name} today`);
        }
      } catch (err) {
        console.error(`❌ Error processing user ${user.user_id}:`, err.message);
      }
    }

    console.log("✅ Inactivity check completed\n");
  } catch (err) {
    console.error("❌ Inactivity cron job error:", err.message);
  }
});

// Also run a check immediately on startup (for testing, set to 30 seconds for demo)
const testCronJob = cron.schedule("*/30 * * * * *", async () => {
  // Running a quick check for demo purposes
  try {
    // Find users inactive for 1+ day
    const inactiveUsers = await pool.query(`
      SELECT user_id, full_name
      FROM users
      WHERE role = 'student'
        AND last_active < NOW() - INTERVAL '1 day'
      LIMIT 1
    `);

    if (inactiveUsers.rows.length > 0) {
      console.log(`[TEST CRON] User inactive >= 1 day found: ${inactiveUsers.rows[0].full_name}`);
    }
  } catch (err) {
    // ignore
  }
});

export { inactivityCronJob, testCronJob };
