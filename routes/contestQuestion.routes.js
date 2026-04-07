import express from "express";

import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";

import { addContestQuestion } from "../controllers/contestQuestion.controller.js";

const router = express.Router();

/*
  Instructor -> add question to a contest
*/
router.post(
  "/:examId/questions",
  firebaseAuth,
  attachUser,
  roleGuard("instructor"),
  addContestQuestion
);

export default router;