import express from "express";
import {
    createLearningPath,
    getMyLearningPaths,
    addCourseToLearningPath,
    removeCourseFromLearningPath,
    getLearningPathCourses,
    searchLearningPaths,
    getAllLearningPaths,
} from "../controllers/LearningPath.controller.js";

import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";

const router = express.Router();

// ── Instructor routes ──────────────────────────────────────────────────────────
// Create a new learning path
router.post(
    "/",
    firebaseAuth, attachUser, roleGuard("instructor"),
    createLearningPath
);

// Get all my learning paths (instructor)
router.get(
    "/my",
    firebaseAuth, attachUser, roleGuard("instructor"),
    getMyLearningPaths
);

// Add a course to a learning path
router.post(
    "/add-course",
    firebaseAuth, attachUser, roleGuard("instructor"),
    addCourseToLearningPath
);

// Remove a course from a learning path
router.delete(
    "/:learningPathId/courses/:courseId",
    firebaseAuth, attachUser, roleGuard("instructor"),
    removeCourseFromLearningPath
);

// Get courses of a specific learning path (instructor view)
router.get(
    "/:learningPathId/courses",
    firebaseAuth, attachUser, roleGuard("instructor"),
    getLearningPathCourses
);

// ── Student routes ─────────────────────────────────────────────────────────────
// Search learning paths by name (e.g. ?q=ai)
router.get(
    "/search",
    firebaseAuth, attachUser,
    searchLearningPaths
);

// Get all available learning paths for students
router.get(
    "/all",
    firebaseAuth, attachUser,
    getAllLearningPaths
);

export default router;