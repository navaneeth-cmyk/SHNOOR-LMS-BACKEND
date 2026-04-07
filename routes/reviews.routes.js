import express from "express";
import { addReview, getMyReviewStats, getInstructorReviews } from "../controllers/reviews.controller.js";
import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";

const router = express.Router();

// Student submits review
router.post(
    "/",
    firebaseAuth,
    attachUser,
    roleGuard("student"),
    addReview
);

// Instructor views their own stats
router.get(
    "/my-stats",
    firebaseAuth,
    attachUser,
    roleGuard("instructor"),
    getMyReviewStats
);

// Admin or Public views reviews for specific instructor
router.get(
    "/:instructorId",
    firebaseAuth,
    attachUser,
    getInstructorReviews
);

export default router;