import pool from "../db/postgres.js";

export const addReview = async (req, res) => {
    const student_id = req.user.id;
    const { course_id, instructor_id, rating, comment } = req.body;

    // Validation
    if (!course_id) {
        return res.status(400).json({ message: "Course ID is required" });
    }

    if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({ message: "Rating must be between 1 and 5" });
    }

    try {
        // Check for duplicate review - NOW PER COURSE instead of per instructor
        const existingReview = await pool.query(
            "SELECT 1 FROM instructor_reviews WHERE student_id = $1 AND course_id = $2",
            [student_id, course_id]
        );

        if (existingReview.rowCount > 0) {
            return res.status(409).json({ message: "You have already reviewed this course" });
        }

        // Insert review with course_id
        const result = await pool.query(
            `INSERT INTO instructor_reviews (student_id, instructor_id, course_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
            [student_id, instructor_id, course_id, rating, comment]
        );

        res.status(201).json({
            message: "Review submitted successfully",
            review: result.rows[0],
        });
    } catch (error) {
        console.error("Add review error:", error);
        res.status(500).json({ message: "Failed to submit review" });
    }
};

// ✅ 2. Get own stats (For Instructor Dashboard)
export const getMyReviewStats = async (req, res) => {
    const instructor_id = req.user.id;

    try {
        const result = await pool.query(
            `SELECT 
         COUNT(*) as total_reviews,
         COALESCE(AVG(rating), 0) as average_rating
       FROM instructor_reviews
       WHERE instructor_id = $1`,
            [instructor_id]
        );

        res.json({
            totalReviews: Number(result.rows[0].total_reviews),
            averageRating: Number(parseFloat(result.rows[0].average_rating).toFixed(1)),
        });
    } catch (error) {
        console.error("Get my stats error:", error);
        res.status(500).json({ message: "Failed to fetch review stats" });
    }
};

// ✅ 3. Get reviews for an instructor (For Admin/Public if needed)
export const getInstructorReviews = async (req, res) => {
    const { instructorId } = req.params;

    try {
        const result = await pool.query(
            `SELECT r.*, u.full_name as student_name
       FROM instructor_reviews r
       JOIN users u ON r.student_id = u.user_id
       WHERE r.instructor_id = $1
       ORDER BY r.created_at DESC`,
            [instructorId]
        );

        res.json(result.rows);
    } catch (error) {
        console.error("Get instructor reviews error:", error);
        res.status(500).json({ message: "Failed to fetch reviews" });
    }
};