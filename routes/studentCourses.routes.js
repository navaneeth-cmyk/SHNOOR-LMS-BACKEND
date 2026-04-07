import express from "express";
import firebaseAuth from "../middlewares/firebaseAuth.js";
import attachUser from "../middlewares/attachUser.js";
import roleGuard from "../middlewares/roleGuard.js";
import { getStudentCourseById, enrollStudent, checkEnrollmentStatus, getMyCourses,getRecommendedCourses } from "../controllers/studentCourses.controller.js";
import { markModuleCompleted, updateModuleProgress } from "../controllers/studentProgress.controller.js";
import { getStudentDashboard, searchCourses } from "../controllers/student.controller.js";

const router = express.Router();

router.get(
  "/search-courses",
  firebaseAuth,
  attachUser,
  roleGuard("student", "user", "learner"),
  searchCourses
);

router.get(
  "/courses/:courseId",
  firebaseAuth,
  attachUser,
  roleGuard("student", "user", "learner"),
  getStudentCourseById
);

router.post(
  "/courses/:courseId/progress",
  firebaseAuth,
  attachUser,
  roleGuard("student", "user", "learner"),
  markModuleCompleted
);

router.put(
  "/courses/:courseId/modules/:moduleId/progress",
  firebaseAuth,
  attachUser,
  roleGuard("student", "user", "learner"),
  updateModuleProgress
);


router.get(
  "/dashboard",
  firebaseAuth,
  attachUser,
  roleGuard("student", "user", "learner"),
  getStudentDashboard
);

router.post(
  "/:courseId/enroll",
  firebaseAuth,
  attachUser,
  roleGuard("student", "user", "learner"),
  enrollStudent
);

router.get(
  "/:courseId/status",
  firebaseAuth,
  attachUser,
  roleGuard("student", "user", "learner"),
  checkEnrollmentStatus
);

router.get(
  "/my-courses",
  firebaseAuth,
  attachUser,
  roleGuard("student", "user", "learner"),
  getMyCourses
);

router.get(
  "/recommendations",
  firebaseAuth,
  attachUser,
  roleGuard("student", "user", "learner"),
  getRecommendedCourses
);


export default router;