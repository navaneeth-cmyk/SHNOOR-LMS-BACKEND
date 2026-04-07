import { Server } from "socket.io";
import admin from "firebase-admin";
import { autoSubmitExam } from "../controllers/exams/exam.controller.js";
import pool from "../db/postgres.js";
import { sendPushNotification } from "./pushService.js";

let io = null;

// Initialize Socket.IO server
export const initializeSocket = (httpServer) => {
  io = new Server(httpServer, {
    // Faster disconnect detection to trigger grace timer promptly
    pingInterval: 5000,
    pingTimeout: 8000,
    cors: {
      origin: [
        "http://localhost:5173",
        process.env.FRONTEND_URL || "http://localhost:5173",
      ],
      credentials: true,
    },
  });

  /* =====================================
     🔐 SOCKET AUTH MIDDLEWARE
     Verify Firebase Token
  ===================================== */
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;

      if (!token) {
        return next(new Error("Authentication token missing"));
      }

      const decoded = await admin.auth().verifyIdToken(token);

      // Get actual DB user_id (UUID)
      const { rows } = await pool.query(
        `SELECT user_id FROM users WHERE firebase_uid = $1`,
        [decoded.uid]
      );

      if (!rows.length) {
        return next(new Error("User not found in database"));
      }

      socket.userId = rows[0].user_id; // Real UUID from DB
      next();
    } catch (err) {
      console.error("Socket authentication error:", err);
      next(new Error("Authentication failed"));
    }
  });

  /* =====================================
     🔌 SOCKET CONNECTION
  ===================================== */
  io.on("connection", (socket) => {
    console.log(`🔌 User connected: ${socket.id}`);
    console.log(`👤 Authenticated user: ${socket.userId}`);

    /* =========================
       JOIN USER ROOM
    ========================= */
    socket.join(socket.userId);

    /* =========================
       STUDENT STARTS EXAM
    ========================= */
    socket.on("exam:start", async ({ examId }) => {
      const userId = socket.userId;
      socket.examId = examId;

      console.log(`📝 User ${userId} started exam ${examId}`);
      console.log(`🔍 Checking disconnect state for user ${userId}, exam ${examId}`);

      // Check if exam was auto-submitted during disconnection
      try {
        console.log(`🔍 Checking if exam ${examId} was auto-submitted for user ${userId}...`);
        const { rows } = await pool.query(
          `
          SELECT ea.status, ea.disconnected_at, ea.end_time, e.disconnect_grace_time
          FROM exam_attempts ea
          JOIN exams e ON e.exam_id = ea.exam_id
          WHERE ea.exam_id = $1 AND ea.student_id = $2
          `,
          [examId, userId]
        );

        console.log(`📊 Query result:`, rows);

        if (rows.length > 0 && rows[0].status === 'submitted') {
          console.log(`🚨🚨🚨 Exam ${examId} was auto-submitted for user ${userId} during disconnection`);
          console.log(`📤 Emitting exam:autoSubmitted event to socket ${socket.id}`);
          
          socket.emit("exam:autoSubmitted", {
            examId,
            message: "Exam was auto-submitted due to disconnection",
          });
          
          console.log(`✅ Event emitted successfully`);
        } else if (rows.length > 0) {
          const disconnectedAt = rows[0].disconnected_at;
          const endTime = rows[0].end_time;
          const graceSeconds = rows[0].disconnect_grace_time || 0;
          const { rows: nowRows } = await pool.query(`SELECT NOW() AS now`);
          const now = nowRows[0].now;

          const deadlineMs = endTime
            ? new Date(endTime).getTime() + graceSeconds * 1000
            : null;

          if (deadlineMs && new Date(now).getTime() > deadlineMs) {
            console.log(`🚨 Attempt exceeded end time. Auto-submitting exam ${examId} for user ${userId}`);
            await autoSubmitExam(userId, examId);
            socket.emit("exam:autoSubmitted", {
              examId,
              message: "Exam auto-submitted due to time expiry",
            });
            return;
          }

          if (disconnectedAt) {
            const offlineSeconds = Math.floor((new Date(now).getTime() - new Date(disconnectedAt).getTime()) / 1000);

            console.log(`⏱️ Offline duration: ${offlineSeconds}s (grace ${graceSeconds}s)`);

            if (offlineSeconds > graceSeconds) {
              console.log(`🚨 Offline grace exceeded. Auto-submitting exam ${examId} for user ${userId}`);
              await autoSubmitExam(userId, examId);
              socket.emit("exam:autoSubmitted", {
                examId,
                message: "Exam auto-submitted due to disconnection",
              });
            } else {
              await pool.query(
                `
                UPDATE exam_attempts
                SET disconnected_at = NULL
                WHERE exam_id = $1 AND student_id = $2
                `,
                [examId, userId]
              );
              console.log(`✅ Reconnected within grace. Cleared disconnected_at.`);
            }
          } else {
            console.log(`✓ Exam ${examId} not yet submitted, continuing normally`);
          }
        } else {
          console.log(`⚠️ No attempt found for exam ${examId}, user ${userId}`);
        }
      } catch (err) {
        console.error("❌ Error checking exam status on reconnect:", err);
      }
    });

    /* =========================
       HANDLE DISCONNECT
    ========================= */
    socket.on("disconnect", async () => {
      console.log(`❌ User disconnected: ${socket.id}`);
      console.log(`📍 Socket data - userId: ${socket.userId}, examId: ${socket.examId}`);

      const userId = socket.userId;

      if (!userId) {
        console.log(`⚠️ Disconnect ignored - no userId`);
        return;
      }

      try {
        // Find ALL in-progress attempts for this user (not dependent on socket.examId)
        const { rows } = await pool.query(
          `
          SELECT exam_id FROM exam_attempts
          WHERE student_id = $1 AND status = 'in_progress' AND disconnected_at IS NULL
          `,
          [userId]
        );

        if (rows.length === 0) {
          console.log(`⚠️ No in-progress attempts found for user ${userId}`);
          return;
        }

        // Mark ALL in-progress attempts as disconnected
        for (const row of rows) {
          await pool.query(
            `
            UPDATE exam_attempts
            SET disconnected_at = NOW()
            WHERE exam_id = $1
            AND student_id = $2
            AND status = 'in_progress'
            `,
            [row.exam_id, userId]
          );
          console.log(`📝 Marked disconnected_at for user ${userId}, exam ${row.exam_id}`);
        }
      } catch (err) {
        console.error("❌ Disconnect handling error:", err);
        console.error(err.stack);
      }
    });

    socket.on("error", (err) => {
      console.error(`Socket error for ${socket.id}:`, err);
    });
  });

  console.log("✅ Socket.IO initialized");
  return io;
};

// Get Socket.IO instance
export const getIO = () => {
  if (!io) {
    console.warn("⚠️ Socket.IO not initialized yet");
  }
  return io;
};

// Emit notification to a specific user
export const emitNotificationToUser = (userId, notification) => {
  if (!io) {
    console.error("Socket.IO not initialized");
    return;
  }

  io.to(userId).emit("new_notification", {
    ...notification,
    timestamp: new Date().toISOString(),
  });

  console.log(`📤 Notification sent to user ${userId}`);
};

// Emit notification to multiple users
export const emitNotificationToUsers = (userIds, notification) => {
  if (!io) return;

  userIds.forEach((userId) => {
    emitNotificationToUser(userId, notification);
  });
};

// Broadcast notification
export const broadcastNotification = (notification) => {
  if (!io) return;

  io.emit("notification", {
    ...notification,
    timestamp: new Date().toISOString(),
  });

  console.log("📢 Broadcast notification");
};
