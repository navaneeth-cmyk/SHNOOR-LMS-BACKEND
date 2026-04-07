import express from "express";
import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";
import { runMockTestCode } from "../controllers/mocktest.controller.js";

const router = express.Router();

import { debugEnv } from "../controllers/debugEnv.js";
router.get("/debug", debugEnv);

// Student should be authenticated and have student role
router.post(
  "/run",
  firebaseAuth,
  attachUser,
  roleGuard("student"),
  runMockTestCode
);

export default router;
