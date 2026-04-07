import express from "express";
import {
  getCourseComments,
  addCourseComment,
  updateCourseComment,
  deleteCourseComment,
  voteComment,
} from "../controllers/courseComments.controller.js";
import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";

const router = express.Router();

// Get all comments for a course
router.get(
  "/courses/:courseId/comments",
  firebaseAuth,
  attachUser,
  getCourseComments
);

// Add a new comment
router.post(
  "/courses/:courseId/comments",
  firebaseAuth,
  attachUser,
  addCourseComment
);

// Update a comment
router.put(
  "/comments/:commentId",
  firebaseAuth,
  attachUser,
  updateCourseComment
);

// Delete a comment
router.delete(
  "/comments/:commentId",
  firebaseAuth,
  attachUser,
  deleteCourseComment
);

// Vote on a comment
router.post(
  "/comments/:commentId/vote",
  firebaseAuth,
  attachUser,
  voteComment
);

export default router;