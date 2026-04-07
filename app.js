import https from "https";
import fs from "fs";
import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import pool from "./db/postgres.js";
import admin from "firebase-admin";
import { autoSubmitExam } from "./controllers/exams/exam.controller.js";

import authRoutes from "./routes/auth.routes.js";
import usersRoutes from "./routes/users.routes.js";
import managerRoutes from "./routes/manager.routes.js";
import coursesRoutes from "./routes/courses.routes.js";
import moduleRoutes from "./routes/module.routes.js";
import assignmentsRoutes from "./routes/assignments.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import studentCoursesRoutes from "./routes/studentCourses.routes.js";
import examRoutes from "./routes/exam.routes.js";
import studentExamRoutes from "./routes/studentExam.routes.js";
import uploadRoutes from "./routes/upload.routes.js";
import chatRoutes from "./routes/chat.routes.js";
import groupsRoutes from "./routes/group.routes.js";
import practiceRoutes from "./routes/practice.routes.js";
import proctoringRoutes from "./routes/proctoring.routes.js";
import notificationRoutes from "./routes/notification.routes.js";
import http from "http";
import { Server } from "socket.io";
import { initChatTables, serveFile } from "./controllers/chat.controller.js";
import botRoutes from "./routes/bot.routes.js";
import reviewroutes from "./routes/reviews.routes.js"
import certificateRoutes from "./routes/certificate.routes.js"
import contestRoutes from "./routes/contest.routes.js";
import contestQuestionRoutes from "./routes/contestQuestion.routes.js";
import contestAdvancedRoutes from "./routes/contestAdvanced.routes.js";
import { router as admingroupsRoutes } from "./routes/admingroups.routes.js";
import courseCommentsRoutes from "./routes/courseComments.routes.js";
import learningPathRoutes from "./routes/LearningPath.routes.js";
import mocktestRoutes from "./routes/mocktest.routes.js";
import { initializeDatabase } from "./db/dbInit.js";

// const express = require('express');


const app = express();

// 👇 Step 2: Add this BEFORE all your routes
app.use(
  cors({
    origin: function (origin, callback) {
      const s3Origin = 'http://vanshika-project-frontend.s3-website.eu-north-1.amazonaws.com';
      if (!origin || allowedOrigins.includes(origin) || origin === s3Origin) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);



//const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set("trust proxy", 1);
const server = http.createServer(app);
const baseUrl = process.env.BACKEND_URL;
const allowedOrigins = [
  "http://localhost:5173",
  process.env.FRONTEND_URL,
  "http://vanshika-project-frontend.s3-website.eu-north-1.amazonaws.com"
];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
  pingInterval: 5000,
  pingTimeout: 8000,
});
global.io = io;

/* =====================================
   🔐 SOCKET AUTH MIDDLEWARE
   Verify Firebase Token
===================================== */
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next();
    }

    const decoded = await admin.auth().verifyIdToken(token);

    const { rows } = await pool.query(
      `SELECT user_id FROM users WHERE firebase_uid = $1`,
      [decoded.uid]
    );

    if (!rows.length) {
      return next(new Error("User not found in database"));
    }

    socket.userId = rows[0].user_id;
    socket.firebaseUid = decoded.uid;
    next();
  } catch (err) {
    console.error("Socket authentication error:", err);
    next();
  }
});

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);

app.use(express.json());

// Log 401 errors to help debug unauthorized requests
app.use((req, res, next) => {
  const originalJson = res.json;
  const originalSendStatus = res.sendStatus;
  const originalSend = res.send;

  res.json = function(body) {
    if (res.statusCode === 401) {
      console.warn(`[401 UNAUTHORIZED] ${req.method} ${req.url} - IP: ${req.ip}`);
      console.warn(`Headers:`, req.headers);
    }
    return originalJson.call(this, body);
  };
  
  res.sendStatus = function(code) {
    if (code === 401) {
      console.warn(`[401 UNAUTHORIZED] ${req.method} ${req.url} - SendStatus`);
    }
    return originalSendStatus.call(this, code);
  };

  res.send = function(body) {
    if (res.statusCode === 401) {
      console.warn(`[401 UNAUTHORIZED] ${req.method} ${req.url} - Send`);
    }
    return originalSend.call(this, body);
  };

  next();
});

