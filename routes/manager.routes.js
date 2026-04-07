import express from "express";
import {
  getManagerCollegeStudents,
  getManagerCourseProgress,
  getManagerExamProgress,
  getManagerCertificates,
} from "../controllers/manager.controller.js";
import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";

const router = express.Router();

router.get(
  "/students",
  firebaseAuth,
  attachUser,
  roleGuard("manager"),
  getManagerCollegeStudents,
);

router.get(
  "/course-progress",
  firebaseAuth,
  attachUser,
  roleGuard("manager"),
  getManagerCourseProgress,
);

router.get(
  "/exam-progress",
  firebaseAuth,
  attachUser,
  roleGuard("manager"),
  getManagerExamProgress,
);

router.get(
  "/certificates",
  firebaseAuth,
  attachUser,
  roleGuard("manager"),
  getManagerCertificates,
);

export default router;
