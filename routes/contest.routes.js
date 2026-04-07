import express from "express";

import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";

import {
  createContest,
  getMyContests,
  getAvailableContests,
  getContestById,
  deleteContest,
  updateContest,
  addQuestionToContest,
  getContestQuestionsForStudent,
  submitContestAnswers,
  getCodingQuestionMetaForStudent,
  getMyContestResult,
  getContestLeaderboard
} from "../controllers/contest.controller.js";

import {
  addDescriptiveContestQuestion,
  addCodingContestQuestion,
  runContestQuestionCode
} from "../controllers/contestAdvanced.controller.js";

const router = express.Router();

/* =========================
   Instructor
========================= */

router.post(
  "/",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  createContest
);

/* =========================
   SPECIFIC ROUTES FIRST (avoid being caught by /:id)
========================= */

/* Instructor special routes */
router.get(
  "/mine",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  getMyContests
);

/* Student available route */
router.get(
  "/available",
  firebaseAuth,
  attachUser,
  roleGuard("student"),
  getAvailableContests
);

/* =========================
   Instructor – MCQ
========================= */

router.post(
  "/:contestId/questions",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  addQuestionToContest
);

/* =========================
   Instructor – descriptive
========================= */

router.post(
  "/:contestId/questions/descriptive",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  addDescriptiveContestQuestion
);

/* =========================
   Instructor – coding
========================= */

router.post(
  "/:contestId/questions/coding",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  addCodingContestQuestion
);

/* =========================
   Coding meta (MUST be before /questions to avoid route shadowing)
========================= */

router.get(
  "/:contestId/questions/coding/:questionId/meta",
  firebaseAuth,
  attachUser,
  roleGuard("student"),
  getCodingQuestionMetaForStudent
);

/* =========================
   Questions (GET)
========================= */

router.get(
  "/:contestId/questions",
  firebaseAuth,
  attachUser,
  roleGuard("student", "instructor"),
  getContestQuestionsForStudent
);

/* =========================
   Student – run coding
========================= */

router.post(
  "/:contestId/run-question/:questionId",
  firebaseAuth,
  attachUser,
  roleGuard("student"),
  runContestQuestionCode
);

/* =========================
   Submit contest
========================= */

router.post(
  "/:contestId/submit",
  firebaseAuth,
  attachUser,
  roleGuard("student"),
  submitContestAnswers
);

/* =========================
   Result + leaderboard
========================= */

router.get(
  "/:contestId/my-result",
  firebaseAuth,
  attachUser,
  roleGuard("student"),
  getMyContestResult
);

router.get(
  "/:contestId/leaderboard",
  firebaseAuth,
  attachUser,
  roleGuard("student", "instructor"),
  getContestLeaderboard
);

/* =========================
   GENERIC ROUTES LAST (catch remaining /:id requests)
========================= */

router.delete(
  "/:id",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  deleteContest
);

router.put(
  "/:id",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  updateContest
);

router.get(
  "/:id",
  firebaseAuth,
  attachUser,
  roleGuard("student"),
  getContestById
);

export default router;