import express from "express";

import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";

import {
  addDescriptiveContestQuestion,
  addCodingContestQuestion,
  runContestQuestionCode
} from "../controllers/contestAdvanced.controller.js";

const router = express.Router();

/*
=====================================================
 Instructor – add descriptive contest question
=====================================================
POST /api/contests/:contestId/questions/descriptive
*/
router.post(
  "/:contestId/questions/descriptive",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  addDescriptiveContestQuestion
);

/*
=====================================================
 Instructor – add coding contest question
=====================================================
POST /api/contests/:contestId/questions/coding
*/
router.post(
  "/:contestId/questions/coding",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  addCodingContestQuestion
);

/*
=====================================================
 Student – run coding question (no save, only run)
=====================================================
POST /api/contests/:contestId/run-question/:questionId
*/
router.post(
  "/:contestId/run-question/:questionId",
  firebaseAuth,
  attachUser,
  roleGuard("student"),
  runContestQuestionCode
);

export default router;