import express from "express";
import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";

import {
  getStudentExams,
  getExamForAttempt,
  submitExam,
  logViolation,
  savePracticeResult
} from "../controllers/studentExam.controller.js";

const router = express.Router();

// 1️⃣ List exams for enrolled courses
router.get(
  "/",
  firebaseAuth,
  attachUser,
  roleGuard("student", "user"),
  getStudentExams
);

// 2️⃣ Load exam questions (WITHOUT answers)
router.get(
  "/:examId",
  firebaseAuth,
  attachUser,
  roleGuard("student", "user"),
  getExamForAttempt
);

// 3️⃣ Submit exam
router.post(
  "/:examId/submit",
  firebaseAuth,
  attachUser,
  roleGuard("student", "user"),
  submitExam
);

// 4️⃣ Log Proctoring Violation
router.post(
  "/:examId/violation",
  firebaseAuth,
  attachUser,
  roleGuard("student", "user"),
  logViolation
);

router.post(
  "/practice/save-result",
  firebaseAuth,
  attachUser,
  roleGuard("student", "user"),
  savePracticeResult
);

export default router;