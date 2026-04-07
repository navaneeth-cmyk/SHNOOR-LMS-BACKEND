import pool from "../db/postgres.js";

const isValidVoteType = (voteType) => [1, -1, 0].includes(Number(voteType));
const isUuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

// Get all comments for a course
export const getCourseComments = async (req, res) => {
  try {
    const { courseId } = req.params;
    const userId = req.user?.id;
    if (!courseId || !isUuid(courseId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid courseId",
      });
    }

    const { rows } = await pool.query(
      `
      SELECT 
        cc.comment_id,
        cc.comment_text,
        cc.created_at,
        cc.updated_at,
        cc.user_id,
        cc.parent_comment_id,
        u.full_name as user_name,
        u.role,
        COALESCE(SUM(CASE WHEN cv.vote_type = 1 THEN 1 ELSE 0 END), 0)::int as upvotes,
        COALESCE(SUM(CASE WHEN cv.vote_type = -1 THEN 1 ELSE 0 END), 0)::int as downvotes,
        COALESCE(SUM(cv.vote_type), 0)::int as vote_score,
        MAX(CASE WHEN cv.user_id = $2 THEN cv.vote_type ELSE NULL END) as user_vote,
        (SELECT COUNT(*)::int FROM course_comments WHERE parent_comment_id = cc.comment_id) as reply_count
      FROM course_comments cc
      JOIN users u ON cc.user_id = u.user_id
      LEFT JOIN comment_votes cv ON cc.comment_id = cv.comment_id
      WHERE cc.course_id = $1
      GROUP BY cc.comment_id, cc.comment_text, cc.created_at, cc.updated_at, cc.user_id, cc.parent_comment_id, u.full_name, u.role
      ORDER BY cc.created_at DESC
      `,
      [courseId, userId]
    );

    res.json({
      success: true,
      comments: rows
    });
  } catch (err) {
    console.error("Get course comments error:", err);
    res.status(500).json({ 
      success: false,
      message: "Failed to fetch comments", 
      error: err.message 
    });
  }
};

// Add a new comment
export const addCourseComment = async (req, res) => {
  try {
    const { courseId } = req.params;
    const { comment_text, parent_comment_id } = req.body;
    const user_id = req.user.id;
    if (!courseId || !isUuid(courseId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid courseId",
      });
    }
    if (parent_comment_id && !isUuid(parent_comment_id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid parent_comment_id",
      });
    }

    if (!comment_text || comment_text.trim().length === 0) {
      return res.status(400).json({ 
        success: false,
        message: "Comment text is required" 
      });
    }

    const { rows } = await pool.query(
      `
      INSERT INTO course_comments (course_id, user_id, comment_text, parent_comment_id, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
      RETURNING 
        comment_id,
        comment_text,
        created_at,
        updated_at,
        user_id,
        parent_comment_id
      `,
      [courseId, user_id, comment_text.trim(), parent_comment_id || null]
    );

    // Get user details
    const { rows: userRows } = await pool.query(
      `SELECT full_name, role FROM users WHERE user_id = $1`,
      [user_id]
    );

    const comment = {
      ...rows[0],
      user_name: userRows[0].full_name,
      role: userRows[0].role,
      upvotes: 0,
      downvotes: 0,
      vote_score: 0,
      user_vote: null,
      reply_count: 0
    };

    res.status(201).json({
      success: true,
      comment
    });
  } catch (err) {
    console.error("Add course comment error:", err);
    res.status(500).json({ 
      success: false,
      message: "Failed to add comment", 
      error: err.message 
    });
  }
};

