

import pool from "../db/postgres.js";
import { uploadBufferToS3, removeLocalFileSafe } from "../services/s3Storage.service.js";

// Initialize Tables
export const initChatTables = async () => {
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto";');

    console.log("Initializing Chat Schemas...");

    // Files Table
    await pool.query(`
            CREATE TABLE IF NOT EXISTS files (
                file_id SERIAL PRIMARY KEY,
                filename TEXT NOT NULL,
                mime_type TEXT NOT NULL,
                data BYTEA NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

    // Groups Table
    await pool.query(`
            CREATE TABLE IF NOT EXISTS college_groups (
                group_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                college TEXT NOT NULL,
                creator_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
                meeting_link TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

    // Group Members Table
    await pool.query(`
            CREATE TABLE IF NOT EXISTS clg_group_members (
                group_id UUID REFERENCES college_groups(group_id) ON DELETE CASCADE,
                user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                role TEXT DEFAULT 'member',
                PRIMARY KEY (group_id, user_id)
            );
        `);

    // Chats Table (1-on-1)
    await pool.query(`
            CREATE TABLE IF NOT EXISTS chats (
                chat_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                instructor_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                student_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT unique_instructor_student_chat UNIQUE (instructor_id, student_id)
            );
        `);

    // Messages Table
    await pool.query(`
            CREATE TABLE IF NOT EXISTS messages (
                message_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                chat_id UUID REFERENCES chats(chat_id) ON DELETE CASCADE,
                group_id UUID REFERENCES college_groups(group_id) ON DELETE CASCADE,
                sender_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
                receiver_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                text TEXT NOT NULL,
                attachment_file_id INT REFERENCES files(file_id),
                attachment_type VARCHAR(50),
                attachment_name TEXT,
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT at_least_one_destination CHECK (chat_id IS NOT NULL OR group_id IS NOT NULL)
            );
        `);

    // Migration/Alter updates for existing tables
    const alterQueries = [
      "ALTER TABLE messages ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES college_groups(group_id) ON DELETE CASCADE",
      "ALTER TABLE messages ALTER COLUMN chat_id DROP NOT NULL",
      "ALTER TABLE messages ALTER COLUMN receiver_id DROP NOT NULL",
      "ALTER TABLE college_groups ADD COLUMN IF NOT EXISTS meeting_link TEXT",
      "ALTER TABLE college_groups ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
      "ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT FALSE",
      "ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE",
      "ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
      "ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id UUID REFERENCES messages(message_id) ON DELETE SET NULL",
      "ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS reply_to_message_id UUID REFERENCES group_messages(message_id) ON DELETE SET NULL",
      "ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE",
      "ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS is_edited BOOLEAN DEFAULT FALSE", 
      "ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP",
      "ALTER TABLE group_messages ADD COLUMN IF NOT EXISTS attachment_file_id INT REFERENCES files(file_id)",
      // S3 storage columns for files table
      "ALTER TABLE files ADD COLUMN IF NOT EXISTS s3_url TEXT",
      "ALTER TABLE files ADD COLUMN IF NOT EXISTS s3_object_path TEXT",
      "ALTER TABLE files ADD COLUMN IF NOT EXISTS file_size BIGINT",
      "ALTER TABLE files ALTER COLUMN data DROP NOT NULL",
    ];

    // Reactions Table
    await pool.query(`
            CREATE TABLE IF NOT EXISTS message_reactions (
                reaction_id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                message_id UUID REFERENCES messages(message_id) ON DELETE CASCADE,
                user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
                emoji TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (message_id, user_id)
            );
        `);

    for (const q of alterQueries) {
      try {
        await pool.query(q);
      } catch (e) {
        // Ignore if already changed or complex
      }
    }

    console.log("✅ Chat and Group tables initialized successfully");
  } catch (err) {
    console.error("❌ Error initializing chat tables:", err);
  }
};

// GET /api/chats
export const getMyChats = async (req, res) => {
  try {
    const userId = req.user.id;
    const query = `
            SELECT 
                c.chat_id,
                c.created_at,
                c.updated_at,
                u.full_name as recipient_name,
                u.user_id as recipient_id,
                u.firebase_uid as recipient_uid, 
                u.role as recipient_role,
                (
                    SELECT text FROM messages m 
                    WHERE m.chat_id = c.chat_id 
                    ORDER BY m.created_at DESC LIMIT 1
                ) as last_message,
                (
                    SELECT COUNT(*)::int FROM messages m 
                    WHERE m.chat_id = c.chat_id 
                    AND m.is_read = FALSE 
                    AND m.sender_id != $1
                ) as unread_count
            FROM chats c
            JOIN users u ON (
                CASE 
                    WHEN c.student_id = $1 THEN c.instructor_id 
                    ELSE c.student_id 
                END = u.user_id
            )
            WHERE c.student_id = $1 OR c.instructor_id = $1
            ORDER BY c.updated_at DESC;
        `;
    const result = await pool.query(query, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/chats Error:", err);
    res.status(500).json({ message: "Server Error", error: err.message });
  }
};

// POST /api/chats - Create a new 1-on-1 chat
export const createChat = async (req, res) => {
  try {
    const userId = req.user.id;
    const { recipientId } = req.body;

    if (!recipientId) {
      return res.status(400).json({ message: "recipientId is required" });
    }

    if (userId === recipientId) {
      return res.status(400).json({ message: "Cannot create chat with yourself" });
    }

    // Get user roles to determine instructor and student
    const userResult = await pool.query(
      "SELECT role FROM users WHERE user_id = $1",
      [userId]
    );
    const recipientResult = await pool.query(
      "SELECT role FROM users WHERE user_id = $1",
      [recipientId]
    );

    if (!userResult.rows[0] || !recipientResult.rows[0]) {
      return res.status(404).json({ message: "One or both users not found" });
    }

    const userRole = userResult.rows[0].role;
    const recipientRole = recipientResult.rows[0].role;

    // Determine instructor and student IDs
    let instructorId, studentId;
    if (userRole === "instructor" || userRole === "admin") {
      instructorId = userId;
      studentId = recipientId;
    } else {
      instructorId = recipientId;
      studentId = userId;
    }

    // Create or get existing chat
    const result = await pool.query(
      `
      INSERT INTO chats (instructor_id, student_id)
      VALUES ($1, $2)
      ON CONFLICT (instructor_id, student_id) 
      DO UPDATE SET updated_at = CURRENT_TIMESTAMP
      RETURNING chat_id, created_at, updated_at;
      `,
      [instructorId, studentId]
    );

    const chatId = result.rows[0].chat_id;

    // Get chat details with recipient info
    const chatDetails = await pool.query(
      `
      SELECT 
        c.chat_id,
        c.created_at,
        c.updated_at,
        u.full_name as recipient_name,
        u.user_id as recipient_id,
        u.firebase_uid as recipient_uid,
        u.role as recipient_role
      FROM chats c
      JOIN users u ON (
        CASE 
          WHEN c.student_id = $1 THEN c.instructor_id 
          ELSE c.student_id 
        END = u.user_id
      )
      WHERE c.chat_id = $2;
      `,
      [userId, chatId]
    );

    res.status(201).json(chatDetails.rows[0]);
  } catch (err) {
    console.error("POST /api/chats Error:", err);
    res.status(500).json({ message: "Server Error", error: err.message });
  }
};

// GET /api/chats/messages/:chatId
export const getMessages = async (req, res) => {
  try {
    const { chatId } = req.params;
    const result = await pool.query(
      `
            SELECT 
                m.*, 
                u.firebase_uid as sender_uid,
                u.full_name as sender_name, 
                u.photo_url as sender_photo,
                pm.text as parent_message_text,
                pu.full_name as parent_message_sender_name,
                (
                    SELECT json_agg(json_build_object('emoji', mr.emoji, 'user_id', mr.user_id, 'user_name', ru.full_name))
                    FROM message_reactions mr
                    JOIN users ru ON mr.user_id = ru.user_id
                    WHERE mr.message_id = m.message_id
                ) as reactions
            FROM messages m
            JOIN users u ON m.sender_id = u.user_id
            LEFT JOIN messages pm ON m.reply_to_message_id = pm.message_id
            LEFT JOIN users pu ON pm.sender_id = pu.user_id
            WHERE m.chat_id = $1
            ORDER BY m.created_at ASC
        `,
      [chatId],
    );

    const baseUrl = process.env.BACKEND_URL;
    const messages = result.rows.map((msg) => ({
      ...msg,
      attachment_url: msg.attachment_file_id
        ? `${baseUrl}/api/chats/media/${msg.attachment_file_id}`
        : null,
    }));

    res.json(messages);
  } catch (err) {
    console.error("getMessages Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};

// POST /api/chats (Start a new conversation)

// PUT /api/chats/read
export const markRead = async (req, res) => {
  try {
    const { chatId } = req.body;
    const userId = req.user.id;

    await pool.query(
      "UPDATE messages SET is_read = TRUE WHERE chat_id = $1 AND sender_id != $2",
      [chatId, userId],
    );
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ message: "Server Error" });
  }
};

// POST /api/files/upload
export const uploadFile = async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("No file uploaded");
    
    const { originalname, mimetype, buffer, size } = req.file;

    // Determine folder based on file type
    const ext = originalname.split('.').pop().toLowerCase();
    let folder = "chat-files";
    
    if (mimetype?.startsWith('image/')) {
      folder = "chat-images";
    } else if (mimetype === "application/pdf" || ext === "pdf") {
      folder = "chat-pdfs";
    } else if (mimetype?.startsWith('video/')) {
      folder = "chat-videos";
    }

    // Upload to S3
    const { url, objectPath } = await uploadBufferToS3(buffer, {
      originalName: originalname,
      mimeType: mimetype || "application/octet-stream",
      folder: folder,
    });

    // Store file metadata in database with S3 URL
    const newFile = await pool.query(
      `INSERT INTO files (filename, mime_type, s3_url, s3_object_path, file_size)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING file_id`,
      [originalname, mimetype, url, objectPath, size]
    );

    res.json({ 
      file_id: newFile.rows[0].file_id,
      url: url,
      objectPath: objectPath,
      filename: originalname,
      mimetype: mimetype,
      size: size
    });
  } catch (err) {
    console.error("Upload Error:", err);
    res.status(500).send("File upload failed");
  }
};

// GET /api/files/:id
export const serveFile = async (req, res) => {
  try {
    const { id } = req.params;
    const file = await pool.query(
      "SELECT file_id, filename, mime_type, s3_url FROM files WHERE file_id = $1", 
      [id]
    );

    if (file.rows.length === 0) return res.status(404).send("File not found");

    const { s3_url, filename, mime_type } = file.rows[0];

    // If S3 URL exists, redirect to S3 signed URL
    if (s3_url) {
      return res.redirect(s3_url);
    }

    // Fallback for legacy files stored in DB (if any)
    const legacyFile = await pool.query(
      "SELECT data FROM files WHERE file_id = $1", 
      [id]
    );

    if (legacyFile.rows[0]?.data) {
      res.setHeader("Content-Type", mime_type);
      res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
      return res.send(legacyFile.rows[0].data);
    }

    res.status(404).send("File not found");
  } catch (err) {
    console.error("File Serve Error:", err);
    res.status(500).send("Error serving file");
  }
};

// GET /api/chats/available-students (For Instructors)
export const getAvailableStudents = async (req, res) => {
  try {
    const userId = req.user.id;
    console.log("🔵 getAvailableStudents called for user:", userId);

    const query = `
            SELECT 
                u.user_id,
                u.full_name,
                u.email,
                u.firebase_uid,
                u.role,
                u.status,
                CASE 
                    WHEN c.chat_id IS NOT NULL THEN c.chat_id
                    ELSE NULL
                END as existing_chat_id
            FROM users u
            LEFT JOIN chats c ON (
                (c.student_id = u.user_id AND c.instructor_id = $1)
            )
            WHERE (LOWER(u.role) IN ('student', 'learner') OR u.role ILIKE 'student' OR u.role ILIKE 'learner')
            AND (u.status = 'active' OR u.status IS NULL)
            ORDER BY u.full_name ASC;
        `;
    const result = await pool.query(query, [userId]);
    console.log("🔵 Found students:", result.rows.length);
    console.log("🔵 Student data:", result.rows);
    
    if (result.rows.length === 0) {
      console.warn("⚠️ No students found. Checking database directly...");
      const allUsersCheck = await pool.query(
        "SELECT user_id, full_name, role, status FROM users LIMIT 10"
      );
      console.log("⚠️ Sample users from DB:", allUsersCheck.rows);
    }

    res.json(result.rows);
  } catch (err) {
    console.error("❌ GET /available-students Error:", err);
    res.status(500).json({ message: "Server Error", error: err.message });
  }
};

// GET /api/chats/available-instructors (For Students)
export const getAvailableInstructors = async (req, res) => {
  try {
    const userId = req.user.id;
    console.log("🔵 getAvailableInstructors called for user:", userId);

    const query = `
            SELECT 
                u.user_id,
                u.full_name,
                u.email,
                u.firebase_uid,
                u.role,
                u.status,
                CASE 
                    WHEN c.chat_id IS NOT NULL THEN c.chat_id
                    ELSE NULL
                END as existing_chat_id
            FROM users u
            LEFT JOIN chats c ON (
                (c.instructor_id = u.user_id AND c.student_id = $1)
            )
            WHERE (LOWER(u.role) IN ('instructor', 'company') OR u.role ILIKE 'instructor' OR u.role ILIKE 'company')
            AND (u.status = 'active' OR u.status IS NULL)
            ORDER BY u.full_name ASC;
        `;
    const result = await pool.query(query, [userId]);
    console.log("🔵 Found instructors:", result.rows.length);
    console.log("🔵 Instructor data:", result.rows);
    
    if (result.rows.length === 0) {
      console.warn("⚠️ No instructors found. Checking database directly...");
      const allUsersCheck = await pool.query(
        "SELECT user_id, full_name, role, status FROM users LIMIT 10"
      );
      console.log("⚠️ Sample users from DB:", allUsersCheck.rows);
    }

    res.json(result.rows);
  } catch (err) {
    console.error("❌ GET /available-instructors Error:", err);
    res.status(500).json({ message: "Server Error", error: err.message });
  }
};

// --- GROUP CONTROLLERS ---

// POST /api/chats/groups
export const createGroup = async (req, res) => {
  const client = await pool.connect();

  try {
    console.log("🔵 POST /api/chats/groups hit");
    console.log("🔵 User:", req.user);
    console.log("🔵 Body:", req.body);

    const name = String(req.body?.name || "").trim();
    const description = String(req.body?.description || "").trim();
    const userId = req.user.id;

    await client.query("BEGIN");

    if (!name) {
      console.error("❌ Group name is empty");
      await client.query("ROLLBACK");
      return res.status(400).json({
        message: "Group name is required.",
      });
    }

    // Get user's college
    const userRes = await client.query(
      "SELECT college FROM users WHERE user_id = $1",
      [userId],
    );
    
    console.log("🔵 User from DB:", userRes.rows[0]);

    const college = userRes.rows[0]?.college;

    if (!college) {
      console.error("❌ User has no college set");
      await client.query("ROLLBACK");
      return res.status(400).json({
        message: "Please set your college in profile settings first.",
      });
    }

    console.log("🔵 Creating group with:", { name, description, college, userId });

    const newGroup = await client.query(
      "INSERT INTO college_groups (name, description, college, creator_id) VALUES ($1, $2, $3, $4) RETURNING *",
      [name, description || null, college, userId],
    );

    const groupId = newGroup.rows[0].group_id;

    console.log("🔵 Group created:", groupId);

    // Add creator as admin
    await client.query(
      "INSERT INTO clg_group_members (group_id, user_id, role) VALUES ($1, $2, 'admin')",
      [groupId, userId],
    );

    await client.query("COMMIT");

    console.log("✅ Group with members created successfully");
    res.status(201).json({
      ...newGroup.rows[0],
      member_count: 1,
      last_message: null,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {
      // ignore rollback errors
    }
    console.error("❌ createGroup Error:", err);
    res.status(500).json({ message: "Server Error", error: err.message });
  } finally {
    client.release();
  }
};

// GET /api/chats/groups/my
export const getMyGroups = async (req, res) => {
  try {
    const userId = req.user.id;
const result = await pool.query(
  `
  SELECT 
    g.*,
    lm.text AS last_message,
    COUNT(gm2.user_id)::int AS member_count
  FROM college_groups g
  JOIN clg_group_members gm ON g.group_id = gm.group_id
  LEFT JOIN LATERAL (
    SELECT text
    FROM messages
    WHERE group_id = g.group_id
    ORDER BY created_at DESC
    LIMIT 1
  ) lm ON true
  LEFT JOIN clg_group_members gm2 ON gm2.group_id = g.group_id
  WHERE gm.user_id = $1
  GROUP BY g.group_id, lm.text
  ORDER BY g.created_at DESC
  `,
  [userId]
);


    res.json(result.rows);
  } catch (err) {
    console.error("getMyGroups Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};

// GET /api/chats/groups/available
export const getAvailableGroups = async (req, res) => {
  try {
    const userId = req?.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const userRes = await pool.query(
      "SELECT college FROM users WHERE user_id = $1",
      [userId],
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const college = userRes.rows[0].college;

    if (!college) {
      console.log(
        `[getAvailableGroups] User ${userId} has no college set. Returning empty list.`,
      );
      return res.json([]);
    }

    const result = await pool.query(
      `
            SELECT g.* FROM college_groups g
            WHERE g.college = $1
            AND g.group_id NOT IN (SELECT group_id FROM clg_group_members WHERE user_id = $2)
            ORDER BY g.created_at DESC
        `,
      [college, userId],
    );

    console.log(
      `[getAvailableGroups] Returning ${result.rows.length} groups for college ${college}`,
    );
    result.rows.forEach((r) =>
      console.log(`  - Group: ${r.name} ID: ${r.group_id}`),
    );

    res.json(result.rows);
  } catch (err) {
    console.error("getAvailableGroups Error:", err);
    res.status(500).json({ message: "Server Error", error: err.message });
  }
};

// POST /api/chats/groups/:groupId/join
export const joinGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req?.user?.id;

    if (!userId) {
      console.error("❌ joinGroup: No userId in request");
      return res.status(401).json({ message: "User session not found" });
    }

    if (!groupId) {
      console.error("❌ joinGroup: No groupId in params");
      return res.status(400).json({ message: "Group ID is required" });
    }

    console.log(`[JoinGroup] User:${userId} -> Group:${groupId}`);

    // 1. Fetch group info
    const groupRes = await pool.query(
      "SELECT college, name FROM college_groups WHERE group_id = $1",
      [groupId],
    );
    if (groupRes.rows.length === 0) {
      console.error(`❌ joinGroup: Group ${groupId} not found`);
      return res.status(404).json({ message: "Group not found" });
    }

    // 2. Fetch user info
    const userRes = await pool.query(
      "SELECT college FROM users WHERE user_id = $1",
      [userId],
    );
    if (userRes.rows.length === 0) {
      console.error(`❌ joinGroup: User ${userId} not found in DB`);
      return res.status(404).json({ message: "User not found" });
    }

    const groupCollege = groupRes.rows[0].college;
    const userCollege = userRes.rows[0].college;

    console.log(
      `[JoinGroup] Colleges - User:${userCollege || "NULL"} Group:${groupCollege}`,
    );

    // 3. Check college match
    if (groupCollege !== userCollege) {
      return res.status(403).json({
        message: `Privacy Violation: You belong to ${userCollege || "Unknown"}, but this group is for ${groupCollege}.`,
      });
    }

    // 4. Join
    await pool.query(
      "INSERT INTO clg_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [groupId, userId],
    );

    console.log(
      `✅ User ${userId} successfully joined ${groupRes.rows[0].name}`,
    );
    res.json({
      message: "Joined successfully",
      group_name: groupRes.rows[0].name,
    });
  } catch (err) {
    console.error("❌ joinGroup Critical Error:", err);
    res.status(500).json({
      message: "Failed to join group due to a server error",
      error: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};

// PUT /api/chats/groups/:groupId/meeting
export const updateMeetingLink = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { meetingLink } = req.body;
    const userId = req.user.id;

    const groupRes = await pool.query(
      "SELECT creator_id, name FROM college_groups WHERE group_id = $1",
      [groupId],
    );
    if (groupRes.rows.length === 0)
      return res.status(404).json({ message: "Group not found" });

    if (groupRes.rows[0].creator_id !== userId) {
      return res
        .status(403)
        .json({ message: "Only the group creator can start a meeting." });
    }

    await pool.query(
      "UPDATE college_groups SET meeting_link = $1, updated_at = NOW() WHERE group_id = $2",
      [meetingLink, groupId],
    );

    console.log(`🚀 Meeting started in ${groupRes.rows[0].name} by ${userId}`);
    res.json({ message: "Meeting started successfully", meetingLink });
  } catch (err) {
    console.error("updateMeetingLink Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};

// DELETE /api/chats/groups/:groupId/meeting
export const stopMeeting = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req?.user?.id;

    const groupRes = await pool.query(
      "SELECT creator_id, name FROM college_groups WHERE group_id = $1",
      [groupId],
    );
    if (groupRes.rows.length === 0)
      return res.status(404).json({ message: "Group not found" });

    if (groupRes.rows[0].creator_id !== userId) {
      return res
        .status(403)
        .json({ message: "Only the group creator can end the meeting." });
    }

    await pool.query(
      "UPDATE college_groups SET meeting_link = NULL, updated_at = NOW() WHERE group_id = $1",
      [groupId],
    );

    console.log(`🛑 Meeting ended in ${groupRes.rows[0].name} by ${userId}`);
    res.json({ message: "Meeting ended successfully" });
  } catch (err) {
    console.error("stopMeeting Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};

// GET /api/chats/groups/:groupId/messages
export const getGroupMessages = async (req, res) => {
  try {
    const { groupId } = req.params;

    // Pagination params
    const limit = Math.min(parseInt(req.query.limit) || 50, 100); // max 100
    const offset = parseInt(req.query.offset) || 0;

    const result = await pool.query(
      `
      SELECT 
        m.*,
        m.text,
        u.firebase_uid as sender_uid,
        u.full_name as sender_name, 
        u.photo_url as sender_photo,
        pm.text as parent_message_text,
        pu.full_name as parent_message_sender_name,
        (
          SELECT json_agg(
            json_build_object(
              'emoji', mr.emoji,
              'user_id', mr.user_id,
              'user_name', ru.full_name
            )
          )
          FROM message_reactions mr
          JOIN users ru ON mr.user_id = ru.user_id
          WHERE mr.message_id = m.message_id
        ) as reactions
      FROM messages m
      JOIN users u ON m.sender_id = u.user_id
      LEFT JOIN messages pm ON m.reply_to_message_id = pm.message_id
      LEFT JOIN users pu ON pm.sender_id = pu.user_id
      WHERE m.group_id = $1
      ORDER BY m.created_at ASC
      LIMIT $2 OFFSET $3
      `,
      [groupId, limit, offset]
    );

    const baseUrl = process.env.BACKEND_URL;

    const messages = result.rows.map((msg) => ({
      ...msg,
      attachment_url: msg.attachment_file_id
        ? `${baseUrl}/api/chats/media/${msg.attachment_file_id}`
        : null,
    }));

    res.json(messages);
  } catch (err) {
    console.error("getGroupMessages Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};

// PUT /api/chats/messages/:messageId
export const editMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { text } = req.body;
    const userId = req.user.id;

    if (!text) return res.status(400).json({ message: "Text is required" });

    let tableName = "messages";
    let msgInfo = await pool.query(
      "SELECT message_id, group_id, chat_id, sender_id FROM messages WHERE message_id = $1",
      [messageId],
    );

    if (msgInfo.rows.length === 0) {
      tableName = "group_messages";
      msgInfo = await pool.query(
        "SELECT message_id, group_id, sender_id FROM group_messages WHERE message_id = $1",
        [messageId],
      );
    }

    if (msgInfo.rows.length === 0) {
      return res.status(404).json({ message: "Message not found" });
    }

    const msgMeta = msgInfo.rows[0];

    if (msgMeta.sender_id !== userId) {
      return res.status(403).json({ message: "Unauthorized to edit this message" });
    }

    const messageColumn = tableName === "group_messages" ? "message" : "text";

    const result = await pool.query(
      `UPDATE ${tableName}
             SET ${messageColumn} = $1, is_edited = TRUE, updated_at = NOW()
             WHERE message_id = $2 AND sender_id = $3 AND is_deleted = FALSE
             RETURNING *`,
      [text, messageId, userId],
    );

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ message: "Message not found or unauthorized" });
    }

    const msg = result.rows[0];

    // Fetch sender details for the socket payload
    const userRes = await pool.query(
      "SELECT full_name, firebase_uid FROM users WHERE user_id = $1",
      [userId],
    );
    const sender = userRes.rows[0];

    const payload = {
      ...msg,
      sender_name: sender.full_name,
      sender_uid: sender.firebase_uid,
    };

    if (msg.group_id) {
      req.io.to(`group_${msg.group_id}`).emit("edit_message", payload);
    } else if (msg.chat_id) {
      req.io.to(`chat_${msg.chat_id}`).emit("edit_message", payload);
    }

    res.json(payload);
  } catch (err) {
    console.error("editMessage Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};

// DELETE /api/chats/messages/:messageId
export const deleteMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;
    const userRole = req.user.role; // Assuming role is available on req.user

    // Check if message exists (DMs + group messages)
    let tableName = "messages";
    let check = await pool.query(
      "SELECT sender_id, group_id, chat_id FROM messages WHERE message_id = $1",
      [messageId],
    );

    if (check.rows.length === 0) {
      tableName = "group_messages";
      check = await pool.query(
        "SELECT sender_id, group_id FROM group_messages WHERE message_id = $1",
        [messageId],
      );
    }

    if (check.rows.length === 0) {
      return res.status(404).json({ message: "Message not found" });
    }

    const msg = check.rows[0];

    // Permission check: Owner or Admin
    if (msg.sender_id !== userId && userRole !== "admin") {
      return res
        .status(403)
        .json({ message: "Unauthorized to delete this message" });
    }

    // Soft delete
    const messageColumn = tableName === "group_messages" ? "message" : "text";

    const result = await pool.query(
      `UPDATE ${tableName}
             SET is_deleted = TRUE, ${messageColumn} = 'This message was deleted', attachment_file_id = NULL, updated_at = NOW()
             WHERE message_id = $1
             RETURNING *`,
      [messageId],
    );

    const deletedMsg = result.rows[0];

    if (deletedMsg.group_id) {
      req.io
        .to(`group_${deletedMsg.group_id}`)
        .emit("delete_message", { messageId, is_deleted: true });
    } else if (deletedMsg.chat_id) {
      req.io
        .to(`chat_${deletedMsg.chat_id}`)
        .emit("delete_message", { messageId, is_deleted: true });
    }

    res.json({ message: "Message deleted", id: messageId });
  } catch (err) {
    console.error("deleteMessage Error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};

export const getGroupMembers = async (req, res) => {
  try {
    const { groupId } = req.params;
    console.log(`[getGroupMembers] Fetching members for group: ${groupId}`);

    const result = await pool.query(
      `
            SELECT u.user_id as id, u.full_name as name, u.role as global_role, gm.role as group_role, u.photo_url, u.email 
            FROM clg_group_members gm 
            JOIN users u ON gm.user_id = u.user_id 
            WHERE gm.group_id = $1
            ORDER BY u.full_name ASC
        `,
      [groupId],
    );

    console.log(`[getGroupMembers] Found ${result.rows.length} members`);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching members:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

export const updateGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const { name, description } = req.body;
    const userId = req.user.id;

    console.log(
      `[updateGroup] User ${userId} attempting to update group ${groupId}`,
    );
    console.log(`[updateGroup] Payload:`, { name, description });

    // Check if user is admin
    const memberCheck = await pool.query(
      "SELECT role FROM clg_group_members WHERE group_id = $1 AND user_id = $2",
      [groupId, userId],
    );

    if (memberCheck.rowCount === 0 || memberCheck.rows[0].role !== "admin") {
      console.warn(
        `[updateGroup] Permission denied for user ${userId} on group ${groupId}`,
      );
      return res
        .status(403)
        .json({ message: "Only group admins can edit details" });
    }

    const result = await pool.query(
      "UPDATE college_groups SET name = $1, description = $2 WHERE group_id = $3 RETURNING *",
      [name, description, groupId],
    );

    if (result.rowCount === 0) {
      console.error(`[updateGroup] Group ${groupId} not found for update`);
      return res.status(404).json({ message: "Group not found" });
    }

    const updatedGroup = result.rows[0];
    console.log(`[updateGroup] Success:`, updatedGroup);

    // Notify members via socket
    if (req.io) {
      req.io.to(`group_${groupId}`).emit("group_updated", updatedGroup);
    }

    res.json(updatedGroup);
  } catch (err) {
    console.error("Error updating group:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};

export const leaveGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.id;

    // Get member info
    const memberRes = await pool.query(
      "SELECT role FROM clg_group_members WHERE group_id = $1 AND user_id = $2",
      [groupId, userId],
    );

    if (memberRes.rowCount === 0) {
      return res
        .status(404)
        .json({ message: "You are not a member of this group" });
    }

    const userRole = memberRes.rows[0].role;

    // If admin, check if there are other admins
    if (userRole === "admin") {
      const adminCountRes = await pool.query(
        "SELECT COUNT(*) FROM clg_group_members WHERE group_id = $1 AND role = 'admin'",
        [groupId],
      );
      const adminCount = parseInt(adminCountRes.rows[0].count);

      if (adminCount === 1) {
        // Last admin. check if there are other members at all.
        const totalMembersRes = await pool.query(
          "SELECT COUNT(*) FROM clg_group_members WHERE group_id = $1",
          [groupId],
        );
        const totalMembers = parseInt(totalMembersRes.rows[0].count);

        if (totalMembers > 1) {
          return res.status(400).json({
            message:
              "As the only admin, you must promote another member to admin before leaving, or delete the group.",
          });
        } else {
          // Last person in group. Just delete group.
          await pool.query("DELETE FROM college_groups WHERE group_id = $1", [groupId]);
          return res.json({
            message: "Left and deleted group as you were the last member.",
          });
        }
      }
    }

    // Standard leave
    await pool.query(
      "DELETE FROM clg_group_members WHERE group_id = $1 AND user_id = $2",
      [groupId, userId],
    );

    res.json({ message: "Successfully left the group" });
  } catch (err) {
    console.error("leaveGroup error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const deleteGroup = async (req, res) => {
  try {
    const { groupId } = req.params;
    const userId = req.user.id;

    // Check if user is admin
    const memberRes = await pool.query(
      "SELECT role FROM clg_group_members WHERE group_id = $1 AND user_id = $2",
      [groupId, userId],
    );

    if (memberRes.rowCount === 0 || memberRes.rows[0].role !== "admin") {
      return res
        .status(403)
        .json({ message: "Only group admins can delete the group" });
    }

    // Delete group (cascade will handle members and messages)
    await pool.query("DELETE FROM college_groups WHERE group_id = $1", [groupId]);

    if (req.io) {
      req.io.to(`group_${groupId}`).emit("group_deleted", { groupId });
    }

    res.json({ message: "Group deleted successfully" });
  } catch (err) {
    console.error("deleteGroup error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const promoteToAdmin = async (req, res) => {
  try {
    const { groupId, userId } = req.params;
    const requesterId = req.user.id;

    // Check if requester is admin
    const memberRes = await pool.query(
      "SELECT role FROM clg_group_members WHERE group_id = $1 AND user_id = $2",
      [groupId, requesterId],
    );

    if (memberRes.rowCount === 0 || memberRes.rows[0].role !== "admin") {
      return res
        .status(403)
        .json({ message: "Only group admins can promote others" });
    }

    await pool.query(
      "UPDATE clg_group_members SET role = 'admin' WHERE group_id = $1 AND user_id = $2",
      [groupId, userId],
    );

    res.json({ message: "Member promoted to admin" });
  } catch (err) {
    console.error("promoteToAdmin error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const removeMember = async (req, res) => {
  try {
    const { groupId, userId } = req.params;
    const requesterId = req.user.id;

    // Cannot remove self via this endpoint (use leaveGroup)
    if (userId === requesterId) {
      return res
        .status(400)
        .json({ message: "Use leaveGroup to exit the group yourself" });
    }

    // Check if requester is admin
    const requesterRes = await pool.query(
      "SELECT role FROM clg_group_members WHERE group_id = $1 AND user_id = $2",
      [groupId, requesterId],
    );

    if (requesterRes.rowCount === 0 || requesterRes.rows[0].role !== "admin") {
      return res
        .status(403)
        .json({ message: "Only group admins can remove members" });
    }

    // Check if target is admin (usually admins shouldn't remove other admins depending on policy, but WhatsApp lets you remove any member)
    // We'll allow removing anyone except yourself.

    await pool.query(
      "DELETE FROM clg_group_members WHERE group_id = $1 AND user_id = $2",
      [groupId, userId],
    );

    // Notify target via socket
    if (req.io) {
      req.io.to(`user_${userId}`).emit("removed_from_group", { groupId });
    }

    res.json({ message: "Member removed successfully" });
  } catch (err) {
    console.error("removeMember error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const addReaction = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    const userId = req.user.id;

    console.log(
      `👍 Adding reaction: ${emoji} to message: ${messageId} by user: ${userId}`,
    );

    await pool.query(
      `
            INSERT INTO message_reactions (message_id, user_id, emoji)
            VALUES ($1, $2, $3)
            ON CONFLICT (message_id, user_id) 
            DO UPDATE SET emoji = $3, created_at = CURRENT_TIMESTAMP
        `,
      [messageId, userId, emoji],
    );

    const result = await pool.query(
      `
            SELECT mr.emoji, mr.user_id, u.full_name as user_name
            FROM message_reactions mr
            JOIN users u ON mr.user_id = u.user_id
            WHERE mr.message_id = $1
        `,
      [messageId],
    );

    if (req.io) {
      // Find if group or private chat
      let msgInfo = await pool.query(
        "SELECT group_id, chat_id FROM messages WHERE message_id = $1",
        [messageId],
      );

      if (msgInfo.rowCount === 0) {
        msgInfo = await pool.query(
          "SELECT group_id FROM group_messages WHERE message_id = $1",
          [messageId],
        );
      }

      if (msgInfo.rowCount > 0) {
        const { group_id, chat_id } = msgInfo.rows[0];
        const room = group_id ? `group_${group_id}` : `chat_${chat_id}`;
        req.io.to(room).emit("message_reaction_updated", {
          messageId,
          reactions: result.rows,
        });
      }
    }

    res.json({ message: "Reaction updated", reactions: result.rows });
  } catch (err) {
    console.error("addReaction error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

export const removeReaction = async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    console.log(
      `👎 Removing reaction from message: ${messageId} by user: ${userId}`,
    );

    await pool.query(
      "DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2",
      [messageId, userId],
    );

    const result = await pool.query(
      `
            SELECT mr.emoji, mr.user_id, u.full_name as user_name
            FROM message_reactions mr
            JOIN users u ON mr.user_id = u.user_id
            WHERE mr.message_id = $1
        `,
      [messageId],
    );

    if (req.io) {
      let msgInfo = await pool.query(
        "SELECT group_id, chat_id FROM messages WHERE message_id = $1",
        [messageId],
      );

      if (msgInfo.rowCount === 0) {
        msgInfo = await pool.query(
          "SELECT group_id FROM group_messages WHERE message_id = $1",
          [messageId],
        );
      }

      if (msgInfo.rowCount > 0) {
        const { group_id, chat_id } = msgInfo.rows[0];
        const room = group_id ? `group_${group_id}` : `chat_${chat_id}`;
        req.io.to(room).emit("message_reaction_updated", {
          messageId,
          reactions: result.rows,
        });
      }
    }

    res.json({ message: "Reaction removed", reactions: result.rows });
  } catch (err) {
    console.error("removeReaction error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// GET /api/chats/search?query=<search_term>
export const searchMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { query } = req.query;

    if (!query || query.trim().length === 0) {
      return res.json([]);
    }

    const searchTerm = `%${query}%`;

    // ✅ FIX: JOIN both sides of the chat so other_user_name is never NULL
    const dmResults = await pool.query(
      `
      SELECT 
        m.message_id,
        m.chat_id,
        m.text as message_text,
        m.sender_id,
        m.created_at,
        m.is_deleted,
        sender.full_name as sender_name,
        sender.photo_url as sender_photo,
        c.student_id,
        c.instructor_id,
        -- ✅ FIX: derive other_user from chat participants, not receiver_id
        CASE 
          WHEN c.student_id = $1 THEN instructor.full_name
          ELSE student.full_name
        END as other_user_name,
        CASE 
          WHEN c.student_id = $1 THEN c.instructor_id
          ELSE c.student_id
        END as other_user_id,
        'dm' as type
      FROM messages m
      JOIN chats c ON m.chat_id = c.chat_id
      JOIN users sender   ON m.sender_id      = sender.user_id
      JOIN users student  ON c.student_id     = student.user_id    -- ✅ always resolves
      JOIN users instructor ON c.instructor_id = instructor.user_id -- ✅ always resolves
      WHERE (c.student_id = $1 OR c.instructor_id = $1)
        AND m.text ILIKE $2
        AND (m.is_deleted = FALSE OR m.is_deleted IS NULL)
      ORDER BY m.created_at DESC
      LIMIT 50
      `,
      [userId, searchTerm]
    );

    // Group search - updated to use messages table
    const groupResults = await pool.query(
      `
      SELECT 
        m.message_id,
        m.group_id,
        m.text as message_text,
        m.sender_id,
        NULL as receiver_id,
        m.created_at,
        m.is_deleted,
        sender.full_name as sender_name,
        sender.photo_url as sender_photo,
        cg.name as other_user_name,
        cg.name as group_name,
        'group' as type
      FROM messages m
      JOIN college_groups cg ON m.group_id = cg.group_id
      JOIN clg_group_members cgm ON cg.group_id = cgm.group_id AND cgm.user_id = $1
      JOIN users sender ON m.sender_id = sender.user_id
      WHERE m.group_id IS NOT NULL
        AND m.text ILIKE $2
        AND (m.is_deleted = FALSE OR m.is_deleted IS NULL)
      ORDER BY m.created_at DESC
      LIMIT 50
      `,
      [userId, searchTerm]
    );

    const format = (row) => ({
      ...row,
      display_date: new Date(row.created_at).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric'
      }),
      display_time: new Date(row.created_at).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit'
      }),
    });

    const results = [
      ...dmResults.rows.map(format),
      ...groupResults.rows.map(format),
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json(results);
  } catch (err) {
    console.error("searchMessages Error:", err);
    res.status(500).json({ message: "Server Error", error: err.message });
  }
};

export const getAvailableAdmins = async (req, res) => {
    try {
        const userId = req.user.id;
        const query = `
            SELECT 
                u.user_id,
                u.full_name,
                u.email,
                u.firebase_uid,
                CASE 
                    WHEN c.chat_id IS NOT NULL THEN c.chat_id
                    ELSE NULL
                END as existing_chat_id
            FROM users u
            LEFT JOIN chats c ON (
                (c.participant1 = u.user_id AND c.participant2 = $1)
                OR (c.participant1 = $1 AND c.participant2 = u.user_id)
            )
            WHERE u.role = 'admin' 
              AND u.status = 'active'
            ORDER BY u.full_name ASC;
        `;
        const result = await pool.query(query, [userId]);
        res.json(result.rows);
    } catch (err) {
        console.error("GET /available-admins Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
};

export const searchContacts = async (req, res) => {
  try {
    const userId = req.user.id;
    const { query } = req.query;

    console.log("🔍 searchContacts called:", { userId, query });

    if (!query || query.trim().length === 0) {
      return res.json({ users: [], groups: [] });
    }

    const searchTerm = `%${query.trim()}%`;

    const userRes = await pool.query(
      "SELECT role, college FROM users WHERE user_id = $1",
      [userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    const { role, college } = userRes.rows[0];
    const isAdmin = role?.toLowerCase() === 'admin';
    const isStudent = role?.toLowerCase() === 'student';
    const isManager = role?.toLowerCase() === 'manager';

    console.log("🔍 role:", role, "| college:", college);

    // Search users (skip entirely for admin)
    let usersResult = { rows: [] };

    if (!isAdmin) {
      // For managers, search for admins
      // For students, search for instructors
      // For others, search for students
      let targetRoles = ['student'];
      
      if (isStudent) {
        targetRoles = ['instructor'];
      } else if (isManager) {
        targetRoles = ['admin'];
      }

      usersResult = await pool.query(
        `
        SELECT 
          u.user_id,
          u.full_name AS name,
          u.email,
          u.firebase_uid,
          u.photo_url,
          u.role,
          CASE 
            WHEN c.chat_id IS NOT NULL THEN c.chat_id 
            ELSE NULL 
          END AS existing_chat_id,
          'user' AS type
        FROM users u
        LEFT JOIN chats c ON (
          (c.student_id = u.user_id AND c.instructor_id = $1)
          OR (c.instructor_id = u.user_id AND c.student_id = $1)
        )
        WHERE LOWER(u.role) = ANY($2::text[])
          AND u.status = 'active'
          AND u.user_id != $1
          AND u.full_name ILIKE $3
        ORDER BY u.full_name ASC
        LIMIT 20
        `,
        [userId, targetRoles, searchTerm]
      );

      console.log("🔍 Users found:", usersResult.rows.length);
    }

    // Search groups
    let groupsResult = { rows: [] };

    if (isAdmin) {
      // Admin: search admin_groups where they are creator OR a member
      groupsResult = await pool.query(
        `
        SELECT
          ag.group_id AS id,
          ag.name,
          ag.description,
          ag.purpose,
          ag.created_at,
          ag.admin_id,
          NULL AS college,
          'group' AS type,
          TRUE AS is_member,
          COUNT(agm_all.user_id) AS member_count
        FROM admin_groups ag
        LEFT JOIN admin_group_members agm
          ON ag.group_id = agm.group_id AND agm.user_id = $1
        LEFT JOIN admin_group_members agm_all
          ON ag.group_id = agm_all.group_id
        WHERE ag.name ILIKE $2
          AND (agm.user_id IS NOT NULL OR ag.admin_id = $1)
        GROUP BY ag.group_id
        ORDER BY ag.name ASC
        LIMIT 20
        `,
        [userId, searchTerm]
      );
      console.log("🔍 Admin groups found:", groupsResult.rows.length);

    } else if (college) {
      // Student/Instructor: search college_groups by college
      groupsResult = await pool.query(
        `
        SELECT DISTINCT
          cg.group_id AS id,
          cg.name,
          cg.description,
          cg.college,
          'group' AS type,
          CASE WHEN gm.user_id IS NOT NULL THEN TRUE ELSE FALSE END AS is_member
        FROM college_groups cg
        LEFT JOIN clg_group_members gm 
          ON cg.group_id = gm.group_id AND gm.user_id = $1
        WHERE cg.college = $2
          AND cg.name ILIKE $3
        ORDER BY cg.name ASC
        LIMIT 20
        `,
        [userId, college, searchTerm]
      );
      console.log("🔍 College groups found:", groupsResult.rows.length);

    } else {
      console.log("🔍 No college set — skipping group search");
    }

    res.json({
      users: usersResult.rows,
      groups: groupsResult.rows,
    });

  } catch (err) {
    console.error("❌ searchContacts Error:", err.message);
    console.error(err.stack);
    res.status(500).json({ message: "Server Error", error: err.message });
  }
};