app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/manager", managerRoutes);
app.use("/api/courses", coursesRoutes);
app.use("/api", moduleRoutes);
app.use("/api/assignments", assignmentsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin/groups", groupsRoutes);
app.use("/api/student", studentCoursesRoutes);
app.use("/api/exams", examRoutes);
// Backward-compatible alias for older frontend routes
app.use("/api/exam", examRoutes);
app.use("/api/student/exams", studentExamRoutes);
app.use("/api/chats", chatRoutes);
app.use("/api/practice", practiceRoutes);
app.use("/api/proctoring", proctoringRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/bot", botRoutes);
app.use("/api/reviews", reviewroutes);
app.use("/api/certificate", certificateRoutes);
app.use("/api/contests", contestRoutes);
app.use("/api/contests", contestQuestionRoutes);
app.use("/api/contests", contestAdvancedRoutes);
app.use("/api/admingroups", admingroupsRoutes);
app.use("/api", courseCommentsRoutes);
app.use("/api/mocktest", mocktestRoutes);
app.use("/api/learning-paths", learningPathRoutes);

app.get("/", (req, res) => {
  res.send("API is running 🚀");
});

app.get("/api/chats/media/:id", serveFile);

const userSockets = new Map();

io.on("connection", (socket) => {
  console.log(`Socket Connected: ${socket.id}`);
  if (socket.userId) {
    console.log(`👤 Authenticated user: ${socket.userId}`);
  }

  socket.on("join_user", (userId) => {
    socket.join(`user_${userId}`);
    console.log(`User ${userId} joined room user_${userId}`);
  });

  /* =========================
     STUDENT STARTS EXAM
  ========================= */
  socket.on("exam:start", async ({ examId }) => {
    const userId = socket.userId;

    // 🔍 ATTEMPT-AWARE VIRTUAL ID RESOLUTION
    if (examId && examId.startsWith("final_")) {
      const courseId = examId.replace("final_", "");
      const { rows: resolvedExams } = await pool.query(
        `
        SELECT e.exam_id 
        FROM exams e
        LEFT JOIN exam_attempts ea ON ea.exam_id = e.exam_id AND ea.student_id = $2
        WHERE e.course_id = $1
        ORDER BY (ea.exam_id IS NOT NULL) DESC, e.created_at DESC
        LIMIT 1
        `,
        [courseId, userId]
      );
      if (resolvedExams.length) {
        console.log(`🔍 RESOLVED socket examId from ${examId} to ${resolvedExams[0].exam_id}`);
        examId = resolvedExams[0].exam_id;
      }
    }

    socket.examId = examId;

    console.log(`📝 User ${userId} started exam ${examId}`);
    console.log(`🔍 Checking disconnect state for user ${userId}, exam ${examId}`);

    if (!userId || !examId) {
      console.log(`⚠️ exam:start ignored - no userId or examId`);
      return;
    }

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

  socket.on("join_chat", (chatId) => {
    socket.join(`chat_${chatId}`);
    console.log(`Socket ${socket.id} joined chat_${chatId}`);
  });

  socket.on("join_group", (groupId) => {
    socket.join(`group_${groupId}`);
    console.log(`Socket ${socket.id} joined group_${groupId}`);
  });

  socket.on("send_message", async (data, callback) => {

    const {
      chatId,
      groupId,
      text,
      senderId,
      senderUid,
      senderName,
      recipientId,
      attachment_file_id,
      attachment_type,
      attachment_name,
      reply_to_message_id,
    } = data;

    try {
      // Handle GROUP messages
      if (groupId) {
        const groupCheck = await pool.query(
          'SELECT 1 FROM admin_groups WHERE group_id = $1',
          [groupId]
        );

        const isAdminGroup = groupCheck.rows.length > 0;

        let result;

        if (isAdminGroup) {
          // Admin group → admin_group_messages table
          result = await pool.query(
            `INSERT INTO admin_group_messages (
                group_id, sender_id, text,
                attachment_file_id, attachment_type, attachment_name
            )
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [
              groupId,
              senderId,
              text || "",
              attachment_file_id || null,
              attachment_type || null,
              attachment_name || null,
            ]
          );
        } else {
          // College group → messages table (where frontend reads from!)
          result = await pool.query(
            `INSERT INTO messages (
                group_id, sender_id, text,
                attachment_file_id, attachment_type, attachment_name,
                reply_to_message_id
            )
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
              groupId,
              senderId,
              text || "",
              attachment_file_id || null,
              attachment_type || null,
              attachment_name || null,
              reply_to_message_id || null,
            ]
          );
        }

        const savedMsg = result.rows[0];
        console.log(`✅ ${isAdminGroup ? 'Admin' : 'College'} group message saved:`, savedMsg);

        const payload = {
          ...savedMsg,
          text: savedMsg.text ?? savedMsg.message ?? text ?? "",
          sender_uid: senderUid,
          sender_name: senderName,
          attachment_url: savedMsg.attachment_file_id
            ? `${baseUrl}/api/chats/media/${savedMsg.attachment_file_id}`
            : null,
        };

        console.log(
          "📨 Broadcasting receive_message to group_" +
          groupId +
          " (excluding sender)",
        );
        socket.broadcast.to(`group_${groupId}`).emit("receive_message", payload);

        if (callback) callback(payload);

        // Notify all group members except sender
        const memberTable = isAdminGroup ? 'admin_group_members' : 'clg_group_members';
        const membersResult = await pool.query(
          `SELECT user_id FROM ${memberTable} WHERE group_id = $1 AND user_id != $2`,
          [groupId, senderId],
        );

        membersResult.rows.forEach((member) => {
          io.to(`user_${member.user_id}`).emit("new_notification", {
            group_id: groupId,
            sender_id: senderId,
            sender_name: senderName,
            text: text || "Sent an attachment",
            created_at: savedMsg.created_at,
          });
        });

        const groupTable = isAdminGroup ? 'admin_groups' : 'college_groups';
        await pool.query(
          `UPDATE ${groupTable} SET updated_at = NOW() WHERE group_id = $1`,
          [groupId],
        );
        console.log(
          `✅ ${isAdminGroup ? 'Admin' : 'College'} group message handling complete`,
        );
      }
      // Handle DM messages
      else if (chatId && recipientId) {
        const result = await pool.query(
          `INSERT INTO messages (
                chat_id, sender_id, receiver_id, text, 
                attachment_file_id, attachment_type, attachment_name,
                reply_to_message_id
            ) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
             RETURNING *`,
          [
            chatId,
            senderId,
            recipientId,
            text || "",
            attachment_file_id || null,
            attachment_type || null,
            attachment_name || null,
            reply_to_message_id || null,
          ],
        );
        const savedMsg = result.rows[0];
        console.log("✅ DM message saved to database:", savedMsg);

        const payload = {
          ...savedMsg,
          sender_uid: senderUid,
          sender_name: senderName,
          attachment_url: savedMsg.attachment_file_id
            ? `${baseUrl}/api/chats/media/${savedMsg.attachment_file_id}`
            : null,
        };

        console.log(
          "📨 Broadcasting receive_message to chat_" +
          chatId +
          " (excluding sender)",
        );
        socket.broadcast.to(`chat_${chatId}`).emit("receive_message", payload);

        if (callback) callback(payload);

        console.log("📨 Emitting new_notification to user_" + recipientId);
        io.to(`user_${recipientId}`).emit("new_notification", {
          chat_id: chatId,
          sender_id: senderId,
          sender_name: senderName,
          text: text || "Sent an attachment",
          created_at: savedMsg.created_at,
        });

        await pool.query(
          "UPDATE chats SET updated_at = NOW() WHERE chat_id = $1",
          [chatId],
        );
        console.log("✅ DM message handling complete");
      }
    } catch (err) {
      console.error("❌ Socket Message Error:", err);
    }
  });

  socket.on("disconnect", async () => {
    console.log("Socket Disconnected:", socket.id);

    const userId = socket.userId;

    if (userId) {
      console.log(`📍 Tracking disconnect for user: ${userId}`);
      try {
        const { rows } = await pool.query(
          `
          SELECT ea.exam_id, ea.end_time, e.disconnect_grace_time
          FROM exam_attempts ea
          JOIN exams e ON e.exam_id = ea.exam_id
          WHERE ea.student_id = $1 
          AND ea.status = 'in_progress' 
          AND ea.disconnected_at IS NULL
          AND NOW() < ea.end_time + (COALESCE(e.disconnect_grace_time, 0) * INTERVAL '1 second')
          `,
          [userId]
        );

        if (rows.length === 0) {
          console.log(`⚠️ No active in-progress attempts found for user ${userId}`);
        } else {
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
        }

        const { rows: expiredRows } = await pool.query(
          `
          SELECT ea.exam_id
          FROM exam_attempts ea
          JOIN exams e ON e.exam_id = ea.exam_id
          WHERE ea.student_id = $1 
          AND ea.status = 'in_progress'
          AND NOW() >= ea.end_time + (COALESCE(e.disconnect_grace_time, 0) * INTERVAL '1 second')
          `,
          [userId]
        );

        for (const row of expiredRows) {
          console.log(`🚨 Auto-submitting expired exam ${row.exam_id} for user ${userId} on disconnect`);
          await autoSubmitExam(userId, row.exam_id);
        }

      } catch (err) {
        console.error("❌ Disconnect handling error:", err);
        console.error(err.stack);
      }
    }
  });
});

app.use((err, req, res, next) => {
  console.error("❌ Error:", err.message);
  res.status(500).json({ message: "Internal server error" });
});

// REPLACE WITH:
const PORT = process.env.PORT || 443;
const HOST = process.env.HOST || "0.0.0.0";

const sslOptions = {
  key: fs.readFileSync(new URL('./privkey.pem', import.meta.url)),
  cert: fs.readFileSync(new URL('./fullchain.pem', import.meta.url)),
};

// Redirect HTTP (port 80) → HTTPS
http.createServer((req, res) => {
  res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
  res.end();
}).listen(process.env.HTTP_PORT || 80, () => {
  console.log(`🔁 HTTP redirect on port ${process.env.HTTP_PORT || 80}`);
}).on('error', (err) => {
  console.error("❌ HTTP redirect error:", err.message);
});

pool
  .query("SELECT NOW()")
  .then(async () => {
    console.log("✅ Database connected successfully");
    await initializeDatabase();
    await initChatTables();
    // Replace http server with https
    const httpsServer = https.createServer(sslOptions, app);
    // Reattach socket.io to the https server
    io.attach(httpsServer);
    httpsServer.listen(PORT, HOST, () => {
      console.log(`✅ HTTPS Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("❌ Database connection failed:", err.message);
    console.error("Please check your database credentials in .env");
    process.exit(1);
  });

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error);
});