// Update a comment
export const updateCourseComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const { comment_text } = req.body;
    const user_id = req.user.id;
    if (!commentId || !isUuid(commentId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid commentId",
      });
    }

    if (!comment_text || comment_text.trim().length === 0) {
      return res.status(400).json({ 
        success: false,
        message: "Comment text is required" 
      });
    }

    // Check if user owns the comment
    const { rows: checkRows } = await pool.query(
      `SELECT user_id FROM course_comments WHERE comment_id = $1`,
      [commentId]
    );

    if (checkRows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: "Comment not found" 
      });
    }

    if (checkRows[0].user_id !== user_id) {
      return res.status(403).json({ 
        success: false,
        message: "You can only edit your own comments" 
      });
    }

    const { rows } = await pool.query(
      `
      UPDATE course_comments
      SET comment_text = $1, updated_at = NOW()
      WHERE comment_id = $2
      RETURNING 
        comment_id,
        comment_text,
        created_at,
        updated_at,
        user_id
      `,
      [comment_text.trim(), commentId]
    );

    // Get user details
    const { rows: userRows } = await pool.query(
      `SELECT full_name, role FROM users WHERE user_id = $1`,
      [user_id]
    );

    const comment = {
      ...rows[0],
      user_name: userRows[0].full_name,
      role: userRows[0].role,
    };

    res.json({
      success: true,
      comment
    });
  } catch (err) {
    console.error("Update course comment error:", err);
    res.status(500).json({ 
      success: false,
      message: "Failed to update comment", 
      error: err.message 
    });
  }
};

// Delete a comment
export const deleteCourseComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const user_id = req.user.id;
    if (!commentId || !isUuid(commentId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid commentId",
      });
    }

    // Check if user owns the comment
    const { rows: checkRows } = await pool.query(
      `SELECT user_id FROM course_comments WHERE comment_id = $1`,
      [commentId]
    );

    if (checkRows.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: "Comment not found" 
      });
    }

    if (checkRows[0].user_id !== user_id) {
      return res.status(403).json({ 
        success: false,
        message: "You can only delete your own comments" 
      });
    }

    await pool.query(
      `DELETE FROM course_comments WHERE comment_id = $1`,
      [commentId]
    );

    res.json({ 
      success: true,
      message: "Comment deleted successfully" 
    });
  } catch (err) {
    console.error("Delete course comment error:", err);
    res.status(500).json({ 
      success: false,
      message: "Failed to delete comment", 
      error: err.message 
    });
  }
};

// Vote on a comment
export const voteComment = async (req, res) => {
  try {
    const { commentId } = req.params;
    const { vote_type } = req.body; // 1 for upvote, -1 for downvote, 0 to remove vote
    const user_id = req.user.id;
    if (!commentId || !isUuid(commentId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid commentId",
      });
    }

    // Validate vote_type
    if (!isValidVoteType(vote_type)) {
      return res.status(400).json({
        success: false,
        message: "Invalid vote type. Use 1 for upvote, -1 for downvote, 0 to remove"
      });
    }

    // Check if comment exists and user is not voting on their own comment
    const { rows: commentRows } = await pool.query(
      `SELECT user_id FROM course_comments WHERE comment_id = $1`,
      [commentId]
    );

    if (commentRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Comment not found"
      });
    }

    if (commentRows[0].user_id === user_id) {
      return res.status(403).json({
        success: false,
        message: "You cannot vote on your own comment"
      });
    }

    // Remove vote if vote_type is 0
    if (vote_type === 0) {
      await pool.query(
        `DELETE FROM comment_votes WHERE comment_id = $1 AND user_id = $2`,
        [commentId, user_id]
      );
    } else {
      // Insert or update vote
      await pool.query(
        `
        INSERT INTO comment_votes (comment_id, user_id, vote_type)
        VALUES ($1, $2, $3)
        ON CONFLICT (comment_id, user_id)
        DO UPDATE SET vote_type = $3, created_at = NOW()
        `,
        [commentId, user_id, Number(vote_type)]
      );
    }

    // Get updated vote counts
    const { rows } = await pool.query(
      `
      SELECT 
        COALESCE(SUM(CASE WHEN vote_type = 1 THEN 1 ELSE 0 END), 0)::int as upvotes,
        COALESCE(SUM(CASE WHEN vote_type = -1 THEN 1 ELSE 0 END), 0)::int as downvotes,
        COALESCE(SUM(vote_type), 0)::int as vote_score
      FROM comment_votes
      WHERE comment_id = $1
      `,
      [commentId]
    );

    res.json({
      success: true,
      vote_data: {
        ...rows[0],
        user_vote: Number(vote_type) === 0 ? null : Number(vote_type)
      }
    });
  } catch (err) {
    console.error("Vote comment error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to vote on comment",
      error: err.message
    });
  }
};